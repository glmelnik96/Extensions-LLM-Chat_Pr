# Рилс v2: captions-слой, редактор титров, честный синхрон — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Караоке-слова выравниваются по речи (char-weighted + вычитание тишин), субтитры дублируются редактируемой caption-дорожкой, кью правятся в модалке панели с обновлением обоих слоёв.

**Architecture:** Чистая логика (выравнивание, SRT, пересборка кью) — в `client/shared/reels-pipeline.js`, тестируется в vm. Host 2.13.0 добавляет `activateSequenceByName` и режим `replaceTopOverlay` в `importAndOverlayOnTop`. Оркестрация и модалка — в `panel.js`; кью персистятся в ContextStore через существующий transcript-cache механизм с отдельным PID `_llm_reels_cache` (нулевые изменения в context-store.js).

**Tech Stack:** CEP 12 (Chromium+Node), ExtendScript ES3, ffmpeg+libass, node:test + vm.

**ВАЖНО — правила проекта:**
- Коммиты и пуш — ТОЛЬКО после явной отмашки пользователя, одним батчем в конце. Шаги «Commit» в задачах = подготовить, НО НЕ ВЫПОЛНЯТЬ без отмашки.
- ExtendScript = ES3: никаких `trim/forEach/Object.keys/const/let` в premiere.jsx.
- Тест-паттерн vm: футер `})(window);` заменяется на `})(root);` при загрузке (см. loadReelsPipeline в tests/reels-pipeline.test.mjs).
- CDP: сложный код только через `node tools/cep-debug.mjs evalfile tmp/<файл>.js` (eval с bash ломается на эскейпинге).

**Спека:** `docs/superpowers/specs/2026-07-17-reels-v2-captions-design.md`

---

### Task 1: Выравнивание слов — char-weighted + вычитание тишин

**Files:**
- Modify: `client/shared/reels-pipeline.js` (заменить линейную раздачу в `buildKaraokeCues`, строки ~74-86)
- Test: `tests/reels-pipeline.test.mjs`

- [ ] **Step 1.1: Написать падающие тесты**

Добавить в `tests/reels-pipeline.test.mjs` новый describe-блок (после блока `buildKaraokeCues`):

```js
/* ═══ Char-weighted выравнивание + вычитание тишин ═══ */
describe('alignWordsChar', () => {
  it('char-weighted: длинное слово получает больше времени', () => {
    const out = RP.alignWordsChar(['я', 'коротко', 'сверхдлинное'], 0, 10, null);
    assert.equal(out.length, 3);
    assert.equal(out[0].s, 0);
    assert.equal(out[2].e, 10);
    const d0 = out[0].e - out[0].s;
    const d2 = out[2].e - out[2].s;
    assert.ok(d2 > d0 * 3, `d0=${d0} d2=${d2}`);
    /* слова стыкуются без дыр */
    assert.ok(Math.abs(out[0].e - out[1].s) < 0.002);
    assert.ok(Math.abs(out[1].e - out[2].s) < 0.002);
  });
  it('тишина в середине сегмента выкидывается из раскладки', () => {
    /* сегмент 0..10, тишина 4..8 → речь 0..4 и 8..10 (6с) */
    const sil = [{ startSec: 4, endSec: 8 }];
    const out = RP.alignWordsChar(['aa', 'bb', 'cc'], 0, 10, sil);
    /* ни одно слово не должно НАЧИНАТЬСЯ внутри тишины */
    for (const w of out) {
      assert.ok(!(w.s > 4.001 && w.s < 7.999), `слово начинается в тишине: ${JSON.stringify(w)}`);
    }
    /* последнее слово тянется до конца сегмента */
    assert.ok(Math.abs(out[2].e - 10) < 0.002);
    /* первое начинается с начала */
    assert.equal(out[0].s, 0);
  });
  it('тишина < 0.3с игнорируется', () => {
    const sil = [{ startSec: 5, endSec: 5.2 }];
    const out = RP.alignWordsChar(['aa', 'bb'], 0, 10, sil);
    /* раскладка как без тишин: aa занимает первую половину */
    assert.ok(Math.abs(out[0].e - 5) < 0.01, JSON.stringify(out));
  });
  it('тишина накрывает весь сегмент → деградация на весь интервал', () => {
    const sil = [{ startSec: 0, endSec: 10 }];
    const out = RP.alignWordsChar(['aa', 'bb'], 2, 8, sil);
    assert.equal(out[0].s, 2);
    assert.ok(Math.abs(out[1].e - 8) < 0.002);
  });
  it('толерантность к форме {start,end} (deterministic-pipelines style)', () => {
    const sil = [{ start: 4, end: 8 }];
    const out = RP.alignWordsChar(['aa', 'bb', 'cc'], 0, 10, sil);
    for (const w of out) {
      assert.ok(!(w.s > 4.001 && w.s < 7.999), JSON.stringify(w));
    }
  });
});

describe('buildKaraokeCues + silences', () => {
  it('opts.silences прокидывается в раскладку слов', () => {
    const segs = [{ startSec: 0, endSec: 10, text: 'раз два три' }];
    const sil = [{ startSec: 4, endSec: 8 }];
    const cues = RP.buildKaraokeCues(segs, { silences: sil });
    assert.equal(cues.length, 1);
    for (const w of cues[0].words) {
      assert.ok(!(w.s > 4.001 && w.s < 7.999), `слово в тишине: ${JSON.stringify(w)}`);
    }
  });
});
```

- [ ] **Step 1.2: Убедиться, что тесты падают**

Run: `npm test 2>&1 | grep -E "fail|alignWordsChar"`
Expected: FAIL — `RP.alignWordsChar is not a function`.

- [ ] **Step 1.3: Реализация в reels-pipeline.js**

Вставить перед `buildKaraokeCues` (после `_wrapWords`):

```js
  /* ── Выравнивание слов по речи (Cloud.ru Whisper НЕ отдаёт word-таймкоды,
   * проверено live 17.07.2026: timestamp_granularities[]=word → 200 OK, слов
   * нет). Детерминированная замена: интервал сегмента минус тишины ≥0.3с
   * (ffmpeg silencedetect из audioAnalysis), слова раскладываются по
   * озвученным подынтервалам пропорционально длине слова в символах. ── */

  /* Озвученные интервалы [start,end] за вычетом тишин ≥ minSilenceSec.
   * Формы тишин: {startSec,endSec} и {start,end} (как в deterministic-pipelines).
   * Всё вырезано → деградация: весь [start,end]. */
  function _speechIntervals(start, end, silences, minSilenceSec) {
    var minSil = minSilenceSec > 0 ? minSilenceSec : 0.3;
    var sils = [];
    var n = silences ? silences.length : 0;
    for (var i = 0; i < n; i++) {
      var sl = silences[i];
      if (!sl) continue;
      var s = Number(sl.startSec !== undefined ? sl.startSec : sl.start);
      var e = Number(sl.endSec !== undefined ? sl.endSec : sl.end);
      if (!isFinite(s) || !isFinite(e) || e - s < minSil) continue;
      var cs = Math.max(s, start), ce = Math.min(e, end);
      if (ce > cs) sils.push({ s: cs, e: ce });
    }
    if (!sils.length) return [{ s: start, e: end }];
    sils.sort(function (a, b) { return a.s - b.s; });
    var out = [], cur = start;
    for (var k = 0; k < sils.length; k++) {
      if (sils[k].s > cur + 1e-9) out.push({ s: cur, e: sils[k].s });
      cur = Math.max(cur, sils[k].e);
    }
    if (cur < end - 1e-9) out.push({ s: cur, e: end });
    if (!out.length) return [{ s: start, e: end }];
    return out;
  }

  /**
   * Char-weighted раскладка слов по озвученным интервалам сегмента.
   * words: массив строк; silences: см. _speechIntervals (может быть null).
   * Возвращает [{w,s,e}], слова стыкуются встык, последнее до конца речи.
   */
  function alignWordsChar(words, start, end, silences) {
    var iv = _speechIntervals(start, end, silences, 0.3);
    var total = 0, i;
    for (i = 0; i < iv.length; i++) total += iv[i].e - iv[i].s;
    var chars = 0;
    for (i = 0; i < words.length; i++) chars += Math.max(1, String(words[i]).length);
    /* Позиция на «речевой оси» (0..total) → реальное время: кусочно-линейно,
       тишины перепрыгиваются. */
    function toReal(pos) {
      var acc = 0;
      for (var k = 0; k < iv.length; k++) {
        var d = iv[k].e - iv[k].s;
        if (pos <= acc + d + 1e-9) return iv[k].s + (pos - acc);
        acc += d;
      }
      return iv[iv.length - 1].e;
    }
    var out = [], cum = 0;
    for (i = 0; i < words.length; i++) {
      var w = String(words[i]);
      var dur = total * Math.max(1, w.length) / chars;
      out.push({
        w: w,
        s: Math.round(toReal(cum) * 1000) / 1000,
        e: Math.round(toReal(cum + dur) * 1000) / 1000
      });
      cum += dur;
    }
    return out;
  }
```

В `buildKaraokeCues` заменить блок раздачи таймкодов (текущие строки 74-86, от `var timed = [];` до конца цикла `for (var k...)`) на:

```js
      /* Пословные таймкоды: нативные seg.words при совпадении длины (приоритет),
         иначе char-weighted + вычитание тишин (opts.silences). */
      var timed = null;
      if (sg.words && sg.words.length === words.length) {
        timed = [];
        for (var k = 0; k < words.length; k++) {
          var ws = Number(sg.words[k].s), we = Number(sg.words[k].e);
          if (!isFinite(ws) || !isFinite(we) || we < ws) { timed = null; break; }
          timed.push({ w: words[k], s: ws, e: we });
        }
      }
      if (!timed) timed = alignWordsChar(words, start, end, o.silences);
```

В экспорт `global.ReelsPipeline` добавить `alignWordsChar: alignWordsChar,` (после `buildKaraokeCues`).

- [ ] **Step 1.4: Прогнать тесты, починить старые ожидания линейной раздачи**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`

Существующие тесты `buildKaraokeCues` могли ожидать РАВНОМЕРНУЮ раздачу
(wordDur = интервал/N). Char-weighted меняет тайминги слов. Найти упавшие
ассерты и обновить ожидания: границы кью (startSec/endSec) НЕ меняются,
меняются только внутренние s/e слов. Если тест проверял конкретные значения
внутренних слов при линейном fallback — пересчитать под char-weighted
(длина слова / сумма длин × интервал) или ослабить до структурных проверок
(стыковка встык, первый s = start, последний e = end).
Expected: после правок — все тесты PASS.

- [ ] **Step 1.5: Подготовить коммит (НЕ выполнять без отмашки)**

`feat(reels): char-weighted выравнивание слов + вычитание тишин`

---

### Task 2: buildSrt — генерация SRT из кью

**Files:**
- Modify: `client/shared/reels-pipeline.js`
- Test: `tests/reels-pipeline.test.mjs`

- [ ] **Step 2.1: Падающие тесты**

```js
/* ═══ SRT-генерация ═══ */
describe('buildSrt', () => {
  it('формат: номер, HH:MM:SS,mmm --> ..., текст, пустая строка', () => {
    const cues = [
      { startSec: 0, endSec: 1.5, text: 'Привет', words: [] },
      { startSec: 61.25, endSec: 3661.007, text: 'Две\nстроки', words: [] }
    ];
    const srt = RP.buildSrt(cues);
    const expected =
      '1\n00:00:00,000 --> 00:00:01,500\nПривет\n\n' +
      '2\n00:01:01,250 --> 01:01:01,007\nДве\nстроки\n';
    assert.equal(srt, expected);
  });
  it('пустой вход → пустая строка', () => {
    assert.equal(RP.buildSrt([]), '');
  });
});
```

- [ ] **Step 2.2: Убедиться, что падают**

Run: `npm test 2>&1 | grep -i "buildSrt"`
Expected: FAIL — `RP.buildSrt is not a function`.

- [ ] **Step 2.3: Реализация**

Вставить после `buildOverlayFfmpegArgs`:

```js
  /* ── SRT для caption-дорожки Premiere (importSrtAsCaptions) ──────────── */

  /** Секунды → SRT-время HH:MM:SS,mmm. */
  function srtTime(sec) {
    var ms = Math.max(0, Math.round(Number(sec) * 1000));
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    function p3(n) { return (n < 100 ? (n < 10 ? '00' : '0') : '') + n; }
    return p2(h) + ':' + p2(m) + ':' + p2(s) + ',' + p3(ms);
  }

  /** Кьюи → текст .srt (переносы строк кью сохраняются как многострочный блок). */
  function buildSrt(cues) {
    if (!cues || !cues.length) return '';
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      out.push(String(i + 1));
      out.push(srtTime(cues[i].startSec) + ' --> ' + srtTime(cues[i].endSec));
      out.push(cues[i].text);
      out.push('');
    }
    return out.join('\n');
  }
```

В экспорт добавить `srtTime: srtTime,` и `buildSrt: buildSrt,`.

- [ ] **Step 2.4: Тесты зелёные**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: PASS, счётчик вырос.

- [ ] **Step 2.5: Подготовить коммит** — `feat(reels): buildSrt для caption-дорожки`

---

### Task 3: rebuildCueText — пересборка кью после правки в модалке

**Files:**
- Modify: `client/shared/reels-pipeline.js`
- Test: `tests/reels-pipeline.test.mjs`

- [ ] **Step 3.1: Падающие тесты**

```js
/* ═══ Пересборка кью после правки текста (модалка) ═══ */
describe('rebuildCueText', () => {
  const cue = {
    startSec: 10, endSec: 14,
    text: 'старый текст',
    words: [{ w: 'старый', s: 10, e: 12 }, { w: 'текст', s: 12, e: 14 }]
  };
  it('границы кью не двигаются, words пересобраны char-weighted', () => {
    const out = RP.rebuildCueText(cue, 'новый исправленный текст', {});
    assert.equal(out.startSec, 10);
    assert.equal(out.endSec, 14);
    assert.equal(out.words.length, 3);
    assert.equal(out.words[0].s, 10);
    assert.ok(Math.abs(out.words[2].e - 14) < 0.002);
    /* «исправленный» длиннее «новый» → больше времени */
    assert.ok((out.words[1].e - out.words[1].s) > (out.words[0].e - out.words[0].s));
  });
  it('перенос строк пересобирается greedy (20 симв / 2 строки по умолчанию)', () => {
    const out = RP.rebuildCueText(cue, 'очень длинная фраза которая не влезает в одну строку', {});
    assert.ok(out.text.indexOf('\n') !== -1, out.text);
    /* число слов в text = числу words */
    assert.equal(out.text.split(/[\n ]/).length, out.words.length);
  });
  it('тишины вычитаются при пересборке', () => {
    const out = RP.rebuildCueText(cue, 'раз два', { silences: [{ startSec: 11, endSec: 13 }] });
    for (const w of out.words) {
      assert.ok(!(w.s > 11.001 && w.s < 12.999), JSON.stringify(w));
    }
  });
  it('пустой текст → null', () => {
    assert.equal(RP.rebuildCueText(cue, '   ', {}), null);
  });
  it('исходный кью не мутирован', () => {
    RP.rebuildCueText(cue, 'другое', {});
    assert.equal(cue.text, 'старый текст');
    assert.equal(cue.words[0].w, 'старый');
  });
});
```

- [ ] **Step 3.2: Убедиться, что падают**

Run: `npm test 2>&1 | grep -i "rebuildCueText"`
Expected: FAIL.

- [ ] **Step 3.3: Реализация**

Вставить после `applyProofread`:

```js
  /**
   * Правка текста кью из модалки (без LLM-guard — правки монтажёра
   * авторитетны). Границы [startSec, endSec] не двигаются; переносы
   * пересобираются greedy; words — char-weighted с вычитанием тишин.
   * Пустой текст → null (кью не меняется). Без мутации входа.
   * opts: {maxCharsPerLine, maxLines, silences}
   */
  function rebuildCueText(cue, newText, opts) {
    var o = opts || {};
    var maxChars = o.maxCharsPerLine > 0 ? o.maxCharsPerLine : 20;
    var maxLines = o.maxLines > 0 ? o.maxLines : 2;
    var flat = String(newText == null ? '' : newText).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!flat) return null;
    var words = flat.split(' ');
    var wrapped = _wrapWords(words, maxChars, maxLines);
    if (wrapped === null) wrapped = words.join(' ');
    return {
      startSec: cue.startSec,
      endSec: cue.endSec,
      text: wrapped,
      words: alignWordsChar(words, cue.startSec, cue.endSec, o.silences)
    };
  }
```

В экспорт добавить `rebuildCueText: rebuildCueText,`.

- [ ] **Step 3.4: Тесты зелёные**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: PASS.

- [ ] **Step 3.5: Подготовить коммит** — `feat(reels): rebuildCueText для редактора титров`

---

### Task 4: Host 2.13.0 — activateSequenceByName + replaceTopOverlay; bridge

**Files:**
- Modify: `host/premiere.jsx` (version + новая функция + доработка importAndOverlayOnTop, ~строки 2987-3142)
- Modify: `client/shared/bridge-premiere.js` (~строка 279, после importAndOverlayOnTop)

ES3-ДИСЦИПЛИНА: только var, никаких стрелок/trim/Object.keys.

- [ ] **Step 4.1: Bump версии host**

В `host/premiere.jsx` найти `version: '2.12.0'` → `version: '2.13.0'`.

- [ ] **Step 4.2: activateSequenceByName**

Вставить в `host/premiere.jsx` после конца `importAndOverlayOnTop` (после строки `};` ~3142):

```jsx
/**
 * Рилс v2 (18.07.2026): активировать секвенцию по имени.
 * Нужен для импорта captions в рилс-секвенцию при анимации «нет»
 * (importSrtAsCaptions работает по активной; importAndOverlayOnTop,
 * который раньше активировал её попутно, в этом режиме не вызывается).
 */
$._EXT_PRM_.activateSequenceByName = function (jsonStr) {
  try {
    if (!app.project) return JSON.stringify({ ok: false, error: 'Нет открытого проекта' });
    var p;
    try {
      p = JSON.parse(jsonStr);
    } catch (eJ) {
      return JSON.stringify({ ok: false, error: 'Невалидный JSON: ' + String(eJ) });
    }
    var wantName = String((p && p.name) || '');
    if (!wantName) return JSON.stringify({ ok: false, error: 'name обязателен' });
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) {
      if (String(seqs[i].name) === wantName) {
        app.project.activeSequence = seqs[i];
        return JSON.stringify({ ok: true, sequenceName: wantName, hostVersion: $._EXT_PRM_.version });
      }
    }
    return JSON.stringify({ ok: false, error: 'Секвенция «' + wantName + '» не найдена' });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};
```

- [ ] **Step 4.3: replaceTopOverlay в importAndOverlayOnTop**

В `importAndOverlayOnTop`, блок «Верхняя видеодорожка» (~строка 3077,
`var numV = seq.videoTracks.numTracks;` … перед `if (topBusy) { QE... }`).
После вычисления `topBusy` вставить ПЕРЕД существующим `if (topBusy) {`:

```jsx
      /* Рилс v2: replaceTopOverlay — заменить старый оверлей на той же
         дорожке (перерендер из модалки), дорожки не добавлять.
         Last line of defense (стандарт проекта): НЕ трогаем V1 и НЕ удаляем
         клипы, не похожие на оверлей (.mov) — отклоняем, не клампим. */
      var replaceTop = !!(p && p.replaceTopOverlay);
      if (replaceTop && topBusy) {
        if (numV < 2) {
          return JSON.stringify({ ok: false, error: 'replaceTopOverlay: верхняя дорожка = V1 с исходным видео — замена отклонена' });
        }
        var rc;
        for (rc = 0; rc < top.clips.numItems; rc++) {
          var rcName = '';
          try { rcName = String(top.clips[rc].name); } catch (eRcN) {}
          if (!/\.mov$/i.test(rcName)) {
            return JSON.stringify({ ok: false, error: 'replaceTopOverlay: на V' + numV + ' найден клип «' + rcName + '» (не .mov-оверлей) — замена отклонена' });
          }
        }
        try {
          for (rc = top.clips.numItems - 1; rc >= 0; rc--) {
            top.clips[rc].remove(false, false);
          }
        } catch (eRm) {
          return JSON.stringify({ ok: false, error: 'Не удалось удалить старый оверлей: ' + String(eRm && eRm.message ? eRm.message : eRm) });
        }
        topBusy = false;
        try { topBusy = top.clips.numItems > 0; } catch (eTB2) { topBusy = true; }
        if (topBusy) {
          return JSON.stringify({ ok: false, error: 'Старый оверлей не удалился с V' + numV });
        }
      }
```

(Дальше существующий `if (topBusy) { QE addTracks... }` остаётся как есть —
при успешной очистке он не сработает, дорожка не добавится.)

- [ ] **Step 4.4: EXPORTED-обёртки**

В списке `EXPORTED` (~строка 4100) проверить наличие `'importAndOverlayOnTop'`;
добавить `'activateSequenceByName'` (и `'importAndOverlayOnTop'`, если
отсутствует) — чтобы Phase-1 wrap покрывал новые функции.

- [ ] **Step 4.5: ES3-проверка**

Run: `grep -nE "\b(const |let |=>|\.trim\(|\.forEach\(|Object\.keys)" host/premiere.jsx | grep -v "^\s*//"`
Expected: пусто (или только строки в комментариях).

- [ ] **Step 4.6: Bridge-методы**

В `client/shared/bridge-premiere.js` после `importAndOverlayOnTop` (~строка 279) вставить:

```js
    /** Рилс v2: активировать секвенцию по имени (captions при анимации «нет»). */
    activateSequenceByName: function (payloadObj, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(payloadObj));
      this.evalJson('$._EXT_PRM_.activateSequenceByName("' + json + '")', cb, { mutating: true });
    },
```

Run: `node --check client/shared/bridge-premiere.js`
Expected: без ошибок.

- [ ] **Step 4.7: Подготовить коммит** — `feat(host): activateSequenceByName + replaceTopOverlay (2.13.0)`

---

### Task 5: toolsRunReels — captions-слой, anim «нет» без .mov, персист кью

**Files:**
- Modify: `client/unified/panel.js` (toolsRunReels ~7659-7968; константы рядом с REELS_PROOFREAD_BATCH ~7613)

- [ ] **Step 5.1: Константа PID и хелпер активации**

Рядом с `var REELS_PROOFREAD_BATCH = 40;` (~строка 7613) добавить:

```js
    /* Рилс v2: кью персистятся через transcript-cache механизм ContextStore
       с отдельным PID — ключ = имя рилс-секвенции. Ноль изменений в сторе. */
    var REELS_PID = '_llm_reels_cache';
    function reelsActivateSequence(name) {
      return new Promise(function (resolve, reject) {
        PremiereBridge.activateSequenceByName({ name: name }, function (err, data) {
          if (err) reject(err);
          else if (!data || !data.ok) reject(new Error((data && data.error) || 'activateSequenceByName: нет ответа'));
          else resolve(data);
        });
      });
    }
```

- [ ] **Step 5.2: Гейты preflight — шрифт и libass только при анимации**

В `toolsRunReels` перенести чтение `anim` ДО проверок шрифта/libass
(сейчас anim читается на ~7702, шрифт проверяется на ~7681, libass на ~7706).
Новый порядок в шаге 0:

```js
        var anim = (document.getElementById('rl-anim') || {}).value || 'color';
        var ffBin = AudioPreprocess.findFfmpegPath();
        if (!ffBin) {
          toolsShowErr('Нужен ffmpeg (кадры для vision' + (anim !== 'none' ? ' и рендер субтитров' : '') + '). Установите ffmpeg и повторите.');
          return;
        }
        var fontName = (document.getElementById('rl-font') || {}).value || 'SB Sans Text SemiBold';
        if (anim !== 'none' && !reelsFontInstalled(fontName)) {
          toolsShowErr('Шрифт «' + fontName + '» не найден среди системных. Установите .otf (правый клик → «Установить для всех пользователей») и повторите.');
          return;
        }
```

И обёртка libass-проверки (~7706-7715): выполнять только `if (anim !== 'none') { ... }`.

- [ ] **Step 5.3: Тишины в buildKaraokeCues**

Строка ~7863: `ReelsPipeline.buildKaraokeCues(entry.segments, {})` →

```js
        var cues = ReelsPipeline.buildKaraokeCues(entry.segments, {
          silences: (entry.audioAnalysis && entry.audioAnalysis.silences && entry.audioAnalysis.silences.length)
            ? entry.audioAnalysis.silences : null
        });
```

- [ ] **Step 5.4: Рендер и оверлей — только при анимации; SRT и captions — всегда**

Блок «6. ASS → оверлей» + «7. Импорт» (~7893-7934) реорганизовать.
Каталог/имена файлов создаются всегда; ass/mov — только при anim ≠ 'none':

```js
        /* 6. Файлы: SRT всегда; ASS+оверлей — только при анимации. */
        var fps = Number(snap.fps) > 0 ? Number(snap.fps) : 25;
        var durationSec = Math.ceil((cues[cues.length - 1].endSec + 0.5) * 100) / 100;
        var dir = path.join(os.homedir(), '.extensions_llm_chat_pr', 'reels');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        var safeName = seqName.replace(/[\\\/:*?"<>|]/g, '_');
        var srtPath = path.join(dir, safeName + '_' + ts + '.srt');
        fs.writeFileSync(srtPath, ReelsPipeline.buildSrt(cues), 'utf8');
        var assPath = null, outPath = null, ins = null;
        if (anim !== 'none') {
          var ass = ReelsPipeline.buildAss(cues, {
            w: targetW, h: targetH,
            fontName: fontName,
            textColor: textColor,
            hlColor: hlColor,
            anim: anim
          });
          assPath = path.join(dir, safeName + '_' + ts + '.ass');
          outPath = path.join(dir, safeName + '_' + ts + '.mov');
          fs.writeFileSync(assPath, ass, 'utf8'); /* UTF-8 БЕЗ BOM — libass */
          toolsStatusUi.show('Рилс: рендерю субтитры (' + cues.length + ' титров, ~' + Math.round(durationSec) + 'с)…', true);
          await reelsRunFfmpeg(ffBin, ReelsPipeline.buildOverlayFfmpegArgs({
            assPath: assPath, w: targetW, h: targetH, fps: fps,
            durationSec: durationSec, outPath: outPath
          }));
          if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 4096) {
            toolsShowErr('Секвенция «' + applied.sequenceName + '» создана, но ffmpeg отрендерил пустой оверлей: ' + outPath);
            return;
          }
          /* 7a. Оверлей на новую верхнюю дорожку (активирует рилс-секвенцию). */
          toolsStatusUi.show('Рилс: вставляю оверлей в «' + applied.sequenceName + '»…', true);
          ins = await new Promise(function (resolve, reject) {
            PremiereBridge.importAndOverlayOnTop({
              filePath: outPath.replace(/\\/g, '/'),
              expectedSequenceName: applied.sequenceName
            }, function (err, data) {
              if (err) reject(err); else resolve(data);
            });
          });
          if (!ins || !ins.ok) {
            toolsShowErr('Секвенция «' + applied.sequenceName + '» создана, но оверлей не вставлен: ' +
              ((ins && ins.error) || 'нет ответа хоста') + '\nФайл оверлея: ' + outPath);
            return;
          }
        } else {
          /* Анимация «нет»: рендера не будет — активируем рилс-секвенцию
             для captions явно (обычно её активирует importAndOverlayOnTop). */
          await reelsActivateSequence(applied.sequenceName);
        }

        /* 7b. Caption-дорожка — всегда (нативно редактируемый слой). */
        toolsStatusUi.show('Рилс: импортирую captions в «' + applied.sequenceName + '»…', true);
        var capOk = false, capErr = '';
        try {
          var cap = await new Promise(function (resolve, reject) {
            PremiereBridge.importSrtAsCaptions({
              srtPath: srtPath.replace(/\\/g, '/'),
              expectedSequenceName: applied.sequenceName
            }, function (err, data) {
              if (err) reject(err); else resolve(data);
            });
          });
          capOk = !!(cap && cap.ok);
          if (!capOk) capErr = (cap && cap.error) || 'нет ответа хоста';
        } catch (eCap) { capErr = String((eCap && eCap.message) || eCap); }
        if (!capOk) notes.push('Caption-дорожка не создана (' + capErr + ') — титры только в ' + (anim !== 'none' ? 'оверлее' : 'SRT: ' + srtPath));

        /* 7c. Персист кью — источник правды для модалки «Править титры». */
        try {
          ContextStore.setTranscriptEntry(REELS_PID, applied.sequenceName, {
            cues: cues,
            settings: { format: fmt, anim: anim, fontName: fontName, textColor: textColor, hlColor: hlColor, fps: fps, w: targetW, h: targetH },
            paths: { srt: srtPath, ass: assPath, mov: outPath },
            silences: (entry.audioAnalysis && entry.audioAnalysis.silences) || null,
            sourceSequenceName: seqName,
            reelsSequenceName: applied.sequenceName,
            createdAt: Date.now()
          });
        } catch (eSt) { notes.push('Кью не сохранены для редактора (' + String((eSt && eSt.message) || eSt) + ')'); }
```

- [ ] **Step 5.5: Отчёт**

Блок «8. Отчёт» (~7936-7945): строку про субтитры заменить на:

```js
        var animLabel = anim === 'box' ? 'плашка под словом' : (anim === 'none' ? 'без анимации' : 'цвет слова');
        var lines = [
          'Создана секвенция «' + applied.sequenceName + '» (' + targetW + '×' + targetH + ').',
          'Отрефреймлено ' + applied.applied + ' из ' + plan.total + ' клипов.',
          anim !== 'none'
            ? ('Субтитры: ' + cues.length + ' титров, ' + animLabel + ', шрифт ' + fontName + ' — оверлей на V' + (ins.trackIndex + 1) + (capOk ? ' + caption-дорожка' : '') + '.')
            : ('Субтитры: ' + cues.length + ' титров — caption-дорожка (редактируемая, без анимации).'),
          proofOk
            ? ('Корректура LLM: ' + proofApplied + ' правок' + (proofRejected ? ' (' + proofRejected + ' отклонено guard-ом)' : '') + '.')
            : 'Корректура LLM: пропущена.'
        ];
        if (anim !== 'none' && capOk) {
          lines.push('Внимание: включённый CC в мониторе задвоит текст — выключите CC или удалите caption-дорожку.');
        }
```

- [ ] **Step 5.6: Проверки**

Run: `node --check client/unified/panel.js && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: чисто, все тесты PASS.

- [ ] **Step 5.7: Подготовить коммит** — `feat(reels): captions-слой всегда, режим без анимации без рендера, персист кью`

---

### Task 6: Модалка «Править титры»

**Files:**
- Modify: `client/unified/index2.html` (кнопка на card-reels + разметка модалки после transcript-modal ~строка 815)
- Modify: `client/unified/panel.js` (логика модалки — после toolsRunReels)

- [ ] **Step 6.1: Разметка**

В `index2.html` на карточке `card-reels`, рядом с кнопкой `.tool-run`
(data-tool="reels"), добавить:

```html
              <button type="button" class="secondary" id="rl-edit-cues" style="font-size:11px;" title="Открыть сохранённые титры рилса: правка текста, обновление captions, перерендер караоке">Править титры</button>
```

После закрывающего `</div>` модалки `transcript-modal` (~строка 815) добавить
(классы tr-modal-* переиспользуются — стили уже есть):

```html
    <!-- Рилс v2: редактор титров. Кью — источник правды (ContextStore),
         правка пересобирает words char-weighted; кнопки обновляют слои. -->
    <div class="tr-modal-overlay" id="reels-edit-modal" hidden role="dialog" aria-modal="true" aria-labelledby="re-modal-title">
      <div class="tr-modal">
        <div class="tr-modal-head">
          <span class="tr-modal-title" id="re-modal-title">Титры рилса</span>
          <span class="tr-modal-meta" id="re-modal-meta"></span>
          <button type="button" class="tr-modal-close" id="re-modal-close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
        </div>
        <div class="tr-modal-body" id="re-modal-body"></div>
        <div style="display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--border,#444);align-items:center;">
          <button type="button" id="re-update-captions">Обновить captions</button>
          <button type="button" id="re-rerender-karaoke">Перерендерить караоке</button>
          <span id="re-modal-status" style="color:var(--muted);font-size:12px;flex:1;"></span>
        </div>
      </div>
    </div>
```

- [ ] **Step 6.2: Логика модалки в panel.js**

После `toolsRunReels` добавить:

```js
    /* ═══ Рилс v2: модалка «Править титры» ═══
       Кью из ContextStore (REELS_PID, ключ = имя рилс-секвенции) — источник
       правды. Правка текста: rebuildCueText (без LLM-guard — монтажёр
       авторитетен), границы кью не двигаются, сохранение сразу.
       «Обновить captions»: новый .srt → новая caption-дорожка (старую
       удалить вручную — API удаления в ExtendScript нет).
       «Перерендерить караоке»: ASS → ffmpeg → replaceTopOverlay (замена
       на той же дорожке, число дорожек не растёт). */
    var _reelsEditEntry = null;

    function reelsFindSavedEntry(seqName) {
      /* Активная секвенция — сама рилс-секвенция или её исходник. */
      var cands = [seqName, seqName + ' — Рилс 9x16', seqName + ' — Рилс 1x1'];
      for (var i = 0; i < cands.length; i++) {
        var e = ContextStore.getTranscriptEntry(REELS_PID, cands[i]);
        if (e && e.cues && e.cues.length) return e;
      }
      return null;
    }

    function reelsEditStatus(msg) {
      var el = document.getElementById('re-modal-status');
      if (el) el.textContent = msg || '';
    }

    function reelsSaveEditEntry() {
      if (!_reelsEditEntry) return;
      ContextStore.setTranscriptEntry(REELS_PID, _reelsEditEntry.reelsSequenceName, _reelsEditEntry);
    }

    function reelsRenderEditBody() {
      var body = document.getElementById('re-modal-body');
      if (!body || !_reelsEditEntry) return;
      body.textContent = '';
      var cues = _reelsEditEntry.cues;
      for (var i = 0; i < cues.length; i++) {
        (function (idx) {
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:flex-start;';
          var tc = document.createElement('span');
          tc.style.cssText = 'color:var(--muted);font-size:11px;white-space:nowrap;padding-top:4px;min-width:88px;';
          tc.textContent = cues[idx].startSec.toFixed(1) + '–' + cues[idx].endSec.toFixed(1) + 'с';
          var ta = document.createElement('textarea');
          ta.style.cssText = 'flex:1;min-height:34px;resize:vertical;font-size:12px;';
          ta.value = cues[idx].text;
          ta.addEventListener('change', function () {
            var upd = ReelsPipeline.rebuildCueText(cues[idx], ta.value, {
              silences: _reelsEditEntry.silences || null
            });
            if (!upd) { ta.value = cues[idx].text; reelsEditStatus('Пустой титр — правка отменена'); return; }
            cues[idx] = upd;
            ta.value = upd.text;
            reelsSaveEditEntry();
            reelsEditStatus('Сохранено. Обновите captions/караоке, чтобы применить в Premiere.');
          });
          row.appendChild(tc);
          row.appendChild(ta);
          body.appendChild(row);
        })(i);
      }
    }

    function reelsOpenEditModal() {
      toolsShowErr('');
      PremiereBridge.getSequenceRegionInfo(function (err, info) {
        var seqName = (!err && info && info.ok) ? String(info.sequenceName || '') : '';
        var entry = seqName ? reelsFindSavedEntry(seqName) : null;
        if (!entry) {
          toolsShowErr('Нет сохранённых титров рилса для «' + (seqName || '?') + '». Сначала соберите рилс.');
          return;
        }
        _reelsEditEntry = entry;
        var ov = document.getElementById('reels-edit-modal');
        var meta = document.getElementById('re-modal-meta');
        var rerenderBtn = document.getElementById('re-rerender-karaoke');
        if (meta) meta.textContent = entry.reelsSequenceName + ' · ' + entry.cues.length + ' титров · ' + (entry.settings.anim === 'none' ? 'без анимации' : entry.settings.anim === 'box' ? 'плашка' : 'цвет слова');
        if (rerenderBtn) rerenderBtn.hidden = entry.settings.anim === 'none';
        reelsEditStatus('');
        reelsRenderEditBody();
        if (ov) ov.hidden = false;
      });
    }

    async function reelsUpdateCaptions() {
      if (!_reelsEditEntry) return;
      if (!beginOperation('tools:reels-captions')) { reelsEditStatus('Идёт другая операция — подождите.'); return; }
      try {
        reelsEditStatus('Обновляю captions…');
        var fs = require('fs');
        var path = require('path');
        var os = require('os');
        var dir = path.join(os.homedir(), '.extensions_llm_chat_pr', 'reels');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        var safeName = _reelsEditEntry.reelsSequenceName.replace(/[\\\/:*?"<>|]/g, '_');
        var srtPath = path.join(dir, safeName + '_' + ts + '.srt');
        fs.writeFileSync(srtPath, ReelsPipeline.buildSrt(_reelsEditEntry.cues), 'utf8');
        await reelsActivateSequence(_reelsEditEntry.reelsSequenceName);
        var cap = await new Promise(function (resolve, reject) {
          PremiereBridge.importSrtAsCaptions({
            srtPath: srtPath.replace(/\\/g, '/'),
            expectedSequenceName: _reelsEditEntry.reelsSequenceName
          }, function (err, data) { if (err) reject(err); else resolve(data); });
        });
        if (!cap || !cap.ok) throw new Error((cap && cap.error) || 'importSrtAsCaptions: нет ответа');
        _reelsEditEntry.paths.srt = srtPath;
        reelsSaveEditEntry();
        reelsEditStatus('Captions обновлены (новая дорожка). Старую caption-дорожку удалите вручную — API удаления нет.');
      } catch (e) {
        reelsEditStatus('Ошибка captions: ' + String((e && e.message) || e));
      } finally {
        endOperation();
      }
    }

    async function reelsRerenderKaraoke() {
      if (!_reelsEditEntry) return;
      if (_reelsEditEntry.settings.anim === 'none') return;
      if (!beginOperation('tools:reels-rerender')) { reelsEditStatus('Идёт другая операция — подождите.'); return; }
      try {
        var st = _reelsEditEntry.settings;
        var ffBin = AudioPreprocess.findFfmpegPath();
        if (!ffBin) throw new Error('ffmpeg не найден');
        var fs = require('fs');
        var path = require('path');
        var os = require('os');
        var dir = path.join(os.homedir(), '.extensions_llm_chat_pr', 'reels');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        var safeName = _reelsEditEntry.reelsSequenceName.replace(/[\\\/:*?"<>|]/g, '_');
        var cues = _reelsEditEntry.cues;
        var ass = ReelsPipeline.buildAss(cues, {
          w: st.w, h: st.h, fontName: st.fontName,
          textColor: st.textColor, hlColor: st.hlColor, anim: st.anim
        });
        var assPath = path.join(dir, safeName + '_' + ts + '.ass');
        var outPath = path.join(dir, safeName + '_' + ts + '.mov');
        fs.writeFileSync(assPath, ass, 'utf8');
        var durationSec = Math.ceil((cues[cues.length - 1].endSec + 0.5) * 100) / 100;
        reelsEditStatus('Рендерю караоке (~' + Math.round(durationSec) + 'с видео)…');
        await reelsRunFfmpeg(ffBin, ReelsPipeline.buildOverlayFfmpegArgs({
          assPath: assPath, w: st.w, h: st.h, fps: st.fps,
          durationSec: durationSec, outPath: outPath
        }));
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 4096) {
          throw new Error('ffmpeg отрендерил пустой файл: ' + outPath);
        }
        reelsEditStatus('Заменяю оверлей на таймлайне…');
        var ins = await new Promise(function (resolve, reject) {
          PremiereBridge.importAndOverlayOnTop({
            filePath: outPath.replace(/\\/g, '/'),
            expectedSequenceName: _reelsEditEntry.reelsSequenceName,
            replaceTopOverlay: true
          }, function (err, data) { if (err) reject(err); else resolve(data); });
        });
        if (!ins || !ins.ok) throw new Error((ins && ins.error) || 'importAndOverlayOnTop: нет ответа');
        _reelsEditEntry.paths.ass = assPath;
        _reelsEditEntry.paths.mov = outPath;
        reelsSaveEditEntry();
        reelsEditStatus('Караоке перерендерено — оверлей заменён на V' + (ins.trackIndex + 1) + '.');
      } catch (e) {
        reelsEditStatus('Ошибка перерендера: ' + String((e && e.message) || e));
      } finally {
        endOperation();
      }
    }

    (function wireReelsEditModal() {
      var openBtn = document.getElementById('rl-edit-cues');
      var closeBtn = document.getElementById('re-modal-close');
      var ov = document.getElementById('reels-edit-modal');
      var capBtn = document.getElementById('re-update-captions');
      var rrBtn = document.getElementById('re-rerender-karaoke');
      if (openBtn) openBtn.addEventListener('click', reelsOpenEditModal);
      if (closeBtn) closeBtn.addEventListener('click', function () { if (ov) ov.hidden = true; });
      if (ov) ov.addEventListener('click', function (ev) { if (ev.target === ov) ov.hidden = true; });
      if (capBtn) capBtn.addEventListener('click', reelsUpdateCaptions);
      if (rrBtn) rrBtn.addEventListener('click', reelsRerenderKaraoke);
    })();
```

- [ ] **Step 6.3: Проверки**

Run: `node --check client/unified/panel.js && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: чисто, PASS.

- [ ] **Step 6.4: Подготовить коммит** — `feat(reels): модалка «Править титры» — правка кью, captions, перерендер`

---

### Task 7: Live CDP-валидация (полный цикл)

Метод: `node tools/cep-debug.mjs reload`, сложный код — evalfile через tmp/*.js.
Перед прогоном: активная секвенция «Мельников Глеб, Цибрий Егор», In/Out
0–151.167 (tmp/cdp-set-inout.js существует), гейт снимается toolsRefreshLed.
Секвенции «— Рилс …» от прошлых прогонов удалить/переименовать заранее
(deleteBin у открытой в таймлайне секвенции оставляет сироту — переименовать).

- [ ] **7.1: reload панели → HOST 2.13.0** (tmp/cdp-check-host.js, проверить `activateSequenceByName` = function)
- [ ] **7.2: Прогон 9:16/color** — кнопка «Собрать рилс» (tmp/cdp-run-reels.js), poll (tmp/cdp-poll-reels.js). Проверить: секвенция 1080×1920, V3-оверлей, **caption-дорожка появилась** (в отчёте «+ caption-дорожка»), кадры .mov через ffmpeg-композит: слова подсвечиваются НЕ равномерно (сравнить `\k`-длительности в .ass — должны отличаться по словам), титры не горят во время пауз (сверить с audioAnalysis.silences).
- [ ] **7.3: Прогон anim=none** — .mov НЕ создан, caption-дорожка есть, ffmpeg не вызывался (быстрый прогон).
- [ ] **7.4: Модалка** — открыть «Править титры» (CDP click), поменять текст первого кью (dispatch change), проверить: entry в ContextStore обновился, words пересобраны, границы кью прежние.
- [ ] **7.5: «Обновить captions»** — новая caption-дорожка с новым текстом, статус с предупреждением про старую дорожку.
- [ ] **7.6: «Перерендерить караоке»** — число видеодорожек НЕ выросло, на верхней — новый .mov (имя с новым ts), кадр с новым текстом.
- [ ] **7.7: Негативный guard replaceTopOverlay** — вызвать importAndOverlayOnTop с replaceTopOverlay=true на секвенции, где верхняя дорожка V1 с видео → ok:false «замена отклонена».
- [ ] **7.8: Полный `npm test`** — все зелёные.

### Task 8: Финал

- [ ] **8.1:** Отчёт пользователю: что изменилось, результаты live-прогонов, ограничения (старые caption-дорожки удалять вручную).
- [ ] **8.2:** Спросить отмашку на батч коммитов (спека v2 + план + Task 1-6 коммиты) и пуш.
