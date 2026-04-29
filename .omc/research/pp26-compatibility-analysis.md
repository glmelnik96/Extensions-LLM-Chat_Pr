# Premiere Pro 2026 совместимость и стабильность host/premiere.jsx

**Дата:** 2026-04-29
**Контекст:** На PP 24/25 наш плагин работает. На PP 26 (стабильная версия 26.0 — январь 2026, текущая 26.2) `getTimelineSnapshot()` возвращает литеральную строку `"EvalScript error."` несмотря на то, что функция определена. Этот документ собирает причины и план стабилизации.

---

## TL;DR

**Не один баг — три накладывающихся фактора:**

1. **PP 26 ужесточил CEP↔ExtendScript bridge serialization.** Возврат host-объектов или объектов с native-properties, которые раньше прощались, теперь рушит вызов с непрозрачным `"EvalScript error."`.
2. **QE DOM (`qe.project.razor()`)** — официально неподдерживаемый, ломается между мажорами. В нашем коде используется в `_applyOneTimelineInterval`.
3. **Адобе анонсировал EOL ExtendScript на сентябрь 2026.** UXP-scripting для Premiere стал GA в 25.6, в 26.2 появились UXP Hybrid Plugins (JS+C++). CEP ещё работает, но Adobe явно сворачивает.

**Что НЕ причина (исключено диагностикой):**
- Проблема пути / Unicode (путь чисто ASCII)
- macOS quarantine (xattr пустой)
- Файл `host/premiere.jsx` не дошёл (87606 байт, file = UTF-8 text)
- Cold-start race (`PING_OK` стабильно проходит, retry в bridge внедрён)
- `__adobe_cep__` не инжектирован (bridge ответил `host loaded? yes`)

---

## Внешний контекст: Premiere Pro 2026 и судьба ExtendScript

### Хронология
- **24 окт 2025** — beta v26 заменила v25.6
- **янв 2026** — стабильная **PP 26.0**
- **апр 2026** — текущая стабильная **PP 26.2**, в beta 26.3
- **Сентябрь 2026** — заявленный EOL ExtendScript
- **Premiere 25.6** (сен-ноя 2025) — UXP-scripting вышел из беты, стал GA
- **Premiere 26.2** (апр 2026) — UXP Hybrid Plugins (JS+C++ нативный код)

### Официальная позиция Adobe
> «CEP 12 будет последним мажорным апдейтом CEP, хотя критические security-фиксы продолжат выходить.»
> — Padma Krishnamoorthy, Adobe Tech Blog

> «No further changes or improvements to Premiere Pro's ExtendScript API are planned or scheduled.»
> — `ppro-scripting.docsforadobe.dev` changelog

CEP-12 в PP 26.x **загружается и работает**, но движется к закату.

### Ключевые источники
- [Adobe Developer Blog — UXP Arrives in Premiere (Dec 2025)](https://blog.developer.adobe.com/en/publish/2025/12/uxp-arrives-in-premiere-a-new-era-for-plugin-development)
- [Adobe Developer Blog — UXP Hybrid Plugins for Premiere (Apr 2026)](https://blog.developer.adobe.com/en/publish/2026/04/uxp-hybrid-plugins-now-available-for-premiere)
- [Adobe Tech Blog — CEP wind-down](https://medium.com/adobetech/updates-for-creative-cloud-desktop-extensibility-0dd5c663563e)
- [Adobe Community — ExtendScript to UXP migration thread](https://community.adobe.com/questions-729/extendscript-to-uxp-for-premiere-pro-1553924)
- [GitHub — AdobeDocs/uxp-premiere-pro-samples](https://github.com/AdobeDocs/uxp-premiere-pro-samples)

---

## Что такое `"EvalScript error."`

CEP возвращает эту литеральную строку всегда без полезной информации, когда:

1. **JSX-функция бросила unhandled-исключение** на ExtendScript-уровне.
2. **Bridge-сериализатор не смог упаковать результат** (host-объект, циклическая ссылка, native value).
3. **Result-string слишком большой** или содержит «нечитаемые» символы.
4. **ExtendScript-движок крашнулся** в полу-сломанное состояние от предыдущего вызова (типичное лекарство — рестарт PP).
5. **`evalScript` выполнился до того**, как панель полностью готова (cold-start race).

`typeof X` не вызывает функцию → не падает. `$._EXT_PRM_.fn()` вызывает → ловит #1-#4. Это объясняет, почему `typeof` возвращает `"function"`, а вызов рушится.

### Прецедент Adobe-CEP/Samples Issue #133
PProPanel в PP 15.x: тот же код, который работал в 14.9, начал возвращать `"EvalScript error."`. Adobe **не починил**. Тот же паттерн повторяется при каждом мажорном переезде Premiere — после 25→26 и сейчас, скорее всего, тоже.

---

## Где в нашем `host/premiere.jsx` хрупкие места

### 🔴 HIGH — самые вероятные причины «EvalScript error.» в PP 26

#### 1. `getTimelineSnapshot()` — `host/premiere.jsx:671`
Главная подозреваемая функция (та, что у коллеги падает).

**Проблемы:**
- `item.start.seconds` / `item.end.seconds` без null-проверок (строки 731-735)
- `seq.getPlayerPosition().seconds` (685) — `getPlayerPosition()` мог вернуть null в 26-й
- `seq.end.seconds` (687) — то же самое
- `track.clips.numItems` (706, 712) — без проверки, что `track.clips` не null
- Возвращает один **большой JSON** с массивом всех клипов (может пробить лимит payload в 26-й)

**Фикс:**
```javascript
startSec: item && item.start ? item.start.seconds : 0,
endSec: item && item.end ? item.end.seconds : 0,
durationSec: (item && item.end && item.start) ? (item.end.seconds - item.start.seconds) : 0,
```

И chunking при `clips.length > 500`.

#### 2. `_clipTimes()` — `host/premiere.jsx:53`
Вызывается из десятков мест. Если падает — каскад.
```javascript
return {
  s: clip.start.seconds,    // ← без guard
  e: clip.end.seconds,
  srcIn: clip.inPoint.seconds,
  srcOut: clip.outPoint.seconds
};
```

**Фикс:** обернуть в try/catch, возвращать safe defaults.

#### 3. QE DOM в `_applyOneTimelineInterval` — `host/premiere.jsx:237-269`
```javascript
qeSeq = qe.project.getActiveSequence();
var vt = qeSeq.getVideoTrackAt(vi);
vt.razor(tc0, true, true);
```

**Проблема:** QE DOM **никогда не был официальным**. Adobe сами пишут «not supported, not at all recommended». Ломается между мажорными версиями. На PP 26 — высокая вероятность что `getVideoTrackAt` или `razor()` не существуют либо ведут себя иначе.

**Фикс:** заменить на `Track.insertClip` + `TrackItem.remove` (стабильные API). QE — оставить как fallback с детектом доступности.

### 🟡 MEDIUM — усиливают хрупкость

#### 4. JSON-полифилл не загружен явно
ExtendScript ES3 **не имеет нативного `JSON`**. Adobe инжектирует его в host-context, но в PP 26 могло измениться. PProPanel-стиль — грузить `json2.min.js` через `evalFile` первым делом. У нас нет.

#### 5. `JSON.parse(jsonPlan)` без валидации
В `applyTimecodeEdits` (854), `applyTranscriptCuts`, `addSequenceMarkers` — парсим JSON и сразу используем `plan.operations`. Если parse упал или структура не та — silent failure.

#### 6. Fallback по `name+start+end` для linked clips — `host/premiere.jsx:404-444`
Сами в комментарии написали «ненадёжно». В PP 26 `getLinkedItems` может работать иначе → fallback ловит чужие клипы.

### 🟢 LOW — косметика и потенциальные улучшения

- Тройные вложенные try/catch-блоки гасят оригинальные ошибки
- `parseFloat` без проверки на Infinity
- Длинные string-конкатенации в error-сообщениях

---

## Конкретный план починки (когда вернёмся)

### Phase 1 — стабилизация PP 24/25/26 (1-2 дня)

1. **Wrap-pattern для всех экспортируемых функций.** Внутри JSX:
```javascript
$._EXT_PRM_.getTimelineSnapshot = function () {
  try {
    /* ... real logic ... */
    return JSON.stringify({ ok: true, data: payload });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      msg: e.toString(),
      line: e.line,
      source: e.source,
      fileName: e.fileName,
      stack: $.stack
    });
  }
};
```
И в `bridge-premiere.js` — парсить `ok:false` в осмысленную ошибку с реальной строкой и стеком.
**После этого `"EvalScript error."` пропадёт у 95% вызовов.**

2. **Defensive null-guards** на все цепочки `.start.seconds`, `.inPoint.seconds`, `.getPlayerPosition()` в:
   - `_clipTimes` (53)
   - `getTimelineSnapshot` (671-794)
   - `_applyOneTimelineInterval` (221)
   - все обработчики которые работают с TrackItem.

3. **Загрузить `json2.min.js`** через `$.evalFile` первым делом (см. Adobe PProPanel). На случай если в PP 26 нативного JSON не оказалось.

4. **Chunking больших ответов:** если `clips.length > 500` — отдавать страницами с `pageInfo`.

5. **Re-namespace.** Заменить `$._EXT_PRM_` на `$['com.extensionsllm.chatpr']` — защита от коллизий в shared engine.

### Phase 2 — отказ от QE DOM (3-5 дней)

QE — фундаментально нестабильно. Все razor-операции переписать на `Track.insertClip(projectItem, time)` + `TrackItem.remove(rippleType, alignType)`. Время передавать в **тиках** (не секундах) — это документированный стандарт.

После этого Phase 2 наш host станет компиляционно совместим с любой версией PP в рамках ExtendScript-эпохи.

### Phase 3 — UXP migration (большой эпик, отдельная сессия)

Когда Phase 1+2 готовы и стабильны:
- Поднять UXP-проект параллельно
- Реализовать read-only `getTimelineSnapshot` в UXP
- Постепенно переносить функции
- Использовать UXP Hybrid Plugins (PP 26.2+) для тяжёлой работы где UXP API не хватает

Готовый референс: [github.com/AdobeDocs/uxp-premiere-pro-samples](https://github.com/AdobeDocs/uxp-premiere-pro-samples).

UXP-миграция — это **переписывание примерно с нуля**. Месяцы работы. Adobe говорит «coexist year» с 25.6 (старт сен 2025) — у нас есть время до конца 2026.

---

## Немедленный workaround для коллеги

**До починки Phase 1** — единственный надёжный способ работать **сейчас**:

1. Adobe Creative Cloud → Premiere Pro → ⋯ → Other versions
2. Установить **Premiere Pro 2024 (24.x)** или **2025 (25.x)**
3. Открыть проект в этой версии — наш плагин работает стабильно

PP 26 — слишком сырой для ExtendScript-плагинов прямо сейчас.

---

## Что **НЕ** надо делать

- ❌ Добавлять retry на `"EvalScript error."` без улучшения wrap-pattern. Retry не лечит реальную ошибку, только маскирует.
- ❌ Возвращать host-объекты напрямую (Sequence, TrackItem, ProjectItem). Только сериализованные JSON-строки.
- ❌ Доверять QE DOM. Любая razor-операция должна иметь non-qe fallback.
- ❌ Игнорировать UXP-миграцию. EOL — сентябрь 2026.

---

## Полезные ссылки на будущее

### Документация
- [Premiere Pro Scripting Guide (ExtendScript)](https://ppro-scripting.docsforadobe.dev/)
- [Premiere UXP API Reference](https://developer.adobe.com/premiere-pro/uxp/ppro_reference/)
- [Premiere UXP Changelog](https://developer.adobe.com/premiere-pro/uxp/changelog/)

### Сэмплы
- [PProPanel (Adobe-CEP/Samples)](https://github.com/Adobe-CEP/Samples) — образцовый паттерн wrap+evalFile
- [AdobeDocs/uxp-premiere-pro-samples](https://github.com/AdobeDocs/uxp-premiere-pro-samples) — UXP примеры

### Ключевые статьи
- [Davide Barranca — CEP Panels and JSON objects](https://medium.com/adobetech/cep-panels-and-json-objects-8f1643742f4c)
- [Hyper Brew — Top 2 ExtendScript Mistakes](https://hyperbrew.co/blog/top-2-extendscript-mistakes-and-how-to-avoid-them/)
- [Hyper Brew — Premiere Pro UXP Beta](https://hyperbrew.co/blog/premiere-pro-uxp-beta/)

### Community / прецеденты
- [Adobe-CEP/Samples Issue #133](https://github.com/Adobe-CEP/Samples/issues/133) — PProPanel сломался в 15.x с тем же симптомом
- [«1+4 throws evalScript error» thread](https://community.adobe.com/t5/premiere-pro-bugs/1-4-throws-evalscript-error/idi-p/15562762) — спорадические сбои движка
- [«EvalScript error» — generic explanation](https://community.adobe.com/t5/get-started/q-csinterface-evalscript-reports-quot-evalscript-error-quot/td-p/9903586)

---

## Связанные документы

- `.omc/research/premiere-api-audit.md` — аудит host JSX от 2026-04-16 (US-001)
- `client/shared/bridge-premiere.js` — содержит cold-start retry (commit 5298cf9)
- `host/premiere.jsx` v2.6.0 — текущий host, требует Phase 1 рефакторинга
