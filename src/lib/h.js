// @ts-check
/** Tiny DOM helper. */

/** @typedef {Node | string | number | null | undefined | false | any[]} Child */

const PROPS = new Set(['value', 'checked', 'disabled', 'readOnly', 'selected', 'innerHTML', 'hidden']);

/**
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...Child} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

/**
 * @param {Node} el
 * @param {Child[]} children
 */
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : /** @type {Node} */ (c));
  }
}

/** @param {HTMLElement} el @param {...Child} children */
export function replace(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/** @param {{ text: string, changed: boolean }[]} segs @param {string} cls */
export function segments(segs, cls) {
  return segs.map((s) => (s.changed ? h('span', { class: cls }, s.text) : s.text));
}
