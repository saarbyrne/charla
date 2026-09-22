// @ts-check
import { h } from '../lib/h.js';
import { shortDate } from '../core/dates.js';
import { summarise } from '../actions.js';
import { duration, sessionLabel } from './format.js';

/** @typedef {import('../app.js').App} App */
/** @typedef {import('../core/store.js').Summary} Summary */

/**
 * @param {Summary} s
 * @param {'questions'|'learn'} activity
 */
export function SummaryBlock(s, activity) {
  return h('div', { class: 'summary' },
    s.resumen ? h('p', { class: 'summary-text', lang: 'es' }, s.resumen) : null,
    activity === 'questions' && s.preguntas.length
      ? [h('h2', null, 'Preguntas'), h('ol', { class: 'plain', lang: 'es' }, s.preguntas.map((q) => h('li', null, q)))]
      : null,
    s.vocabulario.length
      ? [h('h2', null, 'Vocabulario'), h('table', { class: 'pairs' }, h('tbody', null, s.vocabulario.map((v) => h('tr', null, h('td', { lang: 'es' }, v.es), h('td', { class: 'muted' }, v.en)))))]
      : null,
    s.correcciones.length
      ? [h('h2', null, 'Correcciones'), h('ul', { class: 'fixes' }, s.correcciones.map((c) =>
          h('li', null, c.dije ? h('s', { lang: 'es' }, c.dije) : null, h('span', { lang: 'es' }, c.mejor))))]
      : null,
  );
}

/** @param {App} app */
export function History(app) {
  const sessions = app.store.data.sessions.slice().reverse();
  return h('section', null,
    h('div', { class: 'page-head' }, h('h1', null, 'Historial'), h('div', { class: 'head-meta' }, String(sessions.length))),
    sessions.length
      ? h('ul', { class: 'list' }, sessions.map((s) =>
          h('li', null, h('a', { href: `#/historial/${s.id}` },
            h('span', { class: 'list-main' },
              h('span', { class: 'tag' }, s.activity === 'questions' ? '5 preguntas' : 'Aprender'),
              ` ${sessionLabel(s)}`),
            h('span', { class: 'muted' }, `${shortDate(s.date)} · ${duration(s.seconds)}`)))))
      : h('div', { class: 'sub' }, 'Sin sesiones'),
  );
}

/** @param {App} app @param {string} id */
export function SessionDetail(app, id) {
  const s = app.store.data.sessions.find((x) => x.id === id);
  if (!s) return h('p', null, 'Sesión no encontrada');
  const retry = h('button', {
    type: 'button', class: 'btn',
    onclick: async () => {
      retry.textContent = 'Preparando…';
      try {
        await summarise(app.store, id);
      } catch {
        /* error saved on the session */
      }
      app.rerender();
    },
  }, 'Crear resumen');
  return h('section', null,
    h('div', { class: 'page-head' },
      h('div', null,
        h('a', { class: 'eyebrow', href: '#/historial' }, s.activity === 'questions' ? `5 preguntas · Ronda ${s.round ?? 1}` : `Aprender algo · ${s.topic?.interest ?? ''}`),
        h('h1', { lang: 'es' }, sessionLabel(s))),
      h('div', { class: 'head-meta' }, `${shortDate(s.date)} · ${duration(s.seconds)}`)),
    h('div', { class: 'card' },
      s.summary
        ? SummaryBlock(s.summary, s.activity)
        : [s.summaryError ? h('div', { class: 'msg bad' }, s.summaryError) : null, s.transcript.length ? retry : null]),
    s.transcript.length
      ? h('details', { class: 'card transcript-card' },
          h('summary', null, 'Transcripción'),
          h('div', { class: 'transcript static' }, s.transcript.map((t) => h('p', { class: `turn ${t.role}`, lang: 'es' }, t.text))))
      : null,
  );
}
