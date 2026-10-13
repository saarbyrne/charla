// @ts-check
/** All app data in one localStorage key. */
import { defaultThemes } from './themes.js';
import { simpleLevel } from './prompts.js';

/** @typedef {import('./themes.js').Theme} Theme */
/** @typedef {import('./transcript.js').Turn} Turn */
/** @typedef {import('./prompts.js').Topic} Topic */

/**
 * @typedef {object} Summary
 * @property {string[]} preguntas
 * @property {string} resumen
 * @property {{ es: string, en: string }[]} vocabulario
 * @property {{ dije: string, mejor: string }[]} correcciones
 */

/**
 * One usage report as the server sent it, with the time since the session
 * started and whether the message also ended a model turn.
 * @typedef {{ ms: number, turnComplete: boolean, usageMetadata: unknown }} UsageLogEntry
 */

/**
 * Gemini usage for one live session: the usageMetadata reports added up
 * (see addUsage in live/session.js), the live model, the number of model turns
 * (turnComplete) and the number of messages that carried usage. `log` holds
 * the reports themselves, for the last KEEP_USAGE_LOGS sessions only.
 * A pipeline session (live/pipeline.js) also says so in `engine`, with the
 * seconds of speech and the cost in dollars at list prices. `deviceReplies`
 * counts the replies the device's own voice said because Google refused.
 * @typedef {import('./gemini.js').UsageReport & { model: string, turns: number, reports: number, log?: UsageLogEntry[], engine?: 'live' | 'pipeline', speechSeconds?: number, cost?: number, deviceReplies?: number }} SessionUsage
 */

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {string} date
 * @property {string} startedAt
 * @property {number} seconds
 * @property {'questions'|'learn'} activity
 * @property {string} [themeId]
 * @property {string} [themeName]
 * @property {number} [round]
 * @property {Topic} [topic]
 * @property {Turn[]} transcript
 * @property {Summary | null} summary
 * @property {string} [summaryError]
 * @property {SessionUsage} [usage]  missing on sessions saved before usage was recorded
 */

/**
 * @typedef {object} Settings
 * @property {string} apiKey
 * @property {string} liveModel
 * @property {string} textModel
 * @property {string} voice
 * @property {string} about
 * @property {string} level      A2 (Fácil), B1 (Medio) or B2 (Difícil)
 * @property {string[]} [liveModels]
 * @property {string[]} [textModels]
 */

/**
 * @typedef {object} Data
 * @property {number} schemaVersion
 * @property {Settings} settings
 * @property {Theme[]} themes
 * @property {string[]} interests
 * @property {{ date: string, interest: string, title: string }[]} covered
 * @property {Session[]} sessions
 * @property {{ date: string, topics: Topic[], skip: string[], rejected: string[], shownInterests?: string[], picked?: string[] }} day
 */

export const KEY = 'charla:data';
export const SCHEMA_VERSION = 1;
/** Transcripts are kept for this many recent sessions; older ones keep only the summary. */
export const KEEP_TRANSCRIPTS = 60;
/** Usage logs are kept for this many recent sessions; older ones keep only the totals. */
export const KEEP_USAGE_LOGS = 5;

export const DEFAULT_INTERESTS = [
  'fútbol', 'filosofía', 'diseño', 'arquitectura', 'urbanismo', 'periodismo',
  'novelas', 'audiolibros', 'ciclismo', 'viajes', 'historia', 'ciencia', 'gastronomía', 'cine',
];

/** What an imported copy may hold. Far above real use; anything bigger is refused. */
export const IMPORT_LIMITS = { sessions: 10_000, themes: 2_000, interests: 500, covered: 20_000, turns: 10_000, list: 10_000, text: 100_000, nodes: 1_000_000, depth: 12 };

const DAMAGED = 'Datos dañados';
const TOO_BIG = 'Copia demasiado grande';
/** Keys that could reach the prototype of the objects built from a file. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** @returns {Data} */
export function defaultData() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { apiKey: '', liveModel: '', textModel: '', voice: '', about: '', level: 'A2', liveModels: [], textModels: [] },
    themes: defaultThemes(),
    interests: DEFAULT_INTERESTS.slice(),
    covered: [],
    sessions: [],
    day: { date: '', topics: [], skip: [], rejected: [] },
  };
}

/** @param {any} stored @returns {Data} */
export function migrate(stored) {
  const base = defaultData();
  if (!stored || typeof stored !== 'object') return base;
  return {
    ...base,
    ...stored,
    settings: { ...base.settings, ...(stored.settings ?? {}), level: simpleLevel(stored.settings?.level) },
    day: { ...base.day, ...(stored.day ?? {}) },
    schemaVersion: SCHEMA_VERSION,
  };
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A copy of a parsed file without the keys that reach the prototype. Refuses
 * a file with too many values or too deeply nested.
 * @param {any} value
 * @param {{ nodes: number }} [count]
 * @param {number} [depth]
 * @returns {any}
 */
function cleanCopy(value, count = { nodes: 0 }, depth = 0) {
  if (++count.nodes > IMPORT_LIMITS.nodes || depth > IMPORT_LIMITS.depth) throw new Error(TOO_BIG);
  if (Array.isArray(value)) return value.map((v) => cleanCopy(v, count, depth + 1));
  if (!isRecord(value)) return value;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!UNSAFE_KEYS.has(k)) out[k] = cleanCopy(v, count, depth + 1);
  }
  return out;
}

/** @param {boolean} ok */
function need(ok) {
  if (!ok) throw new Error(DAMAGED);
}

/** @param {any} v */
function text(v) {
  need(typeof v === 'string');
  if (v.length > IMPORT_LIMITS.text) throw new Error(TOO_BIG);
}

/** @param {any} v @param {number} max @param {(item: any) => void} each */
function list(v, max, each) {
  need(Array.isArray(v));
  if (v.length > max) throw new Error(TOO_BIG);
  v.forEach(each);
}

/** @param {any} v */
const texts = (v) => list(v, IMPORT_LIMITS.list, text);

/** @param {any} v */
function date(v) {
  need(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

/** A check for a field that may be missing. @param {(v: any) => void} check */
const optional = (check) => (/** @type {any} */ v) => { if (v !== undefined) check(v); };

/** @param {any} t */
function checkTopic(t) {
  need(isRecord(t));
  text(t.interest);
  text(t.title);
  optional(text)(t.hook);
}

/** @param {any} s */
function checkSummary(s) {
  need(isRecord(s));
  texts(s.preguntas);
  text(s.resumen);
  list(s.vocabulario, IMPORT_LIMITS.list, (v) => { need(isRecord(v)); text(v.es); text(v.en); });
  list(s.correcciones, IMPORT_LIMITS.list, (c) => { need(isRecord(c)); text(c.dije); text(c.mejor); });
}

/** @param {any} s */
function checkSession(s) {
  need(isRecord(s));
  text(s.id);
  need(s.id !== '');
  date(s.date);
  text(s.startedAt);
  need(Number.isFinite(s.seconds) && s.seconds >= 0);
  need(s.activity === 'questions' || s.activity === 'learn');
  optional(text)(s.themeId);
  optional(text)(s.themeName);
  optional((r) => need(Number.isFinite(r)))(s.round);
  optional(checkTopic)(s.topic);
  list(s.transcript, IMPORT_LIMITS.turns, (t) => { need(isRecord(t) && (t.role === 'user' || t.role === 'model')); text(t.text); });
  optional(checkSummary)(s.summary ?? undefined);
  optional(text)(s.summaryError);
  optional((u) => need(isRecord(u)))(s.usage);
}

/** @param {any} t */
function checkTheme(t) {
  need(isRecord(t));
  text(t.id);
  need(t.id !== '');
  text(t.name);
  list(t.dates, IMPORT_LIMITS.list, date);
  texts(t.questions);
}

/** @param {any} s */
function checkSettings(s) {
  need(isRecord(s));
  for (const k of ['liveModel', 'textModel', 'voice', 'about', 'level']) optional(text)(s[k]);
  optional(texts)(s.liveModels);
  optional(texts)(s.textModels);
}

/** @param {any} d */
function checkDay(d) {
  need(isRecord(d));
  optional(text)(d.date);
  optional((t) => list(t, IMPORT_LIMITS.list, checkTopic))(d.topics);
  for (const k of ['skip', 'rejected', 'shownInterests', 'picked']) optional(texts)(d[k]);
}

/**
 * Refuse a copy whose records the screens could not draw.
 * @param {Record<string, any>} copy
 */
function checkCopy(copy) {
  list(copy.sessions, IMPORT_LIMITS.sessions, checkSession);
  list(copy.themes, IMPORT_LIMITS.themes, checkTheme);
  optional((v) => list(v, IMPORT_LIMITS.interests, text))(copy.interests);
  optional((v) => list(v, IMPORT_LIMITS.covered, (c) => { need(isRecord(c)); date(c.date); text(c.interest); text(c.title); }))(copy.covered);
  optional(checkSettings)(copy.settings);
  optional(checkDay)(copy.day);
}

/** @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} StorageLike */

/** @returns {StorageLike} */
export function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

/** @returns {StorageLike} */
function safeStorage() {
  try {
    const s = globalThis.localStorage;
    s.setItem('__charla__', '1');
    s.removeItem('__charla__');
    return s;
  } catch {
    return memoryStorage();
  }
}

/** @param {StorageLike} [storage] */
export function createStore(storage = safeStorage()) {
  /** The stored text that `data` was last read from or written to. @type {string | null} */
  let seen = null;
  /** @type {Data} */
  let data;
  try {
    seen = storage.getItem(KEY);
    data = migrate(JSON.parse(seen ?? 'null'));
  } catch {
    data = defaultData();
  }

  /** Another tab may have saved since this one did, so read before changing anything. */
  function refresh() {
    try {
      const raw = storage.getItem(KEY);
      if (raw === null || raw === seen) return;
      data = migrate(JSON.parse(raw));
      seen = raw;
    } catch {
      /* unreadable: keep this tab's copy */
    }
  }

  function save() {
    // Drop old transcripts and usage logs first so the data stays well under
    // the storage limit.
    data.sessions.forEach((s, i) => {
      if (i < data.sessions.length - KEEP_TRANSCRIPTS) s.transcript = [];
      if (i < data.sessions.length - KEEP_USAGE_LOGS && s.usage?.log) delete s.usage.log;
    });
    try {
      const raw = JSON.stringify(data);
      storage.setItem(KEY, raw);
      seen = raw;
    } catch {
      /* storage full or blocked */
    }
  }

  return {
    get data() { return data; },

    /** @param {(d: Data) => void} fn */
    update(fn) {
      refresh();
      fn(data);
      save();
    },

    /** Export without the API key. */
    exportData() {
      return { app: 'charla', exportedAt: new Date().toISOString(), ...data, settings: { ...data.settings, apiKey: '' } };
    },

    /** @param {any} incoming */
    importData(incoming) {
      if (!incoming || incoming.app !== 'charla') throw new Error('No es una copia de Charla');
      if (typeof incoming.schemaVersion !== 'number' || incoming.schemaVersion > SCHEMA_VERSION) throw new Error('Versión no compatible');
      if (!Array.isArray(incoming.themes) || !Array.isArray(incoming.sessions)) throw new Error('Datos incompletos');
      // Keep this device's key. Exports never include one, so a key in the file
      // was added by hand, and it would send the conversations to someone
      // else's Google project.
      const key = data.settings.apiKey;
      const { app, exportedAt, ...rest } = cleanCopy(incoming);
      checkCopy(rest);
      data = migrate(rest);
      data.settings.apiKey = key;
      save();
    },
  };
}

/** @typedef {ReturnType<typeof createStore>} Store */
