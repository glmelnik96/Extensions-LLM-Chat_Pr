# Аудит нашего плагина — неоттестированные риски (2026-07-10)

> Сгенерирован агентом-исследователем (Explore) по всему коду. **Номера строк
> приблизительные** — агент читал крупными кусками; перед правкой каждого пункта
> ОБЯЗАТЕЛЬНО грепнуть и подтвердить факт в текущем коде. Спот-проверено вручную
> отмечено ✅; неподтверждённое — ⚠️ VERIFY.
>
> Размеры файлов на момент аудита: host/premiere.jsx 3048, panel.js 6920,
> cloudru-client.js 460, tool-validators.js 352.

## Легенда приоритетов
- **P0** — может испортить таймлайн/данные пользователя.
- **P1** — сломает фичу/выдаст неверный результат.
- **P2** — UX/косметика.

---

## 1. HOST (host/premiere.jsx)

### P0
- **trackIndex без bounds-check** ⚠️ VERIFY (~274/452/855/883): `videoTracks[i]`/`audioTracks[i]`
  без проверки `i < numTracks`, когда `i` из пользовательски-редактируемого JSON. → undefined/тихий сбой.
- **Смешение ticks/seconds в маркерах** ⚠️ VERIFY (~1860–1883): 4 стратегии createMarker (число тиков /
  строка тиков). На видео >1ч и десятках маркеров — накопительный дрейф ±секунды. Есть коррекция
  drift<0.25с, но база EPS 0.04с копится.
- **Пересекающиеся removeIntervals** ⚠️ VERIFY (~500–650): при интервалах [0,10],[5,15],[12,20] razor режет
  по уже дрейфнувшему таймлайну → удаляются не те сегменты. Root-cause совпадает с P1 в валидаторах.
- **`_findClipByNodeId` на пустой секвенции** ⚠️ VERIFY (~237–271): 0 дорожек → null даже при валидном
  nodeId; null не обработан выше в remove_clip/trim.

### P1
- **`exportAsMediaDirect` + кириллический путь** ⚠️ VERIFY (~2220): файл создан, но `_fileExists`
  на ANSI-кодировке вернёт false → ложная ошибка «export failed» → дубликаты/частичный откат.
  (⚠ Пересечение с известной памятью: PP2026 export вообще нестабилен — см. env-память.)
- **Пустой try/catch в deleteMarker при retry** ⚠️ VERIFY (~1848): `_opCounter` рассинхронизируется
  с реальностью → undo выполняет неверное число шагов.
- **Отрицательный `fromSec` в shift_timeline_ripple** ⚠️ VERIFY (~1220): host-гард есть, но JS-валидатор
  для встроенных стартеров может пропустить.

### P2
- **Undo-group открыт до preflight** ⚠️ VERIFY (~1109): при locked-дорожках `beginUndoGroup` без
  `endUndoGroup` → пустой undo-шаг в PP.
- **NaN при tick→sec** ⚠️ VERIFY (~203): `parseFloat(timebase)` без явного isNaN перед fallback (хрупко).

## 2. cloudru-client.js (460 строк)

### P0
- **SSE reader может зависнуть при abort во время read()** ⚠️ VERIFY (~189–277): гонка
  `reader.cancel()` vs `releaseLock()`. У нас ЕСТЬ AbortController + abortableSleep (✅ подтверждено
  на строках 28–79), но abort именно внутри `reader.read()` — под вопросом.
- **Retry при 413 не усекает body** ⚠️ VERIFY: exponential backoff × большое body → память.
- **429 без чтения `Retry-After`** ✅ **ПОДТВЕРЖДЕНО**: `isRetryable` (стр. 47) = `status>=500 || status===429`,
  заголовок `Retry-After` НЕ читается (грепом не найден). Backoff 1/2/4с может быть короче лимита →
  повторные 429. **Реальный, дешёвый к фиксу.**

### P1
- **413 в HTML-теле (не JSON)** ⚠️ VERIFY (~387): `isPayloadTooLarge` до `parseJsonResponse` — если тело
  HTML, парсер падает позже с неверной диагностикой.

## 3. timeline-transcribe.js + ffmpeg

### P0
- **Whisper 25MB не учитывает VFR/speed-эффекты** ⚠️ VERIFY (~558–627): fileSize по байтам, но при
  reverse/×2 реальная длительность больше → Whisper 413.
- **Нет cleanup temp-файлов при abort** ⚠️ VERIFY (~550–606): «Стоп» во время ffmpeg → мусор в %TEMP%
  копится → «No space left».
- **Пустые Whisper-segments не валидируются** ⚠️ VERIFY (~49–69): тишина/шум → `{segments:[],text:""}`
  уходит дальше → LLM галлюцинирует, токены впустую.

### P1
- **Offset чанков считается от clipStart, а не clipInPoint** ⚠️ VERIFY (~667–695): при inPoint>0 и
  мульти-чанках сегменты чанков 2+ сдвинуты на inPoint. (⚠ Мы недавно чинили мульти-nest offset —
  проверить, не тот ли это случай.)

## 4. panel.js (6920 строк)

### P0
- **Гонка смены секвенции между proposal и apply** ⚠️ VERIFY (~2387): окно ~100мс между
  `assertSequenceMatch` и apply; двойной клик Apply над устаревшим proposal.
- **`_pendingProposal` гонка при двух ответах подряд** ⚠️ VERIFY (~5019): новый ответ обнуляет
  proposal, onApply получает null.
- **Утечка `_transcriptCheckpoints` при отмене** ⚠️ VERIFY (~2782): снимок транскрипта в памяти не
  чистится при cancel/смене секвенции → рост памяти за много proposal'ов.

### P1
- **`renderTimelineStrip` без batch на >1000 клипов** ⚠️ VERIFY (~1560): 1000+ reflow → фриз 2-3с.
- **OperationQueue.tryBegin=false игнорируется в части путей** ⚠️ VERIFY (~52): застрявшая операция →
  onSend ждёт вечно, нужен hard-refresh.

### P2
- **localStorage бросает в private mode** ⚠️ VERIFY (~4413): категория «не запомнилась» тихо.

## 5. tool-validators.js (352 строки)

### P1
- **`validateTranscriptCuts` не ловит пересечения** ⚠️ VERIFY (~144): корень P0-пересечений в host.
- **Нет валидатора для `apply_edit_plan`** ⚠️ VERIFY: story-cutter план не проверяется (пустой/циклы).
- **Нет `isNaN`/bounds для `timeSec` маркеров** ⚠️ VERIFY: NaN/999999999 проходит → host createMarker падает.

## 6. Тесты — пробелы
- Пустые секвенции (0 дорожек/клипов) — не покрыто.
- Пересекающиеся removeIntervals — не покрыто (`scenarios-validation.test.mjs:250` только валидные).
- Abort во время SSE-read — не покрыто.
- Cleanup temp при abort — не покрыто.
- localStorage недоступен — не покрыто.
- Смена секвенции между proposal/apply — не покрыто.
- **Известный падающий тест:** `scenarios-validation.test.mjs:250` (долг из прошлых сессий) — причину
  подтвердить отдельно.

## 7. Состояние/персистентность
- **P1: ключ транскрипт-кэша = имя секвенции** ⚠️ VERIFY (~panel.js 5422): при переименовании/бэкапах/
  одинаковых именах в разных проектах — коллизия/устаревание. (⚠ Совпадает с нашей болью «бэкап-секвенции
  в проекте», см. память live-валидации.)
- **P1: localStorage 5–10MB не контролируется** ⚠️ VERIFY (agent-loop): длинный чат → тихий сброс save.

---

## Сводка
| Приоритет | Кол-во (заявлено агентом) |
|---|---|
| P0 | 11 |
| P1 | 14 |
| P2 | 5 |

**Подтверждено вручную на 2026-07-10:** 429-без-Retry-After (cloudru-client.js:47); наличие
AbortController/abortableSleep (28–79). Остальное — VERIFY перед работой.

---

## Верификация и статус фиксов (2026-07-10, Волна 1 п.1–4)
- ✅ **ИСПРАВЛЕНО: 429 Retry-After** — parseRetryAfterMs (секунды/HTTP-date, cap 60с), wait = max(backoff, header); 7 тестов.
- ✅ **ИСПРАВЛЕНО: пересечения removeIntervals в host** — applyTranscriptCuts отклоняет ВЕСЬ план ДО beginUndoGroup (EPS 0.01, встык ок); live-подтверждено на секвенции «6».
- 🆕 **НОВЫЙ P0 (live-обнаружен, ИСПРАВЛЕН): 24ч-wrap таймкода** — время за концом секвенции QE-razor заворачивает по модулю 24ч (99990с → 3:46:30 = 13590с) и режет РЕАЛЬНЫЙ контент. Воспроизведено live (9→18 клипов, откачено undo). Фикс: `_seqEndSec(seq)` (max от seq.end и концов клипов) + reject `startSec >= end` / `endSec > end+120` в applyTranscriptCuts И applyTimecodeEdits (ripple/lift).
- ✅ **ИСПРАВЛЕНО: NaN в интервалах host** — isNaN-гарды в applyTranscriptCuts + ripple/lift веток applyTimecodeEdits (NaN проходил typeof и все сравнения).
- ✅ **ИСПРАВЛЕНО: пустые Whisper-segments** — assertNonEmptyTranscript, единая точка для всех режимов runFromPrep; analysisOnly не трогаем; 5 тестов.
- ✅ **ИСПРАВЛЕНО: negative timeSec маркеров в host** — reject в failed[] (NaN-гард уже был на 1954).
- ❌ **STALE (уже было исправлено до аудита):** validateTranscriptCuts ловит NaN/negative/дубликаты/пересечения (P1-F, май 2026); validateMarkersList ловит NaN+bounds; mute_track trackIndex безопасен (`!targetTrack` ловит любой мусор); внутренние trackIndex-циклы (846–875, 883) — не из пользовательского JSON.
- ⚠️ Осталось из Волны 1: cleanup temp при abort (п.4), гонки proposal (п.5), утечка чекпоинтов (п.6), тесты §6.
- Host bump: 2.6.7 → 2.6.8. Node-тесты: 600/600.

## Верификация и статус фиксов (2026-07-10, Волна 1 п.4–6)
- ✅ **ИСПРАВЛЕНО: cleanup temp при abort/ошибке** (timeline-transcribe.js) — 4 подтверждённые утечки:
  (A) `extractAudioChunksWithFfmpeg`: частичные `_llm_chunk_*` при падении пула — catch-очистка
  created + in-flight ffmpeg-колбэки самоудаляют выход после reject (у promisePool задачи доезжают
  ПОСЛЕ reject); партиалы чанков unlink'аются и в err-ветках; (B) clip_queue: unlink
  `allChunksForAnalysis` был вне finally → abort в backendTranscribe терял все чанки — теперь finally;
  (C) nest_reconstruct: `nChunks` не удалялись ВООБЩЕ (даже на успехе) — добавлен в finally;
  (D) media_file: `ffmpegTmpM` удалялся только на успехе хвоста — единый внешний finally;
  + партиал `_llm_nestmix_*` при ffmpeg-err. 4 новых теста (фейковый require: fs/execFile),
  экспортирован extractAudioChunksWithFfmpeg, loader принимает opts.require.
- ✅ **ИСПРАВЛЕНО: гонки proposal (~2387, ~5019)** — (1) click-time capture: `propAtClick`/`toolsPropAtClick`
  фиксируются на клике, в колбэке assertSequenceMatch проверка идентичности — замещённый новым ответом
  план больше не применится «вслепую»; (2) остаточное окно ~100мс между JS-проверкой и host-apply
  закрыто host-side: `expectedSequenceName` в payload applyTranscriptCuts/applyTimecodeEdits, host
  сверяет seq.name ДО мутаций (last line of defense). Live-проверено CDP: mismatch → reject без
  мутации (оба метода), match → гейт прозрачен (план дошёл до overlap-валидатора). Прим.: канонический
  «~5019» из аудита (onSend обнуляет proposal) был НЕ багом — осознанный фикс 19.06; реальная гонка
  была в окне assertSequenceMatch. J-cuts покрыт только JS-слоем (host-гейт не добавлялся).
- ✅ **ИСПРАВЛЕНО: утечка `_transcriptCheckpoints` (~2782)** — deep-copy транскриптов копились всю
  сессию: удаление было ТОЛЬКО при клике «⏪ Откатить» ровно того backupId. Теперь чекпоинт,
  замещаемый setLastUndo той же панели, удаляется сразу + страховочный кэп 8 снимков с вытеснением
  старейшего (_ts). Деградация мягкая: без чекпоинта откат секвенции работает, не восстанавливается
  только транскрипт-кэш (поведение до 19.06).
- Host bump: 2.6.8 → 2.6.9. Node-тесты: 604/604. Панель перезагружена, модули живы.
- ⚠️ Осталось из Волны 1: п.8 — тесты по §6 (пустая секвенция, abort-SSE, смена секвенции e2e).
