// @ts-check
/**
 * Finds where the learner starts and stops speaking from how loud the
 * microphone is, so charla can decide when a turn is over. Learners stop to
 * think in the middle of a sentence, so a turn ends only after END_PAUSE_MS
 * of quiet. Used by the pipeline (live/pipeline.js).
 */

/** Quiet that ends a turn. Saar's answers on 10 October paused for up to 1.8 seconds mid-sentence. */
export const END_PAUSE_MS = 2000;
/** A turn starts with this much loud sound within START_WINDOW_MS. */
export const START_SPEECH_MS = 120;
export const START_WINDOW_MS = 300;
/** Sound kept from just before the start, so the first syllable isn't cut. */
export const PREROLL_MS = 300;
/** Quiet kept after the last word. */
export const TAIL_MS = 300;
/** A turn with less speech than this is noise, such as a cough or a click, and is dropped. */
export const MIN_SPEECH_MS = 300;
/** A turn this long ends even without a pause. */
export const MAX_TURN_MS = 60_000;
/** How much louder than the background counts as speech, in dB. */
export const SPEECH_ABOVE_NOISE_DB = 12;
/** Anything quieter than this is never speech, in dB below full scale. */
export const SPEECH_FLOOR_DB = -50;

/**
 * How loud a block of 16-bit samples is, in dB below full scale.
 * @param {Int16Array} s
 */
export function levelDb(s) {
  if (!s.length) return -120;
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i] * s[i];
  const rms = Math.sqrt(sum / s.length) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

/** @typedef {{ type: 'start' } | { type: 'end', audio: Int16Array, speechMs: number } | { type: 'noise' }} TurnEvent */

export class TurnDetector {
  /** @param {{ rate?: number, endPauseMs?: number }} [opts] */
  constructor({ rate = 16000, endPauseMs = END_PAUSE_MS } = {}) {
    this.rate = rate;
    this.endPauseMs = endPauseMs;
    /** The background level, followed between turns. */
    this.noiseDb = -60;
    /** @type {number | undefined} the quietest level since the last reset, from calibrate() */
    this.calibration = undefined;
    this.speaking = false;
    /** @type {{ block: Int16Array, ms: number, loud: boolean }[]} the last few blocks before a turn starts */
    this.recent = [];
    /** @type {Int16Array[]} */
    this.blocks = [];
    this.quietMs = 0;
    this.speechMs = 0;
    this.turnMs = 0;
  }

  /**
   * Measure the background while nobody should be talking, for example while
   * charla prepares its reply. The quietest block wins, because even a
   * learner who keeps talking leaves gaps between words. reset() applies it.
   * @param {Int16Array} block
   */
  calibrate(block) {
    if (block.length) this.calibration = Math.min(this.calibration ?? Infinity, levelDb(block));
  }

  /**
   * Forget the turn in progress, for example after charla has spoken. The
   * background level stays, or takes the level measured by calibrate().
   */
  reset() {
    if (this.calibration !== undefined && Number.isFinite(this.calibration)) this.noiseDb = this.calibration;
    this.calibration = undefined;
    this.speaking = false;
    this.recent = [];
    this.blocks = [];
    this.quietMs = 0;
    this.speechMs = 0;
    this.turnMs = 0;
  }

  /**
   * Add a block of microphone audio at `rate`. Returns an event when a turn
   * starts, ends, or turns out to be noise.
   * @param {Int16Array} block
   * @returns {TurnEvent | null}
   */
  push(block) {
    if (!block.length) return null;
    const ms = (block.length / this.rate) * 1000;
    const db = levelDb(block);
    const loud = db > Math.max(this.noiseDb + SPEECH_ABOVE_NOISE_DB, SPEECH_FLOOR_DB);

    if (!this.speaking) {
      // The background follows quiet sound quickly and loud sound very
      // slowly, so a fan that starts up stops counting as speech after a while.
      if (db < this.noiseDb) this.noiseDb = db;
      else this.noiseDb += (db - this.noiseDb) * (loud ? 0.005 : 0.05);
      this.recent.push({ block, ms, loud });
      let kept = this.recent.reduce((n, b) => n + b.ms, 0);
      while (this.recent.length > 1 && kept - this.recent[0].ms >= Math.max(PREROLL_MS, START_WINDOW_MS)) {
        kept -= this.recent[0].ms;
        this.recent.shift();
      }
      let windowMs = 0;
      let loudMs = 0;
      for (let i = this.recent.length - 1; i >= 0 && windowMs < START_WINDOW_MS; i--) {
        windowMs += this.recent[i].ms;
        if (this.recent[i].loud) loudMs += this.recent[i].ms;
      }
      if (loudMs < START_SPEECH_MS) return null;
      this.speaking = true;
      this.blocks = this.recent.map((b) => b.block);
      this.turnMs = kept;
      this.speechMs = loudMs;
      this.quietMs = 0;
      this.recent = [];
      return { type: 'start' };
    }

    this.blocks.push(block);
    this.turnMs += ms;
    if (loud) {
      this.speechMs += ms;
      this.quietMs = 0;
    } else {
      this.quietMs += ms;
    }
    if (this.quietMs < this.endPauseMs && this.turnMs < MAX_TURN_MS) return null;

    const speechMs = this.speechMs;
    if (speechMs < MIN_SPEECH_MS) {
      this.reset();
      return { type: 'noise' };
    }
    const total = this.blocks.reduce((n, b) => n + b.length, 0);
    const drop = Math.max(0, Math.round(((this.quietMs - TAIL_MS) / 1000) * this.rate));
    const audio = new Int16Array(Math.max(0, total - drop));
    let pos = 0;
    for (const b of this.blocks) {
      const take = Math.min(b.length, audio.length - pos);
      if (take <= 0) break;
      audio.set(b.subarray(0, take), pos);
      pos += take;
    }
    this.reset();
    return { type: 'end', audio, speechMs };
  }
}
