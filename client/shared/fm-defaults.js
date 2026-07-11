/**
 * Вся конфигурация FM здесь. Ключ: client/shared/fm-secrets.js (FM_SECRETS.apiKey).
 * Панели Premiere не содержат полей настроек API/моделей.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * КАТАЛОГ МОДЕЛЕЙ Cloud.ru Foundation Models (июнь 2026 — Phase 2)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ┌─────────────────────────────────────────┬────────┬──────────┬──────────┬────┬────┐
 * │ Модель                                  │Контекст│ Input ₽/M│Output ₽/M│ FC │ SO │
 * ├─────────────────────────────────────────┼────────┼──────────┼──────────┼────┼────┤
 * │ deepseek-ai/DeepSeek-V4-Pro      NEW    │ 1048K  │  183.00  │   732.00 │ ✓  │ ✓  │
 * │ zai-org/GLM-5.1                  NEW    │  202K  │  198.86  │   829.60 │ ✓  │ ✓  │
 * │ moonshotai/Kimi-K2.6             NEW    │  262K  │  175.68  │   725.90 │ ✓  │ ✓  │
 * │ openai/gpt-oss-120b                     │  131K  │   15.86  │    61.00 │ ✓  │ ✓  │
 * │ zai-org/GLM-4.7                 Preview  │  202K  │  549.00  │   793.00 │ ✓  │ ✓  │
 * └─────────────────────────────────────────┴────────┴──────────┴──────────┴────┴────┘
 *
 * FC = Function Calling, SO = Structured Output
 *
 * ⚠ НЕДОСТУПНЫ на текущем аккаунте (HTTP 404 при вызове, проверено 18.06.2026):
 *   zai-org/GLM-4.6, Qwen/Qwen3-235B-A22B-Instruct-2507, Qwen/Qwen3-Next-80B-A3B,
 *   Qwen/Qwen3-Coder-Next, Qwen/Qwen3-Coder-480B-A35B. НЕ назначай их на роли —
 *   404 ломает чат молча («Ответ не JSON» в клиенте).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * РЕЗУЛЬТАТЫ ЖИВЫХ ТЕСТОВ (4 июня 2026, .omc/research/...):
 * ═══════════════════════════════════════════════════════════════════════
 *
 * TEST A — Structured JSON классификация сегментов (thinking=False):
 *   • GLM-5.1:        3.65s, 6/6 segments, JSON OK
 *   • Kimi-K2.6:     18.39s, JSON FAIL (thinking burnt все 2000 tokens)
 *   • DeepSeek-V4:    6.32s, 6/6 segments, JSON OK
 *
 * TEST B — Главы для подкаста (long-context reasoning, thinking=True):
 *   • GLM-5.1:       22.80s, 5 глав, 0 EN-leak (отличное качество)
 *   • Kimi-K2.6:     24.12s, 5 глав, 0 EN-leak
 *   • DeepSeek-V4:    3.14s, 6 глав, 0 EN-leak (быстрее в 7×, чуть гранулярнее)
 *
 * TEST C — Multi-step агент tool-calling:
 *   • Все три вызывают get_timeline_snapshot корректно. GLM/Kimi быстрее.
 *
 * TEST D (критично) — Long-input probe (14K tokens):
 *   • GLM-5.1 + thinking=True : ОШИБКА (NoneType, content=null — сжёг бюджет)
 *   • GLM-5.1 + thinking=False: 0.67s OK
 *   • DeepSeek-V4: 1.58s OK без танцев с thinking
 *
 * COMPAT — DeepSeek-V4 молча игнорирует chat_template_kwargs.enable_thinking
 *   (без ошибки) — наш единый передатчик thinking-флага безопасен.
 *
 * Kimi-K2.6 не уважает chat_template_kwargs.enable_thinking (мы пробовали:
 * один и тот же тайминг 6.36s/6.65s). Используем Kimi только там, где
 * thinking приемлем. Альтернатива — adapter под Moonshot-нативный
 * extra_body.enable_thinking; пока не требуется.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * РАСПРЕДЕЛЕНИЕ РОЛЕЙ (Phase 2, 4 июня 2026):
 * ═══════════════════════════════════════════════════════════════════════
 *
 * chatModel        → zai-org/GLM-5.1            (202K, thinking=true, top FC)
 * analysisModel    → zai-org/GLM-5.1            (thinking=false ВАЖНО, см. policy)
 * chapterModel     → deepseek-ai/DeepSeek-V4-Pro (1M контекст, 7× быстрее, ru OK)
 * findMomentsModel → zai-org/GLM-5.1            (thinking=false)
 * codeModel        → deepseek-ai/DeepSeek-V4-Pro (1M контекст под кодовые ризонинги)
 * fastModel        → zai-org/GLM-4.7            (Phase 3: было gpt-oss-120b; 549/793 ₽/M)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════
 * БЕНЧМАРК 18 июня 2026 (tests/integration/benchmark-models.mjs, 5 сценариев,
 * реальные вызовы, кэш seq «2»):
 *   • GLM-4.7   5/5  2.1s  13.5K ток — быстрейший, точен (включая длительность); 549/793 ₽/M
 *   • GLM-5.1   5/5  5.2s  29.9K ток — надёжный multi-step, текущий chat/analysis
 *   • gpt-oss   5/5  4.5s  24.8K ток — НО галлюцинировал длительность (363 вместо 484с!)
 *   • Kimi-K2.6 5/5 16.0s  15.7K ток — сбалансирован, точный target
 *   • DeepSeek  5/5 39.4s  29.9K ток — дотошнее всех (23 паразита vs 1), но медленный
 *
 * Phase 3 (18.06.2026): fastModel gpt-oss-120b → GLM-4.7. Причина — gpt-oss
 * выдумывал длительность таймлайна в info-запросах (роль fast как раз отвечает
 * на «что/сколько» — врать там нельзя). GLM-4.7: быстрее, точнее (549/793 ₽/M).
 * ⚠ GLM-4.7 — preview-модель. Если её отзовут (404), верни fastModel обратно
 *   на 'openai/gpt-oss-120b' (стабильна, но проверяй факты в info-ответах).
 * ═══════════════════════════════════════════════════════════════════════
 */
(function (global) {
  global.FM_DEFAULTS = {
    /** Хост без суффикса /v1 — cloudru-client.js добавит /v1/chat/… и /v1/audio/… */
    baseUrl: 'https://foundation-models.api.cloud.ru',

    /**
     * Машиночитаемая карта тарифов Cloud.ru (₽ за 1M токенов, снято 2026-07-06).
     * Читается UsageMeter (client/shared/usage-meter.js) для подсчёта расхода сессии.
     * inPerM — вход ₽/1M токенов, outPerM — выход ₽/1M токенов.
     * ctxTokens — окно контекста модели (токены, из каталога выше) — для
     *   индикатора «% окна контекста» (Волна 2 п.2 плана усиления).
     * whisperPerSec — стоимость транскрипции, ₽ за секунду аудио.
     * Модель не в карте → 0 ₽ (токены всё равно суммируются).
     */
    pricing: {
      currency: '₽',
      models: {
        'zai-org/GLM-5.1':             { inPerM: 198.86, outPerM: 829.60, ctxTokens: 202000 },
        'deepseek-ai/DeepSeek-V4-Pro': { inPerM: 183.00, outPerM: 732.00, ctxTokens: 1048000 },
        'zai-org/GLM-4.7':             { inPerM: 549.00, outPerM: 793.00, ctxTokens: 202000 },
        'openai/gpt-oss-120b':         { inPerM: 15.86,  outPerM: 61.00,  ctxTokens: 131000 },
        'moonshotai/Kimi-K2.6':        { inPerM: 175.68, outPerM: 725.90, ctxTokens: 262000 },
        /* Vision-модели (цены из /v1/models metadata, 2026-07-11) */
        'MiniMaxAI/MiniMax-M3':        { inPerM: 240.22, outPerM: 1008.85, ctxTokens: 524000 },
        'Qwen/Qwen3.5-397B-A17B':      { inPerM: 915.00, outPerM: 1085.80, ctxTokens: 262000 }
      },
      whisperPerSec: 0.01
    },

    /**
     * Основная модель агента (чат + вызов инструментов).
     * Phase 2 (4 июня 2026): GLM-4.7 → GLM-5.1.
     * GLM-5.1: 202K контекст, top tool-calling, Interleaved Thinking.
     * В тестах (TEST C) корректно вызывает tools и с thinking=True (3.58s),
     * и с thinking=False (1.16s) — оставляем true для multi-step reasoning.
     * Цена 198.86₽/M in / 829.60₽/M out — приоритет качества над лимитами.
     *
     * Простые «вопросы» («что на таймлайне», «привет») роутятся на fastModel
     * через AgentPrompts.classifyComplexity (panel.js:3575-3579).
     */
    chatModel: 'zai-org/GLM-5.1',

    /**
     * Альтернатива для агента; включается флагом useCodeModelForAgent.
     * Phase 2: Qwen3-Coder-Next → DeepSeek-V4-Pro (1M контекст под кодовые
     * ризонинги, native tool-calling, без проблем с большим input).
     */
    codeModel: 'deepseek-ai/DeepSeek-V4-Pro',
    /** true — агент использует codeModel, false — chatModel */
    useCodeModelForAgent: false,

    /**
     * Модель для анализа транскрипта (analyze_transcript_for_cuts).
     * Классифицирует сегменты: filler/intro/outro/repeat/digression/artifact/outtake.
     * Не требует Function Calling — достаточно Structured Output (JSON).
     *
     * Phase 2: GLM-5.1. КРИТИЧНО — thinkingPolicy.analyze = false (см. TEST D:
     * GLM-5.1 + default thinking на 14K input → NoneType, content=null).
     * При thinking=false справляется за 3.65s, JSON schema OK.
     */
    analysisModel: 'zai-org/GLM-5.1',

    /**
     * Модель для построения глав (buildTopicsWithLLM).
     * Получает весь транскрипт целиком (paragraphs) и определяет темы.
     *
     * Phase 3 (19.06.2026): DeepSeek-V4-Pro → GLM-4.7. Live-баг: инструмент
     * «Главы» ЗАВИСАЛ на 180с+ — DeepSeek с thinking + json_object + max_tokens
     * до 32K непрактично медленный в интерактиве (TEST B 3.14s не воспроизвёлся
     * на реальном 10-мин транскрипте). GLM-4.7 — быстрый, FREE, качество глав на
     * русском хорошее (549/793 ₽/M). thinkingPolicy.chapter=false (см. ниже) — для structured
     * JSON thinking не нужен и рискует null-content (TEST D). ⚠ preview-модель:
     * при 404 верни 'zai-org/GLM-5.1' (thinkingPolicy.chapter оставь false).
     */
    chapterModel: 'zai-org/GLM-4.7',

    /**
     * Модель для семантического поиска (find_moments через LLM, future use).
     * Сейчас find-moments использует TF-IDF + stem-match, но при low-confidence
     * fallback подключаем LLM. Phase 2: GLM-5.1 (thinking=false, см. policy).
     */
    findMomentsModel: 'zai-org/GLM-5.1',

    /**
     * Быстрая модель для простых задач (маркеры, классификация, структура).
     * Двухмодельная стратегия: простые intent'ы → fastModel (дешевле, быстрее),
     * сложные → chatModel. Пустая строка '' — отключает routing, всегда chatModel.
     *
     * Phase 3 (18.06.2026): gpt-oss-120b → GLM-4.7. Бенчмарк показал, что
     * gpt-oss выдумывал длительность таймлайна в info-запросах (363 вместо 484с),
     * а fast-роль как раз отвечает на «что/сколько на таймлайне». GLM-4.7 —
     * FREE, 2.1s, точен. ⚠ preview: при 404 верни 'openai/gpt-oss-120b'.
     */
    fastModel: 'zai-org/GLM-4.7',

    /**
     * Vision-модель (describe_frames — описание кадров таймлайна).
     * Live-проба 11.07.2026: из 70 моделей каталога картинки реально понимают
     * только MiniMax-M3 и Qwen3.5-397B-A17B (DeepSeek-OCR-2 отвечает 200, но
     * мусор; внешние vision — 403 RBAC). MiniMax-M3: вход в ~4 раза дешевле
     * Qwen3.5 (240 vs 915 ₽/M), thinking отключаем (reasoning_optional=true).
     * ⚠ при 404 верни 'Qwen/Qwen3.5-397B-A17B'.
     */
    visionModel: 'MiniMaxAI/MiniMax-M3',

    /**
     * Whisper для облачной транскрибации (Cloud.ru Foundation Models).
     * Лимит ~20 МБ на файл; длинные диапазоны автоматически режутся через ffmpeg.
     */
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
     * Длина одного аудио-чанка (сек) при транскрибации.
     * Используется и для экспорта через .epr, и для авто-нарезки через ffmpeg
     * (когда .epr не задан и In–Out длиннее ~1.5×chunk).
     *
     * Аудит 2026-06-09: 90 → 180. При CLOUD_CONCURRENCY=20 часовое видео
     * (40×90с = 2 волны) превращается в 20×180с = 1 волну → ~2× быстрее.
     * Размеры: 180 с WAV (16 kHz mono PCM) ≈ 5.8 МБ, MP3 64k ≈ 1.4 МБ —
     * с запасом < 20 МБ лимита API.
     */
    transcribeExportChunkSec: 180,

    /**
     * Формат ffmpeg-чанков для облачной транскрибации: 'mp3' | 'wav'.
     * MP3 (libmp3lame 64k mono 16kHz) — в ~4 раза меньше WAV → быстрее upload.
     * Точность Whisper-large-v3 на речи 64k mono не страдает (смоук-тест 2026-06-09).
     * 'wav' — запасной вариант, если в сборке ffmpeg нет libmp3lame.
     */
    transcribeChunkFormat: 'mp3',

    /** Макс. размер одного загружаемого файла транскрипции (байт); сверка перед POST */
    maxTranscribeUploadBytes: 20971520,

    /**
     * Параметры chat.completions для основного агента.
     *
     * temperature: 0.1 (было 0.5) — для tool-calling нужна детерминированность.
     * Аудит май 2026 показал: 0.5 приводит к hallucinated nodeIds, странным
     * интервалам, markdown-обёрткам в JSON-аргументах. См. memory:
     * project_transcript_pipeline_audit.md HIGH#2.
     */
    chatParams: {
      max_tokens: 16000,
      temperature: 0.1,
      presence_penalty: 0,
      top_p: 0.95
    },

    /**
     * Включать thinking mode (chain-of-thought) для моделей которые его поддерживают
     * (GLM-5.1, GLM-4.7, GLM-4.6 через chat_template_kwargs.enable_thinking).
     * Для не-thinking моделей (gpt-oss-120b, Qwen3) — флаг игнорируется.
     * DeepSeek-V4-Pro молча игнорирует chat_template_kwargs (compat-test 4 июня).
     *
     * Kimi-K2.6 не уважает наш формат флага — требует нативный Moonshot
     * extra_body.enable_thinking (без обёртки). Adapter пока не реализован,
     * Kimi не назначен ни на одну роль.
     */
    enableThinking: true,

    /**
     * Phase 2 (4 июня 2026, live tests TEST A/D findings): per-role thinking.
     *
     * analyze=false — КРИТИЧНО для GLM-5.1: на длинных input (≥10K tokens)
     * с включённым thinking модель сжигает весь бюджет в reasoning_content
     * и возвращает content=null (SDK падает с NoneType). С thinking=false
     * та же задача — 0.67s на 10K input. См. TEST D.
     *
     * chapter — Phase 3: false. chapterModel=GLM-4.7, задача structured JSON;
     * thinking не нужен, замедляет и рискует null-content (как analyze, TEST D).
     *
     * chat — multi-step tool-calling (TEST C, 3.58s для GLM-5.1). Оставляем.
     * report — Phase 3: false. _generateReport использует analysisModel(GLM-5.1)
     *   + responseFormat json_object — ТА ЖЕ комбинация, что в analyze (TEST D:
     *   GLM-5.1+thinking+json на большом input → content=null/зависание). На малой
     *   сессии (1 чанк) работало с thinking, но длинная сессия (много чанков +
     *   объединяющий вызов) гарантированно попадёт в баг. Отчёт — summarization,
     *   thinking не нужен.
     *
     * Если поле undefined — fallback на enableThinking.
     */
    thinkingPolicy: {
      analyze: false,    /* GLM-5.1: иначе NoneType на больших input */
      chapter: false,    /* GLM-4.7: structured JSON, thinking не нужен и рискует null (Phase 3) */
      chat: true,        /* multi-step tool-calling — нужно */
      report: false      /* GLM-5.1 + json_object: как analyze, thinking ломает на больших сессиях (Phase 3) */
    },

    /**
     * Phase 1.5: параллельные analyze chunks. Сейчас analyze идёт sequentially
     * (chunk1 → wait → chunk2 → wait), что на 1ч видео даёт 3 chunks × 60-100с = 5 мин.
     * С параллелизмом N=3 — все 3 chunks одновременно, время = max latency = ~100с.
     * Cross-chunk bridging при этом теряется (мы не знаем выход chunk N-1 при
     * запуске chunk N), но bridging на синтетических повторах и так не работал.
     *
     * Аудит 2026-06-09: 3 → 6. Cloud.ru стабильно держит 20 параллельных
     * (CLOUD_CONCURRENCY в timeline-transcribe.js); 6 analyze-чанков — с запасом.
     * Эффект: −40-100 с на анализе 1 ч видео.
     */
    analyzeConcurrency: 6,

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

    /**
     * Поля multipart для /v1/audio/transcriptions.
     * temperature 0.1 (было 0.5, аудит 2026-06-09): ASR — детерминированная
     * задача; 0.5 давала случайные вариации границ слов и filler-детекта
     * между прогонами. 0.1 (не 0.0) — сохраняем редкие RU-произносительные
     * варианты без полного жадного декодинга.
     */
    transcribeParams: {
      language: 'ru',
      temperature: '0.1',
      response_format: 'verbose_json'
    }
  };
})(window);
