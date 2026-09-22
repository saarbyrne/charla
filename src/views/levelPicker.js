// @ts-check
import { h, replace } from '../lib/h.js';
import { LEVELS } from '../core/prompts.js';

/** @typedef {import('../app.js').App} App */

/**
 * Level buttons, A1 to C2. Changing the level also refreshes today's topics.
 * @param {App} app
 */
export function LevelPicker(app) {
  const box = h('div', { class: 'segmented levels', role: 'group', 'aria-label': 'Nivel' });
  const render = () => {
    const current = app.store.data.settings.level;
    replace(box, LEVELS.map((l) =>
      h('button', {
        type: 'button', class: l === current ? 'on' : '', 'aria-pressed': String(l === current),
        onclick: () => {
          app.store.update((d) => { d.settings.level = l; d.day.topics = []; });
          render();
        },
      }, l)));
  };
  render();
  return box;
}
