/**
 * Вся конфигурация FM здесь. Ключ: client/shared/fm-secrets.js (FM_SECRETS.apiKey).
 * Панели Premiere не содержат полей настроек API/моделей.
 */
(function (global) {
  global.FM_DEFAULTS = {
    /** Хост без суффикса /v1 — cloudru-client.js добавит /v1/chat/… и /v1/audio/… */
    baseUrl: 'https://foundation-models.api.cloud.ru',

    /** Основная модель агента (чат + вызов инструментов) */
    chatModel: 'openai/gpt-oss-120b',

    /** Альтернатива для агента; включается флагом useCodeModelForAgent */
    codeModel: 'Qwen/Qwen3-Coder-Next',
    /** true — агент использует codeModel, false — chatModel */
    useCodeModelForAgent: false,

    whisperModel: 'openai/whisper-large-v3',

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
     * Длина одного WAV-чанка при экспорте In–Out с пресетом .epr (сек).
     * Меньше — меньше риск 413 у прокси/API.
     */
    transcribeExportChunkSec: 90,

    /** Макс. размер одного загружаемого файла транскрипции (байт); сверка перед POST */
    maxTranscribeUploadBytes: 20971520,

    /** Параметры chat.completions */
    chatParams: {
      max_tokens: 2500,
      temperature: 0.5,
      presence_penalty: 0,
      top_p: 0.95
    },

    /** Поля multipart для /v1/audio/transcriptions */
    transcribeParams: {
      language: 'ru',
      temperature: '0.5',
      response_format: 'verbose_json'
    }
  };
})(window);
