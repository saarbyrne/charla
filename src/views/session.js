// @ts-check
import { h, replace } from '../lib/h.js';
import { LiveSession } from '../live/session.js';
import { systemPrompt, kickoff } from '../core/prompts.js';
import { today } from '../core/dates.js';
import { saveSession, summarise, recentForPrompt } from '../actions.js';
import { duration } from './format.js';
import { SummaryBlock } from './history.js';

/** @typedef {import('../app.js').App} App */
/** @typedef {import('../core/prompts.js').Topic} Topic */

/**
 * @typedef {object} Plan
 * @property {'questions'|'learn'} activity
 * @property {string} [themeId]
 * @property {string} [themeName]
 * @property {number} [round]
 * @property {Topic} [topic]
 */

/** @type {Plan | null} */
let plan = null;

/** @param {Plan} p */
export function startSession(p) {
  plan = p;
  location.hash = `#/sesion?r=${Date.now()}`;
}

const STATUS = {
  idle: 'Listo',
  connecting: 'Conectando…',
  listening: 'Te escucho',
  speaking: 'Hablando',
  closed: 'Terminado',
};

/** @param {App} app */
export function Session(app) {
  if (!plan) {
    location.hash = '#/';
    return h('div');
  }
  const p = plan;
  const { store } = app;
  const root = h('section', { class: 'session' });
  const title = p.activity === 'questions' ? p.themeName : p.topic?.title;
  const eyebrow = p.activity === 'questions' ? `5 preguntas · Ronda ${p.round} de 3` : `Aprender algo · ${p.topic?.interest}`;

  /** @type {LiveSession | null} */
  let live = null;
  let startedAt = 0;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  /** @type {any} */
  let wakeLock = null;
  let finished = false;

  const statusEl = h('div', { class: 'status-line' });
  const timeEl = h('div', { class: 'timer' }, '0:00');
  const transcriptEl = h('div', { class: 'transcript', 'aria-live': 'polite' });
  const errorEl = h('div', { class: 'msg bad' });
  const muteBtn = h('button', { type: 'button', class: 'btn' }, 'Silenciar');
  const endBtn = h('button', { type: 'button', class: 'btn primary' }, 'Terminar');

  /** @param {string} s */
  const setStatus = (s) => replace(statusEl, h('span', { class: `dot ${s}` }), STATUS[/** @type {keyof typeof STATUS} */ (s)] ?? s);

  /** @param {import('../core/transcript.js').Turn[]} turns */
  function renderTranscript(turns) {
    const nearBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 80;
    replace(transcriptEl, turns.map((t) => h('p', { class: `turn ${t.role}`, lang: 'es' }, t.text)));
    if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function head() {
    return h('header', { class: 'session-head' },
      h('div', { class: 'eyebrow' }, eyebrow),
      h('h1', { lang: 'es' }, title ?? ''));
  }

  async function begin() {
    replace(root, head(),
      h('div', { class: 'live-bar' }, statusEl, timeEl),
      transcriptEl,
      errorEl,
      h('div', { class: 'actions sticky' }, muteBtn, endBtn));
    setStatus('connecting');
    const d = store.data;
    const theme = d.themes.find((t) => t.id === p.themeId);
    live = new LiveSession({
      apiKey: d.settings.apiKey,
      model: d.settings.liveModel,
      voice: d.settings.voice,
      systemPrompt: systemPrompt({
        activity: p.activity,
        theme: p.themeName,
        round: p.round,
        previousQuestions: theme?.questions ?? [],
        topic: p.topic,
        about: d.settings.about,
        recent: recentForPrompt(store),
      }),
      kickoff: kickoff(p.activity, p.topic),
    });
    live.addEventListener('status', (e) => setStatus(/** @type {CustomEvent} */ (e).detail));
    live.addEventListener('transcript', (e) => renderTranscript(/** @type {CustomEvent} */ (e).detail));
    live.addEventListener('error', (e) => replace(errorEl, String(/** @type {CustomEvent} */ (e).detail)));
    live.addEventListener('goaway', () => replace(errorEl, 'La sesión termina pronto'));
    live.addEventListener('ended', (e) => {
      const { reason } = /** @type {CustomEvent} */ (e).detail;
      finish(reason);
    });
    try {
      await live.start();
      startedAt = Date.now();
      timer = setInterval(() => replace(timeEl, duration(Math.floor((Date.now() - startedAt) / 1000))), 500);
      try {
        wakeLock = await /** @type {any} */ (navigator).wakeLock?.request('screen');
      } catch {
        /* not supported */
      }
    } catch (err) {
      live?.stop();
      finish(String(/** @type {Error} */ (err).message ?? err));
    }
  }

  muteBtn.addEventListener('click', () => {
    if (!live) return;
    live.setMuted(!live.muted);
    muteBtn.textContent = live.muted ? 'Activar micro' : 'Silenciar';
    muteBtn.classList.toggle('on', live.muted);
  });
  endBtn.addEventListener('click', () => {
    live?.stop();
    finish(null);
  });

  /** @param {string | null} problem */
  async function finish(problem) {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    wakeLock?.release?.().catch?.(() => {});
    plan = null;
    const seconds = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    const transcript = live?.transcript ?? [];
    const spoke = transcript.some((t) => t.role === 'user');
    if (!spoke) {
      replace(root, head(),
        h('div', { class: 'card' },
          problem ? h('div', { class: 'msg bad' }, problem) : h('div', { class: 'sub' }, 'Sesión sin conversación'),
          h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/' }, 'Volver'))));
      return;
    }
    const id = `${Date.now().toString(36)}`;
    saveSession(store, {
      id,
      date: today(),
      startedAt: new Date(startedAt).toISOString(),
      seconds,
      activity: p.activity,
      themeId: p.themeId,
      themeName: p.themeName,
      round: p.round,
      topic: p.topic,
      transcript,
    });
    const body = h('div', { class: 'card' }, h('div', { class: 'sub loading' }, 'Preparando el resumen…'));
    replace(root, head(),
      problem ? h('div', { class: 'msg bad' }, problem) : null,
      h('div', { class: 'sub' }, duration(seconds)),
      body,
      h('div', { class: 'actions' },
        h('a', { class: 'btn primary', href: '#/' }, 'Hecho'),
        h('a', { class: 'btn', href: `#/historial/${id}` }, 'Ver sesión')));
    try {
      const summary = await summarise(store, id);
      replace(body, SummaryBlock(summary, p.activity));
    } catch (err) {
      replace(body, h('div', { class: 'msg bad' }, `Sin resumen: ${String(/** @type {Error} */ (err).message ?? err)}`));
    }
  }

  replace(root,
    head(),
    h('div', { class: 'card start-card' },
      h('button', { type: 'button', class: 'btn primary big', onclick: begin }, 'Empezar'),
      h('a', { class: 'btn', href: '#/' }, 'Volver')));
  return root;
}
