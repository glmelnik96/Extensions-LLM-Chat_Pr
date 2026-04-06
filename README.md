# Extensions-LLM-Chat_Pr v2.0.0

Три CEP-панели для **Adobe Premiere Pro 2025** (CEP 12) с ИИ-агентом на **Cloud.ru Foundation Models** (чат + Whisper).

## Панели (Window > Extensions)

1. **ИИ: монтаж по таймкодам** — снимок секвенции, обрезка/перемещение/скорость клипов, ripple delete, вкл/выкл клипов, управление playhead и дорожками.
2. **ИИ: монтаж по тексту** — транскрипт в кэш > `apply_transcript_cuts` и те же правки, что у таймкодов (`apply_timecode_edits`: трим, перенос блоков).
3. **ИИ: маркеры по структуре** — маркеры на секвенции (Comment / Chapter).

## Возможности v2.0.0

### Действия таймлайна (панель Timecode Edit)

| Действие | Параметры | Описание |
|----------|-----------|----------|
| `ripple_delete_range` | startSec, endSec | Вырезать интервал на всех дорожках |
| `remove_clip` | nodeId | Удалить клип целиком (видео + аудио) |
| `set_timeline_in` | nodeId, timeSec | Обрезать начало клипа |
| `set_timeline_out` | nodeId, timeSec | Обрезать конец клипа |
| `set_timeline_bounds` | nodeId, startSec, endSec | Оба конца |
| `move_clip` | nodeId, newStartSec, shiftBlockingClips? | Переместить; по умолчанию ripple-сдвиг всех клипов правее цели |
| `shift_timeline_ripple` | fromSec, deltaSec | Сдвинуть вправо все клипы с start ≥ fromSec |
| `set_clip_enabled` | nodeId, enabled | Включить/выключить без удаления |
| `set_clip_speed` | nodeId, speed | Скорость (1.0=норма, 2.0=2x, 0.5=замедление) |
| `set_playhead` | timeSec | Переместить курсор воспроизведения |
| `mute_track` | trackType, trackIndex, muted | Заглушить/включить дорожку |

### Снимок таймлайна (get_timeline_snapshot)

Возвращает:
- Мета: `sequenceName`, `fps`, `frameSizeH`x`frameSizeV`, `playheadSec`, `sequenceEndSec`
- In/Out секвенции: `sequenceInSec`, `sequenceOutSec`
- Дорожки: `tracks[]` с name, muted, clipCount
- Клипы: `clips[]` с nodeId, name, startSec, endSec, durationSec, disabled

### Транскрибация

- **Авто-извлечение аудио через ffmpeg** — если медиафайл слишком большой для API, автоматически извлекается аудио (mono 16kHz WAV). Требует `ffmpeg` в PATH.
- **Экспорт чанками** — при наличии .epr пресета, область In-Out экспортируется чанками.
- **Кэш транскриптов** — по имени секвенции; файловый канон `~/.extensions_llm_chat_pr/_llm_transcript_cache.json` и merge с путями расширения (см. `docs/PROJECT.md`).

### Улучшения агента

- **maxSteps=12** в timecode (было 6) — поддержка сложных составных задач
- **Авто-снимок** после каждой правки — агент всегда работает со свежим состоянием таймлайна
- **Linked A/V** — trim/remove/move/enable работают на обе дорожки одновременно

## Настройка

### API-ключ

После клонирования репозитория создайте локальный файл с ключом (он **не** попадает в Git):

```bash
cp client/shared/fm-secrets.example.js client/shared/fm-secrets.js
```

Откройте `client/shared/fm-secrets.js` и укажите `apiKey: 'ваш-ключ'`.

### Конфигурация FM

**Файл:** `client/shared/fm-defaults.js`:

| Поле | Значение по умолчанию | Описание |
|------|----------------------|----------|
| `chatModel` | `openai/gpt-oss-120b` | Модель агента |
| `codeModel` | `Qwen/Qwen3-Coder-Next` | Альтернатива (при `useCodeModelForAgent: true`) |
| `whisperModel` | `openai/whisper-large-v3` | Транскрибация |
| `exportAudioPresetPath` | `''` | Путь к .epr для экспорта In-Out |
| `exportChunkExtension` | `wav` | Расширение чанков (wav/mp3) |
| `transcribeExportChunkSec` | `90` | Длина одного чанка (сек) |
| `maxTranscribeUploadBytes` | `20971520` | Макс. размер загрузки (20 МБ) |

## Установка

### macOS

```bash
# Symlink или копия в:
~/Library/Application Support/Adobe/CEP/extensions/Extensions-LLM-Chat_Pr

# Включить отладку CEP 12:
defaults write com.adobe.CSXS.12 PlayerDebugMode 1

# Для ffmpeg (транскрибация больших файлов):
brew install ffmpeg
```

### Windows

Папка: `%AppData%\Adobe\CEP\extensions\Extensions-LLM-Chat_Pr`
Отладка: реестр `HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.12` → `PlayerDebugMode` = `1`

## Тесты

```bash
npm test
```

Автотесты покрывают валидаторы планов (`tests/*.test.mjs`). Интеграция с Premiere — только ручная проверка; итоги и риски — в `docs/premiere-extension-audit.md` и `docs/KNOWN_ISSUES_AND_TEST_GAPS.md`.

## Хост ExtendScript

Файл `host/premiere.jsx` (версия в преамбуле файла):

- Обогащённый снимок (playhead, fps, tracks, disabled, In/Out)
- Linked A/V: remove/trim/move/enable работают на все связанные дорожки
- Split через insertClip + подгонка in/out (с защитой от дубликатов)
- Маркеры с типом Chapter
- Транскрибация: In-Out чанками / очередь клипов / один файл
- Undo через системное меню

## Документация

- [docs/README.md](docs/README.md) — указатель по `docs/`
- [docs/PROJECT.md](docs/PROJECT.md) — архитектура и чек перед правками
- [docs/premiere-extension-audit.md](docs/premiere-extension-audit.md) — аудит: работает / не работает, качество STT, скорость
- [docs/PREMIERE_AI_ASSISTANT.md](docs/PREMIERE_AI_ASSISTANT.md) — продуктовое ТЗ и референсы
