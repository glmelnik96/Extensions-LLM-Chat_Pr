# Extensions-LLM-Chat_Pr

ИИ-ассистент видеомонтажа для **Adobe Premiere Pro 2024+** (CEP 12, проверено на 24/25/26).
Единая панель с AI-чатом и детерминированными инструментами. Бэкенд — **Cloud.ru Foundation Models** (GLM-5.1 + DeepSeek-V4-Pro + Whisper-large-v3).

> **🤖 Работаешь над проектом как агент?** Сначала прочитай [HANDOFF.md](HANDOFF.md) — там всё необходимое: что работает, где hot zones, как тестировать, чего НЕ трогать. ~5 минут чтения.

## Текущее состояние

| Компонент | Статус |
|-----------|--------|
| Транскрибация (Whisper Large v3) | Работает — параллельные чанки, clip_queue, cache |
| Убрать тишины | Работает — гибрид: transcript gaps + ffmpeg silencedetect |
| Waveform-превью (Инструменты) | Работает — огибающая RMS + красные зоны выреза, ползунки обновляют вживую без ffmpeg (Тишины, Jump cuts); preview==apply |
| Убрать паразиты | Работает — Path A (целый сегмент) + Path B (начало/конец фразы) |
| Jump cuts | Работает — те же источники, порог 0.1–2.0с |
| Авто-главы | Работает — LLM topics + fallback time-based |
| AI-чат (монтаж) | Работает — tiered prompts, tool calling, propose/apply |
| AI-чат (маркеры) | Работает — propose_markers |
| AI-чат (аудио ducking) | Реализовано, не тестировалось в продакшене |
| J/L-cuts | Отключено — ExtendScript не поддерживает unlink() |
| Скорость клипа | Не поддерживается — нет API в Premiere Pro 2025 |
| Автотесты | 463/463 unit + 23/23 LLM quality checks на 1ч подкасте |
| MultiCam-нарезка для подкастов | Phase 2 — audio-driven свитчер по RMS микрофонов, кастомный выбор дорожек по спикерам, пресеты Спокойный/Динамичный + свои |
| Чекпоинты / Откат | Работает — бэкап-секвенция перед каждым apply, кнопка «⏪ Откатить» |
| Кликабельные таймкоды | Работает — в proposal-картах и в свободном тексте чата («763–778 сек», «12:43») → клик двигает плейхед |
| PP 2026 совместимость | Стабилизировано — `_wrap` decorator + cold-start retry |

## Что нового (июнь 2026)

- **Авто-MultiCam Phase 2**: свитчер камер по RMS-громкости микрофонов (AutoPod-паттерн). Режимы «Авто» (детект микрофонов) и «Вручную» — маппинг спикер→аудиодорожка→видеодорожка + общий план. Пресеты Спокойный/Динамичный + сохранение своих. Честные варнинги: «плоский» микрофон, BRAW без декодирования.
- **Чекпоинты**: перед каждым apply создаётся бэкап-секвенция `[бэкап HH:MM:SS]`, откат одной кнопкой «⏪ Откатить».
- **Кликабельные таймкоды** — и в proposal-картах, и в свободном тексте ответов чата: «763 – 778 сек», «12 мин 43 сек», «12:43», «1304с» → клик ставит плейхед.
- **Точный find_moments**: стемминг по началу слова (запрос «рост» больше не матчит «просто»/«вопрос»), multi-stem ranking — сегменты со всеми словами запроса вытесняют частичные совпадения.
- **⚡ Анализ аудио без транскрипции**: silences/jump cuts за ~30 сек через ffmpeg, не дожидаясь Whisper.
- **Live-валидация на больших проектах**: чат проверен на 53-минутном подкасте (768 сегментов) — резюме, поиск моментов и дальние края транскрипта точны до секунд, без галлюцинаций.
- **tools/cep-debug.mjs**: CDP-драйвер для live-прогонов панели (eval/evalfile/reload/screenshot через порт 8098).
- **Кросс-ОС/ExtendScript hardening (18 июня)**: JSON-полифилл в host (часть сборок Premiere не имеют нативного JSON), замена `.trim()` (нет в ES3), кросс-ОС поиск whisper.cpp (Win/Mac), понятные ошибки ffmpeg на Windows. Чинит установку на других машинах.

## Новые проверки качества (май 2026)

- **Target-duration enforcement**: при «уложи в N секунд» LLM передаёт `targetDurationSec`, плагин валидирует сумму keepIntervals (допуск +20%) → ошибка с подсказкой → LLM пересобирает план. Раньше overshoot 75% уходил молча.
- **Stale paragraph auto-rebuild**: после ripple_delete параграфы могли разъехаться с сегментами по timestamps. `TranscriptStructure.isParagraphsStale` детектит drift >1с / out-of-range segIdxs и автоматически пересобирает структуру.
- **Snap к paragraph boundaries**: ножи теперь snap'ят сначала к границам абзацев (паузы ≥0.5с, drift до 1.5с), потом fallback на segment-boundaries (drift 0.5с) — меньше mid-word cuts.
- **Sequence-switch guard**: если активная секвенция переключилась между proposal и apply — блок, без удаления чужого таймлайна.
- **Audio-only анализ**: `cutSilences`/`jumpCuts` без транскрипции — 30 сек вместо 10–15 мин Whisper.

## UX-улучшения карточки proposal

- 🎯 Target/Actual badge с цветовой индикацией (≤+5% green, ≤+20% amber, >+20% red)
- Apply primary green-кнопка (раньше визуально равноценна с Cancel)
- Autofocus на Apply, **Esc** закрывает proposal card
- Прогресс-бар точный по чанкам в analyze, indeterminate в transcribe
- Retry-кнопка для network errors с классификацией (auth/quota/network)
- WCAG AA контраст, focus-visible outlines, aria-live регионы
- Унифицированные CSS-токены `--{warning,danger,success,info}-*` вместо hard-coded hex

## Архитектура

```
┌─────────────────────────────────────────────────┐
│  CEP Panel (Chromium + Node.js)                 │
│  client/unified/index2.html + panel.js          │
│                                                 │
│  ┌──────────┐  ┌──────────────────────────────┐ │
│  │ Вкладка  │  │ Вкладка «Инструменты»       │ │
│  │ «Чат»    │  │ Тишины · Паразиты · Jumps   │ │
│  │ AI-агент │  │ Главы · (J-cuts отключено)   │ │
│  └────┬─────┘  └─────────────┬────────────────┘ │
│       │                      │                  │
│  ┌────▼──────────────────────▼────────────────┐ │
│  │ client/shared/                             │ │
│  │ cloudru-client.js  — API Cloud.ru FM       │ │
│  │ deterministic-pipelines.js — алгоритмы     │ │
│  │ prompts.js — tiered system prompts         │ │
│  │ agent-loop.js — orchestration              │ │
│  │ context-store.js — кэш, настройки          │ │
│  │ timeline-transcribe.js — транскрибация     │ │
│  │ audio-preprocess.js — ffmpeg analysis      │ │
│  └────────────────────┬───────────────────────┘ │
│                       │ CSInterface.evalScript   │
│  ┌────────────────────▼───────────────────────┐ │
│  │ host/premiere.jsx — ExtendScript           │ │
│  │ Снимок · Razor · Ripple · Markers · Export │ │
│  └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
         │                        │
    Cloud.ru FM API          Adobe Premiere Pro
    (chat + whisper)         (DOM + QE DOM)
```

## Рабочие функции

### Вкладка «Инструменты»

**Убрать тишины** — гибридное обнаружение пауз:
- Источник 1: gaps между сегментами транскрипта (Whisper знает границы речи)
- Источник 2: ffmpeg silencedetect (ловит тихие паузы внутри сегментов)
- Слайдеры: мин. длительность (0.3–3.0с), padding (0–0.5с), порог тишины (3–30 dB ниже средней громкости)
- Фильтр микро-зазоров (<0.15с) — убирает мусор в 2–3 кадра после razor

**Убрать паразиты** — двухпутевой детектор:
- Path A: целый короткий сегмент (≤4 слова) = филлер → вырезать
- Path B: первые/последние 1–2 слова длинного сегмента = филлер → вырезать пропорционально
- Два режима: Строгий (э, мм, ну, блин) и Расширенный (+ типа, вот, значит, как бы, короче)

**Jump cuts** — YouTube-стиль:
- Те же два источника (transcript gaps + ffmpeg)
- Порог паузы: 0.1–2.0с (default 0.3с)
- Фильтр микро-зазоров

**Авто-главы** — маркеры по темам:
- LLM определяет смену тем через transcript paragraphs
- Fallback: равномерные главы по времени
- Контроль количества глав (0 = авто, 1–20)
- Фильтр: маркеры ближе 15с объединяются

### Вкладка «Чат»

AI-агент монтажа с tool calling. Понимает естественный язык:

| Запрос пользователя | Что делает агент |
|---------------------|------------------|
| «Убери паразиты и вступление» | analyze_transcript_for_cuts → propose_transcript_cuts |
| «Удали с 3 по 5 секунду» | get_snapshot → propose_edit_plan (ripple_delete) |
| «Собери ролик 45 секунд» | get_transcript_structure → выбор фрагментов → propose_transcript_cuts |
| «Поставь маркеры на главы» | get_transcript_structure → propose_markers |
| «Удали клип [имя]» | get_snapshot → propose_edit_plan (remove_clip) |
| «Приглуши музыку» | propose_audio_ducking |
| «Сделай динамичнее» | анализ транскрипта → вырезка пауз/повторов |

Slash-команды в чате: `/cut_fillers`, `/cut_silences`, `/jump_cuts`, `/chapterize`.

### Транскрибация

- Cloud.ru Whisper Large v3 (или локальный whisper.cpp)
- Режим clip_queue: параллельная обработка клипов (CONCURRENCY=20)
- Автоизвлечение аудио через ffmpeg (mono 16kHz WAV)
- Кэш: `~/.extensions_llm_chat_pr/_llm_transcript_cache.json`
- Audio analysis: ffmpeg silencedetect + EBU R128 loudnorm

### Сервисные функции

- **Сохранить сессию (JSON)** — полный дамп чата + snapshot → `~/.extensions_llm_chat_pr/sessions/`
- **AI-отчёт о сессии** — Cloud.ru FM анализирует лог, выдаёт структурированный JSON с ошибками, багами, рекомендациями → `~/.extensions_llm_chat_pr/reports/`

## Действия таймлайна

| Действие | Параметры | Описание |
|----------|-----------|----------|
| `ripple_delete_interval` | startSec, endSec | Вырезать и сомкнуть |
| `lift_delete_interval` | startSec, endSec | Вырезать, оставить дыру |
| `remove_clip` | nodeId | Удалить клип (видео + аудио) |
| `trim_in` | nodeId, timeSec | Обрезать начало |
| `trim_out` | nodeId, timeSec | Обрезать конец |
| `trim_bounds` | nodeId, startSec, endSec | Оба конца |
| `move_clip` | nodeId, newStartSec | Переместить |
| `shift_ripple` | fromSec, deltaSec | Сдвинуть всё правее |
| `set_clip_enabled` | nodeId, enabled | Вкл/выкл клипа |
| `set_playhead` | timeSec | Курсор воспроизведения |
| `mute_track` | trackType, trackIndex, muted | Заглушить дорожку |

## Установка

> 📖 **Полное пошаговое руководство** с проверками после каждого шага и Troubleshooting — в [INSTALL.md](INSTALL.md). Здесь — краткая версия для опытных пользователей.

### Требования

- **Adobe Premiere Pro 2024 или новее** (CEP 12; PP 23 и старше manifest отвергает)
- **ffmpeg в PATH** — для транскрибации и audio analysis
- **API-ключ Cloud.ru Foundation Models** — https://cloud.ru/

### macOS — quick start

```bash
# 1. Включить отладку CEP (CRITICAL — без этого расширение НЕ загрузится):
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
# Проверка: defaults read com.adobe.CSXS.12 PlayerDebugMode → должно быть 1

# 2. Установить ffmpeg:
brew install ffmpeg
# Проверка: which ffmpeg → /opt/homebrew/bin/ffmpeg или /usr/local/bin/ffmpeg

# 3. Склонировать репо в правильное место:
cd ~/Library/Application\ Support/Adobe/CEP/extensions/
git clone <repo-url> Extensions-LLM-Chat_Pr
cd Extensions-LLM-Chat_Pr

# 4. Настроить API-ключ:
cp client/shared/fm-secrets.example.js client/shared/fm-secrets.js
# Открыть fm-secrets.js, вписать apiKey

# 5. ПОЛНОСТЬЮ закрыть Premiere (Cmd+Q) и открыть снова
# 6. Window → Extensions → ИИ: монтаж
```

### Windows — quick start

```
1. Реестр: HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.12 → PlayerDebugMode (DWORD) = 1
2. Установить ffmpeg → распаковать в C:\ffmpeg или C:\Program Files\ffmpeg → добавить bin в PATH
   (плагин сам проверяет оба пути + `where ffmpeg`)
3. Скопировать в: %AppData%\Adobe\CEP\extensions\Extensions-LLM-Chat_Pr
4. Скопировать fm-secrets.example.js → fm-secrets.js, вписать apiKey
5. Полный рестарт Premiere
6. Window → Extensions → ИИ: монтаж
```

### 🆘 Не работает?

Краткие фиксы — здесь, полный Troubleshooting — в [INSTALL.md#troubleshooting](INSTALL.md#-troubleshooting).

| Симптом | Вероятная причина | Быстрый фикс |
|---|---|---|
| Нет «ИИ: монтаж» в Window → Extensions | PlayerDebugMode не установлен или Premiere не перезапущен | `defaults read com.adobe.CSXS.12 PlayerDebugMode` → 1, потом Cmd+Q + старт |
| «Не настроен API (fm-secrets.js)» | apiKey пустой или файла нет | `grep apiKey client/shared/fm-secrets.js` → должен быть твой ключ |
| «ffmpeg не найден» при транскрибации | ffmpeg не в PATH | `which ffmpeg` → если пусто, `brew install ffmpeg` + рестарт Premiere |
| «EvalScript error.» при первой операции | Cold-start race ExtendScript | Bridge ретраит 3 раза автоматически. Если стабильно — Cmd+Q + старт. Открой DevTools на `localhost:8098`, пришли скрин Console |
| «JSON polyfill missing in Premiere ExtendScript» | Старая версия host/premiere.jsx | `git pull` свежую версию (исправлено в Phase 1 wrap-pattern) |
| Premiere версии < 2024 | manifest требует `[24.0,99.9]` | Обнови Premiere через Creative Cloud |

### Конфигурация

**`client/shared/fm-defaults.js`** — модели и параметры:

| Поле | Значение | Описание |
|------|----------|----------|
| `chatModel` | `zai-org/GLM-5.1` | Основной агент + tool-calling (202K контекст, thinking on) |
| `analysisModel` | `zai-org/GLM-5.1` | Анализ транскрипта (thinking off — обязательно для >10K input) |
| `chapterModel` | `deepseek-ai/DeepSeek-V4-Pro` | Главы / long-context reasoning (1M контекст, 7× быстрее GLM) |
| `findMomentsModel` | `zai-org/GLM-5.1` | Семантический поиск моментов |
| `codeModel` | `deepseek-ai/DeepSeek-V4-Pro` | Альтернатива агента для кода (1M контекст) |
| `fastModel` | `openai/gpt-oss-120b` | Routing / простые intent'ы (131K, дёшево) |
| `whisperModel` | `openai/whisper-large-v3` | Транскрибация |
| `chatParams.max_tokens` | `16000` | Бюджет ответа на один call |
| `transcribeExportChunkSec` | `90` | Длина чанка (сек) |
| `maxTranscribeUploadBytes` | `20971520` | Макс. размер загрузки (20 МБ) |

Распределение обосновано живыми тестами 4 июня 2026 — см. [`.omc/research/2026-06-04-cloudru-new-models-evaluation.md`](.omc/research/2026-06-04-cloudru-new-models-evaluation.md).

**`client/shared/fm-secrets.js`** — API-ключ (не в Git):
```js
var FM_SECRETS = { apiKey: 'ваш-ключ-cloud-ru' };
```

## Использование

### Быстрый старт

1. Premiere Pro → Window → Extensions → **ИИ: монтаж**
2. Нажать **Транскрибировать In–Out** (установить In/Out точки на секвенции)
3. Дождаться завершения (LED станет зелёным)
4. Использовать инструменты (тишины, паразиты, jump cuts, главы) или чат

### Типовые сценарии

**Чистка видео для YouTube:**
1. Транскрибировать → Инструменты → «Убрать тишины» (порог 0.5с) → Применить
2. «Убрать паразиты» (Расширенный) → Применить
3. В чате: «Убери вступление, оставь с момента, где начинается основная тема»

**Черновой монтаж:**
1. Транскрибировать
2. В чате: «Собери автоматический черновой монтаж, оставь самое ценное»
3. Или: «Собери ролик длительностью 45 секунд из лучших фрагментов»

**Разметка глав:**
1. Транскрибировать → Инструменты → «Авто-главы» (кол-во: 5) → Применить
2. Или в чате: «Поставь маркеры на главы, 6 штук»

**Точечные правки через чат:**
- «Удали с 10 по 15 секунду»
- «Обрежь начало первого клипа до 3 секунд»
- «Отключи клип [имя]»

### Экспорт отчётов

- Меню **Ещё ▾** → **Сохранить сессию (JSON)** — полный дамп для отладки
- Меню **Ещё ▾** → **AI-отчёт о сессии** — структурированный анализ от Cloud.ru FM

## Тесты

```bash
npm test   # 463 тестов: валидаторы, pipelines, prompts, search, simulator, multicam, scenarios
```

Интеграция с Premiere — ручная проверка по чеклисту `docs/MANUAL_TESTS.md`.

## Файловая структура

```
├── CSXS/manifest.xml              — регистрация панели (MainPath: index2.html)
├── client/
│   ├── unified/
│   │   ├── index2.html            — HTML панели (cache-bust через document.write)
│   │   └── panel.js               — UI, executors, agent loop, tools, export
│   └── shared/
│       ├── cloudru-client.js      — HTTP-клиент Cloud.ru FM API
│       ├── deterministic-pipelines.js — алгоритмы: silences, fillers, jumps, chapters
│       ├── prompts.js             — tiered system prompts для AI-агента
│       ├── agent-loop.js          — оркестрация tool calling
│       ├── context-store.js       — localStorage + файловый кэш транскриптов
│       ├── timeline-transcribe.js — транскрибация (cloud + whisper.cpp)
│       ├── audio-preprocess.js    — ffmpeg silencedetect + loudnorm
│       ├── bridge-premiere.js     — CSInterface → ExtendScript мост
│       ├── transcript-structure.js— paragraphs, topics, local detectors
│       ├── find-moments.js        — semantic search (literal stems + TF-IDF)
│       ├── multicam-plan.js       — план переключений камер по RMS микрофонов
│       ├── tool-validators.js     — валидация планов перед apply
│       ├── edit-plan-simulator.js — dry-run симуляция правок
│       ├── operation-queue.js     — очередь длинных операций (transcribe/analyze)
│       ├── analysis-routing.js    — выбор модели под задачу
│       ├── audio-ducking.js       — план приглушения музыки под речь
│       ├── audio-render.js        — экспорт аудио секвенции через .epr
│       ├── whisper-cpp-client.js  — локальный whisper.cpp (fallback)
│       ├── youtube-export.js      — главы → описание YouTube
│       ├── markdown-lite.js       — безопасный рендер markdown в чате
│       ├── conversation-starters.js / starters-ui.js — стартовые подсказки чата
│       ├── ui-hints.js / ui-status.js — подсказки и статусная строка
│       ├── panel-bootstrap.js     — загрузка модулей, cache-bust
│       ├── abort-shim.js          — AbortController для старого CEF
│       ├── fm-defaults.js         — конфигурация моделей
│       └── fm-secrets.js          — API-ключ (gitignored)
├── host/
│   ├── premiere.jsx               — ExtendScript: snapshot, razor, markers, export
│   └── presets/                   — .epr пресет для аудио-экспорта
├── tools/
│   └── cep-debug.mjs              — CDP-драйвер: eval/reload/screenshot панели (порт 8098)
├── tests/                         — 463 автотестов (npm test) + integration на Cloud.ru
└── docs/                          — документация
```

## Документация

- **[HANDOFF.md](HANDOFF.md)** — входная точка для агентов (что работает, hot zones, conventions, как тестировать)
- [INSTALL.md](INSTALL.md) — пошаговая установка (macOS / Windows) + Troubleshooting
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — хронология milestone'ов
- [docs/DEV_ARTIFACTS.md](docs/DEV_ARTIFACTS.md) — артефакты разработки: lessons learned (17 ловушек), known issues, roadmap, audit компонентов
- [docs/MANUAL_TESTS.md](docs/MANUAL_TESTS.md) — чеклист ручного тестирования в Premiere
