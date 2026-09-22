import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { precacheList, render, ROOT } from '../scripts/precache.mjs';

test('sw.js precache list matches the files on disk (run npm run precache)', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.ok(sw.includes(render(precacheList())), 'sw.js precache list is out of date');
});
