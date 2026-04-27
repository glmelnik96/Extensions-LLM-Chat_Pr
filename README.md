# Extensions-LLM-Chat_Pr

ИИ-ассистент видеомонтажа для **Adobe Premiere Pro 2025** (CEP 12).
Единая панель с AI-чатом и детерминированными инструментами. Бэкенд — **Cloud.ru Foundation Models**.

## Текущее состояние

| Компонент | Статус |
|-----------|--------|
| Транскрибация (Whisper Large v3) | Работает — параллельные чанки, clip_queue, cache |
| Убрать тишины | Работает — гибрид: transcript gaps + ffmpeg silencedetect |
| Убрать паразиты | Работает — Path A (целый сегмент) + Path B (начало/конец фразы) |
| Jump cuts | Работает — те же источники, порог 0.1–2.0с |
| Авто-главы | Работает — LLM topics + fallback time-based |
| AI-чат (монтаж) | Работает — tiered prompts, tool calling, propose/apply |
| AI-чат (маркеры) | Работает — propose_markers |
| AI-чат (аудио ducking) | Реализовано, не тестировалось в продакшене |
| J/L-cuts | Отключено — ExtendScript не поддерживает unlink() |
| Скорость клипа | Не поддерживается — нет API в Premiere Pro 2025 |
| Автотесты | 129/129 pass |

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

### Требования

- Adobe Premiere Pro 2025 (CEP 12)
- ffmpeg в PATH (для транскрибации и audio analysis)
- API-ключ Cloud.ru Foundation Models

### macOS

```bash
# 1. Клонировать/скопировать в:
~/Library/Application Support/Adobe/CEP/extensions/Extensions-LLM-Chat_Pr

# 2. Включить отладку CEP:
defaults write com.adobe.CSXS.12 PlayerDebugMode 1

# 3. Установить ffmpeg:
brew install ffmpeg

# 4. Настроить API-ключ:
cd ~/Library/Application\ Support/Adobe/CEP/extensions/Extensions-LLM-Chat_Pr
cp client/shared/fm-secrets.example.js client/shared/fm-secrets.js
# Открыть fm-secrets.js, вписать apiKey
```

### Windows

```
1. Скопировать в: %AppData%\Adobe\CEP\extensions\Extensions-LLM-Chat_Pr
2. Реестр: HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.12 → PlayerDebugMode = 1
3. Установить ffmpeg, добавить в PATH
4. Скопировать fm-secrets.example.js → fm-secrets.js, вписать apiKey
```

### Конфигурация

**`client/shared/fm-defaults.js`** — модели и параметры:

| Поле | Значение | Описание |
|------|----------|----------|
| `chatModel` | `openai/gpt-oss-120b` | Основная модель агента (131K контекст) |
| `codeModel` | `Qwen/Qwen3-Coder-Next` | Альтернатива для кода (262K) |
| `analysisModel` | `openai/gpt-oss-120b` | Анализ транскрипта |
| `fastModel` | `openai/gpt-oss-120b` | Простые задачи (routing) |
| `whisperModel` | `openai/whisper-large-v3` | Транскрибация |
| `transcribeExportChunkSec` | `90` | Длина чанка (сек) |
| `maxTranscribeUploadBytes` | `20971520` | Макс. размер загрузки (20 МБ) |

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
npm test   # 129 тестов: валидаторы, pipelines, prompts, search, simulator
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
│       ├── find-moments.js        — semantic search (literal + TF-IDF)
│       ├── tool-validators.js     — валидация планов перед apply
│       ├── edit-plan-simulator.js — dry-run симуляция правок
│       ├── fm-defaults.js         — конфигурация моделей
│       └── fm-secrets.js          — API-ключ (gitignored)
├── host/
│   ├── premiere.jsx               — ExtendScript: snapshot, razor, markers, export
│   └── presets/                   — .epr пресет для аудио-экспорта
├── tests/                         — 129 автотестов (node --test)
└── docs/                          — документация
```

## Документация

- [docs/MANUAL_TESTS.md](docs/MANUAL_TESTS.md) — чеклист ручного тестирования
- [docs/DEV_ARTIFACTS.md](docs/DEV_ARTIFACTS.md) — артефакты разработки: lessons learned, known issues, roadmap, audit
