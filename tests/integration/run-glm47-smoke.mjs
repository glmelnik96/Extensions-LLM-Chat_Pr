/**
 * Real-call smoke test for GLM-4.7 routing (Phase 1.5, май 2026).
 *
 * Цель: проверить что новая конфигурация (chatModel/analysisModel/chapterModel = GLM-4.7,
 * enableThinking, response_format passthrough) реально работает на живом транскрипте
 * из кеша плагина.
 *
 * Запуск:
 *   node tests/integration/run-glm47-smoke.mjs
 *
 * Делает 2 реальных HTTP-вызова к Cloud.ru:
 *   1. analyzeForCutsWithLLM на 11-сегментном транскрипте (1 chunk → 1 вызов)
 *   2. buildTopicsWithLLM на 9-paragraph транскрипте (1 вызов)
 *
 * Логирует:
 *   - Какая модель использована, какой response_format, thinking ON/OFF
 *   - Latency
 *   - Усеченный output
 *   - EN-leakage check (% non-cyrillic слов в `reason` полях)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '../..');
const SHARED = resolve(ROOT, 'client/shared');

/* ─── Bootstrap legacy IIFE-modules in single VM context ───────────────── */

const ctx = {
  Array, Object, Math, String, Number, JSON, Error, RegExp, Date,
  Boolean, Promise, Symbol, Map, Set, WeakMap, WeakSet,
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, undefined,
  fetch,                /* node 18+ has global fetch */
  AbortController,
  module: { exports: {} },
  exports: {}
};
ctx.global = ctx;
ctx.window = ctx;       /* IIFE checks `typeof window !== 'undefined'` */
ctx.self = ctx;
vm.createContext(ctx);

/* Загружаем модули в порядке зависимостей. Important: fm-secrets first. */
const FILES = [
  'fm-defaults.js',
  'fm-secrets.js',
  'cloudru-client.js',
  'analysis-routing.js',
  'context-store.js',
  'transcript-structure.js'
];

for (const f of FILES) {
  const code = readFileSync(resolve(SHARED, f), 'utf8');
  vm.runInContext(code, ctx, { filename: f });
}

console.log('=== Boot OK ===');
console.log('FM_DEFAULTS chatModel:', ctx.FM_DEFAULTS.chatModel);
console.log('FM_DEFAULTS analysisModel:', ctx.FM_DEFAULTS.analysisModel);
console.log('FM_DEFAULTS chapterModel:', ctx.FM_DEFAULTS.chapterModel);
console.log('FM_DEFAULTS enableThinking:', ctx.FM_DEFAULTS.enableThinking);
console.log('FM_DEFAULTS chatParams.temperature:', ctx.FM_DEFAULTS.chatParams.temperature);
console.log('apiKey present:', ctx.FM_SECRETS && ctx.FM_SECRETS.apiKey ? 'yes (len ' + ctx.FM_SECRETS.apiKey.length + ')' : 'NO!');

if (!ctx.FM_SECRETS || !ctx.FM_SECRETS.apiKey) {
  console.error('FM_SECRETS.apiKey не задан — останавливаюсь, реальные вызовы невозможны.');
  process.exit(1);
}

/* ─── Load real cache ──────────────────────────────────────────────────── */

const cachePath = '/Users/gmmelnikov/.extensions_llm_chat_pr/_llm_transcript_cache.json';
const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
const seqKey = Object.keys(cache)[0];
const entry = cache[seqKey];

/* Normalize segments: ensure i, startSec/endSec, text */
const segments = entry.segments.map((s, i) => ({
  i: typeof s.i === 'number' ? s.i : i,
  startSec: typeof s.startSec === 'number' ? s.startSec : s.start,
  endSec: typeof s.endSec === 'number' ? s.endSec : s.end,
  text: s.text || ''
}));

const paragraphs = entry.paragraphs.map((p, i) => ({
  startSec: typeof p.startSec === 'number' ? p.startSec : p.start,
  endSec: typeof p.endSec === 'number' ? p.endSec : p.end,
  text: p.text || ''
}));

console.log('\n=== Transcript loaded ===');
console.log('seqKey:', seqKey);
console.log('segments:', segments.length);
console.log('paragraphs:', paragraphs.length);
console.log('text size:', entry.text.length, 'chars');

const settings = {
  baseUrl: ctx.FM_DEFAULTS.baseUrl,
  apiKey: ctx.FM_SECRETS.apiKey,
  chatModel: ctx.FM_DEFAULTS.chatModel,
  analysisModel: ctx.FM_DEFAULTS.analysisModel,
  chapterModel: ctx.FM_DEFAULTS.chapterModel,
  enableThinking: ctx.FM_DEFAULTS.enableThinking
};

/* ─── EN-leakage detector v2 (6 мая) — исключает valid labels и KNOWN_TERMS ── */
const VALID_LABELS = new Set(['filler', 'intro', 'outro', 'outtake', 'repeat', 'artifact', 'digression', 'content']);
const KNOWN_TERMS = new Set(['cloud', 'ru', 'andrey', 'andrew', 'whisper', 'pp', 'youtube', 'tiktok', 'okr', 'kpi', 'api', 'llm', 'json', 'ai', 'glm', 'gpt']);
function enLeakageCheck(text, label) {
  const words = String(text || '').split(/[\s,.;:!?()«»"'\-]+/).filter(Boolean);
  if (!words.length) return { ratio: 0, sample: [] };
  const enWords = words.filter(w => {
    if (!/^[A-Za-z][A-Za-z\-']*$/.test(w) || w.length <= 2) return false;
    const lower = w.toLowerCase();
    return !VALID_LABELS.has(lower) && !KNOWN_TERMS.has(lower);
  });
  const ratio = enWords.length / words.length;
  return { ratio, totalWords: words.length, enCount: enWords.length, sample: enWords.slice(0, 5) };
}

/* ─── 1. analyzeForCutsWithLLM ─────────────────────────────────────────── */
async function testAnalyze() {
  console.log('\n========================================');
  console.log('TEST 1: analyzeForCutsWithLLM (GLM-4.7 + thinking + json_object)');
  console.log('========================================');
  const t0 = Date.now();
  let lastPhase = null;
  const result = await ctx.TranscriptStructure.analyzeForCutsWithLLM(segments, {
    settings,
    CloudRuClient: ctx.CloudRuClient,
    tasks: ['filler', 'intro', 'outro', 'outtake', 'repeat', 'artifact'],
    onProgress: (ev) => {
      if (ev.phase !== lastPhase) {
        lastPhase = ev.phase;
        console.log('  [' + ev.phase + ']', ev.message || '');
      }
    }
  });
  const dt = Date.now() - t0;
  console.log('\n  Время: ' + dt + 'мс');
  console.log('  Stats:', JSON.stringify(result.stats));
  console.log('  Chunks:', result.chunks);
  console.log('  Failed chunks:', (result.failedChunks || []).length);
  console.log('  Missed segments:', result.missedSegments || 0);
  console.log('\n  Labels:');
  result.labels.forEach(lb => {
    const seg = segments.find(s => s.i === lb.i);
    const t = seg ? '[' + seg.startSec.toFixed(1) + '-' + seg.endSec.toFixed(1) + ']' : '';
    console.log('    [i=' + lb.i + '] ' + t + ' label=' + lb.label + ' reason="' + lb.reason + '"');
  });
  /* EN-leakage по reason полям */
  const allReasons = result.labels.map(l => l.reason).join(' ');
  const leak = enLeakageCheck(allReasons);
  console.log('\n  EN-leakage check on reasons: ' +
    (leak.ratio * 100).toFixed(1) + '% (' + leak.enCount + '/' + leak.totalWords +
    ' слов, sample: ' + JSON.stringify(leak.sample) + ')');
  return { result, latency: dt, leak };
}

/* ─── 2. buildTopicsWithLLM ────────────────────────────────────────────── */
async function testTopics() {
  console.log('\n========================================');
  console.log('TEST 2: buildTopicsWithLLM (chapterModel = GLM-4.7 + thinking + json_object)');
  console.log('========================================');
  const t0 = Date.now();
  const topics = await ctx.TranscriptStructure.buildTopicsWithLLM(paragraphs, {
    settings,
    CloudRuClient: ctx.CloudRuClient
  });
  const dt = Date.now() - t0;
  console.log('  Время: ' + dt + 'мс');
  console.log('  Topics:', topics.length);
  topics.forEach((t, i) => {
    console.log('    [' + (i + 1) + '] ' + t.startSec.toFixed(1) + '–' + t.endSec.toFixed(1) +
      'с | ' + t.title + ' | ' + (t.summary || '').slice(0, 80));
  });
  const allTitles = topics.map(t => t.title + ' ' + (t.summary || '')).join(' ');
  const leak = enLeakageCheck(allTitles);
  console.log('\n  EN-leakage check on titles+summaries: ' +
    (leak.ratio * 100).toFixed(1) + '% (' + leak.enCount + '/' + leak.totalWords +
    ' слов, sample: ' + JSON.stringify(leak.sample) + ')');
  return { topics, latency: dt, leak };
}

/* ─── Run ──────────────────────────────────────────────────────────────── */
(async () => {
  const summary = {};
  try {
    const t1 = await testAnalyze();
    summary.analyze = {
      latency_ms: t1.latency,
      labels: t1.result.labels.length,
      en_leakage_pct: (t1.leak.ratio * 100).toFixed(1),
      stats: t1.result.stats
    };
  } catch (e) {
    console.error('TEST 1 failed:', e.message);
    summary.analyze = { error: e.message };
  }
  try {
    const t2 = await testTopics();
    summary.topics = {
      latency_ms: t2.latency,
      topics_count: t2.topics.length,
      en_leakage_pct: (t2.leak.ratio * 100).toFixed(1),
      titles: t2.topics.map(t => t.title)
    };
  } catch (e) {
    console.error('TEST 2 failed:', e.message);
    summary.topics = { error: e.message };
  }
  console.log('\n========================================');
  console.log('SUMMARY (JSON):');
  console.log('========================================');
  console.log(JSON.stringify(summary, null, 2));
})();
