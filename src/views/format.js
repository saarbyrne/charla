// @ts-check
/** @param {number} s */
export const duration = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** @param {import('../core/store.js').Session} s */
export const sessionLabel = (s) => (s.activity === 'questions' ? s.themeName ?? '' : s.topic?.title ?? '');
