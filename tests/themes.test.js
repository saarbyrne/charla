import { test } from 'node:test';
import assert from 'node:assert/strict';
import { themeState, pickTheme, recordTheme, currentCycle, defaultThemes, themeId, DEFAULT_THEMES } from '../src/core/themes.js';
import { addDays, daysBetween } from '../src/core/dates.js';

const T = (name, dates = [], questions = []) => ({ id: themeId(name), name, dates, questions });

test('default themes have unique ids', () => {
  const ids = defaultThemes().map((t) => t.id);
  assert.equal(new Set(ids).size, DEFAULT_THEMES.length);
  assert.equal(themeId('La comida y la cocina'), 'la-comida-y-la-cocina');
  assert.equal(themeId('El fútbol'), 'el-futbol');
});

test('dates helpers', () => {
  assert.equal(addDays('2026-09-28', 4), '2026-10-02');
  assert.equal(daysBetween('2026-09-22', '2026-10-22'), 30);
});

test('new theme', () => {
  assert.deepEqual(themeState(T('A'), '2026-09-22'), { status: 'new', round: 1, availableFrom: null, last: null });
});

test('repeat every 4 days, round 2 and 3', () => {
  const t = T('A', ['2026-09-01']);
  assert.equal(themeState(t, '2026-09-04').status, 'waiting');
  assert.equal(themeState(t, '2026-09-04').availableFrom, '2026-09-05');
  assert.deepEqual(themeState(t, '2026-09-05'), { status: 'due', round: 2, availableFrom: null, last: '2026-09-01' });
  const t2 = T('A', ['2026-09-01', '2026-09-05']);
  assert.equal(themeState(t2, '2026-09-09').round, 3);
  assert.equal(themeState(t2, '2026-09-09').status, 'due');
});

test('after 3 rounds the theme rests 30 days, then starts a new cycle', () => {
  const t = T('A', ['2026-09-01', '2026-09-05', '2026-09-09']);
  assert.deepEqual(themeState(t, '2026-09-20'), { status: 'resting', round: 1, availableFrom: '2026-10-09', last: '2026-09-09' });
  assert.equal(themeState(t, '2026-10-09').status, 'new');
  const t2 = T('A', ['2026-09-01', '2026-09-05', '2026-09-09', '2026-10-10']);
  assert.deepEqual(currentCycle(t2.dates), ['2026-10-10']);
  assert.equal(themeState(t2, '2026-10-14').round, 2);
});

test('pick: overdue repeats before new themes', () => {
  const themes = [T('Nuevo'), T('Repetir', ['2026-09-10']), T('Esperar', ['2026-09-20'])];
  assert.equal(pickTheme(themes, '2026-09-22')?.theme.name, 'Repetir');
  assert.equal(pickTheme(themes, '2026-09-22')?.state.round, 2);
});

test('pick: most overdue first', () => {
  const themes = [T('B', ['2026-09-15']), T('A', ['2026-09-10'])];
  assert.equal(pickTheme(themes, '2026-09-22')?.theme.name, 'A');
});

test('pick: never used before rested, and not a theme done today', () => {
  const themes = [T('Descansado', ['2026-07-01', '2026-07-05', '2026-07-09']), T('Nunca')];
  assert.equal(pickTheme(themes, '2026-09-22')?.theme.name, 'Nunca');
  const done = [T('Hoy', ['2026-09-22']), T('Otro')];
  assert.equal(pickTheme(done, '2026-09-22')?.theme.name, 'Otro');
});

test('pick is stable for a day and skip works', () => {
  const themes = defaultThemes();
  const a = pickTheme(themes, '2026-09-22');
  const b = pickTheme(themes, '2026-09-22');
  assert.equal(a?.theme.id, b?.theme.id);
  const c = pickTheme(themes, '2026-09-22', [a.theme.id]);
  assert.notEqual(c?.theme.id, a?.theme.id);
});

test('pick returns null when every theme is waiting or resting', () => {
  assert.equal(pickTheme([T('A', ['2026-09-21'])], '2026-09-22'), null);
});

test('recordTheme adds the date and keeps the last 30 questions', () => {
  const many = Array.from({ length: 29 }, (_, i) => `q${i}`);
  const r = recordTheme(T('A', [], many), '2026-09-22', ['n1', 'n2', '']);
  assert.deepEqual(r.dates, ['2026-09-22']);
  assert.equal(r.questions.length, 30);
  assert.equal(r.questions.at(-1), 'n2');
});
