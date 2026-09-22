// @ts-check
/** Builds turns from streamed transcription chunks. */

/** @typedef {{ role: 'user'|'model', text: string }} Turn */

/**
 * Add a chunk. A new turn starts when the speaker changes.
 * @param {Turn[]} turns
 * @param {'user'|'model'} role
 * @param {string} text
 */
export function appendChunk(turns, role, text) {
  if (!text) return turns;
  const last = turns[turns.length - 1];
  if (last && last.role === role) last.text = (last.text + text).replace(/\s+/g, ' ');
  else turns.push({ role, text: text.replace(/\s+/g, ' ').trimStart() });
  return turns;
}

/** @param {Turn[]} turns */
export function cleanTurns(turns) {
  return turns.map((t) => ({ role: t.role, text: t.text.trim() })).filter((t) => t.text);
}
