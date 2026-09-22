# Charla

Charla is a daily live Spanish conversation app with a memory. You talk out loud with Gemini in real time, and Charla remembers the themes, questions and topics from earlier sessions. Everything is stored on your device, and there are no dependencies and no server.

Live at https://saarbyrne.github.io/charla/ once GitHub Pages is on. On a phone, open it and add it to the Home Screen.

## Running

You need Node 22 or later. There is nothing to install.

```sh
npm start
```

Then open http://localhost:5174. The microphone only works on localhost or HTTPS, so on a phone use the GitHub Pages address.

## Key

Each person adds their own Gemini API key on the first screen or in Ajustes. A free key comes from https://aistudio.google.com/apikey. The key is stored only in that browser, and Export never includes it.

The free tier covers the Gemini Live models. For users in the EEA, the UK and Switzerland, Google applies its paid-tier data terms to the free tier, so it does not use the conversations to improve its products. Elsewhere, free-tier content can be used for that.

## Activities

- **5 preguntas.** Charla picks a theme and the model asks 5 questions one at a time. It waits for you to say «siguiente pregunta» before the next one. A theme comes back every 4 days with different questions. After 3 rounds it rests for at least 30 days. "Otro tema" skips today's pick.
- **Aprender algo.** Charla suggests 3 topics from your interests and leaves out topics you have already covered. You tap one, the model gives an overview, and you ask questions.

## Memory

- **Themes.** The dates each theme was used and the questions already asked, so repeats get new questions.
- **Topics.** The topics covered in "Aprender algo".
- **Sessions.** The transcript and a summary with the questions, new words and corrections. Transcripts are kept for the last 60 sessions, and summaries are kept for all of them.
- **Prompt.** The last 5 session summaries and your "Sobre mí" notes go into each new session's instructions.

Themes and interests can be added and removed in Temas. Export and Import in Ajustes move everything between devices.

## Structure

```
src/
  core/        themes (scheduling), prompts, transcript, audio (PCM), gemini (REST and Live messages), store
  live/        session.js (WebSocket, mic, playback), capture-worklet.js
  views/       one file per screen
  actions.js   key check, topic suggestions, saving and summarising sessions
scripts/       serve.mjs, precache.mjs
tests/         node --test
```

## Tests

```sh
npm test            # scheduling, prompts, audio, Gemini messages, storage
npm run typecheck   # optional, needs TypeScript
```

The live session was tested in Chromium against a fake Gemini server with a fake microphone. It has not yet been tested against the real API or on an iPhone.

## Limits

- Gemini ends audio sessions after 15 minutes.
- If the model hears its own voice through the speaker and interrupts itself, use headphones.
- The free tier has rate limits, which Google shows in AI Studio.
- After adding or removing files, run `npm run precache` so the offline cache includes them.
