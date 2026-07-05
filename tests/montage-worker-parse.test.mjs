import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTranscriptStructure } from './load-transcript-structure.mjs';

const TS = loadTranscriptStructure();

test('parseMontageChunk: валидный JSON → нормализованные метки', () => {
  const raw = '{"blocks":[{"i":0,"importance":3,"role":"hook","theme":"Завязка","blockId":"b0"},{"i":1,"importance":1,"role":"filler","theme":"","blockId":"b0"}]}';
  const out = TS.parseMontageChunk(raw, 0, 1);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'hook');
  assert.equal(out[0].importance, 3);
  assert.equal(out[1].blockId, 'b0');
});

test('parseMontageChunk: importance вне 0-3 → кламп; невалидный role → argument', () => {
  const raw = '{"blocks":[{"i":0,"importance":9,"role":"zzz","theme":"t","blockId":"b0"}]}';
  const out = TS.parseMontageChunk(raw, 0, 0);
  assert.equal(out[0].importance, 3);
  assert.equal(out[0].role, 'argument');
});

test('parseMontageChunk: мусор без JSON → пустой массив (не throw)', () => {
  /* vm-загрузчик возвращает массивы чужого realm — deepEqual([], []) падает
     на cross-realm проверке прототипа (см. multicam-plan.test.mjs, memory:
     feedback_pure_logic_pattern). Проверяем длину. */
  const out = TS.parseMontageChunk('no json here', 0, 5);
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 0);
});

test('parseMontageChunk: JSON с markdown-обёрткой → парсится', () => {
  const raw = '```json\n{"blocks":[{"i":2,"importance":2,"role":"argument","theme":"t","blockId":"b1"}]}\n```';
  const out = TS.parseMontageChunk(raw, 2, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].i, 2);
});
