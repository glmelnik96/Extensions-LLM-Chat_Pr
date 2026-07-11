# Авто-MultiCam UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переставить карточку `#card-multicam`: 4 базовых контрола видны, 12 редких свёрнуты под нативный `<details>` в 4 секции; уточнить 3 названия и все подсказки. Логика не трогается.

**Architecture:** Чисто презентационная правка `client/unified/index2.html`. id всех контролов сохраняются → panel.js читает по id, порядок в DOM не важен → JS не меняется. Сворачивание — `<details>`/`<summary>`, стартует свёрнутым (без `open`). Секции внутри — подзаголовки-`<div>`.

**Tech Stack:** HTML + CSS (переменные `--muted`/`--border`/`--accent`/`--text` уже есть). Проверка — CDP-прогон (`node tools/cep-debug.mjs`) + `npm test`.

---

### Task 1: CSS для сворачиваемого блока и подзаголовков секций

**Files:**
- Modify: `client/unified/index2.html` (блок `<style>`, рядом с `.param-row` ~строка 281)

- [ ] **Step 1: Добавить стили** после правила `.param-val { ... }` (~строка 281):

```css
      .mc-advanced { margin: 8px 0 4px; border-top: 1px solid var(--border); padding-top: 6px; }
      .mc-advanced > summary {
        font-size: 11px;
        font-weight: 600;
        color: var(--muted);
        cursor: pointer;
        list-style: none;
        padding: 2px 0;
        user-select: none;
      }
      .mc-advanced > summary::-webkit-details-marker { display: none; }
      .mc-advanced > summary::before { content: '▸ '; }
      .mc-advanced[open] > summary::before { content: '▾ '; }
      .mc-section-title {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
        opacity: 0.7;
        margin: 8px 0 4px;
      }
```

- [ ] **Step 2: Визуальная проверка** — отложена до Task 3 (CDP-прогон). CSS сам по себе не тестируется.

---

### Task 2: Переставить и перегруппировать HTML карточки

**Files:**
- Modify: `client/unified/index2.html:559-626` (тело карточки от «Мин. план» до «Сдвиг привязки»)

Порядок в DOM после правки:
1. Дорожки (`mc-map-mode`) — уже на месте (строки 540-547), НЕ трогаем
2. Пресет (`mc-preset`) — уже на месте (549-558), НЕ трогаем
3. Мин. план (`mc-minhold`)
4. Порог лидера (`mc-margin`)
5. `<details class="mc-advanced">` с summary «⚙ Тонкая настройка» → 4 секции:
   - Ритм и перебивки: `mc-maxhold`, `mc-overlap`, `mc-maxall`, `mc-wide-silence`, `mc-wide-overlap`
   - Чувствительность звука: `mc-silence`, `mc-smooth`
   - Точность резов: `mc-snap`, `mc-snapoff`
   - Вариативность и анализ: `mc-jitter`, `mc-seed`, `mc-framesec`

- [ ] **Step 1: Заменить блок строк 559-626** (от `<div class="param-row" title="Минимальная...`  до закрывающего `</div>` строки «Сдвиг привязки») цельным новым фрагментом. Полный фрагмент — в разделе «HTML-фрагмент Task 2» ниже. Названия/подсказки в нём уже финальные (переименования `mc-overlap`→«Терпеть перебивки», `mc-maxall`→«Длина общего плана», `mc-seed`→«Дубль»). Диапазоны/шаги/дефолты/id всех input — БЕЗ изменений.

- [ ] **Step 2: Grep-проверка что ни один id не потерян**

Run: `grep -oE 'id="mc-[a-z-]+"' client/unified/index2.html | sort -u`
Expected: присутствуют все — mc-framesec, mc-jitter, mc-map-mode, mc-mapping, mc-margin, mc-maxall, mc-maxhold, mc-minhold, mc-overlap, mc-preset, mc-seed, mc-silence, mc-smooth, mc-snap, mc-snapoff, mc-wide-overlap, mc-wide-silence (+ `-val` спаны, + mc-preset-save)

---

### Task 3: Live-проверка (CDP) + сюита

**Files:** нет правок, только проверка

- [ ] **Step 1: Reload панели**

Run: `node tools/cep-debug.mjs reload`
Expected: панель перезагрузилась без ошибок

- [ ] **Step 2: Визуальный снимок структуры** — evalfile-проба (tmp/mc_ui_check.js): проверить что видимы 4 param-row до `<details>`, что `<details>` НЕ open, что внутри 4 `.mc-section-title`. Скрипт печатает счётчики. Ожидание: baseVisible=4-ish, detailsOpen=false, sections=4.

- [ ] **Step 3: Прогон multicam при свёрнутом блоке + спай** — evalfile (tmp/mc_ui_run.js): обернуть `MulticamPlan.buildSwitchPlan`, кликнуть кнопку, дождаться, прочитать `window.__cap`. Ожидание: 4 tier-параметра (wideOnSilence/wideOnOverlap/snapWindowSec/frameOffsetSec) доходят до плана; сегменты построены; ошибок консоли нет.

- [ ] **Step 4: Пресет двигает спрятанные слайдеры** — evalfile: выбрать пресет «dynamic», прочитать value спрятанных `mc-maxhold`/`mc-jitter`. Ожидание: значения изменились относительно дефолтов.

- [ ] **Step 5: Юнит-сюита**

Run: `npm test`
Expected: 763/763 pass (логика не тронута)

- [ ] **Step 6: Commit** (после явной отмашки пользователя — стандартное правило проекта)

---

## HTML-фрагмент Task 2

Вставляется на место строк 559-626 (после блока «Пресет», перед кнопкой строки 629):

```html
            <div class="param-row" title="Минимум секунд на одной камере. Влево = чаще режем, живее. Вправо = спокойнее, реже.">
              <span class="param-label">Мин. план</span>
              <input type="range" id="mc-minhold" min="0.5" max="4" step="0.1" value="1.5" />
              <span class="param-val" id="mc-minhold-val">1.5с</span>
            </div>
            <div class="param-row" title="Насколько микрофон громче остальных, чтобы забрать план. Вправо = увереннее держим одного, реже дёргаемся на чужой звук.">
              <span class="param-label">Порог лидера</span>
              <input type="range" id="mc-margin" min="3" max="12" step="1" value="6" />
              <span class="param-val" id="mc-margin-val">6 dB</span>
            </div>
            <details class="mc-advanced">
              <summary>⚙ Тонкая настройка</summary>

              <div class="mc-section-title">Ритм и перебивки</div>
              <div class="param-row" title="Дольше этого один спикер в кадре не держится — вставляем общий план, чтобы картинка не застыла.">
                <span class="param-label">Макс. план</span>
                <input type="range" id="mc-maxhold" min="3" max="15" step="0.5" value="8" />
                <span class="param-val" id="mc-maxhold-val">8с</span>
              </div>
              <div class="param-row" title="Короткие реплики поверх (кросс-ток) короче этого НЕ уводят в общий план — держим говорящего. Больше = терпимее. 0 = выкл.">
                <span class="param-label">Терпеть перебивки</span>
                <input type="range" id="mc-overlap" min="0" max="3" step="0.25" value="1" />
                <span class="param-val" id="mc-overlap-val">1с</span>
              </div>
              <div class="param-row" title="Сколько длится общий план, вставленный в длинный монолог. Меньше = короткие мелькания, больше = спокойные вставки.">
                <span class="param-label">Длина общего плана</span>
                <input type="range" id="mc-maxall" min="0.5" max="4" step="0.5" value="4" />
                <span class="param-val" id="mc-maxall-val">4с</span>
              </div>
              <div class="param-row" title="Пауза (никто не говорит) → общий план. Выкл = держим камеру последнего говорившего.">
                <span class="param-label">Общий на паузах</span>
                <input type="checkbox" id="mc-wide-silence" checked />
              </div>
              <div class="param-row" title="Говорят разом → общий план. Выкл = держим последнего говорившего.">
                <span class="param-label">Общий на перебивках</span>
                <input type="checkbox" id="mc-wide-overlap" checked />
              </div>

              <div class="mc-section-title">Чувствительность звука</div>
              <div class="param-row" title="Тише этого микрофон считается молчащим. Вправо = порог ниже (строже, реже слышим тишину).">
                <span class="param-label">Порог тишины</span>
                <input type="range" id="mc-silence" min="20" max="50" step="1" value="35" />
                <span class="param-val" id="mc-silence-val">-35 dB</span>
              </div>
              <div class="param-row" title="Гасит покадровое дрожание камеры. Больше = плавнее; слишком много = проспим быстрые реплики.">
                <span class="param-label">Сглаживание</span>
                <input type="range" id="mc-smooth" min="1" max="15" step="2" value="5" />
                <span class="param-val" id="mc-smooth-val">5 кадр.</span>
              </div>

              <div class="mc-section-title">Точность резов</div>
              <div class="param-row" title="Подтягивает рез к ближайшей паузе / началу слова, чтобы не резать посреди слова. 0 = выкл. Больше = сильнее.">
                <span class="param-label">Привязка к паузам</span>
                <input type="range" id="mc-snap" min="0" max="0.5" step="0.05" value="0" />
                <span class="param-val" id="mc-snap-val">выкл</span>
              </div>
              <div class="param-row" title="Тонкий сдвиг реза: минус = раньше (до первого слова), плюс = позже. Только при «Привязка» > 0.">
                <span class="param-label">Сдвиг привязки</span>
                <input type="range" id="mc-snapoff" min="-0.2" max="0.2" step="0.05" value="0" />
                <span class="param-val" id="mc-snapoff-val">0мс</span>
              </div>

              <div class="mc-section-title">Вариативность и анализ</div>
              <div class="param-row" title="Случайный разброс длины планов, чтобы нарезка не была механически ровной. 0 = выкл.">
                <span class="param-label">Вариативность</span>
                <input type="range" id="mc-jitter" min="0" max="0.5" step="0.05" value="0" />
                <span class="param-val" id="mc-jitter-val">выкл</span>
              </div>
              <div class="param-row" title="Перетасовка рисунка разброса. Не понравился прогон → сдвинь, получишь другой. Только при «Вариативность» > 0.">
                <span class="param-label">Дубль</span>
                <input type="range" id="mc-seed" min="1" max="20" step="1" value="1" />
                <span class="param-val" id="mc-seed-val">#1</span>
              </div>
              <div class="param-row" title="Шаг анализа звука. Влево = точнее границы резов, но дольше. 50мс — оптимум для речи.">
                <span class="param-label">Шаг анализа</span>
                <input type="range" id="mc-framesec" min="0.05" max="0.2" step="0.05" value="0.05" />
                <span class="param-val" id="mc-framesec-val">50мс</span>
              </div>
            </details>
```

## Self-review

- **Spec coverage:** 4 базовых ✓, 4 секции с 12 контролами ✓, 3 переименования ✓, все подсказки ✓, `<details>` без `open` (свёрнуто) ✓, id не меняются ✓, проверки CDP+пресет+сюита ✓.
- **Placeholders:** нет — весь HTML/CSS приведён целиком.
- **Type/id consistency:** все id и `-val` спаны совпадают с оригиналом; переименованы только тексты `<span class="param-label">` и `title`.
- **Дорожки/Пресет:** остаются как есть (строки 540-558), подсказки к ним из спеки применяются отдельным мелким шагом в Task 2 Step 1 (title на `mc-map-mode` param-row и `mc-preset` param-row) — учтено при правке.
```

> Примечание: подсказки «Дорожки» и «Пресет» из спеки добавляются к их param-row (строки 540, 549) — эти строки сейчас без `title`. Включить в правку Task 2.
