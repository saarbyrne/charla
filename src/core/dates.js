// @ts-check
/** Local calendar dates as YYYY-MM-DD. */

/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0');

/** @param {Date} [d] */
export function today(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** @param {string} date */
function parse(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** @param {string} date @param {number} days */
export function addDays(date, days) {
  const d = parse(date);
  return today(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

/** Whole days from a to b. @param {string} a @param {string} b */
export function daysBetween(a, b) {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
}

/** "22 sep" @param {string} date */
export function shortDate(date) {
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const d = parse(date);
  return `${d.getDate()} ${months[d.getMonth()]}`;
}
