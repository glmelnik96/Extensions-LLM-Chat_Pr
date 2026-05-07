# MultiCam Phase 1 MVP — план реализации

**Дата старта:** 2026-04-30
**Цель:** Минимально работающая авто-нарезка multicam-композиции (3V + 2A), end-to-end на 5-30 мин подкасте.
**Reference:** `.omc/research/multicam-podcast-feature.md`

---

## Принципы

1. **Чистая логика отделена от Premiere.** Алгоритм построения плана — в `multicam-plan.js`, тестируется в Node без Premiere.
2. **Только один путь.** Hardcoded mapping, фиксированные defaults. Конфигурация — Phase 2.
3. **Backward compatible.** Не ломаем существующие функции и тесты.
4. **Wrap-pattern везде.** Любое исключение в host'е → структурированная ошибка через `_wrap`.
5. **Validation-first.** Каждый шаг имеет чёткий критерий «проверить-готово».

---

## Allowed inputs (MVP)

- Активная sequence в Premiere
- Минимум **3 видеодорожки**: V1 (wide), V2 (cam1), V3 (cam2)
- Минимум **2 аудиодорожки**: A1 (mic1), A2 (mic2)
- Все клипы засинхронизированы (пользователь сделал это руками)
- Опционально: In/Out range — если не задан, обрабатываем всю sequence

**Hardcoded mapping (Phase 1):**
- Wide: `videoTrackIndex = 0` (V1)
- Speaker 1: audio=0 (A1) ↔ video=1 (V2)
- Speaker 2: audio=1 (A2) ↔ video=2 (V3)

---

## Параметры по умолчанию (Phase 1, не настраиваемые)

| Параметр | Значение | Назначение |
|---|---|---|
| `frameSec` | 0.05 | Окно RMS (50мс) |
| `minHoldSec` | 1.5 | Мин. длительность shot'а перед переключением |
| `bleedMarginDb` | 6 | Активный спикер = громче на ≥6dB остальных |
| `silenceThresholdDb` | -35 | Ниже = тишина |
| `snapWindowSec` | 0.3 | Snap к ближайшей silence-границе |
| `mode` | 'disable' | Не удаляем клипы, ставим .disabled=true |
| `wideOnOverlap` | true | При перебивке гостей → wide |
| `wideOnSilence` | true | При полной тишине → wide |

---

## Архитектура

```
┌────────────────────────────────────────────────────────────────┐
│ panel.js                                                       │
│  • Tool schema: propose_multicam_cuts                          │
│  • Executor: execProposeMulticamCuts(args)                     │
│  • UI: одна кнопка «Авто-MultiCam»                             │
│  • Карточка proposal (kind: 'multicam_cuts')                   │
└────────┬───────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────┐
│ NEW client/shared/multicam-plan.js (IIFE, чистая логика)       │
│  buildSwitchPlan(audioFrames, params) → {segments, switchCount}│
│  • Gain-sharing: кто громче на margin                          │
│  • EMA-smoothing                                               │
│  • Min-hold enforcement                                        │
│  • Snap к silence-границам                                     │
│  • Wide injection при overlap/silence                          │
└────────┬───────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────┐
│ panel.js → renderPendingProposalCard (kind:'multicam_cuts')   │
│  Кнопка «Применить» → bridge.applyMulticamCuts(plan)           │
└────────┬───────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────┐
│ bridge-premiere.js: applyMulticamCuts(plan, cb)                │
└────────┬───────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────┐
│ host/premiere.jsx: $._EXT_PRM_.applyMulticamCuts               │
│  for cut in cuts: razor V1+V2+V3 at cut.timeSec                │
│  for segment in segments:                                      │
│    for V_i in [V1,V2,V3]:                                      │
│      найти clip в [tStart,tEnd]                                │
│      clip.disabled = (i !== activeVideoTrack)                  │
└────────────────────────────────────────────────────────────────┘
```

---

## Шаги реализации с критериями валидации

### Шаг 1 — `multicam-plan.js` (чистая логика)

**Создать:** `client/shared/multicam-plan.js` как IIFE экспортирующий `MulticamPlan`:

```javascript
window.MulticamPlan = {
  buildSwitchPlan: function(audioFrames, params) { ... }
}
```

**Где `audioFrames` =** массив `[{tStart, tEnd, rmsByTrack: [r0_dB, r1_dB, ...]}]`.
**Возвращает =** `{segments: [{tStart, tEnd, activeVideoTrack}], switchCount}`.

**Внутри:**
1. Per-frame `activeAudioTrack`: либо номер mic'а громче на `bleedMargin`, либо `null` (silence/overlap)
2. Mapping `activeAudioTrack → activeVideoTrack` (через переданный mapping в params)
3. EMA-smoothing на 5 кадров (250мс)
4. Min-hold: если переключение случается раньше `minHoldSec`, отменяем
5. Output — segments

**Валидация Шага 1:**
- [ ] Файл создан, синтаксис OK (`node --check` через стенд)
- [ ] Регистрируется в HTML (добавлен в `<script>` список в `index2.html`)
- [ ] Покрыт unit-тестами (см. Шаг 2)

### Шаг 2 — Unit-тесты `multicam-plan.test.mjs`

**Создать:** `tests/multicam-plan.test.mjs` + `tests/load-multicam-plan.mjs`.

**Сценарии:**
1. **Speaker 1 один говорит** — все frames с `rms[0]>>rms[1]` → один segment с activeVideoTrack=1
2. **Чередование двух спикеров** — frames с alternating peak → segments с правильным mapping
3. **Min-hold блокирует частые переключения** — кратковременный peak спикера 2 (<1.5с) → не появляется в segments
4. **Overlap (оба говорят громко)** — frames где оба >threshold → wide track (0)
5. **Silence (оба тихо)** — frames где оба <threshold → wide track (0)
6. **Bleed-margin защита** — speaker 2 чуть громче (3dB), bleed-margin=6dB → остаёмся на speaker 1
7. **Empty input** → segments пустой, switchCount=0
8. **Один frame** → один segment с длительностью frame'а

**Валидация Шага 2:**
- [ ] Все 8 тестов зелёные
- [ ] `npm test` — общее число тестов 174+8=182, без regressions

### Шаг 3 — `host/premiere.jsx`: `applyMulticamCuts`

**Добавить функцию** перед блоком `_decorateExportedFunctions`:

```javascript
$._EXT_PRM_.applyMulticamCuts = function (jsonPlan) {
  // 1. JSON.parse(jsonPlan) → {segments, mapping, mode}
  // 2. Найти все уникальные cut-точки (start/end сегментов, кроме границ всей sequence)
  // 3. razor каждой видеодорожки на каждой cut-точке (используем существующий razor pattern)
  // 4. Для каждого segment'а:
  //    — найти trackitem на каждой V-track в диапазоне [tStart, tEnd]
  //    — clip.disabled = (track.index !== activeVideoTrack)
  // 5. return JSON.stringify({ok, cutsApplied, segmentsApplied, switchedToWide})
}
```

И **зарегистрировать в `_decorateExportedFunctions`** список → автоматическая обёртка.

**Валидация Шага 3:**
- [ ] `node-check` host'а ОК
- [ ] Функция в массиве `EXPORTED` decorate-блока
- [ ] Документирован контракт plan.json в JSDoc

### Шаг 4 — `bridge-premiere.js`: метод `applyMulticamCuts`

**Добавить рядом с `applyTimecodeEdits`:**

```javascript
applyMulticamCuts: function (planObj, cb) {
  var json = escapeDoubleQuoted(JSON.stringify(planObj));
  this.evalJson('$._EXT_PRM_.applyMulticamCuts("' + json + '")', cb);
}
```

**Валидация Шага 4:**
- [ ] node syntax OK
- [ ] Регрессионный прогон 174+ тестов зелёный

### Шаг 5 — `panel.js`: tool schema + executor + UI

**Tool schema** для LLM:
```javascript
{
  name: 'propose_multicam_cuts',
  description: 'Анализирует multicam-композицию (3V+2A) и предлагает план переключения камер по говорящему. Только подкастов с засинхронизированными дорожками.',
  parameters: { type: 'object', properties: { sequenceKey: { type: 'string' } } }
}
```

**Executor `execProposeMulticamCuts(args)`:**
1. Получить snapshot: проверить что есть ≥3V и ≥2A
2. Получить per-track RMS: вызов `audio-preprocess` (если есть) или ffmpeg astats напрямую
3. Построить `audioFrames` массив
4. `MulticamPlan.buildSwitchPlan(audioFrames, params)` → segments
5. `_pendingProposal = { kind:'multicam_cuts', plan, summary, snapshot }`
6. `renderPendingProposalCard()`

**UI карточка `kind === 'multicam_cuts'`:**
- Заголовок: «Авто-MultiCam»
- Summary: «N переключений на M сегментов. {%V1, %V2, %V3 распределение}»
- Кнопка «Применить» → `bridge.applyMulticamCuts`

**UI кнопка** в Tools-секции HTML — рядом с существующими карточками.

**Валидация Шага 5:**
- [ ] node syntax OK
- [ ] panel.js не сломал ничего (174+тестов зелёные)
- [ ] Schema валидна

### Шаг 6 — Финальная валидация

- [ ] `node --check` всех изменённых файлов
- [ ] `npm test` зелёный
- [ ] Зафиксировать урок в memory

---

## Что НЕ делаем в Phase 1

- ❌ UI sliders для параметров (default'ы хардкод)
- ❌ Track mapping UI (хардкод V1/V2/V3, A1/A2)
- ❌ Marker preview перед apply
- ❌ Mode delete (только disable)
- ❌ Reaction-shot insertion
- ❌ Silero VAD (только ffmpeg astats)
- ❌ J/L cut offsets
- ❌ Range support (вся sequence)

Всё это — Phase 2/3. См. research-документ.

---

## Проверочный сценарий после реализации

1. Открыть тестовый подкаст в Premiere (3V+2A, 5-10 мин)
2. Нажать «Авто-MultiCam» в панели
3. Дождаться карточки proposal'а с цифрами
4. Нажать «Применить»
5. Проверить:
   - Все V1/V2/V3 разрезаны на сегменты в моменты переключения
   - В каждом сегменте только одна V-track активна (.disabled = false), остальные disabled
   - Аудио (A1/A2) не тронуто
   - Cmd+Z откатывает изменения
   - Sequence не desync'нулась

---

## Известные риски (документированы в research)

1. Razor на V-track без клипа в этой точке — possibly no-op
2. `disabled` на V может потянуть linked A — нужно проверить
3. Performance на длинных секвенциях
4. QE DOM может депрекейтнуться

---

**Начинаю реализацию шаг за шагом, с валидацией после каждого.**
