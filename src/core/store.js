// @ts-check
/** All app data in one localStorage key. */
import { defaultThemes } from './themes.js';

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
 */

/**
 * @typedef {object} Settings
 * @property {string} apiKey
 * @property {string} liveModel
 * @property {string} textModel
 * @property {string} voice
 * @property {string} about
 * @property {string} level      A1 to C2
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
 * @property {{ date: string, topics: Topic[], skip: string[] }} day
 */

export const KEY = 'charla:data';
export const SCHEMA_VERSION = 1;
/** Transcripts are kept for this many recent sessions; older ones keep only the summary. */
export const KEEP_TRANSCRIPTS = 60;

export const DEFAULT_INTERESTS = [
  'fútbol', 'filosofía', 'diseño', 'arquitectura', 'urbanismo', 'periodismo',
  'novelas', 'audiolibros', 'ciclismo', 'viajes', 'historia', 'ciencia', 'gastronomía', 'cine',
];

/** @returns {Data} */
export function defaultData() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { apiKey: '', liveModel: '', textModel: '', voice: '', about: '', level: 'A2', liveModels: [], textModels: [] },
    themes: defaultThemes(),
    interests: DEFAULT_INTERESTS.slice(),
    covered: [],
    sessions: [],
    day: { date: '', topics: [], skip: [] },
  };
}

/** @param {any} stored @returns {Data} */
export function migrate(stored) {
  const base = defaultData();
  if (!stored || typeof stored !== 'object') return base;
  return {
    ...base,
    ...stored,
    settings: { ...base.settings, ...(stored.settings ?? {}) },
    day: { ...base.day, ...(stored.day ?? {}) },
    schemaVersion: SCHEMA_VERSION,
  };
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
  /** @type {Data} */
  let data;
  try {
    data = migrate(JSON.parse(storage.getItem(KEY) ?? 'null'));
  } catch {
    data = defaultData();
  }

  function save() {
    // Drop old transcripts first so the data stays well under the storage limit.
    data.sessions.forEach((s, i) => {
      if (i < data.sessions.length - KEEP_TRANSCRIPTS) s.transcript = [];
    });
    try {
      storage.setItem(KEY, JSON.stringify(data));
    } catch {
      /* storage full or blocked */
    }
  }

  return {
    get data() { return data; },

    /** @param {(d: Data) => void} fn */
    update(fn) {
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
      const key = data.settings.apiKey;
      const { app, exportedAt, ...rest } = incoming;
      data = migrate(rest);
      if (!data.settings.apiKey) data.settings.apiKey = key;
      save();
    },
  };
}

/** @typedef {ReturnType<typeof createStore>} Store */
