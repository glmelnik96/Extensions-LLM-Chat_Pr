# Lessons learned (CEP + ExtendScript + Premiere Pro 2025)

Короткий журнал подводных камней, которые уже стоили нам часов отладки. Если
натыкаешься на повторение — добавляй сюда, не в код.

---

## 1. `413 Payload Too Large` при транскрибации музыки / длинных клипов

**Симптом:** Cloud.ru FM возвращает `413 Payload Too Large — аудио слишком
большое для API`.

**Причина:** панель уходила в режим `media_file` (без `.epr`-пресета) и
пыталась отправить весь исходный медиафайл целиком (десятки–сотни МБ) — API
режет на ~20 МБ.

**Решения (в порядке приоритета):**

1. **Локальный бэкенд whisper.cpp** — ставит проблему с API вне уравнения.
   См. `client/shared/whisper-cpp-client.js` и `FM_DEFAULTS.transcribeBackend
   = 'whisper.cpp'`. Это теперь дефолт.
2. **Автоматический ffmpeg-чанкинг** (fallback для облачного режима):
   `timeline-transcribe.js` → `extractAudioChunksWithFfmpeg()` режет
   `[workIn..workOut]` источника на 90-секундные 16 kHz mono PCM фрагменты
   (≈ 2.9 МБ каждый), отправляет по одному, склеивает таймкоды.
3. **`.epr`-пресет** (только аудио MP3 128 kbps): прописать абсолютный путь
   в `FM_DEFAULTS.exportAudioPresetPath`. Премьер сам экспортирует чанками
   через `exportAsMediaDirect` — см. `host/presets/README.txt`.

**Анти-паттерн:** увеличивать `maxTranscribeUploadBytes`. Лимит на стороне
API, не у нас.

---

## 2. ExtendScript regex lexer баг: `/` внутри character class ломает парсер

**Симптом:** `SyntaxError: Expected: )` при `$.evalFile("host/premiere.jsx")`,
хотя любой нормальный JS-парсер (acorn, esprima, Node) говорит, что файл
валидный.

**Причина:** ExtendScript (JS-движок PP 2025 ScriptingAPI) — ES3 с кастомным
лексером, который **некорректно завершает regex literal на первом `/`, даже
внутри `[...]`**. Типичный триггер:

```js
/* трогает баг → "Expected: )" */
var basename = p.replace(/^.*[\\/]/, '');
```

**Правила для `host/premiere.jsx`:**

- **Никогда** не ставь `/` внутри `[...]` в regex literal.
- Если нужен «любой из разделителей пути»:
  - замена — на `lastIndexOf('/')` + `lastIndexOf('\\')`,
  - либо `new RegExp('[\\\\/]')` (конструктор обходит баг лексера),
  - либо разбивать через `split('/')` и `split('\\')`.
- Все другие файлы (`client/**/*.js`) парсит Chromium-Node, там ок.

**Проверка на будущее:** после изменений в `host/premiere.jsx` прогонять:

```bash
node -e "
const acorn=require('acorn');
const src=require('fs').readFileSync('host/premiere.jsx','utf8');
const ast=acorn.parse(src,{ecmaVersion:5,locations:true});
(function walk(n){if(!n||typeof n!=='object')return;
  if(n.type==='Literal'&&n.regex&&/\[[^\]]*\/[^\]]*\]/.test(n.raw))
    console.log('SUSPECT regex (slash in char class):',n.loc.start.line,n.raw);
  for(const k in n){if(k==='loc')continue;const v=n[k];
    if(Array.isArray(v))v.forEach(walk);
    else if(v&&typeof v==='object'&&v.type)walk(v);}})(ast);
console.log('done');
"
```

Должно печатать только `done`.

---

## 3. Volume keyframes через ExtendScript — нерабочее

**Симптом:** просили ducking/loudness «применить на дорожке», ставили
маркеры как заглушку — пользователь справедливо закрыл эту ветку.

**Причина:** `TrackItem.components.Volume` есть, но `setValueAtKey`
нестабилен на PP 2025, особенно при batch-записи.

**Решение:** offline-рендер через ffmpeg + импорт в bin `AI Renders`.
См. `client/shared/audio-render.js` + `$._EXT_PRM_.importMediaFile`.
Пользователь сам перетаскивает рендер из бина на дорожку поверх
оригинала. Никаких маркеров-заглушек.

---

## 4. Чат «переполнен» после 5–8 мелких запросов

**Причина:** tool-results (снимки таймлайна, транскрипты) копились в
истории целиком.

**Решение:** `agent-loop.js` → `compressToolHistory()`. Последние 4 tool-
сообщения сохраняются целиком, остальные урезаются до 600 байт с пометкой
`[truncated … bytes]`. История системных/пользовательских/ассистентских
сообщений не трогается.

---

## 5. `find_moments` возвращает слишком мало/широко

**Симптом:** на запрос «все упоминания Х» возвращался один результат и
широкий параграф.

**Причина:** TF-IDF + paragraph-level matching.

**Решение:** `find-moments.js` теперь идёт сначала сегмент-level с literal
substring + простое стемминг-урезание (`ё→е`, дроп 1-2 последних символов).
TF-IDF остаётся fallback-ом для семантики. k=20, без `minScore` для literal.
Склейка соседних хитов ≤ `mergeGapSec` (по умолчанию 1.5 с).

---

## 6. «Удали клип X» удалял ВСЁ под ним

**Причина:** агент выбирал `ripple_delete_range` по временному диапазону
клипа, и ripple-удаление резало нижестоящую музыкальную дорожку по тем же
границам.

**Решение:** в `prompts.js` (textmontage + timecode) добавлено
«⚠ ЖЕЛЕЗНОЕ ПРАВИЛО»: для «удали клип <имя>» агент ОБЯЗАН использовать
`remove_clip` с конкретным `nodeId`. `ripple_delete_range` запрещён, когда
речь о конкретном клипе.

---

## 7. ffmpeg не находится из Node-CEP

**Причина:** CEP Node.js не наследует пользовательский PATH → в скриптах
`which ffmpeg` пустой.

**Решение:** `findFfmpegPath()` в `timeline-transcribe.js` и `audio-render.js`
проходит по белому списку: `/opt/homebrew/bin/ffmpeg`,
`/usr/local/bin/ffmpeg`, `/usr/bin/ffmpeg`, Windows-пути, потом
`which ffmpeg` с явно дополненным `PATH`. То же соглашение — для
`whisper-cli` (см. `whisper-cpp-client.js` → `findWhisperCliPath`).

---

## 8. Host не перегружается после правки premiere.jsx

**Симптом:** правишь `host/premiere.jsx`, а в панели работает старая версия.

**Причина:** `bridge-premiere.js` кэширует `hostLoaded = true` после первой
успешной загрузки.

**Решение:** перезагружать CEP-панель (закрыть/открыть панель в Window →
Extensions) или перезапустить Premiere. Никакого hot-reload нет.

---
