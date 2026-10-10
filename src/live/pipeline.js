// @ts-check
/**
 * A voice session as a pipeline: the microphone, then Gemini Flash-Lite, then
 * Gemini's voice (see core/pipeline.js). It has the same events and methods
 * as LiveSession, so the session screen works with either.
 *
 * charla listens until the learner pauses for END_PAUSE_MS, sends the answer,
 * says the reply, and listens again. It doesn't listen while it is thinking
 * or speaking, so the learner can't interrupt it. "Silenciar" stops the
 * listening, as in a live session.
 */
import { anySignal, createPipeline, pickSpainVoice, turnUsage, FALLBACK_VOICE, PIPELINE_MODEL, SPEECH_MODEL, STALL_MS } from '../core/pipeline.js';
import { TurnDetector } from '../core/turns.js';
import { downsample, floatTo16, int16ToFloat } from '../core/audio.js';
import { cleanTurns } from '../core/transcript.js';
import { emptyUsage, USAGE_LOG_LIMIT } from './session.js';
import { speakWithDevice } from './device-voice.js';

/** @typedef {'idle'|'connecting'|'listening'|'thinking'|'speaking'|'closed'} Status */
/** @typedef {import('../core/store.js').SessionUsage} SessionUsage */
/** @typedef {import('../core/store.js').UsageLogEntry} UsageLogEntry */
/** @typedef {import('../core/pipeline.js').Message} Message */
/** @typedef {import('../core/pipeline.js').Input} Input */

/** The voice found in Google's library, kept while the page is open. */
let foundVoice = '';

/**
 * @typedef {object} PipelineOptions
 * @property {string} apiKey
 * @property {string} systemPrompt
 * @property {string} kickoff
 * @property {AudioContext} [ctx]  Created during the tap that started the session, so iOS allows audio.
 * @property {(history: Message[]) => string} [turnNote]  added to the instructions on each turn, such as questionNote
 * @property {typeof fetch} [fetchFn]
 * @property {number} [stallMs]  how long a silent voice stream is waited for
 * @property {typeof speakWithDevice} [deviceSpeak]  the device's voice, replaced in tests
 */

export class PipelineSession extends EventTarget {
  /** @param {PipelineOptions} opts */
  constructor(opts) {
    super();
    this.opts = opts;
    /** @type {import('../core/transcript.js').Turn[]} */
    this.turns = [];
    /** @type {Message[]} what the model gets back each turn */
    this.history = [];
    /** @type {Status} */
    this.status = 'idle';
    this.muted = false;
    /** True while the page is hidden. Separate from `muted`, which the person sets. */
    this.paused = false;
    this.ready = false;
    /** True from the end of an answer until charla has finished speaking. */
    this.busy = false;
    this.stoppedByUser = false;
    /** @type {Set<AudioBufferSourceNode>} */
    this.sources = new Set();
    this.nextTime = 0;
    /** @type {AudioContext | null} */
    this.ctx = null;
    /** @type {MediaStream | null} */
    this.stream = null;
    /** @type {AudioWorkletNode | null} */
    this.node = null;
    this.detector = new TurnDetector();
    /** @type {ReturnType<typeof createPipeline> | null} */
    this.pipeline = null;
    /** @type {SessionUsage} */
    this.usage = { ...emptyUsage(`${PIPELINE_MODEL} + ${SPEECH_MODEL}`), engine: 'pipeline', speechSeconds: 0, cost: 0 };
    /** @type {UsageLogEntry[]} */
    this.usageLog = [];
    this.createdAt = Date.now();
    /** Resolves when charla stops speaking. */
    this.whenQuiet = Promise.resolve();
    /** @type {() => void} */
    this.quiet = () => {};
    /** Cancels the calls in progress when the session ends. */
    this.abort = new AbortController();
    /** True once Google has refused the voice for too many requests. The device's voice says the rest. */
    this.deviceVoice = false;
    /** Why Google's voice last failed. It goes in the usage log. */
    this.voiceError = '';
  }

  /** @param {string} type @param {any} [detail] */
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** @param {Status} s */
  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  get transcript() {
    return cleanTurns(this.turns);
  }

  async start() {
    this.setStatus('connecting');
    const AC = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
    this.ctx = this.opts.ctx && this.opts.ctx.state !== 'closed' ? this.opts.ctx : /** @type {AudioContext} */ (new AC());
    // The person can end the session during any of these waits. After each
    // one, turn off what has arrived since.
    await this.ctx.resume();
    if (this.stoppedByUser) return this.cleanup();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (this.stoppedByUser) return this.cleanup();
    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    if (this.stoppedByUser) return this.cleanup();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture');
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    source.connect(this.node);
    this.node.connect(sink);
    sink.connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this.onMic(e.data);

    const base = this.opts.fetchFn ?? fetch.bind(globalThis);
    /** @type {typeof fetch} */
    const fetchFn = (url, init) => base(url, { ...init, signal: init?.signal ? anySignal([init.signal, this.abort.signal]) : this.abort.signal });
    if (!foundVoice) foundVoice = (await pickSpainVoice(this.opts.apiKey, fetchFn)) ?? FALLBACK_VOICE;
    if (this.stoppedByUser) return this.cleanup();
    this.pipeline = createPipeline({ key: this.opts.apiKey, voice: foundVoice, fetchFn, stallMs: this.opts.stallMs ?? STALL_MS });
    this.ready = true;
    // The first reply ends the session if it fails, because nothing has worked yet.
    await this.respond({ text: this.opts.kickoff }, true);
  }

  /** @param {Float32Array} samples */
  onMic(samples) {
    if (!this.ready || this.muted || this.paused || !this.ctx) return;
    const pcm = floatTo16(downsample(samples, this.ctx.sampleRate, 16000));
    // While charla prepares its reply the room should be quiet, so that's
    // when it measures the background. While it speaks, the microphone hears it.
    if (this.busy) {
      if (this.status === 'thinking') this.detector.calibrate(pcm);
      return;
    }
    const event = this.detector.push(pcm);
    if (event?.type === 'end') this.respond({ audio: event.audio }, false);
  }

  /**
   * Send the learner's answer, or the kickoff, and say the reply.
   * @param {Input} input
   * @param {boolean} first
   */
  async respond(input, first) {
    if (!this.pipeline) return;
    this.busy = true;
    this.setStatus('thinking');
    try {
      const r = await this.pipeline.ask(this.opts.systemPrompt + (this.opts.turnNote?.(this.history) ?? ''), this.history, input);
      if (this.stoppedByUser) return;
      const said = 'text' in input ? input.text : (r.heard || '[?]');
      if ('audio' in input) this.turns.push({ role: 'user', text: said });
      this.turns.push({ role: 'model', text: r.reply });
      this.history.push({ role: 'user', text: said }, { role: 'model', text: r.reply });
      this.emit('transcript', this.transcript);

      const speech = this.deviceVoice ? null : await this.googleVoice(r.reply);
      if (this.stoppedByUser) return;
      if (speech) {
        this.addUsage(turnUsage(r.usage, speech.usage, speech.seconds), { reply: r.usage, speech: speech.usage });
        // Wait for the reply to finish playing. A phone can suspend audio, so
        // don't wait much longer than the reply should take.
        const left = Math.max(0, (this.nextTime - (this.ctx?.currentTime ?? 0)) * 1000);
        await Promise.race([this.whenQuiet, new Promise((r) => setTimeout(r, left + 1500))]);
      } else {
        this.addUsage(turnUsage(r.usage, null, 0), { reply: r.usage, speech: null, deviceVoice: this.voiceError });
        this.usage.deviceReplies = (this.usage.deviceReplies ?? 0) + 1;
        this.setStatus('speaking');
        const spoke = await (this.opts.deviceSpeak ?? speakWithDevice)(r.reply, { signal: this.abort.signal });
        // With no Spanish voice on the device either, say why there is no voice.
        if (!spoke && !this.stoppedByUser) this.emit('error', this.voiceError);
      }
    } catch (err) {
      if (this.stoppedByUser) return;
      const message = String(/** @type {Error} */ (err)?.message ?? err);
      const status = /** @type {any} */ (err)?.status;
      if (first || status === 401 || status === 403) {
        this.ready = false;
        this.cleanup();
        this.emit('ended', { code: status ?? 0, reason: message });
        this.setStatus('closed');
        return;
      }
      this.emit('error', message);
    } finally {
      this.busy = false;
      this.detector.reset();
      if (this.ready && !this.stoppedByUser) this.setStatus('listening');
    }
  }

  /**
   * Say the reply with Google's voice. Returns null when Google refuses, so
   * the device's voice says it. After a refusal for too many requests, the
   * device's voice says the rest of the session, so the voice doesn't keep
   * changing.
   * @param {string} text
   */
  async googleVoice(text) {
    if (!this.pipeline) return null;
    try {
      return await this.pipeline.speak(text, (samples, rate) => this.play(samples, rate));
    } catch (err) {
      if (this.stoppedByUser) return null;
      this.voiceError = String(/** @type {Error} */ (err)?.message ?? err);
      if (/** @type {any} */ (err)?.status === 429) this.deviceVoice = true;
      return null;
    }
  }

  /**
   * @param {import('../core/pipeline.js').TurnUsage} turn
   * @param {unknown} raw
   */
  addUsage(turn, raw) {
    const u = this.usage;
    u.turns += 1;
    u.reports += 1;
    u.input.audio += turn.input.audio;
    u.input.text += turn.input.text;
    u.output.audio += turn.output.audio;
    u.output.text += turn.output.text;
    u.thoughtsTokenCount += turn.thoughts;
    u.promptTokenCount += turn.input.audio + turn.input.text;
    u.responseTokenCount += turn.output.audio + turn.output.text;
    u.totalTokenCount += turn.input.audio + turn.input.text + turn.output.audio + turn.output.text + turn.thoughts;
    u.speechSeconds = (u.speechSeconds ?? 0) + turn.speechSeconds;
    u.cost = (u.cost ?? 0) + turn.cost;
    if (this.usageLog.length < USAGE_LOG_LIMIT) {
      this.usageLog.push({ ms: Date.now() - this.createdAt, turnComplete: true, usageMetadata: raw });
    }
  }

  /**
   * Play a piece of the reply right after the previous one.
   * @param {Int16Array} pcm
   * @param {number} rate
   */
  play(pcm, rate) {
    const ctx = this.ctx;
    if (!ctx || this.stoppedByUser) return;
    const samples = int16ToFloat(pcm);
    if (!samples.length) return;
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.nextTime);
    src.start(at);
    this.nextTime = at + buffer.duration;
    if (!this.sources.size) this.whenQuiet = new Promise((resolve) => { this.quiet = () => resolve(undefined); });
    this.sources.add(src);
    this.setStatus('speaking');
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this.quiet();
    };
  }

  stopPlayback() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    this.quiet();
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.muted = muted;
    if (muted) this.detector.reset();
  }

  /**
   * Stop or restart listening while the page is hidden. Coming back also
   * wakes the audio, which a phone can suspend in the background.
   * @param {boolean} paused
   */
  setPaused(paused) {
    this.paused = paused;
    if (paused) this.detector.reset();
    if (!paused && this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      this.ctx.resume().catch(() => {});
    }
  }

  cleanup() {
    this.stopPlayback();
    this.node?.port && (this.node.port.onmessage = null);
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.node = null;
    this.stream = null;
  }

  stop() {
    this.stoppedByUser = true;
    this.ready = false;
    this.abort.abort();
    this.cleanup();
    this.setStatus('closed');
  }
}
