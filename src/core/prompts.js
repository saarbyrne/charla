// @ts-check
/** Instructions for the live model and the text model. All in Spanish. */

/**
 * @typedef {object} RecentSession
 * @property {string} date
 * @property {string} label
 * @property {string} [summary]
 */

/**
 * @typedef {object} Topic
 * @property {string} interest
 * @property {string} title
 * @property {string} [hook]
 */

/** @typedef {'A1'|'A2'|'B1'|'B2'|'C1'|'C2'} Level */

/** @type {Level[]} */
export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

/** How the model should speak at each level. @type {Record<Level, string>} */
export const LEVEL_GUIDE = {
  A1: 'Mi nivel es A1 (principiante). Usa frases muy cortas, palabras muy comunes y sobre todo el presente. Habla despacio. Si no sé qué decir, dame un ejemplo de respuesta.',
  A2: 'Mi nivel es A2 (básico). Usa frases cortas y vocabulario común. Usa el presente, el pasado y el futuro con «ir a». Habla despacio.',
  B1: 'Mi nivel es B1 (intermedio). Usa frases claras y vocabulario de todos los días. Puedes usar todos los tiempos comunes. Habla a un ritmo tranquilo.',
  B2: 'Mi nivel es B2 (intermedio alto). Habla de forma natural a un ritmo normal. Usa expresiones comunes y un vocabulario variado.',
  C1: 'Mi nivel es C1 (avanzado). Habla con naturalidad. Usa expresiones idiomáticas y temas complejos.',
  C2: 'Mi nivel es C2 (casi nativo). Habla como con un hablante nativo.',
};

/** The three levels shown in hecho, and the level the AI is told for each. */
export const LEVEL_CHOICES = [
  { value: 'A2', label: 'Fácil' },
  { value: 'B1', label: 'Medio' },
  { value: 'B2', label: 'Difícil' },
];

/**
 * Move an old A1 to C2 setting onto the three levels.
 * @param {string | undefined} level
 * @returns {'A2'|'B1'|'B2'}
 */
export function simpleLevel(level) {
  if (level === 'B1') return 'B1';
  if (level === 'B2' || level === 'C1' || level === 'C2') return 'B2';
  return 'A2';
}

/** @param {string | undefined} level */
export const levelLabel = (level) => LEVEL_CHOICES.find((c) => c.value === simpleLevel(level))?.label ?? 'Fácil';

/** @param {string | undefined} level */
export const levelGuide = (level) => LEVEL_GUIDE[/** @type {Level} */ (level)] ?? LEVEL_GUIDE.A2;

/** @param {string | undefined} level */
const base = (level) => `Eres mi compañero de conversación en español. Hablamos cada día para practicar. Estoy aprendiendo español.
${levelGuide(level)}
Reglas:
- Habla solo en español, con acento de España.
- Adapta las preguntas, el vocabulario y la velocidad a mi nivel.
- Si no entiendo algo, repítelo con palabras más sencillas.
- No me corrijas durante la conversación, salvo que yo lo pida. Queremos que la conversación fluya.
- Sé breve en cada turno. Deja que yo hable más que tú.
- Hago pausas para pensar. Si mi frase parece sin terminar, por ejemplo si acaba en «pero», «y» o «porque», di solo «¿Sí?» o «Sigue» y espera.
- Si no entiendes lo que digo, pídeme que lo repita. No me pidas que hable en español, salvo que diga una frase entera en otro idioma.`;

/**
 * @param {{
 *   activity: 'questions' | 'learn',
 *   theme?: string, round?: number, previousQuestions?: string[],
 *   topic?: Topic,
 *   about?: string,
 *   level?: string,
 *   recent?: RecentSession[],
 * }} p
 */
export function systemPrompt(p) {
  const parts = [base(p.level)];
  if (p.about?.trim()) parts.push(`Sobre mí:\n${p.about.trim()}`);
  if (p.recent?.length) {
    parts.push(`Sesiones recientes:\n${p.recent.map((r) => `- ${r.date}: ${r.label}${r.summary ? `. ${r.summary}` : ''}`).join('\n')}`);
  }
  if (p.activity === 'questions') {
    const prev = (p.previousQuestions ?? []).slice(-15);
    parts.push(`Actividad de hoy: 5 preguntas.
Tema: ${p.theme}. Es la ronda ${p.round ?? 1} de 3 con este tema.
- Prepara 5 preguntas sobre el tema antes de empezar, y hazlas en ese orden.
- Di el tema y haz solo la primera pregunta.
- Di el número de cada pregunta: primera, segunda, tercera, cuarta y quinta. Usa cada número una sola vez.
- No hagas la siguiente pregunta hasta que yo diga «siguiente pregunta».
- Entre preguntas, comenta mi respuesta o hazme una pregunta corta para seguir la conversación. Esas preguntas cortas no tienen número y no cuentan como una de las 5.
- Después de la quinta pregunta, despídete de forma breve.${prev.length ? `
Preguntas que ya hicimos con este tema. No las repitas. Haz preguntas un poco diferentes:
${prev.map((q) => `- ${q}`).join('\n')}` : ''}`);
  } else {
    parts.push(`Actividad de hoy: Aprender algo.
Tema elegido: ${p.topic?.title} (${p.topic?.interest}).
- Empieza con un resumen del tema de uno o dos minutos.
- Luego yo te hago preguntas y tú das más detalle.
- Si me quedo callado, hazme una pregunta sencilla sobre el tema.`);
  }
  return parts.join('\n\n');
}

const ORDINALS = ['primera', 'segunda', 'tercera', 'cuarta', 'quinta'];

/** @param {string} text */
const asksNext = (text) => /siguiente\s+pregunta/.test(text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));

/**
 * Where the 5 questions are, added to the instructions on each turn of a
 * pipeline session (live/pipeline.js). charla counts the learner's «siguiente
 * pregunta», so the model doesn't have to remember. In the voice test on
 * 10 October, Flash-Lite asked the fourth question without waiting for it.
 * @param {{ role: 'user' | 'model', text: string }[]} history  the conversation before this turn
 */
export function questionNote(history) {
  if (!history.length) return '\n\nAhora: di el tema y haz la primera pregunta.';
  const n = 1 + history.filter((m) => m.role === 'user' && asksNext(m.text)).length;
  const comment = 'comenta lo que digo o hazme una pregunta corta sobre ello';
  if (n > 5) return `\n\nAhora: ya hemos hecho las 5 preguntas. No hagas más preguntas con número. ${comment[0].toUpperCase()}${comment.slice(1)}, o despídete si me despido.`;
  if (n === 5) return `\n\nAhora: vamos por la quinta y última pregunta. Si en este turno digo «siguiente pregunta», dime que ya hemos hecho las 5 y despídete de forma breve. Si no, ${comment}.`;
  return `\n\nAhora: vamos por la ${ORDINALS[n - 1]} pregunta. Si en este turno digo «siguiente pregunta», haz la ${ORDINALS[n]} pregunta. Si no, no hagas una pregunta nueva con número: ${comment}.`;
}

/** First message that makes the model start speaking. @param {'questions'|'learn'} activity @param {Topic} [topic] */
export function kickoff(activity, topic) {
  return activity === 'questions' ? 'Hola. Empecemos con las 5 preguntas.' : `Hola. Hoy quiero aprender sobre: ${topic?.title}.`;
}

/**
 * @param {{ activity: 'questions'|'learn', theme?: string, topic?: Topic }} s
 * @param {string} transcript
 * @param {string} [level]
 */
export function summaryPrompt(s, transcript, level) {
  const what = s.activity === 'questions' ? `la actividad «5 preguntas» con el tema «${s.theme}»` : `la actividad «Aprender algo» sobre «${s.topic?.title}»`;
  return `Esta es la transcripción de una sesión de práctica de español: ${what}. «Yo» es el estudiante. «Tú» es el compañero.

Devuelve solo JSON con esta forma:
{
  "preguntas": ["las preguntas principales que hizo el compañero, máximo 5"],
  "resumen": "dos o tres frases en español sobre lo que hablamos",
  "vocabulario": [{"es": "palabra o expresión útil de la sesión", "en": "traducción al inglés"}],
  "correcciones": [{"dije": "frase del estudiante con un error", "mejor": "versión correcta"}]
}
Máximo 6 elementos en vocabulario y 6 en correcciones. Usa listas vacías si no hay nada.
El nivel del estudiante es ${level ?? 'A2'}. Elige vocabulario útil para ese nivel y corrige los errores más importantes para ese nivel.

Transcripción:
${transcript}`;
}

/** @param {{ interests: string[], covered: string[], rejected?: string[], level?: string }} p */
export function topicsPrompt({ interests, covered, rejected = [], level }) {
  return `Propón 3 temas concretos e interesantes para aprender en una conversación de 10 minutos en español, con un estudiante de nivel ${level ?? 'A2'}.
${interests.length >= 3
    ? `Cada tema debe salir de uno de estos intereses, y los 3 temas deben ser de intereses diferentes: ${interests.join(', ')}.`
    : `Cada tema debe salir de ${interests.length > 1 ? 'uno de estos intereses' : 'este interés'}: ${interests.join(', ')}. Los 3 temas deben ser muy diferentes entre sí.`}
Evita los temas más famosos y obvios de cada interés. Elige personas, lugares, ideas o historias menos conocidas, de cualquier país del mundo hispanohablante o de fuera.
${covered.length ? `No repitas estos temas, que ya hemos visto:\n${covered.map((c) => `- ${c}`).join('\n')}\n` : ''}${rejected.length ? `El estudiante no quiere estos temas. No los repitas y no propongas nada parecido, ni la misma persona, lugar u obra:\n${rejected.map((c) => `- ${c}`).join('\n')}\n` : ''}
Devuelve solo JSON con esta forma:
{"temas": [{"interes": "interés", "titulo": "título corto del tema en español", "gancho": "una frase que explica por qué es interesante"}]}`;
}

/**
 * Plain text version of the transcript for the summary.
 * @param {{ role: 'user'|'model', text: string }[]} turns
 */
export function transcriptText(turns) {
  return turns.map((t) => `${t.role === 'user' ? 'Yo' : 'Tú'}: ${t.text.trim()}`).join('\n');
}
