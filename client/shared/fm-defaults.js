/**
 * Вся конфигурация FM здесь. Ключ: client/shared/fm-secrets.js (FM_SECRETS.apiKey).
 * Панели Premiere не содержат полей настроек API/моделей.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ДОСТУПНО ПРОЕКТУ КЛЮЧА (живая проба 18.10.2026, /v1/models = 90 моделей)
 * ═══════════════════════════════════════════════════════════════════════
 * На проекте включён список разрешённых моделей. Чат отвечает только:
 *   zai-org/GLM-4.7                          202K  549.00 / 793.00 ₽/M  FC ✓ SO ✓
 *   MiniMaxAI/MiniMax-M2.5                   196K  353.80 / 475.80 ₽/M  FC ✓ SO ✓ (рассуждает всегда)
 *   ai-sage/GigaChat3.5-432B-A28B-Reasoning  262K   96.22 / 288.60 ₽/M  FC ✓ (рассуждает всегда,
 *     enable_thinking игнорирует; рассуждения в поле `reasoning`)
 * (+ ai-sage/Giga-Embeddings-instruct-3B и -480M — эмбеддинги.)
 * Остальные, в т.ч. openai/whisper-large-v3, MiniMax-M3, Qwen3.5-397B (vision),
 * gpt-oss-120b, DeepSeek-V4-Pro, GLM-5.1, Kimi-K2.6, отвечают 403 PLAIN TEXT
 * «Requested model is not available for this project». Включить модель проекту
 * может только администратор организации в консоли Cloud.ru. Пока Whisper и
 * vision вне проекта, транскрибация и описание кадров не работают — панель
 * говорит об этом прямо (cloudru-client: modelNotInProject).
 * НЕ назначай на роли и в modelFallbacks модели вне этого списка.
 *
 * БЕНЧМАРК 18.10.2026 (tests/integration/benchmark-models.mjs, транскрипт
 * «Нарезка Copy 01» 20.8 мин, 10 сценариев; «различающие» — без H1/H5, где
 * падают все: H1 бенч не валидирует target при removeIntervals, H5 — find_moments
 * отдаёт мимо темы):
 *   GLM-4.7      thinking=true (как в чате): 8/10, 29.0 с/сценарий (до 115 с), 40.8 ₽
 *                thinking=false:              7/10,  8.5 с,                      40.2 ₽
 *                различающие 15/16 — единственная стабильно режет по темам (H2 2/2)
 *   MiniMax-M2.5 7/10 и 7/10, 8.8–14.8 с, 25.5–31.0 ₽; различающие 14/16, H2 0/2
 *   GigaChat3.5  6/10, 28.4 с, 24.7 ₽ (втрое больше токенов на ходы)
 * Корректура (json_object, max_tokens 4096): GLM-4.7 и MiniMax 2/2 валидный JSON
 * за ~15 с; GigaChat 0/2 — бюджет уходит на рассуждения, content пустой (94 с).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * КАТАЛОГ МОДЕЛЕЙ Cloud.ru Foundation Models (июнь 2026 — Phase 2, история)
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
        /* Доступны проекту ключа с 18.10.2026 (цены из /v1/models metadata) */
        'ai-sage/GigaChat3.5-432B-A28B-Reasoning': { inPerM: 96.22, outPerM: 288.60, ctxTokens: 262144 },
        'MiniMaxAI/MiniMax-M2.5':      { inPerM: 353.80, outPerM: 475.80, ctxTokens: 196608 },
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
    /* Ревью 09.2026: GLM-5.1 отдаёт 403 «not available for this project» на аккаунте
       (живые пробы 04.08 и 02.09) — каждый ход начинался с провального вызова и
       уходил фолбэком. Дефолт — GLM-4.7 (бенчмарк 18.06: 5/5 простых, 4/5 сложных,
       быстрее GLM-5.1). Когда GLM-5.1 вернут — переключить здесь и в analysis/findMoments.
       18.10.2026: остаётся GLM-4.7 — точнее доступных альтернатив (см. бенчмарк в
       шапке); цена — ожидание с thinkingPolicy.chat=true (~29 с на запрос). */
    chatModel: 'zai-org/GLM-4.7',

    /**
     * Альтернатива для агента; включается флагом useCodeModelForAgent.
     * Phase 2: Qwen3-Coder-Next → DeepSeek-V4-Pro (1M контекст под кодовые
     * ризонинги, native tool-calling, без проблем с большим input).
     * 18.10.2026: DeepSeek-V4-Pro вне проекта ключа (403) → MiniMax-M2.5:
     * в каталоге task_type «code», 196K, tools и json_object работают
     * (бенчмарк 18.10: 7/10 в обоих прогонах, 8.8 с на сценарий в режиме чата).
     */
    codeModel: 'MiniMaxAI/MiniMax-M2.5',
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
    analysisModel: 'zai-org/GLM-4.7', /* 09.2026: GLM-5.1 = 403 на аккаунте */

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
    findMomentsModel: 'zai-org/GLM-4.7', /* 09.2026: GLM-5.1 = 403 на аккаунте */

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
     * Фолбэк-модели по недоступности (21.07.2026). Если основная модель
     * недоступна — 5xx после ретраев, 404 (снята с аккаунта), или МОЛЧАЛИВЫЙ
     * висяк до таймаута — cloudru-client переключается на первую живую из списка
     * (isModelUnavailable + attemptModel loop). НЕ триггерится на 413/400/Стоп.
     *
     * Живой инцидент 21.07.2026: GLM-5.1 ушла в офлайн и не отдавала ни 500, ни
     * ответ — сокет висел до 300с × 5 ретраев (~25 мин на «шаг 2 из 24»), пока
     * GLM-4.7 тем же пингом отвечала 200/300мс. Без фолбэка чат замирал.
     *
     * 18.10.2026: прежние цели (gpt-oss-120b, DeepSeek-V4-Pro, GLM-5.1, vision
     * Qwen3.5) вне проекта ключа — 403 «not available for this project», то есть
     * при сбое GLM-4.7 чат молча уходил в цепочку 403. Теперь цепочки только из
     * доступных (инвариант — tests/fm-defaults.test.mjs). Порядок по бенчмарку
     * 18.10: MiniMax-M2.5 первой (tools ✓, json_object ✓, самая быстрая в
     * режиме чата), GigaChat3.5 последней — самая дешёвая за токен, но
     * рассуждает всегда (enable_thinking игнорирует), втрое медленнее, а в
     * корректуре (json_object, max_tokens 4096) сжигает бюджет на рассуждения
     * и отдаёт пустой content. Цепочки — общие для чата и корректуры.
     * Vision-цепочки нет: доступных vision-моделей у проекта нет вовсе.
     */
    modelFallbacks: {
      'zai-org/GLM-4.7':        ['MiniMaxAI/MiniMax-M2.5', 'ai-sage/GigaChat3.5-432B-A28B-Reasoning'],
      'MiniMaxAI/MiniMax-M2.5': ['zai-org/GLM-4.7', 'ai-sage/GigaChat3.5-432B-A28B-Reasoning'],
      'ai-sage/GigaChat3.5-432B-A28B-Reasoning': ['zai-org/GLM-4.7', 'MiniMaxAI/MiniMax-M2.5']
    },

    /**
     * Известные рабочие модели для РУЧНОГО переключателя чата/агента (меню
     * «Ещё ▾»). Только FC-способные chat-модели (не vision/whisper). Выбор
     * переопределяет chatModel НА СЕССИЮ (не персистится, сбрасывается при
     * перезапуске панели); автоматический modelFallbacks остаётся поверх
     * выбранной модели. id = модель для API, label = подпись в UI.
     * Только модели, доступные проекту ключа: на этот список опираются роли
     * и modelFallbacks (tests/fm-defaults.test.mjs).
     */
    knownModels: [
      { id: 'zai-org/GLM-4.7', label: 'GLM-4.7 · по умолчанию, быстрая' },
      { id: 'MiniMaxAI/MiniMax-M2.5', label: 'MiniMax-M2.5 · быстрее и дешевле, слабее в нарезке по темам' },
      { id: 'ai-sage/GigaChat3.5-432B-A28B-Reasoning', label: 'GigaChat3.5 · самая дешёвая, медленная' }
    ],

    /**
     * Vision-модель (describe_frames — описание кадров таймлайна).
     * Live-проба 11.07.2026: из 70 моделей каталога картинки реально понимают
     * только MiniMax-M3 и Qwen3.5-397B-A17B (DeepSeek-OCR-2 отвечает 200, но
     * мусор; внешние vision — 403 RBAC). MiniMax-M3: вход в ~4 раза дешевле
     * Qwen3.5 (240 vs 915 ₽/M), thinking отключаем (reasoning_optional=true).
     * ⚠ при 404 верни 'Qwen/Qwen3.5-397B-A17B'.
     * 18.10.2026: MiniMax-M3 и Qwen3.5 вне проекта ключа (403), а доступные
     * модели картинок не принимают («is not a multimodal model»). Модель
     * оставлена — её и нужно включить в консоли Cloud.ru; до тех пор
     * describe_frames и vision-кадрирование рилсов сообщают «… не включена в
     * проект Cloud.ru» (рилсы кадрируют по центру).
     */
    visionModel: 'MiniMaxAI/MiniMax-M3',

    /**
     * Whisper для облачной транскрибации (Cloud.ru Foundation Models).
     * Лимит ~20 МБ на файл; длинные диапазоны автоматически режутся через ffmpeg.
     * 18.10.2026: вне проекта ключа (403; 03.09 тот же ключ получал 200).
     * Замены нет (решение пользователя — остаёмся на Cloud.ru Whisper):
     * транскрибация сообщает «Транскрибация недоступна: модель … не включена
     * в проект Cloud.ru», пока администратор не включит модель.
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
     * Потоковый (SSE) ответ для агентского цикла чата (5 августа 2026).
     *
     * Стриминг был реализован давно, но флаг нигде не выставлялся — код
     * фактически не работал. Включаем: при thinkingPolicy.chat=true GLM-5.1
     * молчит 30-45с до первого токена, и только по стриму видно, что модель
     * рассуждает, а не зависла (панель показывает это в «ходе мыслей»).
     *
     * Живая проверка 05.08.2026 (Cloud.ru, GLM-4.7): usage в стриме идентичен
     * обычному режиму (stream_options.include_usage) — бейдж расхода не врёт.
     * tool_calls собираются из дельт по index, «Стоп» прерывает read-loop.
     */
    enableStreaming: true,

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
      response_format: 'verbose_json',
      /* Ревью 09.2026: word-level тайминги (timestamp_granularities[]=word).
         false — отключить (сервер без поддержки отключается сам после 400). */
      wordTimestamps: true
    }
  };
})(window);
