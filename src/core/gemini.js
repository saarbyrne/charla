// @ts-check
/** Gemini API: model list, JSON generation, Live API messages. */

export const API = 'https://generativelanguage.googleapis.com/v1beta';
export const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const INPUT_MIME = 'audio/pcm;rate=16000';

/** Voices offered in settings. An empty value leaves the choice to the model. */
export const VOICES = ['', 'Kore', 'Aoede', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus'];

/** @typedef {{ name: string, displayName?: string, supportedGenerationMethods?: string[] }} Model */

/**
 * REST calls send the key in this header, never in the URL, as Google's JS SDK
 * does. URLs end up in places headers don't, such as proxy logs, error
 * messages and the list of requests that any script on the page can read.
 * @param {string} key
 */
const keyHeader = (key) => ({ 'x-goog-api-key': key });

/**
 * @param {string} key
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Model[]>}
 */
export async function listModels(key, fetchFn = fetch) {
  /** @type {Model[]} */
  const out = [];
  let token = '';
  for (let i = 0; i < 5; i++) {
    const url = `${API}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const res = await fetchFn(url, { headers: keyHeader(key) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    out.push(...(body.models ?? []));
    token = body.nextPageToken ?? '';
    if (!token) break;
  }
  return out;
}

/** @param {string} name */
const bare = (name) => name.replace(/^models\//, '');

/**
 * Live models, best first. Prefers conversational live models over translate,
 * transcribe and extended-thinking variants.
 * @param {Model[]} models
 */
export function pickLiveModels(models) {
  const live = models.filter((m) => (m.supportedGenerationMethods ?? []).includes('bidiGenerateContent') || /live/.test(m.name));
  const score = (/** @type {string} */ n) => (/translate|transcribe/.test(n) ? 3 : 0) + (/thinking/.test(n) ? 1 : 0) + (/preview|exp/.test(n) ? 0.5 : 0);
  return live
    .map((m) => bare(m.name))
    .filter((n, i, a) => a.indexOf(n) === i)
    .sort((a, b) => score(a) - score(b) || b.localeCompare(a, undefined, { numeric: true }));
}

/**
 * Text models for summaries, best first: fast "flash" models without audio,
 * image, TTS or live in the name.
 * @param {Model[]} models
 */
export function pickTextModels(models) {
  const text = models.filter((m) =>
    (m.supportedGenerationMethods ?? []).includes('generateContent') &&
    !/live|tts|image|audio|embedding|vision|aqa|robotics|computer/.test(m.name));
  const score = (/** @type {string} */ n) => (/flash/.test(n) ? 0 : 2) + (/lite/.test(n) ? 0.5 : 0) + (/preview|exp/.test(n) ? 1 : 0) + (/latest/.test(n) ? -0.5 : 0);
  return text
    .map((m) => bare(m.name))
    .filter((n, i, a) => a.indexOf(n) === i)
    .sort((a, b) => score(a) - score(b) || b.localeCompare(a, undefined, { numeric: true }));
}

/**
 * Pull the first JSON object out of a model reply.
 * @param {string} text
 */
export function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('The reply was not JSON');
  }
}

/**
 * Thinking for summaries and topics. Most of their cost was thinking tokens:
 * 8.7K output tokens for two summaries and one topic list on 10 October. Flash
 * models think at "medium" by default, so they're asked for "low". Lite models
 * already think little or not at all, and "low" would turn thinking on for some
 * of them, so they get no setting. Levels per model:
 * ai.google.dev/gemini-api/docs/thinking.
 * @param {string} model
 * @returns {{ thinkingLevel: string } | undefined}
 */
export function textThinking(model) {
  return /lite/.test(model) ? undefined : { thinkingLevel: 'low' };
}

/**
 * @param {string} key
 * @param {string} model
 * @param {string} prompt
 * @param {typeof fetch} [fetchFn]
 */
export async function generateJson(key, model, prompt, fetchFn = fetch, temperature = 0.7) {
  // The model name can come from an imported file, so it is encoded: a name
  // like "../x" can't send the key to another path on Google's server.
  const url = `${API}/models/${encodeURIComponent(bare(model))}:generateContent`;
  /** @param {{ thinkingLevel: string } | undefined} thinkingConfig */
  const call = async (thinkingConfig) => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...keyHeader(key) },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature, ...(thinkingConfig ? { thinkingConfig } : {}) },
      }),
    });
    return { res, body: await res.json().catch(() => ({})) };
  };
  const thinking = textThinking(bare(model));
  let { res, body } = await call(thinking);
  // A model that doesn't take the thinking setting answers 400. Ask again without it.
  if (thinking && res.status === 400 && /thinking/i.test(body?.error?.message ?? '')) ({ res, body } = await call(undefined));
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  const text = (body.candidates?.[0]?.content?.parts ?? []).map((/** @type {any} */ p) => p.text ?? '').join('');
  return parseJson(text);
}

/**
 * The Live API WebSocket address. Here the key has to stay in the URL, because
 * browsers can't set headers on a WebSocket. Google's JS SDK does the same.
 * Short-lived tokens from Hecho's server will replace the key.
 * @param {string} key
 */
export function liveUrl(key) {
  return `${LIVE_URL}?key=${encodeURIComponent(key)}`;
}

/**
 * How long a pause has to last before Gemini takes its turn. Learners stop to
 * think in the middle of a sentence. Google's default is about 800 ms, and in
 * the test sessions on 10 October it cut Saar off twice mid-answer.
 */
export const LEARNER_SILENCE_MS = 1500;

/**
 * Turn-taking for learners: a longer pause before the reply, and low
 * sensitivity to the end of speech, so a short pause doesn't end the turn.
 * See ai.google.dev/gemini-api/docs/live-api/capabilities.
 */
export const LEARNER_TURNS = {
  automaticActivityDetection: {
    endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
    silenceDurationMs: LEARNER_SILENCE_MS,
  },
};

/**
 * A hint for Google's transcript of what the learner says. Without it Google
 * guesses the language, and in a test session on 10 October it wrote a German
 * word for a Spanish answer. The transcript feeds the summary after the
 * session. See AudioTranscriptionConfig in ai.google.dev/api/live.
 */
export const LEARNER_TRANSCRIPTION = { languageCodes: ['es-ES'] };

/**
 * @param {{ model: string, systemPrompt: string, voice?: string }} p
 */
export function setupMessage({ model, systemPrompt, voice }) {
  /** @type {Record<string, any>} */
  const generationConfig = { responseModalities: ['AUDIO'] };
  if (voice) generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } };
  return {
    setup: {
      model: `models/${bare(model)}`,
      generationConfig,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      realtimeInputConfig: LEARNER_TURNS,
      inputAudioTranscription: LEARNER_TRANSCRIPTION,
      outputAudioTranscription: {},
    },
  };
}

/** @param {string} text */
export const textMessage = (text) => ({ realtimeInput: { text } });

/** @param {string} base64 */
export const audioMessage = (base64) => ({ realtimeInput: { audio: { data: base64, mimeType: INPUT_MIME } } });

/**
 * One usageMetadata report from the Live API. Missing counts are 0.
 * @typedef {object} UsageReport
 * @property {{ audio: number, text: number }} input   promptTokensDetails, by modality
 * @property {{ audio: number, text: number }} output  responseTokensDetails, by modality
 * @property {number} promptTokenCount
 * @property {number} responseTokenCount
 * @property {number} thoughtsTokenCount  thinking models only, billed as output
 * @property {number} totalTokenCount
 */

/** @param {unknown} n */
const count = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * Split a details list, [{ modality, tokenCount }], into audio and text.
 * Charla only sends and receives audio and text. A missing modality counts as
 * text, as in Google's SDK.
 * @param {unknown} details
 */
function byModality(details) {
  const out = { audio: 0, text: 0 };
  for (const d of Array.isArray(details) ? details : []) {
    const n = count(d?.tokenCount);
    const modality = d?.modality ?? 'MODALITY_UNSPECIFIED';
    if (modality === 'AUDIO') out.audio += n;
    else if (modality === 'TEXT' || modality === 'MODALITY_UNSPECIFIED') out.text += n;
  }
  return out;
}

/**
 * @param {any} u the usageMetadata field of a server message
 * @returns {UsageReport | null}
 */
export function parseUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    input: byModality(u.promptTokensDetails),
    output: byModality(u.responseTokensDetails),
    promptTokenCount: count(u.promptTokenCount),
    responseTokenCount: count(u.responseTokenCount),
    thoughtsTokenCount: count(u.thoughtsTokenCount),
    totalTokenCount: count(u.totalTokenCount),
  };
}

/**
 * @typedef {object} ServerEvent
 * @property {boolean} setupComplete
 * @property {{ data: string, mimeType: string }[]} audio
 * @property {string} inputText
 * @property {string} outputText
 * @property {boolean} interrupted
 * @property {boolean} turnComplete
 * @property {string | null} goAway
 * @property {string | null} error
 * @property {UsageReport | null} usage
 */

/**
 * @param {any} msg parsed server message
 * @returns {ServerEvent}
 */
export function parseServerMessage(msg) {
  const sc = msg?.serverContent ?? {};
  const parts = sc.modelTurn?.parts ?? [];
  return {
    setupComplete: Boolean(msg?.setupComplete),
    audio: parts
      .map((/** @type {any} */ p) => p.inlineData)
      .filter((/** @type {any} */ d) => d?.data && String(d.mimeType ?? '').startsWith('audio/'))
      .map((/** @type {any} */ d) => ({ data: d.data, mimeType: d.mimeType })),
    inputText: sc.inputTranscription?.text ?? '',
    outputText: sc.outputTranscription?.text ?? '',
    interrupted: Boolean(sc.interrupted),
    turnComplete: Boolean(sc.turnComplete),
    goAway: msg?.goAway ? String(msg.goAway.timeLeft ?? '') : null,
    error: msg?.error ? String(msg.error.message ?? msg.error) : null,
    usage: parseUsage(msg?.usageMetadata),
  };
}
