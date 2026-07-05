# Монтаж по смыслам v2 — архитектурная переработка (дизайн)

Дата: 2026-07-06. Статус: утверждён пользователем (вариант A + встроенное усиление из C).
Предшественник: `2026-07-05-montage-plan-design.md` (v1, оказался нежизнеспособен на длинном материале).

## Проблема (root cause из systematic-debugging)

Фича v1 возлагала семантический выбор keep/cut по ВСЕМУ транскрипту на **главную
модель в одном окне контекста**. Это не масштабируется за ~30-50 мин:

- `get_transcript_structure` при `totalChars > TRANSCRIPT_TEXT_BUDGET` (12000) отдаёт
  только первую страницу (`TRANSCRIPT_PAGE_SIZE` = 60 абзацев) с `hasMore:true` —
  модель физически не видит весь транскрипт за один вызов.
- Валидатор `MontagePlan.validatePlan` требует ПОЛНОГО покрытия (каждый абзац ровно в
  одном блоке). Прямое противоречие с пагинацией.
- На 67-мин подкасте: модель строит план по видимым ~60 абзацам → валидатор
  «абзацы 60…N не покрыты» → error → retry guard → цикл кончается БЕЗ карточки.

Три симптома от пользователя = один архитектурный дефект:
- **#1** «нет подтверждения + не закончил» = циклы отклонения без карточки.
- **#2** «порезал только хвост» = вырожденный выбор на длинном материале (тот же корень,
  путь story-cutter через главную модель).
- **#3** «стартер/welcome не существуют» = ОПРОВЕРГНУТО на v37 (есть в коде), но реальный
  пробел обнаруживаемости (свёрнутая категория; welcome только на пустом чате).

## Ключевое решение

Переиспользовать УЖЕ существующий масштабируемый паттерн `analyze_transcript_for_cuts`
(`TranscriptStructure.analyzeForCutsWithLLM`: вторая модель, чанкинг по 50 сегментов,
до 30 чанков ≈ 5 ч, прогресс по чанкам, abort, кэш). Семантику даёт чанкированный
воркер, всю арифметику и бюджет — детерминированный код. Главная модель НЕ держит
транскрипт и НЕ авторит план — только показывает готовый план и правит по репликам.

Разделение (по философии проекта «арифметика — код, за LLM — только семантика»):
- **Воркер (2-я модель, локально по чанкам)** — оценивает СЕМАНТИКУ: importance, role,
  theme, группировка в связные блоки. Не считает секунды, не знает глобальный бюджет.
- **Калибровка (2-я модель, 1 вызов, только сводка блоков)** — глобальный re-rank
  (балл относителен между чанками) + защита завязки/финала.
- **Сборщик (код, глобально)** — knapsack под бюджет ±10%.

## Конвейер

```
propose_montage_plan({sequenceKey, targetDurationSec, summary})   ← без blocks от модели
   │
   ├─ 1. labelMontageBlocks (worker, 2-я модель, чанки): абзац → {i, importance, role, theme, blockId}
   ├─ 2. calibrateMontageBlocks (2-я модель, 1 вызов): сводка блоков → re-rank + protect start/end
   ├─ 3. MontagePlan.buildPlanFromLabels (код): knapsack блоков под бюджет → blocks[] в формате валидатора
   ├─ 4. MontagePlan.validatePlan (как сейчас): покрытие/арифметика → авто-план полон по построению
   ├─ 5. execProposeTranscriptCuts (существующий): padding/snap/merge, верификация, _pendingProposal
   └─ 6. карточка плана → правки репликами → applyPendingProposal (без изменений)
```

## Контракты данных

### Выход воркера — labeledBlock (на абзац)
```js
{
  i: 0,                    // индекс абзаца (из entry.paragraphs)
  blockId: 'b0',           // группировка соседних абзацев одной мысли
  importance: 3,           // 0=мусор, 1=проходное, 2=важное, 3=ядро смысла
  role: 'hook',            // hook|argument|example|payoff|repeat|filler|offtopic
  theme: 'Завязка спора'   // 3-6 слов, роль в истории
}
```
- `blockId` строится воркером: соседние абзацы одной мысли → один blockId. Knapsack
  оперирует блоками (связный keep, защита от «конфетти-реза»).
- role → cut-reason детерминированно: repeat→«повтор», filler→«вода», offtopic→«офтоп»,
  прочее→«слабый кусок».

### Выход калибровки — на blockId (не на абзац)
```js
{ blockId: 'b0', importance: 3, protect: 'start' }   // protect: 'start'|'end'|null
```
Вход калибровки — только сводка: `[{blockId, theme, role, importance, durationSec, startSec}]`.
Влезает в один контекст даже для 67 мин (нет полного текста).

### buildPlanFromLabels(labeledBlocks, entry, targetSec) → { blocks[], stats }
Чистая функция в `montage-plan.js`. Алгоритм:
1. Свернуть labeledBlocks по blockId → блоки с суммарной длительностью, min-i/max-i,
   агрегированным importance (после калибровки), role (доминирующий), theme.
2. Сортировка отбора: `protect:'start'` и `protect:'end'` — первыми (всегда keep);
   затем по importance убыв., при равенстве — по startSec (стабильно).
3. Добор в keep пока `keepSec + blockDur ≤ targetSec` (защита начала/финала может
   слегка превысить — валидатор ловит ±10%). Остальные блоки → cut.
4. Собрать `blocks[]` в формате текущего валидатора:
   keep → `{action:'keep', paragraphs:{from,to}, theme}`,
   cut → `{action:'cut', paragraphs:{from,to}, reason}`.
   Гарантия покрытия: блоки покрывают ВСЕ абзацы (воркер разметил каждый) → соседние
   одинаковые-action блоки сливаются, дыр нет по построению.
5. Вернуть `{blocks, stats:{keptBlocks, cutBlocks, keepSec, cutSec}}`.

## Worker — labelMontageBlocks (transcript-structure.js)

По образцу `analyzeForCutsWithLLM`:
- Тот же чанкинг (`ANALYSIS_CHUNK_SIZE`, `ANALYSIS_MAX_CHUNKS`), abort, onProgress,
  вызов через `CloudRuClient`/settings, repairJson на выходе чанка.
- Вход — абзацы (не сегменты): для каждого чанка воркер размечает importance/role/theme/blockId.
- Системный промпт чанка: «оцени важность каждого абзаца для сохранения СУТИ, не считай
  секунды, группируй соседние абзацы одной мысли в blockId». Пример JSON-выхода.
- Кэш по образцу `_labelsCache` (ключ seqKey|editVer) — повторный вызов с другой целью
  НЕ гоняет воркер заново (importance от цели не зависит; бюджет применяет код).

## calibrateMontageBlocks (transcript-structure.js)

Один LLM-вызов. Вход — сводка блоков. Выход — скорректированный importance + protect.
Дешёвый (нет полного текста). Fallback: если вызов упал/пустой — используем importance
воркера как есть, protect по эвристике (первый/последний блок с importance≥2).

## Контракт инструмента propose_montage_plan (panel.js)

- Схема: `required: [sequenceKey, targetDurationSec, summary]` — **blocks убран**.
- `execProposeMontagePlan`:
  1. sequenceKey-гейт + staleness-гейт (как сейчас).
  2. `labelMontageBlocks` → `calibrateMontageBlocks` → `MontagePlan.buildPlanFromLabels`.
     Прогресс воркера — через statusUi (пользователь видит «размечаю 3/8 чанков»).
  3. `validatePlan` (страховка; авто-план полон по построению).
  4. Делегировать в `execProposeTranscriptCuts` (как сейчас: `_pendingPlanContext`).
  5. Вернуть `{ok, status:'waiting_user_confirmation', _verification, _planStats}`.
- **Гейт (#1):** executor ВСЕГДА завершается либо карточкой `_pendingProposal`, либо
  явным `{error}` агенту. Никаких тихих выходов. Ошибка воркера → `{error}` с причиной.
- Старый путь «модель прислала blocks» удаляется целиком (YAGNI, источник #1).

## Стартер «Монтаж по смыслам» (conversation-starters.js)

Упростить systemPromptAddon под новый контракт:
1. Если нет цели — спроси «До какой длительности сжать?». Не продолжай без цели.
2. `get_timeline_snapshot` → sequenceName.
3. `propose_montage_plan({sequenceKey, targetDurationSec, summary})` — БЕЗ blocks,
   БЕЗ get_transcript_structure (executor сам разметит через воркер).
4. После `waiting_user_confirmation` — 1-2 фразы, цифры ТОЛЬКО из `_planStats`.
5. НИКОГДА не вызывай apply напрямую.

## Обнаруживаемость (#3, panel.js)

- Категория 📝 По тексту раскрыта по умолчанию ЛИБО стартер «Монтаж по смыслам»
  вынесен в always-visible-ряд — чтобы виден без раскрытия. (Выбор реализации — в плане.)
- Welcome-пункт про сжатие остаётся; проверить рендер на пустом чате.

## Тесты и приёмка (критерий B)

- **Юнит `tests/montage-plan.test.mjs`** (расширение): `buildPlanFromLabels` —
  неравномерная плотность (золото в одной секции, вода вокруг → keep берёт золото,
  не пропорцию), защита start/end, бюджет ±10% в обе стороны, cut-reason из role,
  связность (нет дыр/перекрытий после свёртки блоков), стабильная сортировка.
- **Юнит парсинга воркера**: разбор JSON-выхода чанка labelMontageBlocks (валидные/
  битые ответы, repairJson).
- **Live e2e (CDP)**: секвенция «1» (67 мин) на КОПИИ (backup → рез копии → возврат
  оригинала) → «сожми до 15 минут» → карточка плана покрывает ВЕСЬ ролик (проверка:
  cut/keep есть и в первой трети, и в последней — не только хвост) → Apply →
  `_timelineDiff.match === true` → субъективная связность автором.

## Вне скоупа v2

- Sentence-уровень гранулярности.
- Сборка новой секвенции из кусков (сценарии C/D).
- Drag&drop-редактирование плана (правки — репликами через агента).
