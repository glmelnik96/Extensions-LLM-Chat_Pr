# Артефакты разработки

Консолидированный документ: lessons learned, known issues, аудит, roadmap.
Обновлено: 2026-05-07.

> Для быстрого онбординга агента — см. [HANDOFF.md](../HANDOFF.md) в корне.
> Хронология milestone'ов — [CHANGELOG.md](CHANGELOG.md).

---

## 1. Lessons Learned (ловушки CEP + ExtendScript + Premiere)

### 1.1. CEP Chromium кэширует HTML агрессивно
`index.html` кэшируется даже после перезагрузки панели. Cache-bust через `document.write()` с `?_cb=Date.now()` не помогает, если сам HTML закэширован.
**Решение:** переименовать HTML (`index.html` → `index2.html`), обновить `manifest.xml MainPath`. Кэш: `~/Library/Caches/CSXS/cep_cache/`.

### 1.2. 413 Payload Too Large — ложное срабатывание
Regex `/413/` в `isPayloadTooLarge` ловил token ID `23413` в Whisper verbose_json ответе (status 200).
**Решение:** `\b413\b` word boundary + пропуск body check для 2xx ответов.

### 1.3. ExtendScript regex lexer bug
Лексер ES неверно обрабатывает `/` внутри character classes `[...]`. Ломает весь файл.
**Решение:** заменить regex на `lastIndexOf('/')` + string operations.

### 1.4. Volume keyframes нестабильны
`TrackItem.components.Volume.setValueAtKey` на PP 2025 — результат непредсказуем.
**Решение:** offline рендер через ffmpeg + импорт WAV.

### 1.5. Chat overflow после 5-8 запросов
Tool results накапливаются в контексте → 413 от FM API.
**Решение:** `compressToolHistory()` — последние 4 сообщения целиком, старые → 600 байт.

### 1.6. find_moments — мало результатов
Чистый TF-IDF на параграфах давал 1-2 хита.
**Решение:** literal substring + стемминг по сегментам, TF-IDF как fallback.

### 1.7. «Удали клип X» удаляло всё ниже
LLM выбирал `ripple_delete_range` вместо `remove_clip`.
**Решение:** enforce `remove_clip` с `nodeId` в prompt + валидатор.

### 1.8. ffmpeg не найден из Node-CEP
CEP Node.js не наследует пользовательский PATH.
**Решение:** whitelist `/usr/local/bin`, `/opt/homebrew/bin`, etc. + explicit PATH extension.

### 1.9. Host cache — jsx не обновляется
Изменения в `premiere.jsx` не подхватываются без перезагрузки панели/Premiere.
**Решение:** всегда перезапускать панель после правок jsx.

### 1.10. Audio analysis на неправильных файлах
`computeAudioPreprocess` запускался на raw .braw (1GB video) и .mp3 (music), а не на извлечённых WAV чанках.
**Решение:** анализ на extracted WAV chunks с правильным timeline offset, удаление чанков после анализа.

### 1.11. Segment overlaps из разных клипов
Музыка (.mp3) и речь (.braw) давали перекрывающиеся сегменты.
**Решение:** дедупликация — удаление dominated сегментов (короткий текст внутри длинного).

### 1.12. _cleanSeqKey обрезал имена секвенций
`s.split(/\s+/)[0]` превращал «My Sequence» в «My» → cache miss → все AI-операции сломаны.
**Решение:** удалять только known suffixes (dur=, clips=, in=, out=), не трогая пробелы.

### 1.13. LLM overshoot на «уложи в N сек» (40с → 70с +75%)
LLM игнорировал target duration — нет арифметической валидации в prompt и нет runtime-проверки.
**Решение:** `targetDurationSec` параметр в schema + `validateKeepDuration` с +20% cap. При overshoot → structured error с подсказкой, LLM пересобирает.

### 1.14. Stale paragraphs после ripple_delete (mid-word cuts)
После `applyTranscriptCuts` segments ремаплятся, paragraphs остаются в старых координатах. Drift до 5.5с между `paragraph.endSec` и `segments[idxs[-1]].endSec` → LLM работает по неверным timestamps.
**Решение:** `isParagraphsStale()` детект (drift >1с или out-of-range segIdxs) + auto-rebuild в 3 точках входа.

### 1.15. PP 2026 cold-start race
ExtendScript не успевает прогреться к первому `evalScript`, возвращает `EvalScript error.`
**Решение:** `_wrap()` decorator + retry с exponential backoff (0/300/900мс) в `bridge-premiere.js`. Optimistic try/catch вместо pre-check `typeof JSON.stringify === 'function'`.

### 1.16. Highlights cycling на длинных контентах
LLM в режиме «Хайлайты» на 1ч контенте делал 42 `find_moments` вызова с вариациями тех же запросов, не доходил до `propose_markers` (3/4 quality fail).
**Решение:** ХАРД-ЛИМИТ max 1 `find_moments` в system-prompt, разделение «общий запрос» vs «узкий», явный `propose_markers обязателен`. Результат: 23/23 pass, 19× быстрее.

### 1.17. video-use prompt-инжиниринг не транслируется на наш ASR
Phrase-packed view дал 14% сжатия (не 10×), `buildEditorBrief` ломал tool-use паттерн, protected zones no-op без `(laugh)` тегов в Whisper.
**Решение:** откатить инфраструктуру, оставить research в vault. Возвращаться после ASR upgrade на event-tagging.

---

## 2. Known Issues (текущие)

### Активные ограничения

| # | Проблема | Severity | Workaround |
|---|----------|----------|------------|
| 1 | J/L-cuts отключены | Medium | Ручной монтаж. ExtendScript не поддерживает `unlink()` |
| 2 | `set_clip_speed` не поддерживается | Low | Speed/Duration в Premiere вручную |
| 3 | `move_clip` — linked A/V иногда рассинхронизируется | Medium | Cmd+Z и повторить |
| 4 | Span-маркеры: `mk.end` read-only | Low | Длительность в комментарии маркера |
| 5 | Stop button не прерывает `evalScript` | Low | Ждать завершения ExtendScript |
| 6 | Transcript timing drift | Low | Сдвиг ≤0.3с, приемлемо для монтажа |

### Исправлено (ранее были баги)

- 413 false positive на Whisper response — исправлено (word boundary regex)
- Agent loop cycling — исправлено (`detectCycle()`)
- Fillers не находились (Whisper сегменты 5-30с) — исправлено (Path B: начало/конец фразы)
- Jump cuts = silences (оба через ffmpeg) — исправлено (hybrid: transcript gaps + ffmpeg)
- AI чат не видел изменения таймлайна — исправлено (force refresh auto-snapshot)
- Микро-зазоры 2-3 кадра после razor — исправлено (MIN_CUT 0.15s filter)

### Пробелы в тестовом покрытии

Автотесты (**247 штук** unit + **23/23 LLM quality checks** на 1ч подкасте через Cloud.ru API) покрывают: валидаторы, pipelines, prompts logic, search, simulator, transcript structure, conversation starters scenarios, multicam plan, YouTube export, analysis routing (включая `validateKeepDuration` и `isParagraphsStale`).

**Не покрыто автотестами** (только ручные):
- `host/premiere.jsx` — snapshot, razor, markers, export (ExtendScript не запускается из Node)
- Whisper/FM API timeouts и non-JSON ответы
- A/V pair sync после серии правок
- Intent classification edge cases

**Hot zones без unit-тестов** (backlog 5-7ч):
- `client/shared/cloudru-client.js` — HTTP retry, SSE parsing
- `client/shared/agent-loop.js` — orchestration, cycle detection
- `client/shared/prompts.js` — tiered logic, intent classification

---

## 3. Аудит компонентов

### Подтверждённо работает (2026-05-07, после Phase 1.5/1.6/1.7 + UI overhaul + scenarios validation)

| Компонент | Статус | Примечания |
|-----------|--------|------------|
| Транскрибация clip_queue | OK | Параллельные чанки, cache, auto audio analysis, retry 5×, timeout 300с |
| **Audio-only анализ** (Phase 1.6) | OK | ffmpeg без Whisper, 30 сек на 1ч vs 10-15 мин |
| cutSilences (hybrid) | OK | Transcript gaps + ffmpeg, threshold slider |
| cutFillers (v2) | OK | Path A + Path B, strict/expanded |
| jumpCuts (hybrid) | OK | Transcript gaps + ffmpeg, min 0.1s, дыхание, min-сегмент |
| chapterize | OK | LLM topics + time-based fallback + maxChapters + min-interval адаптивный |
| **MultiCam Phase 1 MVP** | OK | QE DOM razor + clip.disabled, sequence-switch guard, undo leak fix |
| AI chat: timeline edits | OK | propose_edit_plan, remove_clip, ripple, trim |
| AI chat: transcript cuts | OK | analyze + propose, one-pass principle, **`targetDurationSec` validation +20% cap** |
| AI chat: markers | OK | propose_markers, **6 валидированных стартеров** (23/23 LLM checks) |
| Snapshot caching | OK | Force refresh per message, dirty flag |
| Session export (JSON) | OK | ~/.extensions_llm_chat_pr/sessions/ |
| AI report generation | OK | Cloud.ru FM analysis, chunked logs |
| **Per-call model routing** | OK | chatModel/analysisModel/chapterModel/findMomentsModel/fastModel + thinkingPolicy |
| **GLM-4.7 + thinkingPolicy** | OK | GLM-4.7-Flash 27% быстрее full с тем же качеством |
| Deterministic slash-commands | OK | /cut_fillers, /cut_silences, /jump_cuts, /chapterize |
| **isParagraphsStale auto-rebuild** | OK | Детект drift >1с / out-of-range segIdxs после ripple_delete |
| **Snap к paragraph boundaries** | OK | drift 1.5с → fallback к segments (drift 0.5с) |
| **YouTube chapters export** | OK | formatChaptersForYouTube + validateForYouTube |
| **PP 2026 совместимость** | OK | `_wrap` decorator + cold-start retry (0/300/900мс) |
| **UI: collapsible categories** | OK | 3 категории (По тексту / Маркеры / Поиск), state в localStorage |
| **UI: target/actual badge** | OK | Green/amber/red по overshoot ratio |
| **UI: progress bar** | OK | Точный % в analyze, indeterminate в transcribe |
| **UI: WCAG AA контраст + focus-visible** | OK | aria-live, role=alert/status/progressbar |
| **UI: retry on network errors** | OK | _classifyError() → network/auth/quota/cancel |

### С оговорками

| Компонент | Проблема |
|-----------|----------|
| Audio ducking | Код написан, не тестировался end-to-end в продакшене |
| LUFS normalization | Код написан, не тестировался end-to-end |
| move_clip | Linked A/V иногда рассинхронизируется |
| Transcript LED | Обновление с задержкой до следующего cache-refresh |
| Highlights на 1ч+ контентах | После fix 2026-05-07: 3 tool calls вместо 42 (раньше зацикливался), но ещё нужен реальный production smoke с разными темами |

---

## 4. Roadmap

### Выполнено (P0–P1)

- [x] Deterministic pipelines (silences, fillers, jumps, chapters)
- [x] Agent cycle detection
- [x] JSON repair for malformed tool args
- [x] Retry with exponential backoff (3x for 5xx/429)
- [x] SSE streaming (optional)
- [x] Parallel tool_call execution
- [x] Snapshot caching with dirty-flag
- [x] Two-model routing (fast/full)
- [x] Auto-inject timeline snapshot
- [x] Local detectors (fillers, intro/outro, artifacts)
- [x] Tiered system prompt by intent
- [x] Transcript structure (paragraphs, topics, speakers)
- [x] Unified EditPlan (propose/dry_run/apply)
- [x] find_moments (literal + TF-IDF)
- [x] Silence threshold user control
- [x] Chapter count user control
- [x] Micro-gap filter (0.15s)
- [x] One-pass editing principle in prompts
- [x] Session export + AI report generation

### Выполнено (P0–P1) — продолжение (май 2026)

- [x] OpenShorts integration (paddingSec 0.3, YouTube chapters export)
- [x] PP 2026 stabilization (`_wrap` decorator + cold-start retry)
- [x] MultiCam Phase 1 MVP для подкастов
- [x] Install hardening (INSTALL.md, health-check)
- [x] Phase 1 quality fixes (few-shot, temperature 0.1, response_format, cross-chunk bridging)
- [x] GLM-4.7 per-call model routing + thinkingPolicy
- [x] Parallel chunking в analyzeForCutsWithLLM (concurrency=3)
- [x] Production validation на 1ч подкасте (1255 segs / 297 paragraphs)
- [x] Audio-only path (30 сек vs 15 мин Whisper для cutSilences/jumpCuts)
- [x] Sequence-switch guard на apply paths
- [x] Target-duration enforcement (+20% cap, validateKeepDuration)
- [x] Stale paragraphs auto-rebuild (isParagraphsStale + drift detect)
- [x] Snap к paragraph boundaries (drift 1.5с → fallback segments 0.5с)
- [x] UI overhaul Сценарий B (CSS-токены, focus management, progress bar, retry, event-based view sync)
- [x] UI compact v3 collapsible categories
- [x] Scenarios validation tests (real LLM, 23/23 pass)
- [x] Highlights cycling fix (max 1 find_moments, 19× быстрее)
- [x] HANDOFF.md + CHANGELOG.md
- [x] README/MANUAL_TESTS/DEV_ARTIFACTS актуализированы

### В плане (P2) — текущее backlog

- [ ] Unit tests для cloudru-client.js / agent-loop.js / prompts.js (5-7ч)
- [ ] ffmpeg path detection через FM_DEFAULTS с OS detection (15 мин)
- [ ] Per-project/sequence chat memory
- [ ] B-roll marker hints
- [ ] Captions/subtitles из Whisper сегментов (SRT/VTT export)
- [ ] Split panel.js на 4-5 модулей по ответственности (8-10ч)
- [ ] Extract functions >100 LoC в hot zones (4-6ч)
- [ ] MultiCam Phase 1.5: ffmpeg astats per-channel pipeline
- [ ] MultiCam: проверка clip.disabled на linked V↔A парах

### Дальний план (P3)

- [ ] Structured output / JSON mode от FM
- [ ] UXP compatibility layer (для move_clip, span-markers, unlink) — ExtendScript EOL сентябрь 2026
- [ ] Integration tests (ExtendScript → Premiere)
- [ ] Color grading через Lumetri
- [ ] Export presets
- [ ] Auto-annotations для проблемных участков
- [ ] RLHF-lite из accept/reject решений
- [ ] Project-specific dictionary
- [ ] Session quality metrics
- [ ] Drag-and-drop clip из timeline

### Research-only / parked

- DaVinci Resolve миграция — research зафиксирован (180-240ч effort, parked до бизнес-причины)
- video-use идеи (phrase-packed view, archetypes, protected zones) — не дают benefit'а без ASR upgrade
- UXP migration — research в vault, ждёт официальной EOL ExtendScript

### Исключено

- Zoom/punch-in on accents — нет API
- Local LLM fallback (ollama) — отложено
- Visual keyframe analysis — требует vision model
- Voice input — нет инфраструктуры
- Auto B-roll selection — заменено на B-roll marker hints
- J/L-cuts — ExtendScript не поддерживает unlink()
- Speed/Duration — нет API в PP 2025/2026
