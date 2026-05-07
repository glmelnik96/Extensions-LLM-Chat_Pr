# Phase 1 quality fixes + GLM-4.7 selector

**Дата:** 2026-05-05
**Цель:** Закрыть 4 HIGH-impact проблемы из audit + добавить per-call model selector с GLM-4.7 для reasoning-heavy задач.
**Reference:** `.omc/research/multicam-podcast-feature.md` нет; референс — memory `project_transcript_pipeline_audit.md` и `reference_cloudru_models.md`.

---

## User decisions (этой сессии)

| Параметр | Решение |
|---|---|
| Default model для chat-agent | `gpt-oss-120b` (как сейчас) |
| GLM-4.7 routing | Везде где может улучшить качество — главы, find_moments, analyze (per-chunk), main agent. Цена не критична. |
| Audit fixes | Phase 1 целиком (4 HIGH-impact) |
| GLM-4.7 thinking mode | Включить для reasoning-heavy calls. Risk: EN-leakage в RU output — мониторить. |

---

## 6 шагов реализации

### Шаг 1 — `fm-defaults.js`: model-selector + temperature 0.1

**Что:**
- Добавить `chapterModel`, `findMomentsModel`, `analysisModel` поля.
- `chapterModel: 'zai-org/GLM-4.7'` для buildTopicsWithLLM
- `analysisModel: 'zai-org/GLM-4.7'` для analyzeForCutsWithLLM (per-chunk)
- `findMomentsModel: 'zai-org/GLM-4.7'` (на случай LLM-fallback в find-moments — пока не использует, но готовим инфраструктуру)
- `chatTemperature: 0.1` (было 0.5) — для tool-calling
- `analysisTemperature: 0.1` (как было)
- `enableThinking: true` (новое) — для GLM-4.7 reasoning
- Document: comments объясняющие routing decision.

**Validation:** node --check + grep на новые поля.

### Шаг 2 — `cloudru-client.js`: response_format + thinking passthrough

**Что:**
- `chatCompletions(opts)` поддерживает `opts.responseFormat` → `body.response_format = {type: 'json_object'}` если задано
- `opts.enableThinking` → `body.chat_template_kwargs = {enable_thinking: ...}` (правильное имя поля для GLM)
- Default body: НЕ ставить `response_format` (могут быть простые text-вопросы)
- Document: что какие модели поддерживают.

**Validation:** node --check + smoke-test (mock response).

### Шаг 3 — `agent-loop.js`: использовать chatModel + chatTemperature из settings

**Что:**
- Сейчас: model берётся из `settings.chatModel`, что хорошо.
- Проверить что `temperature` тоже через settings (если хардкод 0.5 где-то — заменить на `settings.chatTemperature || 0.1`)
- Передавать `responseFormat: 'json_object'` для tool-calling вызовов? Нет — потому что tool_calls и json_object конфликтуют по контракту OpenAI API. Для tool-calling сохраняем как есть (тут JSON в виде tool_calls schema, не json_object).

**Verdict для Phase 1:** только temperature через settings. response_format только для случаев где нет tools[]. Документируем.

### Шаг 4 — `transcript-structure.js`: cross-chunk bridging + model selection

**Что:**
- `analyzeForCutsWithLLM` получает `model` через settings → используем `settings.analysisModel || settings.chatModel`
- Cross-chunk bridging: для chunk N≥2 в user-message добавить **last 200 chars предыдущего chunk transcript** + краткое summary меток (cnt по category)
- `buildTopicsWithLLM` получает `model` через `settings.chapterModel || settings.chatModel`
- Передавать `enableThinking: settings.enableThinking` для GLM (не вредит другим моделям, они игнорят)
- response_format: уже стоит для analyze, оставляем

**Validation:** node --check + npm test (174+ тестов на transcript-structure не должны regrress).

### Шаг 5 — `prompts.js`: few-shot примеры в TIER1_TRANSCRIPT

**Что:**
- Добавить раздел `«Конкретные примеры»` в TIER1_TRANSCRIPT перед «ИНСТРУМЕНТЫ»
- 3 примера: «почисти», «собери ролик про X», «уложи в N секунд»
- Каждый: пользователь → внутренний tool-call (JSON в кодоблоке) → tool-call (JSON)
- Версия prompt: 2026-05-05 — quality-v3

**Validation:** node --check + smoke-чтение что не сломали structure.

### Шаг 6 — `panel.js`: panel.js: tool descriptions trim (опционально, если останется время) + использовать chatTemperature

**Что:**
- В `agent-loop.js` chatTemperature уже настроен (Шаг 3)
- Tool descriptions в panel.js: НЕ трогаем в Phase 1 (это MEDIUM в audit, отдельная сессия)

---

## Validation plan

После каждого шага:
- `node --check` соответствующих файлов
- После всех шагов: `npm test` — все 205 должны быть зелёными
- Smoke-test: vault artefact с примерами как поменялась картина

---

## Не делаем в Phase 1 (отложено)

- ❌ Tool descriptions trim (MEDIUM #5)
- ❌ validateTranscriptCuts hardening (MEDIUM #6)
- ❌ Tool history compression policy (MEDIUM #7)
- ❌ Tag-based markup vместо JSON (большой рефакторинг)
- ❌ Outline-then-detail (Phase 3)
- ❌ Stop sending tool definitions in pure-chat turns (MEDIUM #7 audit)

---

## Risks

1. **GLM-4.7 EN-leakage в RU output** — если в smoke-тесте LLM выдаст английские слова в названиях глав или в reason-полях вырезок, откатить chapterModel/analysisModel обратно на gpt-oss-120b.
2. **Thinking mode latency** — ответы могут быть в 2-5× медленнее. Если станет невыносимо, отключить через `enableThinking: false`.
3. **Few-shot примеры могут «перетянуть»** LLM на конкретные паттерны → проверить что универсальные запросы тоже работают.
4. **Cross-chunk bridging** добавляет токены на каждый чанк — но улучшает repeat/digression detection. Acceptable.
