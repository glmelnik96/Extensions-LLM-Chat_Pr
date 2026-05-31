# MultiCam Phase 2 — Wraith-parity план реализации

**Дата:** 2026-05-31
**Цель:** Довести авто-MultiCam до уровня Wraith / AutoPod: реальный детект говорящего + 3 фичи ритм-полировки + настраиваемый UX.
**References:** `.omc/research/multicam-podcast-feature.md` (раздел «Wraith — глубокий разбор»), `.omc/plans/multicam-phase1-mvp.md`

---

## Исходная точка (что реально есть на 2026-05-31)

| Слой | Состояние |
|---|---|
| `client/shared/multicam-plan.js` | ✅ Грамотный RMS-алгоритм (gain-sharing, EMA-smoothing, min-hold, snap). Покрыт unit-тестами. **НЕ подключён к shipped-пути.** |
| `client/shared/deterministic-pipelines.js:931` `multicamFromTranscript` | ⚠️ Shipped-путь. **Наивное чередование V2/V3 по `pi % 2`** + wide на паузах ≥1с. Без детекта говорящего. |
| `client/shared/audio-preprocess.js:183` astats RMS | ⚠️ Есть RMS-таймлайн для **одной** дорожки. Per-track извлечения нет. |
| `host/premiere.jsx:2241` `applyMulticamCuts` | ✅ Готов. Принимает `{segments:[{tStart,tEnd,activeVideoTrack}], mapping, params}`, режет QE razor + `clip.disabled`. Контракт стабилен. |
| `client/unified/panel.js:4544` | ✅ Карточка `kind:'multicam_cuts'` → `bridge.applyMulticamCuts`. |

**Главный вывод:** apply-сторона (jsx + bridge + карточка) уже умеет исполнять качественный план. Не хватает **источника качественного плана**: реального per-track аудио-анализа, подключённого к `multicam-plan.js`. Сначала чиним фундамент, потом добавляем фичи Wraith.

---

## Принципы (наследуются из Phase 1)
1. Чистая логика отделена от Premiere, тестируется в Node (vm-loader).
2. TDD: тест до реализации (`superpowers:test-driven-development`).
3. Backward-compatible: не ломаем 304 существующих теста; контракт `applyMulticamCuts` не меняем.
4. Контракт плана не трогаем — apply-сторона уже его понимает. Все улучшения = богаче `segments`.
5. Walking skeleton: сперва end-to-end реальный детект, потом полировка ритма, потом UX.

---

## Phase 2A — Фундамент: реальный детект говорящего

Цель: заменить наивное чередование реальным per-track RMS, подключив существующий `multicam-plan.js`.

### Шаг 2A.1 — Per-track RMS extraction
**Расширить** `client/shared/audio-preprocess.js`: новая функция `extractPerTrackRms(wavPaths, frameSec)` → для каждой mic-дорожки строит RMS-таймлайн (переиспользуя существующий `astats=metadata=1:reset=...` паттерн, см. :192), затем сшивает в кадры `[{tStart, tEnd, rmsByTrack:[r0,r1,...]}]` — точный формат, который ждёт `buildSwitchPlan` (см. `multicam-plan.js:229`).
- Извлечение аудио каждой дорожки в mono 16k WAV — уже есть в timeline-transcribe pipeline, переиспользовать.
- **Валидация:** unit-тест парсинга astats-вывода в кадры (фикстура из 2-3 mock astats строк); кадры выровнены по `frameSec`.

### Шаг 2A.2 — Wire buildSwitchPlan в executor
**Заменить** тело `multicamFromTranscript` (или добавить `multicamFromAudio` рядом и переключить dispatch в `panel.js:4616`):
1. snapshot-валидация ≥3V/≥2A — оставить как есть (:942-950).
2. mapping — оставить hardcoded для 2A (V1=wide, A1↔V2, A2↔V3); UI-mapping → Phase 2C.
3. `extractPerTrackRms` → `audioFrames`.
4. `MulticamPlan.buildSwitchPlan(audioFrames, mapping, params, silences)` → `{segments, switchCount, stats}`.
5. Тот же proposal-контракт (`kind:'multicam_cuts'`, summary с perTrackSeconds).
- **Транскрипт больше не обязателен** — multicam теперь от аудио, не от абзацев. (Транскрипт-fallback можно оставить, если astats недоступен/нет ffmpeg.)
- **Валидация:** end-to-end на тестовом 3V+2A подкасте — план отражает реального говорящего, а не `pi%2`. Регрессия `npm test` зелёная.

### Шаг 2A.3 — Sensitivity маппинг (Wraith-совместимый)
В UI/params: один слайдер «Чувствительность (dB)» → `silenceThresholdDb`. Семантика как у Wraith v1.2.4: −40 = high (тихий подкаст), −20 = low (шумно).
- **Валидация:** unit-тест `decideActiveMic` на границах −40/−20.

**Acceptance Phase 2A:** на реальном подкасте камера переключается на того, кто говорит (а не пинг-понг по абзацам). Время анализа сопоставимо с audio-only (<60с на час).

---

## Phase 2B — Wraith-parity: 3 фичи ритм-полировки

Все три — чистые функции в `multicam-plan.js`, добавляются в pipeline `buildSwitchPlan` после `enforceMinHold`. TDD: тест до кода.

### Шаг 2B.1 — Max-hold + wide/reaction injection
**Новая функция** `enforceMaxHold(segments, params)`: если сегмент одной камеры длиннее `maxHoldSec` (default 8с, диапазон 3-30) — разбить, вставив wide (или reaction-камеру) на короткий бридж. Отдельный `maxAllSpeakersSec` для wide-сегментов (аналог Wraith «Max All-Speakers Duration»).
- **Валидация:** длинный монолог (20с одной камеры) → ≥1 wide-вставка; wide не дольше `maxAllSpeakersSec`.

### Шаг 2B.2 — Variations (анти-монотонность)
**Новая функция** `applyVariations(segments, params, seed)`: детерминированный (seeded) джиттер длительности сегментов в пределах [`minHold`, `maxHold`], чтобы рез не был механически ровным. Seed → воспроизводимость (важно для тестов и undo/re-apply).
- **Валидация:** с `variations=0` план идентичен исходному; с `variations>0` границы сдвигаются в пределах допуска, **seed даёт детерминизм** (один и тот же seed = один и тот же план).

### Шаг 2B.3 — Frame Offset (рез на атаку слога)
**Новая функция** `snapToSpeechOnset(segments, onsets, offsetSec)`: вместо/в дополнение к `snapToSilences` двигать границу к **началу речи** следующего спикера (атака первого слога), со смещением `frameOffsetSec`. Источник onset'ов — границы сегментов транскрипта или порог нарастания RMS.
- **Валидация:** граница приземляется на onset±offset, не в середину паузы; деградирует gracefully если onset'ов нет (fallback на snapToSilences).

**Acceptance Phase 2B:** монологи разбавлены wide, ритм неравномерный но управляемый, резы попадают на старт фраз. Все новые функции покрыты unit-тестами, общий счётчик тестов растёт без регрессий.

---

## Phase 2C — UX: mapping-таблица + слайдеры

### Шаг 2C.1 — Track mapping UI
Таблица в Tools-секции (`index2.html` + `panel.js`): auto-suggest по именам дорожек (mic1→cam1), manual override. Поддержка до 8 спикеров/камер (контракт `mapping.speakers[]` уже это позволяет — см. apply jsx :2274).
- **Валидация:** mapping из UI корректно доезжает до `buildSwitchPlan` и до `applyMulticamCuts`.

### Шаг 2C.2 — Слайдеры параметров (6 контролов Wraith)
Min/Max Camera Duration, Max All-Speakers, Sensitivity, Variations, Frame Offset — в карточке proposal/Tools. CSS-токены уже унифицированы (`--{warning,...}`).
- **Валидация:** WCAG AA, изменение слайдера → re-build плана, превью обновляется.

### Шаг 2C.3 — Marker dry-run preview (опц.)
Перед apply — маркеры переключений на sequence (через существующий addSequenceMarkers), чтобы видеть план без razor.

**Acceptance Phase 2C:** пользователь настраивает mapping + ритм, видит превью, применяет. Паритет по контролам с Wraith.

---

## Что НЕ делаем (out of scope Phase 2)
- ❌ ML speaker-ID модель (Wraith «99.9%») — у нас RMS gain-sharing; ML-диаризация (Silero VAD/pyannote) = Phase 3, только если RMS не вытягивает на близкой посадке/bleed.
- ❌ J/L-cut offsets (видео раньше аудио) — Phase 3.
- ❌ Mic-bleed cleanup pre-pass — Phase 3.
- ❌ Изменение контракта `applyMulticamCuts` — он стабилен.

---

## Риски
1. **astats на длинных дорожках тяжёл** — батчить, либо `reset` + grep-парсинг (как отмечено в audio-preprocess.js:184). Мера: chunked extraction.
2. **Mic bleed → ложный активный спикер** при близкой посадке — `bleedMarginDb` повыше (8-9) + (Phase 3) cross-correlation gate.
3. **`clip.disabled` на linked V↔A** — проверить что disable видео не глушит аудио (известный риск из Phase 1, требует ручного теста в Premiere).
4. **QE DOM deprecation (PP 27+)** — apply уже требует QE; завязано на платформенный риск (UXP-миграция, Sept 2026).
5. **Variations + undo** — seeded-детерминизм обязателен, иначе re-apply даёт другой план и путает undo.

---

## Порядок исполнения
2A (фундамент) → 2B (фичи ритма) → 2C (UX). Каждый шаг: тест → реализация → `npm test` зелёный → `node --check`. Перед коммитом — явная отмашка пользователя.

**Следующий шаг:** утвердить план, затем `superpowers:writing-plans` / `executing-plans` для пошаговой реализации Phase 2A.
