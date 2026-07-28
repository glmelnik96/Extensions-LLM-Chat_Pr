# Валидность кэша транскрипта — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Панель честно детектирует ручные правки таймлайна после транскрибации (отпечаток аудио-дорожек), переводит ключ кэша на sequenceID и наследует транскрипт бэкап-секвенциям.

**Architecture:** Host (ES3) считает FNV-1a-хэш по аудиоклипам и возвращает его в лёгком poll-вызове и снапшоте; панель штампует отпечаток в entry при транскрибации, сравнивает в polling (LED) и перед запуском инструментов (confirm); ContextStore получает ID-first поиск с миграцией на лету.

**Tech Stack:** ExtendScript ES3 (`host/premiere.jsx`), ES5 браузерный JS (`client/unified/panel.js`, `client/shared/context-store.js`), Node test runner (`node --test`), live-валидация через `node tools/cep-debug.mjs`.

**Спека:** `docs/superpowers/specs/2026-07-28-transcript-cache-validity-design.md`

**Правила работы:** работаем на main (устоявшийся workflow — CDP требует файлов в каталоге расширения). Коммиты в конце задач — с формулировкой из шага; пуш НЕ делать без отдельной отмашки. ES3: НЕТ `trim`/`forEach`/`map`/`Object.keys` в host-коде.

---

### Task 1: Host — FNV-1a и строка отпечатка (+ unit-тест извлечением)

**Files:**
- Modify: `host/premiere.jsx` (вставка перед `getSequenceRegionInfo`, строка ~1144)
- Test: `tests/host-audio-fingerprint.test.mjs` (create)

- [x] **Step 1: Написать падающий тест**

Создать `tests/host-audio-fingerprint.test.mjs`. Тест извлекает функции из `premiere.jsx` по маркерам `/* __FP_HELPERS_BEGIN__ */` … `/* __FP_HELPERS_END__ */` и исполняет в Node (они pure-ES3):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsxSrc = fs.readFileSync(path.join(__dirname, '..', 'host', 'premiere.jsx'), 'utf8');

function extractHelpers() {
  const m = jsxSrc.match(/\/\* __FP_HELPERS_BEGIN__ \*\/([\s\S]*?)\/\* __FP_HELPERS_END__ \*\//);
  if (!m) throw new Error('Маркеры __FP_HELPERS_*__ не найдены в premiere.jsx');
  const fn = new Function(m[1] + '\nreturn { fnv1a: _extFnv1a, fpString: _extAudioFpString };');
  return fn();
}

/* Мок структур ExtendScript: коллекции = { numTracks/numItems, 0: …, 1: … } */
function clip(track, mediaPath, startTicks, endTicks, inTicks) {
  return {
    projectItem: { getMediaPath: function () { return mediaPath; } },
    name: 'clip',
    start: { ticks: String(startTicks) },
    end: { ticks: String(endTicks) },
    inPoint: { ticks: String(inTicks) }
  };
}
function seqWith(trackClipLists) {
  const at = { numTracks: trackClipLists.length };
  for (let t = 0; t < trackClipLists.length; t++) {
    const clipsObj = { numItems: trackClipLists[t].length };
    for (let c = 0; c < trackClipLists[t].length; c++) clipsObj[c] = trackClipLists[t][c];
    at[t] = { clips: clipsObj };
  }
  return { audioTracks: at, videoTracks: { numTracks: 99 } }; /* videoTracks не должен читаться */
}

test('fnv1a: известные векторы FNV-1a 32-bit', () => {
  const { fnv1a } = extractHelpers();
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(fnv1a('a'), 'e40c292c');
  assert.equal(fnv1a('foobar'), 'bf9cf968');
});

test('fnv1a: кириллица детерминирована и различима', () => {
  const { fnv1a } = extractHelpers();
  assert.equal(fnv1a('секвенция'), fnv1a('секвенция'));
  assert.notEqual(fnv1a('секвенция'), fnv1a('секвенцiя'));
  assert.match(fnv1a('секвенция'), /^[0-9a-f]{8}$/);
});

test('fpString: детерминированная сборка, формат поля через |, клипы через ;', () => {
  const { fpString } = extractHelpers();
  const seq = seqWith([[clip(0, 'C:\\a.wav', 0, 254016000000, 0)], [clip(1, '/b.wav', 100, 200, 50)]]);
  assert.equal(
    fpString(seq),
    '0|C:/a.wav|0|254016000000|0;1|/b.wav|100|200|50'
  );
});

test('fpString: чувствителен к каждому полю аудиоклипа', () => {
  const { fpString } = extractHelpers();
  const base = () => seqWith([[clip(0, 'C:/a.wav', 0, 1000, 0)]]);
  const ref = fpString(base());
  let s = base(); s.audioTracks[0].clips[0].start.ticks = '1'; assert.notEqual(fpString(s), ref);
  s = base(); s.audioTracks[0].clips[0].end.ticks = '999'; assert.notEqual(fpString(s), ref);
  s = base(); s.audioTracks[0].clips[0].inPoint.ticks = '5'; assert.notEqual(fpString(s), ref);
  s = base(); s.audioTracks[0].clips[0].projectItem = { getMediaPath: function () { return 'C:/b.wav'; } };
  assert.notEqual(fpString(s), ref);
});

test('fpString: fallback на clip.name при недоступном mediaPath; пустая секвенция → пустая строка', () => {
  const { fpString } = extractHelpers();
  const s = seqWith([[clip(0, 'x', 0, 1, 0)]]);
  s.audioTracks[0].clips[0].projectItem = null;
  assert.equal(fpString(s), '0|clip|0|1|0');
  assert.equal(fpString(seqWith([])), '');
});
```

- [x] **Step 2: Прогнать — убедиться, что падает**

Run: `node --test tests/host-audio-fingerprint.test.mjs`
Expected: FAIL «Маркеры __FP_HELPERS_*__ не найдены».

- [x] **Step 3: Реализовать хелперы в premiere.jsx**

Вставить в `host/premiere.jsx` ПЕРЕД комментарием к `getSequenceRegionInfo` (строка ~1144):

```js
/* __FP_HELPERS_BEGIN__ */
/**
 * FNV-1a 32-bit по код-юнитам строки (ES3: умножение на 16777619 через сдвиги,
 * суммы точны в double до 2^53, >>>0 усекает по модулю 2^32). Возврат — 8 hex.
 */
function _extFnv1a(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h = h ^ str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  var hex = h.toString(16);
  while (hex.length < 8) hex = '0' + hex;
  return hex;
}

/**
 * Строка-отпечаток АУДИО-дорожек секвенции: по клипу
 * «trackIdx|mediaPath|start.ticks|end.ticks|inPoint.ticks», клипы через «;».
 * Тики (целые), не секунды — без float-сравнений. Видео-дорожки не участвуют:
 * транскрипт — про звук (спека 2026-07-28). Известное ограничение V1:
 * mute/громкость НЕ входят (позиции клипов не двигают).
 */
function _extAudioFpString(seq) {
  var parts = [];
  for (var t = 0; t < seq.audioTracks.numTracks; t++) {
    var tr = seq.audioTracks[t];
    var n = tr.clips.numItems;
    for (var c = 0; c < n; c++) {
      var cl = tr.clips[c];
      if (!cl) continue;
      var mp = '';
      try {
        var pi = cl.projectItem;
        if (pi && typeof pi.getMediaPath === 'function') mp = String(pi.getMediaPath() || '');
        else if (pi && pi.mediaPath) mp = String(pi.mediaPath);
      } catch (eMP) {}
      if (!mp) { try { mp = String(cl.name || ''); } catch (eN) {} }
      var st = '', en = '', ip = '';
      try { st = String(cl.start.ticks); } catch (eS) {}
      try { en = String(cl.end.ticks); } catch (eE) {}
      try { ip = String(cl.inPoint.ticks); } catch (eI) {}
      parts[parts.length] = t + '|' + mp.replace(/\\/g, '/') + '|' + st + '|' + en + '|' + ip;
    }
  }
  return parts.join(';');
}

/** Хэш-отпечаток аудио-таймлайна секвенции; null при сбое. */
function _extAudioFingerprint(seq) {
  try { return _extFnv1a(_extAudioFpString(seq)); } catch (eF) { return null; }
}
/* __FP_HELPERS_END__ */
```

Внимание: `_extAudioFingerprint` вне зоны извлечения теста не нужен — но он внутри маркеров, `new Function` его тоже определит, это безвредно.

- [x] **Step 4: Прогнать тест — должен пройти**

Run: `node --test tests/host-audio-fingerprint.test.mjs`
Expected: PASS (5 тестов).

- [x] **Step 5: Синтаксис + полный набор**

Run: `node --check host/premiere.jsx && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: без ошибок; fail 0.

- [x] **Step 6: Commit**

```bash
git add host/premiere.jsx tests/host-audio-fingerprint.test.mjs
git commit -m "feat(host): FNV-1a отпечаток аудио-дорожек таймлайна (+unit через извлечение из jsx)"
```

---

### Task 2: Host — sequenceId + audioFp в getSequenceRegionInfo и getTimelineSnapshot

**Files:**
- Modify: `host/premiere.jsx:20` (версия), `:1122-1138` (снапшот), `:1150-1168` (region info)

- [x] **Step 1: Версия хоста**

Строка 20: `$._EXT_PRM_.version = '2.15.1';` → `'2.16.0'`.

- [x] **Step 2: getSequenceRegionInfo — добавить поля**

В `$._EXT_PRM_.getSequenceRegionInfo` (строка ~1150) перед `return JSON.stringify({…})` добавить:

```js
    var sid = '';
    try { sid = String(seq.sequenceID); } catch (eSid) {}
    var afp = _extAudioFingerprint(seq);
```

и расширить возвращаемый объект:

```js
    return JSON.stringify({
      ok: true,
      sequenceName: seq.name || '',
      sequenceId: sid,
      audioFp: afp,
      sequenceInSec: inSec,
      sequenceOutSec: outSec
    });
```

- [x] **Step 3: getTimelineSnapshot — те же поля**

В финальном `return JSON.stringify({…})` `getTimelineSnapshot` (строка ~1122) добавить после `sequenceName: seq.name,`:

```js
      sequenceId: (function () { try { return String(seq.sequenceID); } catch (eSid) { return ''; } })(),
      audioFp: _extAudioFingerprint(seq),
```

- [x] **Step 4: Проверка синтаксиса**

Run: `node --check host/premiere.jsx`
Expected: тишина (OK).

- [x] **Step 5: Live-проверка полей (CDP)**

Run: `node tools/cep-debug.mjs hardreload` затем `node tools/cep-debug.mjs host "$._EXT_PRM_.getSequenceRegionInfo()"`
Expected: JSON содержит `sequenceId` (непустой) и `audioFp` (8 hex) при открытой секвенции.

- [x] **Step 6: Commit**

```bash
git add host/premiere.jsx
git commit -m "feat(host): sequenceId + audioFp в getSequenceRegionInfo/getTimelineSnapshot (2.16.0)"
```

---

### Task 3: ContextStore — ID-first поиск, миграция на лету, updateTranscriptFingerprint, kind в событии

**Files:**
- Modify: `client/shared/context-store.js:191-197` (notifyTranscriptShifted), `:498` и `:520` (вызовы), `:524-544` (findTranscriptEntry + новый метод)
- Test: `tests/context-store.test.mjs` (append)

- [x] **Step 1: Написать падающие тесты**

Добавить в конец `tests/context-store.test.mjs` (использует существующий `loadContextStoreWithTempRoot` из `tests/load-context-store.mjs`; PID любой, напр. `'p1'`):

```js
test('findTranscriptEntry: ID-first — прямое попадание по seqId', () => {
  const { ContextStore, cleanup } = loadContextStoreWithTempRoot();
  try {
    ContextStore.setTranscriptEntry('p1', 'seq-123', { segments: [{ startSec: 0, endSec: 1, text: 'x' }] });
    const f = ContextStore.findTranscriptEntry('p1', 'Другое имя', 'seq-123');
    assert.ok(f.entry);
    assert.equal(f.matchedKey, 'seq-123');
  } finally { cleanup(); }
});

test('findTranscriptEntry: legacy-запись по имени мигрирует на seqId', () => {
  const { ContextStore, cleanup } = loadContextStoreWithTempRoot();
  try {
    ContextStore.setTranscriptEntry('p1', 'Моя секвенция', { segments: [{ startSec: 0, endSec: 1, text: 'x' }] });
    const f = ContextStore.findTranscriptEntry('p1', 'Моя секвенция', 'seq-777');
    assert.ok(f.entry);
    assert.equal(f.matchedKey, 'seq-777');           /* перепривязано */
    const map = ContextStore.getTranscriptCache('p1');
    assert.ok(map['seq-777']);
    assert.equal(map['Моя секвенция'], undefined);   /* старый ключ удалён */
    assert.equal(map['seq-777'].seqId, 'seq-777');
    assert.equal(map['seq-777'].seqName, 'Моя секвенция');
  } finally { cleanup(); }
});

test('findTranscriptEntry: поиск по имени находит ID-ключёванную запись через entry.seqName', () => {
  const { ContextStore, cleanup } = loadContextStoreWithTempRoot();
  try {
    ContextStore.setTranscriptEntry('p1', 'seq-42', { seqName: 'Интервью', segments: [{ startSec: 0, endSec: 1, text: 'x' }] });
    const f = ContextStore.findTranscriptEntry('p1', 'интервью'); /* только имя, без ID, другой регистр */
    assert.ok(f.entry);
    assert.equal(f.matchedKey, 'seq-42');
  } finally { cleanup(); }
});

test('findTranscriptEntry: без seqId поведение прежнее (REELS-регрессия)', () => {
  const { ContextStore, cleanup } = loadContextStoreWithTempRoot();
  try {
    ContextStore.setTranscriptEntry('p1', 'Reels 1', { any: 1 });
    const f = ContextStore.findTranscriptEntry('p1', ' reels 1 ');
    assert.ok(f.entry);
    assert.equal(f.matchedKey, 'Reels 1');
  } finally { cleanup(); }
});

test('updateTranscriptFingerprint: пишет timelineFp, не трогая остальное', () => {
  const { ContextStore, cleanup } = loadContextStoreWithTempRoot();
  try {
    ContextStore.setTranscriptEntry('p1', 'seq-9', { segments: [{ startSec: 0, endSec: 1, text: 'x' }], topics: [1] });
    assert.equal(ContextStore.updateTranscriptFingerprint('p1', 'имя', 'seq-9', 'aabbccdd'), true);
    const e = ContextStore.getTranscriptCache('p1')['seq-9'];
    assert.equal(e.timelineFp.hash, 'aabbccdd');
    assert.ok(e.timelineFp.at > 0);
    assert.deepEqual(e.topics, [1]);
    assert.equal(ContextStore.updateTranscriptFingerprint('p1', 'нет такой', 'seq-none', 'ff'), false);
  } finally { cleanup(); }
});
```

- [x] **Step 2: Прогнать — падают**

Run: `node --test tests/context-store.test.mjs`
Expected: FAIL новые тесты (мигр./seqName/updateTranscriptFingerprint не реализованы).

- [x] **Step 3: Реализация в context-store.js**

3a. `notifyTranscriptShifted` (строка 191) — параметр kind в detail:

```js
  function notifyTranscriptShifted(kind) {
    try {
      if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
        document.dispatchEvent(new CustomEvent('omc:transcript-rippled', { detail: { kind: kind || 'ripple' } }));
      }
    } catch (e) {}
  }
```

Вызов в `applyRippleDeletionsToTranscript` (строка 498): `notifyTranscriptShifted('ripple');`
Вызов в `markTranscriptStale` (строка 520): `notifyTranscriptShifted('stale');`

3b. Заменить `findTranscriptEntry` (строки 528-544) на:

```js
    /**
     * Поиск entry: сначала по seqId (стабильный Premiere sequenceID), затем
     * legacy-цепочка по имени (точное → без регистра → по entry.seqName).
     * При находке legacy-записи по имени с известным seqId — миграция на лету:
     * entry перепривязывается к seqId, старый ключ удаляется (спека 2026-07-28).
     * @returns {{ entry: *, matchedKey: string|null }}
     */
    findTranscriptEntry: function (panelId, sequenceKey, seqId) {
      var map = this.getTranscriptCache(panelId);
      var idKey = normSeqKey(seqId);
      if (idKey && map[idKey]) return { entry: map[idKey], matchedKey: idKey };
      var want = normSeqKey(sequenceKey);
      if (!want && !idKey) return { entry: null, matchedKey: null };
      var hit = null;
      if (want) {
        if (map[want]) hit = { entry: map[want], matchedKey: want };
        if (!hit) {
          var k, low = want.toLowerCase();
          for (k in map) {
            if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
            if (normSeqKey(k).toLowerCase() === low) { hit = { entry: map[k], matchedKey: k }; break; }
          }
        }
        if (!hit) {
          /* запись уже ключёвана по ID — ищем по сохранённому имени */
          var k2;
          for (k2 in map) {
            if (!Object.prototype.hasOwnProperty.call(map, k2)) continue;
            var e2 = map[k2];
            if (e2 && e2.seqName && normSeqKey(e2.seqName).toLowerCase() === low) { hit = { entry: e2, matchedKey: k2 }; break; }
          }
        }
      }
      if (!hit) return { entry: null, matchedKey: null };
      if (idKey && hit.matchedKey !== idKey) {
        /* миграция: перепривязать к стабильному ID */
        var entry = shallowCopy(hit.entry);
        entry.seqId = idKey;
        if (!entry.seqName && want) entry.seqName = want;
        delete map[hit.matchedKey];
        map[idKey] = entry;
        this.setTranscriptCache(panelId, map);
        return { entry: entry, matchedKey: idKey };
      }
      return hit;
    },

    /** Обновить отпечаток таймлайна у entry (после наших ripple-правок). */
    updateTranscriptFingerprint: function (panelId, sequenceKey, seqId, fpHash) {
      if (!fpHash) return false;
      var found = this.findTranscriptEntry(panelId, sequenceKey, seqId);
      if (!found || !found.entry) return false;
      var entry = shallowCopy(found.entry);
      entry.timelineFp = { hash: String(fpHash), at: Date.now() };
      var map = this.getTranscriptCache(panelId);
      map[found.matchedKey] = entry;
      return this.setTranscriptCache(panelId, map);
    },
```

Важно: в тесте миграции `setTranscriptEntry('p1','Моя секвенция',…)` запись без `seqName` — миграция берёт `want` («Моя секвенция» уже нормализовано) в `entry.seqName`.

- [x] **Step 4: Прогнать тесты**

Run: `node --test tests/context-store.test.mjs`
Expected: PASS все (старые + 5 новых).

- [x] **Step 5: Полный набор**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: fail 0.

- [x] **Step 6: Commit**

```bash
git add client/shared/context-store.js tests/context-store.test.mjs
git commit -m "feat(cache): ключ транскрипта по sequenceID с миграцией на лету + updateTranscriptFingerprint"
```

---

### Task 4: panel.js — штамповка seqId/seqName/отпечатков при транскрибации и аудио-анализе

**Files:**
- Modify: `client/unified/panel.js:6549` (ключ transcribe), `:6581-6589` (штамп), `:6661` (сообщение), `:6733` (ключ audio-only), `:6742-6767` (штамп+merge)

- [x] **Step 1: onTranscribeTimeline — ключ и штамп**

Строка 6549: `var key = snap.sequenceName || 'sequence';` →

```js
      var key = snap.sequenceId || snap.sequenceName || 'sequence';
      var seqDisplayName = snap.sequenceName || 'sequence';
```

В блок try (строки 6581-6588), после `norm.analyzedRegion = regionT;` добавить (внутри того же try):

```js
        /* Спека 2026-07-28: идентичность + отпечаток аудио-таймлайна на момент
           экспорта. timelineFp — за транскриптом; analyzedFp — за аудио-анализом
           (обновляется независимо «⚡ Анализом»). */
        norm.seqId = snap.sequenceId || '';
        norm.seqName = seqDisplayName;
        if (snap.audioFp) {
          norm.timelineFp = { hash: snap.audioFp, at: Date.now() };
          if (norm.audioAnalysis) norm.audioAnalysis.analyzedFp = snap.audioFp;
        }
```

Строка 6661: `statusUi.show('Транскрипт в кэше: «' + key + '»', false);` → `statusUi.show('Транскрипт в кэше: «' + seqDisplayName + '»', false);`

- [x] **Step 2: onAudioOnlyAnalyze — ключ и штамп**

Строка 6733: `var key = snap.sequenceName || 'sequence';` →

```js
      var key = snap.sequenceId || snap.sequenceName || 'sequence';
```

В блок строк 6742-6747 (analyzedRegion) добавить после установки `analyzedRegion`:

```js
      if (entry && entry.audioAnalysis && snap.audioFp) {
        entry.audioAnalysis.analyzedFp = snap.audioFp;
      }
      if (entry) {
        entry.seqId = snap.sequenceId || '';
        entry.seqName = snap.sequenceName || 'sequence';
      }
```

Строка 6752: `var existing = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key);` → `var existing = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, snap.sequenceName || '', snap.sequenceId || '');`

В merge-ветке (строка 6756) `Object.assign` уже переносит существующий `timelineFp` из `existing.entry` (транскрипт не трогали — его отпечаток должен остаться СТАРЫМ), а новый `audioAnalysis` несёт свежий `analyzedFp`. Добавить в объект Object.assign после `analysisOnly: false`:

```js
          seqId: snap.sequenceId || existing.entry.seqId || '',
          seqName: snap.sequenceName || existing.entry.seqName || ''
```

И заменить ключ записи merge-ветки (6762): `ContextStore.setTranscriptEntry(TRANSCRIPT_PID, key, merged);` → `ContextStore.setTranscriptEntry(TRANSCRIPT_PID, existing.matchedKey || key, merged);` (existing уже мигрирован на ID Task 3 — matchedKey и key совпадут; страховка от рассинхрона).

- [x] **Step 3: Синтаксис + полный набор**

Run: `node --check client/unified/panel.js && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: OK; fail 0.

- [x] **Step 4: Commit**

```bash
git add client/unified/panel.js
git commit -m "feat(transcribe): entry получает seqId/seqName + отпечатки таймлайна (timelineFp/analyzedFp)"
```

---

### Task 5: panel.js — LED учитывает отпечаток (мягкая индикация)

**Files:**
- Modify: `client/unified/panel.js:7342-7379` (_applyToolsLedForSeq)

- [x] **Step 1: Расширить _applyToolsLedForSeq**

Внутри try (после вычисления `staleAudio`/`staleTranscript`, строка ~7360) добавить fp-сравнение. Итоговый вид блока try:

```js
      var fpStale = false; /* мягкий флаг: только LED, карточки НЕ блокируем (спека 2026-07-28) */
      try {
        if (seqName || (snap && snap.sequenceId)) {
          var f = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, seqName, (snap && typeof snap === 'object' && snap.sequenceId) || '');
          if (f && f.entry) {
            hasTranscript = !!(f.entry.segments && f.entry.segments.length);
            hasAudio = hasTranscript || !!f.entry.audioAnalysis;
            var arA = (f.entry.audioAnalysis && f.entry.audioAnalysis.analyzedRegion) || f.entry.analyzedRegion;
            var arT = f.entry.analyzedRegion || (f.entry.audioAnalysis && f.entry.audioAnalysis.analyzedRegion);
            if (hasAudio) staleAudio = _regionStale(arA, snap);
            if (hasTranscript) staleTranscript = _regionStale(arT, snap);
            /* Отпечаток аудио-таймлайна: ловит РУЧНЫЕ правки в Premiere, которые
               панель не видит (спека 2026-07-28). Legacy-entry без fp → «неизвестно»,
               молчим. Собственные правки панели fp обновляют (см. ripple-listener). */
            var curFp = (snap && typeof snap === 'object' && snap.audioFp) || null;
            if (curFp) {
              if (hasTranscript && f.entry.timelineFp && f.entry.timelineFp.hash && f.entry.timelineFp.hash !== curFp) fpStale = true;
              var aFp = f.entry.audioAnalysis && f.entry.audioAnalysis.analyzedFp;
              if (!fpStale && aFp && aFp !== curFp) fpStale = true;
            }
          }
        }
      } catch (e) { /* findTranscriptEntry не должен падать */ }
```

(Существующие строки внутри try сохранить как есть, добавляются объявление `fpStale` перед try, передача `snap.sequenceId` в findTranscriptEntry и fp-блок.)

- [x] **Step 2: LED-ветка**

В цепочке if/else (строки 7365-7375) добавить ветку ПЕРЕД финальным `else`:

```js
      } else if (fpStale) {
        /* мягко: жёлтый LED, кнопки живы — честность обеспечит confirm перед запуском */
        toolsSetLed('busy', 'транскрипт устарел — таймлайн изменился' + seqLabel);
      } else {
```

- [x] **Step 3: Синтаксис**

Run: `node --check client/unified/panel.js`
Expected: OK.

- [x] **Step 4: Commit**

```bash
git add client/unified/panel.js
git commit -m "feat(tools): LED детектирует ручные правки таймлайна по отпечатку (мягкая индикация)"
```

---

### Task 6: panel.js — confirm перед запуском инструмента по устаревшему кэшу

**Files:**
- Modify: `client/unified/panel.js:10198+` (toolsRunTool), CSS-класс в `client/unified/index2.html`

- [x] **Step 1: Хелпер проверки (перед toolsRunTool)**

```js
    /* Спека 2026-07-28, мягкий гейт: свежий отпечаток прямо перед запуском
       (не полагаемся на последний poll — окно 4с). При сбое опроса НЕ блокируем:
       ложный отказ хуже честного предупреждения. mode: 'transcript' → timelineFp,
       'audio' → audioAnalysis.analyzedFp. */
    function _confirmCacheFresh(mode) {
      return new Promise(function (resolve) {
        var done = false;
        var t = setTimeout(function () { if (!done) { done = true; resolve(true); } }, 12000);
        function finish(v) { if (!done) { done = true; clearTimeout(t); resolve(v); } }
        try {
          PremiereBridge.getSequenceRegionInfo(function (err, info) {
            try {
              if (err || !info || !info.ok || !info.audioFp) { finish(true); return; }
              var f = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, info.sequenceName || '', info.sequenceId || '');
              var entry = f && f.entry;
              if (!entry) { finish(true); return; } /* «нет транскрипта» отработают гейты карточек */
              var stored = null;
              if (mode === 'audio') stored = entry.audioAnalysis && entry.audioAnalysis.analyzedFp;
              else stored = entry.timelineFp && entry.timelineFp.hash;
              if (stored && stored !== info.audioFp) {
                var okGo = window.confirm(
                  'Таймлайн изменился после ' + (mode === 'audio' ? 'аудио-анализа' : 'транскрибации') +
                  ' — тайминги могут не совпадать.\n\nПродолжить по устаревшим данным?'
                );
                if (!okGo) {
                  toolsStatusUi.show(mode === 'audio'
                    ? 'Рекомендуется «⚡ Анализ аудио» заново.'
                    : 'Рекомендуется повторная транскрибация.', false);
                  setTimeout(function () { toolsStatusUi.hide(); }, 4000);
                  var tb = document.getElementById('tools-btn-transcribe');
                  if (tb && mode !== 'audio') {
                    tb.classList.add('attn');
                    setTimeout(function () { tb.classList.remove('attn'); }, 3000);
                  }
                }
                finish(okGo);
                return;
              }
              finish(true);
            } catch (e) { finish(true); }
          });
        } catch (e2) { finish(true); }
      });
    }
```

- [x] **Step 2: Вставить проверку в toolsRunTool**

В начало `toolsRunTool` (строка ~10199, после `toolsHideAllProposals();`):

```js
      /* Мягкий гейт по отпечатку (спека 2026-07-28). По timelineFp — потребители
         сегментов транскрипта; по analyzedFp — потребители кэша audioAnalysis
         (silences/jumps: их proposal строится из кэшированных координат).
         trim-edges/gaps/multicam/loudnorm работают по свежему снимку — не проверяем. */
      var FP_TRANSCRIPT_TOOLS = { fillers: 1, profanity: 1, speakers: 1, reels: 1, chapters: 1, 'subtitles-anim': 1, 'subtitles-static': 1 };
      var FP_AUDIO_TOOLS = { silences: 1, jumps: 1 };
      if (FP_TRANSCRIPT_TOOLS[toolName]) {
        if (!(await _confirmCacheFresh('transcript'))) return;
      } else if (FP_AUDIO_TOOLS[toolName]) {
        if (!(await _confirmCacheFresh('audio'))) return;
      }
```

- [x] **Step 3: CSS подсветки кнопки транскрибации**

В `<style>` `client/unified/index2.html` (рядом с существующими tools-стилями) добавить:

```css
      @keyframes attn-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,193,7,.7); } 50% { box-shadow: 0 0 0 6px rgba(255,193,7,0); } }
      .attn { animation: attn-pulse 1s ease-in-out 3; }
```

- [x] **Step 4: Синтаксис + полный набор**

Run: `node --check client/unified/panel.js && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: OK; fail 0.

- [x] **Step 5: Commit**

```bash
git add client/unified/panel.js client/unified/index2.html
git commit -m "feat(tools): confirm перед запуском по устаревшему транскрипту/анализу (мягкий гейт)"
```

---

### Task 7: panel.js — авто-обновление отпечатка после собственных ripple-правок

**Files:**
- Modify: `client/unified/panel.js:7318-7328` (listener omc:transcript-rippled)

- [x] **Step 1: Расширить listener**

Заменить обработчик (строка 7318) на:

```js
    document.addEventListener('omc:transcript-rippled', function (ev) {
      try {
        _waveState = null;
        var ws2 = document.getElementById('wave-silences'); if (ws2) ws2.hidden = true;
        var wj2 = document.getElementById('wave-jumps'); if (wj2) wj2.hidden = true;
        var ls2 = document.getElementById('wave-legend-silences'); if (ls2) ls2.hidden = true;
        var lj2 = document.getElementById('wave-legend-jumps'); if (lj2) lj2.hidden = true;
        toolsHideAllProposals();
        /* kind==='ripple': транскрипт честно пересчитан под новый таймлайн →
           освежаем отпечаток, иначе наша же правка выглядела бы как «устарел».
           kind==='stale' (unknown shift): fp НЕ трогаем — расхождение желанно. */
        var kind = ev && ev.detail && ev.detail.kind;
        if (kind === 'ripple') {
          PremiereBridge.getSequenceRegionInfo(function (err, info) {
            try {
              if (!err && info && info.ok && info.audioFp) {
                ContextStore.updateTranscriptFingerprint(TRANSCRIPT_PID, info.sequenceName || '', info.sequenceId || '', info.audioFp);
              }
            } catch (eU) {}
            try { window.toolsRefreshLed(); } catch (eL) {}
          });
        } else {
          window.toolsRefreshLed();
        }
      } catch (e) {}
    });
```

(Было: безусловный `window.toolsRefreshLed();` в конце — теперь он в обеих ветках, после обновления fp.)

- [x] **Step 2: Синтаксис + полный набор**

Run: `node --check client/unified/panel.js && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: OK; fail 0.

- [x] **Step 3: Commit**

```bash
git add client/unified/panel.js
git commit -m "feat(cache): отпечаток обновляется после собственных ripple-правок панели"
```

---

### Task 8: panel.js — бэкап-секвенция наследует транскрипт

**Files:**
- Modify: `client/unified/panel.js:3003-3008` (_makeSequenceCheckpoint)

- [x] **Step 1: Копия entry под sequenceID бэкапа**

В `_makeSequenceCheckpoint`, в блоке try (строки 3003-3008), после `if (_ent) _transcriptCheckpoints[...] = …;` добавить:

```js
          /* Спека 2026-07-28: бэкап наследует транскрипт под СВОИМ sequenceID —
             откат на бэкап = транскрипт валиден сразу (клип-раскладка идентична,
             отпечаток совпадает). */
          if (_ent && data.backupId) {
            try {
              var _bkEnt = JSON.parse(JSON.stringify(_ent));
              _bkEnt.seqId = String(data.backupId);
              _bkEnt.seqName = String(data.backupName || '');
              ContextStore.setTranscriptEntry(TRANSCRIPT_PID, String(data.backupId), _bkEnt);
            } catch (eBk) {}
          }
```

- [x] **Step 2: Синтаксис + полный набор**

Run: `node --check client/unified/panel.js && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: OK; fail 0.

- [x] **Step 3: Commit**

```bash
git add client/unified/panel.js
git commit -m "feat(backup): бэкап-секвенция наследует транскрипт под своим sequenceID"
```

---

### Task 9: Live-валидация (CDP) и финал

**Files:** нет правок кода (кроме фиксов найденных багов); скрипты в `tmp/`

- [x] **Step 1: Reload панели и хоста**

Run: `node tools/cep-debug.mjs hardreload`
Затем: `node tools/cep-debug.mjs host "$._EXT_PRM_.version"` → Expected: `2.16.0`.

- [x] **Step 2: Отпечаток стабилен и меняется правильно**

- `node tools/cep-debug.mjs host "$._EXT_PRM_.getSequenceRegionInfo()"` дважды → `audioFp` одинаков (детерминизм).
- Ручной рез аудио в Premiere (лезвие/ripple на A1) → повторный вызов → `audioFp` ИЗМЕНИЛСЯ.
- Ctrl+Z (откат реза) → `audioFp` вернулся к исходному.
- Правка ТОЛЬКО видео-дорожки (подрезать видеоклип без linked-аудио / отключить клип) → `audioFp` НЕ изменился.

- [x] **Step 3: Сценарий stale → confirm → лечение**

На тест-секвенции с существующим транскриптом (или после новой транскрибации):
1. Убедиться LED «анализ готов», в кэше entry с `timelineFp` (eval: `ContextStore.findTranscriptEntry(...)`).
2. Ручной рез аудио в Premiere → в течение ~4-8с LED «транскрипт устарел — таймлайн изменился».
3. Клик «Найти» у fillers → появляется confirm; «Отмена» → инструмент не запущен, статус «Рекомендуется повторная транскрибация», кнопка транскрибации пульсирует.
4. Ctrl+Z → LED возвращается в «анализ готов» (отпечаток совпал снова).

- [x] **Step 4: Наши правки не дают ложного stale**

Прогнать «Тишины» → Применить (ripple) → LED НЕ показывает «таймлайн изменился» (fp обновился ripple-listener'ом); eval entry: `timelineFp.hash` совпадает со свежим `audioFp` из региона.

- [x] **Step 5: Миграция ключа и бэкап**

- eval: entry старой секвенции (ключ-имя) после одного цикла poll находится по ID (`getTranscriptCache` содержит ключ-ID, не имя).
- Запустить операцию с чекпоинтом (или host `backupActiveSequence` + повторить копирование) → в кэше появился entry под `backupId` с `seqName` бэкапа.

- [x] **Step 6: Полный набор тестов + синтаксис**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && node --check client/unified/panel.js && node --check client/shared/context-store.js && node --check host/premiere.jsx`
Expected: fail 0; синтаксис OK.

- [x] **Step 7: Финальный коммит (план+спека, если менялись) — с одобрения пользователя**

```bash
git add docs/superpowers/plans/2026-07-28-transcript-cache-validity.md docs/superpowers/specs/2026-07-28-transcript-cache-validity-design.md
git commit -m "docs: план и уточнения спеки валидности кэша транскрипта"
```

Пуш — только с отдельной отмашки пользователя.

---

## Self-Review

- **Spec coverage:** отпечаток host (T1-T2), хранение/ключ/миграция (T3-T4), polling+LED (T5), pre-run confirm (T6), синхронизация после своих правок (T7), бэкапы (T8), unit+live тесты (T1/T3/T9). Legacy-entry без fp → «неизвестно», молчим (T5-T6: проверка `stored &&`). Ограничение mute — задокументировано в коде T1.
- **Placeholders:** нет.
- **Type consistency:** `_extFnv1a`/`_extAudioFpString`/`_extAudioFingerprint` (T1) используются в T2; `findTranscriptEntry(panelId, sequenceKey, seqId)` (T3) — вызовы в T4/T5/T6/T7 совпадают; `updateTranscriptFingerprint(panelId, sequenceKey, seqId, fpHash)` (T3) — вызов T7 совпадает; поля `seqId/seqName/timelineFp{hash,at}/audioAnalysis.analyzedFp` согласованы в T3-T8; `snap.sequenceId`/`snap.audioFp`/`info.sequenceId`/`info.audioFp` (T2) согласованы в T4-T7.
