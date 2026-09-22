// @ts-check
import { h, replace } from './lib/h.js';
import { createStore } from './core/store.js';
import { Today } from './views/today.js';
import { Session } from './views/session.js';
import { History, SessionDetail } from './views/history.js';
import { Themes } from './views/themes.js';
import { Settings } from './views/settings.js';

/** @typedef {import('./app.js').App} App */

const NAV = [
  { href: '#/', label: 'Hoy', match: '' },
  { href: '#/historial', label: 'Historial', match: 'historial' },
  { href: '#/temas', label: 'Temas', match: 'temas' },
  { href: '#/ajustes', label: 'Ajustes', match: 'ajustes' },
];

const nav = /** @type {HTMLElement} */ (document.getElementById('nav'));
const main = /** @type {HTMLElement} */ (document.getElementById('main'));

/** @type {App} */
const app = { store: createStore(), rerender: () => render() };

function render() {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  document.body.classList.toggle('session-mode', a === 'sesion');
  replace(nav, NAV.map((n) =>
    h('a', { href: n.href, class: (a ?? '') === n.match ? 'active' : '', 'aria-current': (a ?? '') === n.match ? 'page' : null }, n.label)));
  /** @type {HTMLElement} */
  let view;
  switch (a) {
    case 'sesion': view = Session(app); break;
    case 'historial': view = b ? SessionDetail(app, b) : History(app); break;
    case 'temas': view = Themes(app); break;
    case 'ajustes': view = Settings(app); break;
    default: view = Today(app);
  }
  replace(main, view);
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();

navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
