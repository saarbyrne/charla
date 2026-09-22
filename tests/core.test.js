import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, kickoff, summaryPrompt, topicsPrompt, transcriptText } from '../src/core/prompts.js';
import { appendChunk, cleanTurns } from '../src/core/transcript.js';
import { floatTo16, int16ToFloat, downsample, pcmToBase64, base64ToPcm, parseRate } from '../src/core/audio.js';
import { pickLiveModels, pickTextModels, parseJson, setupMessage, audioMessage, textMessage, parseServerMessage, liveUrl, generateJson, listModels } from '../src/core/gemini.js';
import { createStore, memoryStorage, KEY, KEEP_TRANSCRIPTS } from '../src/core/store.js';

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
  assert.match(calls[1].url, /models\/gemini-3\.5-flash:generateContent\?key=KEY/);
  assert.equal(JSON.parse(calls[1].init.body).generationConfig.responseMimeType, 'application/json');
  const bad = async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
  await assert.rejects(listModels('x', bad), /API key not valid/);
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
