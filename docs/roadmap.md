# Roadmap: LLM Chat for Premiere — ИИ-помощник в монтаже

Легенда статусов: ☐ запланировано · ◧ в работе · ✓ готово · ⚠ known-broken · ✗ не будет реализовано.

---

## Sprint 2026-04-10 — Оптимизация пайплайна (P0-P1)

Цель: ускорить пайплайн маркеров по смыслам и монтажа по тексту — два основных сценария.
Проблема: анализ транскрипта через LLM занимал 2-4+ минуты (109K токенов на вход, лишние round-trips).

### P0-1: Auto-inject timeline snapshot ✓
- Перед запуском агент-цикла автоматически получаем снимок таймлайна и вставляем в контекст.
- Убирает 1 обязательный round-trip (агент раньше вызывал `get_timeline_snapshot` первым шагом всегда).
- Реализация: `onSend()` вызывает `execGetSnapshot()` → snapshot вставляется как `role: 'user'` перед user-сообщением.

### P0-2: Локальные детекторы (без LLM) ✓
- `detectFillers(segments)` — словарные fillers (ну, ээ, ммм, как бы, типа, вот, короче, допустим, ладно).
- `detectIntroOutro(segments, totalDurationSec)` — паттерны приветствий/прощаний в первых/последних 10% видео.
- `detectArtifacts(segments)` — повторяющиеся фразы Whisper (артефакты транскрибации).
- Работают мгновенно. Результат используется как pre-labels перед LLM-анализом: сегменты, уверенно размеченные локально, НЕ отправляются в LLM.

### P0-3: Pre-compute analysis при транскрибации ✓
- После `buildTopicsWithLLM` запускаем локальные детекторы и сохраняем `entry.preAnalysis`.
- При вызове `analyze_transcript_for_cuts` — локально размеченные сегменты берутся из кэша, в LLM отправляются только неопределённые.
- Экономия: для типичного 30-мин видео 20-40% сегментов размечаются локально → LLM получает меньше данных.

### P1-1: Tiered system prompt ✓
- Промпт разбит на Tier 0 (всегда: роль + оркестрация + правило подтверждения) и Tier 1 (по задаче).
- Intent classification по первому сообщению пользователя: markers / transcript_edit / timeline_edit / audio / general.
- Tier 1 секции подключаются динамически → экономия ~2-3K токенов на каждый запрос.

### P1-2: Compact tool schemas ✓
- `TOOLS_UNIFIED` сформирован с дедупликацией; неиспользуемые описания сокращены.
- Общая экономия ~1-2K токенов на tool definitions.

---

## Журнал изменений

### 2026-04-08 — Локальная транскрибация (whisper.cpp) и фикс ExtendScript-лексера

- ✓ **Локальный бэкенд транскрибации whisper.cpp.** Новый модуль `client/shared/whisper-cpp-client.js` (`WhisperCppClient.transcribeFile / diagnose / findWhisperCliPath / findWhisperModelPath`). Автопоиск бинарника (`~/whisper.cpp/build/bin/whisper-cli`, brew, `which` с расширенным PATH) и модели (`ggml-medium.bin` → `large-v3` → `small` → `base`). Запуск через `child_process.execFile` с флагами `-m … -f … -l ru -oj -of <tmp>`. Парсер `parseWhisperCppJson()` конвертирует `-oj` (offsets в ms) в Whisper verbose_json `{segments:[{start,end,text}], text, language}`.
- ✓ **Диспетчер `backendTranscribe()` в `timeline-transcribe.js`.** Все 6 вызовов `CC.transcribeAudio(...)` заменены на один хелпер, который читает `settings.transcribeBackend` (`'whisper.cpp'` | `'cloud'`) и маршрутизирует в `WhisperCppClient` или `CloudRuClient`. Для локального пути `maxBytes = Infinity` (лимит 20 МБ API снят). Для контейнеров видео (`.mp4`, `.mov`, …) whisper-cli не знает — добавлена проверка `isAudioExt()` (wav/mp3/ogg/oga/flac) и принудительная ffmpeg-экстракция в wav перед подачей в whisper-cli.
- ✓ **FM_DEFAULTS расширен.** Новые поля: `transcribeBackend: 'whisper.cpp'` (дефолт!), `whisperCppBin`, `whisperCppModel`, `whisperCppLanguage: 'ru'`, `whisperCppThreads: 0`, `whisperCppExtraArgs: []`. Плюс whitelist в `ContextStore.getResolvedSettings()` пополнен этими полями — без этого `settings.transcribeBackend` возвращался `undefined` и диспетчер молча падал на cloud (→ 413 Payload Too Large).
- ✓ **ExtendScript regex lexer bug в `host/premiere.jsx`.** Функция `importMediaFile` использовала `/^.*[\\/]/` для вычленения basename — лексер ExtendScript терминирует regex-literal на первом `/` даже внутри `[...]`, из-за чего хост падал с `SyntaxError: Expected: )` при загрузке. Заменено на `lastIndexOf('/')` + `lastIndexOf('\\')`. Урок зафиксирован в `docs/lessons-learned.md` (раздел 2).
- ✓ **`docs/lessons-learned.md`** — новый файл с 8 накопленными граблями: 413 (с полным текстом ошибки), regex-lexer, невалидные keyframes Volume, компрессия чата, find_moments literal-first, «remove_clip only» правило, ffmpeg PATH whitelist для CEP Node, кэш хоста (перезагрузка панели после правок .jsx).
- ◧ **Test 4 — Audio ducking (реальный рендер).** Оставлен в пайплайне (`client/shared/audio-ducking.js`, `audio-render.js`), но **не фиксируется как 100% рабочий**. Пользователь не использует в продакшене; функциональность сохранена для будущих итераций §3.3.
- ◧ **Test 5 — LUFS normalization (реальный рендер).** Аналогично: код `loudnorm` через offline ffmpeg (`audio-render.js`) остаётся, но не верифицируется как стабильный путь. Будет добиваться в §3.3.

### 2026-04-08 — UI унифицированной панели и чистка нереализуемого

- ✓ **Скрытие tool-блоков в чате.** Сообщения с `role=tool` и assistant-сообщения с `tool_calls` без текста рендерятся свёрнутыми: видна только полоска с лейблом и кнопкой `▸`, по клику разворачивается JSON. См. `client/unified/panel.js` (`renderMessages`) и `client/shared/styles.css` (`.bubble.collapsible`, `.bubble-toggle`).
- ✓ **Горизонтальная лента Conversation Starters.** `.starters-row` использует `flex-wrap:nowrap` + `overflow-x:auto`, карточки — компактные пилюли, не перекрывают чат.
- ✓ **Per-preset подсказки в диалоге создания стартера.** Объект `PLACEHOLDERS` в `client/shared/starters-ui.js` хранит примеры name/description/userPrompt/systemPromptAddon отдельно для `timecode | textmontage | markers`. `showDialog(existing, onSave, onCancel, panelId)` принимает `panelId`.
- ✓ **Расширенные шаблоны system-промпта в стартерах.** Диалог 440px, textarea системного промпта `rows=6`, плейсхолдер — многострочный пример с правилами под пресет.
- ✗ **`set_clip_speed` удалён как нереализуемый на PP 2025.** `TrackItem.setSpeed()` отсутствует в Premiere Pro 2024+ ScriptingAPI (есть только `getSpeed()`). Action убран из enum'ов `TOOLS_TIMECODE` / `TOOLS_TEXTMONTAGE`, проверки `hasUnknownShift`, хост-обработчика, валидатора, `AgentPrompts.timecode`, `UiHints.timecode`, README. В промпте агенту сказано отвечать «сделайте вручную: правый клик → Speed/Duration». Тест в `tests/tool-validators.test.mjs` переписан на reject-семантику, 33/33 проходят.
- ✗ **Batch-undo для timecode/textmontage удалён.** Edit→Undo на PP 2025 нестабильно срабатывает на ripple-cuts, откат N≥10 шагов накопленным счётчиком в реальном монтаже не работает. Удалены `undoSteps`/`undoLast` в `host/premiere.jsx`, `client/shared/bridge-premiere.js`, вызовы `setLastUndo` для не-маркерных executor'ов в `client/unified/panel.js`. Кнопка отката теперь скрыта вне пресета `markers`. Упоминание оставлено в подсказках под пресетами и в комментариях.
- ✓ **Откат маркеров остаётся** через `removeMarkersBySeconds` (`markers.deleteMarker`) — единственный undo-механизм, работает стабильно.

---

## 1. Понимание контента

### 1.1. Локальный препроцессинг аудио через ffmpeg ✓
- **Модуль `client/shared/audio-preprocess.js`** (`AudioPreprocess.detectSilences / analyzeLoudness / computeRmsTimeline / analyzeAll`).
- Парсит stderr ffmpeg: `silencedetect=noise=-30dB:d=0.5`, `loudnorm=...:print_format=json`, `astats=metadata=1:reset=...`.
- Интегрировано в `timeline-transcribe.js` — после транскрибации во всех 4 режимах (export_chunks / export_wav / clip_queue / media_file) вызывается `computeAudioPreprocess(path, offset)` и результат прикрепляется к `norm.audioAnalysis = {silences, loudness}` (таймкоды тишин сдвинуты в координаты таймлайна через `offset`).
- Кэшируется вместе с транскриптом в `_llm_transcript_cache.json` (`entry.audioAnalysis`).
- Ошибки ffmpeg не ломают транскрибацию — мягко глотаются, `audioAnalysis: null` или `{error}`.

### 1.3. Структура транскрипта поверх сегментов ✓
- **Модуль `client/shared/transcript-structure.js`** (`TranscriptStructure.buildParagraphs / buildSpeakers / buildTopicsWithLLM / buildStructure`).
- **Параграфы**: группировка Whisper-сегментов по правилам: пауза ≥0.9с, пересечение с silence-интервалом из 1.1, сегмент заканчивается `.!?…`, предел 60с на абзац. Поля: `startSec, endSec, text, segmentIdxs, pauseBeforeSec, pauseAfterSec`.
- **Спикеры**: если Whisper вернул `speaker/speaker_id/speakerLabel` — группировка параграфов по лейблу. Иначе `[]`.
- **Темы/главы**: one-shot LLM (`CloudRuClient.chatCompletions`, 2000 tokens, temp 0.2) с компактным входом (первые 40 слов каждого параграфа) → `topics[{startSec, endSec, title, summary}]`. Считается асинхронно после сохранения параграфов (LED не блокируется).
- Вызывается автоматически из `onTranscribeTimeline()` в `text-montage/panel.js` и `markers/panel.js` после `TimelineTranscribe.runFromPrep()`.
- Инструмент агента `get_transcript_structure(sequenceKey)` — компактный обзор (цитаты 18 слов на параграф, silences/loudness/topics/speakers) в разы легче, чем полный `get_transcript_from_cache`. Промпты textmontage и markers переписаны: сначала structure, только потом full text.

---

## 2. Планирование и безопасность правок

### 2.1. Единый EditPlan (propose / dry_run / apply) ✓
- JSON-контракт: `{ ops: [...], summary: string, rationale?: string }`, kind ∈ `ripple_delete_interval | lift_delete_interval | remove_clip | trim_in | trim_out | trim_bounds | move_clip | set_clip_enabled | shift_ripple | mute_track | note`.
- Инструменты: `propose_edit_plan`, `dry_run_edit_plan`, `apply_edit_plan` (атомарный, один undo-group через один `applyTimecodeEdits` вызов). Карточка `kind=edit_plan` в `renderPendingProposalCard`, handler в `applyPendingProposal`.
- Нормализация/симуляция: `EditPlanSimulator.normalizeUnifiedPlan` + `simulateUnified`; валидация: `ToolValidators.validateEditPlan`. Покрыто юнит-тестами (`tests/edit-plan-simulator.test.mjs`, `tests/tool-validators.test.mjs`).

### 2.2. Diff-view до / после ✓
- `renderDiffSection(card, snapshot, simulation)` строит полосы «было/станет» на основе клиентской симуляции.
- Подключено в карточках: `timecode_edits`, `edit_plan`, `transcript_cuts` (через `EditPlanSimulator.simulateUnified` на `ripple_delete_interval` ops), а также `audio_ducking` (подсветка целевого клипа).

### 2.3. Инструмент `find_moments(query, k)` ✓
- Literal стем-матч поверх сегментов + TF-IDF fallback для семантических запросов без literal-совпадений (`client/shared/find-moments.js`).
- Возвращает `[{startSec, endSec, score, quote, matchType}]`. Покрыт тестами (`tests/find-moments.test.mjs`). Подключён в пресетах `textmontage` и `markers`.

### 2.4. Health-check перед крупной правкой ☐
- Перед каждой тяжёлой операцией агент явно получает от хоста краткое состояние: `{sequenceName, durationSec, clipCount, transcriptSynced, lastEditAt}` и проговаривает в ответе пользователю.

---

## 3. Скорость и эффективность

### 3.1. Детерминированные пайплайны (slash-команды) ✓
- `/cut_fillers`, `/cut_silences`, `/chapterize`, `/jump_cuts`, `/j_cuts`, `/l_cuts` — обход LLM для типовых задач.
- 0-1 вызовов LLM вместо 4-6. Каждая команда — один пайплайн, один undo-group.
- Реализация: `client/shared/deterministic-pipelines.js`, интеграция в `panel.js` через `parsePipelineCommand()`.

### 3.2. Streaming SSE-ответы ✓
- `cloudru-client.js`: `parseSSEStream()` — полный SSE-парсер, агрегация `tool_calls` deltas и текстового контента.
- `chatCompletions` принимает `opts.stream` и `opts.onChunk` для прогрессивного отображения.
- `panel.js` передаёт `stream: true` в настройках агента.

### 3.3. Параллельное выполнение tool_calls ✓
- `agent-loop.js`: `Promise.all` вместо последовательного `for`-цикла для независимых tool_calls.
- Ускорение на шагах, где агент одновременно запрашивает snapshot + transcript + structure.

### 3.4. Кэширование snapshot с dirty-флагом ✓
- `panel.js`: `_snapDirty` flag + CEP event listeners для `SequenceChanged` и `ActiveSequenceChanged`.
- `execGetSnapshot(forceRefresh)` возвращает кэш если не dirty. Сброс перед мутирующими операциями.

### 3.5. Двухмодельная маршрутизация ✓
- `fm-defaults.js`: `fastModel: 'openai/gpt-oss-120b'`.
- `prompts.js`: `classifyComplexity(text)` → 'simple' | 'complex'. Simple → fastModel, complex → основная модель.
- `panel.js`: маршрутизация в `onSend()` на основе классификации.

---

## 4. Надёжность агентного цикла

### 4.1. Защита от зацикливания агента ✓
- `agent-loop.js`: `hashToolCall()` + `detectCycle()` — если последние 3 tool_calls одинаковы → force-stop с сообщением «Обнаружено зацикливание».
- Экспортирован через `_agentLoopInternals` для тестирования.

### 4.2. JSON-ремонт для повреждённых tool args ✓
- `agent-loop.js`: `repairJson()` — trailing commas, single quotes → double, unquoted keys, обрезанные строки.
- `safeParseArgs()` — `JSON.parse` → fallback `repairJson`. Покрыто тестами.

### 4.3. Retry с экспоненциальным backoff ✓
- `cloudru-client.js`: `fetchWithRetry()` — 3 попытки, задержки 1с/2с/4с. Только для 5xx/429, не для 4xx.
- Используется в `chatCompletions` и `transcribeAudio`.

### 4.4. Structured output / JSON mode ☐
- Использовать `response_format: { type: "json_object" }` там, где Cloud.ru FM это поддерживает.
- Гарантированный валидный JSON для `propose_edit_plan`, `analyze_transcript_for_cuts` и других структурных ответов.

---

## 5. Покрытие каналов монтажа (новые возможности)

### 5.1. Титры и субтитры ☐
- `add_captions({style, position, fontSize, mogrt?})` — автогенерация субтитров из Whisper-сегментов через MOGRT-шаблон.
- Нижние трети с именами спикеров по `speakers[]`.

### 5.2. Цвет — LUT через Lumetri ☐
- `apply_lut(nodeId|all, lutPath)` — применение LUT к клипам через Lumetri Color (ExtendScript).
- Пресет «ночные кадры холоднее», «контраст + saturation» — предзаготовленные цепочки.

### 5.3. Аудио ◧
- **Ducking**: offline-ffmpeg рендер (`volume filter` с `between()`) через `audio-ducking.js` + `audio-render.js`. Карточка `audio_ducking` с корректным описанием («ffmpeg рендер + импорт в bin AI Renders») и diff-полосой целевого клипа. Код стабилен по логике, но не верифицирован на реальных многочасовых проектах — оставлен в пайплайне без гарантий.
- **LUFS-нормализация речи**: двухпроходный `loudnorm` через `audio-render.js`, карточка `loudness` с честным текстом. Тот же статус: работает, не фиксируется как production-proof.
- **Слова-паразиты**: one-click preset, уже почти реализован через `apply_transcript_cuts`; доделать до готового пайплайна.

### 5.4. Экспорт ☐
- Пресеты YouTube / Reels / TikTok / Shorts.
- Авто-crop 16:9 → 9:16 по центру кадра (движение / лицо) — ffmpeg facedetect или простой центр-кроп.
- Экспорт глав YouTube из маркеров `type=chapter` (частично есть).

### 5.5. J-cut / L-cut автоматизация ⛔ ОТКЛЮЧЕНО
- Slash-команды `/j_cuts` и `/l_cuts` — **временно отключены**.
- **Причина**: связанные клипы (V1+A1) в Premiere обрезаются вместе (видео+аудио).
  J/L-cuts требуют клипы на отдельных дорожках (V1/A1 + V2/A2) с перекрытием,
  либо программное отвязывание (unlink). ExtendScript API не поддерживает `unlink()`.
- UI: карточка отключена (`opacity:0.5; pointer-events:none`), текст объясняет ограничение.
- **Перспектива**: реализовать когда Adobe добавит `unlink()` в UXP/ExtendScript.

### 5.6. B-roll маркеры-подсказки ☐
- Анализ транскрипта для поиска естественных пауз в A-roll (говорящий), где уместна вставка B-roll.
- Размещение маркеров вида «B-ROLL: городские кадры», «B-ROLL: крупный план продукта» в подходящих точках.
- Помогает монтажёру, но не вставляет B-roll автоматически.

### 5.7. One-click пресеты из Starters ☐
- Конвертация Conversation Starters в детерминированные пайплайны: кнопка → pipeline → результат, без чата.
- Для типовых задач (вырезать паразиты, расставить главы, нормализовать звук) — мгновенное выполнение.

---

## 6. UX панели

### 6.1. Drag-and-drop клипа из таймлайна в чат ☐
- Пользователь перетаскивает клип из PP → в поле ввода вставляется `@clip:nodeId Имя (MM:SS–MM:SS)`.
- Снимает класс ошибок «агент не понял, о каком клипе речь».

### 6.2. Авто-аннотации проблемных мест ☐
- В режиме markers агент сам ставит маркеры на: заикания (по Whisper confidence), длинные паузы (>1.5с, из silencedetect), клиппинг звука (из loudnorm), чёрные кадры (ffmpeg blackdetect).

### 6.3. Память чата per-project + per-sequence ☐
- Ключ в `ContextStore` = `projectPath + sequenceName` (сейчас только panelId).
- Переключился на другой проект — увидел другую историю.

### 6.4. Пресеты стиля монтажа ☐
- Сохранение «стиля»: `{fillerThreshold, pauseMax, lowerThirdColor, chapterInterval, ...}` → применяется одним кликом к новому ролику.
- Хранение в `~/.extensions_llm_chat_pr/styles.json`.

---

## 7. Обучение от пользователя

### 7.1. RLHF-lite из принятых/отклонённых планов ☐
- Каждый `propose_edit_plan` → `apply` или `cancel`; фиксируем пару в `~/.extensions_llm_chat_pr/feedback.jsonl`.
- Периодически: LLM one-shot «обобщи стиль по последним 20 решениям» → записывается в `user_style` и добавляется к системному промпту.

### 7.2. Мини-словарь проекта ☐
- `projectDictionary.json` рядом с проектом: имена спикеров, правильные термины, запрещённые слова.
- Используется для коррекции Whisper-выхода (постпроцесс) и как контекст для LLM.

---

## 8. Инфраструктура

### 8.1. Rolling host-лог ☐
- `~/.extensions_llm_chat_pr/host.log` — последние 500 операций хоста: action, args, result, time, hostVersion.
- Ротация: 5 файлов по 1 МБ.

### 8.2. ExtendScript integration тесты ☐
- `tests/host-integration/`: сценарии «создай секвенцию → правка → снимок → проверка инварианта».
- Запуск через CEP-панель в режиме self-test.

### 8.3. Метрики качества сессии ☐
- Для каждого запроса: `stepsUsed / maxSteps`, `planAccepted`, `toolErrors`, `driftWarnings`, `retries`.
- Показывать в статус-баре панели.

### 8.4. UXP-прослойка для починки move_clip и span-маркеров ☐
- PP 2024+ поддерживает UXP plugins для части API; в UXP `Marker.duration` и `TrackItem.move` работают надёжнее (по docsforadobe).
- Прослойка: CEP-панель отправляет операции в UXP-плагин через файловый брокер или HTTP localhost.
- Это план-B для known-broken (см. секцию ниже).

---

## ⚠ Известные нерабочие функции

См. `docs/premiere-extension-audit.md` — секция «Известные нерабочие функции»:
- ⚠ `move_clip` — API PP 2025 не даёт переносить клип с линковкой. Чинится в рамках 8.4 (UXP-прослойка).
- ⚠ Span-маркеры — `mk.end` привязан к `mk.start`, не поддаётся программной модификации. Чинится в рамках 8.4.
- ✗ `set_clip_speed` — удалено (см. журнал 2026-04-08). `TrackItem.setSpeed()` не существует в API PP 2024+, программно скорость не меняется. Альтернатива — вручную через Speed/Duration.
- ✗ Batch-undo для timecode/textmontage — удалено (см. журнал 2026-04-08). Накопленный счётчик откатов не работает на ripple-cuts. Используем системный Cmd+Z / Ctrl+Z в фокусе таймлайна Premiere. Откат маркеров остаётся (через `removeMarkersBySeconds`).

---

## ✗ Явно исключено

Следующие фичи сознательно не включены в текущий скоуп:

- ✗ **Zoom / Punch-in на акцентах** — deferred, не в текущем скоупе.
- ✗ **Локальный LLM fallback (llama.cpp / ollama)** — deferred, не в текущем скоупе. Простые задачи закрываются детерминированными пайплайнами (§3.1) и двухмодельной маршрутизацией (§3.5).
- ✗ **Визуальный анализ ключевых кадров** — требует vision-модели, не приоритет.
- ✗ **Голосовой ввод** — не приоритет для профессионального монтажа.
- ✗ **Vision-LLM** — нет подходящей инфраструктуры на Cloud.ru FM.
- ✗ **Авто-подбор B-roll из медиатеки** — слишком сложная задача без vision; вместо этого — B-roll маркеры-подсказки (§5.6).
- ✗ **`set_clip_speed`** — удалён, API недоступно в PP 2024+ (см. журнал).
- ✗ **Batch-undo для timecode/textmontage** — удалён, нестабилен (см. журнал).

---

## Приоритеты реализации

Отсортировано по соотношению «польза для пользователя / стоимость реализации».

### P0 — Ближайший спринт (Speed & Reliability) ✓ DONE
1. ✓ **§3.1 Детерминированные пайплайны** — `/cut_fillers`, `/cut_silences`, `/chapterize`, `/jump_cuts`, `/j_cuts`, `/l_cuts`.
2. ✓ **§4.1 Защита от зацикливания** — хэш последних 3 tool_calls, force-stop.
3. ✓ **§4.3 Retry с backoff** — 3 повтора для 5xx/429, exponential backoff.
4. ✓ **§4.2 JSON-ремонт** — `repairJson()` + `safeParseArgs()`.

### P1 — Следующий спринт ✓ DONE
5. ✓ **§3.2 Streaming SSE** — `parseSSEStream()`, прогрессивное отображение.
6. ✓ **§3.3 Параллельные tool_calls** — `Promise.all` в agent-loop.
7. ✓ **§3.4 Snapshot caching** — dirty-flag + CEP events.
8. ☐ **§5.7 One-click пресеты из Starters** — кнопка → результат без чата.

### P2 — Средний горизонт
9. **§6.3 Память per-project** — правильное ключевание `ContextStore`.
10. ⛔ **§5.5 J-cut / L-cut** — отключено (ExtendScript не поддерживает unlink).
11. **§5.6 B-roll маркеры** — анализ + маркеры-подсказки.
12. ✓ **§3.5 Двухмодельная маршрутизация** — `classifyComplexity()` + `fastModel`.
13. **§2.4 Health-check** — состояние таймлайна перед правкой.
14. **§6.1 Drag-and-drop клипа** — `@clip:nodeId` в поле ввода.

### P3 — Дальний горизонт
15. **§4.4 Structured output / JSON mode** — `response_format` где поддерживается.
16. **§8.4 UXP-прослойка** — починка `move_clip` и span-маркеров.
17. **§8.2 ExtendScript integration тесты** — self-test через CEP.
18. **§5.1 Титры и субтитры** через MOGRT — отдельная итерация.
19. **§5.2 Цвет / LUT** через Lumetri.
20. **§5.4 Экспорт** — пресеты YouTube / Reels / Shorts.
21. **§6.2 Авто-аннотации** — маркеры на проблемные места.
22. **§6.4 Пресеты стиля монтажа** — сохранение/применение стилей.
23. **§7.1 RLHF-lite** — обучение на accept/reject.
24. **§7.2 Словарь проекта** — коррекция Whisper + контекст LLM.
25. **§8.1 Rolling host-лог** — ротация логов хоста.
26. **§8.3 Метрики качества** — статистика сессий.
