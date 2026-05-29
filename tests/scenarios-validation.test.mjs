/**
 * scenarios-validation.test.mjs (7 мая 2026)
 *
 * Валидация быстрых сценариев на реальном транскрипт-кэше.
 *
 * Идея: для каждого стартера эмулируем «правильный» ответ LLM (цепочку tool-calls),
 * прогоняем через те же executors что и панель, проверяем что:
 *   - формат данных корректный
 *   - validators (ToolValidators, validateKeepDuration, validateForYouTube) проходят
 *   - результат не пустой / соответствует ожиданиям
 *
 * Если сценарий fail'ит — он НЕ добавляется в conversation-starters.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadAnalysisRouting } from './load-analysis-routing.mjs';
import { loadTranscriptStructure } from './load-transcript-structure.mjs';
import { loadFindMoments } from './load-find-moments.mjs';
import { loadToolValidators } from './load-tool-validators.mjs';

const AR = loadAnalysisRouting();
const TS = loadTranscriptStructure();
const FM = loadFindMoments();
const TV = loadToolValidators();

/* YouTubeExport грузим напрямую через vm. */
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadYouTubeExport() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'client', 'shared', 'youtube-export.js'),
    'utf8'
  );
  const root = {};
  /* youtube-export.js: если есть module.exports — экспорт идёт туда (Node-режим);
     если нет — на global. Чтобы получить через root.window, передаём global=root
     и НЕ передаём module → IIFE attaches to global.YouTubeExport. */
  vm.runInNewContext(src, { window: root, global: root, console });
  return root.YouTubeExport;
}
const YT = loadYouTubeExport();

/* ─── Реальный кэш транскрипта ───────────────────────────────────────── */
const CACHE_PATH = path.join(os.homedir(), '.extensions_llm_chat_pr', '_llm_transcript_cache.json');
let cacheEntry = null;
let cacheKey = null;
try {
  const raw = fs.readFileSync(CACHE_PATH, 'utf8');
  const data = JSON.parse(raw);
  const keys = Object.keys(data);
  if (keys.length) {
    cacheKey = keys[0];
    cacheEntry = data[keys[0]];
  }
} catch (e) {
  /* Если кэша нет — fallback на синтетику. */
}

/**
 * 7 мая 2026: ролики разной длительности — стартеры должны работать на всех.
 * Генерируем синтетические entry: short (~1мин), medium (~10мин), long (~1ч).
 */
function _genTexts(n) {
  const phrases = [
    'Всем привет, меня зовут Андрей и я расскажу про стратегию.',
    'Ну, ээ, в общем, мы занимаемся аналитикой.',
    'Мы формируем планы на следующий год.',
    'С точки зрения внешней аналитики мы исследуем рынок.',
    'А внутренняя аналитика измеряет процессы в компании.',
    'Подписывайтесь на канал, ставьте лайк.',
    'Мы будем рады, приходите к нам.',
    'Главный аргумент — это работа с данными в реальном времени.',
    'Цифры показывают рост на тридцать процентов.',
    'Команда разработки выросла за два года.'
  ];
  const out = [];
  for (let i = 0; i < n; i++) out.push(phrases[i % phrases.length]);
  return out;
}
function buildSyntheticEntry(targetDur) {
  const phrases = _genTexts(Math.max(7, Math.ceil(targetDur / 8)));
  const segments = [];
  let t = 0;
  for (let i = 0; i < phrases.length && t < targetDur; i++) {
    const len = 6 + (i % 4) + Math.random() * 4;
    const e = Math.min(targetDur, t + len);
    segments.push({ startSec: t, endSec: e, text: phrases[i] });
    /* случайные мини-паузы для buildParagraphs */
    t = e + (i % 3 === 0 ? 0.6 : 0.05);
  }
  const entry = { segments, paragraphs: [], audioAnalysis: { silences: [] } };
  TS.buildStructure(entry, { pauseThresholdSec: 0.5 });
  return entry;
}

/* Реальный кэш + синтетические разной длины. Каждый сценарий гоняем по всем. */
const FIXTURES = [];
if (cacheEntry) FIXTURES.push({ name: 'real-cache', entry: cacheEntry });
FIXTURES.push({ name: 'short-1min', entry: buildSyntheticEntry(60) });
FIXTURES.push({ name: 'medium-10min', entry: buildSyntheticEntry(600) });
FIXTURES.push({ name: 'long-1h', entry: buildSyntheticEntry(3600) });

/* Берём максимум из segments + paragraphs — на реальном кэше после ripple_delete
   segments могут быть короче чем paragraphs (stale), это валидный edge case. */
function _maxEnd(arr) {
  let m = 0;
  for (const x of arr || []) {
    const e = typeof x.endSec === 'number' ? x.endSec : (x.end || 0);
    if (e > m) m = e;
  }
  return m;
}

/* Реальный кэш используем как основной entry только если он содержательный.
   Smoke-кэш после install-теста бывает 1 абзац на ~8с — на нём структурные сценарии
   («выбери каждый 2-й абзац», «уложи в 50%») вырожденны: нечего удалять / ничего не влезает.
   Реальный кэш всё равно прогоняется в общем цикле по FIXTURES ниже. */
function _isRichEntry(e) {
  return !!e && Array.isArray(e.paragraphs) && e.paragraphs.length >= 4
    && Math.max(_maxEnd(e.segments), _maxEnd(e.paragraphs)) >= 60;
}
const entry = _isRichEntry(cacheEntry) ? cacheEntry : buildSyntheticEntry(600);
const totalDur = Math.max(_maxEnd(entry.segments), _maxEnd(entry.paragraphs)) || 60;

describe('Scenario validation: real transcript cache', () => {
  test('cache загружен (или synthetic fallback)', () => {
    assert.ok(entry, 'нет ни кэша ни synthetic');
    assert.ok(Array.isArray(entry.segments) && entry.segments.length > 0);
    assert.ok(Array.isArray(entry.paragraphs) && entry.paragraphs.length > 0);
  });
});

/* ───────────────────────────────────────────────────────────────────────
 * SCENARIO 1: Story Cutter — собирает black-box keepIntervals из абзацев
 * ─────────────────────────────────────────────────────────────────────── */
describe('Scenario: Story Cutter (semantic montage)', () => {
  test('LLM выбирает топ-N абзацев → invertKeepToRemove → validation', () => {
    /* Эмулируем что LLM выбрал каждый второй абзац */
    const keepIntervals = entry.paragraphs
      .filter((_, i) => i % 2 === 0)
      .map(p => ({ startSec: p.startSec, endSec: p.endSec, reason: 'value' }));
    assert.ok(keepIntervals.length >= 1, 'выбрано хотя бы 1 параграф');

    const inv = AR.invertKeepToRemove(keepIntervals, {
      minSec: 0,
      maxSec: totalDur,
      segments: entry.segments
    });
    assert.ok(inv.removeIntervals, 'invertKeepToRemove не упал: ' + JSON.stringify(inv));
    assert.ok(inv.removeIntervals.length >= 1, 'removeIntervals не пустой');

    /* Все интервалы валидны */
    inv.removeIntervals.forEach(iv => {
      assert.ok(iv.endSec > iv.startSec, 'interval ' + iv.startSec + '-' + iv.endSec + ' валиден');
      assert.ok(iv.startSec >= 0);
      assert.ok(iv.endSec <= totalDur + 0.05);
    });
  });
});

/* ───────────────────────────────────────────────────────────────────────
 * SCENARIO 2: Story Cutter Timed — «уложи в N секунд»
 * ─────────────────────────────────────────────────────────────────────── */
describe('Scenario: Story Cutter Timed (target duration)', () => {
  const targetSec = Math.floor(totalDur * 0.5);

  test('LLM правильно уложился в target → validation passes', () => {
    /* Берём первые параграфы пока сумма ≤ target */
    const keepIntervals = [];
    let sum = 0;
    for (const p of entry.paragraphs) {
      const d = p.endSec - p.startSec;
      if (sum + d > targetSec) break;
      keepIntervals.push({ startSec: p.startSec, endSec: p.endSec, reason: 'in target' });
      sum += d;
    }
    assert.ok(keepIntervals.length >= 1, 'хотя бы 1 параграф уместился');

    const dRes = AR.validateKeepDuration(keepIntervals, targetSec);
    assert.equal(dRes.ok, true, 'валидация прошла: ' + JSON.stringify(dRes));
    assert.ok(dRes.keepSumSec <= targetSec * 1.20);
  });

  test('LLM перебрал хронометраж → validation возвращает actionable error', () => {
    /* Эмулируем баг: LLM выбрал ВСЕ параграфы при target=20% от total */
    const keepIntervals = entry.paragraphs.map(p => ({
      startSec: p.startSec, endSec: p.endSec, reason: 'overshoot'
    }));
    const tinyTarget = Math.max(5, Math.floor(totalDur * 0.2));
    const dRes = AR.validateKeepDuration(keepIntervals, tinyTarget);
    assert.ok(dRes.error, 'overshoot → error');
    assert.ok(dRes.overshootPct > 20);
    /* Сообщение содержит численные подсказки для LLM-pivot */
    assert.match(dRes.error, /Сумма keepIntervals/);
    assert.match(dRes.error, /Сократи выбор/);
    assert.match(dRes.error, new RegExp(String(tinyTarget) + 'с'));
  });
});

/* ───────────────────────────────────────────────────────────────────────
 * SCENARIO 3: Filler Cleanup — analyze_transcript_for_cuts
 * ─────────────────────────────────────────────────────────────────────── */
describe('Scenario: Filler Cleanup (paraziti, паузы, оговорки)', () => {
  test('runLocalDetectors находит fillers без LLM (для синтетики)', () => {
    /* Локальные детекторы — словарные fillers/intro/artifacts */
    const segs = entry.segments.map((s, i) => ({
      i, startSec: s.startSec, endSec: s.endSec, text: s.text || ''
    }));
    const res = TS.runLocalDetectors(segs);
    assert.ok(Array.isArray(res.labels), 'labels массив');
    /* На реальном кэше кол-во маркируемых может быть 0 (чистая речь) — это ок,
       главное чтобы функция не упала и формат был корректным. */
    res.labels.forEach(lb => {
      assert.equal(typeof lb.i, 'number');
      assert.ok(['filler', 'artifact', 'intro', 'outro', 'outtake', 'repeat', 'digression', 'content']
        .includes(lb.label));
    });
  });

  test('Если детекторы нашли labels → собираем removeIntervals и валидируем', () => {
    const segs = entry.segments.map((s, i) => ({
      i, startSec: s.startSec, endSec: s.endSec, text: s.text || ''
    }));
    const res = TS.runLocalDetectors(segs);
    /* Берём все «to remove» лейблы и формируем интервалы */
    const removeIntervals = res.labels
      .filter(lb => AR.shouldRemoveLabel(lb.label, 'normal'))
      .map(lb => ({
        startSec: segs[lb.i].startSec,
        endSec: segs[lb.i].endSec,
        reason: lb.label
      }));
    /* Если ничего не помечено — это допустимый случай (чистая речь). */
    if (removeIntervals.length === 0) return;

    const snap = {
      ok: true,
      sequenceName: cacheKey || 'test',
      sequenceEndSec: totalDur,
      inPointSec: 0,
      outPointSec: totalDur,
      clips: [{ startSec: 0, endSec: totalDur }]
    };
    const v = TV.validateTranscriptCuts(snap, { removeIntervals });
    assert.ok(!v || !v.error, 'validateTranscriptCuts: ' + (v && v.error));
  });
});

/* ───────────────────────────────────────────────────────────────────────
 * SCENARIO 4: YouTube Chapters — propose_markers
 * ─────────────────────────────────────────────────────────────────────── */
describe('Scenario: YouTube Chapters (propose_markers)', () => {
  test('LLM создаёт маркеры по абзацам → validateForYouTube', () => {
    /* Эмулируем: первый параграф = 0:00 «Вступление», далее темы по сменам */
    const markers = entry.paragraphs.slice(0, 4).map((p, i) => ({
      timeSec: i === 0 ? 0 : p.startSec,
      name: 'Глава ' + (i + 1),
      type: 'chapter'
    }));
    /* На коротком кэше может быть < 3 параграфов — это норма, сценарий тогда
       вернёт warning, и это допустимое поведение для validateForYouTube. */
    const warns = YT.validateForYouTube(markers);
    assert.ok(Array.isArray(warns));
    /* Если markers ≥ 3 + первый на 0 + ≥10с между → warns пустой */
    if (markers.length >= 3 &&
        markers[0].timeSec === 0 &&
        markers.every((m, i) => i === 0 || (m.timeSec - markers[i-1].timeSec) >= 10)) {
      assert.equal(warns.length, 0, 'правильные маркеры → 0 warnings: ' + warns.join(' | '));
    }
  });

  test('Формат для YouTube-описания корректный (M:SS Название)', () => {
    const markers = [
      { timeSec: 0, name: 'Вступление', type: 'chapter' },
      { timeSec: 30, name: 'Основная мысль', type: 'chapter' },
      { timeSec: 60, name: 'Вывод', type: 'chapter' }
    ];
    const text = YT.formatChaptersForYouTube(markers);
    const lines = text.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^0:00 Вступление$/);
    assert.match(lines[1], /^0:30/);
    assert.match(lines[2], /^1:00/);
  });
});

/* ───────────────────────────────────────────────────────────────────────
 * SCENARIO 5: Highlights — comment-маркеры на ярких моментах
 * ─────────────────────────────────────────────────────────────────────── */
describe('Scenario: Highlights (comment markers)', () => {
  test('LLM ставит comment-маркеры на эмоциональных пиках', () => {
    /* Эмулируем выбор каждого 3-го параграфа как «highlight» */
    const markers = entry.paragraphs
      .filter((_, i) => i % 3 === 0)
      .map(p => ({
        timeSec: (p.startSec + p.endSec) / 2,
        name: 'Хайлайт',
        type: 'comment',
        comment: (p.text || '').slice(0, 60)
      }));
    assert.ok(markers.length >= 1, 'хотя бы 1 highlight');
    /* Все timeSec уникальные и валидные */
    markers.forEach(m => {
      assert.equal(typeof m.timeSec, 'number');
      assert.ok(m.timeSec >= 0);
      assert.ok(m.timeSec <= totalDur);
      assert.equal(m.type, 'comment');
    });
    /* Между маркерами достаточный gap (не дублируем) */
    for (let i = 1; i < markers.length; i++) {
      assert.ok(markers[i].timeSec - markers[i-1].timeSec >= 2,
        'gap >= 2с между highlight #' + (i-1) + ' и #' + i);
    }
  });
});

/* ───────────────────────────────────────────────────────────────────────
 * SCENARIO 6: Find Moments — семантический поиск
 * ─────────────────────────────────────────────────────────────────────── */
/* ───────────────────────────────────────────────────────────────────────
 * SCENARIO 7: Multi-length validation — каждый сценарий по 4 фикстурам
 * (real cache + 1мин, 10мин, 1ч synthetic). Гарантирует что стартеры
 * работают на роликах любой длины.
 * ─────────────────────────────────────────────────────────────────────── */
describe('Multi-length validation: starters work on any video duration', () => {
  for (const fix of FIXTURES) {
    const e = fix.entry;
    const dur = Math.max(_maxEnd(e.segments), _maxEnd(e.paragraphs)) || 60;

    test(fix.name + ': Story Cutter Timed работает на target = 30% от длины', () => {
      const target = Math.max(10, Math.floor(dur * 0.3));
      /* Берём первые параграфы пока сумма ≤ target */
      const keep = [];
      let s = 0;
      for (const p of e.paragraphs) {
        const d = p.endSec - p.startSec;
        if (s + d > target) break;
        keep.push({ startSec: p.startSec, endSec: p.endSec });
        s += d;
      }
      if (keep.length === 0) {
        /* Очень длинные параграфы при коротком target — допустимо взять 1 урезанный.
           В реальности LLM получит validationError и пересоберёт. Пропускаем. */
        return;
      }
      const v = AR.validateKeepDuration(keep, target);
      assert.equal(v.ok, true, fix.name + ' validateKeepDuration: ' + JSON.stringify(v));
    });

    test(fix.name + ': YouTube chapters — adaptive chapter count', () => {
      /* Адаптивно: ~1 глава на 2-5 минут.
         <60с → 0 глав (warning норма)
         60с-3мин → 3 главы (минимум YouTube)
         3-15 мин → 5-7 глав
         15+ мин → главы каждые 3 мин */
      let chapterCount;
      if (dur < 60) chapterCount = Math.max(1, Math.floor(dur / 20));
      else if (dur < 180) chapterCount = 3;
      else if (dur < 900) chapterCount = Math.min(7, Math.max(3, Math.floor(dur / 120)));
      else chapterCount = Math.min(20, Math.floor(dur / 180));

      const step = dur / chapterCount;
      const markers = [];
      for (let i = 0; i < chapterCount; i++) {
        markers.push({
          timeSec: i === 0 ? 0 : Math.round(i * step),
          name: 'Глава ' + (i + 1),
          type: 'chapter'
        });
      }
      const warns = YT.validateForYouTube(markers);
      /* На длине ≥60с с adaptive count должно быть валидно */
      if (dur >= 60 && chapterCount >= 3) {
        assert.equal(warns.length, 0, fix.name + ' YT warns: ' + warns.join(' | '));
      }
    });

    test(fix.name + ': Find moments не падает на любом запросе', () => {
      const moments = FM.find(e, 'аналитика стратегия', { k: 5 });
      assert.ok(Array.isArray(moments));
    });

    test(fix.name + ': Story Cutter инверсия не падает', () => {
      /* Берём каждый 2-й параграф */
      const keep = e.paragraphs
        .filter((_, i) => i % 2 === 0)
        .map(p => ({ startSec: p.startSec, endSec: p.endSec }));
      if (keep.length === 0) return;
      const inv = AR.invertKeepToRemove(keep, {
        minSec: 0,
        maxSec: dur,
        segments: e.segments
      });
      /* Может быть error если keep покрывает весь транскрипт — это валидное
         поведение, главное чтобы не упало на NaN/негативных интервалах. */
      assert.ok(inv.removeIntervals || inv.error, fix.name + ' inv: ' + JSON.stringify(inv));
      if (inv.removeIntervals) {
        inv.removeIntervals.forEach(iv => {
          assert.ok(iv.endSec > iv.startSec, fix.name + ' bad interval ' + JSON.stringify(iv));
          assert.ok(iv.startSec >= 0);
          assert.ok(iv.endSec <= dur + 0.5);
        });
      }
    });
  }
});

describe('Scenario: Find Moments (semantic search)', () => {
  test('Поиск по релевантному слову возвращает результаты', () => {
    /* Подбираем query от частых слов в кэше */
    const allText = entry.paragraphs.map(p => p.text || '').join(' ').toLowerCase();
    let query = null;
    /* Кандидаты по частоте — берём первый который попадает */
    const candidates = ['аналитика', 'стратегия', 'компания', 'привет', 'продукт', 'команда', 'тест'];
    for (const c of candidates) {
      if (allText.includes(c)) { query = c; break; }
    }
    if (!query) query = entry.paragraphs[0].text.split(/\s+/)[0] || 'тест';

    const moments = FM.find(entry, query, { k: 5 });
    assert.ok(Array.isArray(moments), 'find возвращает массив');
    /* Если нашлось — структура корректная */
    moments.forEach(m => {
      assert.equal(typeof m.startSec, 'number');
      assert.equal(typeof m.endSec, 'number');
      assert.ok(m.endSec > m.startSec);
      assert.equal(typeof m.text, 'string');
      assert.ok(['paragraphs', 'segments'].includes(m.source));
    });
  });

  test('Поиск по бессмысленной строке не падает', () => {
    const moments = FM.find(entry, 'зззззыыыыхххх', { k: 5 });
    assert.ok(Array.isArray(moments));
    /* Может быть 0 результатов — это ок */
  });

  test('Поиск с пустым query возвращает пустой массив', () => {
    const moments = FM.find(entry, '', { k: 5 });
    assert.ok(Array.isArray(moments));
    assert.equal(moments.length, 0);
  });
});
