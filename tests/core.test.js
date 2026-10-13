import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, kickoff, summaryPrompt, topicsPrompt, transcriptText } from '../src/core/prompts.js';
import { appendChunk, cleanTurns } from '../src/core/transcript.js';
import { floatTo16, int16ToFloat, downsample, pcmToBase64, base64ToPcm, parseRate } from '../src/core/audio.js';
import { pickLiveModels, pickTextModels, parseJson, setupMessage, audioMessage, textMessage, parseServerMessage, parseUsage, liveUrl, generateJson, listModels, textThinking, LEARNER_SILENCE_MS } from '../src/core/gemini.js';
import { createStore, memoryStorage, KEY, KEEP_TRANSCRIPTS, KEEP_USAGE_LOGS, IMPORT_LIMITS } from '../src/core/store.js';
import { themeId } from '../src/core/themes.js';
import { saveSession, generateTopics, topicsRequester, sharedTopicsRequester, TOPICS_WAIT_MS } from '../src/actions.js';

test('system prompt for 5 preguntas', () => {
  const p = systemPrompt({ activity: 'questions', theme: 'La comida', round: 2, previousQuestions: ['¿Qué desayunas?'], about: 'Vivo en Zamora.', recent: [{ date: '2026-09-20', label: 'Aprender algo: Le Corbusier' }] });
  assert.match(p, /Tema: La comida\. Es la ronda 2 de 3/);
  assert.match(p, /«siguiente pregunta»/);
  assert.match(p, /- ¿Qué desayunas\?/);
  assert.match(p, /Sobre mí:\nVivo en Zamora\./);
  assert.match(p, /2026-09-20: Aprender algo: Le Corbusier/);
});

test('the 5 preguntas prompt numbers the questions and waits through pauses', () => {
  const p = systemPrompt({ activity: 'questions', theme: 'El ciclismo' });
  assert.match(p, /primera, segunda, tercera, cuarta y quinta\. Usa cada número una sola vez/);
  assert.match(p, /no tienen número y no cuentan como una de las 5/);
  assert.match(p, /si acaba en «pero», «y» o «porque», di solo «¿Sí\?» o «Sigue» y espera/);
  assert.match(p, /No me pidas que hable en español, salvo que diga una frase entera en otro idioma/);
  const learn = systemPrompt({ activity: 'learn', topic: { interest: 'x', title: 'y' } });
  assert.match(learn, /Hago pausas para pensar/, 'the pause rule is for both activities');
});

test('system prompt for aprender algo', () => {
  const p = systemPrompt({ activity: 'learn', topic: { interest: 'arquitectura', title: 'Le Corbusier' } });
  assert.match(p, /Tema elegido: Le Corbusier \(arquitectura\)/);
  assert.doesNotMatch(p, /Sobre mí/);
  assert.equal(kickoff('learn', { interest: 'x', title: 'Le Corbusier' }), 'Hola. Hoy quiero aprender sobre: Le Corbusier.');
});

test('summary and topics prompts', () => {
  assert.match(summaryPrompt({ activity: 'questions', theme: 'La comida' }, 'Yo: hola'), /«5 preguntas» con el tema «La comida»/);
  assert.match(topicsPrompt({ interests: ['fútbol', 'diseño'], covered: ['La Masia'] }), /fútbol, diseño[\s\S]*- La Masia/);
  assert.equal(transcriptText([{ role: 'model', text: ' Hola ' }, { role: 'user', text: 'Buenas' }]), 'Tú: Hola\nYo: Buenas');
});

test('transcript chunks build turns', () => {
  const t = [];
  appendChunk(t, 'model', ' Hola,');
  appendChunk(t, 'model', ' ¿qué tal?');
  appendChunk(t, 'user', 'Muy');
  appendChunk(t, 'user', ' bien');
  appendChunk(t, 'user', '');
  appendChunk(t, 'model', 'Genial.');
  assert.deepEqual(cleanTurns(t), [
    { role: 'model', text: 'Hola, ¿qué tal?' },
    { role: 'user', text: 'Muy bien' },
    { role: 'model', text: 'Genial.' },
  ]);
});

test('audio conversions', () => {
  const f = new Float32Array([0, 0.5, -0.5, 1, -1, 2]);
  const p = floatTo16(f);
  assert.deepEqual([...p], [0, 16383, -16384, 32767, -32768, 32767]);
  const back = base64ToPcm(pcmToBase64(p));
  assert.deepEqual([...back], [...p]);
  assert.ok(Math.abs(int16ToFloat(new Int16Array([16384]))[0] - 0.5) < 1e-6);
  const d = downsample(new Float32Array(4800).fill(0.25), 48000, 16000);
  assert.equal(d.length, 1600);
  assert.ok(d.every((x) => Math.abs(x - 0.25) < 1e-6));
  assert.equal(downsample(new Float32Array(441), 44100, 16000).length, 160);
  assert.equal(parseRate('audio/pcm;rate=24000'), 24000);
  assert.equal(parseRate('audio/pcm'), 24000);
});

const MODELS = [
  { name: 'models/gemini-3.8-live', supportedGenerationMethods: ['bidiGenerateContent'] },
  { name: 'models/gemini-3.8-live-extended-thinking', supportedGenerationMethods: ['bidiGenerateContent'] },
  { name: 'models/gemini-3.5-live-translate-preview', supportedGenerationMethods: ['bidiGenerateContent'] },
  { name: 'models/gemini-3.1-flash-live-preview', supportedGenerationMethods: ['bidiGenerateContent'] },
  { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.5-pro', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.5-flash-image', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
];

test('model picking', () => {
  const live = pickLiveModels(MODELS);
  assert.equal(live[0], 'gemini-3.8-live');
  assert.equal(live.at(-1), 'gemini-3.5-live-translate-preview');
  const text = pickTextModels(MODELS);
  assert.equal(text[0], 'gemini-3.5-flash');
  assert.ok(!text.includes('gemini-3.5-flash-image'));
  assert.ok(!text.includes('gemini-3.5-flash-preview-tts'));
  assert.ok(!text.includes('gemini-3.8-live'));
});

test('parseJson handles fences and extra text', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Aquí tienes: {"a": 2} gracias'), { a: 2 });
  assert.throws(() => parseJson('nada'));
});

test('live messages', () => {
  const s = setupMessage({ model: 'gemini-3.8-live', systemPrompt: 'Hola', voice: 'Kore' });
  assert.deepEqual(s, {
    setup: {
      model: 'models/gemini-3.8-live',
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
      systemInstruction: { parts: [{ text: 'Hola' }] },
      realtimeInputConfig: { automaticActivityDetection: { endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', silenceDurationMs: 1500 } },
      inputAudioTranscription: { languageCodes: ['es-ES'] },
      outputAudioTranscription: {},
    },
  });
  assert.ok(LEARNER_SILENCE_MS > 800, 'longer than Google\'s default pause');
  assert.equal(setupMessage({ model: 'models/x', systemPrompt: '' }).setup.generationConfig.speechConfig, undefined);
  assert.equal(setupMessage({ model: 'models/x', systemPrompt: '' }).setup.model, 'models/x');
  assert.deepEqual(audioMessage('AAA'), { realtimeInput: { audio: { data: 'AAA', mimeType: 'audio/pcm;rate=16000' } } });
  assert.deepEqual(textMessage('Hola'), { realtimeInput: { text: 'Hola' } });
  assert.match(liveUrl('k y'), /BidiGenerateContent\?key=k%20y$/);
});

test('server message parsing', () => {
  const e = parseServerMessage({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }, { text: 'x' }] },
      outputTranscription: { text: 'Hola' },
      inputTranscription: { text: 'Buenas' },
      turnComplete: true,
    },
  });
  assert.deepEqual(e.audio, [{ data: 'AAAA', mimeType: 'audio/pcm;rate=24000' }]);
  assert.equal(e.outputText, 'Hola');
  assert.equal(e.inputText, 'Buenas');
  assert.equal(e.turnComplete, true);
  assert.equal(parseServerMessage({ setupComplete: {} }).setupComplete, true);
  assert.equal(parseServerMessage({ serverContent: { interrupted: true } }).interrupted, true);
  assert.equal(parseServerMessage({ goAway: { timeLeft: '10s' } }).goAway, '10s');
  assert.equal(e.usage, null);
});

test('server message parsing reads usage', () => {
  // A message as the Live API sends it with turnComplete.
  const e = parseServerMessage({
    serverContent: { turnComplete: true },
    usageMetadata: {
      promptTokenCount: 437,
      responseTokenCount: 96,
      totalTokenCount: 533,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 312 }, { modality: 'AUDIO', tokenCount: 125 }],
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 96 }],
    },
  });
  assert.equal(e.turnComplete, true);
  assert.deepEqual(e.usage, {
    input: { audio: 125, text: 312 },
    output: { audio: 96, text: 0 },
    promptTokenCount: 437,
    responseTokenCount: 96,
    thoughtsTokenCount: 0,
    totalTokenCount: 533,
  });
  // Missing or broken counts are 0. A detail without a modality is text. Charla sends no images.
  assert.deepEqual(parseUsage({
    promptTokenCount: 'x',
    thoughtsTokenCount: 7,
    promptTokensDetails: [{ tokenCount: 5 }, { modality: 'IMAGE', tokenCount: 9 }, null, { modality: 'AUDIO', tokenCount: -3 }],
    responseTokensDetails: 'none',
  }), {
    input: { audio: 0, text: 5 },
    output: { audio: 0, text: 0 },
    promptTokenCount: 0,
    responseTokenCount: 0,
    thoughtsTokenCount: 7,
    totalTokenCount: 0,
  });
  assert.equal(parseUsage(undefined), null);
  assert.equal(parseUsage('x'), null);
});

test('a saved session keeps its usage, and exports include it', () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  const usage = {
    model: 'gemini-3.8-live', turns: 2, reports: 2,
    input: { audio: 20, text: 26 }, output: { audio: 21, text: 0 },
    promptTokenCount: 46, responseTokenCount: 21, thoughtsTokenCount: 0, totalTokenCount: 67,
  };
  saveSession(store, {
    id: 'a', date: '2026-10-09', startedAt: '2026-10-09T10:00:00.000Z', seconds: 600,
    activity: 'learn', topic: { interest: 'cine', title: 'Buñuel' }, transcript: [{ role: 'user', text: 'Hola' }], usage,
  });
  assert.deepEqual(store.data.sessions[0].usage, usage);
  assert.deepEqual(createStore(storage).data.sessions[0].usage, usage, 'kept after a reload');
  const exported = JSON.parse(JSON.stringify(store.exportData()));
  assert.deepEqual(exported.sessions[0].usage, usage);
});

test('usage logs are kept for the last few sessions only, and the totals for all', () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  const log = [{ ms: 1200, turnComplete: true, usageMetadata: { promptTokenCount: 9, totalTokenCount: 20 } }];
  store.update((x) => {
    for (let i = 0; i < KEEP_USAGE_LOGS + 3; i++) {
      x.sessions.push({ id: String(i), transcript: [], usage: { model: 'm', turns: 1, reports: 1, log: structuredClone(log) } });
    }
  });
  const kept = createStore(storage).data.sessions;
  assert.deepEqual(kept.map((s) => Boolean(s.usage?.log)), [false, false, false, true, true, true, true, true]);
  assert.deepEqual(kept.at(-1).usage.log, log);
  assert.ok(kept.every((s) => s.usage?.reports === 1), 'totals kept');
});

test('REST calls with a fake fetch', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/models?')) return new Response(JSON.stringify({ models: MODELS }), { status: 200 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"temas":[1,2,3]}' }] } }] }), { status: 200 });
  };
  assert.equal((await listModels('KEY', fake)).length, MODELS.length);
  assert.deepEqual(await generateJson('KEY', 'gemini-3.5-flash', 'p', fake), { temas: [1, 2, 3] });
  assert.match(calls[1].url, /models\/gemini-3\.5-flash:generateContent$/);
  assert.equal(JSON.parse(calls[1].init.body).generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(JSON.parse(calls[1].init.body).generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  const bad = async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
  await assert.rejects(listModels('x', bad), /API key not valid/);
});

test('summaries ask for less thinking, except on lite models', () => {
  assert.deepEqual(textThinking('gemini-3.8-flash'), { thinkingLevel: 'low' });
  assert.deepEqual(textThinking('gemini-flash-latest'), { thinkingLevel: 'low' });
  assert.equal(textThinking('gemini-3.5-flash-lite'), undefined);
  assert.equal(textThinking('gemini-flash-lite-latest'), undefined);
});

test('a model that refuses the thinking setting is asked again without it', async () => {
  const bodies = [];
  const fake = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.generationConfig.thinkingConfig) {
      return new Response(JSON.stringify({ error: { message: 'Thinking level is not supported for this model.' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
  };
  assert.deepEqual(await generateJson('KEY', 'gemma-4-31b-it', 'p', fake), { ok: true });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].generationConfig.thinkingConfig, undefined);
  // Other errors aren't retried.
  let calls = 0;
  const denied = async () => { calls += 1; return new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }); };
  await assert.rejects(generateJson('KEY', 'gemini-3.8-flash', 'p', denied), /API key not valid/);
  assert.equal(calls, 1);
});

test('REST calls send the key in a header, never in the URL', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/models?')) {
      const page = calls.length === 1 ? { models: MODELS.slice(0, 2), nextPageToken: 'p2' } : { models: MODELS.slice(2) };
      return new Response(JSON.stringify(page), { status: 200 });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }), { status: 200 });
  };
  assert.equal((await listModels('SECRET-KEY', fake)).length, MODELS.length);
  await generateJson('SECRET-KEY', 'models/gemini-3.5-flash', 'p', fake);
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /pageToken=p2/);
  for (const c of calls) {
    assert.ok(!c.url.includes('SECRET'), c.url);
    assert.ok(!/[?&]key=/.test(c.url), c.url);
    assert.equal(new Headers(c.init?.headers).get('x-goog-api-key'), 'SECRET-KEY');
  }
  assert.equal(new Headers(calls[2].init.headers).get('content-type'), 'application/json');
  // The Live WebSocket can't take headers, so its key stays in the URL.
  assert.match(liveUrl('SECRET-KEY'), /\?key=SECRET-KEY$/);
});

test('a model name from an imported file stays inside the models path', async () => {
  const urls = [];
  const fake = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }), { status: 200 });
  };
  await generateJson('KEY', '../../files', 'p', fake);
  assert.equal(new URL(urls[0]).pathname, '/v1beta/models/..%2F..%2Ffiles:generateContent');
});

test('store: persistence, export without key, import keeps key, old transcripts dropped', () => {
  const s = memoryStorage();
  const a = createStore(s);
  a.update((d) => {
    d.settings.apiKey = 'SECRET';
    d.interests.push('música');
  });
  const b = createStore(s);
  assert.equal(b.data.settings.apiKey, 'SECRET');
  assert.ok(b.data.interests.includes('música'));
  const exp = JSON.parse(JSON.stringify(b.exportData()));
  assert.equal(exp.settings.apiKey, '');
  assert.ok(!JSON.stringify(exp).includes('SECRET'));
  const c = createStore(memoryStorage());
  c.update((d) => { d.settings.apiKey = 'OTHER'; });
  c.importData(exp);
  assert.equal(c.data.settings.apiKey, 'OTHER');
  assert.ok(c.data.interests.includes('música'));
  assert.throws(() => c.importData({ app: 'verbos' }));
  // A key added to a file by hand never replaces or fills in this device's key.
  c.importData({ ...exp, settings: { ...exp.settings, apiKey: 'SOMEONE-ELSE' } });
  assert.equal(c.data.settings.apiKey, 'OTHER');
  const empty = createStore(memoryStorage());
  empty.importData({ ...exp, settings: { ...exp.settings, apiKey: 'SOMEONE-ELSE' } });
  assert.equal(empty.data.settings.apiKey, '');
  const d = createStore(memoryStorage());
  d.update((x) => {
    for (let i = 0; i < KEEP_TRANSCRIPTS + 5; i++) x.sessions.push({ id: String(i), transcript: [{ role: 'user', text: 'hola' }] });
  });
  assert.equal(d.data.sessions[0].transcript.length, 0);
  assert.equal(d.data.sessions.at(-1).transcript.length, 1);
  s.setItem(KEY, '{broken');
  assert.equal(createStore(s).data.sessions.length, 0);
});

test('a session saved in one tab survives another tab saving', () => {
  const storage = memoryStorage();
  const tabA = createStore(storage);
  const tabB = createStore(storage);
  const session = (id) => ({ id, date: '2026-10-09', startedAt: '2026-10-09T10:00:00.000Z', seconds: 60, activity: 'questions', themeId: 'el-cafe', themeName: 'El café', round: 1, transcript: [{ role: 'user', text: 'Hola' }] });
  saveSession(tabA, session('a'));
  saveSession(tabB, session('b'));
  tabA.update((d) => { d.settings.about = 'Soy Saar'; });
  const stored = createStore(storage).data;
  assert.deepEqual(stored.sessions.map((x) => x.id), ['a', 'b']);
  assert.equal(stored.settings.about, 'Soy Saar');
  assert.deepEqual(tabA.data.sessions.map((x) => x.id), ['a', 'b'], 'the tab that saved last sees both');
  assert.equal(stored.themes.find((t) => t.id === 'el-cafe').dates.length, 2, 'theme dates from both tabs');
});

test('a summary lands on its session even when another tab saved in between', () => {
  const storage = memoryStorage();
  const tabA = createStore(storage);
  const tabB = createStore(storage);
  tabA.update((d) => { d.sessions.push({ id: 'a', transcript: [], summary: null }); });
  tabB.update((d) => { d.sessions.push({ id: 'b', transcript: [], summary: null }); });
  tabA.update((d) => { d.sessions.find((x) => x.id === 'a').summary = { resumen: 'ok' }; });
  const stored = createStore(storage).data.sessions;
  assert.deepEqual(stored.map((x) => x.id), ['a', 'b']);
  assert.equal(stored[0].summary.resumen, 'ok');
});

test('a store keeps its own data when the storage cannot be written or read', () => {
  const m = memoryStorage();
  const full = { ...m, setItem() { throw new Error('full'); } };
  const store = createStore(full);
  store.update((d) => { d.interests.push('a'); });
  store.update((d) => { d.interests.push('b'); });
  assert.deepEqual(store.data.interests.slice(-2), ['a', 'b']);
  const cleared = createStore(m);
  cleared.update((d) => { d.interests.push('c'); });
  m.removeItem(KEY);
  cleared.update((d) => { d.interests.push('d'); });
  assert.deepEqual(cleared.data.interests.slice(-2), ['c', 'd'], 'cleared storage does not wipe the open tab');
});

/** A good copy with one full session of each kind, as the Exportar button writes it. */
function goodCopy() {
  const source = createStore(memoryStorage());
  const usage = { model: 'm', turns: 1, reports: 1, input: { audio: 2, text: 3 }, log: [{ ms: 5, turnComplete: true, usageMetadata: { totalTokenCount: 9 } }] };
  saveSession(source, {
    id: 'a', date: '2026-10-09', startedAt: '2026-10-09T10:00:00.000Z', seconds: 600, activity: 'questions',
    themeId: 'el-cafe', themeName: 'El café', round: 1, transcript: [{ role: 'user', text: 'Hola' }, { role: 'model', text: 'Buenas' }], usage,
  });
  saveSession(source, {
    id: 'b', date: '2026-10-10', startedAt: '2026-10-10T10:00:00.000Z', seconds: 300, activity: 'learn',
    topic: { interest: 'cine', title: 'Buñuel', hook: 'Un aragonés surrealista' }, transcript: [],
  });
  source.update((d) => {
    d.sessions[0].summary = { preguntas: ['¿Qué tal?'], resumen: 'Hablamos del café.', vocabulario: [{ es: 'cortado', en: 'cortado' }], correcciones: [{ dije: 'yo es', mejor: 'yo soy' }] };
    d.sessions[1].summaryError = 'Sin red';
    d.day = { date: '2026-10-10', topics: [{ interest: 'cine', title: 'Buñuel', hook: '' }], skip: ['el-cafe'], rejected: ['x'], shownInterests: ['cine'], picked: ['cine'] };
  });
  return JSON.parse(JSON.stringify(source.exportData()));
}

test('a good copy imports whole', () => {
  const copy = goodCopy();
  const store = createStore(memoryStorage());
  store.importData(copy);
  assert.deepEqual(store.data.sessions, copy.sessions);
  assert.deepEqual(store.data.day, copy.day);
  assert.deepEqual(store.data.covered, copy.covered);
  assert.deepEqual(store.data.themes, copy.themes);
});

test('a theme whose name has no latin letters exports and imports again', () => {
  const store = createStore(memoryStorage());
  for (const name of ['⚽', '日本語']) {
    assert.equal(themeId(name), '', 'the app really saves this id');
    store.update((d) => { d.themes.push({ id: themeId(name), name, dates: [], questions: [] }); });
  }
  const copy = JSON.parse(JSON.stringify(store.exportData()));
  const other = createStore(memoryStorage());
  other.importData(copy);
  assert.deepEqual(other.data.themes, store.data.themes);
});

test('a broken copy is refused and leaves the data and the stored text as they were', () => {
  const broken = {
    'a null session': (c) => { c.sessions.push(null); },
    'a session that is a string': (c) => { c.sessions[0] = 'hola'; },
    'a session without an id': (c) => { delete c.sessions[0].id; },
    'a session with an empty id': (c) => { c.sessions[0].id = ''; },
    'a session with a bad date': (c) => { c.sessions[0].date = 'ayer'; },
    'a session with no duration': (c) => { c.sessions[0].seconds = '600'; },
    'an unknown activity': (c) => { c.sessions[0].activity = 'jugar'; },
    'a transcript that is not a list': (c) => { c.sessions[0].transcript = 'hola'; },
    'a transcript turn that is null': (c) => { c.sessions[0].transcript[0] = null; },
    'a transcript turn with a bad speaker': (c) => { c.sessions[0].transcript[0].role = 'system'; },
    'a transcript turn with no text': (c) => { c.sessions[0].transcript[0].text = 5; },
    'a summary that is a string': (c) => { c.sessions[0].summary = 'ok'; },
    'a summary without its lists': (c) => { delete c.sessions[0].summary.vocabulario; },
    'a vocabulary entry that is null': (c) => { c.sessions[0].summary.vocabulario[0] = null; },
    'a correction that is a number': (c) => { c.sessions[0].summary.correcciones[0] = 3; },
    'a topic that is a string': (c) => { c.sessions[1].topic = 'Buñuel'; },
    'a topic without a title': (c) => { delete c.sessions[1].topic.title; },
    'usage that is a list': (c) => { c.sessions[0].usage = []; },
    'a theme that is null': (c) => { c.themes[0] = null; },
    'a theme without dates': (c) => { delete c.themes[0].dates; },
    'a theme with a bad date': (c) => { c.themes[0].dates = [4]; },
    'questions that are not text': (c) => { c.themes[0].questions = [{}]; },
    'interests that are a string': (c) => { c.interests = 'cine'; },
    'an interest that is null': (c) => { c.interests[0] = null; },
    'a covered entry that is null': (c) => { c.covered.push(null); },
    'a covered entry without a title': (c) => { delete c.covered[0].title; },
    'a day that is a list': (c) => { c.day = []; },
    'a day skip list that is a string': (c) => { c.day.skip = 'el-cafe'; },
    'a day topic that is null': (c) => { c.day.topics[0] = null; },
    'settings that are a string': (c) => { c.settings = 'x'; },
    'a model list with a number': (c) => { c.settings.liveModels = [1]; },
    'an about text that is a number': (c) => { c.settings.about = 1; },
  };
  for (const [name, break_] of Object.entries(broken)) {
    const storage = memoryStorage();
    const store = createStore(storage);
    store.update((d) => { d.settings.apiKey = 'MINE'; d.interests.push('música'); });
    const before = JSON.stringify(store.data);
    const stored = storage.getItem(KEY);
    const copy = goodCopy();
    break_(copy);
    assert.throws(() => store.importData(copy), /Datos dañados/, name);
    assert.equal(JSON.stringify(store.data), before, `${name}: data untouched`);
    assert.equal(storage.getItem(KEY), stored, `${name}: stored text untouched`);
  }
});

test('the top-level checks still refuse other files', () => {
  const store = createStore(memoryStorage());
  assert.throws(() => store.importData(null), /No es una copia de Charla/);
  assert.throws(() => store.importData({ app: 'verbos' }), /No es una copia de Charla/);
  assert.throws(() => store.importData({ ...goodCopy(), schemaVersion: 99 }), /Versión no compatible/);
  assert.throws(() => store.importData({ ...goodCopy(), sessions: null }), /Datos incompletos/);
});

test('a hostile copy cannot reach the prototype and never brings a key', () => {
  const copy = JSON.parse(JSON.stringify(goodCopy()).replace(/^\{/, '{"__proto__":{"polluted":"top"},"constructor":{"prototype":{"polluted":"ctor"}},'));
  copy.sessions[0] = JSON.parse(`{"__proto__":{"polluted":"session"},"constructor":"x",${JSON.stringify(copy.sessions[0]).slice(1)}`);
  copy.sessions[0].usage = JSON.parse('{"model":"m","__proto__":{"polluted":"usage"},"input":{"__proto__":{"polluted":"deep"},"audio":1}}');
  copy.settings = JSON.parse('{"__proto__":{"polluted":"settings"},"apiKey":"SOMEONE-ELSE","about":"hola"}');
  const store = createStore(memoryStorage());
  store.update((d) => { d.settings.apiKey = 'MINE'; });
  store.importData(copy);
  assert.equal(({}).polluted, undefined);
  assert.equal(store.data.polluted, undefined);
  assert.equal(store.data.sessions[0].polluted, undefined);
  assert.equal(store.data.sessions[0].usage.input.polluted, undefined);
  assert.equal(store.data.settings.polluted, undefined);
  const own = (o) => Object.keys(o).filter((k) => k === '__proto__' || k === 'constructor');
  for (const o of [store.data, store.data.sessions[0], store.data.sessions[0].usage, store.data.sessions[0].usage.input, store.data.settings]) assert.deepEqual(own(o), []);
  assert.equal(store.data.sessions[0].usage.input.audio, 1, 'the rest of the record is kept');
  assert.equal(store.data.settings.apiKey, 'MINE');
  assert.equal(store.data.settings.about, 'hola');
});

test('a copy far bigger than real use is refused', () => {
  const store = createStore(memoryStorage());
  const tooMany = (key, make) => {
    const copy = goodCopy();
    copy[key] = Array.from({ length: IMPORT_LIMITS[key] + 1 }, make);
    assert.throws(() => store.importData(copy), /Copia demasiado grande/, key);
  };
  tooMany('sessions', (_, i) => ({ id: String(i), date: '2026-10-09', startedAt: '', seconds: 1, activity: 'learn', transcript: [] }));
  tooMany('themes', (_, i) => ({ id: String(i), name: 'x', dates: [], questions: [] }));
  tooMany('interests', () => 'x');
  tooMany('covered', () => ({ date: '2026-10-09', interest: 'x', title: 'x' }));

  const long = goodCopy();
  long.sessions[0].transcript[0].text = 'x'.repeat(IMPORT_LIMITS.text + 1);
  assert.throws(() => store.importData(long), /Copia demasiado grande/, 'a very long text');

  const turns = goodCopy();
  turns.sessions[0].transcript = Array.from({ length: IMPORT_LIMITS.turns + 1 }, () => ({ role: 'user', text: 'x' }));
  assert.throws(() => store.importData(turns), /Copia demasiado grande/, 'a very long transcript');

  const deep = goodCopy();
  let nest = {};
  for (let i = 0; i < 100; i++) nest = { nest };
  deep.sessions[0].usage = nest;
  assert.throws(() => store.importData(deep), /Copia demasiado grande/, 'deeply nested records');

  const sprawl = goodCopy();
  sprawl.sessions[0].usage = { log: Array.from({ length: IMPORT_LIMITS.nodes + 1 }, () => 0) };
  assert.throws(() => store.importData(sprawl), /Copia demasiado grande/, 'too many values in all');
});

/** A clock that only moves when the test says so. */
function fakeTimers() {
  let time = 0;
  let next = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { timers.set(next, { at: time + ms, fn }); return next++; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      time += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= time) { timers.delete(id); t.fn(); }
      }
    },
  };
}

/** A stand-in for generateTopics whose answers the test releases one by one. */
function fakeGenerate() {
  const asked = [];
  const generate = (store, isCurrent) => new Promise((resolve) => {
    asked.push({ isCurrent, answer: () => resolve([]) });
  });
  return { asked, generate };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('topics are asked for once the taps stop', async () => {
  const clock = fakeTimers();
  const { asked, generate } = fakeGenerate();
  const ask = topicsRequester(createStore(memoryStorage()), { generate, clock });
  let drawn = 0;
  for (let i = 0; i < 5; i++) {
    ask(() => drawn++, TOPICS_WAIT_MS);
    clock.advance(TOPICS_WAIT_MS - 1);
  }
  assert.equal(asked.length, 0, 'still waiting while the taps keep coming');
  clock.advance(1);
  assert.equal(asked.length, 1, 'one request after the last tap');
  asked[0].answer();
  await settle();
  assert.equal(drawn, 1);
  clock.advance(TOPICS_WAIT_MS * 3);
  assert.equal(asked.length, 1, 'nothing more is scheduled');
});

test('an answer for older picks is ignored', async () => {
  const clock = fakeTimers();
  const { asked, generate } = fakeGenerate();
  const ask = topicsRequester(createStore(memoryStorage()), { generate, clock });
  const drawn = [];
  ask(() => drawn.push('first'), TOPICS_WAIT_MS);
  clock.advance(TOPICS_WAIT_MS);
  ask(() => drawn.push('second'), TOPICS_WAIT_MS);
  assert.equal(asked[0].isCurrent(), false, 'the request on its way is stale as soon as the picks change');
  clock.advance(TOPICS_WAIT_MS);
  assert.equal(asked.length, 2);
  assert.equal(asked[1].isCurrent(), true);
  asked[1].answer();
  asked[0].answer();
  await settle();
  assert.deepEqual(drawn, ['second']);
});

test('asking at once replaces a request that is still waiting', async () => {
  const clock = fakeTimers();
  const { asked, generate } = fakeGenerate();
  const ask = topicsRequester(createStore(memoryStorage()), { generate, clock });
  let drawn = 0;
  ask(() => drawn++, TOPICS_WAIT_MS);
  ask(() => drawn++);
  assert.equal(asked.length, 1, 'no wait when none is given');
  clock.advance(TOPICS_WAIT_MS * 2);
  assert.equal(asked.length, 1, 'the waiting request was dropped');
  asked[0].answer();
  await settle();
  assert.equal(drawn, 1);
});

test('every Today view of a store shares one requester, so the newest call wins', async () => {
  const store = createStore(memoryStorage());
  assert.equal(sharedTopicsRequester(store), sharedTopicsRequester(store));
  assert.notEqual(sharedTopicsRequester(store), sharedTopicsRequester(createStore(memoryStorage())));
  const drawn = [];
  sharedTopicsRequester(store)(() => drawn.push('old view'), 20);
  sharedTopicsRequester(store)(() => drawn.push('new view'), 20);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(drawn, ['new view'], 'one request, drawn by the newest view only');
});

test('topics for old picks are not saved', async () => {
  const store = createStore(memoryStorage());
  await generateTopics(store, () => false);
  assert.equal(store.data.day.topics.length, 0);
  await generateTopics(store);
  assert.equal(store.data.day.topics.length, 3);
});

test('level shapes the prompts', async () => {
  const { LEVELS, levelGuide } = await import('../src/core/prompts.js');
  assert.deepEqual(LEVELS, ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  const a1 = systemPrompt({ activity: 'questions', theme: 'La casa', level: 'A1' });
  assert.match(a1, /Mi nivel es A1/);
  assert.match(systemPrompt({ activity: 'learn', topic: { interest: 'x', title: 'y' }, level: 'C1' }), /Mi nivel es C1/);
  assert.match(systemPrompt({ activity: 'questions', theme: 'La casa' }), /Mi nivel es A2/);
  assert.equal(levelGuide('Z9'), levelGuide('A2'));
  assert.match(topicsPrompt({ interests: ['a'], covered: [], level: 'B2' }), /nivel B2/);
  assert.match(summaryPrompt({ activity: 'questions', theme: 'x' }, 'Yo: hola', 'B1'), /nivel del estudiante es B1/);
  assert.equal(createStore(memoryStorage()).data.settings.level, 'A2');
});

test('topicsPrompt lists rejected topics', () => {
  const p = topicsPrompt({ interests: ['viajes'], covered: [], rejected: ['La Sagrada Familia de Gaudí'] });
  assert.match(p, /no quiere estos temas[\s\S]*- La Sagrada Familia de Gaudí/);
});

test('old A1 to C2 levels move onto Fácil, Medio and Difícil', async () => {
  const { simpleLevel, levelLabel } = await import('../src/core/prompts.js');
  assert.deepEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', undefined].map(simpleLevel), ['A2', 'A2', 'B1', 'B2', 'B2', 'B2', 'A2']);
  assert.equal(levelLabel('C1'), 'Difícil');
  const storage = memoryStorage();
  storage.setItem(KEY, JSON.stringify({ settings: { level: 'C2' } }));
  assert.equal(createStore(storage).data.settings.level, 'B2');
});
