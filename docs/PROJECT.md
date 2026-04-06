# Проект: CEP + Premiere + Cloud.ru FM

## Три панели (Window → Extensions)

| Панель | `panel.js` | Инструменты агента | Хост `premiere.jsx` |
|--------|------------|-------------------|---------------------|
| Монтаж по таймкодам | `client/timecode-edit/` | `get_timeline_snapshot`, `apply_timecode_edits` | `getTimelineSnapshot`, `applyTimecodeEdits` |
| Монтаж по тексту | `client/text-montage/` | + `get_transcript_from_cache`, `apply_transcript_cuts`, `apply_timecode_edits` (трим, `move_clip`, `shift_timeline_ripple`) | `applyTimecodeEdits`, `applyTranscriptCuts` |
| Маркеры | `client/markers/` | + `get_transcript_from_cache`, `add_markers` | `addSequenceMarkers` |

У каждой панели **отдельный** чат (`localStorage`, ключ `__PANEL_ID__`). Кэш транскриптов **общий** между Extension Id: запись/чтение в несколько путей с merge; канон для кросс-панели — **`~/.extensions_llm_chat_pr/_llm_transcript_cache.json`** (Node `os.homedir()`), т.к. CEP `userData` часто разный на каждую панель. Дополнительно: корень расширения, `host/`, bundle, опционально `setTranscriptUserDataBase`, fallback — `localStorage`.

## Поток данных

1. **CEP (HTML/JS)** — UI, `runAgentLoop` (`client/shared/agent-loop.js`), вызовы FM через `cloudru-client.js`.
2. **CSInterface** + `bridge-premiere.js` — `evalScript` JSON в ExtendScript.
3. **`host/premiere.jsx`** — реальные операции таймлайна (см. комментарии в начале файла).

Нет отдельного планировщика: одна чат-модель в цикле `tool_calls`. Ограничение глубины — `maxSteps` в вызове `runAgentLoop` + промпт про очередь подзадач.

## Ключевые файлы

- `client/shared/prompts.js` — системные промпты трёх агентов  
- `client/shared/tool-validators.js` — проверка аргументов до хоста  
- `client/shared/fm-defaults.js` / `fm-secrets.js` — URL, модели, ключ  
- `client/shared/timeline-transcribe.js` — Whisper → сегменты; `runFromPrep` (чанки, очередь клипов)  
- `client/shared/abort-shim.js` + `abortCheck` в цикле и в `fetch` — кнопка «Стоп»  
- `client/shared/panel-bootstrap.js` — `PanelBoot.run`, видимая ошибка при сбое инициализации вместо пустой панели  
- `CSXS/manifest.xml` — CEP 12, `--enable-nodejs` для чтения файлов транскрибации  

## Соответствие Premiere API

Опираемся на [Premiere Pro Scripting Guide](https://ppro-scripting.docsforadobe.dev/): `TrackItem`, `remove(ripple)`, маркеры, экспорт In–Out. Ripple-вырезание интервала реализовано через split (`insertClip`) + подгонка in/out + сдвиг правого куска (см. `_removeIntervalFromClip`).

**Ограничение:** клипы на разных дорожках (V/A) обрабатываются независимо — возможен визуальный рассинхрон после тяжёлых правок.

## Новая операция (чеклист)

1. Описать tool в `panel.js` (schema для FM).  
2. Реализовать в `premiere.jsx` (ветка в существующем JSON-хендлере или новая функция).  
3. При необходимости — правило в `tool-validators.js`.  
4. Строка в промпте в `prompts.js`.  
5. При заметной смене поведения в Premiere — кратко обновить [premiere-extension-audit.md](premiere-extension-audit.md).

---

## Перед правками (быстрый чек)

1. `npm test` — валидаторы аргументов инструментов (`tests/*.test.mjs`).  
2. После изменений `host/premiere.jsx` — перезагрузка панели в Premiere, проверка на **копии** секвенции.  
3. Сеть FM: 401 / 413 — сообщения в панели и `client/shared/cloudru-client.js` (413 → уменьшить чанк / In–Out / лимит загрузки).
