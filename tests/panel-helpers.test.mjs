/**
 * Тесты self-contained хелперов panel.js (Wave A, 10 июня 2026).
 * panel.js — DOM-bound IIFE, целиком в Node не грузится, поэтому извлекаем
 * чистые функции из исходника по имени (баланс скобок) и исполняем в vm.
 * Покрытие:
 *  - mergeRemoveIntervals (P1-2): merge перекрытий перед отправкой в host
 *  - transcriptEditVersion / labelsCacheKey / analysisCacheKey (P0-1)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panelSrc = fs.readFileSync(
  path.join(__dirname, '..', 'client', 'unified', 'panel.js'),
  'utf8'
);

/** Извлекает `function <name>(...) {...}` из исходника по балансу скобок. */
function extractFunction(src, name) {
  const sig = 'function ' + name + '(';
  const start = src.indexOf(sig);
  assert.notEqual(start, -1, `panel.js: функция ${name} не найдена`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`panel.js: не найден конец функции ${name}`);
}

function loadFunctions(names) {
  const ctx = {};
  const code = names.map((n) => extractFunction(panelSrc, n)).join('\n') +
    '\nexports = { ' + names.map((n) => n + ': ' + n).join(', ') + ' };';
  const sandbox = { exports: null, Math, Date, JSON };
  vm.runInNewContext(code, sandbox, { filename: 'panel-helpers.vm.js' });
  Object.assign(ctx, sandbox.exports);
  return ctx;
}

const {
  mergeRemoveIntervals,
  transcriptEditVersion,
  labelsCacheKey,
  analysisCacheKey
} = loadFunctions([
  'mergeRemoveIntervals',
  'transcriptEditVersion',
  'labelsCacheKey',
  'analysisCacheKey'
]);

/* ── mergeRemoveIntervals (P1-2) ─────────────────────────────────── */

test('merge: пустой и одиночный массивы возвращаются как есть', () => {
  assert.deepEqual(mergeRemoveIntervals([]), []);
  assert.equal(mergeRemoveIntervals(null), null);
  const one = [{ startSec: 1, endSec: 2, reason: 'a' }];
  assert.deepEqual(mergeRemoveIntervals(one), one);
});

test('merge: непересекающиеся интервалы не сливаются', () => {
  const out = mergeRemoveIntervals([
    { startSec: 0, endSec: 1, reason: 'a' },
    { startSec: 2, endSec: 3, reason: 'b' }
  ]);
  assert.equal(out.length, 2);
});

test('merge: перекрытие сливается, endSec = max', () => {
  const out = mergeRemoveIntervals([
    { startSec: 0, endSec: 5, reason: 'пауза' },
    { startSec: 3, endSec: 7, reason: 'филлер' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].startSec, 0);
  assert.equal(out[0].endSec, 7);
  assert.equal(out[0].reason, 'пауза; филлер');
});

test('merge: вложенный интервал поглощается без потери endSec', () => {
  const out = mergeRemoveIntervals([
    { startSec: 0, endSec: 10, reason: 'a' },
    { startSec: 2, endSec: 4, reason: 'b' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].endSec, 10);
});

test('merge: стык в пределах epsilon 0.05с сливается', () => {
  const out = mergeRemoveIntervals([
    { startSec: 0, endSec: 2, reason: 'a' },
    { startSec: 2.04, endSec: 3, reason: 'b' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].endSec, 3);
});

test('merge: разрыв больше epsilon НЕ сливается', () => {
  const out = mergeRemoveIntervals([
    { startSec: 0, endSec: 2, reason: 'a' },
    { startSec: 2.06, endSec: 3, reason: 'b' }
  ]);
  assert.equal(out.length, 2);
});

test('merge: несортированный вход сортируется по startSec', () => {
  const out = mergeRemoveIntervals([
    { startSec: 5, endSec: 6, reason: 'c' },
    { startSec: 0, endSec: 1, reason: 'a' },
    { startSec: 0.5, endSec: 2, reason: 'b' }
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].startSec, 0);
  assert.equal(out[0].endSec, 2);
  assert.equal(out[1].startSec, 5);
});

test('merge: одинаковый reason не дублируется', () => {
  const out = mergeRemoveIntervals([
    { startSec: 0, endSec: 2, reason: 'тишина' },
    { startSec: 1, endSec: 3, reason: 'тишина' }
  ]);
  assert.equal(out[0].reason, 'тишина');
});

test('merge: цепочка из трёх перекрытий сливается в один', () => {
  const out = mergeRemoveIntervals([
    { startSec: 0, endSec: 2, reason: 'a' },
    { startSec: 1.5, endSec: 4, reason: 'b' },
    { startSec: 3.9, endSec: 6, reason: 'c' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].startSec, 0);
  assert.equal(out[0].endSec, 6);
});

test('merge: не мутирует исходный массив', () => {
  const input = [
    { startSec: 3, endSec: 7, reason: 'b' },
    { startSec: 0, endSec: 5, reason: 'a' }
  ];
  const copy = JSON.parse(JSON.stringify(input));
  mergeRemoveIntervals(input);
  assert.deepEqual(input, copy);
});

/* ── transcriptEditVersion / cache keys (P0-1) ───────────────────── */

test('editVersion: 0 без editHistory, иначе length', () => {
  assert.equal(transcriptEditVersion(null), 0);
  assert.equal(transcriptEditVersion({}), 0);
  assert.equal(transcriptEditVersion({ editHistory: [] }), 0);
  assert.equal(transcriptEditVersion({ editHistory: [{}, {}] }), 2);
});

test('cache keys: editVer входит в ключ — ripple инвалидирует кэш', () => {
  const before = analysisCacheKey('Seq 01', ['filler'], 'normal', 0);
  const after = analysisCacheKey('Seq 01', ['filler'], 'normal', 1);
  assert.notEqual(before, after);
  const lBefore = labelsCacheKey('Seq 01', ['filler'], 0);
  const lAfter = labelsCacheKey('Seq 01', ['filler'], 1);
  assert.notEqual(lBefore, lAfter);
});

test('cache keys: порядок tasks не влияет (sort)', () => {
  assert.equal(
    labelsCacheKey('S', ['b', 'a'], 1),
    labelsCacheKey('S', ['a', 'b'], 1)
  );
});

test('cache keys: aggressiveness в analysis-ключе, но не в labels-ключе', () => {
  assert.notEqual(
    analysisCacheKey('S', ['a'], 'gentle', 1),
    analysisCacheKey('S', ['a'], 'aggressive', 1)
  );
  /* labels-ключ от агрессивности не зависит — raw метки общие */
  assert.equal(labelsCacheKey('S', ['a'], 1).indexOf('gentle'), -1);
});

test('cache keys: null tasks → "*", null aggressiveness → "normal"', () => {
  assert.equal(labelsCacheKey('S', null, 0), 'S|v0|*');
  assert.equal(analysisCacheKey('S', null, null, 0), 'S|v0|*|normal');
});
