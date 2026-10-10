// @ts-check
/**
 * The pipeline. charla decides when the learner has finished (core/turns.js).
 * Gemini Flash-Lite gets the answer as audio, with the conversation so far as
 * text, and returns what it heard and its reply. Gemini's text-to-speech then
 * says the reply. Each call bills only what it gets, so a session costs about
 * the same per minute however many turns it has. The Live API bills every
 * turn for the whole session so far, which made an 8-minute conversation cost
 * about $0.45 against about $0.04 here (estimates from 10 October 2026).
 */
import { API } from './gemini.js';
import { base64ToBytes, bytesToBase64 } from './audio.js';

/** Writes the replies and hears the learner. Stable, takes audio. */
export const PIPELINE_MODEL = 'gemini-3.1-flash-lite';
/** Says the replies. Called through the Interactions API. */
export const SPEECH_MODEL = 'gemini-3.8-flash-lite-tts';
/** The voice when Google's library has no Spain Spanish voice, or the model refuses it. */
export const FALLBACK_VOICE = 'Kore';
/** How the voice speaks. The accent comes from the voice itself. */
export const SPEECH_STYLE = 'Habla despacio y con claridad, con un tono amable, como un profesor con un alumno de nivel básico.';

/**
 * Prices per 1M tokens, from ai.google.dev/gemini-api/docs/pricing on
 * 10 October 2026. The text-to-speech prices double on 1 January 2027.
 * Audio is 25 tokens a second.
 */
export const PIPELINE_PRICES = {
  reply: { textIn: 0.25, audioIn: 0.5, textOut: 1.5 },
  speech: { textIn: 0.5, audioOut: 6 },
};
export const AUDIO_TOKENS_PER_SECOND = 25;

/** A reply that takes longer than this is given up on and asked once more. */
export const REPLY_TIMEOUT_MS = 20_000;
/**
 * A voice stream that sends nothing for this long is given up on. In the
 * voice test on 10 October, one of Google's streams stopped sending without
 * closing and waited 10 minutes.
 */
export const STALL_MS = 6_000;

/** Added to the system prompt, because the reply comes back as text. */
export const REPLY_RULES = `

Formato:
- Recibes lo que digo como audio. Contesta en JSON con dos campos.
- "heard": lo que he dicho, palabra por palabra y sin corregir mis errores. Si no entiendes una parte, escribe [?].
- "reply": tu respuesta, de 25 palabras como mucho. Se va a leer en voz alta, así que escribe solo frases, sin emojis, listas ni símbolos.
- Di «¿Sí?» solo si mi frase acaba a medias, por ejemplo en «pero», «y» o «porque», y entonces no digas nada más. Si mi respuesta está completa, no digas «¿Sí?» ni «Sigue».`;

const REPLY_SCHEMA = {
  type: 'OBJECT',
  properties: { heard: { type: 'STRING' }, reply: { type: 'STRING' } },
  required: ['heard', 'reply'],
};

/**
 * @typedef {{ role: 'user' | 'model', text: string }} Message
 * @typedef {{ text: string } | { audio: Int16Array }} Input
 */

/** @param {string} key */
const keyHeader = (key) => ({ 'x-goog-api-key': key });

/**
 * A 16-bit mono WAV file.
 * @param {Int16Array} samples
 * @param {number} rate
 */
export function wavBytes(samples, rate) {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const text = (/** @type {number} */ at, /** @type {string} */ s) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return out;
}

/**
 * The body of a reply request: the conversation so far as text, then the
 * learner's answer as audio, or the kickoff as text.
 * @param {{ system: string, history: Message[], input: Input, thinking: boolean }} p
 */
export function replyRequest({ system, history, input, thinking }) {
  const last = 'audio' in input
    ? { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: bytesToBase64(wavBytes(input.audio, 16000)) } }] }
    : { role: 'user', parts: [{ text: input.text }] };
  return {
    systemInstruction: { parts: [{ text: system + REPLY_RULES }] },
    contents: [...history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })), last],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: REPLY_SCHEMA,
      ...(thinking ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
    },
  };
}

/**
 * The model's JSON reply, even with a code fence or text around it.
 * @param {string} text
 * @returns {{ heard: string, reply: string }}
 */
export function parseReply(text) {
  const match = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/gi, ''));
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      return { heard: String(obj.heard ?? '').trim(), reply: String(obj.reply ?? '').trim() };
    } catch { /* not JSON, so all of it is the reply */ }
  }
  return { heard: '', reply: text.trim() };
}

/**
 * The body of a text-to-speech request.
 * @param {{ text: string, voice: string }} p
 */
export function speechRequest({ text, voice }) {
  return {
    model: SPEECH_MODEL,
    input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: SPEECH_STYLE }] }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] },
    stream: true,
    // Google is asked not to keep the learner's words.
    store: false,
  };
}

/**
 * Every audio part in a response or a stream event, wherever it sits.
 * @param {any} obj
 * @param {{ data: string, mime: string, rate: number }[]} [out]
 */
export function audioParts(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (obj.type === 'audio' && typeof obj.data === 'string' && obj.data) {
    out.push({ data: obj.data, mime: String(obj.mime_type ?? obj.mimeType ?? ''), rate: Number(obj.sample_rate ?? obj.sampleRate) || 0 });
    return out;
  }
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) if (v && typeof v === 'object') audioParts(v, out);
  return out;
}

/** The first `usage` object anywhere in a response or event. @param {any} obj @returns {any} */
export function findUsage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.usage && typeof obj.usage === 'object') return obj.usage;
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    const u = findUsage(v);
    if (u) return u;
  }
  return null;
}

/** How rough a signal is. Speech read with the wrong byte order is close to noise. @param {Int16Array} s */
function roughness(s) {
  let sum = 0;
  for (let i = 1; i < s.length; i++) sum += Math.abs(s[i] - s[i - 1]);
  return s.length > 1 ? sum / (s.length - 1) : 0;
}

/**
 * 16-bit samples from one audio part. WAV is read from its header. Raw PCM
 * ("audio/l16") may be big-endian, as its standard says, or little-endian,
 * so both are tried and the smoother one is kept.
 * @param {{ data: string, mime: string, rate: number }} part
 * @returns {{ samples: Int16Array, rate: number }}
 */
export function decodeAudio(part) {
  const bytes = base64ToBytes(part.data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (/** @type {number} */ at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    let rate = 24000;
    let at = 12;
    while (at + 8 <= bytes.length) {
      const size = view.getUint32(at + 4, true);
      if (tag(at) === 'fmt ') rate = view.getUint32(at + 12, true);
      if (tag(at) === 'data') {
        const n = Math.floor(Math.min(size, bytes.length - at - 8) / 2);
        const samples = new Int16Array(n);
        for (let i = 0; i < n; i++) samples[i] = view.getInt16(at + 8 + i * 2, true);
        return { samples, rate };
      }
      at += 8 + size + (size % 2);
    }
    return { samples: new Int16Array(0), rate };
  }
  const n = bytes.length >> 1;
  const little = new Int16Array(n);
  const big = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    little[i] = view.getInt16(i * 2, true);
    big[i] = view.getInt16(i * 2, false);
  }
  const rate = part.rate || Number(/rate=(\d+)/.exec(part.mime)?.[1]) || 24000;
  return { samples: roughness(big) < roughness(little) ? big : little, rate };
}

/**
 * Server-sent events from a response body, each data payload parsed as JSON.
 * Reads with a reader, because not every browser can loop over a stream. If
 * nothing arrives for `stallMs`, it stops and calls `onStall`.
 * @param {ReadableStream<Uint8Array>} body
 * @param {(event: any) => void} onEvent
 * @param {{ stallMs?: number, onStall?: () => void }} [opts]
 * @returns {Promise<{ stalled: boolean }>}
 */
export async function readEvents(body, onEvent, { stallMs = STALL_MS, onStall = () => {} } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  /** @param {string} block */
  const parse = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    onEvent(event);
  };
  for (;;) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const stall = new Promise((resolve) => { timer = setTimeout(() => resolve('stall'), stallMs); });
    const next = await Promise.race([reader.read(), stall]);
    clearTimeout(timer);
    if (next === 'stall') {
      onStall();
      reader.cancel().catch(() => {});
      return { stalled: true };
    }
    const { value, done } = /** @type {ReadableStreamReadResult<Uint8Array>} */ (next);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      parse(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
  }
  parse(buf + decoder.decode());
  return { stalled: false };
}

/**
 * A signal that aborts when any of these does. AbortSignal.any is missing in
 * Safari before 17.4.
 * @param {AbortSignal[]} signals
 * @returns {AbortSignal}
 */
export function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

/**
 * Worth asking once more: no answer, a timeout or a server error. Too many
 * requests (429) isn't, because asking again at once fails the same way.
 * @param {any} err
 */
const retryable = (err) => !err?.status || err.status >= 500;

/**
 * An error with Google's message and the HTTP status.
 * @param {Response} res
 * @param {string} what
 */
async function failure(res, what) {
  const body = await res.json().catch(() => ({}));
  const message = body?.error?.message ?? `HTTP ${res.status}`;
  return Object.assign(new Error(`${what}: ${message}`), { status: res.status });
}

/** @typedef {{ id: string, name: string, gender: string, description: string }} Voice */

/**
 * The voice that suits a conversation best: one described as conversational,
 * friendly or natural, and not one made for adverts, news or reading aloud.
 * A tutor's voice comes first. A woman's voice wins a tie. Same as the voice
 * test in the hecho repo, where `npm run voice-samples` plays them all.
 * @param {Voice[]} voices
 * @returns {Voice | null}
 */
export function chooseVoice(voices) {
  const score = (/** @type {Voice} */ v) => {
    const text = `${v.id} ${v.name} ${v.description}`.toLowerCase();
    return (/tutor|teacher|profesor/.test(text) ? 5 : 0)
      + (/conversa|friendly|casual|warm|natural|amable|cercan/.test(text) ? 3 : 0)
      - (/commercial|advert|announc|news|narrat|audiobook|promo/.test(text) ? 3 : 0)
      + (/female|mujer/.test(v.gender.toLowerCase()) ? 1 : 0);
  };
  return [...voices].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/**
 * A Spain Spanish voice from Google's voice library, or null.
 * @param {string} key
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<string | null>}
 */
export async function pickSpainVoice(key, fetchFn = fetch) {
  try {
    const res = await fetchFn(`${API}/voices?language_code=es-ES&page_size=100`, { headers: keyHeader(key) });
    if (!res.ok) return null;
    const body = await res.json();
    /** @type {any[]} */
    const list = Array.isArray(body?.voices) ? body.voices : (Object.values(body ?? {}).find(Array.isArray) ?? []);
    const spain = list
      .filter((v) => /^es[-_]ES$/i.test(String(v?.language_code ?? v?.languageCode ?? '')) || /spain|españa|castil|peninsular/i.test(String(v?.accent ?? '')))
      .map((v) => ({ id: String(v.id ?? v.name ?? ''), name: String(v.display_name ?? v.displayName ?? ''), gender: String(v.gender ?? ''), description: String(v.description ?? '') }))
      .filter((v) => v.id);
    return chooseVoice(spain)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Token counts for one turn: the reply call and the speech call.
 * @typedef {object} TurnUsage
 * @property {{ audio: number, text: number }} input
 * @property {{ audio: number, text: number }} output
 * @property {number} thoughts
 * @property {number} speechSeconds
 * @property {number} cost  dollars at list prices
 */

/**
 * @param {any} replyUsage  usageMetadata from generateContent
 * @param {any} speechUsage the Interactions API usage, if it came
 * @param {number} speechSeconds
 * @returns {TurnUsage}
 */
export function turnUsage(replyUsage, speechUsage, speechSeconds) {
  const input = { audio: 0, text: 0 };
  for (const d of Array.isArray(replyUsage?.promptTokensDetails) ? replyUsage.promptTokensDetails : []) {
    if (d?.modality === 'AUDIO') input.audio += Number(d.tokenCount) || 0;
    else input.text += Number(d?.tokenCount) || 0;
  }
  if (!input.audio && !input.text) input.text = Number(replyUsage?.promptTokenCount) || 0;
  const replyText = Number(replyUsage?.candidatesTokenCount) || 0;
  const thoughts = Number(replyUsage?.thoughtsTokenCount) || 0;
  const speechIn = Number(speechUsage?.total_input_tokens) || 0;
  const speechOut = Number(speechUsage?.total_output_tokens) || Math.round(speechSeconds * AUDIO_TOKENS_PER_SECOND);
  const { reply, speech } = PIPELINE_PRICES;
  const cost = (input.text * reply.textIn + input.audio * reply.audioIn + (replyText + thoughts) * reply.textOut
    + speechIn * speech.textIn + speechOut * speech.audioOut) / 1e6;
  return {
    input: { audio: input.audio, text: input.text + speechIn },
    output: { audio: speechOut, text: replyText },
    thoughts,
    speechSeconds,
    cost,
  };
}

/**
 * The pipeline's two calls, with the key and what Google refused so far.
 * @param {{ key: string, voice: string, fetchFn?: typeof fetch, stallMs?: number }} p
 */
export function createPipeline({ key, voice, fetchFn = fetch, stallMs = STALL_MS }) {
  let thinking = true;
  let currentVoice = voice;
  /** @type {string[]} */
  const notes = [];
  const headers = { 'Content-Type': 'application/json', ...keyHeader(key) };

  /**
   * @param {string} system
   * @param {Message[]} history
   * @param {Input} input
   */
  async function ask(system, history, input) {
    const call = async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), REPLY_TIMEOUT_MS);
      try {
        const res = await fetchFn(`${API}/models/${PIPELINE_MODEL}:generateContent`, {
          method: 'POST',
          headers,
          signal: ctl.signal,
          body: JSON.stringify(replyRequest({ system, history, input, thinking })),
        });
        if (!res.ok) throw await failure(res, PIPELINE_MODEL);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    };
    /** @type {any} */
    let body;
    for (let attempt = 1; ; attempt++) {
      try {
        body = await call();
        break;
      } catch (err) {
        const e = /** @type {any} */ (err);
        if (thinking && e?.status === 400 && /thinking/i.test(String(e.message))) {
          thinking = false;
          notes.push(`${PIPELINE_MODEL} doesn't take a thinking level`);
          continue;
        }
        if (attempt >= 2 || !retryable(e)) throw err;
        notes.push(`${PIPELINE_MODEL} failed once (${e?.message ?? e}), so it was asked again`);
      }
    }
    const text = (body?.candidates?.[0]?.content?.parts ?? []).map((/** @type {any} */ p) => p?.text ?? '').join('');
    return { ...parseReply(text), usage: body?.usageMetadata ?? null };
  }

  /**
   * Say a reply. Each piece of audio goes to `onAudio` as it arrives.
   * @param {string} text
   * @param {(samples: Int16Array, rate: number) => void} onAudio
   */
  async function speak(text, onAudio) {
    for (let attempt = 1; ; attempt++) {
      const ctl = new AbortController();
      let samplesOut = 0;
      let rate = 24000;
      /** @type {any} */
      let usage = null;
      /** @param {any} obj */
      const take = (obj) => {
        for (const part of audioParts(obj)) {
          const audio = decodeAudio(part);
          if (!audio.samples.length) continue;
          samplesOut += audio.samples.length;
          rate = audio.rate;
          onAudio(audio.samples, audio.rate);
        }
        usage = findUsage(obj) ?? usage;
      };
      let stalled = false;
      try {
        const res = await fetchFn(`${API}/interactions`, {
          method: 'POST',
          headers: { ...headers, Accept: 'text/event-stream' },
          signal: ctl.signal,
          body: JSON.stringify(speechRequest({ text, voice: currentVoice })),
        });
        if (!res.ok) {
          const err = await failure(res, SPEECH_MODEL);
          if (res.status === 400 && currentVoice !== FALLBACK_VOICE) {
            notes.push(`${SPEECH_MODEL} refused the voice ${currentVoice} (${err.message})`);
            currentVoice = FALLBACK_VOICE;
            attempt -= 1;
            continue;
          }
          throw err;
        }
        if (/event-stream/i.test(res.headers.get('content-type') ?? '') && res.body) {
          ({ stalled } = await readEvents(res.body, take, { stallMs, onStall: () => ctl.abort() }));
        } else {
          take(await res.json());
        }
      } catch (err) {
        if (!samplesOut && (attempt >= 2 || !retryable(err))) throw err;
        stalled = true;
      }
      if (samplesOut) {
        // A stream that stops after some audio leaves the reply cut short. The
        // transcript still has all of it.
        if (stalled) notes.push(`${SPEECH_MODEL} stopped in the middle of a reply`);
        return { usage, seconds: samplesOut / rate };
      }
      if (attempt >= 2) throw new Error(`${SPEECH_MODEL}: no audio came back`);
      notes.push(`${SPEECH_MODEL} sent no audio, so it was asked again`);
    }
  }

  return { ask, speak, notes, get voice() { return currentVoice; } };
}
