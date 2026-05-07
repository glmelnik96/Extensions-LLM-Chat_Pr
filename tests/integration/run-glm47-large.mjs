/**
 * Large-scale integration test: симуляция реального ~20-минутного подкаста.
 *
 * Метод: реальный кеш повторяется 10 раз с time-offset → ~110 сегментов,
 * ~90 параграфов, ~14 KB транскрипт. Это close-to-production scale.
 *
 * Цель: замерить реальный latency, max_tokens behavior, EN-leakage,
 * cross-chunk bridging effect (3 chunks в analyze) на large input.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED = resolve(__dirname, '../../client/shared');

const ctx = {
  Array, Object, Math, String, Number, JSON, Error, RegExp, Date,
  Boolean, Promise, Symbol, Map, Set, WeakMap, WeakSet,
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, undefined, fetch, AbortController,
  module: { exports: {} }, exports: {}
};
ctx.global = ctx; ctx.window = ctx; ctx.self = ctx;
vm.createContext(ctx);

['fm-defaults.js', 'fm-secrets.js', 'cloudru-client.js', 'analysis-routing.js',
 'context-store.js', 'transcript-structure.js'].forEach(f => {
  vm.runInContext(readFileSync(resolve(SHARED, f), 'utf8'), ctx, { filename: f });
});

const cache = JSON.parse(readFileSync('/Users/gmmelnikov/.extensions_llm_chat_pr/_llm_transcript_cache.json', 'utf8'));
const baseEntry = cache[Object.keys(cache)[0]];
const baseSegs = baseEntry.segments;
const basePars = baseEntry.paragraphs;
const baseDur = basePars[basePars.length - 1].endSec; // ~114s

/* ═════ 10× ESCALATION ═════ */
const REPEATS = 10;
const segments = [];
const paragraphs = [];
let segCounter = 0;
for (let r = 0; r < REPEATS; r++) {
  const offset = r * (baseDur + 5); /* 5с пауза между сегментами повторов */
  baseSegs.forEach((s, i) => {
    segments.push({
      i: segCounter++,
      startSec: (s.startSec ?? s.start) + offset,
      endSec: (s.endSec ?? s.end) + offset,
      text: s.text || ''
    });
  });
  basePars.forEach(p => {
    paragraphs.push({
      startSec: (p.startSec ?? p.start) + offset,
      endSec: (p.endSec ?? p.end) + offset,
      text: p.text || ''
    });
  });
}

console.log('=== LARGE TEST DATA ===');
console.log('Segments:', segments.length);
console.log('Paragraphs:', paragraphs.length);
console.log('Total duration:', paragraphs[paragraphs.length-1].endSec.toFixed(1), 'сек');
console.log('Estimated chunks for analyze (50/chunk):', Math.ceil(segments.length / 50));
console.log('Total text size:', segments.reduce((s, x) => s + x.text.length, 0), 'chars');

const settings = {
  baseUrl: ctx.FM_DEFAULTS.baseUrl,
  apiKey: ctx.FM_SECRETS.apiKey,
  chatModel: ctx.FM_DEFAULTS.chatModel,
  analysisModel: ctx.FM_DEFAULTS.analysisModel,
  chapterModel: ctx.FM_DEFAULTS.chapterModel,
  enableThinking: ctx.FM_DEFAULTS.enableThinking
};

/* EN-leakage детектор. Фикс v2 (6 мая):
   Раньше засчитывал label-токены ('repeat', 'filler' и т.д.) как leakage.
   Теперь исключаем:
   - valid labels (часть нашего prompt-контракта)
   - известные имена/бренды в RU-контексте: Cloud, Andrey, Whisper, etc. */
const VALID_LABELS = new Set([
  'filler', 'intro', 'outro', 'outtake', 'repeat', 'artifact', 'digression', 'content'
]);
const KNOWN_TERMS = new Set([
  'cloud', 'ru', 'andrey', 'andrew', 'whisper', 'pp', 'youtube', 'tiktok',
  'okr', 'kpi', 'api', 'llm', 'json', 'ai', 'glm', 'gpt'
]);
function leak(text) {
  const words = String(text || '').split(/[\s,.;:!?()«»"'\-]+/).filter(Boolean);
  if (!words.length) return { ratio: 0, sample: [] };
  const en = words.filter(w => {
    if (!/^[A-Za-z][A-Za-z\-']*$/.test(w) || w.length <= 2) return false;
    const lower = w.toLowerCase();
    if (VALID_LABELS.has(lower) || KNOWN_TERMS.has(lower)) return false;
    return true;
  });
  return { ratio: en.length / words.length, total: words.length, en: en.length, sample: en.slice(0, 6) };
}

(async () => {
  const summary = {};

  /* Test 1: analyze with 3 chunks */
  console.log('\n========================================');
  console.log('TEST 1: analyze 110 segments (3 chunks, cross-chunk bridging)');
  console.log('========================================');
  const t1 = Date.now();
  let chunkIdx = 0;
  try {
    const res = await ctx.TranscriptStructure.analyzeForCutsWithLLM(segments, {
      settings, CloudRuClient: ctx.CloudRuClient,
      tasks: ['filler', 'intro', 'outro', 'outtake', 'repeat', 'artifact'],
      onProgress: (ev) => {
        if (ev.phase === 'chunk' || ev.phase === 'chunk_done' || ev.phase === 'chunk_error') {
          console.log('  [' + ev.phase + ' #' + (ev.chunkIndex || '?') + '/' + (ev.totalChunks || '?') + '] ' +
            (ev.message || '').slice(0, 100));
        }
      }
    });
    const dt = Date.now() - t1;
    const reasons = res.labels.map(l => l.reason).join(' ');
    const lk = leak(reasons);
    console.log('\n  Время: ' + (dt/1000).toFixed(1) + ' сек');
    console.log('  Stats:', JSON.stringify(res.stats));
    console.log('  Labels: ' + res.labels.length);
    console.log('  Failed chunks:', (res.failedChunks || []).length);
    console.log('  EN-leakage in reasons:', (lk.ratio * 100).toFixed(1) + '%',
      '(' + lk.en + '/' + lk.total + ')', 'sample:', lk.sample);
    /* Сколько раз поймали repeat — 9 повторений одного и того же текста, должно быть много repeat */
    const repeats = res.labels.filter(l => l.label === 'repeat').length;
    const intros = res.labels.filter(l => l.label === 'intro').length;
    const outros = res.labels.filter(l => l.label === 'outro').length;
    console.log('\n  Cross-chunk bridging effect:');
    console.log('    intro count:', intros, '(должно быть несколько — 10 «всем привет»)');
    console.log('    repeat count:', repeats, '(должно быть много — 10× повтор того же текста)');
    console.log('    outro count:', outros);
    summary.analyze = {
      latency_sec: +(dt/1000).toFixed(1),
      labels: res.labels.length,
      chunks: res.chunks,
      failedChunks: (res.failedChunks || []).length,
      stats: res.stats,
      en_leakage_pct: +(lk.ratio * 100).toFixed(1),
      cross_chunk_repeat_detected: repeats,
      intros_detected: intros
    };
  } catch (e) {
    console.error('TEST 1 failed:', e.message);
    summary.analyze = { error: e.message };
  }

  /* Test 2: buildTopics on 90 paragraphs */
  console.log('\n========================================');
  console.log('TEST 2: buildTopics 90 paragraphs (one big call)');
  console.log('========================================');
  const t2 = Date.now();
  try {
    const topics = await ctx.TranscriptStructure.buildTopicsWithLLM(paragraphs, {
      settings, CloudRuClient: ctx.CloudRuClient
    });
    const dt = Date.now() - t2;
    console.log('  Время: ' + (dt/1000).toFixed(1) + ' сек');
    console.log('  Topics: ' + topics.length);
    topics.forEach((t, i) => {
      console.log('    [' + (i+1) + '] ' + t.startSec.toFixed(0) + '–' + t.endSec.toFixed(0) +
        'с | ' + t.title);
    });
    const allText = topics.map(t => t.title + ' ' + (t.summary || '')).join(' ');
    const lk = leak(allText);
    console.log('\n  EN-leakage in titles+summaries:', (lk.ratio * 100).toFixed(1) + '%',
      '(' + lk.en + '/' + lk.total + ')', 'sample:', lk.sample);
    summary.topics = {
      latency_sec: +(dt/1000).toFixed(1),
      count: topics.length,
      titles: topics.map(t => t.title),
      en_leakage_pct: +(lk.ratio * 100).toFixed(1)
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
