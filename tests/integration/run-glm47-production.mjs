/**
 * Production-scale eval (Phase 1.5 final, 6 мая 2026):
 *
 * Берёт САМЫЙ БОЛЬШОЙ entry в кеше транскриптов (для теста на 1ч подкасте).
 * Прогоняет:
 *   1. analyzeForCutsWithLLM (без thinking, parallel concurrency=3)
 *      на ВСЕХ сегментах подкаста — production load
 *   2. buildTopicsWithLLM (с thinking) на ВСЕХ параграфах
 *   3. Опционально: сравнение GLM-4.7 vs Flash на одном чанке
 *
 * Метрики: latency, throughput (segm/sec), failed chunks ratio, label
 * distribution, EN-leakage, output lengths.
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

/* Picks the entry with most segments — assumes that's our 1-hour podcast. */
const cache = JSON.parse(readFileSync('/Users/gmmelnikov/.extensions_llm_chat_pr/_llm_transcript_cache.json', 'utf8'));
const keys = Object.keys(cache);
let bestKey = null, bestCount = 0;
for (const k of keys) {
  const e = cache[k];
  const cnt = (e && e.segments && e.segments.length) || 0;
  if (cnt > bestCount) { bestKey = k; bestCount = cnt; }
}
if (!bestKey) {
  console.error('Кеш пуст. Сначала транскрибируй In-Out в Premiere.');
  process.exit(1);
}
const entry = cache[bestKey];

const segments = entry.segments.map((s, i) => ({
  i: typeof s.i === 'number' ? s.i : i,
  startSec: typeof s.startSec === 'number' ? s.startSec : s.start,
  endSec: typeof s.endSec === 'number' ? s.endSec : s.end,
  text: s.text || ''
}));
const paragraphs = (entry.paragraphs || []).map(p => ({
  startSec: typeof p.startSec === 'number' ? p.startSec : p.start,
  endSec: typeof p.endSec === 'number' ? p.endSec : p.end,
  text: p.text || ''
}));

const totalDur = segments.length ? (segments[segments.length - 1].endSec || 0) : 0;
const totalChars = segments.reduce((s, x) => s + (x.text || '').length, 0);

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  PRODUCTION-SCALE EVAL — реальный 1ч подкаст             ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log('Кеш entry:', bestKey);
console.log('Сегменты:', segments.length, '| Параграфы:', paragraphs.length);
console.log('Длительность:', (totalDur / 60).toFixed(1), 'мин (', totalDur.toFixed(0), 'сек)');
console.log('Текст:', totalChars, 'chars (~', Math.round(totalChars / 3.5).toLocaleString(), 'токенов)');
console.log('Ожидаемые chunks:', Math.ceil(segments.length / 50));

const VALID_LABELS = new Set(['filler', 'intro', 'outro', 'outtake', 'repeat', 'artifact', 'digression', 'content']);
const KNOWN_TERMS = new Set(['cloud', 'ru', 'andrey', 'andrew', 'whisper', 'pp', 'youtube', 'tiktok', 'okr', 'kpi', 'api', 'llm', 'json', 'ai', 'glm', 'gpt', 'kama', 'atom', 'rosatom']);
function leak(text) {
  const words = String(text || '').split(/[\s,.;:!?()«»"'\-]+/).filter(Boolean);
  if (!words.length) return { ratio: 0, sample: [] };
  const en = words.filter(w => {
    if (!/^[A-Za-z][A-Za-z\-']*$/.test(w) || w.length <= 2) return false;
    const lower = w.toLowerCase();
    return !VALID_LABELS.has(lower) && !KNOWN_TERMS.has(lower);
  });
  return { ratio: en.length / words.length, total: words.length, en: en.length, sample: en.slice(0, 8) };
}

const baseSettings = {
  baseUrl: ctx.FM_DEFAULTS.baseUrl,
  apiKey: ctx.FM_SECRETS.apiKey,
  thinkingPolicy: { analyze: false, chapter: true, chat: true, report: true },
  enableThinking: false,
  analyzeConcurrency: 3
};

(async () => {
  const summary = { material: { entry: bestKey, segments: segments.length, paragraphs: paragraphs.length, durSec: totalDur, chars: totalChars } };

  /* ─────────── TEST 1: analyze full transcript ─────────── */
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('TEST 1: analyze ALL segments (GLM-4.7-Flash, no thinking, concurrency=3)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const settings = Object.assign({}, baseSettings, {
      chatModel: 'zai-org/GLM-4.7',
      analysisModel: 'zai-org/GLM-4.7-Flash',
      chapterModel: 'zai-org/GLM-4.7'
    });
    let chunkProgress = 0;
    const t0 = Date.now();
    const result = await ctx.TranscriptStructure.analyzeForCutsWithLLM(segments, {
      settings, CloudRuClient: ctx.CloudRuClient,
      tasks: ['filler', 'intro', 'outro', 'outtake', 'repeat', 'artifact'],
      onProgress: (ev) => {
        if (ev.phase === 'chunk_done') {
          chunkProgress++;
          console.log(`  [chunk ${ev.chunkIndex}/${ev.totalChunks}] done — ${ev.labelsInChunk} меток (cumulative: ${chunkProgress}/${ev.totalChunks})`);
        } else if (ev.phase === 'chunk_error') {
          console.log(`  [chunk ${ev.chunkIndex}] ERROR: ${(ev.error || '').slice(0, 80)}`);
        } else if (ev.phase === 'start') {
          console.log(`  ${ev.message}`);
        }
      }
    });
    const dt = (Date.now() - t0) / 1000;
    const reasonsText = result.labels.map(l => l.reason).join(' ');
    const lk = leak(reasonsText);
    const failed = (result.failedChunks || []).length;
    console.log(`\n  Время: ${dt.toFixed(1)}с (${(dt / 60).toFixed(1)}мин)`);
    console.log(`  Throughput: ${(segments.length / dt).toFixed(1)} segm/sec | ${(totalDur / dt).toFixed(1)}× realtime`);
    console.log(`  Chunks: ${result.chunks}, failed: ${failed}/${result.chunks} (${failed > 0 ? Math.round(failed / result.chunks * 100) : 0}%)`);
    console.log(`  Labels: ${result.labels.length}`);
    console.log(`  Stats: ${JSON.stringify(result.stats)}`);
    console.log(`  EN-leakage в reasons: ${(lk.ratio * 100).toFixed(1)}% (${lk.en}/${lk.total}), sample: ${JSON.stringify(lk.sample)}`);
    summary.analyze = {
      latency_sec: +dt.toFixed(1),
      latency_min: +(dt / 60).toFixed(2),
      realtime_factor: +(totalDur / dt).toFixed(1),
      chunks: result.chunks,
      failed_chunks: failed,
      labels: result.labels.length,
      stats: result.stats,
      en_leakage_pct: +(lk.ratio * 100).toFixed(1),
      missed_segments: result.missedSegments || 0
    };
  } catch (e) {
    console.error(`  ERROR: ${e.message}`);
    summary.analyze = { error: e.message };
  }

  /* ─────────── TEST 2: buildTopics ─────────── */
  if (paragraphs.length) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`TEST 2: buildTopics on ${paragraphs.length} paragraphs (GLM-4.7, thinking ON)`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    try {
      const settings = Object.assign({}, baseSettings, {
        chatModel: 'zai-org/GLM-4.7',
        analysisModel: 'zai-org/GLM-4.7-Flash',
        chapterModel: 'zai-org/GLM-4.7'
      });
      const t0 = Date.now();
      const topics = await ctx.TranscriptStructure.buildTopicsWithLLM(paragraphs, {
        settings, CloudRuClient: ctx.CloudRuClient
      });
      const dt = (Date.now() - t0) / 1000;
      const titlesText = topics.map(t => t.title + ' ' + (t.summary || '')).join(' ');
      const lk = leak(titlesText);
      const uniqueTitles = new Set(topics.map(t => t.title.trim().toLowerCase()));
      console.log(`  Время: ${dt.toFixed(1)}с (${(dt / 60).toFixed(1)}мин)`);
      console.log(`  Topics: ${topics.length} (уникальных: ${uniqueTitles.size})`);
      topics.forEach((t, i) => {
        const dur = t.endSec - t.startSec;
        console.log(`    [${i + 1}] ${(t.startSec / 60).toFixed(1)}–${(t.endSec / 60).toFixed(1)}мин (${dur.toFixed(0)}с) | ${t.title}`);
        if (t.summary) console.log(`        └─ ${t.summary.slice(0, 100)}`);
      });
      console.log(`  EN-leakage: ${(lk.ratio * 100).toFixed(1)}%`);
      summary.buildTopics = {
        latency_sec: +dt.toFixed(1),
        count: topics.length,
        unique_count: uniqueTitles.size,
        titles: topics.map(t => t.title),
        en_leakage_pct: +(lk.ratio * 100).toFixed(1)
      };
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      summary.buildTopics = { error: e.message };
    }
  } else {
    console.log('\n  TEST 2 SKIPPED: paragraphs not in cache');
    summary.buildTopics = { skipped: 'no paragraphs' };
  }

  /* ─────────── SUMMARY ─────────── */
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  SUMMARY (JSON)                                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(JSON.stringify(summary, null, 2));
})();
