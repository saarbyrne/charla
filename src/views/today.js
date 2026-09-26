// @ts-check
import { h, replace } from '../lib/h.js';
import { today, shortDate } from '../core/dates.js';
import { pickTheme } from '../core/themes.js';
import { generateTopics } from '../actions.js';
import { KeyForm } from './keyCard.js';
import { LevelPicker } from './levelPicker.js';
import { startSession } from './session.js';
import { duration, sessionLabel } from './format.js';

/** @typedef {import('../app.js').App} App */

/** @param {App} app */
export function Today(app) {
  const { store } = app;
  const date = today();
  if (store.data.day.date !== date) store.update((d) => { d.day = { date, topics: [], skip: [] }; });
  const d = store.data;

  if (!d.settings.apiKey) {
    return h('section', null,
      h('div', { class: 'page-head' }, h('h1', null, 'charla')),
      h('div', { class: 'card' }, h('h2', null, 'Nivel'), LevelPicker(app)),
      h('div', { class: 'card' }, h('h2', null, 'Clave de Gemini'), KeyForm(app, { onDone: app.rerender })));
  }

  const pick = pickTheme(d.themes, date, d.day.skip);
  const questions = h('div', { class: 'card activity' },
    h('h2', null, '5 preguntas'),
    pick
      ? [
          h('div', { class: 'activity-title' }, pick.theme.name),
          h('div', { class: 'sub' }, `Ronda ${pick.state.round} de 3`),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn primary', onclick: () => startSession({ activity: 'questions', themeId: pick.theme.id, themeName: pick.theme.name, round: pick.state.round }) }, 'Empezar'),
            h('button', { type: 'button', class: 'btn', onclick: () => { store.update((x) => { x.day.skip.push(pick.theme.id); }); app.rerender(); } }, 'Otro tema')),
        ]
      : [h('div', { class: 'sub' }, 'Todos los temas están en pausa'), h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/temas' }, 'Añadir temas'))],
  );

  const topicList = h('div', { class: 'topics' });
  let loading = false;
  const renderTopics = () => {
    const topics = store.data.day.topics;
    if (!store.data.interests.length) {
      replace(topicList, h('a', { class: 'btn', href: '#/temas' }, 'Añadir intereses'));
      return;
    }
    if (!topics.length) {
      replace(topicList, h('div', { class: 'sub loading' }, 'Buscando temas…'));
      if (!loading) {
        loading = true;
        generateTopics(store).then(() => {
          loading = false;
          if (store.data.day.topics.length) renderTopics();
        });
      }
      return;
    }
    replace(topicList, topics.map((t) =>
      h('button', { type: 'button', class: 'topic', onclick: () => startSession({ activity: 'learn', topic: t }) },
        h('span', { class: 'topic-interest' }, t.interest),
        h('span', { class: 'topic-title' }, t.title),
        t.hook ? h('span', { class: 'topic-hook' }, t.hook) : null)));
  };
  renderTopics();
  const learn = h('div', { class: 'card activity' },
    h('h2', null, 'Aprender algo'),
    topicList,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => { store.update((x) => { x.day.topics = []; }); renderTopics(); } }, 'Otros temas')));

  const recent = d.sessions.slice(-3).reverse();
  return h('section', null,
    h('div', { class: 'page-head' }, h('h1', null, 'Hoy'), h('div', { class: 'head-meta' }, `${d.settings.level} · ${shortDate(date)}`)),
    questions,
    learn,
    recent.length
      ? h('div', { class: 'recent' },
          h('h2', null, 'Últimas sesiones'),
          h('ul', { class: 'list' }, recent.map((s) =>
            h('li', null, h('a', { href: `#/historial/${s.id}` },
              h('span', { class: 'list-main' }, sessionLabel(s)),
              h('span', { class: 'muted' }, `${shortDate(s.date)} · ${duration(s.seconds)}`))))))
      : null,
  );
}
