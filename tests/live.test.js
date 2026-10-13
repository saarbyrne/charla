import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LiveSession, addUsage, emptyUsage, USAGE_LOG_LIMIT } from '../src/live/session.js';
import { watchLeave, leaveNow, keepScreenOn, HIDDEN_LIMIT_MS } from '../src/live/page.js';

// Fakes for the browser APIs a live session uses. Each test file runs in its
// own process, so these globals don't reach the other tests.
class FakeTrack {
  readyState = 'live';
  stop() { this.readyState = 'ended'; }
}
class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() { return this.tracks; }
  get live() { return this.tracks.some((t) => t.readyState === 'live'); }
}
class FakeAudioContext {
  state = 'running';
  sampleRate = 48000;
  currentTime = 0;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  async resume() {}
  async close() { this.state = 'closed'; }
  createMediaStreamSource() { return { connect() {} }; }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
}
class FakeWorkletNode {
  port = { onmessage: null };
  connect() {}
  disconnect() {}
}
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** @type {FakeWebSocket[]} */
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.all.push(this);
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code) { this.readyState = FakeWebSocket.CLOSED; this.closedWith = code; }
}

globalThis.window = globalThis;
globalThis.AudioContext = FakeAudioContext;
globalThis.AudioWorkletNode = FakeWorkletNode;
globalThis.WebSocket = FakeWebSocket;
const mediaDevices = { getUserMedia: async () => new FakeStream() };
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices }, configurable: true, writable: true });

beforeEach(() => {
  FakeWebSocket.all = [];
  mediaDevices.getUserMedia = async () => new FakeStream();
});

const options = () => ({ apiKey: 'KEY', model: 'gemini-3.8-live', voice: '', systemPrompt: 'Hola', kickoff: 'Empecemos' });

/** A getUserMedia that waits, like a browser asking for permission. */
function slowMicrophone() {
  /** @type {(s: FakeStream) => void} */
  let grant = () => {};
  /** @type {() => void} */
  let asked = () => {};
  const wasAsked = new Promise((r) => { asked = r; });
  mediaDevices.getUserMedia = () => {
    asked();
    return new Promise((r) => { grant = r; });
  };
  return { wasAsked, grant: (/** @type {FakeStream} */ s) => grant(s) };
}

test('ending while the browser asks for the microphone turns it off and never connects', async () => {
  const mic = slowMicrophone();
  const live = new LiveSession(options());
  const started = live.start();
  await mic.wasAsked;
  live.stop();
  const stream = new FakeStream();
  mic.grant(stream);
  await started;
  assert.equal(stream.live, false, 'the microphone is still on');
  assert.equal(FakeWebSocket.all.length, 0, 'a connection was opened after the session ended');
  assert.equal(live.ctx?.state, 'closed');
  assert.equal(live.status, 'closed');
});

test('ending turns the microphone off and closes the connection', async () => {
  const stream = new FakeStream();
  mediaDevices.getUserMedia = async () => stream;
  const live = new LiveSession(options());
  await live.start();
  const ws = FakeWebSocket.all[0];
  assert.match(ws.url, /BidiGenerateContent\?key=KEY$/);
  ws.readyState = FakeWebSocket.OPEN;
  live.stop();
  assert.equal(stream.live, false);
  assert.equal(live.ctx?.state, 'closed');
  assert.equal(ws.closedWith, 1000);
  assert.deepEqual(ws.sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
});

test('a closed connection turns the microphone off and says why', async () => {
  const stream = new FakeStream();
  mediaDevices.getUserMedia = async () => stream;
  const live = new LiveSession(options());
  /** @type {any[]} */
  const ended = [];
  live.addEventListener('ended', (e) => ended.push(/** @type {CustomEvent} */ (e).detail));
  await live.start();
  FakeWebSocket.all[0].onclose({ code: 1008, reason: 'API key not valid' });
  assert.equal(stream.live, false);
  assert.equal(live.ctx?.state, 'closed');
  assert.deepEqual(ended, [{ code: 1008, reason: 'API key not valid' }]);
});

test('a failed start turns the microphone off', async () => {
  const stream = new FakeStream();
  mediaDevices.getUserMedia = async () => stream;
  const live = new LiveSession(options());
  const ctx = new FakeAudioContext();
  ctx.audioWorklet.addModule = async () => { throw new Error('offline'); };
  live.opts.ctx = /** @type {any} */ (ctx);
  await assert.rejects(live.start(), /offline/);
  live.stop();
  assert.equal(stream.live, false);
  assert.equal(ctx.state, 'closed');
  assert.equal(FakeWebSocket.all.length, 0);
});

/** A clock whose time only moves when the test says so. */
function fakeClock() {
  let time = 0;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  let next = 1;
  return {
    now: () => time,
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      timers.set(next, { at: time + ms, fn });
      return next++;
    },
    clearTimeout: (/** @type {number} */ id) => { timers.delete(id); },
    get pending() { return timers.size; },
    /** Move the time on and run the timers that are due. */
    advance(/** @type {number} */ ms) {
      time += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= time) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    /** Move the time on without running timers, like a phone that froze the page. */
    freeze(/** @type {number} */ ms) { time += ms; },
  };
}

/** A fake page: a window and a document that can be hidden, and a clock. */
function fakePage(hash = '#/sesion?r=1') {
  const win = Object.assign(new EventTarget(), { location: { hash } });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const here = () => win.location.hash.startsWith('#/sesion');
  const clock = fakeClock();
  const calls = { left: 0, paused: 0, resumed: 0 };
  const watch = () => watchLeave(() => calls.left++, {
    here, win, doc, clock,
    pause: () => calls.paused++,
    resume: () => calls.resumed++,
  });
  const show = (/** @type {'visible' | 'hidden'} */ state) => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  return { win, doc, here, clock, calls, watch, show };
}

test('hiding the page pauses the session, and coming back within a minute carries on', () => {
  const page = fakePage();
  page.watch();
  page.show('visible');
  assert.deepEqual(page.calls, { left: 0, paused: 0, resumed: 0 }, 'still visible');
  page.show('hidden');
  page.show('hidden');
  assert.deepEqual(page.calls, { left: 0, paused: 1, resumed: 0 });
  page.clock.advance(HIDDEN_LIMIT_MS - 1);
  page.show('visible');
  assert.deepEqual(page.calls, { left: 0, paused: 1, resumed: 1 });
  assert.equal(page.clock.pending, 0, 'the timer was cleared');
  page.clock.advance(HIDDEN_LIMIT_MS * 2);
  assert.equal(page.calls.left, 0);
});

test('staying hidden for a minute ends the session once', () => {
  const page = fakePage();
  page.watch();
  page.show('hidden');
  page.clock.advance(HIDDEN_LIMIT_MS);
  assert.deepEqual(page.calls, { left: 1, paused: 1, resumed: 0 });
  page.show('visible');
  page.win.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(page.calls, { left: 1, paused: 1, resumed: 0 });
});

test('coming back after a phone froze the page counts the time away', () => {
  const page = fakePage();
  page.watch();
  page.show('hidden');
  page.clock.freeze(HIDDEN_LIMIT_MS + 1);
  page.show('visible');
  assert.deepEqual(page.calls, { left: 1, paused: 1, resumed: 0 });
  assert.equal(page.clock.pending, 0);
});

test('closing a hidden page ends the session at once', () => {
  const page = fakePage();
  page.watch();
  page.show('hidden');
  page.win.dispatchEvent(new Event('pagehide'));
  assert.equal(page.calls.left, 1);
  assert.equal(page.clock.pending, 0);
});

test('closing the page or going to another screen ends the session', () => {
  const closed = fakePage();
  closed.watch();
  closed.win.dispatchEvent(new Event('pagehide'));
  assert.equal(closed.calls.left, 1);

  const moved = fakePage();
  moved.watch();
  moved.win.location.hash = '#/sesion?r=2';
  moved.win.dispatchEvent(new Event('hashchange'));
  assert.equal(moved.calls.left, 0, 'still on the session screen');
  moved.win.location.hash = '#/';
  moved.win.dispatchEvent(new Event('hashchange'));
  assert.equal(moved.calls.left, 1);
});

test('the screen that follows a session is drawn after the session is saved', () => {
  const page = fakePage();
  const order = [];
  // main.js draws on hashchange before the session's own listener exists.
  page.win.addEventListener('hashchange', () => {
    if (!page.here()) leaveNow();
    order.push('drawn');
  });
  watchLeave(() => order.push('saved'), { here: page.here, win: page.win, doc: page.doc, clock: page.clock });
  page.win.location.hash = '#/';
  page.win.dispatchEvent(new Event('hashchange'));
  assert.deepEqual(order, ['saved', 'drawn'], 'saved once, before the draw');
  leaveNow();
  assert.deepEqual(order, ['saved', 'drawn'], 'nothing left to end');
});

test('leaving a session on its own ends nothing later', () => {
  const page = fakePage();
  const stop = page.watch();
  stop();
  leaveNow();
  assert.equal(page.calls.left, 0);
});

test('after a session ends, leaving the page does nothing', () => {
  const page = fakePage();
  const stop = page.watch();
  page.show('hidden');
  stop();
  assert.equal(page.clock.pending, 0, 'the timer was cleared');
  page.show('visible');
  page.show('hidden');
  page.win.dispatchEvent(new Event('pagehide'));
  page.clock.advance(HIDDEN_LIMIT_MS);
  assert.deepEqual(page.calls, { left: 0, paused: 1, resumed: 0 });
});

test('a paused session sends no microphone audio', async () => {
  const live = new LiveSession(options());
  await live.start();
  const ws = FakeWebSocket.all[0];
  ws.readyState = FakeWebSocket.OPEN;
  live.onMessage(JSON.stringify({ setupComplete: {} }));
  const samples = new Float32Array(480).fill(0.1);
  const audioSent = () => ws.sent.filter((m) => m.realtimeInput?.audio).length;
  live.onMic(samples);
  assert.equal(audioSent(), 1);
  live.setPaused(true);
  live.onMic(samples);
  assert.equal(audioSent(), 1, 'sent while paused');
  live.setPaused(false);
  live.onMic(samples);
  assert.equal(audioSent(), 2);
  live.setMuted(true);
  live.onMic(samples);
  assert.equal(audioSent(), 2, 'sent while muted');
  live.stop();
});

test('coming back wakes audio the phone suspended', async () => {
  const live = new LiveSession(options());
  await live.start();
  const ctx = /** @type {any} */ (live.ctx);
  let resumed = 0;
  ctx.resume = async () => { resumed++; ctx.state = 'running'; };
  live.setPaused(true);
  ctx.state = 'suspended';
  live.setPaused(false);
  assert.equal(resumed, 1);
  live.setPaused(true);
  live.setPaused(false);
  assert.equal(resumed, 1, 'already running');
  live.stop();
  live.setPaused(false);
  assert.equal(resumed, 1, 'closed');
});

/** A fake wake lock that arrives when the test says so. */
function fakeWakeLock() {
  const lock = { released: false, async release() { this.released = true; } };
  /** @type {(l: typeof lock) => void} */
  let arrive = () => {};
  const nav = { wakeLock: { request: () => new Promise((r) => { arrive = r; }) } };
  return { lock, nav, arrive: () => arrive(lock) };
}

const tick = () => new Promise((r) => setImmediate(r));

test('the screen lock is released when the session ends', async () => {
  const w = fakeWakeLock();
  const release = keepScreenOn(w.nav);
  w.arrive();
  await tick();
  assert.equal(w.lock.released, false);
  release();
  assert.equal(w.lock.released, true);
});

test('a screen lock that arrives after the session ended is released at once', async () => {
  const w = fakeWakeLock();
  const release = keepScreenOn(w.nav);
  release();
  w.arrive();
  await tick();
  assert.equal(w.lock.released, true);
});

test('no screen lock support is fine', async () => {
  keepScreenOn({})();
  keepScreenOn({ wakeLock: { request: () => Promise.reject(new Error('NotAllowedError')) } })();
  await tick();
});

/** A server message with a usage report, as the Live API sends it with turnComplete. */
const usageMessage = (prompt, response, details) => ({
  serverContent: { turnComplete: true },
  usageMetadata: {
    promptTokenCount: prompt,
    responseTokenCount: response,
    totalTokenCount: prompt + response,
    promptTokensDetails: details,
    responseTokensDetails: [{ modality: 'AUDIO', tokenCount: response }],
  },
});

test('usage adds up the report of every turn', () => {
  const live = new LiveSession(options());
  assert.deepEqual(live.usage, emptyUsage('gemini-3.8-live'));
  live.onMessage(JSON.stringify({ setupComplete: {} }));
  live.onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'Hola' } } }));
  // Turn 1: instructions and kickoff.
  live.onMessage(JSON.stringify(usageMessage(9, 11, [{ modality: 'TEXT', tokenCount: 9 }])));
  // Turn 2: the prompt counts the whole conversation again, as Google bills it.
  // The server sends binary frames, so this one is an ArrayBuffer.
  const turn2 = usageMessage(37, 10, [{ modality: 'TEXT', tokenCount: 17 }, { modality: 'AUDIO', tokenCount: 20 }]);
  live.onMessage(new TextEncoder().encode(JSON.stringify(turn2)).buffer);
  assert.deepEqual(live.usage, {
    model: 'gemini-3.8-live',
    turns: 2,
    reports: 2,
    input: { audio: 20, text: 26 },
    output: { audio: 21, text: 0 },
    promptTokenCount: 46,
    responseTokenCount: 21,
    thoughtsTokenCount: 0,
    totalTokenCount: 67,
  });
});

test('usage keeps each report as the server sent it', () => {
  const live = new LiveSession(options());
  const first = usageMessage(9, 11, [{ modality: 'TEXT', tokenCount: 9 }]);
  live.onMessage(JSON.stringify(first));
  live.onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
  live.onMessage(JSON.stringify({ usageMetadata: { promptTokenCount: 5, cachedContentTokenCount: 2 } }));
  assert.equal(live.usageLog.length, 2);
  assert.deepEqual(live.usageLog.map((e) => e.turnComplete), [true, false]);
  assert.deepEqual(live.usageLog[0].usageMetadata, first.usageMetadata);
  assert.deepEqual(live.usageLog[1].usageMetadata, { promptTokenCount: 5, cachedContentTokenCount: 2 }, 'fields Charla does not count are kept');
  assert.ok(live.usageLog.every((e) => Number.isFinite(e.ms) && e.ms >= 0));
});

test('the usage log stops growing at its limit, and the totals carry on', () => {
  const live = new LiveSession(options());
  const msg = JSON.stringify(usageMessage(1, 1, []));
  for (let i = 0; i < USAGE_LOG_LIMIT + 10; i++) live.onMessage(msg);
  assert.equal(live.usageLog.length, USAGE_LOG_LIMIT);
  assert.equal(live.usage.reports, USAGE_LOG_LIMIT + 10);
});

test('usage counts turns and reports separately', () => {
  const live = new LiveSession(options());
  live.onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
  live.onMessage(JSON.stringify({ usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 } }));
  assert.equal(live.usage.turns, 1);
  assert.equal(live.usage.reports, 1);
  assert.equal(live.usage.promptTokenCount, 5);
});

test('addUsage adds every count, thinking tokens included', () => {
  const total = emptyUsage('m');
  const report = {
    input: { audio: 1, text: 2 }, output: { audio: 3, text: 4 },
    promptTokenCount: 3, responseTokenCount: 7, thoughtsTokenCount: 5, totalTokenCount: 15,
  };
  addUsage(addUsage(total, report), report);
  assert.deepEqual(total, {
    model: 'm', turns: 0, reports: 2,
    input: { audio: 2, text: 4 }, output: { audio: 6, text: 8 },
    promptTokenCount: 6, responseTokenCount: 14, thoughtsTokenCount: 10, totalTokenCount: 30,
  });
});
