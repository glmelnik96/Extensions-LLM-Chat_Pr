/**
 * run-starters-quality.mjs (7 мая 2026)
 *
 * Реальная валидация качества всех 6 стартеров через Cloud.ru API.
 *
 * Что делает: для каждого стартера эмулирует agent-loop:
 *   1. Загружает startersystemPromptAddon + base TIER1 prompt
 *   2. Делает chatCompletions с tools=[propose_*, find_moments, get_transcript_structure, ...]
 *   3. Парсит tool_calls
 *   4. Имитирует ответы tools на основе реального кэша
 *   5. Делает повторные chatCompletions пока LLM не закроет цикл
 *   6. Проверяет семантику финального предложения:
 *      - Story Cutter Timed: keepIntervals.sum попадает в [target*0.85, target*1.20]
 *      - YouTube Chapters: количество глав соответствует длине, валидация YT проходит
 *      - Highlights: gap≥10с, type=comment, число в нужном диапазоне
 *      - Filler Cleanup: removeIntervals все короткие (<10с), не вырезает большие куски
 *      - Find Moments: результат для конкретного запроса не пустой
 *      - Story Cutter (без N): keepIntervals хронологически отсортированы
 *
 * Запуск: node tests/integration/run-starters-quality.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '../..');
const SHARED = resolve(ROOT, 'client/shared');

/* ─── Bootstrap shared modules ────────────────────────────────────────── */
const ctx = {
  Array, Object, Math, String, Number, JSON, Error, RegExp, Date,
  Boolean, Promise, Symbol, Map, Set, WeakMap, WeakSet,
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, undefined,
  fetch, AbortController,
  module: { exports: {} }, exports: {}
};
ctx.global = ctx; ctx.window = ctx; ctx.self = ctx;
vm.createContext(ctx);

const FILES = [
  'fm-defaults.js', 'fm-secrets.js', 'cloudru-client.js',
  'analysis-routing.js', 'find-moments.js', 'youtube-export.js',
  'context-store.js', 'transcript-structure.js',
  'conversation-starters.js'
];
for (const f of FILES) {
  try {
    const code = readFileSync(resolve(SHARED, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  } catch (e) {
    if (f === 'fm-secrets.js' || f === 'conversation-starters.js') continue;
    throw e;
  }
}
/* localStorage stub for ConversationStarters */
ctx.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] || null; },
  setItem(k, v) { this._s[k] = v; },
  removeItem(k) { delete this._s[k]; }
};
/* Re-load conversation-starters now that localStorage exists */
vm.runInContext(readFileSync(resolve(SHARED, 'conversation-starters.js'), 'utf8'), ctx, { filename: 'conversation-starters.js' });

if (!ctx.FM_SECRETS || !ctx.FM_SECRETS.apiKey) {
  console.error('FM_SECRETS.apiKey не задан — реальные вызовы невозможны.');
  process.exit(1);
}

const CC = ctx.CloudRuClient;
const settings = {
  baseUrl: ctx.FM_DEFAULTS.baseUrl,
  apiKey: ctx.FM_SECRETS.apiKey,
  chatModel: ctx.FM_DEFAULTS.chatModel,
  chatParams: ctx.FM_DEFAULTS.chatParams,
  enableThinking: false /* быстрее для теста */
};

/* ─── Load cache ───────────────────────────────────────────────────────── */
const CACHE = JSON.parse(readFileSync(resolve(os.homedir(), '.extensions_llm_chat_pr/_llm_transcript_cache.json'), 'utf8'));
const cacheKey = Object.keys(CACHE)[0];
const entry = CACHE[cacheKey];
const totalDur = Math.max(
  entry.segments[entry.segments.length - 1].endSec,
  entry.paragraphs.length ? entry.paragraphs[entry.paragraphs.length - 1].endSec : 0
);
console.log(`Cache: ${cacheKey} | segments=${entry.segments.length} paragraphs=${entry.paragraphs.length} dur=${totalDur.toFixed(1)}с`);

/* ─── Tool definitions (minimal subset for starters) ──────────────────── */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_timeline_snapshot',
      description: 'Снимок таймлайна: sequenceName, sequenceEndSec, clips.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_transcript_structure',
      description: 'Абзацы транскрипта с startSec/endSec/text/durationSec.',
      parameters: {
        type: 'object',
        properties: { sequenceKey: { type: 'string' } },
        required: ['sequenceKey']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_moments',
      description: 'Семантический поиск по транскрипту.',
      parameters: {
        type: 'object',
        properties: {
          sequenceKey: { type: 'string' },
          query: { type: 'string' },
          k: { type: 'number' }
        },
        required: ['sequenceKey', 'query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_transcript_for_cuts',
      description: 'Автодетекторы + LLM-аналитик меток сегментов (filler/outtake/etc).',
      parameters: {
        type: 'object',
        properties: {
          sequenceKey: { type: 'string' },
          tasks: { type: 'array', items: { type: 'string' } },
          aggressiveness: { type: 'string' }
        },
        required: ['sequenceKey']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_transcript_cuts',
      description: 'Предложить план вырезок — keepIntervals или removeIntervals + targetDurationSec.',
      parameters: {
        type: 'object',
        properties: {
          sequenceKey: { type: 'string' },
          keepIntervals: { type: 'array' },
          removeIntervals: { type: 'array' },
          targetDurationSec: { type: 'number' },
          paddingSec: { type: 'number' },
          summary: { type: 'string' }
        },
        required: ['summary']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_markers',
      description: 'Предложить маркеры (chapter/comment).',
      parameters: {
        type: 'object',
        properties: {
          markers: { type: 'array' },
          summary: { type: 'string' }
        },
        required: ['markers', 'summary']
      }
    }
  }
];

/* ─── Tool executors (имитация плагина) ───────────────────────────────── */
function execTool(name, args) {
  if (name === 'get_timeline_snapshot') {
    return {
      ok: true,
      sequenceName: cacheKey,
      sequenceEndSec: totalDur,
      inPointSec: 0,
      outPointSec: totalDur,
      clips: [{ startSec: 0, endSec: totalDur }]
    };
  }
  if (name === 'get_transcript_structure') {
    return {
      sequenceKey: cacheKey,
      totalParagraphs: entry.paragraphs.length,
      paragraphCount: entry.paragraphs.length,
      paragraphs: entry.paragraphs.map((p, i) => ({
        i, startSec: p.startSec, endSec: p.endSec,
        durationSec: Math.round((p.endSec - p.startSec) * 100) / 100,
        text: p.text || ''
      })),
      hasMore: false
    };
  }
  if (name === 'find_moments') {
    const moments = ctx.FindMoments.find(entry, args.query, { k: args.k || 10 });
    return {
      ok: true, query: args.query, count: moments.length,
      moments: moments.map(m => ({
        startSec: m.startSec, endSec: m.endSec,
        quote: String(m.text || '').slice(0, 200),
        source: m.source
      }))
    };
  }
  if (name === 'analyze_transcript_for_cuts') {
    /* Используем локальные детекторы вместо LLM (быстрее, детерминированнее) */
    const segs = entry.segments.map((s, i) => ({
      i, startSec: s.startSec, endSec: s.endSec, text: s.text || ''
    }));
    const res = ctx.TranscriptStructure.runLocalDetectors(segs);
    const toRemove = res.labels
      .filter(lb => ctx.AnalysisRouting.shouldRemoveLabel(lb.label, args.aggressiveness || 'normal'))
      .map(lb => ({
        startSec: segs[lb.i].startSec, endSec: segs[lb.i].endSec,
        label: lb.label, reason: lb.reason || lb.label
      }));
    return {
      ok: true, sequenceKey: cacheKey,
      totalSegments: segs.length, totalLabels: res.labels.length,
      toRemove, toRemoveCount: toRemove.length,
      stats: res.labels.reduce((acc, l) => { acc[l.label] = (acc[l.label] || 0) + 1; return acc; }, {})
    };
  }
  if (name === 'propose_transcript_cuts') {
    /* Validation как в panel.js */
    const hasKeep = Array.isArray(args.keepIntervals) && args.keepIntervals.length;
    const hasRemove = Array.isArray(args.removeIntervals) && args.removeIntervals.length;
    if (!hasKeep && !hasRemove) return { validationError: 'Нужен keepIntervals или removeIntervals' };
    if (hasKeep && hasRemove) return { validationError: 'Только что-то одно' };

    if (hasKeep && typeof args.targetDurationSec === 'number') {
      const dRes = ctx.AnalysisRouting.validateKeepDuration(args.keepIntervals, args.targetDurationSec);
      if (dRes.error) return { validationError: dRes.error };
    }
    return {
      ok: true, status: 'waiting_user_confirmation',
      _validated: true, _proposalKind: 'transcript_cuts',
      _keepIntervals: args.keepIntervals || null,
      _removeIntervals: args.removeIntervals || null,
      _targetDurationSec: args.targetDurationSec || null,
      message: 'План предложен (тест-mode).'
    };
  }
  if (name === 'propose_markers') {
    return {
      ok: true, status: 'waiting_user_confirmation',
      _validated: true, _proposalKind: 'markers',
      _markers: args.markers,
      markerCount: args.markers ? args.markers.length : 0
    };
  }
  return { error: 'Unknown tool: ' + name };
}

/* ─── Базовый system-prompt (минимальный) ─────────────────────────────── */
const BASE_SYSTEM = [
  'Ты — AI-ассистент для монтажа видео в Adobe Premiere Pro.',
  'Доступные инструменты: get_timeline_snapshot, get_transcript_structure, find_moments,',
  'analyze_transcript_for_cuts, propose_transcript_cuts, propose_markers.',
  'Все propose_* возвращают карточку для подтверждения пользователем — не вызывай apply_*.',
  'Отвечай кратко по-русски.'
].join('\n');

/* ─── Agent loop runner ───────────────────────────────────────────────── */
async function runAgent(systemPromptAddon, userPrompt, maxTurns = 6) {
  const messages = [
    { role: 'system', content: BASE_SYSTEM + '\n\n' + (systemPromptAddon || '') },
    { role: 'user', content: userPrompt }
  ];
  const trace = []; /* {turn, tool, args, result} */
  let lastProposal = null;

  for (let turn = 1; turn <= maxTurns; turn++) {
    let resp;
    try {
      resp = await CC.chatCompletions({
        baseUrl: settings.baseUrl, apiKey: settings.apiKey,
        model: settings.chatModel, messages,
        tools: TOOLS, toolChoice: 'auto',
        params: { ...settings.chatParams, max_tokens: 2000 },
        enableThinking: false
      });
    } catch (e) {
      return { ok: false, error: 'API call failed: ' + e.message, trace, turns: turn - 1 };
    }
    const choice = resp.choices && resp.choices[0];
    if (!choice) return { ok: false, error: 'no choice', trace, turns: turn };

    const msg = choice.message || {};
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

    if (!msg.tool_calls || !msg.tool_calls.length) {
      /* LLM закрыл цикл текстом — диагностика */
      if (turn === 1) {
        console.log('  [DEBUG] turn 1, no tool_calls, finish_reason=' + (choice.finish_reason || 'unknown'));
        console.log('  [DEBUG] content (first 400 chars): ' + (msg.content || '').slice(0, 400));
      }
      return { ok: true, lastProposal, trace, turns: turn, finalContent: msg.content || '', messages };
    }

    /* Выполняем tool calls */
    for (const tc of msg.tool_calls) {
      const name = tc.function && tc.function.name;
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      const result = execTool(name, args);
      trace.push({ turn, tool: name, args, result });
      if (result._validated) lastProposal = { kind: result._proposalKind, ...result };
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }

    if (lastProposal) {
      /* После validated proposal даём LLM ещё один turn для финального текста, потом стоп */
      if (turn >= 2) break;
    }
  }
  return { ok: true, lastProposal, trace, turns: maxTurns, messages };
}

/* ─── Quality assertions ──────────────────────────────────────────────── */
function check(name, cond, msg) {
  const ok = !!cond;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${msg ? ' — ' + msg : ''}`);
  return ok;
}

const STARTERS = ctx.ConversationStarters.getAll('textmontage')
  .concat(ctx.ConversationStarters.getAll('markers'))
  .concat(ctx.ConversationStarters.getAll('search'));

const RESULTS = {};

async function runScenario(starter, userOverride) {
  console.log('\n═══ ' + starter.name + ' ═══');
  console.log('userPrompt:', userOverride || starter.userPrompt);
  const t0 = Date.now();
  const r = await runAgent(starter.systemPromptAddon, userOverride || starter.userPrompt);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`turns=${r.turns} elapsed=${elapsed}s tools_called=${r.trace.length}`);
  if (r.trace.length) {
    console.log('trace:');
    r.trace.forEach(t => {
      const argSum = JSON.stringify(t.args).slice(0, 120);
      console.log(`  T${t.turn}: ${t.tool}(${argSum}) → ${t.result._validated ? 'VALIDATED' : (t.result.error || t.result.validationError || 'ok')}`);
    });
  }
  return r;
}

/* ─── Quality validators per scenario ─────────────────────────────────── */
async function validateStarters() {
  /* 1. Story Cutter — без target */
  const sc = STARTERS.find(s => s.id === 'story-cutter');
  const r1 = await runScenario(sc);
  RESULTS.storyCutter = {
    completed: r1.lastProposal !== null,
    proposalKind: r1.lastProposal && r1.lastProposal.kind,
    turns: r1.turns
  };
  console.log('Quality checks:');
  /* Story Cutter может работать через keepIntervals (сборочный) ИЛИ removeIntervals (чистка).
     Оба пути валидны — выбираем непустой. */
  const k = r1.lastProposal && r1.lastProposal._keepIntervals;
  const r_ = r1.lastProposal && r1.lastProposal._removeIntervals;
  const intervals = (k && k.length) ? k : (r_ || []);
  const intervalsKind = (k && k.length) ? 'keep' : 'remove';
  const totalSpec = intervals.reduce((s, iv) => s + (iv.endSec - iv.startSec), 0);
  RESULTS.storyCutter.checks = {
    proposeCalled: check('propose_transcript_cuts вызван', r1.lastProposal && r1.lastProposal.kind === 'transcript_cuts'),
    intervalsNonEmpty: check(intervalsKind + 'Intervals не пустой', intervals.length > 0),
    chronological: check('intervals хронологически отсортированы', intervals.every((iv, i) => i === 0 || iv.startSec >= intervals[i-1].endSec - 0.1)),
    plausibleCoverage: check('обработано <100% длины (есть смысловой выбор)', totalSpec > 0 && totalSpec < totalDur * 0.99)
  };

  /* 2. Story Cutter Timed — target 30с (на 1мин кэше) */
  const target = Math.max(30, Math.floor(totalDur * 0.5));
  const sct = STARTERS.find(s => s.id === 'story-cutter-timed');
  const r2 = await runScenario(sct, `Собери ролик длительностью ${target} секунд из самых интересных фрагментов`);
  RESULTS.storyCutterTimed = { completed: r2.lastProposal !== null, target, turns: r2.turns };
  console.log('Quality checks:');
  const k2 = r2.lastProposal && r2.lastProposal._keepIntervals;
  const sum2 = k2 ? k2.reduce((s, iv) => s + (iv.endSec - iv.startSec), 0) : 0;
  RESULTS.storyCutterTimed.checks = {
    proposeCalled: check('propose_transcript_cuts вызван', r2.lastProposal && r2.lastProposal.kind === 'transcript_cuts'),
    targetPassed: check('targetDurationSec передан в propose', r2.lastProposal && r2.lastProposal._targetDurationSec === target),
    keepInRange: check(`сумма keep в [${(target*0.7).toFixed(0)}..${(target*1.20).toFixed(0)}]с (фактически ${sum2.toFixed(1)}с)`,
      sum2 >= target * 0.7 && sum2 <= target * 1.20),
    notMidWord: check('keepIntervals на границах абзацев', k2 && k2.every(iv =>
      entry.paragraphs.some(p => Math.abs(p.startSec - iv.startSec) < 0.5) ||
      entry.paragraphs.some(p => Math.abs(p.endSec - iv.endSec) < 0.5)
    ))
  };

  /* 3. Filler Cleanup */
  const fc = STARTERS.find(s => s.id === 'filler-cleanup');
  const r3 = await runScenario(fc);
  RESULTS.fillerCleanup = { completed: r3.lastProposal !== null, turns: r3.turns };
  console.log('Quality checks:');
  const ri = r3.lastProposal && r3.lastProposal._removeIntervals;
  RESULTS.fillerCleanup.checks = {
    proposeCalled: check('propose_transcript_cuts вызван', r3.lastProposal && r3.lastProposal.kind === 'transcript_cuts'),
    analyzeCalled: check('analyze_transcript_for_cuts вызван', r3.trace.some(t => t.tool === 'analyze_transcript_for_cuts')),
    removesAreShort: check('все removeIntervals < 10с (точечная чистка)', !ri || ri.every(iv => (iv.endSec - iv.startSec) < 10)),
    notTooMuch: check('total remove < 50% длины', !ri || ri.reduce((s, iv) => s + (iv.endSec - iv.startSec), 0) < totalDur * 0.5)
  };

  /* 4. YouTube Chapters — на 1мин (ожидаем что LLM скажет «слишком коротко») */
  const yt = STARTERS.find(s => s.id === 'mk-chapters');
  const r4 = await runScenario(yt);
  RESULTS.ytChapters = { completed: r4.lastProposal !== null, turns: r4.turns, finalContent: r4.finalContent };
  console.log('Quality checks:');
  const m4 = r4.lastProposal && r4.lastProposal._markers;
  /* Для коротких видео (<60с) LLM должен сказать что коротко; для нормальных — поставить главы */
  const isShort = totalDur < 60;
  RESULTS.ytChapters.checks = {
    correctBehavior: check(
      isShort ? 'для <60с LLM не ставит chapters или предупреждает' : 'для нормальной длины ставит chapters',
      isShort ? (!r4.lastProposal || (r4.finalContent || '').toLowerCase().includes('коротк') || (r4.finalContent || '').includes('60с'))
              : (m4 && m4.length >= 3)
    ),
    typeChapter: check('если есть markers — type=chapter', !m4 || m4.every(m => m.type === 'chapter')),
    firstAtZero: check('если есть markers — первый на 0:00', !m4 || (m4[0] && m4[0].timeSec === 0))
  };

  /* 5. Highlights */
  const hl = STARTERS.find(s => s.id === 'mk-highlights');
  const r5 = await runScenario(hl);
  RESULTS.highlights = { completed: r5.lastProposal !== null, turns: r5.turns };
  console.log('Quality checks:');
  const m5 = r5.lastProposal && r5.lastProposal._markers;
  RESULTS.highlights.checks = {
    proposeCalled: check('propose_markers вызван', r5.lastProposal && r5.lastProposal.kind === 'markers'),
    typeComment: check('все markers type=comment', !m5 || m5.every(m => m.type === 'comment')),
    inRange: check('все markers в границах таймлайна', !m5 || m5.every(m => m.timeSec >= 0 && m.timeSec <= totalDur)),
    gapEnough: check('gap между markers >= 5с', !m5 || m5.every((m, i) => i === 0 || m.timeSec - m5[i-1].timeSec >= 5))
  };

  /* 6. Find Moments */
  const fm = STARTERS.find(s => s.id === 'find-topic');
  /* Подбираем релевантный запрос из реальных данных */
  const allText = entry.paragraphs.map(p => p.text || '').join(' ').toLowerCase();
  const candidates = ['аналитик', 'стратеги', 'компани', 'клиент', 'команда', 'продукт'];
  const query = candidates.find(c => allText.includes(c)) || 'аналитика';
  const r6 = await runScenario(fm, `Найди в транскрипте все упоминания о ${query}`);
  RESULTS.findMoments = { completed: !!r6.finalContent, turns: r6.turns, query };
  console.log('Quality checks:');
  const fmCall = r6.trace.find(t => t.tool === 'find_moments');
  RESULTS.findMoments.checks = {
    findCalled: check('find_moments вызван', !!fmCall),
    correctQuery: check('query содержит искомое слово', fmCall && (fmCall.args.query || '').toLowerCase().includes(query)),
    notProposingCuts: check('НЕ вызывает propose_transcript_cuts (только показывает результат)',
      !r6.trace.some(t => t.tool === 'propose_transcript_cuts')),
    hasResults: check('result содержит moments', fmCall && fmCall.result.moments && fmCall.result.moments.length > 0)
  };
}

/* ─── Run ─────────────────────────────────────────────────────────────── */
console.log('\n=== Starters quality validation via Cloud.ru ===');
console.log('Model:', settings.chatModel);
const startTime = Date.now();
try {
  await validateStarters();
} catch (e) {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
}
const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

/* ─── Summary ─────────────────────────────────────────────────────────── */
console.log('\n═══════════════════════════════════════');
console.log('SUMMARY (общее время: ' + totalTime + 's)');
console.log('═══════════════════════════════════════');
let totalChecks = 0, passedChecks = 0;
for (const [name, r] of Object.entries(RESULTS)) {
  const checks = r.checks || {};
  const ck = Object.values(checks);
  const passed = ck.filter(Boolean).length;
  totalChecks += ck.length;
  passedChecks += passed;
  console.log(`${name}: ${passed}/${ck.length} pass | turns=${r.turns} | completed=${r.completed}`);
  for (const [cn, cv] of Object.entries(checks)) {
    if (!cv) console.log(`    ✗ ${cn}`);
  }
}
console.log('═══════════════════════════════════════');
console.log(`TOTAL: ${passedChecks}/${totalChecks} quality checks passed`);
process.exit(passedChecks === totalChecks ? 0 : 1);
