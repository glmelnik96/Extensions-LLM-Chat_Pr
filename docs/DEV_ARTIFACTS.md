# Артефакты разработки

Консолидированный документ: lessons learned, known issues, аудит, roadmap.
Обновлено: 2026-04-13.

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

Автотесты (129 штук) покрывают: валидаторы, pipelines, prompts, search, simulator, transcript structure.

**Не покрыто автотестами** (только ручные):
- `host/premiere.jsx` — snapshot, razor, markers, export
- Whisper/FM API timeouts и non-JSON ответы
- A/V pair sync после серии правок
- Intent classification edge cases
- Audio ducking + LUFS normalization (код есть, не тестировался в продакшене)

---

## 3. Аудит компонентов

### Подтверждённо работает (2026-04-13)

| Компонент | Статус | Примечания |
|-----------|--------|------------|
| Транскрибация clip_queue | OK | Параллельные чанки, cache, auto audio analysis |
| cutSilences (hybrid) | OK | Transcript gaps + ffmpeg, threshold slider |
| cutFillers (v2) | OK | Path A + Path B, strict/expanded |
| jumpCuts (hybrid) | OK | Transcript gaps + ffmpeg, min 0.1s |
| chapterize | OK | LLM topics + time-based fallback + maxChapters |
| AI chat: timeline edits | OK | propose_edit_plan, remove_clip, ripple, trim |
| AI chat: transcript cuts | OK | analyze + propose, one-pass principle |
| AI chat: markers | OK | propose_markers |
| Snapshot caching | OK | Force refresh per message, dirty flag |
| Session export (JSON) | OK | ~/.extensions_llm_chat_pr/sessions/ |
| AI report generation | OK | Cloud.ru FM analysis, chunked logs |
| Two-model routing | OK | classifyComplexity → fast/full model |
| Deterministic slash-commands | OK | /cut_fillers, /cut_silences, /jump_cuts, /chapterize |

### С оговорками

| Компонент | Проблема |
|-----------|----------|
| Audio ducking | Код написан, не тестировался end-to-end |
| LUFS normalization | Код написан, не тестировался end-to-end |
| move_clip | Linked A/V иногда рассинхронизируется |
| Transcript LED | Обновление с задержкой до следующего cache-refresh |

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

### В плане (P2)

- [ ] Per-project/sequence chat memory
- [ ] B-roll marker hints
- [ ] Health-check перед крупными правками
- [ ] Drag-and-drop clip из timeline
- [ ] Captions/subtitles из Whisper сегментов

### Дальний план (P3)

- [ ] Structured output / JSON mode от FM
- [ ] UXP compatibility layer (для move_clip, span-markers, unlink)
- [ ] Integration tests (ExtendScript → Premiere)
- [ ] Color grading через Lumetri
- [ ] Export presets
- [ ] Auto-annotations для проблемных участков
- [ ] RLHF-lite из accept/reject решений
- [ ] Project-specific dictionary
- [ ] Session quality metrics

### Исключено

- Zoom/punch-in on accents — нет API
- Local LLM fallback (ollama) — отложено
- Visual keyframe analysis — требует vision model
- Voice input — нет инфраструктуры
- Auto B-roll selection — заменено на B-roll marker hints
