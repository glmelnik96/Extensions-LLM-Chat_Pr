# UI-переработка панели (аккордеон + прогрессивное раскрытие) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перестроить вкладку «Инструменты» в аккордеон из 5 смысловых групп с прогрессивным раскрытием параметров, не меняя ни одного ID и ни одной строки логики инструментов (кроме 3 hook-точек).

**Architecture:** Ре-парентинг на месте в `client/unified/index2.html` — существующие `.tool-card` переносятся целиком в контейнеры `.tools-group` (порядок карточек меняется, ID сохраняются). Тяжёлые карточки получают `<details class="tool-advanced">`-спойлер. Новый файл `client/unified/tools-accordion.js` (ES5) реализует аккордеон/персистентность/авто-раскрытие. В panel.js — ровно 3 точечных дополнения (reveal из proposal, reveal из card-status, экспорт перерисовки waveform).

**Tech Stack:** чистый ES5 JS + CSS, CEP 12 (Chromium), localStorage, CDP-валидация через `node tools/cep-debug.mjs`.

**Спека:** `docs/superpowers/specs/2026-07-28-ui-overhaul-design.md`

---

## Ключевые факты (проверено по коду 28.07.2026, commit 92c62a8)

- `index2.html`: 1148 строк; весь CSS в `<style>` с строки 7; скрипты грузятся через `document.write` из массива `scripts` в конце файла (`'panel.js'` — последний элемент).
- Карточки (строки на момент до правок): card-silences 587–644, card-trim-edges 648–668, card-fillers 671–683, card-profanity 687–703, card-jumps 708–735, card-loudnorm 740–755, card-gaps 758–768, card-chapters 771–790, card-multicam 794–906, card-speakers 911–924, card-reels 932–1004, card-markers-export 1008–1017, card-backups 1020–1027, card-jcuts 1029–1036 (удаляем).
- card-jcuts: внутри только `id="card-jcuts"` и кнопка `data-tool="jcuts"` (disabled, без id). `panel.js:10269` case 'jcuts' обращается к `jcut-offset` — мёртвый код, достижим только кликом по удаляемой кнопке. Ничего править не надо.
- У card-multicam УЖЕ есть `<details class="mc-advanced">` (index2.html:833–901) — переименовываем в `tool-advanced`, CSS `.mc-advanced` (строки 304–316) переименовываем; в panel.js упоминаний `mc-advanced` НЕТ (проверено grep).
- panel.js hook-точки: `toolsShowProposal(areaId, proposal)` ~8017 (после `area.className = 'proposal-area visible';` ~8023); `toolsSetCardStatus` ~7480 (строка `if (seqKey === _toolsStatusSeqKey) _renderCardStatus(...)` ~7486); `toolsShowWaveform(toolName, entry)` ~7210–7225 и `_waveState` ~7107 (экспорт reveal-перерисовки — сразу после toolsShowWaveform, ~7225).
- Чат action-bar: index2.html 506–537. `undo-menu` (517–520) переезжает внутрь `more-popover` (523). Обвязка undo: panel.js 5013–5162 — НЕ меняется (btn-undo/undo-menu/undo-popover находятся по ID). Клик btn-undo при stack>1 делает `stopPropagation` → «Ещё» не закроется; при stack==1 клик всплывает, но target внутри more-menu → «Ещё» тоже не закроется. ОК.
- localStorage-паттерн кодовой базы: прямые try/catch вокруг getItem/setItem (panel.js:4835, 7562). Ключи: `extllmpr_v1_tools_group`, `extllmpr_v1_adv_<cardId>`.
- npm test = 1008 тестов, менять их не требуется (логика не трогается).
- CDP: `node tools/cep-debug.mjs reload` и `node tools/cep-debug.mjs evalfile <file>` (порт 8098, панель должна быть открыта в Premiere). Скрипты класть в `tmp/`.

---

### Task 1: Снимок ID «до»

**Files:** создать `tmp/ids-before.txt` (не коммитится, tmp/ untracked)

- [ ] **Step 1.1:** Снять все id из index2.html:

```bash
cd "C:\Users\Глеб\Documents\Extensions-LLM-Chat_Pr" && grep -o 'id="[^"]*"' client/unified/index2.html | sort > tmp/ids-before.txt && wc -l tmp/ids-before.txt
```

Expected: ~150+ строк. Файл понадобится в Task 8.

---

### Task 2: CSS — группы, спойлеры, чат

**Files:** Modify: `client/unified/index2.html` (блок `<style>`)

- [ ] **Step 2.1:** Переименовать `.mc-advanced` → `.tool-advanced` в CSS (строки 304–316). Было 5 селекторов `.mc-advanced...` — заменить все вхождения строки `mc-advanced` на `tool-advanced` ТОЛЬКО в CSS-блоке (в разметке — Task 5). Итоговый блок:

```css
      .tool-advanced { margin: 8px 0 4px; border-top: 1px solid var(--border); padding-top: 6px; }
      .tool-advanced > summary {
        cursor: pointer;
        font-size: 11px;
        color: var(--muted);
        user-select: none;
        list-style: none;
        margin-bottom: 4px;
      }
      .tool-advanced > summary::-webkit-details-marker { display: none; }
      .tool-advanced > summary::before { content: '▸ '; }
      .tool-advanced[open] > summary::before { content: '▾ '; }
```

(Содержимое правил не менять — только имя класса; свериться с фактическими строками 305–313 перед заменой.)

- [ ] **Step 2.2:** После CSS-блока `.tool-card-desc` (~276) добавить стили аккордеона:

```css
      /* ── Аккордеон групп инструментов (28.07.2026, UI-переработка) ── */
      .tools-group {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 6px;
        margin-bottom: 8px;
      }
      .tools-group-head {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        user-select: none;
      }
      .tools-group-head:hover { background: rgba(255,255,255,0.04); }
      .tools-group-cnt { color: var(--muted); font-weight: 400; font-size: 11px; }
      .tools-group-arrow { margin-left: auto; color: var(--muted); font-size: 10px; }
      .tools-group-arrow::before { content: '▸'; }
      .tools-group.open .tools-group-arrow::before { content: '▾'; }
      .tools-group-body { display: none; border-top: 1px solid var(--border); padding: 8px 8px 2px; }
      .tools-group.open .tools-group-body { display: block; }
```

- [ ] **Step 2.3:** Рядом (тот же новый блок) — CSS вложенного undo-поповера и компактного usage-badge:

```css
      /* «Откат маркеров» внутри поповера «Ещё» (28.07.2026) */
      .more-popover .undo-menu { display: block; position: relative; }
      .more-popover .undo-menu > button { display: block; width: 100%; text-align: left; }
      .more-popover .undo-menu .undo-popover {
        right: calc(100% + 6px);
        left: auto;
        top: 0;
      }
      /* Компактный бейдж токенов */
      .usage-menu .usage-badge {
        font-size: 10px;
        padding: 1px 6px;
        background: var(--border);
        border-radius: 8px;
        color: var(--muted);
        white-space: nowrap;
        display: inline-block;
      }
```

Примечание: правило `.usage-menu .usage-badge { cursor: pointer; }` уже существует (~100) — новое правило дополняет его (cursor не дублировать, оставить старое как есть).

- [ ] **Step 2.4:** Проверка: открыть index2.html в браузере не нужно — просто убедиться, что `grep -c 'mc-advanced' client/unified/index2.html` возвращает `1` (осталось только вхождение в разметке `<details class="mc-advanced">`, его заменит Task 5).

---

### Task 3: Ре-парентинг карточек в 5 групп + удаление card-jcuts

**Files:** Modify: `client/unified/index2.html` (внутри `<div class="tools-scroll" id="tools-scroll">`)

Механика: карточки переносятся ЦЕЛИКОМ (от `<div class="tool-card"...>` до закрывающего `</div>` с комментариями-заголовками), содержимое карточек в этом Task не меняется. Итоговая структура внутри `#tools-scroll`:

```html
<div class="tools-group" data-group="cleanup">
  <div class="tools-group-head">🧹 Чистка речи <span class="tools-group-cnt">6 инструментов</span><span class="tools-group-arrow"></span></div>
  <div class="tools-group-body">
    <!-- card-silences, card-fillers, card-profanity, card-jumps, card-trim-edges, card-gaps -->
  </div>
</div>
<div class="tools-group" data-group="multicam">
  <div class="tools-group-head">🎥 Мультикам и спикеры <span class="tools-group-cnt">2</span><span class="tools-group-arrow"></span></div>
  <div class="tools-group-body">
    <!-- card-multicam, card-speakers -->
  </div>
</div>
<div class="tools-group" data-group="reels">
  <div class="tools-group-head">🎬 Рилс и субтитры <span class="tools-group-cnt">1</span><span class="tools-group-arrow"></span></div>
  <div class="tools-group-body">
    <!-- card-reels -->
  </div>
</div>
<div class="tools-group" data-group="structure">
  <div class="tools-group-head">📑 Структура ролика <span class="tools-group-cnt">2</span><span class="tools-group-arrow"></span></div>
  <div class="tools-group-body">
    <!-- card-chapters, card-markers-export -->
  </div>
</div>
<div class="tools-group" data-group="service">
  <div class="tools-group-head">🔧 Сервис <span class="tools-group-cnt">2</span><span class="tools-group-arrow"></span></div>
  <div class="tools-group-body">
    <!-- card-loudnorm, card-backups -->
  </div>
</div>
```

- [ ] **Step 3.1:** Удалить card-jcuts целиком (строки 1029–1036: `<div class="tool-card" id="card-jcuts" ...>` … `</div>`). Комментарий `<!-- 6. J-cuts / L-cuts — ОТКЛЮЧЕНО ... -->` (~1006) тоже удалить.
- [ ] **Step 3.2:** Построить группу `cleanup`: вставить обёртку, перенести внутрь card-silences, затем card-fillers, card-profanity, card-jumps, card-trim-edges, card-gaps (именно в этом порядке — fillers/profanity поднимаются выше jumps, trim-edges опускается после jumps).
- [ ] **Step 3.3:** Группа `multicam`: card-multicam, card-speakers.
- [ ] **Step 3.4:** Группа `reels`: card-reels.
- [ ] **Step 3.5:** Группа `structure`: card-chapters, card-markers-export.
- [ ] **Step 3.6:** Группа `service`: card-loudnorm, card-backups.
- [ ] **Step 3.7:** Проверка целостности разметки и ID:

```bash
cd "C:\Users\Глеб\Documents\Extensions-LLM-Chat_Pr" && grep -o 'id="[^"]*"' client/unified/index2.html | sort > tmp/ids-after.txt && diff tmp/ids-before.txt tmp/ids-after.txt
```

Expected: единственная разница — `< id="card-jcuts"` (удалён). Никаких других `<`-строк.

---

### Task 4: Спойлер «⚙ Тонкая настройка» в card-silences

**Files:** Modify: `client/unified/index2.html` (card-silences)

- [ ] **Step 4.1:** Внутри card-silences оставить видимыми: title, desc, param-row «Темп» (`sil-preset`), canvas `wave-silences`, `wave-legend-silences`, кнопку `data-tool="silences"`, `proposal-silences`. Шесть param-row (Режим `sil-mode`, Мин. длительность `sil-min`, Тише речи на `sil-thresh`, Отступ до `sil-pad`, Отступ после `sil-pad-after`, Кроссфейд `sil-crossfade`) перенести БЕЗ ИЗМЕНЕНИЙ внутрь нового элемента, вставляемого сразу после param-row «Темп»:

```html
            <details class="tool-advanced" data-adv="card-silences">
              <summary>⚙ Тонкая настройка (6)</summary>
              <!-- сюда переносятся 6 param-row: sil-mode, sil-min, sil-thresh(+Авто), sil-pad, sil-pad-after, sil-crossfade -->
            </details>
```

Существующие HTML-комментарии (A1/A3/B1/P1-1) переносятся вместе со своими param-row.

---

### Task 5: Спойлер в card-multicam (переименование + перенос Tier-1 слайдеров)

**Files:** Modify: `client/unified/index2.html` (card-multicam, строки ~833–901 до правок)

- [ ] **Step 5.1:** Заменить `<details class="mc-advanced">` на `<details class="tool-advanced" data-adv="card-multicam">`, а `<summary>⚙ Тонкая настройка</summary>` на `<summary>⚙ Тонкая настройка (14)</summary>`.
- [ ] **Step 5.2:** Перенести param-row «Мин. план» (`mc-minhold`, ~823–827) и «Порог лидера» (`mc-margin`, ~828–832) внутрь details — в самое начало, ПЕРЕД `<div class="mc-section-title">Ритм и перебивки</div>`. Видимыми остаются: Дорожки (`mc-map-mode` + `mc-mapping`), Пресет (`mc-preset` + `mc-preset-save`), кнопка, proposal-multicam. Класс `.mc-section-title` не трогать (его CSS живёт отдельно).
- [ ] **Step 5.3:** Проверка: `grep -c 'mc-advanced' client/unified/index2.html` → `0`.

---

### Task 6: Спойлер в card-reels + переезд undo в «Ещё»

**Files:** Modify: `client/unified/index2.html` (card-reels ~932–1004; action-bar 506–537)

- [ ] **Step 6.1:** В card-reels перенести 3 param-row — Шрифт (`rl-font`), Анимация (`rl-anim`), Цвета (`rl-text-color`/`rl-hl-color`) — внутрь нового details, вставляемого сразу после param-row «Формат» (`rl-format`):

```html
            <details class="tool-advanced" data-adv="card-reels">
              <summary>⚙ Тонкая настройка субтитров (3)</summary>
              <!-- сюда переносятся 3 param-row: rl-font, rl-anim, rl-text-color/rl-hl-color -->
            </details>
```

Видимыми остаются: Формат, Фокус камер (`rl-offsets`), Виральность (`rl-viral-preset`/`rl-viral-len`), `rl-viral-custom`, все кнопки, `rl-edit-cues`, `rl-result`.

- [ ] **Step 6.2:** В action-bar чата: вырезать span `undo-menu` (517–520 целиком) и вставить его ПЕРВЫМ элементом внутри `<div class="more-popover">` (перед `btn-view-transcript`), добавив после него `<hr />`. У `btn-undo` убрать `class="secondary"` (кнопка стилизуется как пункт меню правилом `.more-menu .more-popover button`). ID `undo-menu`, `btn-undo`, `undo-popover` не меняются:

```html
            <div class="more-popover">
              <span class="more-menu undo-menu" id="undo-menu">
                <button type="button" id="btn-undo">Откат маркеров</button>
                <div class="more-popover undo-popover" id="undo-popover"></div>
              </span>
              <hr />
              <button type="button" id="btn-view-transcript">Читать транскрипт</button>
              ...
```

- [ ] **Step 6.3:** Повторить ID-diff из Step 3.7 — по-прежнему только `card-jcuts` в разнице.

---

### Task 7: Тексты карточек по фактическому поведению

**Files:** Modify: `client/unified/index2.html` (только `.tool-card-desc`; title-тултипы param-row НЕ трогать)

- [ ] **Step 7.1:** Заменить desc у 5 карточек (остальные 8 уже точные — писались/сверялись недавно, их не трогать):

card-silences (было «Гигиена звука: убирает явные паузы ≥1с…»):
```html
<div class="tool-card-desc">Находит паузы по громкости (ffmpeg, без транскрипта) и по выбранному режиму вырезает, глушит или оставляет дыры. План виден на waveform до применения.</div>
```

card-fillers (было «Находит слова-паразиты в начале/конце фраз…»):
```html
<div class="tool-card-desc">Вырезает слова-паразиты по word-таймингам транскрипта: строгий режим — только однозначные («эээ», «ммм», «ну», «блин»), расширенный — плюс контекстные и филлер-сегменты до 2.5с.</div>
```

card-jumps (было «Ритм: агрессивно сжимает паузы, YouTube-стиль…»):
```html
<div class="tool-card-desc">Сжимает все паузы длиннее порога до короткого «дыхания» (по громкости, без транскрипта) — плотный YouTube-ритм. План виден на waveform до применения.</div>
```

card-chapters (было «Маркеры-главы по темам. 1 вызов LLM если темы не в кэше.»):
```html
<div class="tool-card-desc">Разбивает транскрипт на темы (1 вызов LLM, темы кэшируются) и ставит маркеры-главы на таймлайн. Свои указания перестраивают разбивку.</div>
```

card-multicam (было «Подкаст-нарезка: V1 wide + V2..Vn гости…»):
```html
<div class="tool-card-desc">Автопереключение камер по громкости микрофонов (ffmpeg, без транскрипта): razor + включение активной камеры. Кнопка только предлагает план — применение отдельным шагом.</div>
```

---

### Task 8: Новый JS — client/unified/tools-accordion.js + подключение

**Files:** Create: `client/unified/tools-accordion.js`; Modify: `client/unified/index2.html` (массив `scripts` в конце файла)

- [ ] **Step 8.1:** Создать файл целиком:

```js
/* Аккордеон групп вкладки «Инструменты» + спойлеры «⚙ Тонкая настройка»
   + авто-раскрытие группы при показе proposal/статуса (UI-переработка 28.07.2026).
   Логика инструментов живёт в panel.js и не знает про группы: здесь только
   показ/скрытие контейнеров. ES5 (CEP-Chromium). Грузится ПОСЛЕ panel.js. */
(function () {
  'use strict';
  var GROUP_KEY = 'extllmpr_v1_tools_group';
  var ADV_PREFIX = 'extllmpr_v1_adv_';
  var GROUP_ALL_CLOSED = '__none__';

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }

  /* Перерисовка waveform после раскрытия: в скрытом контейнере canvas имел
     нулевую ширину. Функцию экспортирует panel.js (переопределяется на reload). */
  function notifyReveal() {
    if (typeof window.__omcToolsWaveformReveal === 'function') {
      try { window.__omcToolsWaveformReveal(); } catch (e) {}
    }
  }

  var groups = document.querySelectorAll('.tools-group');

  function openGroup(name, persist) {
    var found = false;
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].getAttribute('data-group') === name) {
        groups[i].classList.add('open');
        found = true;
      } else {
        groups[i].classList.remove('open');
      }
    }
    if (found) {
      if (persist) lsSet(GROUP_KEY, name);
      notifyReveal();
    }
  }

  function closeAll(persist) {
    for (var i = 0; i < groups.length; i++) groups[i].classList.remove('open');
    if (persist) lsSet(GROUP_KEY, GROUP_ALL_CLOSED);
  }

  /* Авто-раскрытие: elId — id карточки или любого элемента внутри неё
     (например 'proposal-silences'). Если группа карточки свёрнута — раскрыть,
     чтобы proposal/ошибка/статус не потерялись с глаз. */
  window.toolsRevealCard = function (elId) {
    var el = document.getElementById(elId);
    if (!el) return;
    var g = el;
    while (g && g !== document.body) {
      if (g.classList && g.classList.contains('tools-group')) break;
      g = g.parentNode;
    }
    if (!g || g === document.body || !g.classList) return;
    if (!g.classList.contains('open')) openGroup(g.getAttribute('data-group'), true);
  };

  /* Клик по заголовку: открытая группа сворачивается (все закрыты — допустимо),
     закрытая — открывается, прежняя сворачивается. */
  for (var gi = 0; gi < groups.length; gi++) {
    (function (g) {
      var head = g.querySelector('.tools-group-head');
      if (!head) return;
      head.onclick = function () {
        if (g.classList.contains('open')) closeAll(true);
        else openGroup(g.getAttribute('data-group'), true);
      };
    })(groups[gi]);
  }

  /* Начальное состояние: последняя открытая группа; дефолт — «Чистка речи». */
  var saved = lsGet(GROUP_KEY);
  if (saved === GROUP_ALL_CLOSED) closeAll(false);
  else openGroup(saved || 'cleanup', false);
  if (saved && saved !== GROUP_ALL_CLOSED) {
    /* сохранённая группа могла исчезнуть из разметки — тогда дефолт */
    var anyOpen = document.querySelector('.tools-group.open');
    if (!anyOpen) openGroup('cleanup', false);
  }

  /* Спойлеры «⚙ Тонкая настройка»: native <details>, персистентность per-карточка. */
  var advs = document.querySelectorAll('details.tool-advanced[data-adv]');
  for (var ai = 0; ai < advs.length; ai++) {
    (function (d) {
      var key = ADV_PREFIX + d.getAttribute('data-adv');
      if (lsGet(key) === '1') d.open = true;
      d.addEventListener('toggle', function () {
        lsSet(key, d.open ? '1' : '0');
        if (d.open) notifyReveal();
      });
    })(advs[ai]);
  }
})();
```

- [ ] **Step 8.2:** В index2.html в массиве `scripts` после элемента `'panel.js'` добавить `'tools-accordion.js'`:

```js
          'panel.js',
          'tools-accordion.js'
        ];
```

- [ ] **Step 8.3:** `node --check client/unified/tools-accordion.js` → без ошибок.

---

### Task 9: Hook-точки в panel.js (3 точечных дополнения)

**Files:** Modify: `client/unified/panel.js` (~7225, ~7486, ~8023)

- [ ] **Step 9.1:** После определения `toolsShowWaveform` (после закрывающей `}` функции, ~7225) добавить:

```js
    /* UI-переработка 28.07.2026: перерисовка waveform после раскрытия
       группы/спойлера аккордеона (в скрытом контейнере canvas был нулевой
       ширины). Зовёт tools-accordion.js. Присваивание (не addEventListener) —
       на reload панели переопределяется без утечки старого замыкания. */
    window.__omcToolsWaveformReveal = function () {
      var st = _waveState;
      if (st && st.entry && st.canvas && !st.canvas.hidden) {
        toolsShowWaveform(st.toolName, st.entry);
      }
    };
```

- [ ] **Step 9.2:** В `toolsSetCardStatus` (~7480) заменить строку

```js
      if (seqKey === _toolsStatusSeqKey) _renderCardStatus(cardId, _toolsCardStatus[seqKey][cardId]);
```

на

```js
      if (seqKey === _toolsStatusSeqKey) {
        _renderCardStatus(cardId, _toolsCardStatus[seqKey][cardId]);
        /* UI-переработка 28.07.2026: итог не должен потеряться в свёрнутой группе */
        if (window.toolsRevealCard) window.toolsRevealCard(cardId);
      }
```

(Важно: reveal именно здесь, а НЕ в `_renderCardStatus` — иначе смена секвенции с её `_renderAllCardStatuses` раскрывала бы группы без действия пользователя.)

- [ ] **Step 9.3:** В `toolsShowProposal` (~8017) после строки `area.className = 'proposal-area visible';` добавить:

```js
      /* UI-переработка 28.07.2026: раскрыть группу, если карточка свёрнута */
      if (window.toolsRevealCard) window.toolsRevealCard(areaId);
```

- [ ] **Step 9.4:** `node --check client/unified/panel.js` → без ошибок.

---

### Task 10: Статические проверки

- [ ] **Step 10.1:** `npm test` → 1008/1008 pass (логика не менялась).
- [ ] **Step 10.2:** Финальный ID-diff (как Step 3.7): единственная разница — `card-jcuts`.
- [ ] **Step 10.3:** Санити grep:

```bash
cd "C:\Users\Глеб\Documents\Extensions-LLM-Chat_Pr" && grep -c 'tools-group' client/unified/index2.html && grep -c 'data-adv' client/unified/index2.html && grep -c 'jcut' client/unified/index2.html
```

Expected: tools-group ≥ 20 (CSS+разметка), data-adv = 3, jcut = 0.

---

### Task 11: CDP live-валидация (панель открыта в Premiere)

**Files:** Create: `tmp/cdp-ui-accordion.js` (валидационный скрипт)

- [ ] **Step 11.1:** `node tools/cep-debug.mjs reload` — перезагрузить панель.
- [ ] **Step 11.2:** Записать `tmp/cdp-ui-accordion.js`:

```js
/* Валидация аккордеона: структура, эксклюзивность, localStorage, спойлеры, reveal */
(function () {
  var out = [];
  function t(name, cond) { out.push((cond ? 'PASS' : 'FAIL') + ' ' + name); }
  var gs = document.querySelectorAll('.tools-group');
  t('групп = 5', gs.length === 5);
  t('карточек = 13', document.querySelectorAll('.tool-card').length === 13);
  t('card-jcuts удалён', !document.getElementById('card-jcuts'));
  t('открыта ровно 1 группа', document.querySelectorAll('.tools-group.open').length === 1);
  /* клик по structure */
  var st = document.querySelector('.tools-group[data-group="structure"] .tools-group-head');
  st.click();
  t('после клика открыта structure', document.querySelector('.tools-group.open').getAttribute('data-group') === 'structure');
  t('открыта ровно 1 (эксклюзивность)', document.querySelectorAll('.tools-group.open').length === 1);
  t('localStorage=structure', localStorage.getItem('extllmpr_v1_tools_group') === 'structure');
  /* клик по открытой — все закрыты */
  st.click();
  t('повторный клик: все закрыты', document.querySelectorAll('.tools-group.open').length === 0);
  t('localStorage=__none__', localStorage.getItem('extllmpr_v1_tools_group') === '__none__');
  /* авто-раскрытие */
  window.toolsRevealCard('proposal-silences');
  t('reveal открыл cleanup', document.querySelector('.tools-group.open') && document.querySelector('.tools-group.open').getAttribute('data-group') === 'cleanup');
  /* спойлеры */
  var d = document.querySelector('details[data-adv="card-silences"]');
  t('спойлер silences есть и закрыт', !!d && !d.open);
  d.open = true; /* toggle-событие асинхронно — localStorage проверим кадром позже */
  var d2 = document.querySelector('details[data-adv="card-multicam"]');
  var d3 = document.querySelector('details[data-adv="card-reels"]');
  t('спойлеры multicam+reels есть', !!d2 && !!d3);
  t('sil-mode внутри спойлера', !!document.querySelector('details[data-adv="card-silences"] #sil-mode'));
  t('mc-minhold внутри спойлера', !!document.querySelector('details[data-adv="card-multicam"] #mc-minhold'));
  t('rl-font внутри спойлера', !!document.querySelector('details[data-adv="card-reels"] #rl-font'));
  /* чат: undo внутри «Ещё» */
  t('undo-menu внутри more-popover', !!document.querySelector('#more-menu .more-popover #undo-menu'));
  t('btn-undo жив', !!document.getElementById('btn-undo'));
  t('waveform-hook экспортирован', typeof window.__omcToolsWaveformReveal === 'function');
  /* вернуть дефолт */
  localStorage.setItem('extllmpr_v1_tools_group', 'cleanup');
  return out.join('\n');
})();
```

- [ ] **Step 11.3:** `node tools/cep-debug.mjs evalfile tmp/cdp-ui-accordion.js` → все PASS. Затем вторым eval проверить персистентность спойлера: `localStorage.getItem('extllmpr_v1_adv_card-silences')` → `'1'`.
- [ ] **Step 11.4:** `node tools/cep-debug.mjs reload` и eval: группа из localStorage открыта, спойлер card-silences открыт (восстановился).

---

### Task 12: Smoke живьём + коммит

- [ ] **Step 12.1:** Smoke в панели (руками или CDP): «⚡ Анализ аудио» → открыть card-silences → waveform отрисован; свернуть группу, раскрыть — waveform перерисован (не схлопнулся в 2px); «Найти и вырезать» до proposal; «Бэкапы» → «⟳ Обновить список» → список виден; «Ещё ▾» → «Откат маркеров» виден пунктом меню, поповер списка (если >1 чекпоинта) не обрезается.
- [ ] **Step 12.2:** С одобрения пользователя — коммит:

```bash
git add client/unified/index2.html client/unified/tools-accordion.js client/unified/panel.js docs/superpowers/specs/2026-07-28-ui-overhaul-design.md docs/superpowers/plans/2026-07-28-ui-overhaul.md
git commit -m "feat(ui): аккордеон групп инструментов + прогрессивное раскрытие параметров"
```

---

## Self-review

- **Spec coverage:** §1 группы/порядок — Task 3; удаление card-jcuts — Task 3.1 (+факт: обвязка терпит, case 'jcuts' недостижим); §2 аккордеон/localStorage/авто-раскрытие/ES5 — Tasks 8–9; §3 спойлеры (тишины/мультикам/рилс, ключи adv) — Tasks 4–6; нюанс waveform — Steps 9.1 + 12.1; §4 тексты — Task 7; §5 чат (undo → «Ещё», компактный бейдж) — Steps 6.2 + 2.3; §6 «не делаем» — соблюдено (ID-diff в Tasks 3.7/6.3/10.2 это доказывает); §7 тестирование — Tasks 1, 10, 11, 12.
- **Placeholders:** нет TBD/TODO; все код-шаги содержат полный код.
- **Type consistency:** `toolsRevealCard(elId)` (Task 8) ↔ вызовы `window.toolsRevealCard(cardId|areaId)` (Task 9) — сигнатура совпадает (id элемента или карточки, оба резолвятся через подъём к `.tools-group`); ключи localStorage единые: `extllmpr_v1_tools_group`, `extllmpr_v1_adv_<cardId>`; `__omcToolsWaveformReveal` объявлен в 9.1, вызывается в 8.1.
