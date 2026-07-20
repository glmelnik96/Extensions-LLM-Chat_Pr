# Точные резы (тишино-снап) + Рилс per-clip vision — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) границы монтажных резов переносятся в центр физической тишины (fallback — padding), слова не обрезаются; (2) рилс-рефрейм получает vision-оффсет на КАЖДЫЙ клип таймлайна (кадр из середины клипа с учётом inPoint, батчи по 8, дедуп).

**Architecture:** Часть 1 — чистая функция `refineCutBoundaries` в `deterministic-pipelines.js`, врезается в `execProposeTranscriptCuts` (panel.js) между `snapIntervalsToSegmentBoundaries` и `mergeRemoveIntervals`; статистика в карточку. Часть 2 — host отдаёт геометрию клипов (2.14.0, аддитивно), 4 новые чистые функции в `reels-pipeline.js` (TDD), `planVerticalReframe` принимает адресные оффсеты, vision-цикл в `toolsRunReels` заменяется на батчевый per-clip.

**Tech Stack:** CEP-панель (Chromium, ES5+), ExtendScript ES3 host, node:test + vm для чистой логики, live-валидация через CDP (`node tools/cep-debug.mjs reload|evalfile`).

**Спека:** `docs/superpowers/specs/2026-07-20-precise-cuts-perclip-vision-design.md`

**ВАЖНО — git:** НИКАКИХ коммитов без явной отмашки пользователя (правило проекта, приоритетнее шаблона «frequent commits»). Все изменения накапливаются; коммит — финальная задача после отмашки. Сообщения коммитов по-русски + `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`.

---

## Часть 1. Точные резы

### Task 1: Тесты refineCutBoundaries (failing)

**Files:**
- Modify: `tests/deterministic-pipelines.test.mjs` (добавить describe-блок в конец файла, перед закрытием)

Тесты загружают модуль через уже существующий `loadDeterministicPipelines()` (`const DP = ...` в шапке файла — уже есть).

- [ ] **Step 1: Добавить describe-блок тестов**

```js
/* ═══════════════════════════════════════════════════════════════
 * refineCutBoundaries — точные резы: тишино-снап границ (2026-07-20)
 * ═══════════════════════════════════════════════════════════════ */
describe('refineCutBoundaries', () => {
  it('граница рядом с тишиной → центр тишины (форма startSec/endSec)', () => {
    const r = DP.refineCutBoundaries(
      [{ startSec: 10.0, endSec: 20.0 }],
      [{ startSec: 9.5, endSec: 9.9 }, { startSec: 20.1, endSec: 20.5 }],
      {});
    assert.equal(r.intervals.length, 1);
    assert.ok(Math.abs(r.intervals[0].startSec - 9.7) < 1e-9);
    assert.ok(Math.abs(r.intervals[0].endSec - 20.3) < 1e-9);
    assert.equal(r.stats.snapped, 2);
    assert.equal(r.stats.padded, 0);
  });

  it('форма полей start/end работает так же', () => {
    const r = DP.refineCutBoundaries(
      [{ startSec: 10.0, endSec: 20.0 }],
      [{ start: 9.5, end: 9.9 }],
      {});
    assert.ok(Math.abs(r.intervals[0].startSec - 9.7) < 1e-9);
    /* правая граница без тишины → padding внутрь интервала */
    assert.ok(Math.abs(r.intervals[0].endSec - 19.85) < 1e-9);
    assert.equal(r.stats.snapped, 1);
    assert.equal(r.stats.padded, 1);
  });

  it('тишины нет → padding наружу с обеих сторон (интервал сжимается)', () => {
    const r = DP.refineCutBoundaries([{ startSec: 10, endSec: 20 }], [], {});
    assert.ok(Math.abs(r.intervals[0].startSec - 10.15) < 1e-9);
    assert.ok(Math.abs(r.intervals[0].endSec - 19.85) < 1e-9);
    assert.equal(r.stats.padded, 2);
  });

  it('silences = null → чистый padding, ничего не падает', () => {
    const r = DP.refineCutBoundaries([{ startSec: 5, endSec: 6 }], null, {});
    assert.equal(r.intervals.length, 1);
    assert.equal(r.stats.padded, 2);
  });

  it('интервал после уточнения короче 0.3с → dropped', () => {
    /* 10.0–10.5, padding 0.15 с двух сторон → 0.2с < 0.3с */
    const r = DP.refineCutBoundaries([{ startSec: 10.0, endSec: 10.5 }], [], {});
    assert.equal(r.intervals.length, 0);
    assert.equal(r.stats.dropped, 1);
  });

  it('тишина за пределами окна ±0.7с игнорируется, работает padding', () => {
    const r = DP.refineCutBoundaries(
      [{ startSec: 10, endSec: 20 }],
      [{ startSec: 8.0, endSec: 8.4 }], /* центр 8.2 — дальше 0.7 от 10 */
      {});
    assert.ok(Math.abs(r.intervals[0].startSec - 10.15) < 1e-9);
    assert.equal(r.stats.snapped, 0);
    assert.equal(r.stats.padded, 2);
  });

  it('тишина короче minSilenceSec (0.2с) игнорируется', () => {
    const r = DP.refineCutBoundaries(
      [{ startSec: 10, endSec: 20 }],
      [{ startSec: 9.9, endSec: 10.0 }], /* 0.1с */
      {});
    assert.equal(r.stats.snapped, 0);
    assert.equal(r.stats.padded, 2);
  });

  it('из двух тишин в окне выбирается ближайшая', () => {
    const r = DP.refineCutBoundaries(
      [{ startSec: 10, endSec: 20 }],
      [{ startSec: 9.3, endSec: 9.7 }, { startSec: 9.8, endSec: 10.2 }],
      {});
    /* центры 9.5 и 10.0 — ближе 10.0 */
    assert.ok(Math.abs(r.intervals[0].startSec - 10.0) < 1e-9);
  });

  it('вход не мутируется, дополнительные поля интервала сохраняются', () => {
    const input = [{ startSec: 10, endSec: 20, reason: 'смысловой блок' }];
    const r = DP.refineCutBoundaries(input, [], {});
    assert.equal(input[0].startSec, 10);
    assert.equal(input[0].endSec, 20);
    assert.equal(r.intervals[0].reason, 'смысловой блок');
  });

  it('NaN и инверсия границ → интервал отброшен', () => {
    const r = DP.refineCutBoundaries(
      [{ startSec: NaN, endSec: 5 }, { startSec: 9, endSec: 3 }, null],
      [], {});
    assert.equal(r.intervals.length, 0);
    assert.equal(r.stats.dropped, 3);
  });

  it('интеграция: снап создал пересечение → mergeRemoveIntervals-совместимые интервалы', () => {
    /* два интервала, обе внутренние границы снапаются к одной тишине (центр 15.0) */
    const r = DP.refineCutBoundaries(
      [{ startSec: 10, endSec: 14.8 }, { startSec: 15.2, endSec: 20 }],
      [{ startSec: 14.7, endSec: 15.3 }],
      {});
    assert.equal(r.intervals.length, 2);
    assert.ok(Math.abs(r.intervals[0].endSec - 15.0) < 1e-9);
    assert.ok(Math.abs(r.intervals[1].startSec - 15.0) < 1e-9);
    /* смежные границы совпали — merge на панели схлопнет (EPS 0.05) */
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падают**

Run: `node --test tests/deterministic-pipelines.test.mjs 2>&1 | tail -20`
Expected: FAIL, `DP.refineCutBoundaries is not a function`

### Task 2: Реализация refineCutBoundaries

**Files:**
- Modify: `client/shared/deterministic-pipelines.js` — новая функция рядом с `snapIntervalsToFrame`/`splitCutIntervalsIntoBatches` (конец файла, перед блоком экспорта) + строка в `global.DeterministicPipelines = {...}`

- [ ] **Step 1: Добавить функцию**

```js
  /**
   * Точные резы (спека 2026-07-20): уточнение границ вырезаемых интервалов.
   * Каждая граница: (1) снап в центр ближайшей физической тишины
   * (ffmpeg silencedetect, длительность ≥ minSilenceSec, центр в окне
   * ±windowSec); (2) fallback — padding НАРУЖУ от вырезаемого интервала
   * (интервал сжимается на padSec: лучше лишний хвост звука, чем
   * обрезанное слово). Интервалы короче minIntervalSec после уточнения
   * отбрасываются. Вход не мутируется; NaN/инверсия → отброс.
   * Формы тишин: {startSec,endSec} и {start,end}.
   * → { intervals: [...], stats: { snapped, padded, dropped } }
   */
  function refineCutBoundaries(intervals, silences, opts) {
    var o = opts || {};
    var windowSec = o.windowSec > 0 ? o.windowSec : 0.7;
    var minSilenceSec = o.minSilenceSec > 0 ? o.minSilenceSec : 0.2;
    var padSec = o.padSec >= 0 ? o.padSec : 0.15;
    var minIntervalSec = o.minIntervalSec > 0 ? o.minIntervalSec : 0.3;
    var res = { intervals: [], stats: { snapped: 0, padded: 0, dropped: 0 } };
    if (!intervals || !intervals.length) return res;

    /* Центры валидных тишин (обе формы полей) */
    var centers = [];
    var list = silences || [];
    for (var si = 0; si < list.length; si++) {
      var s = list[si] || {};
      var ss = (typeof s.startSec === 'number') ? s.startSec : s.start;
      var se = (typeof s.endSec === 'number') ? s.endSec : s.end;
      if (typeof ss !== 'number' || typeof se !== 'number' ||
          !isFinite(ss) || !isFinite(se) || se - ss < minSilenceSec) continue;
      centers.push((ss + se) / 2);
    }

    function refineBoundary(t, isStart) {
      var best = null, bestDist = Infinity;
      for (var ci = 0; ci < centers.length; ci++) {
        var d = Math.abs(centers[ci] - t);
        if (d <= windowSec && d < bestDist) { best = centers[ci]; bestDist = d; }
      }
      if (best !== null) return { t: best, how: 'snapped' };
      return { t: isStart ? t + padSec : t - padSec, how: 'padded' };
    }

    for (var i = 0; i < intervals.length; i++) {
      var iv = intervals[i];
      var t0 = iv ? Number(iv.startSec) : NaN;
      var t1 = iv ? Number(iv.endSec) : NaN;
      if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) { res.stats.dropped++; continue; }
      var r0 = refineBoundary(t0, true);
      var r1 = refineBoundary(t1, false);
      var n0 = Math.max(0, r0.t);
      var n1 = r1.t;
      if (n1 - n0 < minIntervalSec) { res.stats.dropped++; continue; }
      res.stats[r0.how]++;
      res.stats[r1.how]++;
      var copy = {};
      for (var k in iv) { if (Object.prototype.hasOwnProperty.call(iv, k)) copy[k] = iv[k]; }
      copy.startSec = n0;
      copy.endSec = n1;
      res.intervals.push(copy);
    }
    return res;
  }
```

- [ ] **Step 2: Экспортировать** — в объект `global.DeterministicPipelines` добавить строку (например, после `splitCutIntervalsIntoBatches`):

```js
    refineCutBoundaries: refineCutBoundaries,
```

- [ ] **Step 3: Прогнать тесты**

Run: `node --test tests/deterministic-pipelines.test.mjs 2>&1 | tail -5`
Expected: PASS, 0 fail

- [ ] **Step 4: Полный прогон**

Run: `node --test tests/ 2>&1 | tail -5`
Expected: все зелёные (базово 845; станет больше на новые)

### Task 3: Врезка в execProposeTranscriptCuts (panel.js)

**Files:**
- Modify: `client/unified/panel.js` — функция `execProposeTranscriptCuts`, строки ~3123–3136 (после `_arSeqKey`-блока, замена строки `var snappedIntervals = mergeRemoveIntervals(snapIntervalsToSegmentBoundaries(paddedIntervals));`) и объект `_pendingProposal` (~3157).

Контекст: `_arSeqKey` уже вычислен выше (строка ~3110: `var _arSeqKey = _cleanSeqKey(workingArgs.sequenceKey || args.sequenceKey || '');`). `ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key)` — существующий способ достать entry транскрипта; silences лежат в `entry.audioAnalysis.silences` (может отсутствовать у старых записей — тогда чистый padding).

- [ ] **Step 1: Заменить строку снапа+мержа**

Было (строка ~3135):

```js
    var snappedIntervals = mergeRemoveIntervals(snapIntervalsToSegmentBoundaries(paddedIntervals));
```

Стало:

```js
    /* Точные резы (спека 2026-07-20): после снапа к границам сегментов
       граница переносится в центр ближайшей физической тишины (ffmpeg
       silencedetect из audioAnalysis), fallback — padding наружу.
       Таймкоды Whisper-сегментов неточны (до ~0.3с) — рез в тишине
       гарантирует целые слова. Затем merge схлопывает пересечения. */
    var _cutSilences = [];
    var _silSeqKey = _arSeqKey || _cleanSeqKey((lastSnap && lastSnap.sequenceName) || '');
    if (_silSeqKey) {
      var _silFound = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, _silSeqKey);
      if (_silFound && _silFound.entry && _silFound.entry.audioAnalysis &&
          Array.isArray(_silFound.entry.audioAnalysis.silences)) {
        _cutSilences = _silFound.entry.audioAnalysis.silences;
      }
    }
    var _refined = DeterministicPipelines.refineCutBoundaries(
      snapIntervalsToSegmentBoundaries(paddedIntervals), _cutSilences, {});
    var snappedIntervals = mergeRemoveIntervals(_refined.intervals);
```

- [ ] **Step 2: Прокинуть статистику в _pendingProposal**

В объект `_pendingProposal = { kind: 'transcript_cuts', ... }` (строка ~3157) добавить поле после `verification: verification,`:

```js
      boundaryStats: _refined.stats,
```

- [ ] **Step 3: Синтаксическая проверка**

Run: `node --check client/unified/panel.js`
Expected: без вывода (ок)

### Task 4: Строка «Границы: …» в карточке предложения

**Files:**
- Modify: `client/unified/panel.js` — `renderPendingProposalCard`, ветка transcript_cuts, сразу после `card.appendChild(stats);` (строка ~2129)

- [ ] **Step 1: Добавить блок**

```js
    /* Точные резы (2026-07-20): статистика уточнения границ по тишине */
    var bs = _pendingProposal.boundaryStats;
    if (bs && (bs.snapped || bs.padded || bs.dropped)) {
      var bsEl = document.createElement('div');
      bsEl.style.cssText = 'font-size:11px;color:#888;margin:-4px 0 8px;';
      bsEl.textContent = 'Границы: ' + (bs.snapped || 0) + ' по тишине, ' +
        (bs.padded || 0) + ' с отступом' +
        (bs.dropped ? ', ' + bs.dropped + ' отброшено (<0.3с)' : '');
      card.appendChild(bsEl);
    }
```

- [ ] **Step 2: Синтаксис + тесты**

Run: `node --check client/unified/panel.js && node --test tests/ 2>&1 | tail -3`
Expected: ок, тесты зелёные

### Task 5: Live-валидация Части 1 (CDP, проект TEst)

**Files:**
- Create: `tmp/cdp-refine-smoke.js`

Premiere с проектом TEst должен быть запущен (панель открыта). Если Premiere закрыт — попросить пользователя запустить, не гадать.

- [ ] **Step 1: Перезагрузить панель**

Run: `node tools/cep-debug.mjs reload`
Expected: `ok`

- [ ] **Step 2: Написать смоук-скрипт** `tmp/cdp-refine-smoke.js`:

```js
(function () {
  var out = { hasFn: typeof DeterministicPipelines.refineCutBoundaries === 'function' };
  if (!out.hasFn) return JSON.stringify(out);
  /* Реальные silences из кэша транскрипта: публичный API ContextStore
     (panelId 'unified'), sequenceKey = имя активной секвенции. */
  var silences = [];
  try {
    var seqName = '';
    var entries = ContextStore.listTranscriptEntries
      ? ContextStore.listTranscriptEntries('unified') : null;
    if (entries && entries.length) seqName = entries[0].sequenceName || '';
    var found = seqName ? ContextStore.findTranscriptEntry('unified', seqName) : null;
    if (found && found.entry && found.entry.audioAnalysis &&
        Array.isArray(found.entry.audioAnalysis.silences)) {
      silences = found.entry.audioAnalysis.silences;
    }
    out.seqName = seqName;
  } catch (e) { out.storeErr = String(e); }
  out.silenceCount = silences.length;
  var probe = silences.length
    ? [{ startSec: Math.max(0, (silences[0].startSec != null ? silences[0].startSec : silences[0].start) - 0.3), endSec: 30 }]
    : [{ startSec: 10, endSec: 20 }];
  var r = DeterministicPipelines.refineCutBoundaries(probe, silences, {});
  out.stats = r.stats;
  out.result = r.intervals;
  return JSON.stringify(out);
})();
```

- [ ] **Step 3: Прогнать**

Run: `node tools/cep-debug.mjs evalfile tmp/cdp-refine-smoke.js`
Expected: `hasFn: true`; при наличии silences в кэше — `stats.snapped ≥ 1`; иначе `stats.padded = 2`

Примечание: exec-функции панели закрыты в замыкании, поэтому смоук идёт через глобальные `DeterministicPipelines` и `ContextStore` (оба на window). Если у `ContextStore` нет метода перечисления записей — взять sequenceKey из UI (заголовок секвенции) и вызвать только `findTranscriptEntry('unified', key)`.

- [ ] **Step 4: Полный e2e — монтаж по смыслам**

Попросить пользователя (или через CDP-клик, как в прошлых прогонах) запустить «Монтаж по смыслам» на секвенции с транскриптом проекта TEst. Проверить: карточка предложения содержит строку «Границы: N по тишине, M с отступом…», резы применяются без обрезанных слов. Это ключевая проверка качества (правило e2e-валидации: слушать результат, а не «код работает»).

---

## Часть 2. Рилс: vision по клипам таймлайна

### Task 6: Host — геометрия клипов в getVerticalReframeSources (2.14.0)

**Files:**
- Modify: `host/premiere.jsx` — строка 20 (версия) и `getVerticalReframeSources` (~2555–2621)

ES3: никаких const/let/стрелок/trim/forEach. Образец полей — `clipInfo` в `getFrameSources` (строка ~2636).

- [ ] **Step 1: Версия**

Было: `$._EXT_PRM_.version = '2.13.0';` → Стало: `$._EXT_PRM_.version = '2.14.0';`

- [ ] **Step 2: Дополнить file-клипы**

В `getVerticalReframeSources` блок push file-клипа (строки ~2574–2578) заменить на:

```js
        if (mp && $._EXT_PRM_._fileExists(mp)) {
          clips.push({
            trackIndex: ti, clipIndex: ci,
            name: String(c.name || ''),
            mediaPath: String(mp).replace(/\\/g, '/'),
            startSec: c.start.seconds,
            endSec: c.end.seconds,
            inPointSec: c.inPoint ? c.inPoint.seconds : null
          });
          continue;
        }
```

- [ ] **Step 3: Дополнить nest-клипы**

Блок push nest-клипа (строки ~2591–2595) заменить на:

```js
          clips.push({
            trackIndex: ti, clipIndex: ci,
            name: String(c.name || ''),
            mediaPath: key,
            startSec: c.start.seconds,
            endSec: c.end.seconds,
            inPointSec: c.inPoint ? c.inPoint.seconds : null
          });
```

- [ ] **Step 4: Проверка отсутствия ES3-нарушений в диффе**

Run: `git diff host/premiere.jsx | grep -E 'const |let |=>|\.trim\(|\.forEach\(|Object\.keys' || echo CLEAN`
Expected: `CLEAN`

### Task 7: Тесты planClipFrames / buildVisionBatches / parseVisionBatchAnswer / assignClipOffsets (failing)

**Files:**
- Modify: `tests/reels-pipeline.test.mjs` — добавить describe-блоки; удалить describe `visionPlan` (функция заменяется, см. Task 8)

- [ ] **Step 1: Удалить describe-блок тестов `visionPlan`** (найти `describe('visionPlan'` и удалить весь блок).

- [ ] **Step 2: Добавить новые тесты**

```js
/* ═══ Vision по клипам таймлайна (спека 2026-07-20) ═══ */
describe('planClipFrames', () => {
  const clip = (over) => Object.assign({
    trackIndex: 0, clipIndex: 0, name: 'c', mediaPath: '/v/a.mp4',
    startSec: 0, endSec: 10, inPointSec: 0
  }, over);

  it('середина клипа с учётом inPoint: frameSec = inPoint + (end-start)/2', () => {
    const r = RP.planClipFrames([clip({ inPointSec: 100, startSec: 20, endSec: 30 })], {});
    assert.equal(r.frames.length, 1);
    assert.equal(r.frames[0].frameSec, 105);
    assert.equal(r.frames[0].fileMidFallback, false);
    assert.deepEqual(r.frames[0].clipRefs, [{ trackIndex: 0, clipIndex: 0 }]);
  });

  it('дедуп: кадры одного файла ближе 2с → одна группа, два clipRefs', () => {
    const r = RP.planClipFrames([
      clip({ clipIndex: 0, inPointSec: 10, startSec: 0, endSec: 4 }),   /* mid 12 */
      clip({ clipIndex: 1, inPointSec: 11, startSec: 4, endSec: 8 })    /* mid 13 */
    ], { dedupeSec: 2 });
    assert.equal(r.frames.length, 1);
    assert.equal(r.frames[0].clipRefs.length, 2);
  });

  it('кадры одного файла дальше 2с → две группы', () => {
    const r = RP.planClipFrames([
      clip({ clipIndex: 0, inPointSec: 0, startSec: 0, endSec: 4 }),    /* mid 2 */
      clip({ clipIndex: 1, inPointSec: 50, startSec: 4, endSec: 8 })    /* mid 52 */
    ], { dedupeSec: 2 });
    assert.equal(r.frames.length, 2);
  });

  it('разные mediaPath не дедупятся даже при близких frameSec', () => {
    const r = RP.planClipFrames([
      clip({ mediaPath: '/v/a.mp4' }),
      clip({ mediaPath: '/v/b.mp4', clipIndex: 1 })
    ], {});
    assert.equal(r.frames.length, 2);
  });

  it('nest: и пустой mediaPath → skipped с причиной', () => {
    const r = RP.planClipFrames([
      clip({ mediaPath: 'nest:abc', name: 'вложенная' }),
      clip({ mediaPath: '', name: 'пустой' })
    ], {});
    assert.equal(r.frames.length, 0);
    assert.equal(r.skipped.length, 2);
    assert.ok(r.skipped[0].reason.length > 0);
  });

  it('inPointSec = null → fileMidFallback, frameSec = null', () => {
    const r = RP.planClipFrames([clip({ inPointSec: null })], {});
    assert.equal(r.frames[0].fileMidFallback, true);
    assert.equal(r.frames[0].frameSec, null);
  });

  it('пустой вход → пустой результат', () => {
    assert.deepEqual(RP.planClipFrames([], {}), { frames: [], skipped: [] });
  });
});

describe('buildVisionBatches', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ mediaPath: '/v/' + i }));
  it('1 кадр → 1 батч', () =>
    assert.deepEqual(RP.buildVisionBatches(mk(1), {}), [[0]]));
  it('9 кадров → батчи [8, 1]', () => {
    const b = RP.buildVisionBatches(mk(9), { batchSize: 8 });
    assert.equal(b.length, 2);
    assert.equal(b[0].length, 8);
    assert.deepEqual(b[1], [8]);
  });
  it('0 кадров → []', () =>
    assert.deepEqual(RP.buildVisionBatches([], {}), []));
});

describe('parseVisionBatchAnswer', () => {
  it('честный JSON-массив', () => {
    const r = RP.parseVisionBatchAnswer('[{"i":1,"cx":0.3},{"i":2,"cx":0.7}]', 2);
    assert.deepEqual(r, [0.3, 0.7]);
  });
  it('JSON в markdown-обёртке', () => {
    const r = RP.parseVisionBatchAnswer('Вот ответ:\n```json\n[{"i":1,"cx":0.4}]\n```', 1);
    assert.deepEqual(r, [0.4]);
  });
  it('пропущенные индексы → null', () => {
    const r = RP.parseVisionBatchAnswer('[{"i":2,"cx":0.6}]', 3);
    assert.deepEqual(r, [null, 0.6, null]);
  });
  it('мусор → все null', () =>
    assert.deepEqual(RP.parseVisionBatchAnswer('не могу распознать', 2), [null, null]));
  it('cx вне [0,1] или не число → null', () => {
    const r = RP.parseVisionBatchAnswer('[{"i":1,"cx":1.5},{"i":2,"cx":"левее"}]', 2);
    assert.deepEqual(r, [null, null]);
  });
  it('индекс вне диапазона игнорируется', () =>
    assert.deepEqual(RP.parseVisionBatchAnswer('[{"i":9,"cx":0.5}]', 1), [null]));
});

describe('assignClipOffsets', () => {
  it('cx → offsetPct ((cx-0.5)*100), распределение по всем clipRefs группы', () => {
    const frames = [{
      mediaPath: '/v/a.mp4', frameSec: 5, fileMidFallback: false,
      clipRefs: [{ trackIndex: 0, clipIndex: 0 }, { trackIndex: 0, clipIndex: 2 }]
    }];
    const r = RP.assignClipOffsets(frames, [0.7]);
    assert.deepEqual(r, [
      { trackIndex: 0, clipIndex: 0, offsetPct: 20 },
      { trackIndex: 0, clipIndex: 2, offsetPct: 20 }
    ]);
  });
  it('null cx → клипы группы не получают оффсет', () => {
    const frames = [
      { mediaPath: '/a', frameSec: 1, fileMidFallback: false, clipRefs: [{ trackIndex: 0, clipIndex: 0 }] },
      { mediaPath: '/b', frameSec: 1, fileMidFallback: false, clipRefs: [{ trackIndex: 1, clipIndex: 0 }] }
    ];
    const r = RP.assignClipOffsets(frames, [null, 0.5]);
    assert.deepEqual(r, [{ trackIndex: 1, clipIndex: 0, offsetPct: 0 }]);
  });
  it('пустые входы → []', () => {
    assert.deepEqual(RP.assignClipOffsets([], []), []);
    assert.deepEqual(RP.assignClipOffsets(null, null), []);
  });
});
```

- [ ] **Step 3: Запустить — новые падают, visionPlan-тестов больше нет**

Run: `node --test tests/reels-pipeline.test.mjs 2>&1 | tail -10`
Expected: FAIL, `RP.planClipFrames is not a function`

### Task 8: Реализация 4 функций в reels-pipeline.js (замена visionPlan)

**Files:**
- Modify: `client/shared/reels-pipeline.js` — заменить `visionPlan` (~432–448) на 4 новые функции; обновить экспорт `global.ReelsPipeline`

- [ ] **Step 1: Заменить блок visionPlan**

Удалить функцию `visionPlan` вместе с её комментарием и вставить:

```js
  /* ── Vision по клипам таймлайна (спека 2026-07-20) ──────────────────────
   * Кадр из середины КАЖДОГО клипа таймлайна (source-время с учётом
   * inPoint), близкие кадры одного файла дедупятся, батчи ≤8 кадров
   * на запрос, оффсеты адресные (trackIndex/clipIndex). ── */

  /* planClipFrames: клипы host getVerticalReframeSources (с геометрией) →
   * группы кадров. 'nest:'/пустой mediaPath → skipped (vision недоступен,
   * центр). inPointSec == null (host не смог) → fileMidFallback: панель
   * возьмёт середину файла (текущее поведение как деградация). */
  function planClipFrames(clips, opts) {
    var o = opts || {};
    var dedupeSec = o.dedupeSec > 0 ? o.dedupeSec : 2;
    var frames = [], skipped = [];
    if (!clips || !clips.length) return { frames: frames, skipped: skipped };
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (!c || !c.mediaPath) {
        skipped.push({ name: (c && c.name) || '?', reason: 'нет mediaPath — vision недоступен, центр' });
        continue;
      }
      var p = String(c.mediaPath);
      if (p.indexOf('nest:') === 0) {
        skipped.push({ name: c.name || '?', reason: 'nested-секвенция — vision недоступен, центр' });
        continue;
      }
      var ref = { trackIndex: c.trackIndex, clipIndex: c.clipIndex };
      var mid = null, fallback = false;
      if (typeof c.inPointSec === 'number' && isFinite(c.inPointSec) &&
          typeof c.startSec === 'number' && isFinite(c.startSec) &&
          typeof c.endSec === 'number' && isFinite(c.endSec) &&
          c.endSec > c.startSec) {
        mid = c.inPointSec + (c.endSec - c.startSec) / 2;
      } else {
        fallback = true;
      }
      var joined = false;
      for (var g = 0; g < frames.length; g++) {
        var fr = frames[g];
        if (fr.mediaPath !== p) continue;
        if (fallback && fr.fileMidFallback) { fr.clipRefs.push(ref); joined = true; break; }
        if (!fallback && !fr.fileMidFallback && Math.abs(fr.frameSec - mid) < dedupeSec) {
          fr.clipRefs.push(ref); joined = true; break;
        }
      }
      if (!joined) {
        frames.push({
          mediaPath: p,
          frameSec: fallback ? null : Math.max(0, Math.round(mid * 100) / 100),
          fileMidFallback: fallback,
          clipRefs: [ref]
        });
      }
    }
    return { frames: frames, skipped: skipped };
  }

  /* buildVisionBatches: индексы frames батчами ≤batchSize (по 8 —
   * VISION_MAX_FRAMES, паттерн describe_frames). */
  function buildVisionBatches(frames, opts) {
    var size = (opts && opts.batchSize > 0) ? opts.batchSize : 8;
    var out = [];
    if (!frames || !frames.length) return out;
    var cur = [];
    for (var i = 0; i < frames.length; i++) {
      cur.push(i);
      if (cur.length >= size) { out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /* parseVisionBatchAnswer: ответ vision-модели → массив cx длиной count
   * (null = центр). Ждём JSON-массив [{"i":<1-based номер кадра>,"cx":0..1}],
   * допускаем markdown/текст вокруг. Невалидный cx, кривой JSON, индекс
   * вне диапазона → null. */
  function parseVisionBatchAnswer(text, count) {
    var out = [];
    for (var i = 0; i < count; i++) out.push(null);
    var s = String(text == null ? '' : text);
    var m = s.match(/\[[\s\S]*\]/);
    if (!m) return out;
    var arr;
    try { arr = JSON.parse(m[0]); } catch (e) { return out; }
    if (!arr || !arr.length) return out;
    for (var j = 0; j < arr.length; j++) {
      var it = arr[j];
      if (!it) continue;
      var idx = Number(it.i) - 1;
      if (!isFinite(idx) || idx !== Math.floor(idx) || idx < 0 || idx >= count) continue;
      var cx = (typeof it.cx === 'number') ? it.cx : NaN;
      if (!isFinite(cx) || cx < 0 || cx > 1) continue;
      out[idx] = cx;
    }
    return out;
  }

  /* assignClipOffsets: cx группы → offsetPct на каждый её clipRef.
   * null cx → клипы группы не получают оффсет (останутся центром). */
  function assignClipOffsets(frames, cxList) {
    var out = [];
    if (!frames || !frames.length) return out;
    for (var i = 0; i < frames.length; i++) {
      var cx = (cxList && i < cxList.length) ? cxList[i] : null;
      if (cx === null || cx === undefined) continue;
      var pct = offsetPctFromCx(cx);
      if (pct === null) continue;
      var refs = frames[i].clipRefs || [];
      for (var r = 0; r < refs.length; r++) {
        out.push({ trackIndex: refs[r].trackIndex, clipIndex: refs[r].clipIndex, offsetPct: pct });
      }
    }
    return out;
  }
```

- [ ] **Step 2: Обновить экспорт** — в `global.ReelsPipeline` удалить `visionPlan: visionPlan,` и добавить:

```js
    planClipFrames: planClipFrames,
    buildVisionBatches: buildVisionBatches,
    parseVisionBatchAnswer: parseVisionBatchAnswer,
    assignClipOffsets: assignClipOffsets,
```

- [ ] **Step 3: Прогнать тесты**

Run: `node --test tests/reels-pipeline.test.mjs 2>&1 | tail -5`
Expected: PASS

### Task 9: planVerticalReframe — адресные оффсеты (TDD)

**Files:**
- Modify: `tests/deterministic-pipelines.test.mjs` (тесты), `client/shared/deterministic-pipelines.js` (`planVerticalReframe`, ~1565–1607)

- [ ] **Step 1: Тесты (failing)** — добавить в describe-блок planVerticalReframe (или новый describe рядом):

```js
describe('planVerticalReframe — адресные vision-оффсеты (2026-07-20)', () => {
  const dims = { '/v/a.mp4': { width: 1920, height: 1080 } };
  const clips = [
    { trackIndex: 0, clipIndex: 0, name: 'Cam A', mediaPath: '/v/a.mp4' },
    { trackIndex: 0, clipIndex: 1, name: 'Cam B', mediaPath: '/v/a.mp4' }
  ];

  it('адресный оффсет применяется к своему клипу, остальные — центр', () => {
    const r = DP.planVerticalReframe(clips, dims, {
      clipOffsets: [{ trackIndex: 0, clipIndex: 1, offsetPct: 20 }]
    });
    assert.equal(r.items.length, 2);
    assert.equal(r.items[0].posX, 0.5); /* центр */
    assert.ok(r.items[1].posX < 0.5);   /* фокус правее → кадр влево */
  });

  it('manual по имени побеждает адресный', () => {
    const rManual = DP.planVerticalReframe(clips, dims, {
      offsets: [{ match: 'cam b', offsetPct: -10 }],
      clipOffsets: [{ trackIndex: 0, clipIndex: 1, offsetPct: 30 }]
    });
    const rOnly = DP.planVerticalReframe(clips, dims, {
      offsets: [{ match: 'cam b', offsetPct: -10 }]
    });
    assert.equal(rManual.items[1].posX, rOnly.items[1].posX);
  });

  it('кламп в границы кадра работает и для адресных (регресс)', () => {
    const rBig = DP.planVerticalReframe(clips, dims, {
      clipOffsets: [{ trackIndex: 0, clipIndex: 0, offsetPct: 500 }]
    });
    const rEdge = DP.planVerticalReframe(clips, dims, {
      clipOffsets: [{ trackIndex: 0, clipIndex: 0, offsetPct: 50 }]
    });
    assert.equal(rBig.items[0].posX, rEdge.items[0].posX); /* оба уперлись в край */
  });
});
```

Run: `node --test tests/deterministic-pipelines.test.mjs 2>&1 | tail -10` — Expected: FAIL (clipOffsets игнорируется, posX равен 0.5)

- [ ] **Step 2: Реализация** — в `planVerticalReframe`:

После `var offsets = o.offsets || null;` добавить:

```js
    var clipOffsets = o.clipOffsets || null;
```

Блок выбора фокуса `var f = 0.5; if (offsets) {...}` заменить на:

```js
      var f = 0.5;
      var matchedByName = false;
      if (offsets) {
        var nameLc = String(c.name || '').toLowerCase();
        for (var j = 0; j < offsets.length; j++) {
          if (nameLc.indexOf(offsets[j].match) !== -1) {
            f = 0.5 + offsets[j].offsetPct / 100;
            matchedByName = true;
            break;
          }
        }
      }
      /* Адресный vision-оффсет (2026-07-20): manual (имя) побеждает */
      if (!matchedByName && clipOffsets) {
        for (var q = 0; q < clipOffsets.length; q++) {
          if (clipOffsets[q].trackIndex === c.trackIndex &&
              clipOffsets[q].clipIndex === c.clipIndex) {
            f = 0.5 + clipOffsets[q].offsetPct / 100;
            break;
          }
        }
      }
```

Обновить JSDoc функции: в описание opts добавить `clipOffsets: [{trackIndex, clipIndex, offsetPct}]|null — адресные vision-оффсеты; приоритет: offsets (имя) → clipOffsets → центр 0.5`.

- [ ] **Step 3: Прогнать**

Run: `node --test tests/deterministic-pipelines.test.mjs 2>&1 | tail -5`
Expected: PASS (включая старые тесты planVerticalReframe — регресс не сломан)

### Task 10: Панель — замена vision-цикла в toolsRunReels

**Files:**
- Modify: `client/unified/panel.js` — `toolsRunReels`, блок «2. Смещения» (~7783–7858) и вызов `planVerticalReframe` (~7861–7865)

- [ ] **Step 1: Заменить блок «2. Смещения»**

Весь код от комментария `/* 2. Смещения: ручные > vision > центр...` до строки `var offsets = manual.concat(visionOffsets);` включительно заменить на:

```js
        /* 2. Смещения: ручные > vision (per-clip) > центр. Спека 2026-07-20:
           кадр из середины КАЖДОГО клипа таймлайна (source-время с учётом
           inPoint), близкие кадры одного файла дедупятся, до 8 кадров в один
           vision-запрос, оффсеты адресные (trackIndex/clipIndex). */
        var offsetsEl = document.getElementById('rl-offsets');
        var manual = DeterministicPipelines.parseVerticalOffsets(offsetsEl ? offsetsEl.value : '') || [];
        /* Клипы, покрытые ручным «Фокусом камер», в vision не идут */
        var manualCovered = 0;
        var visionClips = src.clips.filter(function (c) {
          var low = String(c.name || '').toLowerCase();
          var hit = manual.some(function (o) { return low.indexOf(o.match) !== -1; });
          if (hit) manualCovered++;
          return !hit;
        });
        var cp = ReelsPipeline.planClipFrames(visionClips, { dedupeSec: 2 });
        for (var vs = 0; vs < cp.skipped.length; vs++) {
          notes.push(cp.skipped[vs].name + ': ' + cp.skipped[vs].reason);
        }
        if (manualCovered) notes.push('ручное смещение: ' + manualCovered + ' клипов (vision пропущен)');
        var clipOffsets = [];
        var visionModel = settings.visionModel || 'MiniMaxAI/MiniMax-M3';
        if (cp.frames.length && !settings.apiKey) {
          notes.push('нет API-ключа — vision пропущен, центр');
        } else if (cp.frames.length) {
          /* Кадры групп; fileMidFallback → середина файла (host не дал inPoint) */
          var frameUrls = [];
          for (var fi = 0; fi < cp.frames.length; fi++) {
            var fr = cp.frames[fi];
            var frBase = fr.mediaPath.substring(Math.max(fr.mediaPath.lastIndexOf('/'), fr.mediaPath.lastIndexOf('\\')) + 1);
            toolsStatusUi.show('Рилс: кадры для vision ' + (fi + 1) + ' из ' + cp.frames.length + '…', true);
            try {
              var fSec = fr.frameSec;
              if (fr.fileMidFallback || typeof fSec !== 'number') {
                var vDur = await AudioPreprocess.probeDurationSec(fr.mediaPath);
                fSec = (vDur && vDur > 0) ? vDur / 2 : 1;
              }
              frameUrls.push(await AudioPreprocess.extractFrameJpeg(fr.mediaPath, fSec, { maxWidth: 768 }));
            } catch (eF) {
              frameUrls.push(null);
              notes.push(frBase + ': кадр не извлечён (' + String((eF && eF.message) || eF) + ') — центр');
            }
          }
          /* Батчи ≤8 кадров — один vision-запрос на батч (паттерн describe_frames) */
          var cxAll = [];
          for (var ca = 0; ca < cp.frames.length; ca++) cxAll.push(null);
          var batches = ReelsPipeline.buildVisionBatches(cp.frames, { batchSize: 8 });
          var reqCount = 0;
          for (var bi = 0; bi < batches.length; bi++) {
            var idxs = batches[bi].filter(function (ix) { return frameUrls[ix] !== null; });
            if (!idxs.length) continue;
            toolsStatusUi.show('Рилс: vision-кадрирование, запрос ' + (bi + 1) + ' из ' + batches.length + '…', true);
            var vContent = [{
              type: 'text',
              text: 'Ниже ' + idxs.length + ' кадров видео. Для КАЖДОГО кадра найди главного человека (лицо); если людей нет — главный объект. Ответ строго JSON-массивом без пояснений: [{"i": <номер кадра>, "cx": <число 0..1 — горизонтальный центр, 0 = левый край кадра, 1 = правый>}]. Если объекта нет: cx 0.5.'
            }];
            for (var ni = 0; ni < idxs.length; ni++) {
              vContent.push({ type: 'text', text: 'Кадр ' + (ni + 1) + ':' });
              vContent.push({ type: 'image_url', image_url: { url: frameUrls[idxs[ni]] } });
            }
            try {
              reqCount++;
              var vResp = await CloudRuClient.chatCompletions({
                baseUrl: settings.baseUrl,
                apiKey: settings.apiKey,
                model: visionModel,
                temperature: 0,
                enableThinking: false,
                /* БЕЗ responseFormat: json_object — MiniMax-M3 на Cloud.ru с ним
                 * возвращает ПУСТОЙ content (finish=stop), A/B-проверено live
                 * 17.07.2026. Без него модель отвечает честным JSON. */
                chatParams: { max_tokens: 512 },
                messages: [{ role: 'user', content: vContent }]
              });
              var vText = (vResp && vResp.choices && vResp.choices[0] && vResp.choices[0].message)
                ? String(vResp.choices[0].message.content || '') : '';
              var cxBatch = ReelsPipeline.parseVisionBatchAnswer(vText, idxs.length);
              for (var pb = 0; pb < idxs.length; pb++) cxAll[idxs[pb]] = cxBatch[pb];
            } catch (eB) {
              notes.push('vision-запрос ' + (bi + 1) + ' не сработал (' + String((eB && eB.message) || eB) + ') — центр для его кадров');
            }
          }
          clipOffsets = ReelsPipeline.assignClipOffsets(cp.frames, cxAll);
          var visionClipCount = 0;
          for (var vc = 0; vc < cp.frames.length; vc++) {
            if (cxAll[vc] !== null) visionClipCount += cp.frames[vc].clipRefs.length;
          }
          notes.push('vision: ' + visionClipCount + ' клипов, ' + cp.frames.length + ' кадров, ' + reqCount + ' запросов');
        }
```

- [ ] **Step 2: Обновить вызов planVerticalReframe**

Было:

```js
        var plan = DeterministicPipelines.planVerticalReframe(src.clips, dims, {
          targetW: targetW,
          targetH: targetH,
          offsets: offsets.length ? offsets : null
        });
```

Стало:

```js
        var plan = DeterministicPipelines.planVerticalReframe(src.clips, dims, {
          targetW: targetW,
          targetH: targetH,
          offsets: manual.length ? manual : null,
          clipOffsets: clipOffsets.length ? clipOffsets : null
        });
```

- [ ] **Step 3: Убедиться, что visionPlan больше нигде не используется**

Run: `grep -rn "visionPlan" client/ tests/ || echo CLEAN`
Expected: `CLEAN`

- [ ] **Step 4: Синтаксис + полный прогон тестов**

Run: `node --check client/unified/panel.js && node --test tests/ 2>&1 | tail -5`
Expected: ок, все зелёные

### Task 11: Live-валидация Части 2 (CDP, проект TEst)

**Files:**
- Create: `tmp/cdp-reframe-sources.js`

- [ ] **Step 1: Перезагрузить панель (перегружает и host-скрипт)**

Run: `node tools/cep-debug.mjs reload`
Expected: `ok`

- [ ] **Step 2: Проверить новые host-поля** — `tmp/cdp-reframe-sources.js`:

```js
new Promise(function (resolve) {
  PremiereBridge.getVerticalReframeSources(function (err, data) {
    if (err) { resolve(JSON.stringify({ err: String(err) })); return; }
    var c = (data && data.clips && data.clips[0]) || {};
    resolve(JSON.stringify({
      ok: data && data.ok,
      hostVersion: data && data.hostVersion,   /* ожидаем 2.14.0 */
      clipCount: data && data.clips ? data.clips.length : 0,
      firstClip: {
        name: c.name, mediaPath: c.mediaPath,
        startSec: c.startSec, endSec: c.endSec, inPointSec: c.inPointSec
      }
    }));
  });
});
```

Run: `node tools/cep-debug.mjs evalfile tmp/cdp-reframe-sources.js`
Expected: `hostVersion: "2.14.0"`, у firstClip числовые `startSec/endSec` и `inPointSec` (или null)

- [ ] **Step 3: Полный прогон рилса** — на секвенции TEst с транскриптом запустить сборку рилса (CDP-клик по кнопке, паттерн `tmp/cdp-run-reels-none.js` из прошлой сессии, или руками пользователя). Проверить в отчёте панели:
  - строка «vision: N клипов, M кадров, K запросов» (K < N при дедупе/батчах);
  - деградации перечислены (nest, ошибки кадров) — сборка НЕ упала;
  - в созданной секвенции у клипов с разным положением спикера — разный posX (спикер в центре композиции). Ключевая проверка качества — визуально по кадру, не «код отработал».

- [ ] **Step 4: Регресс ручного «Фокуса камер»** — заполнить `rl-offsets` (например `Cam A: -10`), пересобрать: клип Cam A получает ручной оффсет, в отчёте «ручное смещение: … (vision пропущен)».

---

### Task 12: Отмашка и коммит

- [ ] **Step 1:** Показать пользователю сводку изменений и результаты live-валидации. Ждать явной отмашки.
- [ ] **Step 2 (после отмашки):** два коммита:

```bash
git add client/shared/deterministic-pipelines.js client/unified/panel.js tests/deterministic-pipelines.test.mjs docs/superpowers/specs/2026-07-20-precise-cuts-perclip-vision-design.md docs/superpowers/plans/2026-07-20-precise-cuts-perclip-vision.md
git commit -m "$(cat <<'EOF'
feat(cuts): точные резы — снап границ в центр тишины, fallback-padding

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
git add host/premiere.jsx client/shared/reels-pipeline.js client/shared/deterministic-pipelines.js client/unified/panel.js tests/reels-pipeline.test.mjs tests/deterministic-pipelines.test.mjs
git commit -m "$(cat <<'EOF'
feat(reels): vision по клипам таймлайна — кадр из середины клипа, батчи по 8, адресные оффсеты

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3 (после отдельной отмашки на push):** `GIT_SSH_COMMAND="ssh -i C:/ssh-home/.ssh/id_ed25519 -o UserKnownHostsFile=C:/ssh-home/.ssh/known_hosts" git push`

---

## Порядок и зависимости

- Часть 1 (Tasks 1–5) и Часть 2 (Tasks 6–11) независимы; выполнять последовательно: сначала резы (болит на каждом монтаже).
- Внутри Части 2: Task 6 (host) можно параллельно с 7–9; Task 10 требует 6, 8, 9.
- Live-валидация (5, 11) требует запущенного Premiere с проектом TEst — если закрыт, попросить пользователя, не пропускать.
