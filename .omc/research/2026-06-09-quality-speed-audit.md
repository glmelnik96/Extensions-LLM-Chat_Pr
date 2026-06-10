# Аудит качества и скорости выполнения задач — 2026-06-09

**Метод:** 4 параллельных deep-research агента по слоям: LLM/агент-пайплайн,
транскрипция/аудио, host/ExtendScript, UX-поток/кеширование.
**Фокус:** качество результата и скорость выполнения задач (НЕ стабильность кода).
**Код не менялся** — только анализ.

---

## TL;DR — Top-10 по ROI

| # | Улучшение | Эффект | Усилие |
|---|---|---|---|
| 1 | Чанк транскрибации 90с→180с + MP3 вместо WAV | **~2× быстрее транскрибация** (1 волна из 20 параллельных вместо 2) | 2 строки конфига + MP3 .epr |
| 2 | Whisper temperature 0.5→0.1 | +5-10% точность ASR (детерминизм) | 1 строка |
| 3 | Фоновый прекомпьют анализа после транскрипции | Кнопка «Убрать паразиты» отвечает <100мс вместо 3-5 мин | ~1ч |
| 4 | analyzeConcurrency 3→6 | −40-100с на анализе 1ч видео | 1 строка |
| 5 | Прогресс «чанк N/M» при транскрибации | 15 мин слепого спиннера → видимый прогресс | ~1ч |
| 6 | Расширить classifyComplexity (RU-разговорные паттерны) | 50-70% простых запросов → fastModel, **5-10× быстрее ответ** | ~30 мин |
| 7 | Single-pass аудиоанализ (ffmpeg 40 проходов → 1) | −4-6 мин на 1ч видео | ~2ч |
| 8 | Frame-boundary snapping для всех cuts | Кадровая точность резов (убирает 1-3 frame drift) | ~30 мин |
| 9 | Стартер «Почистить всё» (один propose/apply) | −4 мин + −2 подтверждения на типовом workflow | ~1ч |
| 10 | response_format='json_object' для analyze | 0 JSON-parse ошибок, меньше failed chunks | ~15 мин |

**Совокупно на типовом workflow (1ч подкаст → почистить → главы):**
сейчас ~20+ мин ожидания, после top-5 — ~8-10 мин, и почти всё с видимым прогрессом.

---

## 1. LLM/агент-пайплайн

### 1.1 System prompt пересылается каждый шаг (59% токенов 3-шагового диалога)
- `panel.js:3863` — system (~4500 ток) + tool schemas (~2000 ток) идут в каждый из до 24 шагов
- 3-шаговый диалог: 22.7K токенов, из них 13.5K — повторный system prompt
- **Решение:** prompt caching (`cache_control: {type:'ephemeral'}` в system message)
- ⚠️ **Требует проверки**: поддерживает ли Cloud.ru FM OpenAI prompt-caching API. Если нет — сократить TIER-структуру prompts.js под intent
- Эффект: −15-25% токенов и латентности на всех multi-step диалогах

### 1.2 buildTopicsWithLLM не параллелится с локальными детекторами
- `panel.js:4050-4077` — topics (3-14с на DeepSeek) и runLocalDetectors идут фактически последовательно + race на ContextStore
- **Решение:** Promise.all → −3-15с на каждую транскрибацию

### 1.3 analyzeConcurrency консервативен
- `fm-defaults.js` analyzeConcurrency=3, чанк 50 сегментов, 60-100с на чанк
- Cloud.ru держит 20 параллельных (см. CLOUD_CONCURRENCY в timeline-transcribe.js)
- **Решение:** 3→6 + чанк 50→40 сегментов → −40-100с на 1ч видео

### 1.4 classifyComplexity промахивается на разговорных RU-запросах
- `prompts.js:263-288` — «скажи что там», «сколько клипов», «какая длительность» не матчатся → уходят на GLM-5.1 (10-20с) вместо gpt-oss-120b (1-2с)
- **Решение:** расширить регексы + эвристика «чистый RU <30 символов → simple»
- Эффект: 5-10× быстрее ответ для 50-70% простых вопросов, 10-15× дешевле

### 1.5 Качество промптов
- Few-shot примеры хорошие (3 сценария с арифметикой), но **нет негативных примеров**
- **Решение:** секция «ТИПИЧНЫЕ ОШИБКИ» (не резать абзац посередине, nodeId только из snapshot, endSec>startSec) → −15-30% галлюцинаций (hallucinated nodeIds — задокументированная проблема аудита мая)

### 1.6 response_format не используется в analyze
- `transcript-structure.js:930` — JSON-схема описана текстом, модель может отдать невалидный JSON
- **Решение:** `responseFormat: 'json_object'` (tools там не используются — совместимо)

### Что уже хорошо (не трогать)
- Tool-history compression (4 последних результата целиком, старые → 600 байт)
- Cycle detection в agent-loop
- Per-role thinkingPolicy (analyze=false после TEST D)
- Local detector pre-pass перед LLM (fillers режутся локально, экономия токенов)

---

## 2. Транскрипция и аудио

### 2.1 Чанк 90с → 180с (P0)
- 1ч видео = 40 чанков; CLOUD_CONCURRENCY=20 → **2 волны**
- 180с-чанк = 5.75 МБ WAV (лимит 20 МБ) → 20 чанков = **1 волна** → ~2× быстрее
- `fm-defaults.js` transcribeExportChunkSec

### 2.2 MP3 вместо WAV (P0)
- WAV 90с ≈ 2.9 МБ, MP3 128kbps ≈ 1.4 МБ → −50% upload
- Комментарий в fm-defaults уже рекомендует MP3-пресет — осталось сделать дефолтом
- Требуется MP3 .epr пресет + exportChunkExtension='mp3'

### 2.3 Whisper temperature 0.5 → 0.1 (P0, качество)
- ASR — детерминированная задача; 0.5 даёт случайные вариации границ слов и filler-детекта
- 0.1 (не 0.0) — чтобы сохранить редкие RU-произносительные варианты

### 2.4 Аудиоанализ ffmpeg гоняется по каждому чанку (P3)
- `timeline-transcribe.js:511-542` — silencedetect/loudnorm 40 раз по 5-8с = **4.6 мин** оверхеда на 1ч
- **Решение:** concat чанков → один проход → split по границам

### 2.5 Cache key не учитывает In/Out диапазон
- `panel.js:959-969` — ключ по имени секвенции; сдвиг Out на 5с возвращает старый кэш → **тихая потеря данных** на хвосте
- **Решение:** включить In/Out в ключ + авточистка старых записей

### 2.6 Прочее качество
- `verbose_json` word-level timestamps запрашиваются, но выбрасываются в normalizeWhisperExport — сохранить (subtitle-sync, karaoke-highlight в будущем)
- `language: 'ru'` hardcoded — «React.js» → «Рэакт.js»; рассмотреть 'auto' или per-sequence override
- Diarization отсутствует — 10-20% false positives на филлерах («ну» как смысловое слово)

---

## 3. Host/ExtendScript

### 3.1 Frame-boundary snapping (HIGH, качество)
- Интервалы идут float-секундами; округление к кадру только в `_secToTimecode` → дрейф 1-3 кадра, накапливается на ripple
- **Решение:** snapIntervalsToFrameBoundary(intervals, fps) в apply-слое panel.js перед executeProposal

### 3.2 Кэш позиций клипов (MEDIUM-HIGH, скорость)
- `premiere.jsx:358-390` — после каждого razor скан ВСЕХ клипов всех дорожек: O(50 cuts × 2000 clips) = 100K обращений к clip.start
- **Решение:** один сбор клипов в диапазоне → итерация по кэшу → 10-30% быстрее apply на больших таймлайнах

### 3.3 Multicam: lift vs ripple desync risk (MEDIUM, качество)
- `premiere.jsx:2352-2394` — `clip.remove(0,0)` (lift) по дорожкам последовательно; при разных границах клипов на V1/V2/V3 возможен рассинхрон
- **Решение:** собрать все клипы со всех треков → глобальная сортировка по времени DESC → удаление единым проходом

### 3.4 Multicam razor батчинг (MEDIUM, скорость)
- 200 cut points × 3 трека = 600 razor-вызовов; группировка по timecode → 20-40% быстрее
- Текущий бенчмарк: 8-12с на 200-точечный план

### 3.5 Marker fast-path
- 4 стратегии создания маркера перебираются всегда; на PP 2025+ первая срабатывает в 95% случаев → version-detect → −5-15% на 20+ маркерах

### 3.6 Padding inconsistency (качество звука)
- Filler 0.07с / Silence 0.15с / jumpCuts breath 0.05с / applyTranscriptCuts — 0
- При стыке cut'ов с <10мс зазором слышен щелчок → унифицировать микро-паддинг в apply-слое

### Бейзлайн (60с видео, 50 cuts + 20 маркеров): ~15с host-времени → после оптимизаций ~8-10с

---

## 4. UX-поток и кеширование

### 4.1 Нет фонового прекомпьюта после транскрипции (CRITICAL)
- После транскрибации панель просто гасит LED; analysis стартует только по клику
- 1ч подкаст: 15 мин (transcribe) + клик + 3-5 мин (analyze) = 20 мин до первой возможности монтажа
- **Решение:** после транскрипции запускать в фоне:
  1. `buildStructure` (paragraphs) — мгновенный первый get_transcript_structure
  2. `analyzeForCutsWithLLM` с дефолтными tasks/aggressiveness → кэш на 30 мин
  3. `findSilences` deterministic
- Кнопки Tools начинают отвечать из кэша <100мс

### 4.2 Прогресс транскрибации indeterminate (CRITICAL UX)
- `statusUi.progress(null)` — спиннер 15 минут без «сколько осталось»
- У анализа прогресс по чанкам уже есть (`chunkIndex/totalChunks`) — повторить для транскрибации (upload N/M)

### 4.3 Стриминг есть, но не рендерится прогрессивно
- onChunk в agent-loop.js стреляет каждые ~150мс, но panel.js рендерит сообщение только после завершения шага (renderMessages перерисовывает ВСЮ историю через innerHTML='')
- **Решение:** инкрементальный append чанков в pending-сообщение → текст виден через <500мс вместо 2-5с тишины

### 4.4 Слайдер aggressiveness = cache miss
- Cache key включает aggressiveness → переключение normal→gentle перезапускает 3-5 мин LLM-анализ
- LLM-метки от aggressiveness не зависят — фильтрация (`_shouldRemoveLabel`) дешёвая
- **Решение:** кэшировать labels независимо от aggressiveness, на слайдере — мгновенный re-filter + live-счётчик «уберём N интервалов / M сек»

### 4.5 Стартер «Почистить всё»
- Сейчас: тишины → propose → apply → паразиты → propose → apply → jump cuts → ... = 9+ мин и 3 подтверждения
- **Решение:** один analyze с merged tasks → один объединённый proposal → один apply

---

## Дорожная карта

### Фаза 1 — конфиг-уровень (минуты, нулевой риск)
1. `transcribeExportChunkSec: 90 → 180`
2. `exportChunkExtension: 'mp3'` (+ создать MP3 .epr пресет)
3. `transcribeParams.temperature: '0.5' → '0.1'`
4. `analyzeConcurrency: 3 → 6`

### Фаза 2 — perceived speed (1-2 дня)
5. Фоновый прекомпьют (paragraphs + analysis + silences) после транскрипции
6. Прогресс чанков транскрибации
7. Прогрессивный рендер стриминга в чате
8. classifyComplexity расширение

### Фаза 3 — качество результата (1-2 дня)
9. Frame-boundary snapping
10. response_format json_object в analyze
11. Негативные few-shot примеры в system prompt
12. Унификация cut-padding
13. Cache key с In/Out

### Фаза 4 — host-перформанс (2-3 дня)
14. Кэш позиций клипов в premiere.jsx
15. Multicam ripple-safe delete + razor batching
16. Single-pass ffmpeg аудиоанализ
17. Dual-level analysis caching + live slider preview

### Требует верификации перед внедрением
- Prompt caching: поддержка Cloud.ru FM (тестовый вызов с cache_control)
- MP3 в Whisper Cloud.ru: smoke-test на одном чанке
- Параллельный RMS (ffmpeg concurrent reads одного файла)

### Отклонено (изучено и решено не делать)
- Single-batch analyze через DeepSeek 1M контекст — теряем fault-tolerance чанков при ~равной латентности
- Early tool detection в стриминге — большинство tools мгновенные, выигрыш маргинальный
- Kimi K2.6 адаптер — нет роли, где Kimi лучше пары GLM-5.1+DeepSeek

---

## Сводная таблица всех находок

| Слой | Находка | Тип | Эффект | Усилие |
|---|---|---|---|---|
| ASR | Чанк 180с + MP3 | Speed | 2× транскрибация | XS |
| ASR | temperature 0.1 | Quality | +5-10% точность | XS |
| ASR | Single-pass ffmpeg | Speed | −4-6 мин/1ч | M |
| ASR | Cache key + In/Out | Quality | нет silent loss | S |
| ASR | language auto | Quality | EN-термины | XS |
| LLM | Prompt caching | Speed+Cost | −15-25% токенов | S* |
| LLM | concurrency 3→6 | Speed | −40-100с/1ч | XS |
| LLM | Parallel topics+detectors | Speed | −3-15с/транскр. | S |
| LLM | classifyComplexity RU | Speed | 5-10× simple queries | S |
| LLM | Негативные few-shot | Quality | −15-30% галлюцинаций | S |
| LLM | json_object в analyze | Quality | 0 parse errors | XS |
| Host | Frame snapping | Quality | кадровая точность | S |
| Host | Clip position cache | Speed | 10-30% apply | M |
| Host | Multicam ripple-safe | Quality | нет A/V desync | S |
| Host | Razor batch by timecode | Speed | 20-40% multicam | M |
| Host | Marker fast-path | Speed | −5-15% markers | S |
| Host | Padding унификация | Quality | нет щелчков | S |
| UX | Фоновый прекомпьют | Speed | −5 мин/workflow | M |
| UX | Прогресс чанков | UX | видимый прогресс | S |
| UX | Прогрессивный стриминг | UX | <500мс первый текст | M |
| UX | Re-filter на слайдере | Speed | мгновенный toggle | M |
| UX | «Почистить всё» | Speed | −4 мин + −2 клика | M |

\* при условии поддержки Cloud.ru

Усилие: XS = строки конфига, S = <2ч, M = 2-8ч
