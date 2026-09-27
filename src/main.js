// @ts-check
import { h, replace } from './lib/h.js';
import { createStore } from './core/store.js';
import { Today } from './views/today.js';
import { Session } from './views/session.js';
import { History, SessionDetail } from './views/history.js';
import { Themes } from './views/themes.js';
import { Settings } from './views/settings.js';
import { AppsButton } from './lib/apps.js';

/** @typedef {import('./app.js').App} App */

const NAV = [
  { href: '#/', label: 'Hoy', match: '' },
  { href: '#/historial', label: 'Historial', match: 'historial' },
  { href: '#/temas', label: 'Temas', match: 'temas' },
  { href: '#/ajustes', label: 'Ajustes', match: 'ajustes' },
];

const CHEVRON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';

/**
 * Where the back link goes on screens below the main level. Null on main screens.
 * @param {string | undefined} a
 * @param {string | undefined} b
 * @returns {{ href: string, label: string } | null}
 */
function backFor(a, b) {
  if (a === 'sesion') return { href: '#/', label: 'Hoy' };
  if (a === 'historial' && b) return { href: '#/historial', label: 'Historial' };
  return null;
}

document.getElementById('top-actions')?.append(AppsButton('charla', { label: 'Apps de hecho', support: 'Apoyar', privacy: 'Privacidad' }));

const nav = /** @type {HTMLElement} */ (document.getElementById('nav'));
const main = /** @type {HTMLElement} */ (document.getElementById('main'));

/** @type {App} */
const app = { store: createStore(), rerender: () => render() };

function render() {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  document.body.classList.toggle('session-mode', a === 'sesion');
  const back = backFor(a, b);
  if (back) replace(nav, h('a', { class: 'back', href: back.href }, h('span', { class: 'icon', innerHTML: CHEVRON }), back.label));
  else replace(nav, NAV.map((n) =>
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
