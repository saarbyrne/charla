// @ts-check
import { h, replace } from '../lib/h.js';
import { LEVEL_CHOICES } from '../core/prompts.js';

/** @typedef {import('../app.js').App} App */

/**
 * Fácil, Medio or Difícil. Changing the level also refreshes today's topics.
 * @param {App} app
 */
export function LevelPicker(app) {
  const box = h('div', { class: 'choices', role: 'group', 'aria-label': 'Nivel' });
  const render = () => {
    const current = app.store.data.settings.level;
    replace(box, LEVEL_CHOICES.map((c) =>
      h('button', {
        type: 'button', class: 'pick', 'aria-pressed': String(c.value === current),
        onclick: () => {
          app.store.update((d) => { d.settings.level = c.value; d.day.topics = []; });
          render();
        },
      }, c.label)));
  };
  render();
  return box;
}
