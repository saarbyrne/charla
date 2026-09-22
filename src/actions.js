// @ts-check
/** Actions that combine the store with the Gemini API. */
import { generateJson, listModels, pickLiveModels, pickTextModels } from './core/gemini.js';
import { summaryPrompt, topicsPrompt, transcriptText } from './core/prompts.js';
import { recordTheme } from './core/themes.js';
import { today } from './core/dates.js';

/** @typedef {import('./core/store.js').Store} Store */
/** @typedef {import('./core/store.js').Session} Session */
/** @typedef {import('./core/prompts.js').Topic} Topic */

/**
 * Check the key and choose models.
 * @param {Store} store
 * @param {string} apiKey
 */
export async function connectKey(store, apiKey) {
  const models = await listModels(apiKey);
  const live = pickLiveModels(models);
  const text = pickTextModels(models);
  if (!live.length) throw new Error('Esta clave no tiene modelos Live');
  store.update((d) => {
    d.settings.apiKey = apiKey;
    d.settings.liveModels = live;
    d.settings.textModels = text;
    if (!live.includes(d.settings.liveModel)) d.settings.liveModel = live[0];
    if (!text.includes(d.settings.textModel)) d.settings.textModel = text[0] ?? '';
  });
  return { live, text };
}

/**
 * Three topics for "Aprender algo". Falls back to plain interests if the text model fails.
 * @param {Store} store
 * @returns {Promise<Topic[]>}
 */
export async function generateTopics(store) {
  const { settings, interests, covered } = store.data;
  const recentInterests = covered.slice(-6).map((c) => c.interest);
  const ordered = [...interests].sort((a, b) => recentInterests.indexOf(a) - recentInterests.indexOf(b));
  const fallback = () =>
    ordered
      .slice()
      .sort(() => Math.random() - 0.5)
      .slice(0, 3)
      .map((i) => ({ interest: i, title: `Algo interesante sobre ${i}`, hook: '' }));
  let topics;
  try {
    if (!settings.textModel) throw new Error('no text model');
    const res = await generateJson(settings.apiKey, settings.textModel, topicsPrompt({ interests: ordered, covered: covered.slice(-40).map((c) => c.title), level: settings.level }));
    topics = (res?.temas ?? [])
      .filter((/** @type {any} */ t) => t?.titulo)
      .slice(0, 3)
      .map((/** @type {any} */ t) => ({ interest: String(t.interes ?? ''), title: String(t.titulo), hook: String(t.gancho ?? '') }));
    if (topics.length < 3) throw new Error('too few topics');
  } catch {
    topics = fallback();
  }
  store.update((d) => {
    d.day = { ...d.day, date: today(), topics };
  });
  return topics;
}

/**
 * Save a finished session and update the theme or covered topics.
 * @param {Store} store
 * @param {Omit<Session, 'summary'>} session
 */
export function saveSession(store, session) {
  store.update((d) => {
    d.sessions.push({ ...session, summary: null });
    if (session.activity === 'questions' && session.themeId) {
      d.themes = d.themes.map((t) => (t.id === session.themeId ? recordTheme(t, session.date, []) : t));
    }
    if (session.activity === 'learn' && session.topic) {
      d.covered.push({ date: session.date, interest: session.topic.interest, title: session.topic.title });
      d.day.topics = [];
    }
  });
}

/**
 * Summarise a saved session with the text model.
 * @param {Store} store
 * @param {string} id
 */
export async function summarise(store, id) {
  const s = store.data.sessions.find((x) => x.id === id);
  if (!s) throw new Error('Sesión no encontrada');
  const { apiKey, textModel } = store.data.settings;
  try {
    if (!textModel) throw new Error('No hay modelo de texto');
    const raw = await generateJson(apiKey, textModel, summaryPrompt(s, transcriptText(s.transcript), store.data.settings.level));
    const arr = (/** @type {any} */ v) => (Array.isArray(v) ? v : []);
    const summary = {
      preguntas: arr(raw.preguntas).map(String).slice(0, 5),
      resumen: String(raw.resumen ?? ''),
      vocabulario: arr(raw.vocabulario).filter((/** @type {any} */ v) => v?.es).slice(0, 6).map((/** @type {any} */ v) => ({ es: String(v.es), en: String(v.en ?? '') })),
      correcciones: arr(raw.correcciones).filter((/** @type {any} */ c) => c?.mejor).slice(0, 6).map((/** @type {any} */ c) => ({ dije: String(c.dije ?? ''), mejor: String(c.mejor) })),
    };
    store.update((d) => {
      const target = d.sessions.find((x) => x.id === id);
      if (target) {
        target.summary = summary;
        delete target.summaryError;
      }
      if (s.activity === 'questions' && s.themeId) {
        d.themes = d.themes.map((t) => (t.id === s.themeId ? { ...t, questions: [...t.questions, ...summary.preguntas].slice(-30) } : t));
      }
    });
    return summary;
  } catch (err) {
    store.update((d) => {
      const target = d.sessions.find((x) => x.id === id);
      if (target) target.summaryError = String(/** @type {Error} */ (err).message ?? err);
    });
    throw err;
  }
}

/**
 * Recent sessions for the system prompt.
 * @param {Store} store
 */
export function recentForPrompt(store) {
  return store.data.sessions.slice(-5).map((s) => ({
    date: s.date,
    label: s.activity === 'questions' ? `5 preguntas sobre «${s.themeName}»` : `Aprender algo: «${s.topic?.title}»`,
    summary: s.summary?.resumen,
  }));
}
