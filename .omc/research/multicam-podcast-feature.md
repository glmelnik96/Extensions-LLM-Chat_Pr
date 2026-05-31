# MultiCam Auto-Switching для подкастов — research + план

**Дата:** 2026-04-30
**Цель:** Добавить функцию автоматической нарезки multicam-композиций (3 видео + 2 аудио, всё засинхронизировано) для подкастов, аналог AutoPod.

---

## TL;DR

**Задача реализуема, и на 80% переиспользует то, что у нас уже есть.** Нет фундаментальных блокеров — Premiere ScriptingAPI не даёт «multicam angle setter», но даёт `clip.disabled = true/false`, а это и есть тот же эффект.

Основной алгоритм:
1. Анализ амплитуды каждой mic-дорожки (ffmpeg astats, 50мс окна)
2. Для каждого кадра — кто громче (с margin против mic bleed)
3. Сглаживание + минимальный hold (1.5с)
4. Razor всех видео-дорожек в моменты переключения
5. `clip.disabled = true` на всех неактивных видео-сегментах

**Это AutoPod 1:1.** Они тоже не имеют «multicam angle API» — режут razor'ом и disable'ят.

---

## Что у нас уже есть для этого

| Примитив | Где | Статус |
|---|---|---|
| `getTimelineSnapshot` с enumeration tracks/clips | `host/premiere.jsx:749` | ✅ готов |
| `_clipTimes` safe-accessor | `host/premiere.jsx:124-141` | ✅ готов после Phase 1 |
| QE razor + clip.remove паттерн (используется в applyTranscriptCuts) | `host/premiere.jsx:299-393` | ✅ готов, есть TC-конвертация |
| `clip.disabled = true/false` уже используется | `host/premiere.jsx:1066, 1085` | ✅ работает на user'ской сборке |
| `_ticksStr` / timebase | `host/premiere.jsx:111-120` | ✅ |
| ffmpeg доступен (используется для silencedetect) | `client/shared/audio-preprocess.js` | ✅ |
| propose_*/apply_* паттерн с user-confirm | `client/unified/panel.js` | ✅ можно копировать |
| Sequence markers (для preview) | `host/premiere.jsx` addSequenceMarkers | ✅ |
| Cold-start retry + Phase 1 wrap | `client/shared/bridge-premiere.js` + `host/premiere.jsx` | ✅ свежий |

---

## Алгоритм (расширенный)

```
state = WIDE (V1)
for each 50ms frame:
  rms[1..N] = per-track RMS из ffmpeg astats
  active_set = {i : rms[i] > rms_max_other + 6dB AND rms[i] > -35dB}

  if |active_set| == 0:        target = WIDE
  if |active_set| == 1 = {i}:  target = CAM[i]
  if |active_set| >= 2:        target = WIDE  (overlap)

  if target != state and (now - last_switch) >= T_min_hold:
    snap_t = nearest_silence_or_word_boundary(now, ±300ms)
    commit switch at snap_t
    state = target
    last_switch = snap_t

  if target == state == CAM[i] and (now - last_switch) >= T_max_hold:
    inject reaction-shot or wide
```

### Параметры по умолчанию

| Параметр | Default | Диапазон |
|---|---|---|
| `T_min_hold` | 1.5с | 0.5-5с |
| `T_max_hold` | 8с | 3-30с |
| `bleed_margin_dB` | 6dB | 3-12dB |
| `silence_threshold_dB` | −35dB | −20…−45dB |
| `snap_window` | ±300мс | 0-1с |
| `wide_on_overlap` | true | bool |
| `mode` | disable | disable/delete |

---

## Архитектура (вписывается в существующий паттерн)

```
panel.js
  ├─ UI секция «Авто-MultiCam»
  ├─ Track mapping (auto-suggest по именам, manual override)
  ├─ Sliders + Mode selector
  ├─ "Анализ" → propose_multicam_cuts → карточка предложения
  └─ "Применить" → apply_multicam_cuts (через bridge)

NEW client/shared/multicam-plan.js  (чистая логика, тестируемая)
  ├─ analyzeAudioTracks(wavPaths, params) → per-frame active speaker
  ├─ buildSwitchSegments(activeFrames, params) → list of {tStart, tEnd, activeVideoTrack}
  ├─ snapToSilences(segments, silenceIntervals)
  └─ buildPlan(snapshot, segments, mapping) → plan JSON

NEW client/shared/multicam-vad.js (опционально на Phase 2)
  └─ wrapper над ffmpeg astats и/или Silero ONNX

EXTEND bridge-premiere.js
  └─ applyMulticamCuts(planObj, cb)

EXTEND host/premiere.jsx
  └─ $._EXT_PRM_.applyMulticamCuts (использует QE razor + .disabled)

EXTEND tool-validators.js
  └─ schema для propose/apply_multicam_cuts
```

### JSON плана

```json
{
  "version": 1,
  "rangeSec": [12.5, 1834.7],
  "mapping": {
    "wideTrack": 0,
    "speakers": [
      {"audioTrack": 0, "videoTrack": 1, "label": "Гость 1"},
      {"audioTrack": 1, "videoTrack": 2, "label": "Гость 2"}
    ]
  },
  "params": {"minHold": 1.5, "maxHold": 8, "bleedMarginDb": 6, "mode": "disable"},
  "segments": [
    {"tStart": 12.5, "tEnd": 18.7, "activeVideoTrack": 0},
    {"tStart": 18.7, "tEnd": 22.3, "activeVideoTrack": 1},
    {"tStart": 22.3, "tEnd": 25.0, "activeVideoTrack": 2}
  ]
}
```

---

## Phasing (от MVP к продакшну)

### Phase 1 — MVP (2-3 дня)
- ffmpeg astats per-track RMS + gain-sharing
- Hardcoded mapping: V1=wide, V2↔A1, V3↔A2 (UI с auto-detect мы добавим в Phase 2)
- `T_min_hold = 1.5с`, никаких max-hold/wide-injection/reaction shots
- Snap к silencedetect-границам
- Mode: только `disable` (не delete)
- UI: одна кнопка «Авто-MultiCam: проанализировать → применить»

**Acceptance:** Run end-to-end на 30-минутном подкасте, не desync'ит, время <60с.

### Phase 2 — Продакшн UX (2-3 дня)
- UI с track mapping table (auto-suggest по именам)
- Все sliders открыты пользователю
- Wide injection при overlap и при T_max_hold
- Marker-based dry-run preview перед apply
- Range support (sequence In/Out)
- Edge cases (Multi-Camera Source Sequence detection, missing tracks)

### Phase 3 — Качество (1-2 дня)
- Silero VAD как опционный pre-filter (для шумных микрофонов)
- Reaction-shot insertion (вероятностно)
- J/L-cut offsets (-150мс video против audio)
- Anti-repetition при долгих паузах

### Phase 4 — Опциональное
- Mic bleed cleanup pre-pass
- Pluggable «editing styles» (snappy vs. academic)
- Интеграция с propose_transcript_cuts (фильтры паразитов + multicam в одном плане)

---

## Риски и неизвестные

1. **Razor на трек без клипа в этой точке** — может быть no-op или варнинг. Нужно проверить, не desync'ит ли это треки между собой.
2. **Adobe deprecation QE DOM** — в PP 27+ QE может исчезнуть. Mitigation: fallback на classic-DOM `insertClip + in/out`.
3. **Mic bleed false positives** при близкой посадке гостей. Mitigation: `bleed_margin_dB` повыше (8-9), плюс cross-correlation gate в Phase 3.
4. **`disabled` на linked items** — V2 disabled, A1 должна остаться. В нашем коде уже есть linked-handling, но требует тестирования на multicam-сценарии.
5. **Performance** на длинных секвенциях — razor + disable на сотни точек. Mitigation: батчить в одном `applyMulticamCuts` вызове.
6. **MCS-input (если пользователь уже создал Multi-Camera Source Sequence)** — наш план не сработает внутри MCS. Mitigation: detect и friendly error «развалите MCS на отдельные дорожки».
7. **Adobe Premiere 25.2 «Premiere Assistant»** уже делает auto-multicam нативно. Differentiation: RU-first, on-prem LLM, интеграция со всем нашим pipeline'ом.

---

## Конкуренты (короткое сравнение)

| Tool | Подход | Ключевая фича |
|---|---|---|
| **AutoPod** ($29/мес) | Amplitude-based, 10 cams/10 mics | Industry standard, $29/мес |
| **FireCut** | Loudest-track-wins + variation injection | 2 алгоритма Original/Rapid, mode disable/delete |
| **Hey Eddie** | Standalone preprocessor → XML/EDL | Standalone, не плагин |
| **Wraith** (Phantom Editor) | ML speaker-ID per-mic, conversation-pattern | min/max/variations/frame-offset, $118 lifetime |
| **Premiere Assistant** (Adobe нативный, 25.2) | Transcript + Sensei | Бесплатно встроено |

Все, кроме Adobe-native, используют **тот же базовый алгоритм** что мы планируем.

---

## Wraith Multi-Cam Editor — глубокий разбор (2026-05-31)

Плагин Premiere Pro от **Phantom Editor** (suite 13+ инструментов). Позиционируется как ведущая **AutoPod-альтернатива 2026** для видеоподкастов. $118 единоразово (lifetime) или в подписке Phantom. Win/Mac, 4.9/5 (89 отзывов).

### Алгоритм и вход
- **Вход:** отдельная аудиодорожка на каждого спикера (НЕ mixed-track — требование, как у AutoPod и у нас). До **8 камер / 8 спикеров**.
- **Детекция:** не чистый amplitude-trigger, а **ML speaker-identification model** («model identifies the correct speaker», заявлено ~99.9% точности в v1.2.4) + анализ **conversation patterns** → «человекоподобные» решения. Лучше обрабатывает overlap, чем volume-threshold AutoPod.
- **Overlap:** при одновременной речи автоматически переключается на **«All Speakers» камеру** (wide/group), если она назначена.
- **Бенчмарк:** ~1 ч / 3 камеры → **~1м24с** (против ~2 мин AutoPod).
- **Workflow:** импорт → 1 клик (анализ+синк до 8 камер) → авто-switching → manual override → экспорт.

### Параметры пользователя (6 контролов)
| Контрол | Назначение |
|---|---|
| **Max Camera Duration** | лимит на один ракурс (анти-«залипание») |
| **Max All-Speakers Duration** | лимит длительности wide/group |
| **Min Camera Duration** | анти-дёрганье (мин. shot) |
| **Sensitivity (dB)** | порог детекции голоса; −40 = high (тихий подкаст), −20 = low (шумная среда) |
| **Variations** | естественная непредсказуемость ритма реза |
| **Frame Offset** | синк реза к первому слогу спикера |

### Gap-анализ против нашего `client/shared/multicam-plan.js`
| Параметр Wraith | У нас | Статус |
|---|---|---|
| Min Camera Duration | `minHoldSec` (1.5с) + `enforceMinHold` | ✅ есть |
| Sensitivity (dB) | `silenceThresholdDb` (−35) + `bleedMarginDb` | ✅ есть |
| Max Camera Duration | — | ❌ нет (в research = «T_max_hold») |
| Max All-Speakers (wide) Duration | — | ❌ нет |
| Variations | — | ❌ нет (детерминированный ритм) |
| Frame Offset (атака слога) | snap к **silence**-границам (`snapToSilences`) | ⚠️ другое (рез в паузу, не на слог) |
| Overlap → wide | `wideOnOverlap` (margin-based) | ✅ есть, но проще (без conversation-pattern) |

### ⚠️ Критическая реальность кодбейса (на 2026-05-31)
Грамотный `multicam-plan.js` (per-track RMS, gain-sharing, min-hold, snap) **существует и покрыт unit-тестами, но НЕ подключён к shipped-пути**. Реально работающий executor зовёт `DeterministicPipelines.multicamFromTranscript`, который **просто чередует V2/V3 по индексу абзаца (`pi % 2`)** + wide на паузах ≥1с — **без какого-либо детекта говорящего**. Извлечение per-track RMS через ffmpeg `astats` (Phase 1.5) — невыполненный TODO (`docs/DEV_ARTIFACTS.md`).

**Вывод:** разрыv с Wraith больше, чем казалось. Чтобы догнать «AutoPod-base», нужно сперва соединить уже написанный RMS-модуль с реальным per-track astats и executor'ом; и только потом добавлять 3 фичи ритм-полировки Wraith (max-hold/wide-injection, variations, frame-offset на слог). План реализации — `.omc/plans/multicam-phase2-wraith-parity.md`.

---

## Источники

- [AutoPod homepage](https://www.autopod.fm/)
- [AutoPod multi-camera guide](https://autopodcastai.com/autopod-multi-camera-editing/)
- [FireCut multi-track](https://learn.firecut.ai/features/multi-track/multi-track-video-editing)
- [Premiere ScriptingAPI — TrackItem](https://ppro-scripting.docsforadobe.dev/item/trackitem/)
- [Adobe community — multicam via script (NOT supported)](https://community.adobe.com/t5/premiere-pro-discussions/editing-with-multicam-via-script/m-p/14155138)
- [Silero VAD GitHub](https://github.com/snakers4/silero-vad)
- [ffmpeg astats docs](https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Audio/astats.html)
- [Premiere Pro 25.2 AI features (Adobe blog)](https://blog.adobe.com/en/publish/2025/04/02/introducing-new-ai-powered-features-workflow-enhancements-premiere-pro-after-effects)
- [Auphonic Crossgate / mic bleed removal](https://podcastengineeringschool.com/crossgate-feature-in-auphonic-multitrack/)
- [Wraith Multi-Cam Editor — product](https://phantomeditor.video/products/Wraith)
- [Wraith — how-to](https://phantomeditor.video/blog/How-to-use-Wraith-Multi-Camera-Editor)
- [Wraith vs AutoPod (2026)](https://phantomeditor.video/blog/best-autopod-alternative-2026-multicam-editing-premiere-pro)
- [Wraith v1.2.4 update (sensitivity, All-Speakers)](https://phantomeditor.video/blog/wraith-multi-cam-editor-update-v1-2-4)

---

## Статус

📋 **Research complete.** Готовы начинать Phase 1 MVP при следующем запросе. Все примитивы в кодбейсе уже есть, нужно только склеить их в новый pipeline.
