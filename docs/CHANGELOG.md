# CHANGELOG — хронология milestone'ов

> Краткая хронология значимых изменений. Каждый milestone привязан к артефакту в Obsidian vault `01 Projects/Premiere CEP Suite/` с детальным разбором.

Формат: дата → название milestone'а → ключевые изменения → ссылка на vault-артефакт.

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
