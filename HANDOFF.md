# HANDOFF — входная точка для агентов

> Это **первый файл, который должен прочитать любой агент** перед началом работы над проектом.
> Цель — за 5 минут понять: что это, как устроено, где hot zones, как тестировать, чего НЕ трогать.

**Последнее обновление:** 2026-06-19 · **Статус:** production-ready · **Тесты:** 463/463 unit + 23/23 LLM quality на 1ч подкасте

---

## 1. Что это за проект (30 секунд)

**Extensions-LLM-Chat_Pr** — AI-ассистент видеомонтажа для Adobe Premiere Pro 2024+ (CEP 12 extension).

Пользователь общается с агентом в чате внутри панели Premiere: «убери паразитов», «уложи в 60 секунд», «поставь YouTube-главы». Агент (Cloud.ru GLM-5.1) читает транскрипт, строит план razor+ripple_delete, показывает карточку «Применить/Отмена», выполняет.

Также есть детерминированные кнопки в вкладке «Инструменты»: тишины, паразиты, jump cuts, главы.

**Backend:**
- LLM: Cloud.ru Foundation Models (GLM-5.1 для агента/анализа, DeepSeek-V4-Pro для глав/кода, gpt-oss-120b для routing)
- ASR: Whisper Large v3 через Cloud.ru (+ опциональный whisper.cpp local)
- Audio analysis: ffmpeg (silencedetect, loudnorm)
- Host: ExtendScript (CEP 12) для Premiere DOM + QE DOM

**Stack:**
- ES5-совместимый JavaScript (IIFE-модули, без bundler'а)
- Node-runtime внутри Chromium CEP (есть `require()`, `fs`, etc.)
- Тесты: Node `node --test` через vm-loader pattern

---

## 2. Что точно работает (production-ready)

| Feature | Где | Статус |
|---|---|---|
| Транскрибация In-Out (Cloud.ru Whisper) | Кнопка в Chat header | ✅ Параллельные чанки, cache, auto-restart |
| Audio-only анализ (ffmpeg без Whisper) | Tools view → ⚡ Анализ аудио | ✅ 30 сек на 1ч vs 10-15 мин Whisper |
| Cut silences (гибрид transcript+ffmpeg) | Tools → «Убрать тишины» | ✅ Threshold + padding |
| Cut fillers (Path A + Path B) | Tools → «Убрать паразиты» | ✅ gentle/normal/aggressive |
| Jump cuts (ритм YouTube-стиль) | Tools → «Jump cuts» | ✅ Дыхание 0-200мс, min-сегмент |
| Авто-главы (адаптивные по длине) | Tools → «Авто-главы» | ✅ 10/20/45с min-interval |
| MultiCam план для подкастов | Tools → «Авто-MultiCam» + LLM tool | ✅ Phase 2 audio-driven (RMS микрофонов), кастомный маппинг дорожек, пресеты; live-валидирован 2026-06-12 |
| Чекпоинты / откат | Кнопка «⏪ Откатить» + бэкап-секвенция перед apply | ✅ live-валидирован |
| Кликабельные таймкоды в чате | proposal-карты + свободный текст ответов | ✅ B1-1/B1-1b, клик → setPlayhead |
| AI чат: монтаж по тексту | Chat view | ✅ propose/apply паттерн |
| AI чат: маркеры (chapters/highlights) | Chat view | ✅ propose_markers |
| Сборка по хронометражу («N секунд») | Story Cutter Timed starter | ✅ targetDurationSec validation, +20% cap |
| Семантический поиск (`find_moments`) | Chat tool | ✅ Literal + TF-IDF, 6 категорий стартеров |
| YouTube chapters export | `Ещё ▾` меню | ✅ Format M:SS / H:MM:SS, validateForYouTube |
| Session export (JSON / AI report) | `Ещё ▾` меню | ✅ Cloud.ru FM анализирует лог |

**6 валидированных стартеров** (категории «По тексту» / «Маркеры» / «Поиск»):
- Story Cutter — автосборка ролика
- Уложить в N секунд — с targetDurationSec
- Чистка речи — analyze + propose
- YouTube-главы — propose_markers chapter
- Хайлайты — propose_markers comment
- Найти про… — find_moments

---

## 3. Не работает / отключено / out of scope

| Что | Почему | Workaround |
|---|---|---|
| J/L-cuts | ExtendScript не поддерживает `unlink()` | Отключено в UI, ручной монтаж в Premiere |
| Speed/Duration | Нет API в PP 2025/2026 | Вручную в Premiere |
| Volume keyframes (ducking) | `TrackItem.components.Volume.setValueAtKey` нестабилен | ffmpeg offline render + импорт WAV (реализовано, но не тестировалось в проде) |
| Span-маркеры | `mk.end` read-only | Длительность в комментарии маркера |
| Stop button на длинных evalScript | Cmd+Q не прерывает ES | Ждать завершения |
| Vision input | Нет vision модели | Out of scope |

---

## 4. Архитектура (1 минута)

```
┌─────────────────────────────────────────────────┐
│  CEP Panel (Chromium + Node.js)                 │
│  client/unified/index2.html + panel.js (5500 LoC)│
│                                                 │
│  ┌──────────┐  ┌──────────────────────────────┐ │
│  │ Вкладка  │  │ Вкладка «Инструменты»       │ │
│  │ «Чат»    │  │ Тишины · Паразиты · Jumps · │ │
│  │ + 6 стартеров│ │ Главы · ⚡ Анализ аудио  │ │
│  └────┬─────┘  └─────────────┬────────────────┘ │
│       │                      │                  │
│  ┌────▼──────────────────────▼────────────────┐ │
│  │ client/shared/ (IIFE-модули, ES5)          │ │
│  │ • cloudru-client.js   — HTTP API + SSE     │ │
│  │ • prompts.js          — tiered system prompts│
│  │ • agent-loop.js       — tool calling orch   │ │
│  │ • analysis-routing.js — aggressiveness +   │ │
│  │   keepIntervals inversion + duration cap   │ │
│  │ • transcript-structure.js — paragraphs,    │ │
│  │   topics, isParagraphsStale                │ │
│  │ • deterministic-pipelines.js — alg silences│ │
│  │   fillers, jumps, chapters                 │ │
│  │ • find-moments.js     — semantic search    │ │
│  │ • tool-validators.js  — pre-apply checks   │ │
│  │ • context-store.js    — кэш транскриптов  │ │
│  │ • conversation-starters.js — 6 стартеров   │ │
│  │ • youtube-export.js   — chapters formatter │ │
│  │ • timeline-transcribe.js, whisper-cpp-client│ │
│  │ • audio-preprocess.js, audio-render.js     │ │
│  │ • multicam-plan.js, ui-status.js, ui-hints.js│
│  └────────────────────┬───────────────────────┘ │
│                       │ CSInterface.evalScript   │
│  ┌────────────────────▼───────────────────────┐ │
│  │ host/premiere.jsx — ExtendScript           │ │
│  │ _wrap() декоратор для PP 2026 stability    │ │
│  │ Snapshot · Razor · Ripple · Markers ·      │ │
│  │ Multicam · Export                          │ │
│  └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
         │                        │
    Cloud.ru FM API          Adobe Premiere Pro
    (chat + whisper)         (DOM + QE DOM)
```

**Pure-logic pattern:** вся бизнес-логика (`analysis-routing`, `find-moments`, `prompts`, `tool-validators`) — pure IIFE без DOM-coupling, покрыта unit-тестами через vm-loader. UI-логика (`panel.js`) — separate.

---

## 5. Hot zones (где осторожно)

| Файл | LoC | Почему hot |
|---|---|---|
| `client/unified/panel.js` | ~5550 | UI + executors + agent loop. Любое изменение рискует регрессией. |
| `client/shared/transcript-structure.js` | ~1055 | paragraphs/segments structure. `buildParagraphs`, `isParagraphsStale`, `analyzeForCutsWithLLM` — critical |
| `client/shared/cloudru-client.js` | ~430 | HTTP client + retry + SSE streaming. Unit-тесты на internals (`_cloudRuInternals`): parseSSEStream (вкл. abort), isRetryable, parseJsonResponse, normalizeBase — `tests/cloudru-client.test.mjs` |
| `client/shared/agent-loop.js` | ~14KB | Tool orchestration + cycle detection. **НЕТ unit-тестов** — backlog |
| `client/shared/prompts.js` | ~30KB | Tiered prompts по intent. **НЕТ unit-тестов** — backlog. Любое изменение → re-validate 23/23 LLM checks |
| `host/premiere.jsx` | ~2840 | ExtendScript (ES3!). Особенности: JSON-полифилл (гард по `typeof JSON`), `_wrap()` декоратор, `safeSeconds()` null-guards. НЕТ `.trim`/`.forEach`/`Object.keys` — см. ExtendScript quirks |

**Правила hot zones:**
- **Не делать pre-check** в ExtendScript (`typeof JSON === 'function'` etc.) — используй optimistic try/catch; JSON гарантирован полифиллом вверху premiere.jsx
- **ExtendScript = ES3**: нет `.trim`/`.forEach`/`Object.keys`/`.bind` — не добавляй их в host без CDP-пробы наличия
- **panel.js не split'ить** без явной отмашки — это monster, но рабочий monster
- **prompts.js не рефакторить** без re-validation через `tests/integration/run-starters-quality.mjs`

---

## 6. Как тестировать

```bash
# Unit тесты (быстрые, ~1с) — именно npm test, не node --test tests/
npm test                                              # 463/463 pass

# Real LLM quality на реальном кэше через Cloud.ru API (~10 мин)
node tests/integration/run-starters-quality.mjs       # 23/23 quality checks
# Требует: fm-secrets.js с валидным apiKey
# Использует кэш ~/.extensions_llm_chat_pr/_llm_transcript_cache.json

# Production validation на длинных контентах (1ч+)
node tests/integration/run-glm47-production.mjs

# Ручной smoke (нельзя автоматизировать — это Premiere UI)
# Чеклист: docs/MANUAL_TESTS.md

# Live-прогон панели в живом Premiere через CDP (порт 8098 из .debug)
node tools/cep-debug.mjs targets       # список CEP-панелей
node tools/cep-debug.mjs reload        # перезагрузить панель
node tools/cep-debug.mjs evalfile tools/_live_probe.js   # выполнить JS в панели
# Кириллица/сложный JS — ТОЛЬКО через evalfile (shell ломает inline eval)
# PremiereBridge.evalScript НЕ существует — сырой ExtendScript через new CSInterface().evalScript
```

**Pattern для добавления unit-тестов:**
1. Pure-logic функция кладётся в `client/shared/<module>.js` как IIFE
2. Создаётся `tests/load-<module>.mjs` (vm-loader)
3. Создаётся `tests/<module>.test.mjs` (node:test + assert/strict)
4. Запускается `npm test`

См. примеры: `tests/load-analysis-routing.mjs` + `tests/analysis-routing.test.mjs`.

---

## 7. Что НЕ коммитить и НЕ изменять без отмашки

### Никогда не коммитить
- `client/shared/fm-secrets.js` — содержит реальный apiKey, **в .gitignore**
- Артефакты сессий: `~/.extensions_llm_chat_pr/sessions/*`, `~/.extensions_llm_chat_pr/reports/*`
- Кэш транскриптов: `~/.extensions_llm_chat_pr/_llm_transcript_cache.json`

### Изменять только с явной отмашкой
- `client/shared/prompts.js` — любое изменение требует re-validation 23/23 LLM checks
- `host/premiere.jsx` — особенности ExtendScript, легко сломать тихо
- `panel.js` структура файла (категории UI, агент loop)
- `CSXS/manifest.xml` — версия PP/CEP, MainPath

### Правила работы агента (из памяти проекта)
- **Никогда не делать `git commit/push` без явной отмашки** — "приступай" ≠ git permission
- **Никогда не использовать `--no-verify`** при коммитах
- **При rollback** — спрашивать, не делать destructive ops без подтверждения
- **При уверенности что фича сломает 23/23 quality checks** — A/B перед merge

---

## 8. Key conventions

### Code patterns
- **IIFE modules:** `(function (global) { ... global.MyModule = {...}; })(window);`
- **Pure logic separation:** business logic → `client/shared/<feature>.js` (тестируется vm-loader'ом). UI → `panel.js`.
- **Tool calling:** агент вызывает `propose_*` → плагин показывает карточку → user clicks Apply → `apply_*` исполняет. **Никогда не `apply_*` без `propose_*`**.
- **Walking skeleton MVP:** end-to-end сначала, потом обогащение фаз. Не доводить одну фазу до идеала пока остальные не работают.

### ExtendScript quirks (host/premiere.jsx) — движок ES3, не ES5!
- **`_wrap()` декоратор** обертывает exported functions для structured `{_hostError:true,...}` errors
- **Cold-start retry** в `bridge-premiere.js` (300/900мс backoff) — для PP 25/26 race condition
- **`safeSeconds()` null-guard** — `_clipTimes` может вернуть null на свежесмонтированной timeline
- **JSON-полифилл** (вверху файла, гард `if (typeof JSON === 'undefined')`): часть сборок ExtendScript НЕ имеют нативного JSON (подтверждено логом установки на стороннем устройстве) → все ~85 вызовов `JSON.*` падали с `ReferenceError`. Где JSON есть (напр. ES 4.5.6 в PP 26.2) — гард пропускает полифилл. **Не удалять.** `_wrap` сохраняет optimistic try/catch как defense-in-depth.
- **Не делать `typeof JSON.stringify === 'function'`** — на PP 26 COM-bridge возвращает `'unknown'`, pre-check бессмысленен; полифилл + try/catch надёжнее.
- **ES5-методы отсутствуют в ExtendScript** — проверено на живом PP 26.2 (ES 4.5.6): НЕТ `String.prototype.trim`, `Array.prototype.forEach`, `Object.keys` (но `Array.prototype.indexOf` ЕСТЬ). Вместо `.trim()` → `.replace(/^\s+|\s+$/g,'')`. Перед использованием любого ES5-метода в host — проверь его наличие пробой через CDP.
- **Версия host** в `$._EXT_PRM_.version` — бампать при правках host (сейчас `2.6.7`).

### LLM patterns
- **`targetDurationSec`** обязателен в `propose_transcript_cuts` для запросов «уложи в N сек»
- **`paddingSec: 0.3`** default — дыхание вокруг cut'ов (openshorts pattern)
- **`aggressiveness: gentle|normal|aggressive`** для `analyze_transcript_for_cuts`
- **`keepIntervals` vs `removeIntervals`** — выбирать что проще для конкретного запроса, плагин инвертирует автоматически
- **per-role model routing:** `chatModel` / `analysisModel` / `chapterModel` / `findMomentsModel` / `fastModel`

---

## 9. Ключевые milestone'ы (хронология)

См. полный список: [`docs/CHANGELOG.md`](docs/CHANGELOG.md). Краткие highlights:

- **2026-04:** PRD US-001…US-006, semantic-editing-v2 (aggressiveness, keepIntervals, адаптивные главы)
- **2026-05-02:** OpenShorts integration (paddingSec 0.3, YouTube chapters export)
- **2026-05-03:** PP 2026 stabilization (`_wrap` decorator + cold-start retry)
- **2026-05-04:** MultiCam Phase 1 MVP для подкастов
- **2026-05-05:** Install hardening (INSTALL.md, health-check)
- **2026-05-05:** Phase 1 quality fixes + GLM-4.7 selector
- **2026-05-05:** Phase 1.5 (per-role thinking, parallel chunking)
- **2026-05-06:** Phase 1.6 (audio-only path для cutSilences/jumpCuts)
- **2026-05-06:** Phase 1.7 (sequence-switch guard, abort listener leak, validators)
- **2026-05-06:** Target-duration enforcement (40с→70с overshoot fix) + stale paragraphs auto-rebuild + snap к paragraph boundaries
- **2026-05-06:** UI overhaul Сценарий B (CSS-токены, focus management, progress bar, retry, event-based view sync)
- **2026-05-07:** UI compact v3 collapsible-карточки категорий, scenarios-validation tests
- **2026-05-07:** video-use research + откат (3 идеи не дали benefit'а на нашем ASR)
- **2026-05-07:** Highlights cycling fix (42 find_moments → 3 tool calls, 19× быстрее), README test count fix, 6 silent catches → console.warn
- **2026-05-07:** DaVinci Resolve migration research → parked
- **2026-05-?? — 2026-06-03:** MultiCam Phase 2A — audio-driven speaker detection
  - `framesFromRmsTimelines` RMS-grid aligner, `multicamFromAudio` пайплайн
  - `enforceMaxHold` (wide bridge на долгих mono-сегментах), `applyVariations` (seeded jitter), `snapToSpeechOnset`
  - generalize до N speakers (max 4)
  - Tools dispatch wired в panel.js на audio-driven detection
  - Fix runtime: `MulticamPlan` экспорт напрямую в `window` (CEP `--enable-nodejs` ломал CommonJS-fallback)
  - **Status:** код в working state, тесты зелёные. Phase 2B manual test в Premiere — pending
- **2026-06-04:** Phase 2 model migration — GLM-5.1 (агент/анализ/findMoments) + DeepSeek-V4-Pro (главы/код), `max_tokens` 8000→16000. См. [`.omc/research/2026-06-04-cloudru-new-models-evaluation.md`](.omc/research/2026-06-04-cloudru-new-models-evaluation.md)
- **2026-06-10:** Quality/speed audit wave (честные host-ошибки, NTSC fps, streaming UI) + UI-2 (instant slider re-filter, background precompute) + Wave A (версионирование кэша анализа, audio-only тулзы, ETA моделей)
- **2026-06-11:** Волна B заимствований у конкурентов — checkpoint/«⏪ Откатить», кликабельные таймкоды в proposal-картах, пресеты мультикама, кросс-токи; конкурентная разведка в docs
- **2026-06-12:** MultiCam live-фиксы (BRAW-ошибка честно, media→sequence remap, варнинг плоского микрофона) + кастомный выбор дорожек по спикерам + `tools/cep-debug.mjs` (CDP live-прогоны) + кликабельные таймкоды в свободном тексте чата (B1-1b) + fix зацикливания find_moments (стем только с начала слова, multi-stem ranking). Всё live-валидировано в Premiere на реальных проектах (включая 53-мин подкаст, 768 сегментов)

---

## 10. Open backlog (по убыванию приоритета)

### Quick wins
- Unit tests для cloudru-client.js / agent-loop.js / prompts.js (~5-7ч)
- ffmpeg path detection через FM_DEFAULTS с OS detection (~15 мин)
- Дополнительные unit-тесты для `thinkingPolicy` / audio-only flow

### Medium
- Split panel.js на 4-5 модулей по ответственности (UI / executors / agent loop / tools / export) — ~8-10ч
- Extract functions >100 LoC в hot zones (cloudru-client.makeRequest, agent-loop.runAgentLoop, transcript-structure.buildTopics)
- Captions/subtitles export из Whisper сегментов
- B-roll marker hints

### Tech debt (низкий приоритет)
- 7 модулей пишут в `global.X` без namespace guard
- Migration CEP → UXP (ExtendScript EOL сентябрь 2026)

### Research-only (parked)
- DaVinci Resolve миграция — research зафиксирован в vault, ждёт business reason
- video-use идеи (phrase-packed view, archetypes, protected zones) — не дают benefit'а без ASR upgrade

---

## 11. Точки расширения / куда копать

### Хочу добавить новый стартер (system prompt-driven workflow)
1. Открыть `client/shared/conversation-starters.js`
2. Добавить запись в нужную категорию (`textmontage` / `markers` / `search`) с `systemPromptAddon` + `userPrompt`
3. **ОБЯЗАТЕЛЬНО** провалидировать через `node tests/integration/run-starters-quality.mjs` на реальном кэше
4. Добавить test case в `tests/integration/run-starters-quality.mjs` если стартер сложный

### Хочу добавить новый tool для LLM-агента
1. Добавить schema в `panel.js` (`TOOL_SCHEMAS` массив)
2. Добавить executor (функция `execXxx`) — должен возвращать `{ok, ...}` или `{validationError}`
3. Wire в TOOL_HANDLERS dispatch
4. Если меняется состояние таймлайна — обязательно через `propose_*` → `apply_*` pattern
5. Документировать в `prompts.js` (если LLM должен знать когда звать)

### Хочу изменить behaviour LLM
1. Найти соответствующий tier в `prompts.js` (TIER0_CORE / TIER1_TIMELINE / TIER1_TRANSCRIPT / TIER1_MARKERS / TIER1_AUDIO)
2. **НЕ ЛОМАТЬ existing few-shot examples** — они валидированы
3. Bump VERSION constant в начале файла (2026-MM-DD — descriptive-name)
4. Run `npm test` + `tests/integration/run-starters-quality.mjs` для регрессии

### Хочу добавить новый детерминированный pipeline
1. Алгоритм → `client/shared/deterministic-pipelines.js`
2. Unit тесты → `tests/deterministic-pipelines.test.mjs`
3. UI карточка → `client/unified/index2.html` (`view-tools`) + handler в `panel.js`
4. Slash-команда (опционально) — `chat-router.js` или в `panel.js`

---

## 12. Связанные документы

| Файл | Что внутри |
|---|---|
| [README.md](README.md) | Описание проекта, quick-start, файловая структура |
| [INSTALL.md](INSTALL.md) | Пошаговая установка (macOS / Windows) + Troubleshooting |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Полная хронология milestone'ов |
| [docs/DEV_ARTIFACTS.md](docs/DEV_ARTIFACTS.md) | Lessons learned (12 ловушек CEP/ExtendScript), known issues, roadmap, аудит компонентов |
| [docs/MANUAL_TESTS.md](docs/MANUAL_TESTS.md) | Чеклист ручного тестирования в Premiere |
| `.omc/research/*.md` | Глубокие research-сессии (PP 26, MultiCam, Premiere API audit) |
| `.omc/plans/*.md` | Plans от Phase 1, MultiCam, semantic editing |

### Vault (Obsidian 2nd brain)
`01 Projects/Premiere CEP Suite/` содержит ~14 артефактов с детальными разборами каждой phase, включая research-only артефакты (UXP migration, video-use, DaVinci Resolve). Folder note: `Premiere CEP Suite.md`.

---

## 13. Memory (для агентов которые имеют memory API)

Если у тебя есть доступ к project memory (`~/.claude/projects/.../memory/`), там сохранены:
- `feedback_commit_protocol.md` — никогда не коммитить без отмашки
- `feedback_extendscript_quirks.md` — pre-checks unreliable
- `feedback_pure_logic_pattern.md` — IIFE + vm-loader тесты
- `feedback_mvp_walking_skeleton.md` — end-to-end first
- `feedback_per_call_model_routing.md` — `<role>Model` поля
- `feedback_glm47_real_call_findings.md` — timeout 120→300с, transient retry
- `feedback_audit_after_refactor.md` — дед-references после migration
- `feedback_competitor_ux_check.md` — сравнивать с AutoPod/FireCut/Descript

Прочитай эти feedback'и **до того как** начнёшь что-то менять — они спасут от повторения уже совершённых ошибок.

---

## Быстрая проверка: всё ли в порядке после твоих изменений

```bash
# 1. Syntax check всех JS
for f in client/unified/panel.js client/shared/*.js; do node --check "$f" || echo "FAIL: $f"; done

# 2. Unit tests
npm test                                              # должно быть 463/463

# 3. LLM quality (если менял prompts.js, conversation-starters.js, или агент-логику)
node tests/integration/run-starters-quality.mjs       # 23/23

# 4. CSS/HTML structure
python3 -c "css=open('client/shared/styles.css').read(); print(css.count('{')==css.count('}'))"

# 5. Нет dead references
grep -rn "packParagraphsAsMarkdown\|buildEditorBrief\|findProtectedZones" client/ tests/ \
  && echo "FOUND DEAD REFS!" || echo "clean"
```

Если все 5 проверок пройдены — твои изменения safe to ship. Перед коммитом — **жди явную отмашку пользователя**.
