# Charla

Charla is a daily live Spanish conversation app with a memory. You talk out loud with Gemini, and Charla remembers the themes, questions and topics from earlier sessions. Everything is stored on your device, and there are no dependencies and no server.

Live at https://charla.hecho.fyi. On a phone, open it and add it to the Home Screen.

## Running

You need Node 22 or later. There is nothing to install.

```sh
npm start
```

Then open http://localhost:5174. The microphone only works on localhost or HTTPS, so on a phone use the GitHub Pages address.

## Key

Each person adds their own Gemini API key on the first screen or in Ajustes. A free key comes from https://aistudio.google.com/apikey. The key is stored only in that browser, and Export never includes it.

Google's pricing page lists a free tier, with rate limits, for the models charla uses: Gemini 3.1 Flash-Lite, Gemini 3.8 Flash-Lite TTS and the Live models. For users in the EEA, the UK and Switzerland, Google applies its paid-tier data terms to the free tier, so it does not use the conversations to improve its products. Elsewhere, free-tier content can be used for that.

## Voice

Since 10 October 2026 a conversation runs as a pipeline (`VOICE_ENGINE` in `src/views/session.js`):

1. charla listens until you pause for 2 seconds (`END_PAUSE_MS` in `src/core/turns.js`). Learners stop to think mid-sentence, so a shorter pause cut people off.
2. Gemini 3.1 Flash-Lite gets your answer as audio, with the conversation so far as text, and returns what it heard and its reply (`src/core/pipeline.js`).
3. Gemini 3.8 Flash-Lite TTS says the reply with a Spain Spanish voice from Google's voice library. A tutor's voice comes first (Tutor 12 on 10 October), and Kore if the library has no Spain voice.
4. When Google refuses, the device's own Spanish voice says the reply (`src/live/device-voice.js`). After Google says there were too many requests, for example after a free key's 10 replies a day, the device's voice says the rest of the session. `usage.deviceReplies` counts these replies, and the usage log keeps Google's reason.

Each call bills only what it gets, so a conversation costs about the same per minute however long it runs: about $0.04 for 8 minutes at list prices (estimate). The Gemini Live API (`VOICE_ENGINE = 'live'`, `src/live/session.js`) bills every turn for the whole session so far, which comes to about $0.45 for 8 minutes. Pipeline sessions save their cost in `usage.cost`.

## Activities

- **5 preguntas.** Charla picks a theme and the model asks 5 questions one at a time. It waits for you to say «siguiente pregunta» before the next one. A theme comes back every 4 days with different questions. After 3 rounds it rests for at least 30 days. "Otro tema" skips today's pick.
- **Aprender algo.** Charla suggests 3 topics from your interests and leaves out topics you have already covered. You tap one, the model gives an overview, and you ask questions.

## Memory

- **Themes.** The dates each theme was used and the questions already asked, so repeats get new questions.
- **Topics.** The topics covered in "Aprender algo".
- **Sessions.** The transcript and a summary with the questions, new words and corrections. Transcripts are kept for the last 60 sessions, and summaries are kept for all of them. Each session also keeps its Gemini usage (`usage`): tokens in and out for audio and text, and the number of turns. The last 5 sessions also keep each usage report as Gemini sent it (`usage.log`), so the totals can be checked.
- **Prompt.** The last 5 session summaries and your "Sobre mí" notes go into each new session's instructions.

Themes and interests can be added and removed in Temas. Export and Import in Ajustes move everything between devices.

## Structure

```
src/
  core/        themes (scheduling), prompts, transcript, audio (PCM), gemini (REST and Live messages), pipeline (the pipeline's calls to Gemini), turns (when you start and stop speaking), store
  live/        pipeline.js (the pipeline session), device-voice.js (the device's Spanish voice), session.js (Gemini Live: WebSocket, mic, playback), page.js (screen lock, hiding and leaving the page), capture-worklet.js
  views/       one file per screen
  actions.js   key check, topic suggestions, saving and summarising sessions
scripts/       serve.mjs, precache.mjs
tests/         node --test
```

## Tests

```sh
npm test            # scheduling, prompts, audio, Gemini messages, the pipeline, storage
npm run typecheck   # optional, needs TypeScript
```

The live session was tested in Chromium against a fake Gemini server with a fake microphone. The pipeline was tested with fakes in `tests/pipeline.test.js` and has not yet been tested against the real API or on an iPhone.

## Limits

- In the pipeline, charla doesn't listen while it is thinking or speaking, so you can't interrupt it. Its reply starts a moment after your 2-second pause.
- In the pipeline, the transcript of what you say comes from Gemini Flash-Lite, which is told to write your words without correcting them.
- Gemini Live ends audio sessions after 15 minutes.
- Hiding the page (another app or tab, a locked screen) stops sending sound to Gemini. Coming back within a minute carries on, and after a minute hidden the session ends and is saved.
- Gemini Live waits for a 1.5-second pause before it replies, so you can stop to think in the middle of a sentence. The setting is `LEARNER_SILENCE_MS` in `src/core/gemini.js`.
- On Gemini Live, Google's transcript of what you say expects Spanish from Spain (`LEARNER_TRANSCRIPTION` in `src/core/gemini.js`), so an English word may be written as a Spanish one.
- Gemini Live bills each turn for the whole session so far, so the last minutes of a session cost the most.
- If the model hears its own voice through the speaker and interrupts itself, use headphones.
- Google limits each project. Its voice model, Gemini 3.8 Flash-Lite TTS, allows 3 replies a minute and 10 a day on a free key, and 10 a minute and 100 a day once billing is on (Tier 1). An 8-minute conversation needs about 20 replies (estimate). Gemini 3.1 Flash-Lite allows 10 a minute and 500 a day on a free key. The Live models have no daily limit. AI Studio → Rate Limit shows a project's limits. After the limit, the device's voice says the replies. It sounds fairly natural in Chrome, in Edge and on Android, and robotic in Safari and on iPhone (Mónica).
- After adding or removing files, run `npm run precache` so the offline cache includes them.
