// @ts-check
/** PCM helpers. Gemini Live takes 16-bit PCM at 16 kHz and returns 16-bit PCM (24 kHz). */

/** @param {Float32Array} f */
export function floatTo16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** @param {Int16Array} p */
export function int16ToFloat(p) {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[i] / 0x8000;
  return out;
}

/**
 * Downsample by averaging the input samples that fall in each output sample.
 * @param {Float32Array} input
 * @param {number} fromRate
 * @param {number} toRate
 */
export function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  if (toRate > fromRate) throw new Error('Upsampling is not supported');
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  let pos = 0;
  for (let i = 0; i < length; i++) {
    const end = Math.min(input.length, Math.round((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = pos; j < end; j++) {
      sum += input[j];
      count++;
    }
    out[i] = count ? sum / count : 0;
    pos = end;
  }
  return out;
}

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

/** @param {string} b64 */
export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** @param {Int16Array} pcm */
export function pcmToBase64(pcm) {
  return bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

/** @param {string} b64 */
export function base64ToPcm(b64) {
  const bytes = base64ToBytes(b64);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

/** "audio/pcm;rate=24000" → 24000 @param {string | undefined} mime @param {number} [fallback] */
export function parseRate(mime, fallback = 24000) {
  const m = mime?.match(/rate=(\d+)/);
  return m ? Number(m[1]) : fallback;
}
