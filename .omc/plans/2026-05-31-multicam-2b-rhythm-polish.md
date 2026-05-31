# MultiCam Phase 2B — N-speaker generalization + Wraith-parity rhythm polish

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Расширить multicam с фиксированных 2 спикеров до auto-detected ≤4 (на основе snapshot), и добавить три чистых функции качества из Wraith — `enforceMaxHold` с wide-инжектом в длинные монологи, `applyVariations` (seeded jitter против монотонности), `snapToSpeechOnset` (рез к атаке слога).

**Не-цели:** UI маппинга, слайдеры параметров — это Phase 2C. ML speaker-ID, J/L-cuts, mic-bleed cleanup — Phase 3.

---

## Background (read before starting)

- `client/shared/multicam-plan.js` — `decideActiveMic` и `micToVideoTrack` **уже N-speaker** (loops over `audioRmsDb`, читает `mapping.speakers[N].videoTrack`). `buildSwitchPlan` тоже N-capable. Жёсткое 2-spкр ограничение жило только в `multicamFromAudio`.
- `host/premiere.jsx applyMulticamCuts` — N-capable (поддержка до 8 камер уже отмечена в roadmap, контракт стабилен).
- `client/shared/deterministic-pipelines.js:1064` `multicamFromAudio` — строит **hardcoded mapping на 2 спикеров** (V1=wide, A0↔V1, A1↔V2). Это единственная точка изменения для генерализации.
- `client/unified/panel.js:4639` `rmsExtractor` — уже итерирует `mapping.speakers`, никаких изменений не требует.
- 2B rhythm-фичи — три чистых функции в `multicam-plan.js`, подключаются в `buildSwitchPlan` после `enforceMinHold`/`snapToSilences` соответственно.
- Convention для дефолтов: каждая фича включается через ненулевой param (max-hold вкл по дефолту 8с; variations выкл по дефолту 0с; speech-onset вкл если caller передал `onsets`).

---

## File Structure

- **Modify** `client/shared/multicam-plan.js` — добавить `enforceMaxHold`, `applyVariations`, `snapToSpeechOnset`; обновить `buildSwitchPlan` pipeline; обновить `DEFAULTS` (max-hold ≠ 0, variations = 0); добавить новые функции на `api` и `_internals`.
- **Modify** `tests/multicam-plan.test.mjs` — три новых `describe` блока.
- **Modify** `client/shared/deterministic-pipelines.js` — динамический mapping в `multicamFromAudio`; проброс новых params в `planParams`; обновить сообщения валидации.
- **Modify** `tests/deterministic-pipelines.test.mjs` — кейсы N=4 и N=3 в `multicamFromAudio` describe.

---

## Task 1: N-speaker generalization в `multicamFromAudio`

Динамически собирать `mapping` из `snapshot.tracks`. Конвенция: `wideVideoTrack=0`, `speakers[i]={audioTrack:i, videoTrack:i+1, label:'Гость '+(i+1)}` для `i ∈ [0, speakerCount)`, где `speakerCount = min(aTracks.length, vTracks.length-1, 4)`. Валидация снижена до «минимум 1 спикер»: нужно `≥2V` (1 wide + 1 гость) и `≥1A`.

**Files:**
- Modify: `client/shared/deterministic-pipelines.js`
- Modify: `tests/deterministic-pipelines.test.mjs`

- [ ] **Step 1: Обновить тесты (TDD: добавить новые, ослабить старые)**

Старый тест `'errors when fewer than 3 video tracks'` сейчас ожидает ошибку при 3V — но теперь 3V+2A валиден (2 спикера). Тест должен остаться, но проверять граничный случай **1V+1A** (один V не даёт wide+speaker → ошибка), а сообщение поменять. Также добавить:
- кейс 5V+4A → ровно 4 спикера, mapping корректен;
- кейс 3V+2A (regression) → ровно 2 спикера, plan тот же контракт;
- кейс 6V+5A → speakerCount **обрезан до 4** (MAX);
- кейс 2V+1A → 1 спикер, plan строится, нет ошибки.

Поправить существующий happy-path тест (`'switches to the louder mic per frame'`) — он использует 3V+2A snapshot, ничего не меняется в его assertion'ах кроме того, что `mapping.speakers.length === 2`.

Заменить старый блок `'errors when fewer than 3 video tracks'` на:
```js
  it('errors when fewer than 2 video tracks (need wide + ≥1 speaker)', async () => {
    const ctx = {
      snapshot: { ok: true, tracks: [{ type: 'video', index: 0 }, { type: 'audio', index: 0 }] },
      rmsExtractor: () => Promise.resolve({ timelines: [[]] })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, false);
    assert.match(res.error, /2 видеодорожк/);
  });
```

И добавить рядом с существующим happy-path тестом:
```js
  function snapNvMa(nV, nA) {
    const tracks = [];
    for (let i = 0; i < nV; i++) tracks.push({ type: 'video', index: i });
    for (let i = 0; i < nA; i++) tracks.push({ type: 'audio', index: i });
    return { ok: true, sequenceName: 'seq', tracks };
  }
  function fakeTimelines(nSpeakers, durSec, loudIndex) {
    // Каждый трек имеет одинаковую длину, активный спикер = loudIndex
    const fs = 0.05;
    const total = Math.round(durSec / fs);
    const out = [];
    for (let s = 0; s < nSpeakers; s++) {
      const tl = [];
      for (let i = 1; i <= total; i++) {
        tl.push({ t: +(i * fs).toFixed(3), rms: s === loudIndex ? -10 : -50 });
      }
      out.push(tl);
    }
    return out;
  }

  it('builds 4-speaker mapping from 5V+4A snapshot', async () => {
    const ctx = {
      snapshot: snapNvMa(5, 4),
      rmsExtractor: () => Promise.resolve({ timelines: fakeTimelines(4, 4, 2) })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    const m = res.proposal.plan.mapping;
    assert.equal(m.wideVideoTrack, 0);
    assert.equal(m.speakers.length, 4);
    assert.deepEqual(m.speakers.map(s => s.videoTrack), [1, 2, 3, 4]);
    assert.deepEqual(m.speakers.map(s => s.audioTrack), [0, 1, 2, 3]);
    // Голос на спикере 2 (audioTrack=2, videoTrack=3) — какой-то сегмент должен быть на V3.
    assert.ok(res.proposal.plan.segments.some(s => s.activeVideoTrack === 3));
  });

  it('builds 2-speaker mapping from 3V+2A snapshot (regression)', async () => {
    const ctx = {
      snapshot: snapNvMa(3, 2),
      rmsExtractor: () => Promise.resolve({ timelines: fakeTimelines(2, 4, 0) })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.equal(res.proposal.plan.mapping.speakers.length, 2);
  });

  it('caps speakerCount at 4 when 6V+5A', async () => {
    const ctx = {
      snapshot: snapNvMa(6, 5),
      rmsExtractor: () => Promise.resolve({ timelines: fakeTimelines(4, 4, 0) })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.equal(res.proposal.plan.mapping.speakers.length, 4);
  });

  it('builds 1-speaker mapping from 2V+1A snapshot', async () => {
    const ctx = {
      snapshot: snapNvMa(2, 1),
      rmsExtractor: () => Promise.resolve({ timelines: fakeTimelines(1, 4, 0) })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.equal(res.proposal.plan.mapping.speakers.length, 1);
    assert.equal(res.proposal.plan.mapping.speakers[0].videoTrack, 1);
  });
```

NB: `fakeTimelines(N, durSec, loudIndex)` создаёт N таймлайнов, на одном громко (rms=-10), на остальных тихо (rms=-50). Это гарантирует один активный спикер → детерминированный план.

Старый тест с двумя таймлайнами и переключением «A loud first 2s, B loud next 2s» сохранить как regression — он использует 2 спикера; убедиться что после генерализации `mapping.speakers.length === 2` тоже работает (если тест уже это утверждает — оставить, иначе **не добавлять** дополнительное assertion, ему не место в feature-тесте).

Запуск: `node --test tests/deterministic-pipelines.test.mjs` — новые тесты должны **упасть** (`speakers.length` всё ещё 2 в N=4 кейсе из-за hardcoded mapping).

- [ ] **Step 2: Реализация — динамический mapping**

В `client/shared/deterministic-pipelines.js`, функция `multicamFromAudio`, заменить блок:
```js
    if (vTracks.length < 3) {
      return { ok: false, error: 'Нужно ≥3 видеодорожки (V1=wide, V2/V3=гости). Найдено ' + vTracks.length + '.' };
    }
    if (aTracks.length < 2) {
      return { ok: false, error: 'Нужно ≥2 аудиодорожки. Найдено ' + aTracks.length + '.' };
    }
    // ...
    var mapping = {
      wideVideoTrack: 0,
      speakers: [
        { audioTrack: 0, videoTrack: 1, label: 'Гость 1' },
        { audioTrack: 1, videoTrack: 2, label: 'Гость 2' }
      ]
    };
```
на:
```js
    var MAX_SPEAKERS = 4;
    if (vTracks.length < 2) {
      return { ok: false, error: 'Нужно ≥2 видеодорожки (V1=wide + ≥1 гость). Найдено ' + vTracks.length + '.' };
    }
    if (aTracks.length < 1) {
      return { ok: false, error: 'Нужно ≥1 аудиодорожки (mic). Найдено ' + aTracks.length + '.' };
    }
    var speakerCount = Math.min(aTracks.length, vTracks.length - 1, MAX_SPEAKERS);
    var speakers = [];
    for (var spi = 0; spi < speakerCount; spi++) {
      speakers.push({ audioTrack: spi, videoTrack: spi + 1, label: 'Гость ' + (spi + 1) });
    }
    var mapping = { wideVideoTrack: 0, speakers: speakers };
```

Sanity: в проверках `rmsExtractor`-возврата ничего не меняется — `framesFromRmsTimelines` принимает любое N таймлайнов; `buildSwitchPlan` строит план для любого N спикеров.

Обновить также `summary` в proposal, чтобы она не была захардкожена на «V1/V2/V3»:
```js
      summary: 'Авто-MultiCam (по голосу): ' + built.segments.length + ' сегментов, ' +
        built.switchCount + ' переключений. Спикеров: ' + speakerCount + '.'
```

(Подробная per-track статистика остаётся в `proposal.stats.perTrackSeconds` — UI потом сможет её показать; сейчас в summary держим лаконично, иначе строка раздуется при N=4.)

- [ ] **Step 3: Тесты должны пройти**

Запуск: `node --test tests/deterministic-pipelines.test.mjs 2>&1 | tail -20` → все зелёные, в том числе 4 новых.

- [ ] **Step 4: Регрессия**

Запуск: `npm test 2>&1 | tail -15` → 313+ зелёные, без падений.

- [ ] **Step 5: Syntax**

`node --check client/shared/deterministic-pipelines.js` → exit 0.

- [ ] **Step 6: Commit** (auto-commit per branch policy)

```bash
git add client/shared/deterministic-pipelines.js tests/deterministic-pipelines.test.mjs
git commit -m "feat(multicam): generalize multicamFromAudio to N speakers (max 4)"
```

---

## Task 2: `enforceMaxHold` — wide-инжект в длинные монологи

Чистая функция в `multicam-plan.js`. Если сегмент длиннее `maxHoldSec` (default 8с) — расколоть на куски ≤ `maxHoldSec`, между ними вставить короткий wide-bridge длительностью `bridgeSec = min(maxHoldSec/4, maxAllSpeakersSec)`. Wide-сегменты сами не разбиваем, но опционально ограничиваем длиной `maxAllSpeakersSec` (default 4с) — если wide длиннее, обрезаем на конец wide-сегмента; **в этой задаче не вырезаем длинные wide** (мера 2B+), только инжектируем wide в длинные не-wide.

**Files:**
- Modify: `client/shared/multicam-plan.js`
- Modify: `tests/multicam-plan.test.mjs`

- [ ] **Step 1: Тесты (TDD)**

Добавить в `tests/multicam-plan.test.mjs` блок:
```js
describe('MulticamPlan._enforceMaxHold', () => {
  const wide = 0;
  it('splits a 20s mono segment into chunks ≤ maxHoldSec with wide bridges', () => {
    const segs = [{ tStart: 0, tEnd: 20, activeVideoTrack: 1 }];
    const out = MP._enforceMaxHold(segs, { maxHoldSec: 8, maxAllSpeakersSec: 4 }, wide);
    // Должно быть как минимум 1 wide-инжект.
    assert.ok(out.some(s => s.activeVideoTrack === wide));
    // Все не-wide сегменты ≤ maxHoldSec.
    out.filter(s => s.activeVideoTrack !== wide).forEach(s => {
      assert.ok((s.tEnd - s.tStart) <= 8 + 1e-9, 'chunk too long: ' + (s.tEnd - s.tStart));
    });
    // Не-wide track тот же (1).
    out.filter(s => s.activeVideoTrack !== wide).forEach(s => {
      assert.equal(s.activeVideoTrack, 1);
    });
    // Покрытие времени: суммарная длительность == 20с (с точностью до eps).
    const total = out.reduce((acc, s) => acc + (s.tEnd - s.tStart), 0);
    assert.ok(Math.abs(total - 20) < 1e-6, 'total duration drifted: ' + total);
    // Границы строго возрастают.
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i].tStart >= out[i - 1].tEnd - 1e-9);
    }
  });

  it('does not touch short segments', () => {
    const segs = [
      { tStart: 0, tEnd: 3, activeVideoTrack: 1 },
      { tStart: 3, tEnd: 7, activeVideoTrack: 2 },
      { tStart: 7, tEnd: 10, activeVideoTrack: 1 }
    ];
    const out = MP._enforceMaxHold(segs, { maxHoldSec: 8, maxAllSpeakersSec: 4 }, wide);
    assert.deepEqual(out, segs);
  });

  it('is no-op when maxHoldSec is 0 or absent', () => {
    const segs = [{ tStart: 0, tEnd: 20, activeVideoTrack: 1 }];
    assert.deepEqual(MP._enforceMaxHold(segs, { maxHoldSec: 0 }, wide), segs);
    assert.deepEqual(MP._enforceMaxHold(segs, {}, wide), segs);
  });

  it('does not split wide segments themselves', () => {
    const segs = [{ tStart: 0, tEnd: 20, activeVideoTrack: wide }];
    const out = MP._enforceMaxHold(segs, { maxHoldSec: 8, maxAllSpeakersSec: 4 }, wide);
    // wide остаётся одним куском
    assert.equal(out.length, 1);
    assert.equal(out[0].activeVideoTrack, wide);
  });
});
```

Запуск: упадёт — функции нет.

- [ ] **Step 2: Реализация**

В `multicam-plan.js`, добавить функцию перед `var api = {`:
```js
  /**
   * Разбивает длинные сегменты одной камеры (не-wide), вставляя короткий
   * wide-bridge между кусками — анти-монотонность Wraith «Max Camera Duration».
   * maxHoldSec — макс длительность куска одной камеры (default 8с, 0 = выкл).
   * maxAllSpeakersSec — верхний потолок длительности wide-bridge (default 4с).
   * wideVideoTrack — индекс wide-дорожки (нужен для маркировки вставок).
   *
   * Wide-сегменты сами не делим в этой функции (обрезка длинных wide — отдельная мера).
   */
  function enforceMaxHold(segments, params, wideVideoTrack) {
    var p = params || {};
    var maxHold = typeof p.maxHoldSec === 'number' ? p.maxHoldSec : 0;
    if (!segments || !segments.length || maxHold <= 0) return (segments || []).slice();
    var maxAllSpk = typeof p.maxAllSpeakersSec === 'number' ? p.maxAllSpeakersSec : 4;
    var bridgeSec = Math.min(maxHold / 4, maxAllSpk);
    if (bridgeSec <= 0) bridgeSec = Math.min(1, maxHold / 4);
    var out = [];
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      var dur = s.tEnd - s.tStart;
      // Wide и достаточно короткие — без изменений.
      if (s.activeVideoTrack === wideVideoTrack || dur <= maxHold + bridgeSec) {
        out.push({ tStart: s.tStart, tEnd: s.tEnd, activeVideoTrack: s.activeVideoTrack });
        continue;
      }
      // Сколько wide-вставок? n = floor((dur - maxHold) / (maxHold + bridgeSec)) + 1
      var n = Math.floor((dur - maxHold) / (maxHold + bridgeSec)) + 1;
      // Расставляем равномерно: chunkLen = (dur - n*bridgeSec) / (n+1).
      var chunkLen = (dur - n * bridgeSec) / (n + 1);
      var t = s.tStart;
      for (var k = 0; k < n; k++) {
        out.push({ tStart: t, tEnd: t + chunkLen, activeVideoTrack: s.activeVideoTrack });
        out.push({ tStart: t + chunkLen, tEnd: t + chunkLen + bridgeSec, activeVideoTrack: wideVideoTrack });
        t = t + chunkLen + bridgeSec;
      }
      // Последний кусок — оставшаяся длина.
      out.push({ tStart: t, tEnd: s.tEnd, activeVideoTrack: s.activeVideoTrack });
    }
    return out;
  }
```

Подключение в `buildSwitchPlan` — после `enforceMinHold` + `mergeAdjacentSame`, **до** `snapToSilences`:
```js
    /* Шаг 4: enforce min-hold */
    segments = enforceMinHold(segments, p.minHoldSec);
    segments = mergeAdjacentSame(segments);

    /* Шаг 4b: enforce max-hold (Wraith Max Camera Duration) */
    segments = enforceMaxHold(segments, p, mapping.wideVideoTrack);

    /* Шаг 5: snap к silence-границам */
```

Также добавить `maxHoldSec: 8, maxAllSpeakersSec: 4` в `DEFAULTS` (после `wideVideoTrack`). И экспорт `_enforceMaxHold: enforceMaxHold` в `api`.

- [ ] **Step 3: Тесты должны пройти**

`node --test tests/multicam-plan.test.mjs 2>&1 | tail -25` → все 4 новых + регрессия.

- [ ] **Step 4: Регрессия**

`npm test 2>&1 | tail -15` → зелёные. Если падает старый тест из-за того, что `buildSwitchPlan` теперь генерирует wide-инжекты на длинных сегментах — это **намеренное** изменение поведения. Старые тесты могли иметь длинные mono-сегменты без ожидания инжектов. Проверить именно эти тесты: добавить в них `params: { maxHoldSec: 0 }` чтобы отключить новую фичу для регрессии, **либо** обновить assertion'ы, если тест проверяет план целиком и инжекты ожидаемы. Документировать в commit message.

- [ ] **Step 5: Syntax**

`node --check client/shared/multicam-plan.js` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/shared/multicam-plan.js tests/multicam-plan.test.mjs
git commit -m "feat(multicam): enforceMaxHold inserts wide bridge on long mono segments"
```

---

## Task 3: `applyVariations` — seeded jitter границ

Чистая функция. Сдвигает каждую границу между сегментами в окне `[-jitterSec, +jitterSec]`, детерминированно из `seed` через mulberry32. Не позволяет границе пересечь половину соседнего сегмента (clamp). По умолчанию `variationsJitterSec=0` → no-op (backward-compat).

**Files:**
- Modify: `client/shared/multicam-plan.js`
- Modify: `tests/multicam-plan.test.mjs`

- [ ] **Step 1: Тесты (TDD)**

```js
describe('MulticamPlan._applyVariations', () => {
  function mkSegs() {
    return [
      { tStart: 0, tEnd: 5, activeVideoTrack: 1 },
      { tStart: 5, tEnd: 10, activeVideoTrack: 2 },
      { tStart: 10, tEnd: 15, activeVideoTrack: 1 }
    ];
  }

  it('is no-op when jitterSec is 0', () => {
    const segs = mkSegs();
    const out = MP._applyVariations(segs, 0, 42);
    assert.deepEqual(out, segs);
  });

  it('produces deterministic results for the same seed', () => {
    const a = MP._applyVariations(mkSegs(), 0.5, 42);
    const b = MP._applyVariations(mkSegs(), 0.5, 42);
    assert.deepEqual(a, b);
  });

  it('produces different boundaries for different seeds', () => {
    const a = MP._applyVariations(mkSegs(), 0.5, 1);
    const b = MP._applyVariations(mkSegs(), 0.5, 999);
    // Хотя бы одна граница должна отличаться.
    const aBoundaries = a.slice(0, -1).map(s => s.tEnd);
    const bBoundaries = b.slice(0, -1).map(s => s.tEnd);
    assert.notDeepEqual(aBoundaries, bBoundaries);
  });

  it('keeps boundaries within ±jitterSec of original', () => {
    const segs = mkSegs();
    const out = MP._applyVariations(segs, 0.5, 7);
    for (let i = 0; i < segs.length - 1; i++) {
      const drift = Math.abs(out[i].tEnd - segs[i].tEnd);
      assert.ok(drift <= 0.5 + 1e-9, 'drift exceeded jitter: ' + drift);
    }
  });

  it('does not collapse a segment past the midpoint of its neighbor', () => {
    const segs = mkSegs();
    const out = MP._applyVariations(segs, 100, 5); // абсурдно большой jitter
    // Все сегменты остаются положительной длины.
    out.forEach(s => assert.ok(s.tEnd > s.tStart, 'collapsed: ' + JSON.stringify(s)));
  });
});
```

- [ ] **Step 2: Реализация**

В `multicam-plan.js` перед `var api = {`:
```js
  /**
   * Простой PRNG mulberry32 для детерминированных variations (Phase 2B).
   * seed → unsigned int32; результат: () => float ∈ [0, 1).
   */
  function _seededRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Анти-монотонность: сдвигает каждую границу между сегментами в [-jitterSec, +jitterSec]
   * детерминированно из seed. Гарантирует, что граница не пересечёт середину
   * соседнего сегмента (чтобы сегмент не схлопнулся).
   */
  function applyVariations(segments, jitterSec, seed) {
    if (!segments || segments.length <= 1) return (segments || []).slice();
    if (!jitterSec || jitterSec <= 0) {
      return segments.map(function (s) { return { tStart: s.tStart, tEnd: s.tEnd, activeVideoTrack: s.activeVideoTrack }; });
    }
    var rand = _seededRng(seed || 1);
    var out = segments.map(function (s) { return { tStart: s.tStart, tEnd: s.tEnd, activeVideoTrack: s.activeVideoTrack }; });
    for (var i = 0; i < out.length - 1; i++) {
      var delta = (rand() * 2 - 1) * jitterSec;
      var newBoundary = out[i].tEnd + delta;
      var minB = (out[i].tStart + out[i].tEnd) / 2 + 1e-6;
      var maxB = (out[i + 1].tStart + out[i + 1].tEnd) / 2 - 1e-6;
      if (newBoundary < minB) newBoundary = minB;
      if (newBoundary > maxB) newBoundary = maxB;
      out[i].tEnd = newBoundary;
      out[i + 1].tStart = newBoundary;
    }
    return out;
  }
```

Подключение в `buildSwitchPlan` — после `enforceMaxHold`, перед `snapToSilences`:
```js
    /* Шаг 4b: enforce max-hold */
    segments = enforceMaxHold(segments, p, mapping.wideVideoTrack);

    /* Шаг 4c: variations (анти-монотонность, seeded) */
    if (p.variationsJitterSec > 0) {
      segments = applyVariations(segments, p.variationsJitterSec, p.variationsSeed);
    }

    /* Шаг 5: snap к silence-границам */
```

`DEFAULTS`: добавить `variationsJitterSec: 0, variationsSeed: 1`. Экспорт `_applyVariations: applyVariations` в `api`.

- [ ] **Step 3-5: tests/regression/syntax**

`node --test tests/multicam-plan.test.mjs` (новые 5 + старые), `npm test`, `node --check`.

- [ ] **Step 6: Commit**

```bash
git add client/shared/multicam-plan.js tests/multicam-plan.test.mjs
git commit -m "feat(multicam): applyVariations seeded boundary jitter (anti-monotony)"
```

---

## Task 4: `snapToSpeechOnset` — рез к атаке слога

Чистая функция. Дан `onsets:[t1,t2,...]` (времена начала речи в секундах) и окно `windowSec` — для каждой границы между сегментами находим ближайший onset в окне ±window и смещаем границу к `onset + offsetSec` (frame-offset из Wraith). Если onset'ов в окне нет — граница не двигается. Использовать **вместо** `snapToSilences`, если caller передал onsets; иначе fallback на текущее поведение (snapToSilences).

**Files:**
- Modify: `client/shared/multicam-plan.js`
- Modify: `tests/multicam-plan.test.mjs`

- [ ] **Step 1: Тесты (TDD)**

```js
describe('MulticamPlan._snapToSpeechOnset', () => {
  function mkSegs() {
    return [
      { tStart: 0, tEnd: 5, activeVideoTrack: 1 },
      { tStart: 5, tEnd: 10, activeVideoTrack: 2 }
    ];
  }

  it('snaps boundary to the nearest onset within window', () => {
    const out = MP._snapToSpeechOnset(mkSegs(), [4.8, 7.0], 0.5, 0);
    assert.ok(Math.abs(out[0].tEnd - 4.8) < 1e-9, 'got tEnd=' + out[0].tEnd);
    assert.equal(out[0].tEnd, out[1].tStart);
  });

  it('applies frame offset to the snap point', () => {
    const out = MP._snapToSpeechOnset(mkSegs(), [4.8], 0.5, -0.1);
    assert.ok(Math.abs(out[0].tEnd - (4.8 - 0.1)) < 1e-9);
  });

  it('leaves boundary unchanged when no onset in window', () => {
    const out = MP._snapToSpeechOnset(mkSegs(), [2.0, 8.0], 0.5, 0);
    assert.equal(out[0].tEnd, 5);
  });

  it('is no-op for empty/null onsets or zero window', () => {
    const segs = mkSegs();
    assert.deepEqual(MP._snapToSpeechOnset(segs, [], 0.5, 0), segs);
    assert.deepEqual(MP._snapToSpeechOnset(segs, null, 0.5, 0), segs);
    assert.deepEqual(MP._snapToSpeechOnset(segs, [4.8], 0, 0), segs);
  });
});
```

- [ ] **Step 2: Реализация**

В `multicam-plan.js`:
```js
  /**
   * Снап границы к ближайшему началу речи (onset) в окне ±windowSec,
   * со смещением offsetSec («frame offset» в терминологии Wraith).
   * Если onset'ов в окне нет — граница не двигается.
   */
  function snapToSpeechOnset(segments, onsets, windowSec, offsetSec) {
    if (!segments || segments.length <= 1) return (segments || []).slice();
    if (!onsets || !onsets.length || !windowSec || windowSec <= 0) {
      return segments.map(function (s) { return { tStart: s.tStart, tEnd: s.tEnd, activeVideoTrack: s.activeVideoTrack }; });
    }
    var os = typeof offsetSec === 'number' ? offsetSec : 0;
    var out = segments.map(function (s) { return { tStart: s.tStart, tEnd: s.tEnd, activeVideoTrack: s.activeVideoTrack }; });
    for (var i = 0; i < out.length - 1; i++) {
      var boundary = out[i].tEnd;
      var bestOnset = null;
      var bestDist = windowSec + 1;
      for (var j = 0; j < onsets.length; j++) {
        var d = Math.abs(onsets[j] - boundary);
        if (d < bestDist && d <= windowSec) { bestDist = d; bestOnset = onsets[j]; }
      }
      if (bestOnset !== null) {
        var newB = bestOnset + os;
        out[i].tEnd = newB;
        out[i + 1].tStart = newB;
      }
    }
    return out;
  }
```

Подключение в `buildSwitchPlan` — заменить шаг 5:
```js
    /* Шаг 5: snap границ — приоритет onset'ам речи, fallback на silence */
    if (p.speechOnsets && p.speechOnsets.length && p.snapWindowSec > 0) {
      segments = snapToSpeechOnset(segments, p.speechOnsets, p.snapWindowSec, p.frameOffsetSec || 0);
    } else if (silences && silences.length && p.snapWindowSec > 0) {
      segments = snapToSilences(segments, silences, p.snapWindowSec);
    }
```

`DEFAULTS`: добавить `frameOffsetSec: 0`. Экспорт `_snapToSpeechOnset: snapToSpeechOnset` в `api`.

NB по передаче onsets: caller (`multicamFromAudio`) пробрасывает `params.speechOnsets` если есть — в Phase 2B мы их **не вычисляем** (UI и derivation из транскрипт-границ — это Phase 2C). Функция готова и тестирована; путь активируется когда onsets появятся.

- [ ] **Step 3-5: tests/regression/syntax**

- [ ] **Step 6: Commit**

```bash
git add client/shared/multicam-plan.js tests/multicam-plan.test.mjs
git commit -m "feat(multicam): snapToSpeechOnset cuts to next speaker attack"
```

---

## Done criteria (Phase 2B)

- `multicamFromAudio` строит динамический mapping ≤ 4 спикеров; валидация ≥2V + ≥1A.
- `enforceMaxHold`, `applyVariations`, `snapToSpeechOnset` — unit-tested, подключены в `buildSwitchPlan` через дефолты (`maxHoldSec=8` вкл, `variationsJitterSec=0` выкл, onsets отсутствуют → fallback на silences).
- `npm test` зелёный; `node --check` чистый на обоих модулях.
- `applyMulticamCuts` host-контракт не изменён.
- Старый `multicamFromTranscript` не тронут.

**Готово к ручному тесту Phase 2B** — пользователь проверяет в Premiere на 3V+2A (regression) и 5V+4A (новая фича) подкастах.

---

## Self-review

**Spec coverage vs roadmap Phase 2B:**
- 2B.1 max-hold + wide injection → Task 2 ✓
- 2B.2 variations seeded → Task 3 ✓
- 2B.3 frame offset / snap to onset → Task 4 ✓
- Дополнительно: N-speaker generalization (пользовательский запрос на ≤4 спикеров) → Task 1.

**Placeholder scan:** конкретные сигнатуры, тесты verbatim, точные места врезок в `buildSwitchPlan`. Нет TBD, нет «handle edge cases», нет «similar to».

**Type consistency:** все три фичи — `(segments, params|primitives, …) → segments` той же формы `[{tStart, tEnd, activeVideoTrack}]`. Подключение через дефолты обеспечивает backward-compat: `variationsJitterSec=0` и отсутствие `speechOnsets` означают, что старые тесты увидят то же поведение **кроме** mono-сегментов длиннее 8с (Task 2). Старые тесты, опирающиеся на длинные mono-сегменты, перечислим/обновим в Task 2 Step 4.

**Risks:**
- Task 2 интрузивен в `buildSwitchPlan` pipeline — старые тесты с длинным mono могут начать выдавать wide-вставки. Митigation: явно перечислены в Step 4.
- Task 3 завязан на `Math.imul` — это ES2015, но широко поддержан в CEP-runtime (Chromium). Если возникнут проблемы — заменим на ручную int32-multiplication ES5.
- Task 4 — onsets в Phase 2B не подаются, путь активируется только в 2C. Это намеренно: пишем готовую функцию под будущий UI; в текущей сборке fallback на silences.
