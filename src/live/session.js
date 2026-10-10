// @ts-check
/** A live voice session with Gemini: microphone in, audio and transcripts out. */
import { liveUrl, setupMessage, textMessage, audioMessage, parseServerMessage } from '../core/gemini.js';
import { downsample, floatTo16, pcmToBase64, base64ToPcm, int16ToFloat, parseRate } from '../core/audio.js';
import { appendChunk, cleanTurns } from '../core/transcript.js';

/** @typedef {'idle'|'connecting'|'listening'|'speaking'|'closed'} Status */
/** @typedef {import('../core/gemini.js').UsageReport} UsageReport */
/** @typedef {import('../core/store.js').SessionUsage} SessionUsage */
/** @typedef {import('../core/store.js').UsageLogEntry} UsageLogEntry */

/**
 * A session keeps up to this many usage reports as the server sent them, so
 * the totals can be checked against them. The store keeps them only for the
 * last few sessions (KEEP_USAGE_LOGS in core/store.js).
 */
export const USAGE_LOG_LIMIT = 300;

/**
 * @param {string} model
 * @returns {SessionUsage}
 */
export function emptyUsage(model) {
  return {
    model, turns: 0, reports: 0,
    input: { audio: 0, text: 0 }, output: { audio: 0, text: 0 },
    promptTokenCount: 0, responseTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0,
  };
}

/**
 * Add one usageMetadata report to the session's totals.
 *
 * Each report covers one model turn, not the session so far. The server sends
 * it with turnComplete. Its prompt counts cover everything the model read for
 * that turn: the instructions and the whole conversation so far, which the
 * model reads again on every turn, so they grow turn by turn. Its response
 * counts cover only that turn's reply. Google bills each turn for everything
 * in the context ("The API charges you per turn for all tokens present in the
 * session context window", ai.google.dev/gemini-api/docs/live-api/best-practices),
 * so a session's cost comes from the sum of all its reports. The last report
 * alone is not a session total: its prompt count covers only the last turn.
 *
 * `reports` counts the messages that carried usage, and `turns` counts
 * turnComplete. If a model sends more than one report per turn, the two drift
 * apart and this sum needs another look. Ending a session closes the
 * connection at once, so a turn the model hadn't finished has no report, even
 * if Google bills it.
 * @param {SessionUsage} total
 * @param {UsageReport} report
 */
export function addUsage(total, report) {
  total.reports += 1;
  total.input.audio += report.input.audio;
  total.input.text += report.input.text;
  total.output.audio += report.output.audio;
  total.output.text += report.output.text;
  total.promptTokenCount += report.promptTokenCount;
  total.responseTokenCount += report.responseTokenCount;
  total.thoughtsTokenCount += report.thoughtsTokenCount;
  total.totalTokenCount += report.totalTokenCount;
  return total;
}

/**
 * @typedef {object} LiveOptions
 * @property {string} apiKey
 * @property {string} model
 * @property {string} voice
 * @property {string} systemPrompt
 * @property {string} kickoff
 * @property {AudioContext} [ctx]  Created during the tap that started the session, so iOS allows audio.
 */

export class LiveSession extends EventTarget {
  /** @param {LiveOptions} opts */
  constructor(opts) {
    super();
    this.opts = opts;
    /** @type {import('../core/transcript.js').Turn[]} */
    this.turns = [];
    /** @type {Status} */
    this.status = 'idle';
    this.muted = false;
    /** True while the page is hidden. Separate from `muted`, which the person sets. */
    this.paused = false;
    this.ready = false;
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
    /** @type {WebSocket | null} */
    this.ws = null;
    /** Gemini usage so far. See addUsage. */
    this.usage = emptyUsage(opts.model);
    /** @type {UsageLogEntry[]} the first USAGE_LOG_LIMIT usage reports, as sent */
    this.usageLog = [];
    this.createdAt = Date.now();
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
    // The person can end the session during any of these waits, for example
    // while the browser asks for the microphone. After each one, turn off what
    // has arrived since and don't connect.
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

    const ws = new WebSocket(liveUrl(this.opts.apiKey));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this.send(setupMessage({ model: this.opts.model, systemPrompt: this.opts.systemPrompt, voice: this.opts.voice }));
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onclose = (e) => this.onClose(e);
  }

  /** @param {unknown} obj */
  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** @param {Float32Array} samples */
  onMic(samples) {
    if (!this.ready || this.muted || this.paused || !this.ctx) return;
    const pcm = floatTo16(downsample(samples, this.ctx.sampleRate, 16000));
    this.send(audioMessage(pcmToBase64(pcm)));
  }

  /** @param {string | ArrayBuffer} data */
  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    const ev = parseServerMessage(msg);
    if (ev.usage) {
      addUsage(this.usage, ev.usage);
      if (this.usageLog.length < USAGE_LOG_LIMIT) {
        this.usageLog.push({ ms: Date.now() - this.createdAt, turnComplete: ev.turnComplete, usageMetadata: msg.usageMetadata });
      }
    }
    if (ev.turnComplete) this.usage.turns += 1;
    if (ev.error) this.emit('error', ev.error);
    if (ev.setupComplete) {
      this.ready = true;
      this.setStatus('listening');
      this.send(textMessage(this.opts.kickoff));
    }
    for (const a of ev.audio) this.play(a.data, a.mimeType);
    if (ev.inputText) {
      appendChunk(this.turns, 'user', ev.inputText);
      this.emit('transcript', this.transcript);
    }
    if (ev.outputText) {
      appendChunk(this.turns, 'model', ev.outputText);
      this.emit('transcript', this.transcript);
    }
    if (ev.interrupted) this.stopPlayback();
    if (ev.goAway !== null) this.emit('goaway', ev.goAway);
  }

  /** @param {string} b64 @param {string} mime */
  play(b64, mime) {
    const ctx = this.ctx;
    if (!ctx) return;
    const samples = int16ToFloat(base64ToPcm(b64));
    if (!samples.length) return;
    const buffer = ctx.createBuffer(1, samples.length, parseRate(mime));
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.nextTime);
    src.start(at);
    this.nextTime = at + buffer.duration;
    this.sources.add(src);
    this.setStatus('speaking');
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size && this.ready) this.setStatus('listening');
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
    if (this.ready) this.setStatus('listening');
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.muted = muted;
  }

  /**
   * Stop or restart sending the microphone while the page is hidden. Coming
   * back also wakes the audio, which a phone can suspend in the background.
   * @param {boolean} paused
   */
  setPaused(paused) {
    this.paused = paused;
    if (!paused && this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      this.ctx.resume().catch(() => {});
    }
  }

  /** @param {CloseEvent} e */
  onClose(e) {
    const wasReady = this.ready;
    this.ready = false;
    this.cleanup();
    if (!this.stoppedByUser) {
      this.emit('ended', { code: e.code, reason: e.reason || (wasReady ? 'Conexión cerrada' : 'No se pudo conectar') });
    }
    this.setStatus('closed');
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
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.send({ realtimeInput: { audioStreamEnd: true } });
      this.ws.close(1000);
    }
    this.cleanup();
    this.setStatus('closed');
  }
}
