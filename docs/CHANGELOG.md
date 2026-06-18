# CHANGELOG — хронология milestone'ов

> Краткая хронология значимых изменений. Каждый milestone привязан к артефакту в Obsidian vault `01 Projects/Premiere CEP Suite/` с детальным разбором.

Формат: дата → название milestone'а → ключевые изменения → ссылка на vault-артефакт.

---

## 2026-06-19 — Тест-прогон всех инструментов: фикс зависания «Глав»

Системный прогон Tools-tab пайплайнов и чат-инструментов с apply+revert на чистой raw-секвенции.

- **🔴 БАГ: инструмент «Главы» зависал на 180с+.** chapterModel=DeepSeek-V4-Pro + thinkingPolicy.chapter=true + json_object + max_tokens до 32K → buildTopicsWithLLM висел >3 мин на реальном 10-мин транскрипте (TEST B 3.14s не воспроизвёлся; комментарий кода всё это время ожидал GLM-4.7). Фикс: chapterModel → GLM-4.7, thinkingPolicy.chapter → false. Валидировано: «Главы» ~10с, 3 осмысленные главы, маркеры на таймлайне.
- **Проверены инструменты (apply+revert, реальные пути)**: Tools-tab — fillers (2→22 клипа/−5.3с, откат ✓), silences (20 пауз/18.2с), jumps (91/68.8с), chapters (после фикса); jcuts/multicam корректно disabled для не-мультикам. Чат — move_clip (видео+аудио синхронно), set_clip_enabled (выкл/вкл, disabled-флаг ✓), dry_run_edit_plan (симуляция без применения), loudness, transcript_cuts, target-сборка.
- **Подтверждено**: транскрипт-кэш восстанавливается при откате и на Tools-tab пути (фикс раунда 2 общий для обоих путей — через _makeSequenceCheckpoint).
- **EditPlanSimulator корректен** (контрольная проверка): «3927с/−50с» в текстовом ответе чата — LLM переврал числа в резюме, не баг симулятора.
- Минор (не баг): Tools-tab «Главы» не регистрируют undo-кнопку (чат-маркеры — регистрируют); маркеры удаляются вручную.

## 2026-06-19 — Чистка проекта + реальные пользовательские пути: move_clip и аудио-инструменты

Раунд 3: наведение порядка в тест-проекте + проход реальных пользовательских путей на чистых секвенциях. Тест-секвенции переименованы: **edit** (смонтированная v3/a3), **raw** (сырая 1 клип), **multicam** (v5/a12); мусорные бэкапы помечены **x_junk1..5** (удаление секвенций через ExtendScript недоступно — `deleteClip` отсутствует для type-1; пользователь удалит в Project-панели).

- **🔴 БАГ (host move_clip): двойной сдвиг + A/V-десинк.** Стратегия 1 `move(Time)` двигала видео на delta, но `_verifyMove` падал (linked-аудио не ехало вместе), → QE-стратегия двигала ВСЕ клипы связки на ФИКСИРОВАННУЮ дельту ещё раз → видео +2×delta и рассинхрон с аудио. Live: target 48.24с → факт 53.25с (+10), ok=false, таймлайн broken. Фикс: QE считает дельту ПО-КЛИПНО от текущей позиции до newStartSec; уже сдвинутый клип пропускается. Валидировано: target 65.03→65.03 (host) и через чат «передвинь на 3с» → видео+аудио синхронно на 92.990. Версия host 2.6.3.
- **🔴 БАГ (panel.js auto-snapshot): аудио-инструменты недостижимы из чата.** Линкованное с видео аудио (BRAW/синхро) ПОЛНОСТЬЮ исключалось из снапшота (дедуп) → агент «не видел» аудиоклип, отвечал «нет аудиоклипа», не мог вызвать loudness/ducking. Поэтому аудио-инструменты «никогда не тестировались» — были недостижимы. Фикс: nodeId линкованного аудио привязан к видео-строке маркером `|a=<nodeId>@A<n>`; промпт описывает маркер. Валидировано end-to-end: «нормализуй до -16 LUFS» → propose_loudness → Apply → ffmpeg loudnorm отрендерил WAV из BRAW-аудио (-16 LUFS) → импорт в bin «AI Renders».
- Подтверждено: фиксы предыдущих раундов работают вместе (move_clip + аудио-снапшот: агент видит и двигает обе дорожки, host не задваивает).

## 2026-06-19 — Мульти-модельное тестирование на мультикам seq3: ещё 2 бага монтажа

Раунд 2: тестирование с разными моделями (short-list) на новой территории — мультикам seq3 (5v/12a) с большим транскриптом (179 сегм/29 абз/20 мин, домен B2B/продажи). Цель — поймать баги, не пойманные раньше.

- **🔴 БАГ точности (panel.js): хронометраж нарушался ПОСЛЕ снапа к границам абзацев.** `validateKeepDuration` проверяла сумму keep ДО снапа, но снап к границам крупных абзацев (на seq3 ~41с/абзац) раздувал результат: запрос «2 мин» → итог 2:59 (+50%), карточка показывалась с активным Apply. Фикс: ре-валидация ПОСЛЕ снапа — если финал >target×1.20, возвращаем ошибку → LLM перебирает меньше фрагментов. Валидировано: GLM-5.1 после ретраев дал 2:02 (+2%) ✓; gpt-oss +19% разрешён (в пределах 20%) ⚠. Цена — доп. раунды агента (медленнее, но точно).
- **🔴 БАГ данных (panel.js): откат не восстанавливал транскрипт-кэш.** apply_* сдвигает транскрипт (applyRippleDeletionsToTranscript), а «⏪ Откатить» восстанавливал только секвенцию → транскрипт оставался rippled и не совпадал с восстановленным таймлайном (чат «видел» 0-122с вместо 300-1500с, отказывался монтировать). Фикс: чекпоинт сохраняет копию транскрипта, откат восстанавливает её (под ключ оригинала и бэкап-секвенции). Валидировано: apply (902→892) → revert → транскрипт восстановлен до 300-902.
- **Находка (config): DeepSeek-V4-Pro как chatModel непрактичен** — в live (thinking=true) на большом транскрипте >3 мин/ход (в пределах 5-мин таймаута клиента, но зависает UI). Несмотря на 5/5 в Node-бенчмарке (там thinking=false). Подтверждает выбор GLM как chatModel.
- **Мультикам ripple валидирован**: apply transcript-cuts на seq3 (17 дорожек) — ripple консистентен по всем дорожкам, target соблюдён (117.7с≈122с). Наблюдение: сборка из разносекционного мультикама (V0-V2 поздняя BRAW + V3-V4 ранняя MOV) даёт небольшое перекрытие на стыке секций — редкий кейс.
- **🔧 Инфраструктура**: live-переключение модели рантайм-мутацией `window.FM_DEFAULTS.chatModel` (без reload) — для мульти-модельных прогонов в реальной панели.

## 2026-06-19 — Глубокое тестирование инструментов (APPLY+откат) + смена моделей + 2 фикса безопасности/монтажа

Прогон каждого инструмента с реальным применением и откатом на 3 секвенциях (1: 34 мин/98 клипов, 2: транскрибировано 20 мин/269 сегм/61 абз, 3: мультикам). Реальные вызовы через CDP.

- **Смена моделей**: `fastModel` gpt-oss-120b → **GLM-4.7** (FREE preview). Бенчмарк выявил, что gpt-oss выдумывал длительность таймлайна в info-запросах (363 вместо 484с), а fast-роль отвечает на «что/сколько». GLM-4.7: 2.1с, точен, FREE. Каталог моделей очищен от 5 недоступных (HTTP 404). При отзыве preview — вернуть gpt-oss-120b.
- **🔴 БАГ монтажа (panel.js): сборка «на N минут» оставляла нетранскрибированный хвост.** Инверсия keepIntervals→removeIntervals complement-ила только в границах транскрипта, а не всей секвенции → «нарезка 3 мин» давала 47 мин (валидация ловила, но Apply-кнопка активна). Фикс: при `targetDurationSec` инверсия в границах всей секвенции [0, sequenceEndSec] + warning о неполном покрытии. **Валидировано end-to-end**: «3 мин» → proposal «3:04 ✓ В целевой длине» → apply → реальный таймлайн 184.3с (было бы 47 мин).
- **🔴 БАГ безопасности (panel.js): fast-path точечных вырезок применял БЕЗ чекпоинта.** «Вырежи с X по Y секунду» (parseTimelineIntervalDeleteSec) применял ripple-delete напрямую, без бэкапа — откат только ручным Ctrl+Z. Фикс: чекпоинт перед fast-path apply → кнопка «⏪ Откатить» работает. Валидировано: правка → откат восстановил состояние.
- **Safety-guard агентского apply**: apply_timecode_edits/apply_edit_plan/apply_transcript_cuts без явного «без подтверждения» теперь редиректят на propose_* (карточку). Защита от стохастического нарушения LLM правила «ВСЕГДА propose_*».
- **Бенчмарк сложных задач** (multi-intent, амбигуитет, негация, two-step): DeepSeek-V4-Pro **5/5** (но 25.7с), GLM-4.7 4/5 (3.6с), gpt-oss 4/5 (3.1с), Kimi 4/5 (54.6с), **GLM-5.1 (текущий chat) 3/5** — слабейший на сложном (промахи на multi-intent и тематической сборке). Кандидат к рассмотрению: DeepSeek для сложных монтажных задач.
- **APPLY+откат подтверждены вживую**: маркеры (создание/удаление), паразиты (razor 2→8 клипов/реверт), 3-мин сборка (→184с/реверт), fast-path вырезка (чекпоинт/реверт). Детерминированные пайплайны (silences 8/8.3с, jumps 51/40.8с, chapters 5) — proposals корректны.
- **Батарея реальных кейсов на 20-мин транскрипте** (PASS): find_moments (дословные цитаты), резюме (пагинация 61 абз), edit_plan trim/remove (nodeId из снапшота).
- **🔧 Инструмент**: `tools/cep-debug.mjs hardreload` — сброс кэша CEF + перезагрузка с ignoreCache. CEF кэширует panel.js/*.js, обычный reload отдаёт старый код (обязательно после правок клиентского JS). Маркер версии `window.__PANEL_BUILD__`.

## 2026-06-18 — Комплексное live-тестирование на 3 секвенциях + бенчмарк LLM

Прогон на 3 подготовленных секвенциях (1: 34 мин/98 клипов, 2: 65 мин сырой, 3: 75 мин мультикам 5v/12a) через CDP, реальные вызовы.

- **БАГ (host): `sequenceEndSec=0`** на мультикам/длинных секвенциях — `seq.end.seconds` возвращал 0, агент «не видел» длину таймлайна (ломало info-ответы и валидацию хронометража). Фикс: `getTimelineSnapshot` считает реальный конец как максимум `endSec` по клипам (`Math.max(seq.end, maxClipEnd)`). Версия host 2.6.1 → 2.6.2. Валидировано: seq «3» 0 → 4509с.
- **Чат (prompts v5): «описание вместо действия»** — на «убери паузы/тишины» и неоднозначных запросах агент находил интервалы и перечислял их таблицей, но НЕ вызывал `propose_transcript_cuts` (нет карточки → нечего применить). Фикс: жёсткое правило в TIER0 (правка таймлайна ОБЯЗАНА завершаться `propose_*`, запрет перечислять интервалы текстом) + явный маппинг «убери паузы/тишины» → `propose_transcript_cuts`. Live-проверено: запрос теперь даёт карточку.
- **Бенчмарк моделей Cloud.ru** (`tests/integration/benchmark-models.mjs`, реальные вызовы, 5 сценариев): GLM-4.7 (FREE preview) — самый быстрый/дешёвый (2.1с, 13.5K ток), GLM-5.1 5.2с, gpt-oss-120b 4.5с но галлюцинировал длительность, Kimi-K2.6 16с сбалансирован, DeepSeek-V4-Pro самый дотошный но 39с. Недоступны на аккаунте (HTTP 404): GLM-4.6, Qwen3-235B, Qwen3-Next-80B, Qwen3-Coder.
- **Подтверждено PASS** (live, seq «2», 6-мин транскрипт): info-запрос длительности, find_moments, чистка паразитов (analyze→propose), маркеры глав (5 шт), сборка по хронометражу (target-duration валидация ловит overshoot).
- **Известное ограничение**: сборка keepIntervals при ЧАСТИЧНОЙ транскрибации секвенции оставляет нетранскрибированный хвост (инверсия ограничена диапазоном транскрипта — безопасно, не удаляет непроанализированное). Валидация overshoot честно это помечает. Рекомендация: транскрибировать весь монтируемый регион.

## 2026-06-18 — Кросс-ОС/ExtendScript hardening (совместимость установки)

Триггер: лог установки на стороннем устройстве показал падения в `host/premiere.jsx`. Аудит подтвердил латентные баги портируемости (на машине разработчика не проявлялись).

- **JSON-полифилл в host** (`host/premiere.jsx`, гард `if (typeof JSON === 'undefined')`): часть сборок ExtendScript не имеют нативного JSON → все ~85 вызовов `JSON.*` падали с `ReferenceError`, плагин не работал. Полифилл без Unicode-regex (json2.js Крокфорда на нём падает), посимвольный stringify + eval-parse с проверкой первого символа. Где JSON есть (PP 26.2 / ES 4.5.6) — гард пропускает. Валидирован в реальном ES3-движке через CDP (round-trip кириллицы, отказ от bare-кода).
- **`.trim()` → `.replace(/^\s+|\s+$/g,'')`** в host: `String.prototype.trim` отсутствует в ExtendScript (подтверждено на живом PP 26.2) — путь «удали клип [имя]» бросал TypeError.
- **whisper.cpp кросс-ОС** (`whisper-cpp-client.js`): `path.join` вместо forward-slash конкатенации; Windows-кандидаты (`C:\whisper.cpp\…`, `.exe`); платформо-зависимый fallback `where`(Win)/`which`(Unix) вместо bash-only `which … || true`.
- **Понятная ошибка ffmpeg** на Windows (`timeline-transcribe.js`): сообщение теперь упоминает `C:\ffmpeg` / `C:\Program Files\ffmpeg`, а не только Unix-пути.
- **Диагностика кэша** (`context-store.js`): `console.warn`, когда запись кэша транскрипта не удалась ни в один путь.
- Версия host: `2.6.0` → `2.6.1`. Три ffmpeg-файндера (audio-preprocess/timeline-transcribe/audio-render) проверены — уже платформо-корректны (`where`/`which` по `process.platform`), правок не требовали.

## 2026-06-12 — Кликабельные таймкоды в тексте чата + точный find_moments (c20bc90)

- **B1-1b:** таймкоды в свободном тексте ответов агента кликабельны («763 – 778 сек», «12 мин 43 сек», «12:43», «1304с») → клик ставит плейхед. TreeWalker по текстовым нодам, skip A/CODE/PRE, без lookbehind (ES5).
- **find_moments fix (live-находка):** стем «рос» (от «рост») substring-матчился с «п_рос_то»/«воп_рос»/«Рос_сия» → агент зацикливался. Теперь стем матчится только с началом слова + multi-stem ranking (хиты со всеми стемами запроса вытесняют частичные).
- Live-валидировано на 53-мин подкасте (768 сегментов): вопрос «темпы роста китайского автопрома» отвечен с первого захода, цитаты дословные, 8 кликабельных таймкодов.

## 2026-06-12 — Кастомный выбор дорожек мультикама (ba67c68)

- UI «Дорожки: Авто/Вручную» в карточке Авто-MultiCam (AutoPod-паттерн): маппинг спикер→аудиодорожка→видеодорожка + общий план.
- `params.mapping` → `_normalizeMulticamMapping` в пайплайне; варнинги называют реальные номера дорожек.
- Live-провалидирован полным циклом: выбор ZOOM-миков → план 121 сегмент → apply 121×3 клипа → откат чекпоинтом.

## 2026-06-12 — CDP-драйвер live-прогонов (7ea27b8) + MultiCam live-фиксы (c501a40)

- `tools/cep-debug.mjs`: eval/evalfile/reload/screenshot панели через Chrome DevTools Protocol (порт 8098).
- MultiCam: честная ошибка при BRAW (ffmpeg не декодирует → 0 кадров RMS), ремап media→sequence time (inPoint), варнинг «плоского» микрофона.

## 2026-06-11 — Волна B заимствований у конкурентов (ba67a4e)

- **Checkpoint/Откат:** бэкап-секвенция перед каждым apply + кнопка «⏪ Откатить» (паттерн Descript/FireCut).
- **Кликабельные таймкоды в proposal-картах** (B1-1).
- **Пресеты мультикама:** Спокойный/Динамичный + сохранение своих в localStorage.
- Конкурентная разведка (Remotion+LLM, CVP, Descript, AutoPod) → `docs/` + бэклог заимствований (dc1f155).

## 2026-06-10 — Quality/speed audit wave (f34ac75, 7591b72, d020a9b)

- Честные host-ошибки (структурированные `{_hostError}` вместо тихих фейлов), NTSC fps, streaming UI.
- UI-2: instant slider re-filter (без повторного анализа), background precompute, слайдеры мультикама.
- Wave A: версионирование кэша анализа, audio-only инструменты, ETA по моделям.
- Итог волны: 438/438 unit-тестов.

---

## 2026-05 → 2026-06-03 — MultiCam Phase 2A (audio-driven speaker detection)

Расширение MultiCam от Phase 1 (2 говорящих, ручная разметка) к audio-driven автоматике.

### Что добавлено
- `framesFromRmsTimelines` — выравнивает RMS-таймлайны на единую сетку для cross-track сравнения
- `multicamFromAudio` — пайплайн от аудио-чанков до камера-плана (cuts list)
- `enforceMaxHold` — вставляет wide-bridge при долгом удержании одной камеры (anti-monotony)
- `applyVariations` — seeded boundary jitter (вариативность без потери детерминизма)
- `snapToSpeechOnset` — сдвиг cut'ов к ближайшей атаке речи следующего спикера
- Generalize до N speakers (max 4) — было 2-only
- Tools dispatch в `panel.js` теперь дёргает audio-driven путь

### Runtime fix
- `MulticamPlan` экспорт сломан в CEP с `--enable-nodejs`: `module` определён в browser-context, CommonJS-fallback перехватывал `window.MulticamPlan = api`.
- Решение: убран CommonJS-branch, прямой `global.MulticamPlan = api`. Тесты vm-loader уже читают оба варианта (`ctx.MulticamPlan || ctx.module.exports`).

### Status
- Все unit-тесты зелёные (330/330)
- Manual end-to-end test в Premiere — pending (Phase 2B)
- Phase 2C (mapping UI + sliders) — план в `.omc/plans/`

→ См. `.omc/plans/multicam-phase-2b-*.md` и `.omc/research/multicam-podcast-feature.md`

---

## 2026-06-04 — Phase 2: миграция на GLM-5.1 + DeepSeek-V4-Pro

### Распределение ролей
- `chatModel`        : `zai-org/GLM-4.7` → `zai-org/GLM-5.1`
- `analysisModel`    : `zai-org/GLM-4.7` → `zai-org/GLM-5.1` (thinking=false обязателен)
- `chapterModel`     : `zai-org/GLM-4.7` → `deepseek-ai/DeepSeek-V4-Pro` (1M контекст)
- `findMomentsModel` : `zai-org/GLM-4.7` → `zai-org/GLM-5.1`
- `codeModel`        : `Qwen/Qwen3-Coder-Next` → `deepseek-ai/DeepSeek-V4-Pro`
- `fastModel`        : `openai/gpt-oss-120b` (без изменений)
- `chatParams.max_tokens` : 8000 → **16000**

### Что дало (живые тесты против Cloud.ru, 4 июня)
- **Главы:** DeepSeek-V4 — **3.14s vs 22.80s у GLM** (≈7× быстрее) при сопоставимом качестве, 0 EN-leak
- **Анализ JSON:** GLM-5.1 с thinking=false — 3.65s, 6/6 сегментов корректно
- **Tool-calling:** GLM-5.1 — 1.16–3.58s на multi-step (vs 16.45s у DeepSeek)
- **Long-input (10K tokens):** GLM-5.1 + thinking=false — 0.67s; ранее с GLM-4.7 + default thinking падало на NoneType

### Критичное предупреждение
- **GLM-5.1 + thinking=True на input ≥10K tokens** → `NoneType` (модель сжигает весь бюджет в reasoning_content)
- Поэтому `thinkingPolicy.analyze = false` зафиксировано в комментариях
- Kimi-K2.6 протестирован, но не назначен: не уважает `chat_template_kwargs.enable_thinking`

### Что НЕ менялось
- Промпты (`agent-prompts.js`, `agent-system-prompt.js`) — совместимы as-is
- `cloudru-client.js` — текущий формат thinking-флага работает для GLM, безопасно игнорируется DeepSeek
- Пайплайн analyze→chapter→agent — структура та же

→ [`.omc/research/2026-06-04-cloudru-new-models-evaluation.md`](../.omc/research/2026-06-04-cloudru-new-models-evaluation.md) — полный отчёт с таблицами тестов

---

## 2026-05-07 — Stability, cleanup и research-сессии

### Highlights cycling fix (production stability)
- LLM в режиме «Хайлайты» на 1ч контенте зацикливался на `find_moments` (42 вызова, не доходил до `propose_markers`)
- Усилен system-prompt: ХАРД-ЛИМИТ max 1 `find_moments` на сессию, разделение запросов «общий vs узкий», явный пункт «propose_markers обязателен»
- Результат: 22/23 → **23/23 pass**, время 201с → 10с (**19× быстрее**), tool calls 42 → 3

### Quality of life
- 6 критичных silent catches (DOM/storage ops) → `console.warn` в panel.js + context-store.js
- README test count 129 → 247 (в 3 местах)
- Vault: добавлен артефакт [[DaVinci Resolve миграция — research]] (648 строк) — статус parked

### Research-only (parked)
- **video-use** (browser-use): 3 идеи (phrase-packed view, structural archetypes, protected zones) реализованы + A/B на 1ч → откачено (нулевой/отрицательный benefit на нашем Whisper без diarization/event-tagging)
- **DaVinci Resolve миграция**: глубокий research (2 параллельных агента), 22 встроенных AI-фичи, IntelliScript только UI-only — миграция возможна (~180-240ч) но parked до бизнес-причины

→ [[video-use research и откат интеграции]], [[DaVinci Resolve миграция — research]]

---

## 2026-05-07 — UI compact v3

- Свернули блок «Быстрые сценарии» с 2 строк до 1 collapsible
- 3 категории табов (📝 По тексту / 🏷️ Маркеры / 🔍 Поиск) как collapsible cards
- Состояние раскрытия сохраняется в localStorage
- UiHints chips встроены внутрь развёрнутой категории (не отдельная строка)
- Экономия ~50px вертикали для chat-области

---

## 2026-05-06 — Target-duration enforcement + Stale paragraphs

**Реальный production-баг:** «собери монтаж на 40 секунд» → 70с overshoot (+75%) + cuts посередине слов.

**Root cause:**
1. LLM не считал сумму durations (нет runtime-валидации)
2. Параграфы устарели после ripple_delete (drift до 5.5с между paragraph.endSec и segments[idxs[-1]].endSec)

**Фиксы:**
- `targetDurationSec` параметр в schema `propose_transcript_cuts` + validation +20% cap
- `AnalysisRouting.validateKeepDuration` — pure-логика валидации
- `TranscriptStructure.isParagraphsStale` — детект устаревших paragraphs (drift >1с / out-of-range segIdxs)
- Auto-rebuild paragraphs в 3 точках входа (execGetTranscriptStructure, execAnalyzeTranscriptForCuts, execFindMoments)
- Snap к paragraph boundaries (drift 1.5с) → fallback на segments (drift 0.5с)
- Arithmetic few-shot в TIER1_TRANSCRIPT prompt

**Validation:** +14 unit tests (validateKeepDuration × 7, isParagraphsStale × 7), 219/219 pass

→ [[Target-duration enforcement и stale paragraphs]]

---

## 2026-05-06 — UI overhaul «Сценарий B»

Deep UI audit нашёл 26 проблем в 14 категориях. Сценарий B: HIGH + критичные MEDIUM.

**CSS:**
- Семантические токены `--{warning,danger,success,info}-*` вместо ~40 hard-coded hex
- WCAG AA контраст (muted 3.6→4.7:1, status-bar 4.0→5.4:1)
- `button:focus-visible` outline, `button:disabled` opacity+saturation
- Progress bar styles + indeterminate animation
- Унифицированные `.proposal-*` классы

**HTML/A11y:**
- `aria-live` regions на err / statusBar / led-text
- `role="progressbar"` с aria-valuenow
- Унифицированная proposal card structure

**JS:**
- `_proposalSummaryEl` helper заменил 5 копий inline styles
- Target/actual badge с green/amber/red вариантами
- `_buildButtons`: Apply primary green class, autofocus, double-click debounce, Esc handler
- Глобальный Escape handler с install-once guard
- Event-based view sync (`omc:transcript-led-changed` CustomEvent) вместо `window.toolsRefreshLed` fragile coupling
- Progress wiring: точные % в analyze, indeterminate в transcribe
- `showErr(text, {retry, hint})` extended API
- `_classifyError()` — network/auth/quota/cancel detection с подсказками

→ [[UI overhaul — Сценарий B]]

---

## 2026-05-06 — Phase 1.6/1.7: Audio-only path + production hardening

**Phase 1.6: Audio-only анализ** — для `cutSilences`/`jumpCuts` без транскрипции
- `runAudioOnlyAnalysis(prep)` — ffmpeg silencedetect + loudnorm без Whisper
- **30 сек на 1ч video vs 10-15 мин Whisper** (30× ускорение)
- LED состояние `'audio'` (синий) для аудио-only кэша
- Merge not replace: если есть полный транскрипт — сохраняется
- Match AutoPod/FireCut/Descript workflow (silence cuts без transcription)

**Phase 1.7: Production hardening (deep audit фиксы)**
- Sequence-switch guard на apply paths (если секвенция переключилась — block)
- `applyMulticamCuts` outer try/finally — гарантия `endUndoGroup` на ошибках
- Abort listener leak fix (named handler + `_cleanupAttempt`)
- `evalJson` null check — throws meaningful error
- `invertKeepToRemove` empty result error
- Validators: NaN check, negative startSec, beyond timeline, mute_track schema
- `validateForYouTube(markers)` — warnings для ≥3 chapters, 0:00, ≥10с gaps

→ [[Production validation и audio-only path]]

---

## 2026-05-05 — Phase 1 quality fixes + GLM-4.7 selector

**4 HIGH-impact фикса для quality монтажа по тексту:**
1. Few-shot примеры в TIER1_TRANSCRIPT (3 типовых сценария)
2. Temperature 0.5 → 0.1 для tool-calling
3. `response_format: json_object` enforced для analyze + topics
4. Cross-chunk bridging в analyzeForCutsWithLLM

**Per-call model routing:**
- `chatModel`, `analysisModel`, `chapterModel`, `findMomentsModel`, `fastModel`
- GLM-4.7 / GLM-4.7-Flash / gpt-oss-120b / Qwen3 — комбинации по типу задачи
- `thinkingPolicy: { analyze: false, chapter: true, chat: true, report: true }`
- Parallel chunking в `analyzeForCutsWithLLM` (concurrency=3)

**Production validation на 1ч подкасте:**
- 1255 segments, 297 paragraphs
- analyze: 6.4 мин (10.1× realtime), 0 failed chunks, 0% EN-leakage
- buildTopics: 11 глав

→ [[Phase 1 quality fixes и GLM-4.7 selector]], [[Production validation и audio-only path]]

---

## 2026-05-05 — Install hardening + health-check

- Полный INSTALL.md (macOS + Windows + Troubleshooting)
- README.md quick-start (3 пути установки)
- `panelHealthCheck()` через 1.5с после открытия панели
- Yellow banner если что-то не настроено (fm-secrets.js / API key / ffmpeg / PP версия)
- Ссылки в banner: INSTALL.md, INSTALL.md#troubleshooting

→ [[Install hardening и health-check]]

---

## 2026-05-04 — MultiCam Phase 1 MVP для подкастов

AutoPod-style автонарезка multicam для подкастов:
- `propose_multicam_plan` LLM tool
- QE DOM `razor()` + `clip.disabled` для переключения камер
- ffmpeg astats per-channel для определения активного спикера
- Walking-skeleton — end-to-end на 2-камерном setup'е

**Backlog Phase 1.5:** ffmpeg astats per-channel pipeline для real audio analysis, проверка `clip.disabled` на linked V↔A pair'ах

→ [[MultiCam Phase 1 MVP для подкастов]]

---

## 2026-05-03 — PP 2026 совместимость

**Cold-start race** в Adobe Premiere Pro 2025/2026: ExtendScript-движок не успевает прогреться к первому evalScript call'у.

- `_wrap()` decorator обертывает 10 exported functions в `host/premiere.jsx`
- Structured `{_hostError:true, name, message}` payload вместо raw error
- Cold-start retry в `bridge-premiere.js` (0/300/900мс exponential backoff)
- `_hostError` payload detection в `evalJson`
- `safeSeconds()` null-guards для `_clipTimes`

→ [[PP 2026 — стабилизация host и cold-start retry]]

---

## 2026-05-02 — OpenShorts интеграция

Заимствованы паттерны из open-source проекта openshorts:
- `paddingSec: 0.3` default — «дыхание» вокруг каждого reza (речь не звучит обрезанной)
- `client/shared/youtube-export.js` — `formatChaptersForYouTube` (M:SS / H:MM:SS), `formatTimestamp`
- Word-level grounding для cuts (опционально через Whisper word_timestamps)

→ [[OpenShorts-интеграция в плагин Premiere]]

---

## 2026-04 — Semantic editing v2 (PRD US-001…US-006)

**US-001:** Premiere API audit (Razor/ripple critical), smoke-регрессия по основным потокам
**US-002:** jumpCuts vs cutSilences чётко разведены (ритм vs гигиена)
- Jump cuts: ритм YouTube-стиль, дыхание 0-200мс, min-сегмент 0-1с
- Cut silences: гигиена, ≥1с по умолчанию
**US-003:** `aggressiveness: gentle|normal|aggressive` для `analyze_transcript_for_cuts`
- gentle: только filler+artifact
- normal: + intro/outro/outtake/repeat (digression остаётся — фикс прежнего бага)
- aggressive: всё не-content
**US-004:** `keepIntervals` в `propose_transcript_cuts` — для сборки роликов («оставь только X»)
- Executor автоматически инвертирует keepIntervals → removeIntervals
- Snap границ к сегментам транскрипта
**US-005:** Адаптивные главы (10/20/45с min-interval по длине), запрет имён «Часть N»
**US-006:** Архитектура prompt'ов в tier'ы по intent

→ [[Семантический монтаж и инструменты Premiere CEP]]

---

## 2026-03 (и раньше) — Базовая функциональность

- AI chat с tool calling + propose/apply паттерн
- Транскрибация Whisper-large-v3 через Cloud.ru + локальный whisper.cpp
- Детерминированные pipelines: silences, fillers, jumps, chapters
- Cycle detection в agent loop
- Snapshot caching с dirty-flag
- Two-model routing (fast/full)
- Local detectors (fillers, intro/outro, artifacts)
- `find_moments` (literal + TF-IDF)
- Session export + AI report generation

→ [[CEP-плагин для Premiere — обзор и архитектура]]

---

## Источники для каждой записи

В Obsidian vault `01 Projects/Premiere CEP Suite/` — детальные артефакты по каждому milestone'у. Folder note `Premiere CEP Suite.md` содержит таблицу со всеми артефактами и подсказкой «когда открывать».

Memory агента (`~/.claude/projects/.../memory/`) — feedback'и накопленные через сессии (commit protocol, ExtendScript quirks, pure logic pattern, MVP walking skeleton, и т.д.).

`.omc/research/` и `.omc/plans/` — рабочие артефакты OMC-сессий (PP 26 compatibility, MultiCam, semantic editing, Phase 1 quality).
