import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, kickoff, summaryPrompt, topicsPrompt, transcriptText } from '../src/core/prompts.js';
import { appendChunk, cleanTurns } from '../src/core/transcript.js';
import { floatTo16, int16ToFloat, downsample, pcmToBase64, base64ToPcm, parseRate } from '../src/core/audio.js';
import { pickLiveModels, pickTextModels, parseJson, setupMessage, audioMessage, textMessage, parseServerMessage, parseUsage, liveUrl, generateJson, listModels } from '../src/core/gemini.js';
import { createStore, memoryStorage, KEY, KEEP_TRANSCRIPTS, KEEP_USAGE_LOGS } from '../src/core/store.js';
import { saveSession } from '../src/actions.js';

test('system prompt for 5 preguntas', () => {
  const p = systemPrompt({ activity: 'questions', theme: 'La comida', round: 2, previousQuestions: ['¿Qué desayunas?'], about: 'Vivo en Zamora.', recent: [{ date: '2026-09-20', label: 'Aprender algo: Le Corbusier' }] });
  assert.match(p, /Tema: La comida\. Es la ronda 2 de 3/);
  assert.match(p, /«siguiente pregunta»/);
  assert.match(p, /- ¿Qué desayunas\?/);
  assert.match(p, /Sobre mí:\nVivo en Zamora\./);
  assert.match(p, /2026-09-20: Aprender algo: Le Corbusier/);
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
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  });
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
  const bad = async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
  await assert.rejects(listModels('x', bad), /API key not valid/);
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
