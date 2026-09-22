// @ts-check
/**
 * Theme scheduling for "5 preguntas".
 * A theme repeats every 4 days with slightly different questions. After 3
 * rounds it rests for at least 30 days, then it can start a new cycle.
 */
import { addDays } from './dates.js';

export const REPEAT_DAYS = 4;
export const ROUNDS = 3;
export const REST_DAYS = 30;

/**
 * @typedef {object} Theme
 * @property {string} id
 * @property {string} name
 * @property {string[]} dates       one per completed session, YYYY-MM-DD
 * @property {string[]} questions   questions already asked, newest last
 */

/**
 * @typedef {object} ThemeState
 * @property {'new'|'due'|'waiting'|'resting'} status
 * @property {number} round          round the next session would be (1 to 3)
 * @property {string | null} availableFrom
 * @property {string | null} last
 */

export const DEFAULT_THEMES = [
  'La rutina diaria', 'La comida y la cocina', 'El trabajo', 'Los viajes', 'La familia',
  'Los amigos', 'El fin de semana', 'El fútbol', 'El ciclismo', 'Tu ciudad',
  'La casa', 'El tiempo y las estaciones', 'Las compras', 'La salud', 'La música',
  'El cine y las series', 'Los libros', 'La infancia', 'Los planes para el futuro', 'Las vacaciones',
  'La tecnología', 'Las redes sociales', 'El transporte', 'La naturaleza', 'Los animales',
  'Las fiestas y las tradiciones', 'La vida en España', 'Aprender idiomas', 'Los recuerdos', 'El dinero',
  'Los restaurantes y los bares', 'El deporte', 'Las noticias', 'El diseño', 'La arquitectura',
  'Los barrios', 'El café', 'Los hobbies', 'Las costumbres de tu país', 'Un día perfecto',
];

/** @param {string} name */
export function themeId(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** @param {string[]} [names] @returns {Theme[]} */
export function defaultThemes(names = DEFAULT_THEMES) {
  return names.map((name) => ({ id: themeId(name), name, dates: [], questions: [] }));
}

/**
 * The sessions of the current cycle (at most 3).
 * @param {string[]} dates
 */
export function currentCycle(dates) {
  /** @type {string[]} */
  let cycle = [];
  for (const d of [...dates].sort()) {
    if (cycle.length === ROUNDS) cycle = [];
    cycle.push(d);
  }
  return cycle;
}

/**
 * @param {Theme} theme
 * @param {string} date today
 * @returns {ThemeState}
 */
export function themeState(theme, date) {
  const cycle = currentCycle(theme.dates);
  const last = cycle.length ? cycle[cycle.length - 1] : null;
  if (!last) return { status: 'new', round: 1, availableFrom: null, last: null };
  if (cycle.length === ROUNDS) {
    const restEnd = addDays(last, REST_DAYS);
    if (date >= restEnd) return { status: 'new', round: 1, availableFrom: null, last };
    return { status: 'resting', round: 1, availableFrom: restEnd, last };
  }
  const due = addDays(last, REPEAT_DAYS);
  if (date >= due) return { status: 'due', round: cycle.length + 1, availableFrom: null, last };
  return { status: 'waiting', round: cycle.length + 1, availableFrom: due, last };
}

/** Small stable hash so the pick for a day does not change on reload. @param {string} s */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Pick today's theme: the most overdue repeat first, then a theme never used,
 * then the theme that has rested longest.
 * @param {Theme[]} themes
 * @param {string} date
 * @param {string[]} [skip] theme ids to leave out
 * @returns {{ theme: Theme, state: ThemeState } | null}
 */
export function pickTheme(themes, date, skip = []) {
  const rows = themes
    .filter((t) => !skip.includes(t.id) && !t.dates.includes(date))
    .map((t) => ({ theme: t, state: themeState(t, date) }));
  const due = rows
    .filter((r) => r.state.status === 'due')
    .sort((a, b) => (a.state.last ?? '').localeCompare(b.state.last ?? '') || hash(date + a.theme.id) - hash(date + b.theme.id));
  if (due.length) return due[0];
  const fresh = rows
    .filter((r) => r.state.status === 'new')
    .sort((a, b) => {
      const an = a.state.last ? 1 : 0;
      const bn = b.state.last ? 1 : 0;
      return an - bn || (a.state.last ?? '').localeCompare(b.state.last ?? '') || hash(date + a.theme.id) - hash(date + b.theme.id);
    });
  return fresh[0] ?? null;
}

/**
 * Record a finished session for a theme.
 * @param {Theme} theme
 * @param {string} date
 * @param {string[]} questions
 * @returns {Theme}
 */
export function recordTheme(theme, date, questions) {
  return {
    ...theme,
    dates: [...theme.dates, date].sort(),
    questions: [...theme.questions, ...questions.filter(Boolean)].slice(-30),
  };
}
