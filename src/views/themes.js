// @ts-check
import { h, replace } from '../lib/h.js';
import { today, shortDate } from '../core/dates.js';
import { themeState, themeId } from '../core/themes.js';

/** @typedef {import('../app.js').App} App */

/** @param {import('../core/themes.js').ThemeState} s */
function stateLabel(s) {
  switch (s.status) {
    case 'new': return s.last ? 'Disponible' : 'Nuevo';
    case 'due': return `Toca · ronda ${s.round}`;
    case 'waiting': return `Ronda ${s.round} desde ${shortDate(s.availableFrom ?? '')}`;
    case 'resting': return `Descanso hasta ${shortDate(s.availableFrom ?? '')}`;
  }
}

/**
 * @param {string} placeholder
 * @param {(value: string) => void} onAdd
 */
function AddRow(placeholder, onAdd) {
  const input = /** @type {HTMLInputElement} */ (h('input', { class: 'input', type: 'text', placeholder, lang: 'es', 'aria-label': placeholder }));
  const add = () => {
    const v = input.value.trim();
    if (!v) return input.focus();
    onAdd(v);
    input.value = '';
    input.focus();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  return h('div', { class: 'row' }, input, h('button', { type: 'button', class: 'btn', onclick: add }, 'Añadir'));
}

/** @param {App} app */
export function Themes(app) {
  const { store } = app;
  const root = h('section');
  const date = today();

  function render() {
    const d = store.data;
    const themes = d.themes.slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
    replace(root,
      h('div', { class: 'page-head' }, h('h1', null, 'Temas')),

      h('div', { class: 'card' },
        h('h2', null, 'Intereses'),
        h('div', { class: 'chips' }, d.interests.map((i) =>
          h('span', { class: 'chip removable', lang: 'es' }, i,
            h('button', { type: 'button', class: 'x', 'aria-label': `Quitar ${i}`, onclick: () => {
              store.update((x) => { x.interests = x.interests.filter((v) => v !== i); x.day.topics = []; });
              render();
            } }, '×')))),
        AddRow('Nuevo interés', (v) => {
          store.update((x) => { if (!x.interests.includes(v)) x.interests.push(v); x.day.topics = []; });
          render();
        })),

      h('div', { class: 'card' },
        h('h2', null, '5 preguntas'),
        AddRow('Nuevo tema', (v) => {
          store.update((x) => {
            const id = themeId(v);
            if (!x.themes.some((t) => t.id === id)) x.themes.push({ id, name: v, dates: [], questions: [] });
          });
          render();
        }),
        h('ul', { class: 'list themes' }, themes.map((t) => {
          const s = themeState(t, date);
          return h('li', null,
            h('div', { class: 'theme-row' },
              h('span', { class: 'list-main', lang: 'es' }, t.name),
              h('span', { class: `state ${s.status}` }, stateLabel(s)),
              h('button', { type: 'button', class: 'x', 'aria-label': `Quitar ${t.name}`, onclick: () => {
                store.update((x) => { x.themes = x.themes.filter((v) => v.id !== t.id); });
                render();
              } }, '×')));
        }))),

      d.covered.length
        ? h('div', { class: 'card' },
            h('h2', null, 'Temas aprendidos'),
            h('ul', { class: 'list' }, d.covered.slice().reverse().map((c) =>
              h('li', null, h('div', { class: 'theme-row' },
                h('span', { class: 'list-main', lang: 'es' }, c.title),
                h('span', { class: 'muted' }, `${c.interest} · ${shortDate(c.date)}`))))))
        : null,
    );
  }
  render();
  return root;
}
