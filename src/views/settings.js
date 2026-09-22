// @ts-check
import { h } from '../lib/h.js';
import { VOICES } from '../core/gemini.js';
import { today } from '../core/dates.js';
import { KeyForm } from './keyCard.js';

/** @typedef {import('../app.js').App} App */

/**
 * @param {string} label
 * @param {string[]} options
 * @param {string} value
 * @param {(v: string) => void} onChange
 * @param {(v: string) => string} [text]
 */
function Select(label, options, value, onChange, text = (v) => v) {
  const opts = options.includes(value) || !value ? options : [value, ...options];
  const sel = h('select', { class: 'input', 'aria-label': label, onchange: (/** @type {Event} */ e) => onChange(/** @type {HTMLSelectElement} */ (e.target).value) },
    opts.map((o) => h('option', { value: o, selected: o === value }, text(o))));
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), sel);
}

/** @param {App} app */
export function Settings(app) {
  const { store } = app;
  const s = store.data.settings;
  const about = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'input area', rows: '4', lang: 'es', 'aria-label': 'Sobre mí', placeholder: 'Sobre mí' }));
  about.value = s.about;
  about.addEventListener('input', () => store.update((d) => { d.settings.about = about.value; }));

  const file = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: 'application/json,.json', hidden: true }));
  const msg = h('div', { class: 'msg', 'aria-live': 'polite' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      store.importData(JSON.parse(await f.text()));
      msg.textContent = 'Importado';
      msg.className = 'msg ok';
    } catch (err) {
      msg.textContent = String(/** @type {Error} */ (err).message ?? err);
      msg.className = 'msg bad';
    }
  });
  const exportFile = () => {
    const blob = new Blob([JSON.stringify(store.exportData(), null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `charla-${today()}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return h('section', null,
    h('div', { class: 'page-head' }, h('h1', null, 'Ajustes')),
    h('div', { class: 'card' }, h('h2', null, 'Clave de Gemini'), KeyForm(app, { onDone: app.rerender })),
    s.apiKey
      ? h('div', { class: 'card' },
          h('h2', null, 'Voz'),
          Select('Modelo en vivo', s.liveModels ?? [], s.liveModel, (v) => store.update((d) => { d.settings.liveModel = v; })),
          Select('Voz', VOICES, s.voice, (v) => store.update((d) => { d.settings.voice = v; }), (v) => v || 'Por defecto'),
          Select('Modelo para resúmenes', s.textModels ?? [], s.textModel, (v) => store.update((d) => { d.settings.textModel = v; })))
      : null,
    h('div', { class: 'card' }, h('h2', null, 'Sobre mí'), about),
    h('div', { class: 'card' },
      h('h2', null, 'Copia'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: exportFile }, 'Exportar'),
        h('button', { type: 'button', class: 'btn', onclick: () => file.click() }, 'Importar'),
        file),
      msg),
  );
}
