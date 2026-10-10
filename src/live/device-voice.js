// @ts-check
/**
 * The device's own Spanish voice, through the browser's speech synthesis.
 * charla uses it when Google refuses its voice, for example after the 10
 * spoken replies a day that Google gives a free key. It costs nothing and has
 * no limit. How it sounds depends on the device: Google español in Chrome,
 * Elvira or Álvaro in Edge, Mónica in Safari and on iPhone.
 */

/** A little slower than normal, for learners. */
export const DEVICE_RATE = 0.95;

/**
 * How good a voice is for charla: Spain Spanish first, then the natural ones,
 * which browsers name Natural, Neural, Enhanced or Premium, then Google's and
 * Microsoft's. -1 for a voice that isn't Spanish.
 * @param {{ name: string, lang: string, localService?: boolean }} v
 */
export function voiceScore(v) {
  const lang = String(v.lang ?? '').replace('_', '-').toLowerCase();
  if (!lang.startsWith('es')) return -1;
  return (lang === 'es-es' ? 10 : 0)
    + (/natural|neural|enhanced|premium|mejorad/i.test(v.name) ? 4 : 0)
    + (/google|microsoft/i.test(v.name) ? 2 : 0)
    + (v.localService === false ? 1 : 0);
}

/**
 * The best Spanish voice on the device, or null when it has none.
 * @template {{ name: string, lang: string, localService?: boolean }} V
 * @param {V[]} voices
 * @returns {V | null}
 */
export function bestSpanishVoice(voices) {
  /** @type {V | null} */
  let best = null;
  let bestScore = -1;
  for (const v of voices) {
    const score = voiceScore(v);
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The text in sentences. Chrome can stop a voice in the middle of a long
 * line, so each sentence is said on its own.
 * @param {string} text
 */
export function sentences(text) {
  return (text.match(/[^.!?…]+[.!?…]*[»"”)]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/**
 * The device's voices. Some browsers fill in the list a moment after the
 * page loads.
 * @param {SpeechSynthesis} synth
 * @param {number} waitMs
 * @returns {Promise<SpeechSynthesisVoice[]>}
 */
function voicesOf(synth, waitMs) {
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(synth.getVoices()), waitMs);
    synth.addEventListener?.('voiceschanged', () => {
      clearTimeout(timer);
      resolve(synth.getVoices());
    }, { once: true });
  });
}

/**
 * @typedef {object} DeviceVoiceOptions
 * @property {SpeechSynthesis} [synth]
 * @property {typeof SpeechSynthesisUtterance} [Utterance]
 * @property {AbortSignal} [signal]  stops the voice, for example when the session ends
 * @property {number} [msPerWord]  how long a word may take before charla stops waiting
 */

/**
 * Say a reply with the device's voice. Resolves when the voice has finished,
 * or when the reply has had more than enough time, because some browsers
 * never say they have finished.
 * @param {string} text
 * @param {DeviceVoiceOptions} [opts]
 * @returns {Promise<boolean>} false when the device has no Spanish voice
 */
export async function speakWithDevice(text, opts = {}) {
  const synth = opts.synth ?? globalThis.speechSynthesis;
  const Utterance = opts.Utterance ?? globalThis.SpeechSynthesisUtterance;
  if (!synth || !Utterance) return false;
  const voice = bestSpanishVoice(await voicesOf(synth, 1000));
  const parts = sentences(text);
  if (!voice) return false;
  if (!parts.length || opts.signal?.aborted) return true;
  return new Promise((resolve) => {
    const words = text.split(/\s+/).length;
    const timer = setTimeout(done, 3000 + words * (opts.msPerWord ?? 700));
    let finished = false;
    function done() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
      resolve(true);
    }
    function stop() {
      synth.cancel();
      done();
    }
    opts.signal?.addEventListener('abort', stop, { once: true });
    // A voice left from before would hold up the queue.
    synth.cancel();
    parts.forEach((part, i) => {
      const u = new Utterance(part);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = DEVICE_RATE;
      u.onerror = done;
      if (i === parts.length - 1) u.onend = done;
      synth.speak(u);
    });
  });
}

/**
 * iOS lets a page speak only after it has spoken during a tap. Call this in
 * the tap that starts a session, so the device's voice can speak later.
 * @param {SpeechSynthesis} [synth]
 * @param {typeof SpeechSynthesisUtterance} [Utterance]
 */
export function unlockDeviceVoice(synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance) {
  try {
    if (!synth || !Utterance) return;
    const u = new Utterance(' ');
    u.volume = 0;
    synth.speak(u);
  } catch {
    /* this browser has no speech synthesis */
  }
}
