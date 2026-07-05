# Монтаж по смыслам v2 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Переработать `propose_montage_plan` так, чтобы семантику keep/cut давал чанкированный воркер (2-я модель), а бюджет/арифметику — детерминированный код; главная модель не держит транскрипт и не авторит план.

**Architecture:** worker `labelMontageBlocks` (чанки) → `calibrateMontageBlocks` (1 вызов, сводка) → `MontagePlan.buildPlanFromLabels` (knapsack под бюджет) → существующий `execProposeTranscriptCuts` → карточка. Спека: `docs/superpowers/specs/2026-07-06-montage-by-meaning-v2-design.md`.

**Tech Stack:** browser-JS ES5 (var/function/IIFE) для client/shared; ExtendScript НЕ трогаем; тесты — node --test через vm-загрузчики.

**Порядок:** Задачи 1→6 строго последовательно (позже зависят от раньше). Каждый subagent НЕ коммитит — коммит делает оркестратор.

---

### Task 1: `MontagePlan.buildPlanFromLabels` — детерминированный сборщик (knapsack)

**Files:**
- Modify: `client/shared/montage-plan.js` (добавить функцию + экспорт)
- Test: `tests/montage-plan-buildplan.test.mjs` (новый)

Контракт входа — массив labeled-абзацев (выход воркера после калибровки):
```js
[{ i:0, blockId:'b0', importance:3, role:'hook', theme:'Завязка', protect:'start' }, ...]
```
`entry` — транскрипт-кэш с `paragraphs[i] = {startSec, endSec, text}` (как в validatePlan).

- [ ] **Step 1: Failing-тест**

Создать `tests/montage-plan-buildplan.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMontagePlan } from './load-montage-plan-module.mjs';

const MP = loadMontagePlan();

/* Хелпер: транскрипт из N абзацев по dur сек каждый */
function mkEntry(durs) {
  let t = 0;
  const paragraphs = durs.map((d, i) => {
    const p = { i, startSec: t, endSec: t + d, text: 'p' + i };
    t += d;
    return p;
  });
  return { paragraphs, topics: [] };
}

test('buildPlanFromLabels: золото в одной секции — keep берёт золото, не пропорцию', () => {
  // 10 абзацев по 60с (итого 600с). Цель 120с (2 блока). Золото — абзацы 7,8.
  const entry = mkEntry(Array(10).fill(60));
  const labeled = entry.paragraphs.map((p, i) => ({
    i, blockId: 'b' + i, importance: (i === 7 || i === 8) ? 3 : 1,
    role: (i === 7 || i === 8) ? 'payoff' : 'filler', theme: 'блок ' + i, protect: null
  }));
  const r = MP.buildPlanFromLabels(labeled, entry, 120);
  const keptIdx = [];
  r.blocks.forEach(b => { if (b.action === 'keep') for (let p = b.paragraphs.from; p <= b.paragraphs.to; p++) keptIdx.push(p); });
  assert.ok(keptIdx.includes(7) && keptIdx.includes(8), 'золото 7,8 должно быть в keep');
  assert.ok(r.stats.keepSec <= 120 * 1.1, 'keep в пределах бюджета +10%');
});

test('buildPlanFromLabels: защита protect start/end всегда в keep', () => {
  const entry = mkEntry(Array(6).fill(30)); // 180с
  const labeled = entry.paragraphs.map((p, i) => ({
    i, blockId: 'b' + i, importance: (i === 0 || i === 5) ? 0 : 2,
    role: 'argument', theme: 't' + i, protect: i === 0 ? 'start' : (i === 5 ? 'end' : null)
  }));
  const r = MP.buildPlanFromLabels(labeled, entry, 60);
  const kept = [];
  r.blocks.forEach(b => { if (b.action === 'keep') for (let p = b.paragraphs.from; p <= b.paragraphs.to; p++) kept.push(p); });
  assert.ok(kept.includes(0), 'start защищён');
  assert.ok(kept.includes(5), 'end защищён');
});

test('buildPlanFromLabels: покрытие — каждый абзац ровно в одном блоке, без дыр', () => {
  const entry = mkEntry(Array(8).fill(20));
  const labeled = entry.paragraphs.map((p, i) => ({
    i, blockId: 'b' + i, importance: i % 2, role: 'argument', theme: 't', protect: null
  }));
  const r = MP.buildPlanFromLabels(labeled, entry, 60);
  const seen = new Set();
  r.blocks.forEach(b => { for (let p = b.paragraphs.from; p <= b.paragraphs.to; p++) { assert.ok(!seen.has(p), 'нет перекрытия'); seen.add(p); } });
  for (let i = 0; i < 8; i++) assert.ok(seen.has(i), 'абзац ' + i + ' покрыт');
});

test('buildPlanFromLabels: cut-reason выводится из role', () => {
  const entry = mkEntry(Array(4).fill(100)); // 400с, цель 100 → 3 в cut
  const labeled = [
    { i:0, blockId:'b0', importance:3, role:'hook', theme:'t', protect:'start' },
    { i:1, blockId:'b1', importance:0, role:'repeat', theme:'t', protect:null },
    { i:2, blockId:'b2', importance:0, role:'filler', theme:'t', protect:null },
    { i:3, blockId:'b3', importance:0, role:'offtopic', theme:'t', protect:null }
  ];
  const r = MP.buildPlanFromLabels(labeled, entry, 100);
  const cuts = r.blocks.filter(b => b.action === 'cut');
  const reasons = cuts.map(c => c.reason).join(' ');
  assert.match(reasons, /повтор/);
  assert.match(reasons, /вода/);
  assert.match(reasons, /офтоп/);
});

test('buildPlanFromLabels: соседние одинаковые action сливаются в один блок', () => {
  const entry = mkEntry(Array(4).fill(50));
  const labeled = entry.paragraphs.map((p, i) => ({
    i, blockId: 'b' + i, importance: i < 2 ? 3 : 0, role: 'argument', theme: 't', protect: null
  }));
  const r = MP.buildPlanFromLabels(labeled, entry, 100);
  // абзацы 0,1 → keep (слиты), 2,3 → cut (слиты)
  assert.equal(r.blocks.length, 2, 'ровно 2 слитых блока');
});
```

- [ ] **Step 2: Запустить — падает**

Run: `node --test tests/montage-plan-buildplan.test.mjs`
Expected: FAIL «buildPlanFromLabels is not a function».

- [ ] **Step 3: Реализация в `montage-plan.js`**

Добавить ПЕРЕД строкой `global.MontagePlan = {`:
```js
  // ──────────────────────────────────────────────────────────
  // buildPlanFromLabels(labeled, entry, targetSec) → {blocks, stats}
  // Детерминированный knapsack: свернуть в блоки → отобрать под бюджет →
  // собрать keep/cut blocks в формате validatePlan (соседние сливаются).
  // ──────────────────────────────────────────────────────────
  function _roleToReason(role) {
    if (role === 'repeat') return 'повтор';
    if (role === 'filler') return 'вода';
    if (role === 'offtopic') return 'офтоп';
    return 'слабый кусок';
  }

  function buildPlanFromLabels(labeled, entry, targetSec) {
    var paras = (entry && entry.paragraphs) || [];
    var P = paras.length;
    var stats = { keptBlocks: 0, cutBlocks: 0, keepSec: 0, cutSec: 0 };
    if (!P || !labeled || !labeled.length) {
      return { blocks: [], stats: stats };
    }

    /* 1. Индексируем метку по абзацу; недостающим — importance 1, role argument */
    var byIdx = [];
    for (var li = 0; li < labeled.length; li++) {
      var L = labeled[li];
      if (typeof L.i === 'number' && L.i >= 0 && L.i < P) byIdx[L.i] = L;
    }
    for (var pi = 0; pi < P; pi++) {
      if (!byIdx[pi]) byIdx[pi] = { i: pi, blockId: 'auto' + pi, importance: 1, role: 'argument', theme: '', protect: null };
    }

    /* 2. Сворачиваем по смежным одинаковым blockId в группы */
    var groups = [];
    var cur = null;
    for (var g = 0; g < P; g++) {
      var lab = byIdx[g];
      var dur = paras[g].endSec - paras[g].startSec;
      if (cur && cur.blockId === lab.blockId) {
        cur.to = g; cur.dur += dur;
        if (lab.importance > cur.importance) cur.importance = lab.importance;
        if (lab.protect) cur.protect = lab.protect;
      } else {
        cur = { blockId: lab.blockId, from: g, to: g, dur: dur,
                importance: lab.importance || 0, role: lab.role || 'argument',
                theme: lab.theme || '', protect: lab.protect || null };
        groups.push(cur);
      }
    }

    /* 3. Отбор: protect start/end → keep всегда; затем по importance убыв.,
       tie-break по from (стабильно). Добираем пока keepSec+dur ≤ target. */
    var order = groups.slice().sort(function (a, b) {
      var pa = a.protect ? 1 : 0, pb = b.protect ? 1 : 0;
      if (pa !== pb) return pb - pa;
      if (b.importance !== a.importance) return b.importance - a.importance;
      return a.from - b.from;
    });
    var keepSec = 0;
    for (var oi = 0; oi < order.length; oi++) {
      var grp = order[oi];
      if (grp.protect || keepSec + grp.dur <= targetSec) {
        grp._keep = true; keepSec += grp.dur;
      } else {
        grp._keep = false;
      }
    }

    /* 4. Собираем blocks в хронологическом порядке, сливая соседние одинаковые action */
    var blocks = [];
    var pending = null;
    for (var gi = 0; gi < groups.length; gi++) {
      var gg = groups[gi];
      var action = gg._keep ? 'keep' : 'cut';
      if (pending && pending.action === action) {
        pending.paragraphs.to = gg.to;
        if (action === 'keep' && gg.theme && !pending.theme) pending.theme = gg.theme;
      } else {
        pending = { action: action, paragraphs: { from: gg.from, to: gg.to } };
        if (action === 'keep') pending.theme = gg.theme || 'Ключевой фрагмент';
        else pending.reason = _roleToReason(gg.role);
        blocks.push(pending);
      }
    }

    /* 5. stats */
    for (var bi = 0; bi < blocks.length; bi++) {
      var blk = blocks[bi], d = 0;
      for (var p2 = blk.paragraphs.from; p2 <= blk.paragraphs.to; p2++) d += paras[p2].endSec - paras[p2].startSec;
      if (blk.action === 'keep') { stats.keepSec += d; stats.keptBlocks++; }
      else { stats.cutSec += d; stats.cutBlocks++; }
    }
    return { blocks: blocks, stats: stats };
  }
```
И в экспорт `global.MontagePlan = { ... }` добавить `buildPlanFromLabels: buildPlanFromLabels,`.

- [ ] **Step 4: Тесты зелёные**

Run: `node --test tests/montage-plan-buildplan.test.mjs`
Expected: PASS (5/5).

- [ ] **Step 5: Регрессия**

Run: `npm test`
Expected: все зелёные (существующие + новые).

---

### Task 2: `TranscriptStructure.labelMontageBlocks` — воркер (2-я модель, чанки)

**Files:**
- Modify: `client/shared/transcript-structure.js` (новая функция + экспорт + чистый парс-хелпер)
- Test: `tests/montage-worker-parse.test.mjs` (новый) — тестируем ТОЛЬКО чистый парс/агрегацию (без сети)

Зеркалим `analyzeForCutsWithLLM` (чанкинг `ANALYSIS_CHUNK_SIZE`/`ANALYSIS_MAX_CHUNKS`, `CC.chatCompletions`, `opt.signal/abortCheck/onProgress`), но вход — АБЗАЦЫ, выход на абзац: `{i, importance, role, theme, blockId}`.

- [ ] **Step 1: Failing-тест на чистый парс-хелпер**

Создать `tests/montage-worker-parse.test.mjs`:
```js
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
  assert.deepEqual(TS.parseMontageChunk('no json here', 0, 5), []);
});

test('parseMontageChunk: JSON с markdown-обёрткой → парсится', () => {
  const raw = '```json\n{"blocks":[{"i":2,"importance":2,"role":"argument","theme":"t","blockId":"b1"}]}\n```';
  const out = TS.parseMontageChunk(raw, 2, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].i, 2);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `node --test tests/montage-worker-parse.test.mjs`
Expected: FAIL «parseMontageChunk is not a function».

- [ ] **Step 3: Реализация**

В `transcript-structure.js` добавить рядом с analyze-блоком:
```js
  var MONTAGE_ROLES = { hook:1, argument:1, example:1, payoff:1, repeat:1, filler:1, offtopic:1 };

  function parseMontageChunk(content, segStart, segEnd) {
    if (!content) return [];
    var m = String(content).match(/\{[\s\S]*\}/);
    if (!m) return [];
    var j;
    try { j = JSON.parse(m[0]); } catch (e) { return []; }
    var arr = (j && j.blocks) || [];
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var k = 0; k < arr.length; k++) {
      var b = arr[k];
      if (!b || typeof b.i !== 'number') continue;
      var imp = Math.round(b.importance);
      if (!(imp >= 0)) imp = 1;
      if (imp > 3) imp = 3; if (imp < 0) imp = 0;
      var role = String(b.role || 'argument').toLowerCase();
      if (!MONTAGE_ROLES[role]) role = 'argument';
      out.push({
        i: b.i, importance: imp, role: role,
        theme: String(b.theme || ''),
        blockId: String(b.blockId || ('b' + b.i))
      });
    }
    return out;
  }

  function buildMontageSystemPrompt() {
    return [
      'Ты — ассистент видеомонтажёра. Дан список АБЗАЦЕВ транскрипта.',
      'Каждый абзац: {i: индекс, t0: начало (сек), t1: конец (сек), text: текст}.',
      'Задача: оцени вклад КАЖДОГО абзаца в СУТЬ материала. НЕ считай секунды.',
      'Для каждого абзаца верни:',
      '• importance: 0=мусор/паразиты, 1=проходное, 2=важное, 3=ядро смысла (без него теряется суть).',
      '• role: hook (завязка) | argument (мысль/факт) | example (пример/история) | payoff (вывод/кульминация) | repeat (повтор сказанного) | filler (вода/паразиты) | offtopic (офтоп).',
      '• theme: роль абзаца в истории, 3-6 слов.',
      '• blockId: соседние абзацы ОДНОЙ мысли объединяй одним blockId (например "b3").',
      '  Новая мысль — новый blockId. Это нужно чтобы монтаж резал по смысловым границам.',
      '',
      'ФОРМАТ — строго JSON, без markdown:',
      '{"blocks":[{"i":0,"importance":3,"role":"hook","theme":"Завязка спора","blockId":"b0"},...]}',
      'Верни ВСЕ абзацы из входа. Ни один не пропускай.'
    ].join('\n');
  }

  /**
   * labelMontageBlocks(paragraphs, opt) → Promise<{labeled:Array, chunks, failedChunks}>
   * opt: { settings, CloudRuClient, signal, abortCheck, onProgress? }
   * Зеркалит чанкинг analyzeForCutsWithLLM, но на уровне абзацев.
   */
  function labelMontageBlocks(paragraphs, opt) {
    opt = opt || {};
    var settings = opt.settings || {};
    var CC = opt.CloudRuClient;
    var onProgress = opt.onProgress || function () {};
    var model = settings.analysisModel || settings.model || settings.chatModel;

    if (!CC || !CC.chatCompletions) return Promise.reject(new Error('CloudRuClient недоступен'));
    if (!paragraphs || !paragraphs.length) return Promise.resolve({ labeled: [], chunks: 0, failedChunks: [] });

    var CHUNK = ANALYSIS_CHUNK_SIZE; /* переиспользуем константу */
    var chunks = [];
    for (var ci = 0; ci < paragraphs.length && chunks.length < ANALYSIS_MAX_CHUNKS; ci += CHUNK) {
      var slice = paragraphs.slice(ci, ci + CHUNK);
      chunks.push(slice.map(function (p, idx) {
        return { i: (typeof p.i === 'number' ? p.i : (ci + idx)), t0: p.startSec, t1: p.endSec,
                 text: String(p.text || '').slice(0, 600) };
      }));
    }

    var sysPrompt = buildMontageSystemPrompt();
    var all = [];
    var failedChunks = [];
    var total = chunks.length;
    onProgress({ phase: 'start', totalChunks: total, message: 'Разметка смыслов: ' + paragraphs.length + ' абзацев, ' + total + ' чанк(ов)' });

    function processOne(idx) {
      if (idx >= chunks.length) return Promise.resolve();
      if (opt.abortCheck && opt.abortCheck()) return Promise.resolve();
      var chunk = chunks[idx];
      var segStart = chunk[0].i, segEnd = chunk[chunk.length - 1].i;
      onProgress({ phase: 'chunk', chunkIndex: idx + 1, totalChunks: total,
        message: 'Разметка чанка ' + (idx + 1) + '/' + total + ' (абзацы ' + segStart + '–' + segEnd + ')…' });
      return CC.chatCompletions({
        baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: model,
        messages: [ { role: 'system', content: sysPrompt }, { role: 'user', content: JSON.stringify({ paragraphs: chunk }) } ],
        chatParams: { max_tokens: 8000, temperature: 0.1 },
        responseFormat: 'json_object', enableThinking: false,
        signal: opt.signal, abortCheck: opt.abortCheck
      }).then(function (resp) {
        var content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
        var parsed = parseMontageChunk(content, segStart, segEnd);
        if (!parsed.length) failedChunks.push({ chunkIndex: idx + 1, segStart: segStart, segEnd: segEnd });
        for (var q = 0; q < parsed.length; q++) all.push(parsed[q]);
        onProgress({ phase: 'chunk_done', chunkIndex: idx + 1, totalChunks: total });
        return processOne(idx + 1);
      }, function (err) {
        failedChunks.push({ chunkIndex: idx + 1, segStart: segStart, segEnd: segEnd, reason: String(err && err.message || err) });
        return processOne(idx + 1);
      });
    }

    return processOne(0).then(function () {
      onProgress({ phase: 'done', totalChunks: total });
      return { labeled: all, chunks: total, failedChunks: failedChunks };
    });
  }
```
В экспорт модуля (`return { analyzeForCutsWithLLM: ..., buildStructure: ..., ... }`) добавить:
`parseMontageChunk: parseMontageChunk, labelMontageBlocks: labelMontageBlocks,`.

- [ ] **Step 4: Тесты зелёные**

Run: `node --test tests/montage-worker-parse.test.mjs`
Expected: PASS (4/4).

- [ ] **Step 5: Регрессия** — `npm test` зелёный.

---

### Task 3: `TranscriptStructure.calibrateMontageBlocks` — калибровка (1 вызов, сводка)

**Files:**
- Modify: `client/shared/transcript-structure.js` (функция + чистый merge-хелпер + экспорт)
- Test: `tests/montage-calibrate.test.mjs` (новый) — чистый merge + fallback

- [ ] **Step 1: Failing-тест**

Создать `tests/montage-calibrate.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTranscriptStructure } from './load-transcript-structure.mjs';

const TS = loadTranscriptStructure();

test('applyCalibration: корректировки по blockId накладываются на labeled', () => {
  const labeled = [
    { i:0, blockId:'b0', importance:1, role:'hook', theme:'t', protect:null },
    { i:1, blockId:'b1', importance:2, role:'argument', theme:'t', protect:null }
  ];
  const calib = [ { blockId:'b0', importance:3, protect:'start' } ];
  const out = TS.applyCalibration(labeled, calib);
  assert.equal(out[0].importance, 3);
  assert.equal(out[0].protect, 'start');
  assert.equal(out[1].importance, 2); // без изменений
});

test('fallbackCalibration: первый/последний блок с importance>=2 получают protect', () => {
  const labeled = [
    { i:0, blockId:'b0', importance:2, role:'hook', theme:'t', protect:null },
    { i:1, blockId:'b1', importance:1, role:'filler', theme:'t', protect:null },
    { i:2, blockId:'b2', importance:3, role:'payoff', theme:'t', protect:null }
  ];
  const out = TS.fallbackCalibration(labeled);
  assert.equal(out.find(x => x.blockId === 'b0').protect, 'start');
  assert.equal(out.find(x => x.blockId === 'b2').protect, 'end');
});
```

- [ ] **Step 2: Запустить — падает** (`node --test tests/montage-calibrate.test.mjs`).

- [ ] **Step 3: Реализация**

В `transcript-structure.js`:
```js
  function applyCalibration(labeled, calib) {
    var byBlock = {};
    for (var c = 0; c < (calib || []).length; c++) {
      var cc = calib[c];
      if (cc && cc.blockId) byBlock[cc.blockId] = cc;
    }
    for (var i = 0; i < labeled.length; i++) {
      var adj = byBlock[labeled[i].blockId];
      if (!adj) continue;
      if (typeof adj.importance === 'number') {
        var im = Math.round(adj.importance); if (im > 3) im = 3; if (im < 0) im = 0;
        labeled[i].importance = im;
      }
      if (adj.protect === 'start' || adj.protect === 'end') labeled[i].protect = adj.protect;
    }
    return labeled;
  }

  function fallbackCalibration(labeled) {
    /* Первый и последний блок с importance>=2 → protect start/end */
    var firstBlock = null, lastBlock = null;
    for (var i = 0; i < labeled.length; i++) {
      if (labeled[i].importance >= 2) { if (firstBlock === null) firstBlock = labeled[i].blockId; lastBlock = labeled[i].blockId; }
    }
    for (var j = 0; j < labeled.length; j++) {
      if (firstBlock && labeled[j].blockId === firstBlock && !labeled[j].protect) labeled[j].protect = 'start';
      if (lastBlock && labeled[j].blockId === lastBlock && !labeled[j].protect) labeled[j].protect = 'end';
    }
    return labeled;
  }

  /**
   * calibrateMontageBlocks(labeled, entry, opt) → Promise<labeled (с protect + скорр. importance)>
   * Один LLM-вызов на СВОДКУ блоков. Fallback на эвристику при сбое.
   */
  function calibrateMontageBlocks(labeled, entry, opt) {
    opt = opt || {};
    var CC = opt.CloudRuClient;
    var settings = opt.settings || {};
    var model = settings.analysisModel || settings.model || settings.chatModel;
    if (!labeled || !labeled.length) return Promise.resolve(labeled || []);
    if (!CC || !CC.chatCompletions) return Promise.resolve(fallbackCalibration(labeled));

    /* Сводка по блокам: blockId → {theme, role(доминирующий), importance(max), durationSec, startSec} */
    var order = [], byId = {};
    var paras = (entry && entry.paragraphs) || [];
    for (var i = 0; i < labeled.length; i++) {
      var L = labeled[i]; var p = paras[L.i]; var d = p ? (p.endSec - p.startSec) : 0;
      if (!byId[L.blockId]) { byId[L.blockId] = { blockId: L.blockId, theme: L.theme, role: L.role, importance: L.importance, durationSec: 0, startSec: p ? p.startSec : 0 }; order.push(L.blockId); }
      var g = byId[L.blockId]; g.durationSec += d;
      if (L.importance > g.importance) g.importance = L.importance;
    }
    var summary = order.map(function (id) { return byId[id]; });

    var sys = [
      'Тебе дана СВОДКА смысловых блоков видео (без полного текста).',
      'Каждый блок: {blockId, theme, role, importance (0-3), durationSec, startSec}.',
      'Задача: откалибруй importance ГЛОБАЛЬНО (баллы ставились по частям, теперь ты видишь целое).',
      'Подними ядро истории и опусти проходное. Пометь protect:"start" у завязки и protect:"end" у финала/вывода.',
      'ФОРМАТ строго JSON: {"calib":[{"blockId":"b0","importance":3,"protect":"start"},...]}. Верни только изменённые/ключевые блоки.'
    ].join('\n');

    return CC.chatCompletions({
      baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: model,
      messages: [ { role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ blocks: summary }) } ],
      chatParams: { max_tokens: 4000, temperature: 0.1 },
      responseFormat: 'json_object', enableThinking: false,
      signal: opt.signal, abortCheck: opt.abortCheck
    }).then(function (resp) {
      var content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
      var m = content && String(content).match(/\{[\s\S]*\}/);
      if (!m) return fallbackCalibration(labeled);
      var j; try { j = JSON.parse(m[0]); } catch (e) { return fallbackCalibration(labeled); }
      var calib = (j && j.calib) || [];
      if (!Array.isArray(calib) || !calib.length) return fallbackCalibration(labeled);
      return applyCalibration(labeled, calib);
    }, function () { return fallbackCalibration(labeled); });
  }
```
Экспорт: добавить `applyCalibration, fallbackCalibration, calibrateMontageBlocks`.

- [ ] **Step 4: Тесты зелёные** (`node --test tests/montage-calibrate.test.mjs` → 2/2).
- [ ] **Step 5: Регрессия** — `npm test` зелёный.

---

### Task 4: Переписать `execProposeMontagePlan` + схему инструмента (panel.js)

**Files:**
- Modify: `client/unified/panel.js` (схема `propose_montage_plan` ~678-719; `execProposeMontagePlan` ~3048-3120; bump `__PANEL_BUILD__` line 10)

- [ ] **Step 1: Схема — убрать blocks из required**

В схеме `propose_montage_plan` (~717): заменить
`required: ['sequenceKey', 'targetDurationSec', 'blocks', 'summary']`
на `required: ['sequenceKey', 'targetDurationSec', 'summary']`.
Удалить объект `blocks: {...}` из `properties` (строки ~694-714). Описание инструмента заменить на:
```
'План монтажа по смыслам: сократить материал до целевого хронометража. ' +
'Плагин САМ размечает смыслы транскрипта второй моделью (по чанкам), ' +
'детерминированно собирает план keep/cut под цель ±10% и показывает карточку на подтверждение. ' +
'НЕ передавай blocks — плагин строит их сам. Требуется транскрипт (сначала транскрибируй In–Out). ' +
'Используй для «сожми до N минут», «сократи сохранив суть», «собери по смыслу».'
```

- [ ] **Step 2: Переписать executor**

Заменить тело `execProposeMontagePlan` (от `/* Детерминированная валидация плана */` до конца функции, строки ~3086-3120) на:
```js
    /* v2: план строит плагин через чанкированный воркер, НЕ модель.
       Гейт #1: функция ВСЕГДА завершается карточкой ЛИБО {error}. */
    var settings = ContextStore.getResolvedSettings ? ContextStore.getResolvedSettings() : {};
    var CC = typeof CloudRuClient !== 'undefined' ? CloudRuClient : null;
    var paras = entry.paragraphs || [];
    if (!paras.length) return Promise.resolve({ error: 'В транскрипте нет абзацев — транскрибируй материал заново.' });

    var wOpt = {
      settings: settings, CloudRuClient: CC,
      signal: runAbort ? runAbort.signal : null,
      abortCheck: runAbort ? function () { return runAbort.aborted; } : null,
      onProgress: function (ev) { if (ev && ev.message) statusUi.show(ev.message, true);
        if (ev && ev.totalChunks && typeof ev.chunkIndex === 'number') statusUi.progress((ev.chunkIndex / ev.totalChunks) * 100); }
    };

    statusUi.show('Разметка смыслов транскрипта…', true);
    return TranscriptStructure.labelMontageBlocks(paras, wOpt)
      .then(function (w) {
        if (!w || !w.labeled || !w.labeled.length) throw new Error('Воркер не вернул разметку');
        return TranscriptStructure.calibrateMontageBlocks(w.labeled, entry, wOpt);
      })
      .then(function (labeled) {
        var built = MontagePlan.buildPlanFromLabels(labeled, entry, args.targetDurationSec);
        if (!built.blocks.length) throw new Error('Не удалось собрать план из разметки');
        var v = MontagePlan.validatePlan(
          { targetDurationSec: args.targetDurationSec, blocks: built.blocks, summary: args.summary }, entry);
        if (!v.ok) {
          /* авто-план не прошёл — редкость; отдаём агенту явную ошибку */
          return { error: 'Авто-план не прошёл проверку: ' + v.errors.join('; '), _planStats: v.stats };
        }
        var refs = MontagePlan.buildRemoveRefs(built.blocks);
        var summaries = MontagePlan.buildSummaries(built.blocks, entry);
        _pendingPlanContext = { blocks: built.blocks, stats: v.stats, warnings: v.warnings };
        var res;
        try {
          res = execProposeTranscriptCuts({
            sequenceKey: sequenceKey, removeRefs: refs, targetDurationSec: args.targetDurationSec,
            keepSummary: summaries.keepSummary, removeSummary: summaries.removeSummary, summary: args.summary
          });
        } finally { _pendingPlanContext = null; }
        return Promise.resolve(res).then(function (r) {
          statusUi.hide();
          if (r && r.ok) { r._planStats = v.stats; if (v.warnings.length) r._planWarnings = v.warnings; }
          return r;
        });
      })
      .catch(function (err) {
        statusUi.hide();
        return { error: 'Монтаж по смыслам не удался: ' + (err && err.message ? err.message : String(err)) +
          '. Проверь, что транскрипт готов, и попробуй снова.' };
      });
```
(Оставить неизменными строки 3048-3085: sequenceKey/entry/staleness/rebuild-гейты.)

- [ ] **Step 3: Bump build**

`panel.js:10` — `__PANEL_BUILD__ = '2026-07-06-montage-v2';`

- [ ] **Step 4: Синтаксис + регрессия**

Run: `node --check client/unified/panel.js && npm test`
Expected: OK + все зелёные.

---

### Task 5: Стартер + роутинг промпта под новый контракт

**Files:**
- Modify: `client/shared/conversation-starters.js` (montage-plan systemPromptAddon ~152-179)
- Modify: `client/shared/prompts.js` (роутинг-блок ~135-141)
- Test: `tests/scenarios-validation.test.mjs` — проверить, что стартер `montage-plan` существует и НЕ упоминает `blocks`/`get_transcript_structure`

- [ ] **Step 1: Failing-тест на стартер**

Добавить в `tests/scenarios-validation.test.mjs` (в стиле существующих тестов файла — сверить формат чтения стартеров в начале файла):
```js
test('montage-plan starter v2: не требует blocks и get_transcript_structure', () => {
  const s = getStarterById('montage-plan'); // используем существующий в файле хелпер загрузки
  assert.ok(s, 'стартер montage-plan существует');
  const addon = s.systemPromptAddon;
  assert.doesNotMatch(addon, /blocks/i, 'не должен просить blocks');
  assert.doesNotMatch(addon, /get_transcript_structure/i, 'не должен звать get_transcript_structure');
  assert.match(addon, /propose_montage_plan/);
});
```
(Если в файле нет `getStarterById` — добавить локальный хелпер, читающий `conversation-starters.js` через существующий loader файла; сверить с началом `scenarios-validation.test.mjs`.)

- [ ] **Step 2: Запустить — падает** (стартер ещё упоминает blocks/get_transcript_structure).

- [ ] **Step 3: Переписать systemPromptAddon** стартера `montage-plan`:
```js
        systemPromptAddon: [
          'РЕЖИМ МОНТАЖ ПО СМЫСЛАМ — сокращение материала с сохранением сути.',
          'Плагин САМ размечает смыслы транскрипта и строит план — ты НЕ считаешь секунды и НЕ строишь blocks.',
          '',
          'АЛГОРИТМ:',
          '1. Если в запросе нет целевого хронометража — спроси: «До какой длительности сжать?» НЕ продолжай без цели.',
          '2. get_timeline_snapshot → возьми sequenceName.',
          '3. propose_montage_plan({sequenceKey: sequenceName, targetDurationSec, summary}).',
          '   НЕ передавай blocks. НЕ вызывай get_transcript_structure — плагин разметит сам через вторую модель',
          '   (это может занять до нескольких минут на длинном материале — это нормально).',
          '   Если вернулась ошибка — покажи её пользователю и предложи вариант (другая цель / проверить транскрипт).',
          '4. После status waiting_user_confirmation — финальное сообщение: 1-2 фразы о структуре плана',
          '   и цифры ТОЛЬКО из _planStats/_verification (не свои). Пользователь применит кнопкой.',
          '',
          'НИКОГДА не вызывай apply_transcript_cuts напрямую в этом режиме.'
        ].join('\n'),
```

- [ ] **Step 4: Роутинг в prompts.js** (~135-141) — убедиться, что блок «сожми до N минут / уложи в N секунд / собери по смыслу → propose_montage_plan» на месте; при необходимости добавить фразу «плагин сам разметит транскрипт, blocks передавать не нужно». (Сверить текущий текст перед правкой.)

- [ ] **Step 5: Тесты зелёные** — `npm test`.

---

### Task 6: Обнаруживаемость стартера/welcome (panel.js)

**Files:**
- Modify: `client/unified/panel.js` (STARTER_CATS ~4348 / логика раскрытия категорий; WELCOME_ITEMS ~4287)
- Test: ручная проверка через e2e (Task 7); юнит не требуется (UI-рендер).

- [ ] **Step 1:** Прочитать текущую логику раскрытия категорий (где `expandedCat` инициализируется) и решить минимальное изменение: категория 📝 По тексту раскрыта по умолчанию ЛИБО стартер `montage-plan` продублирован в always-visible ряд. Выбрать вариант с наименьшим риском (скорее — дефолтно раскрытая 'text' категория).

- [ ] **Step 2:** Внести изменение (например, инициализировать `expandedCat` категорией 'text' при первом рендере, если чат пуст).

- [ ] **Step 3:** Проверить, что WELCOME_ITEMS[2] (сжатие ролика) присутствует и текст соответствует v2 (упоминает «плагин покажет план»). При необходимости обновить формулировку.

- [ ] **Step 4:** `node --check client/unified/panel.js && npm test` — зелёные.

---

### Task 7: Комплексные e2e на активной секвенции (Pr, CDP)

**Files:** нет правок кода; проверочный прогон.

- [ ] **Step 1:** hardreload панели (`node tools/cep-debug.mjs hardreload`), убедиться `window.__PANEL_BUILD__ === '2026-07-06-montage-v2'`.
- [ ] **Step 2:** Снять backup активной секвенции (`$._EXT_PRM_.backupActiveSequence()`), работать на КОПИИ.
- [ ] **Step 3:** Прогнать через DOM-драйв (`#input`+`#send`) сценарий «сожми до 15 минут» на 67-мин материале.
- [ ] **Step 4:** Проверить: (a) карточка плана появилась ДО применения; (b) cut/keep есть и в первой трети, и в последней (НЕ только хвост) — сравнить paragraphs.from диапазоны; (c) Apply → `_timelineDiff.match === true`.
- [ ] **Step 5:** Вернуть оригинальную секвенцию (`activateSequenceById`), удалить временные backup-секвенции. Доложить пользователю цифры + оценку связности для субъективного суда.

---

## Self-review заметки
- Типы согласованы: `labeled` объект `{i, importance, role, theme, blockId, protect?}` одинаков в Task 1/2/3/4.
- `buildPlanFromLabels` покрывает все абзацы (недостающие метки → default) → валидатор не упадёт на дырах.
- Гейт #1 закрыт в Task 4 (always карточка/`{error}`, `.catch`).
- Масштаб #2 закрыт чанкингом Task 2 (воркер не держит весь транскрипт; главная модель — тем более).
- #3 закрыт Task 6 (видимый стартер + welcome).
