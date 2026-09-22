// @ts-check
/** A live voice session with Gemini: microphone in, audio and transcripts out. */
import { liveUrl, setupMessage, textMessage, audioMessage, parseServerMessage } from '../core/gemini.js';
import { downsample, floatTo16, pcmToBase64, base64ToPcm, int16ToFloat, parseRate } from '../core/audio.js';
import { appendChunk, cleanTurns } from '../core/transcript.js';

/** @typedef {'idle'|'connecting'|'listening'|'speaking'|'closed'} Status */

/**
 * @typedef {object} LiveOptions
 * @property {string} apiKey
 * @property {string} model
 * @property {string} voice
 * @property {string} systemPrompt
 * @property {string} kickoff
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
    this.ctx = /** @type {AudioContext} */ (new AC());
    await this.ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
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
    if (!this.ready || this.muted || !this.ctx) return;
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
