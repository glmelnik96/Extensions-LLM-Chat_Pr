/**
 * Comprehensive eval (Phase 1.5 final, 6 мая 2026):
 *
 * 1. Ground-truth quality eval на smoke датасете (×1, 11 сегментов)
 * 2. Сравнение GLM-4.7 vs GLM-4.7-Flash на analyze (latency + label match)
 * 3. Перепрогон buildTopics после prompt+dedup фиксов
 *
 * Smoke материал — Cloud.ru Андрей про блок Стратегии и Аналитики (2 мин).
 * Ground truth для классификации: ручная разметка по нашему prompt'у.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
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

const cache = JSON.parse(readFileSync(join(homedir(), '.extensions_llm_chat_pr', '_llm_transcript_cache.json'), 'utf8'));
const entry = cache[Object.keys(cache)[0]];
const segments = entry.segments.map((s, i) => ({
  i: typeof s.i === 'number' ? s.i : i,
  startSec: typeof s.startSec === 'number' ? s.startSec : s.start,
  endSec: typeof s.endSec === 'number' ? s.endSec : s.end,
  text: s.text || ''
}));
const paragraphs = entry.paragraphs.map(p => ({
  startSec: p.startSec || p.start, endSec: p.endSec || p.end, text: p.text || ''
}));

/* ─── Ground truth для smoke материала ──────────────────────────
   По нашему prompt'у:
   • i=0: «Всем привет! Меня зовут Андрей…» → intro (приветствие + представление)
   • i=1-9: содержательные мысли про блок аналитики → content
   • i=10: «Прекрасно.» — финальная отмашка → outro (или content; неоднозначно)
*/
const GROUND_TRUTH = {
  0: 'intro',
  1: 'content', 2: 'content', 3: 'content',
  4: 'content', 5: 'content', 6: 'content',
  7: 'content', 8: 'content', 9: 'content',
  10: 'content' /* спорно: 'Прекрасно' можно outro, но кратко */
};

const VALID_LABELS = new Set(['filler', 'intro', 'outro', 'outtake', 'repeat', 'artifact', 'digression', 'content']);
const KNOWN_TERMS = new Set(['cloud', 'ru', 'andrey', 'andrew', 'whisper', 'pp', 'youtube', 'tiktok', 'okr', 'kpi', 'api', 'llm', 'json', 'ai', 'glm', 'gpt']);
function leak(text) {
  const words = String(text || '').split(/[\s,.;:!?()«»"'\-]+/).filter(Boolean);
  if (!words.length) return { ratio: 0, sample: [] };
  const en = words.filter(w => {
    if (!/^[A-Za-z][A-Za-z\-']*$/.test(w) || w.length <= 2) return false;
    const lower = w.toLowerCase();
    return !VALID_LABELS.has(lower) && !KNOWN_TERMS.has(lower);
  });
  return { ratio: en.length / words.length, total: words.length, en: en.length, sample: en.slice(0, 5) };
}

const baseSettings = {
  baseUrl: ctx.FM_DEFAULTS.baseUrl,
  apiKey: ctx.FM_SECRETS.apiKey,
  thinkingPolicy: { analyze: false, chapter: true, chat: true, report: true },
  enableThinking: false,
  analyzeConcurrency: 3
};

async function runAnalyze(modelName) {
  const settings = Object.assign({}, baseSettings, {
    chatModel: modelName,
    analysisModel: modelName,
    chapterModel: modelName
  });
  const t0 = Date.now();
  let chunkErrors = 0;
  const result = await ctx.TranscriptStructure.analyzeForCutsWithLLM(segments, {
    settings, CloudRuClient: ctx.CloudRuClient,
    tasks: ['filler', 'intro', 'outro', 'outtake', 'repeat', 'artifact'],
    onProgress: (ev) => {
      if (ev.phase === 'chunk_error') chunkErrors++;
    }
  });
  return { result, latency: Date.now() - t0, chunkErrors };
}

function evalLabels(labels) {
  /* Точность относительно GROUND_TRUTH. */
  let correct = 0, total = 0, mismatches = [];
  labels.forEach(lb => {
    const expected = GROUND_TRUTH[lb.i];
    if (!expected) return;
    total++;
    if (lb.label === expected) correct++;
    else mismatches.push({ i: lb.i, expected, got: lb.label, reason: lb.reason });
  });
  return { correct, total, accuracy: total > 0 ? correct / total : 0, mismatches };
}

(async () => {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  GLM-4.7 vs GLM-4.7-Flash comprehensive eval             ║');
  console.log('║  Material: smoke (11 сегм, 9 пар, 114с)                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const models = [
    { name: 'zai-org/GLM-4.7', label: 'GLM-4.7' },
    { name: 'zai-org/GLM-4.7-Flash', label: 'GLM-4.7-Flash' }
  ];

  const summary = {};

  for (const m of models) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`▶ ${m.label} — analyze`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    try {
      const t = await runAnalyze(m.name);
      const ev = evalLabels(t.result.labels);
      const reasonsText = t.result.labels.map(l => l.reason).join(' ');
      const lk = leak(reasonsText);
      console.log(`  latency:        ${(t.latency / 1000).toFixed(1)}с`);
      console.log(`  chunks:         ${t.result.chunks}, failed: ${(t.result.failedChunks || []).length}`);
      console.log(`  accuracy:       ${(ev.accuracy * 100).toFixed(1)}% (${ev.correct}/${ev.total})`);
      console.log(`  EN-leakage:     ${(lk.ratio * 100).toFixed(1)}%${lk.sample.length ? ' (' + lk.sample.join(',') + ')' : ''}`);
      console.log(`  stats:          ${JSON.stringify(t.result.stats)}`);
      if (ev.mismatches.length) {
        console.log(`  mismatches (${ev.mismatches.length}):`);
        ev.mismatches.forEach(mm => {
          console.log(`    [i=${mm.i}] expected=${mm.expected}, got=${mm.got}, reason="${(mm.reason || '').slice(0, 60)}"`);
        });
      }
      summary[m.label] = {
        analyze: {
          latency_sec: +(t.latency / 1000).toFixed(1),
          accuracy: +(ev.accuracy * 100).toFixed(1),
          en_leakage_pct: +(lk.ratio * 100).toFixed(1),
          chunks: t.result.chunks,
          failed: (t.result.failedChunks || []).length,
          stats: t.result.stats,
          mismatches_count: ev.mismatches.length
        }
      };
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      summary[m.label] = { analyze: { error: e.message } };
    }
  }

  /* Test 2: buildTopics только на GLM-4.7 (chapterModel, чтобы проверить prompt+dedup фиксы) */
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('▶ buildTopics — GLM-4.7 (после prompt+dedup фиксов)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const settings = Object.assign({}, baseSettings, {
      chatModel: 'zai-org/GLM-4.7',
      analysisModel: 'zai-org/GLM-4.7',
      chapterModel: 'zai-org/GLM-4.7',
      enableThinking: true /* для chapter включаем */
    });
    settings.thinkingPolicy = { analyze: false, chapter: true, chat: true, report: true };

    const t0 = Date.now();
    const topics = await ctx.TranscriptStructure.buildTopicsWithLLM(paragraphs, {
      settings, CloudRuClient: ctx.CloudRuClient
    });
    const dt = Date.now() - t0;
    const lk = leak(topics.map(t => t.title + ' ' + (t.summary || '')).join(' '));
    console.log(`  latency:        ${(dt / 1000).toFixed(1)}с`);
    console.log(`  topics:         ${topics.length}`);
    topics.forEach((t, i) => {
      console.log(`    [${i + 1}] ${t.startSec.toFixed(0)}–${t.endSec.toFixed(0)}с | ${t.title}`);
    });
    /* Проверка уникальности titles */
    const uniqueTitles = new Set(topics.map(t => t.title.trim().toLowerCase()));
    console.log(`  unique titles:  ${uniqueTitles.size}/${topics.length}`);
    console.log(`  EN-leakage:     ${(lk.ratio * 100).toFixed(1)}%`);
    summary.buildTopics = {
      latency_sec: +(dt / 1000).toFixed(1),
      count: topics.length,
      unique_count: uniqueTitles.size,
      titles: topics.map(t => t.title),
      en_leakage_pct: +(lk.ratio * 100).toFixed(1)
    };
  } catch (e) {
    console.error(`  ERROR: ${e.message}`);
    summary.buildTopics = { error: e.message };
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  SUMMARY (JSON)                                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(JSON.stringify(summary, null, 2));
})();
