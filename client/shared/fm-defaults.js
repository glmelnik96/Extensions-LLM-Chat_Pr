/**
 * Вся конфигурация FM здесь. Ключ: client/shared/fm-secrets.js (FM_SECRETS.apiKey).
 * Панели Premiere не содержат полей настроек API/моделей.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * КАТАЛОГ МОДЕЛЕЙ Cloud.ru Foundation Models (апрель 2026)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ┌─────────────────────────────────────────┬────────┬──────────┬──────────┬────┬────┐
 * │ Модель                                  │Контекст│ Input ₽/M│Output ₽/M│ FC │ SO │
 * ├─────────────────────────────────────────┼────────┼──────────┼──────────┼────┼────┤
 * │ openai/gpt-oss-120b                     │  131K  │   15.86  │    61.00 │ ✓  │ ✓  │
 * │ Qwen/Qwen3-Coder-Next          Preview  │  262K  │  FREE    │   FREE   │ ✓  │ ✓  │
 * │ Qwen/Qwen3-Coder-480B-A35B-Instruct    │  262K  │   48.80  │    97.60 │ ✓  │ ✓  │
 * │ Qwen/Qwen3-235B-A22B-Instruct-2507     │  262K  │   20.74  │    61.00 │ ✓  │ ✓  │
 * │ Qwen/Qwen3-Next-80B-A3B-Instruct       │  262K  │   13.42  │   130.54 │ ✓  │ ✓  │
 * │ zai-org/GLM-4.7                 Preview  │  202K  │  FREE    │   FREE   │ ✓  │ ✓  │
 * │ zai-org/GLM-4.7-Flash          Preview  │  202K  │  FREE    │   FREE   │ ✓  │ ✓  │
 * │ zai-org/GLM-4.6                         │  202K  │   67.10  │   268.40 │ ✓  │ ✓  │
 * │ MiniMax/MiniMax-M2                      │  196K  │   40.26  │   158.60 │ ✓  │ ✓  │
 * │ t-tech/T-pro-it-2.1            Preview  │   40K  │  FREE    │   FREE   │ ✓  │ ✓  │
 * │ t-tech/T-pro-it-2.0                     │   40K  │   26.84  │    52.46 │ ✓  │ ✓  │
 * │ t-tech/T-lite-it-2.1           Preview  │   40K  │  FREE    │   FREE   │    │ ✓  │
 * │ t-tech/T-lite-it-1.0                    │   32K  │    1.76  │     3.51 │    │ ✓  │
 * │ t-tech/T-pro-it-1.0                     │   32K  │   63.44  │   126.88 │    │ ✓  │
 * └─────────────────────────────────────────┴────────┴──────────┴──────────┴────┴────┘
 *
 * FC = Function Calling, SO = Structured Output
 * FREE = бесплатно на момент Preview
 *
 * РЕКОМЕНДАЦИИ ПО РОЛЯМ:
 *
 * chatModel (основной агент — нужен FC + SO + надёжность):
 *   • openai/gpt-oss-120b      — проверен, стабильный, 131K контекста
 *   • Qwen/Qwen3-Coder-Next    — 262K, бесплатный (Preview), хорош для кода
 *   • zai-org/GLM-4.7           — 202K, бесплатный (Preview), хорош для русского
 *
 * analysisModel (анализ транскрипта — нужен SO, желательно FC, большой контекст):
 *   • zai-org/GLM-4.7-Flash     — 202K, бесплатный, быстрый — ЛУЧШИЙ для анализа
 *   • t-tech/T-pro-it-2.1       — 40K, бесплатный (Preview), хватает для чанков
 *   • Qwen/Qwen3-Next-80B-A3B   — 262K, дёшево на вход, FC+SO
 *
 * codeModel (альтернатива агента для code-задач):
 *   • Qwen/Qwen3-Coder-Next     — 262K, бесплатный, оптимизирован для кода
 *   • Qwen/Qwen3-Coder-480B-A35B-Instruct — 262K, платный, топ-качество
 * ═══════════════════════════════════════════════════════════════════════
 */
(function (global) {
  global.FM_DEFAULTS = {
    /** Хост без суффикса /v1 — cloudru-client.js добавит /v1/chat/… и /v1/audio/… */
    baseUrl: 'https://foundation-models.api.cloud.ru',

    /**
     * Основная модель агента (чат + вызов инструментов).
     * Требует Function Calling. 131K контекста — хватает для большинства задач.
     */
    chatModel: 'openai/gpt-oss-120b',

    /**
     * Альтернатива для агента; включается флагом useCodeModelForAgent.
     * 262K контекст, бесплатный Preview, оптимизирован для кода.
     */
    codeModel: 'Qwen/Qwen3-Coder-Next',
    /** true — агент использует codeModel, false — chatModel */
    useCodeModelForAgent: false,

    /**
     * Модель для анализа транскрипта (analyze_transcript_for_cuts, buildTopicsWithLLM).
     * Классифицирует абзацы: filler/intro/outro/repeat/digression.
     * Не требует Function Calling — достаточно Structured Output (JSON).
     *
     * GLM-4.7-Flash: 202K контекст, бесплатный, быстрый — идеален для анализа.
     * Пустая строка '' — используется та же модель, что и для агента.
     */
    analysisModel: 'zai-org/GLM-4.7-Flash',

    /** Whisper для облачной транскрибации */
    whisperModel: 'openai/whisper-large-v3',

    /**
     * Бэкенд транскрибации:
     *   'whisper.cpp' — локальный whisper.cpp (бесплатно, без 413, оффлайн).
     *                   Требует установленный бинарник whisper-cli и модель ggml-*.bin.
     *   'cloud'       — облачный Whisper через cloud.ru Foundation Models.
     *                   Лимит ~20 МБ на файл; длинные диапазоны автоматически
     *                   режутся через ffmpeg.
     * По умолчанию используем локальный бэкенд.
     */
    transcribeBackend: 'whisper.cpp',

    /**
     * Абсолютный путь к whisper-cli. Пусто — автопоиск:
     *   ~/whisper.cpp/build/bin/whisper-cli, /opt/homebrew/bin/whisper-cli, ...
     * Явно прописать стоит, если бинарник лежит в нестандартной директории.
     */
    whisperCppBin: '',

    /**
     * Абсолютный путь к модели ggml-*.bin. Пусто — автопоиск:
     *   ~/whisper.cpp/models/ggml-medium.bin (приоритет), затем large-v3, small, base.
     * Рекомендуем medium для русского (1.5 GB, хороший компромисс качества/скорости).
     */
    whisperCppModel: '',

    /** Язык распознавания для whisper.cpp. 'auto' — автоопределение. */
    whisperCppLanguage: 'ru',

    /** Число потоков whisper-cli (0 — default самого whisper.cpp). */
    whisperCppThreads: 0,

    /** Дополнительные флаги whisper-cli (array строк). Например ['-bs','5','-bo','5']. */
    whisperCppExtraArgs: [],

    /**
     * Сдвиг таймкодов (сек) — для старых сценариев; при транскрибации In–Out смещение берётся из секвенции.
     */
    transcriptTimelineOffsetSec: 0,

    /**
     * Абсолютный путь к .epr (только аудио) для экспорта области In–Out.
     * Пусто — используется host/presets/TimelineAudio.epr, если файл существует.
     * Рекомендуется: пресет с MP3 (128 kbps mono) — файлы в ~10 раз меньше WAV,
     * меньше риск 413 от API. Создайте пресет через File → Export → Media → Audio Only → MP3.
     */
    exportAudioPresetPath: '',

    /**
     * Расширение файла для экспортированных чанков (должно соответствовать пресету .epr).
     * 'wav' для WAV-пресета, 'mp3' для MP3-пресета.
     */
    exportChunkExtension: 'wav',

    /** Макс. длина исходного медиа (сек) для прямого пути к файлу без экспорта */
    maxDirectTranscribeMediaSec: 3600,

    /**
     * Длина одного аудио-чанка (сек) при транскрибации.
     * Используется и для экспорта через .epr, и для авто-нарезки через ffmpeg
     * (когда .epr не задан и In–Out длиннее ~1.5×chunk). При 16 kHz mono PCM
     * 90 с ≈ 2.9 МБ — гарантированно < 20 МБ лимита API.
     */
    transcribeExportChunkSec: 90,

    /** Макс. размер одного загружаемого файла транскрипции (байт); сверка перед POST */
    maxTranscribeUploadBytes: 20971520,

    /** Параметры chat.completions для основного агента */
    chatParams: {
      max_tokens: 8000,
      temperature: 0.5,
      presence_penalty: 0,
      top_p: 0.95
    },

    /**
     * Максимум сообщений в истории чата панели, которые отправляются в FM при каждом запросе.
     * Старые сообщения автоматически усекаются (system + последние N сохраняются).
     */
    maxChatHistoryMessages: 60,

    /**
     * Максимум шагов агента (tool-call циклов) на одно пользовательское сообщение.
     * Если превышен — агент завершает текстом «достигнут лимит, продолжите новым сообщением».
     */
    maxAgentSteps: 24,

    /** Поля multipart для /v1/audio/transcriptions */
    transcribeParams: {
      language: 'ru',
      temperature: '0.5',
      response_format: 'verbose_json'
    }
  };
})(window);
