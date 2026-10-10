import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TurnDetector, levelDb, END_PAUSE_MS, MAX_TURN_MS } from '../src/core/turns.js';
import {
  replyRequest, parseReply, speechRequest, decodeAudio, readEvents, pickSpainVoice, createPipeline, turnUsage, wavBytes, chooseVoice, anySignal,
  PIPELINE_MODEL, SPEECH_MODEL, FALLBACK_VOICE, REPLY_RULES,
} from '../src/core/pipeline.js';
import { questionNote } from '../src/core/prompts.js';
import { PipelineSession } from '../src/live/pipeline.js';
import { bestSpanishVoice, sentences, speakWithDevice, unlockDeviceVoice } from '../src/live/device-voice.js';
import { bytesToBase64 } from '../src/core/audio.js';

// Blocks of 16 kHz audio, about 43 ms each, like the microphone sends after downsampling.
const BLOCK = 682;
const tone = (amp = 9000) => Int16Array.from({ length: BLOCK }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * 200 * i) / 16000)));
const quiet = () => new Int16Array(BLOCK).fill(3);
const blocksFor = (ms) => Math.ceil(ms / ((BLOCK / 16000) * 1000));

/** Push blocks and collect the events. */
function feed(d, make, ms, events) {
  for (let i = 0; i < blocksFor(ms); i++) {
    const e = d.push(make());
    if (e) events.push(e);
  }
}

test('a turn starts with speech and ends after a long pause, not a short one', () => {
  const d = new TurnDetector();
  const events = [];
  feed(d, quiet, 500, events);
  assert.deepEqual(events, []);
  feed(d, tone, 800, events);
  assert.deepEqual(events.map((e) => e.type), ['start']);
  feed(d, quiet, 1800, events);
  assert.deepEqual(events.map((e) => e.type), ['start'], 'a 1.8 s pause to think doesn\'t end the turn');
  feed(d, tone, 600, events);
  feed(d, quiet, END_PAUSE_MS + 100, events);
  const end = events.at(-1);
  assert.equal(end.type, 'end');
  const seconds = end.audio.length / 16000;
  assert.ok(seconds > 3.4 && seconds < 3.9, `both parts, the pause, a little before and after (${seconds.toFixed(2)} s)`);
  assert.ok(end.speechMs >= 1300);
  assert.ok(levelDb(end.audio.subarray(end.audio.length - 1000)) < -60, 'it ends with quiet');
});

test('a click or a cough is not a turn', () => {
  const d = new TurnDetector();
  const events = [];
  feed(d, quiet, 300, events);
  feed(d, tone, 150, events);
  feed(d, quiet, END_PAUSE_MS + 100, events);
  assert.deepEqual(events.map((e) => e.type), ['start', 'noise']);
});

test('a turn that never pauses ends at the limit', () => {
  const d = new TurnDetector();
  const events = [];
  feed(d, tone, MAX_TURN_MS + 200, events);
  assert.deepEqual(events.slice(0, 2).map((e) => e.type), ['start', 'end'], 'and the speech after it starts a new turn');
  assert.ok(Math.abs(events[1].audio.length / 16000 - MAX_TURN_MS / 1000) < 0.2);
});

test('the background measured while charla thinks raises the bar for speech', () => {
  const d = new TurnDetector();
  const noisy = () => tone(400); // about -38 dB, a busy room
  const events = [];
  for (let i = 0; i < 20; i++) d.calibrate(noisy());
  d.reset();
  feed(d, noisy, 2000, events);
  assert.deepEqual(events, [], 'the room alone is not speech');
  feed(d, tone, 600, events);
  assert.deepEqual(events.map((e) => e.type), ['start']);
});

test('replies come back as JSON with what the model heard', () => {
  const body = replyRequest({ system: 'Eres mi compañero.', history: [{ role: 'user', text: 'Hola' }, { role: 'model', text: '¿Qué tal?' }], input: { audio: Int16Array.from([1, 2]) }, thinking: true });
  assert.equal(body.systemInstruction.parts[0].text, `Eres mi compañero.${REPLY_RULES}`);
  assert.deepEqual(body.contents.slice(0, 2), [{ role: 'user', parts: [{ text: 'Hola' }] }, { role: 'model', parts: [{ text: '¿Qué tal?' }] }]);
  assert.equal(body.contents[2].parts[0].inlineData.mimeType, 'audio/wav');
  assert.equal(Buffer.from(body.contents[2].parts[0].inlineData.data, 'base64').subarray(0, 4).toString(), 'RIFF');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.equal(replyRequest({ system: '', history: [], input: { text: 'Hola' }, thinking: false }).generationConfig.thinkingConfig, undefined);
  assert.match(REPLY_RULES, /25 palabras/);
  assert.match(REPLY_RULES, /no digas «¿Sí\?» ni «Sigue»/);

  assert.deepEqual(parseReply('{"heard":"me gusta","reply":"¡Qué bien!"}'), { heard: 'me gusta', reply: '¡Qué bien!' });
  assert.deepEqual(parseReply('```json\n{"heard": "sí", "reply": "Vale."}\n```'), { heard: 'sí', reply: 'Vale.' });
  assert.deepEqual(parseReply('Hola, ¿qué tal?'), { heard: '', reply: 'Hola, ¿qué tal?' });
});

test('speech requests ask Google not to keep the words', () => {
  const body = speechRequest({ text: 'Hola', voice: 'v1' });
  assert.equal(body.model, SPEECH_MODEL);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.generation_config.speech_config, [{ voice: 'v1' }]);
  assert.equal(body.input[0].content[0].text, 'Hola');
});

/** A smooth tone as raw bytes in either order. */
function toneBytes(bigEndian) {
  const bytes = Buffer.alloc(960);
  for (let i = 0; i < 480; i++) {
    const v = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 24000));
    if (bigEndian) bytes.writeInt16BE(v, i * 2); else bytes.writeInt16LE(v, i * 2);
  }
  return bytes;
}

test('voice audio is read as WAV, or as raw PCM in whichever byte order sounds like speech', () => {
  const expected = [...new Int16Array(toneBytes(false).buffer.slice(0))];
  for (const big of [false, true]) {
    const { samples, rate } = decodeAudio({ data: toneBytes(big).toString('base64'), mime: 'audio/l16', rate: 0 });
    assert.deepEqual([...samples], expected);
    assert.equal(rate, 24000);
  }
  const wav = decodeAudio({ data: bytesToBase64(wavBytes(Int16Array.from([1, -2, 3]), 16000)), mime: 'audio/wav', rate: 0 });
  assert.deepEqual([...wav.samples], [1, -2, 3]);
  assert.equal(wav.rate, 16000);
});

/** A response body that arrives in the given pieces. */
const bodyOf = (pieces) => new ReadableStream({ start(c) { for (const p of pieces) c.enqueue(new TextEncoder().encode(p)); c.close(); } });

test('stream events are read across chunk boundaries', async () => {
  const events = [];
  const r = await readEvents(bodyOf(['data: {"a"', ':1}\r\n\r\ndata: {"b":2}\n\n', 'data: [DONE]\n\ndata: {"c":3}']), (e) => events.push(e));
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.equal(r.stalled, false);
});

/** A stream that sends these pieces and then nothing, without closing, as Google's voice did on 10 October. */
const stuckBodyOf = (pieces) => new ReadableStream({ start(c) { for (const p of pieces) c.enqueue(new TextEncoder().encode(p)); } });

test('a stream that stops sending is given up on', async () => {
  const events = [];
  let stalls = 0;
  const r = await readEvents(stuckBodyOf(['data: {"a":1}\n\n']), (e) => events.push(e), { stallMs: 30, onStall: () => { stalls += 1; } });
  assert.deepEqual(events, [{ a: 1 }]);
  assert.equal(r.stalled, true);
  assert.equal(stalls, 1);
});

test('a signal that follows several, also where AbortSignal.any is missing', () => {
  const a = new AbortController();
  const b = new AbortController();
  const any = anySignal([a.signal, b.signal]);
  assert.equal(any.aborted, false);
  b.abort();
  assert.equal(any.aborted, true);
  const native = AbortSignal.any;
  try {
    AbortSignal.any = undefined;
    const c = new AbortController();
    const fallback = anySignal([new AbortController().signal, c.signal]);
    c.abort();
    assert.equal(fallback.aborted, true);
  } finally {
    AbortSignal.any = native;
  }
});

test('the voice suits a conversation: not an advert voice, a woman\'s first on a tie', () => {
  const voices = [
    { id: 'es-es-commercial-3', name: 'Commercial Voiceover 3', gender: 'female', description: '' },
    { id: 'es-es-friendly-1', name: 'Lucía', gender: 'female', description: 'Warm and friendly, for conversations' },
    { id: 'es-es-2', name: 'Álvaro', gender: 'male', description: '' },
  ];
  assert.equal(chooseVoice(voices)?.id, 'es-es-friendly-1');
  assert.equal(chooseVoice([...voices, { id: 'es-es-tutor-12', name: 'Tutor 12', gender: 'female', description: '' }])?.id, 'es-es-tutor-12', 'a tutor\'s voice first');
  assert.equal(chooseVoice(voices.filter((v) => v.id !== 'es-es-friendly-1'))?.id, 'es-es-2', 'a plain voice beats an advert voice');
  assert.equal(chooseVoice([]), null);
});

test('the question note follows «siguiente pregunta», so the model doesn\'t have to', () => {
  assert.match(questionNote([]), /primera pregunta/);
  const h = [{ role: 'user', text: 'Hola. Empecemos.' }, { role: 'model', text: 'Primera pregunta: ¿Te gusta viajar?' }];
  assert.match(questionNote(h), /vamos por la primera pregunta\. Si en este turno digo «siguiente pregunta», haz la segunda/);
  const at3 = [...h, { role: 'user', text: 'Siguiente pregunta.' }, { role: 'model', text: 'x' }, { role: 'user', text: 'Me gusta.' }, { role: 'model', text: 'y' }, { role: 'user', text: 'SIGUIENTE pregunta' }, { role: 'model', text: 'z' }];
  assert.match(questionNote(at3), /vamos por la tercera pregunta/);
  const at5 = [...at3, { role: 'user', text: 'siguiente pregunta' }, { role: 'model', text: 'a' }, { role: 'user', text: 'siguiente pregunta' }, { role: 'model', text: 'b' }];
  assert.match(questionNote(at5), /quinta y última/);
  assert.match(questionNote([...at5, { role: 'user', text: 'Siguiente pregunta' }, { role: 'model', text: 'c' }]), /ya hemos hecho las 5/);
  assert.match(questionNote([{ role: 'model', text: 'Siguiente pregunta: la segunda' }, ...h]), /primera pregunta/, 'only the learner\'s words count');
});

test('turn usage adds the reply and the speech at list prices', () => {
  const u = turnUsage({ promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1000 }, { modality: 'AUDIO', tokenCount: 200 }], candidatesTokenCount: 50 }, null, 4);
  assert.deepEqual(u.input, { audio: 200, text: 1000 });
  assert.deepEqual(u.output, { audio: 100, text: 50 }, '4 s of speech is 100 tokens');
  assert.ok(Math.abs(u.cost - (1000 * 0.25 + 200 * 0.5 + 50 * 1.5 + 100 * 6) / 1e6) < 1e-12);
  const counted = turnUsage({ promptTokenCount: 500 }, { total_input_tokens: 10, total_output_tokens: 80 }, 4);
  assert.deepEqual(counted.input, { audio: 0, text: 510 });
  assert.equal(counted.output.audio, 80, 'Google\'s own count wins');
});

/**
 * A fake Google for the pipeline. Each call is recorded. `failReply` makes
 * the nth reply call fail with that status.
 */
function fakeGoogle({ failReply = {}, thinkingError = false, voiceError = false, stuckVoices = 0, failVoice = {} } = {}) {
  const calls = [];
  let replies = 0;
  let voices = 0;
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: init.headers, signal: init.signal });
    if (url.includes('/voices')) {
      return Response.json({ voices: [{ id: 'es-ES-1', language_code: 'es-ES', gender: 'male' }, { id: 'es-ES-2', language_code: 'es-ES', gender: 'female' }, { id: 'mx-1', language_code: 'es-MX', gender: 'female' }] });
    }
    if (url.includes(':generateContent')) {
      if (thinkingError && body.generationConfig.thinkingConfig) return Response.json({ error: { message: 'Thinking is not supported' } }, { status: 400 });
      replies += 1;
      if (failReply[replies]) return Response.json({ error: { message: 'Something went wrong' } }, { status: failReply[replies] });
      const text = JSON.stringify(replies === 1 ? { heard: '', reply: 'Hola. Primera pregunta: ¿Te gusta viajar?' } : { heard: 'sí me gusta mucho', reply: 'Muy bien. Segunda pregunta.' });
      return Response.json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokensDetails: [{ modality: 'TEXT', tokenCount: 600 }], candidatesTokenCount: 30 } });
    }
    if (url.endsWith('/interactions')) {
      if (voiceError && body.generation_config.speech_config[0].voice !== FALLBACK_VOICE) return Response.json({ error: { message: 'Unknown voice' } }, { status: 400 });
      voices += 1;
      if (failVoice[voices]) return Response.json({ error: { message: `Voice failed with ${failVoice[voices]}` } }, { status: failVoice[voices] });
      if (voices <= stuckVoices) return new Response(stuckBodyOf([]), { headers: { 'content-type': 'text/event-stream' } });
      const chunk = toneBytes(false).toString('base64');
      return new Response(bodyOf([
        `event: step.delta\ndata: ${JSON.stringify({ delta: { type: 'audio', data: chunk, mime_type: 'audio/l16', sample_rate: 24000 } })}\n\n`,
        `event: interaction.completed\ndata: ${JSON.stringify({ interaction: { usage: { total_input_tokens: 12, total_output_tokens: 20 } } })}\n\n`,
      ]), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('', { status: 404 });
  };
  return { fetch, calls };
}

test('a Spain voice is picked from Google\'s library, a woman\'s first', async () => {
  const google = fakeGoogle();
  assert.equal(await pickSpainVoice('k', google.fetch), 'es-ES-2');
  assert.equal(google.calls[0].headers['x-goog-api-key'], 'k');
  assert.ok(!google.calls[0].url.includes('key='), 'the key never goes in a URL');
  assert.equal(await pickSpainVoice('k', async () => new Response('', { status: 403 })), null);
  assert.equal(await pickSpainVoice('k', async () => { throw new Error('offline'); }), null);
});

test('the pipeline drops a setting Google refuses and says so', async () => {
  const google = fakeGoogle({ thinkingError: true, voiceError: true });
  const p = createPipeline({ key: 'k', voice: 'es-ES-2', fetchFn: google.fetch });
  const r = await p.ask('Eres mi compañero.', [], { text: 'Hola' });
  assert.equal(r.reply, 'Hola. Primera pregunta: ¿Te gusta viajar?');
  await p.ask('Eres mi compañero.', [], { text: 'Hola' });
  assert.equal(google.calls.filter((c) => c.body?.generationConfig?.thinkingConfig).length, 1, 'asked with thinking once, then never again');
  const got = [];
  const speech = await p.speak('Hola', (samples, rate) => got.push([samples.length, rate]));
  assert.deepEqual(got, [[480, 24000]]);
  assert.ok(Math.abs(speech.seconds - 0.02) < 1e-9);
  assert.equal(p.voice, FALLBACK_VOICE);
  assert.equal(p.notes.length, 2);
  assert.match(google.calls.find((c) => c.url.includes(':generateContent')).url, new RegExp(`models/${PIPELINE_MODEL}:generateContent$`));
});

test('the pipeline asks once more when Google fails or the voice stalls', async () => {
  const google = fakeGoogle({ failReply: { 1: 503 }, stuckVoices: 1 });
  const p = createPipeline({ key: 'k', voice: 'v', fetchFn: google.fetch, stallMs: 30 });
  const r = await p.ask('', [], { text: 'Hola' });
  assert.equal(r.reply, 'Muy bien. Segunda pregunta.', 'the second answer');
  assert.equal(google.calls.filter((c) => c.url.includes(':generateContent')).length, 2);
  const got = [];
  await p.speak('Hola', (samples) => got.push(samples.length));
  assert.deepEqual(got, [480]);
  assert.equal(google.calls.filter((c) => c.url.endsWith('/interactions')).length, 2);
  assert.match(p.notes[0], /failed once/);
  assert.match(p.notes[1], /sent no audio/);

  const broken = createPipeline({ key: 'k', voice: 'v', fetchFn: fakeGoogle({ stuckVoices: 2 }).fetch, stallMs: 30 });
  await assert.rejects(broken.speak('Hola', () => {}), /no audio came back/, 'it gives up after the second stall');
  const refused = createPipeline({ key: 'k', voice: 'v', fetchFn: fakeGoogle({ failReply: { 1: 400 } }).fetch });
  await assert.rejects(refused.ask('', [], { text: 'Hola' }), /Something went wrong/, 'a refused request is not asked again');
});

// Browser fakes for a pipeline session.
class FakeTrack { readyState = 'live'; stop() { this.readyState = 'ended'; } }
class FakeStream { tracks = [new FakeTrack()]; getTracks() { return this.tracks; } }
class FakeSource {
  constructor(ctx) { this.ctx = ctx; this.buffer = null; this.onended = null; }
  connect() {}
  start(at) { this.ctx.started.push(at); setTimeout(() => this.onended?.(), 0); }
  stop() {}
}
class FakeAudioContext {
  state = 'running';
  sampleRate = 16000;
  currentTime = 0;
  destination = {};
  started = [];
  audioWorklet = { addModule: async () => {} };
  async resume() {}
  async close() { this.state = 'closed'; }
  createMediaStreamSource() { return { connect() {} }; }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  createBuffer(_channels, length, rate) { return { duration: length / rate, copyToChannel() {} }; }
  createBufferSource() { return new FakeSource(this); }
}
class FakeWorkletNode { port = { onmessage: null }; connect() {} disconnect() {} }
globalThis.window = globalThis;
globalThis.AudioContext = FakeAudioContext;
globalThis.AudioWorkletNode = FakeWorkletNode;
const mediaDevices = { getUserMedia: async () => new FakeStream() };
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices }, configurable: true, writable: true });

beforeEach(() => {
  mediaDevices.getUserMedia = async () => new FakeStream();
});

/** Speak into the fake microphone: blocks of Float32 samples at 16 kHz. */
function say(session, make, ms) {
  for (let i = 0; i < blocksFor(ms); i++) {
    const pcm = make();
    session.node?.port.onmessage?.({ data: Float32Array.from(pcm, (v) => v / 32768) });
  }
}

const until = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test('a pipeline session greets, listens until the pause, answers, and adds up its cost', async () => {
  const google = fakeGoogle();
  const s = new PipelineSession({ apiKey: 'k', systemPrompt: 'Eres mi compañero.', kickoff: 'Hola. Empecemos.', fetchFn: google.fetch, turnNote: (h) => ` Nota ${h.length}.` });
  const statuses = [];
  s.addEventListener('status', (e) => statuses.push(e.detail));
  await s.start();
  assert.deepEqual(statuses, ['connecting', 'thinking', 'speaking', 'listening']);
  assert.deepEqual(s.transcript, [{ role: 'model', text: 'Hola. Primera pregunta: ¿Te gusta viajar?' }]);
  const spoken = google.calls.find((c) => c.url.endsWith('/interactions'));
  assert.deepEqual(spoken.body.generation_config.speech_config, [{ voice: 'es-ES-2' }]);

  say(s, quiet, 400);
  say(s, tone, 1000);
  say(s, quiet, 1500);
  assert.equal(google.calls.filter((c) => c.url.includes(':generateContent')).length, 1, 'a 1.5 s pause doesn\'t end the answer');
  say(s, tone, 500);
  say(s, quiet, 2100);
  await until(() => s.transcript.length === 3 && s.status === 'listening', 'the second reply');
  assert.deepEqual(s.transcript.slice(1), [{ role: 'user', text: 'sí me gusta mucho' }, { role: 'model', text: 'Muy bien. Segunda pregunta.' }]);

  const asked = google.calls.filter((c) => c.url.includes(':generateContent'))[1];
  assert.equal(asked.body.systemInstruction.parts[0].text, `Eres mi compañero. Nota 2.${REPLY_RULES}`, 'the turn note goes in after the prompt');
  assert.deepEqual(asked.body.contents.slice(0, 2).map((c) => c.parts[0].text), ['Hola. Empecemos.', 'Hola. Primera pregunta: ¿Te gusta viajar?']);
  const wav = Buffer.from(asked.body.contents[2].parts[0].inlineData.data, 'base64');
  const seconds = (wav.length - 44) / 2 / 16000;
  assert.ok(seconds > 3.2 && seconds < 3.8, `the whole answer goes in one piece (${seconds.toFixed(2)} s)`);

  assert.equal(s.usage.engine, 'pipeline');
  assert.equal(s.usage.turns, 2);
  assert.equal(s.usageLog.length, 2);
  const turnCost = (600 * 0.25 + 30 * 1.5 + 12 * 0.5 + 20 * 6) / 1e6;
  assert.ok(Math.abs(s.usage.cost - 2 * turnCost) < 1e-12);

  s.stop();
  assert.equal(s.status, 'closed');
  assert.equal(s.stream, null);
  assert.ok(google.calls.at(-1).signal.aborted, 'calls in progress are cancelled');
});

test('the microphone is ignored while charla speaks, and a failed reply keeps the session going', async () => {
  const google = fakeGoogle({ failReply: { 2: 400 } });
  const s = new PipelineSession({ apiKey: 'k', systemPrompt: '', kickoff: 'Hola', fetchFn: google.fetch });
  const errors = [];
  s.addEventListener('error', (e) => errors.push(e.detail));
  await s.start();
  say(s, tone, 800);
  say(s, quiet, 2100);
  await until(() => errors.length === 1 && s.status === 'listening', 'the error');
  assert.match(errors[0], /Something went wrong/);
  assert.equal(s.transcript.length, 1, 'nothing is added for a failed turn');

  // While charla thinks, sound only measures the room.
  s.busy = true;
  s.status = 'thinking';
  say(s, tone, 1000);
  s.busy = false;
  assert.equal(google.calls.filter((c) => c.url.includes(':generateContent')).length, 2, 'nothing sent while busy');
  s.stop();
});

test('a session whose first reply fails ends and says why', async () => {
  const google = fakeGoogle({ failReply: { 1: 403 } });
  const s = new PipelineSession({ apiKey: 'bad', systemPrompt: '', kickoff: 'Hola', fetchFn: google.fetch });
  let ended = null;
  s.addEventListener('ended', (e) => { ended = e.detail; });
  await s.start();
  assert.equal(ended.code, 403);
  assert.match(ended.reason, /Something went wrong/);
  assert.equal(s.status, 'closed');
  assert.equal(s.stream, null, 'the microphone is off');
});

test('ending while the browser asks for the microphone never calls Google', async () => {
  const google = fakeGoogle();
  let allow;
  mediaDevices.getUserMedia = () => new Promise((r) => { allow = () => r(new FakeStream()); });
  const s = new PipelineSession({ apiKey: 'k', systemPrompt: '', kickoff: 'Hola', fetchFn: google.fetch });
  const started = s.start();
  await until(() => allow, 'the microphone prompt');
  s.stop();
  allow();
  await started;
  assert.equal(google.calls.length, 0);
});

test('the device voice is the best Spanish one: Spain first, then a natural voice', () => {
  const voices = [
    { name: 'Samantha', lang: 'en-US', localService: true },
    { name: 'Paulina', lang: 'es-MX', localService: true },
    { name: 'Mónica', lang: 'es-ES', localService: true },
    { name: 'Google español', lang: 'es-ES', localService: false },
    { name: 'Microsoft Elvira Online (Natural) - Spanish (Spain)', lang: 'es-ES', localService: false },
  ];
  assert.equal(bestSpanishVoice(voices)?.name, 'Microsoft Elvira Online (Natural) - Spanish (Spain)');
  assert.equal(bestSpanishVoice(voices.slice(0, 4))?.name, 'Google español');
  assert.equal(bestSpanishVoice(voices.slice(0, 3))?.name, 'Mónica');
  assert.equal(bestSpanishVoice([{ name: 'Mónica', lang: 'es_ES' }, { name: 'Paulina', lang: 'es-MX' }])?.name, 'Mónica', 'Android writes es_ES');
  assert.equal(bestSpanishVoice(voices.slice(0, 1)), null);
  assert.deepEqual(sentences('Muy bien. ¿Y tú? ¡Qué bonito! Cuéntame más…'), ['Muy bien.', '¿Y tú?', '¡Qué bonito!', 'Cuéntame más…']);
  assert.deepEqual(sentences('Dijo «hola.» Y se fue'), ['Dijo «hola.»', 'Y se fue']);
});

/** A fake speechSynthesis that finishes each sentence at once. */
function fakeSynth(voices) {
  const said = [];
  const synth = {
    cancelled: 0,
    getVoices: () => voices,
    addEventListener() {},
    cancel() { this.cancelled += 1; },
    speak(u) { said.push(u); setTimeout(() => u.onend?.(), 0); },
  };
  class Utterance { constructor(text) { this.text = text; this.volume = 1; } }
  return { synth, Utterance, said };
}

test('the device voice says each sentence in the Spain voice, and says no when there is none', async () => {
  const { synth, Utterance, said } = fakeSynth([{ name: 'Mónica', lang: 'es-ES', localService: true }]);
  assert.equal(await speakWithDevice('Hola. ¿Qué tal?', { synth, Utterance }), true);
  assert.deepEqual(said.map((u) => [u.text, u.voice.name, u.lang]), [['Hola.', 'Mónica', 'es-ES'], ['¿Qué tal?', 'Mónica', 'es-ES']]);
  assert.ok(said.every((u) => u.rate < 1), 'a little slower for learners');

  const english = fakeSynth([{ name: 'Samantha', lang: 'en-US' }]);
  assert.equal(await speakWithDevice('Hola.', english), false);
  assert.equal(english.said.length, 0);
  assert.equal(await speakWithDevice('Hola.', {}), false, 'no speech synthesis at all');

  // A browser that never says it has finished: charla stops waiting.
  const silent = fakeSynth([{ name: 'Mónica', lang: 'es-ES' }]);
  silent.synth.speak = (u) => silent.said.push(u);
  const start = Date.now();
  assert.equal(await speakWithDevice('Hola.', { ...silent, msPerWord: 1 }), true);
  assert.ok(Date.now() - start < 3500);

  // Ending the session stops the voice.
  const stopped = fakeSynth([{ name: 'Mónica', lang: 'es-ES' }]);
  stopped.synth.speak = (u) => stopped.said.push(u);
  const ctl = new AbortController();
  const speaking = speakWithDevice('Hola. Adiós.', { ...stopped, signal: ctl.signal });
  await until(() => stopped.said.length === 2, 'the sentences');
  ctl.abort();
  assert.equal(await speaking, true);
  assert.equal(stopped.synth.cancelled, 2, 'cleared before speaking and when stopped');

  const tap = fakeSynth([]);
  unlockDeviceVoice(tap.synth, tap.Utterance);
  assert.deepEqual(tap.said.map((u) => [u.text, u.volume]), [[' ', 0]], 'a silent word during the tap');
});

test('when Google refuses its voice, the device says the reply, and after too many requests the rest of the session', async () => {
  const google = fakeGoogle({ failVoice: { 1: 503, 2: 503, 4: 429 } });
  const device = [];
  const deviceSpeak = async (text) => { device.push(text); return true; };
  const s = new PipelineSession({ apiKey: 'k', systemPrompt: '', kickoff: 'Hola', fetchFn: google.fetch, deviceSpeak });
  const errors = [];
  s.addEventListener('error', (e) => errors.push(e.detail));
  await s.start();
  // A server error, asked twice: the device says this reply, and Google is asked again next time.
  assert.deepEqual(device, ['Hola. Primera pregunta: ¿Te gusta viajar?']);
  assert.equal(s.status, 'listening');
  assert.equal(s.deviceVoice, false);

  const speak = () => google.calls.filter((c) => c.url.endsWith('/interactions')).length;
  say(s, tone, 800);
  say(s, quiet, 2100);
  await until(() => s.transcript.length === 3 && s.status === 'listening', 'the second reply');
  assert.equal(speak(), 3, 'Google said the second reply');
  assert.equal(device.length, 1);

  // Too many requests: asked once, then the device for the rest of the session.
  say(s, tone, 800);
  say(s, quiet, 2100);
  await until(() => s.transcript.length === 5 && s.status === 'listening', 'the third reply');
  say(s, tone, 800);
  say(s, quiet, 2100);
  await until(() => s.transcript.length === 7 && s.status === 'listening', 'the fourth reply');
  assert.equal(speak(), 4, 'a 429 is not asked again, and Google is not asked for the next reply');
  assert.equal(device.length, 3);
  assert.equal(s.usage.deviceReplies, 3);
  assert.equal(s.usage.turns, 4);
  assert.match(s.usageLog.at(-1).usageMetadata.deviceVoice, /Voice failed with 429/);
  assert.deepEqual(errors, [], 'the learner sees no error while the device can speak');
  s.stop();

  // A device with no Spanish voice shows Google's error instead.
  const quietDevice = new PipelineSession({ apiKey: 'k', systemPrompt: '', kickoff: 'Hola', fetchFn: fakeGoogle({ failVoice: { 1: 429 } }).fetch, deviceSpeak: async () => false });
  const shown = [];
  quietDevice.addEventListener('error', (e) => shown.push(e.detail));
  await quietDevice.start();
  assert.equal(shown.length, 1);
  assert.match(shown[0], /Voice failed with 429/);
  assert.equal(quietDevice.status, 'listening', 'the session goes on');
  quietDevice.stop();
});

