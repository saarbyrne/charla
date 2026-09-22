// @ts-check
import { h, replace } from '../lib/h.js';
import { connectKey } from '../actions.js';

/** @typedef {import('../app.js').App} App */

export const KEY_URL = 'https://aistudio.google.com/apikey';

/**
 * Key input used on the first screen and in settings.
 * @param {App} app
 * @param {{ onDone?: () => void }} [opts]
 */
export function KeyForm(app, opts = {}) {
  const input = /** @type {HTMLInputElement} */ (h('input', {
    class: 'input', type: 'password', placeholder: 'Clave de Gemini', autocomplete: 'off', spellcheck: 'false',
    value: app.store.data.settings.apiKey, 'aria-label': 'Clave de Gemini',
  }));
  const msg = h('div', { class: 'msg', 'aria-live': 'polite' });
  const btn = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn primary' }, 'Guardar'));
  btn.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) return input.focus();
    btn.disabled = true;
    replace(msg, 'Comprobando…');
    msg.className = 'msg';
    try {
      const { live } = await connectKey(app.store, key);
      replace(msg, `Conectado · ${live[0]}`);
      msg.className = 'msg ok';
      opts.onDone?.();
    } catch (err) {
      replace(msg, String(/** @type {Error} */ (err).message ?? err));
      msg.className = 'msg bad';
    } finally {
      btn.disabled = false;
    }
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && btn.click());
  return h('div', { class: 'key-form' },
    h('div', { class: 'row' }, input, btn),
    msg,
    h('a', { class: 'link', href: KEY_URL, target: '_blank', rel: 'noopener' }, 'Conseguir una clave gratis ↗'));
}
