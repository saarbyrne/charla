// @ts-check
/** The hecho apps button and panel. The same file is used in charla and verbos. */
import { h } from './h.js';

const APPS = [
  { id: 'hecho', href: 'https://hecho.fyi/', bg: '#141414', fg: '#ffffff' },
  { id: 'charla', href: 'https://charla.hecho.fyi/', bg: '#2F4BFF', fg: '#ffffff' },
  { id: 'verbos', href: 'https://verbos.hecho.fyi/', bg: '#FF4B2B', fg: '#141414' },
  { id: 'traduce', href: 'https://chromewebstore.google.com/detail/cdbloidgfaclhajkkmlfnnamggoledmg', bg: '#FFD60A', fg: '#141414', external: true },
];

const GRID = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="currentColor">'
  + [5, 12, 19].flatMap((y) => [5, 12, 19].map((x) => `<circle cx="${x}" cy="${y}" r="2"/>`)).join('')
  + '</svg>';
const EXTERNAL = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>';

/**
 * @param {string} current  id of the app this is shown in
 * @param {{ label: string, support: string, privacy: string }} text
 */
export function AppsButton(current, text) {
  const panel = h('div', { class: 'apps', id: 'apps-panel', hidden: true },
    APPS.map((a) => h('a', {
      class: 'app',
      href: a.href,
      'aria-current': a.id === current ? 'page' : null,
      target: a.external ? '_blank' : null,
      rel: a.external ? 'noopener' : null,
    },
    h('span', { class: 'app-icon', style: `background:${a.bg};color:${a.fg}`, 'aria-hidden': 'true' }, a.id[0]),
    a.id,
    a.external ? h('span', { class: 'ext', innerHTML: EXTERNAL }) : null)),
    h('div', { class: 'apps-links' },
      h('a', { href: 'https://hecho.fyi/apoyar/' }, text.support),
      h('a', { href: 'https://hecho.fyi/privacidad/' }, text.privacy)));
  const button = h('button', { type: 'button', class: 'icon-btn', 'aria-label': text.label, 'aria-expanded': 'false', 'aria-controls': 'apps-panel', innerHTML: GRID });
  const wrap = h('div', { class: 'apps-wrap' }, button, panel);

  /** @param {boolean} open */
  const set = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => set(button.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('click', (e) => { if (!wrap.contains(/** @type {Node} */ (e.target))) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  window.addEventListener('hashchange', () => set(false));
  return wrap;
}
