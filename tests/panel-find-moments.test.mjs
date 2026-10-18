/**
 * execFindMoments из panel.js (18.10.2026): смысловой поиск через
 * MomentEmbeddings + CloudRuClient.embeddings, фолбэк на лексику.
 * panel.js целиком в Node не грузится — извлекаем функцию по балансу скобок
 * (как panel-helpers.test.mjs) и исполняем в vm со стабами окружения.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { loadIife } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'client', 'unified', 'panel.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `panel.js: функция ${name} не найдена`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`panel.js: не найден конец функции ${name}`);
}

const shared = {};
loadIife('client/shared/find-moments.js', 'FindMoments', shared);
const ME = loadIife('client/shared/moment-embeddings.js', 'MomentEmbeddings', shared);
const M = 'ai-sage/Giga-Embeddings-instruct-3B';

/* Оси фейкового эмбеддера — темы абзацев (у каждого абзаца своя). */
const AXES = [/steam|стим|комисс|площадк/i, /движ|unity/i, /игр/i];
function vecOf(text) {
  const v = AXES.map((re) => (re.test(text) ? 1 : 0));
  v.push(0.05);
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
}

function setup({ settings, embeddings }) {
  const entry = {
    paragraphs: [
      { startSec: 0, endSec: 10, text: 'Привет, сегодня про игры.' },
      { startSec: 10, endSec: 20, text: 'Площадка забирает тридцать процентов — комиссия Steam.' },
      { startSec: 20, endSec: 30, text: 'Свой движок проще, чем Unity.' }
    ],
    segments: []
  };
  const saved = [];
  const embCalls = [];
  const sandbox = {
    TRANSCRIPT_PID: 'unified',
    runAbort: null,
    _cleanSeqKey: (s) => String(s || '').trim(),
    fmtSec: (s) => String(s),
    FindMoments: shared.FindMoments,
    MomentEmbeddings: ME,
    ContextStore: {
      findTranscriptEntry: () => ({ entry, matchedKey: 'Seq 1' }),
      listTranscriptCacheKeys: () => [],
      getResolvedSettings: () => settings,
      setTranscriptEntry: (pid, key, e) => { saved.push({ pid, key, e }); return true; }
    },
    CloudRuClient: {
      embeddings: (opts) => { embCalls.push(opts); return embeddings(opts); }
    }
  };
  vm.runInNewContext(extractFunction(panelSrc, 'execFindMoments') + '\nthis.fn = execFindMoments;', sandbox);
  return { run: (args) => sandbox.fn(args), entry, saved, embCalls };
}
const ok = (opts) => Promise.resolve({ vectors: opts.input.map(vecOf) });
const SETTINGS = { baseUrl: 'https://fm.example', apiKey: 'k1', embeddingModel: M };

beforeEach(() => ME._resetForTests());

describe('execFindMoments', () => {
  test('по смыслу: searchMode semantic, score, векторы сохраняются в кэш один раз', async () => {
    const s = setup({ settings: SETTINGS, embeddings: ok });
    const r = await s.run({ sequenceKey: 'Seq 1', query: 'сколько берёт стим', k: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.searchMode, 'semantic');
    assert.equal(r.moments[0].startSec, 10);
    assert.equal(typeof r.moments[0].score, 'number');
    assert.equal(s.embCalls[0].model, M);
    assert.equal(s.embCalls[0].apiKey, 'k1');
    assert.equal(s.saved.length, 1);
    assert.equal(s.saved[0].key, 'Seq 1');
    assert.ok(s.saved[0].e.momentEmbeddings, 'векторы в entry');
    await s.run({ sequenceKey: 'Seq 1', query: 'движок', k: 5 });
    assert.equal(s.saved.length, 1, 'повторно кэш не переписываем');
  });

  test('без embeddingModel — лексика как раньше: без score и fallbackReason, сеть не трогаем', async () => {
    const s = setup({ settings: { ...SETTINGS, embeddingModel: '' }, embeddings: ok });
    const r = await s.run({ sequenceKey: 'Seq 1', query: 'комиссия' });
    assert.equal(r.searchMode, 'lexical');
    assert.equal(r.moments[0].startSec, 10);
    assert.equal(r.moments[0].score, undefined);
    assert.equal(r.fallbackReason, undefined);
    assert.equal(s.embCalls.length, 0);
  });

  test('модель вне проекта (403) → лексика + fallbackReason для агента', async () => {
    const deny = () => Promise.reject(Object.assign(new Error('Эмбеддинги ' + M + ': Requested model is not available for this project'), { httpStatus: 403 }));
    const s = setup({ settings: SETTINGS, embeddings: deny });
    const r = await s.run({ sequenceKey: 'Seq 1', query: 'комиссия' });
    assert.equal(r.searchMode, 'lexical');
    assert.match(r.fallbackReason, /not available for this project/);
    assert.equal(r.moments[0].startSec, 10);
  });

  test('слабое совпадение → weakMatch и подсказка не ставить маркеры наугад', async () => {
    const s = setup({ settings: SETTINGS, embeddings: ok });
    const r = await s.run({ sequenceKey: 'Seq 1', query: 'рецепт борща' });
    assert.equal(r.searchMode, 'semantic');
    assert.equal(r.weakMatch, true);
    assert.match(r.note, /не ставь маркеры наугад/);
  });
});
