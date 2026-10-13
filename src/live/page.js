// @ts-check
/** Page events around a live session: keep the screen on, pause while hidden, and end the session when the person leaves. */

/** @typedef {Pick<EventTarget, 'addEventListener' | 'removeEventListener'>} Target */

/** How long the page can stay hidden before the session ends. */
export const HIDDEN_LIMIT_MS = 60_000;

/** @typedef {{ now(): number, setTimeout(fn: () => void, ms: number): any, clearTimeout(id: any): void }} Clock */

/** @type {Clock} */
const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/** Ends the session being watched, or null when none is. */
let endWatched = /** @type {(() => void) | null} */ (null);

/**
 * Ends and saves the session being watched, if any. The screen that follows a
 * session calls this before it draws, because the browser runs its own
 * hashchange listener before the one that watchLeave adds.
 */
export function leaveNow() {
  endWatched?.();
}

/**
 * Watch for the person leaving a live session.
 *
 * Going to another screen or closing the page calls `leave` at once. Hiding
 * the page (another app or tab, a locked screen) calls `pause`, so no sound
 * goes to Gemini while the page can't be seen. Coming back within `limitMs`
 * calls `resume` and the conversation carries on. Staying away longer calls
 * `leave`, which ends and saves the session and turns the microphone off. A
 * phone can freeze a hidden page and its timers, so
 * coming back also checks how long the page was hidden. `leave` is called
 * once at most.
 * @param {() => void} leave
 * @param {{
 *   here: () => boolean,
 *   pause?: () => void,
 *   resume?: () => void,
 *   limitMs?: number,
 *   win?: Target,
 *   doc?: Target & { visibilityState: string },
 *   clock?: Clock,
 * }} opts
 *   `here` is true while the session screen is showing.
 * @returns {() => void} stops watching
 */
export function watchLeave(leave, {
  here,
  pause = () => {},
  resume = () => {},
  limitMs = HIDDEN_LIMIT_MS,
  win = window,
  doc = document,
  clock = realClock,
}) {
  let watching = true;
  /** When the page was hidden, or null while it shows. */
  let hiddenAt = /** @type {number | null} */ (null);
  /** @type {any} */
  let timer = null;
  function clearTimer() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }
  function stop() {
    watching = false;
    if (endWatched === go) endWatched = null;
    clearTimer();
    win.removeEventListener('hashchange', onHash);
    win.removeEventListener('pagehide', go);
    doc.removeEventListener('visibilitychange', onVisibility);
  }
  function go() {
    if (!watching) return;
    stop();
    leave();
  }
  function onHash() {
    if (!here()) go();
  }
  function onVisibility() {
    if (!watching) return;
    if (doc.visibilityState === 'hidden') {
      if (hiddenAt !== null) return;
      hiddenAt = clock.now();
      pause();
      timer = clock.setTimeout(go, limitMs);
    } else if (hiddenAt !== null) {
      const away = clock.now() - hiddenAt;
      hiddenAt = null;
      clearTimer();
      if (away >= limitMs) go();
      else resume();
    }
  }
  endWatched = go;
  win.addEventListener('hashchange', onHash);
  win.addEventListener('pagehide', go);
  doc.addEventListener('visibilitychange', onVisibility);
  return stop;
}

/** @typedef {{ release(): Promise<void> }} Lock */

/**
 * Keep the screen on during a live session. Returns a function that lets it
 * turn off again. The lock arrives a moment after it is asked for, so a lock
 * that arrives after that function has run is released straight away.
 * @param {{ wakeLock?: { request(type: 'screen'): Promise<Lock> } }} [nav]
 * @returns {() => void}
 */
export function keepScreenOn(nav = navigator) {
  /** @type {Lock | null} */
  let lock = null;
  let wanted = true;
  const free = (/** @type {Lock} */ l) => l.release().catch(() => {});
  try {
    nav.wakeLock?.request('screen').then((l) => {
      if (wanted) lock = l;
      else free(l);
    }, () => { /* not allowed, for example while the page is hidden */ });
  } catch {
    /* not supported */
  }
  return () => {
    wanted = false;
    if (lock) free(lock);
    lock = null;
  };
}
