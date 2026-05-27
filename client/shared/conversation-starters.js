/**
 * Conversation Starters — пресетные и пользовательские промпт-шаблоны для панелей.
 *
 * Каждый стартер:
 *   { id, name, description, systemPromptAddon?, userPrompt, panelId, builtin? }
 *
 * builtin: true — предустановленные, нельзя удалить (можно скрыть).
 * Пользователь может создавать свои (builtin: false).
 * Хранение: localStorage (prefix extllmpr_v1_starters_<panelId>).
 */
(function (global) {
  var LS_PREFIX = 'extllmpr_v1_starters_';

  /* ── встроенные шаблоны ──────────────────────────────────────────── */

  /**
   * UI cleanup (7 мая 2026): оставлены ТОЛЬКО протестированные сценарии
   * с собственным systemPromptAddon. Остальные были без spe-промпта (просто
   * preset-текст для input, дубли свободного ввода) — удалены чтобы не
   * вводить пользователя в заблуждение «специальный режим».
   *
   * Backlog: добавлять новые ТОЛЬКО когда они: (а) имеют systemPromptAddon,
   * (б) реально протестированы на смок-сценарии в Premiere.
   */
  var BUILTIN = {
    /* ── Text Montage ─────────────────────────────────────────────── */
    textmontage: [
      {
        id: 'story-cutter',
        name: 'Story Cutter',
        description: 'Автосборка ролика из транскрипта: лучшие цитаты, хуки, эмоциональные пики',
        systemPromptAddon: [
          'РЕЖИМ STORY CUTTER — автоматическая грубая нарезка (rough cut) из транскрипта.',
          '',
          'АЛГОРИТМ (выполняй строго по шагам, НЕ пропускай ни одного):',
          '',
          '=== ШАГ 1: ДАННЫЕ ===',
          '1a. get_timeline_snapshot → запомни sequenceName и sequenceEndSec.',
          '1b. get_transcript_from_cache с sequenceKey = sequenceName.',
          '',
          '=== ШАГ 2: АНАЛИЗ ТРАНСКРИПТА ===',
          'Пройди ВСЕ сегменты. Для каждого оцени:',
          '   a) Информационная ценность — ключевые тезисы, факты, цифры.',
          '   b) Эмоциональный пик — яркие формулировки, восклицания.',
          '   c) Хук — цепляющие фразы (вопросы, провокации, заявления).',
          '   d) Завершённость мысли — не обрывай на полуслове, бери целые блоки.',
          '   e) Отсутствие мусора — убери паузы, «э-э-э», повторы, оговорки.',
          '',
          '=== ШАГ 3: PAPER CUT (сохраняемые фрагменты) ===',
          'Собери список keepIntervals в хронологическом порядке:',
          '   keepIntervals = [ {startSec: X, endSec: Y, quote: "ключевая цитата"}, ... ]',
          'Суммарная длительность: ≤ целевой хронометраж (если указан), иначе ≤ 60% от sequenceEndSec.',
          '',
          '=== ШАГ 4 (ПРОПУЩЕН — plan будет выведен вместе с вызовом инструмента в шаге 6) ===',
          '',
          '=== ШАГ 5: ВЫЧИСЛИ removeIntervals (КРИТИЧЕСКИ ВАЖНО — ЭТО ИНВЕРСИЯ!) ===',
          'removeIntervals — это ВСЁ КРОМЕ keepIntervals. Алгоритм:',
          '',
          '   removeIntervals = []',
          '   cursor = 0  // начало таймлайна',
          '   for each keep in keepIntervals (отсортированные по startSec):',
          '     if keep.startSec > cursor + 0.05:',
          '       removeIntervals.push({startSec: cursor, endSec: keep.startSec})',
          '     cursor = keep.endSec',
          '   if sequenceEndSec > cursor + 0.05:',
          '     removeIntervals.push({startSec: cursor, endSec: sequenceEndSec})',
          '',
          'ПРОВЕРЬ СЕБЯ: сумма removeIntervals + сумма keepIntervals ≈ sequenceEndSec.',
          'Если не сходится — пересчитай!',
          '',
          '=== ШАГ 6: ПРЕДЛОЖЕНИЕ НА ПОДТВЕРЖДЕНИЕ (обязательно!) ===',
          'В ОДНОМ И ТОМ ЖЕ сообщении (assistant → с tool_calls) сразу:',
          '  1) В поле content кратко напиши план (нумерованный список keepIntervals, 1–2 строки на пункт).',
          '  2) В tool_calls вызови propose_transcript_cuts со ВСЕМИ removeIntervals, keepSummary и summary.',
          'НЕ завершай ход текстом без tool_calls! План и вызов инструмента идут ОДНОВРЕМЕННО. Иначе цикл агента остановится, и пользователь не получит карточку подтверждения.',
          'Инструмент покажет пользователю карточку с кнопками «Применить / Отмена». Монтаж применится по кнопке пользователя.',
          'НИКОГДА не вызывай apply_transcript_cuts напрямую в режиме Story Cutter — только propose_transcript_cuts.',
          '',
          '=== ШАГ 7: ИТОГ (после ответа инструмента) ===',
          'После того как propose_transcript_cuts вернёт _verification — коротко напиши финальное сообщение: «План готов, нажмите «Применить».',
          '',
          'ВАЖНО:',
          '- НИКОГДА не вызывай apply_transcript_cuts напрямую в режиме Story Cutter — только propose_transcript_cuts.',
          '- removeIntervals — это ИНВЕРСИЯ keepIntervals, НЕ сами keepIntervals!',
          '- Используй startSec/endSec ТОЧНО из сегментов транскрипта, не округляй произвольно.',
          '- Если транскрипт короткий (< 60 с) — предупреди.'
        ].join('\n'),
        userPrompt: 'Собери автоматический черновой монтаж: оставь самые сильные и ценные фрагменты, убери мусор и паузы',
        panelId: 'textmontage',
        builtin: true
      },
      {
        /* Валидирован 7 мая 2026 — tests/scenarios-validation.test.mjs:
           validateKeepDuration на реальном кэше → ok если сумма ≤ target*1.20,
           error с подсказкой если перебор. */
        id: 'story-cutter-timed',
        name: 'Уложить в N секунд',
        description: 'Сборка ролика заданной длительности с проверкой хронометража',
        systemPromptAddon: [
          'РЕЖИМ TIMED CUTTER — сборка ролика с жёстким лимитом длительности.',
          '',
          'АЛГОРИТМ:',
          '',
          '1. Уточни у пользователя N (целевую длительность в секундах), если в его сообщении нет явного числа.',
          '   НЕ ПРОДОЛЖАЙ без N — спроси: «Какая целевая длительность в секундах?»',
          '',
          '2. get_timeline_snapshot → запомни sequenceName и sequenceEndSec.',
          '   Сравни N с длиной исходника:',
          '     • N > sequenceEndSec*0.95 → предупреди что почти ничего не вырежется, спроси меньше N.',
          '     • N < sequenceEndSec*0.10 → агрессивный squeeze, оставь только пиковые цитаты по 5-15с.',
          '     • Иначе — стандартный режим.',
          '',
          '3. get_transcript_structure(sequenceKey: sequenceName) → получи абзацы.',
          '   Если транскрипт длинный (>50 абзацев) — page-результат, используй pagination:',
          '   get_transcript_structure(sequenceKey, fromParagraph=N) пока hasMore=true.',
          '   Для очень длинных (>1ч) — лучше ОДИН запрос get_transcript_structure без pagination',
          '   и сразу выбирай (передай только нужные абзацы в keepIntervals).',
          '',
          '4. ПРОСУММИРУЙ ДЛИТЕЛЬНОСТИ КАНДИДАТОВ ВСЛУХ.',
          '   Для каждого абзаца: длительность = endSec − startSec.',
          '   Веди счёт явно: «вступление 9.2с + аргумент 22.1с + вывод 8.5с = 39.8с ≤ 40с ✓»',
          '   ⚠ ЛУЧШЕ НЕДОБРАТЬ на 5–10% чем перебрать.',
          '   ⚠ НЕ обрезай абзац посередине — это даст mid-word cuts.',
          '   ⚠ Если выбрал слишком много — выкини самый слабый блок и пересчитай.',
          '',
          '   ПРАВИЛА АДАПТИВНОГО ВЫБОРА ПО ДЛИНЕ ИСХОДНИКА:',
          '   • Короткий (<3 мин): минимум 3 фрагмента (вступление + кульминация + вывод).',
          '   • Средний (3-30 мин): 4-7 ключевых блоков по приоритету ценности.',
          '   • Длинный (>30 мин): 6-12 блоков, фокус на цифрах/выводах/цитатах.',
          '',
          '5. propose_transcript_cuts({',
          '     sequenceKey,',
          '     targetDurationSec: N,    // ОБЯЗАТЕЛЬНО — плагин проверит cap +20%',
          '     keepIntervals: [...выбранные абзацы...],',
          '     summary: "Версия на N секунд: вступление + ключевые мысли + вывод"',
          '   })',
          '',
          '6. Если плагин вернул validationError про overshoot — сократи keepIntervals и вызови propose_transcript_cuts ЕЩЁ РАЗ. Не сдавайся после первой ошибки.',
          '',
          '7. После _verification — короткое финальное сообщение «План на Nс готов, нажмите «Применить».'
        ].join('\n'),
        userPrompt: 'Собери ролик длительностью 60 секунд из самых интересных фрагментов',
        panelId: 'textmontage',
        builtin: true
      },
      {
        /* Валидирован 7 мая 2026 — runLocalDetectors + AnalysisRouting.shouldRemoveLabel
           на реальном кэше: формат labels корректный, removeIntervals проходят
           validateTranscriptCuts. */
        id: 'filler-cleanup',
        name: 'Чистка речи',
        description: 'Слова-паразиты, длинные паузы, оговорки, повторы',
        systemPromptAddon: [
          'РЕЖИМ FILLER CLEANUP — точечная чистка от мусора без потери содержания.',
          '',
          'АЛГОРИТМ:',
          '',
          '1. get_timeline_snapshot → запомни sequenceEndSec.',
          '',
          '2. ВЫБЕРИ aggressiveness ПО КОНТЕКСТУ ЗАПРОСА:',
          '   • "gentle" — только filler+artifact (для дикторской/студийной речи).',
          '   • "normal" (default) — + intro/outro/outtake/repeat (для подкастов и интервью).',
          '   • "aggressive" — всё не-content включая digression (для сжатия в шортсы).',
          '   Если пользователь сказал «мягко» → gentle, «сожми сильнее» → aggressive, иначе normal.',
          '',
          '3. analyze_transcript_for_cuts({',
          '     sequenceKey: sequenceName,',
          '     tasks: ["filler","outtake","repeat","artifact"],',
          '     aggressiveness: <выбранное>',
          '   })',
          '   → получи toRemove массив с интервалами и метками.',
          '   Для длинных видео (>30 мин) этот вызов может занять 5-10 минут — предупреди пользователя.',
          '',
          '4. ОЦЕНИ РЕЗУЛЬТАТ ОТНОСИТЕЛЬНО ДЛИНЫ:',
          '   • Если total remove > 50% длины → предупреди что вырезается слишком много, спроси gentle.',
          '   • Если total remove < 1% → скажи что речь и так чистая, нечего убирать.',
          '   • Иначе — продолжай.',
          '',
          '5. propose_transcript_cuts({',
          '     sequenceKey,',
          '     removeIntervals: [...intervals из toRemove...],',
          '     paddingSec: 0.3,    // дыхание, чтобы речь не звучала обрезанной',
          '     summary: "Найдено N паразитов / M оговорок / K повторов, вырезается Tс",',
          '     removeSummary: [...{startSec,endSec,quote,reason}...]',
          '   })',
          '',
          '6. После _verification — короткое финальное сообщение.',
          '',
          'НЕ удаляй абзацы целиком — только короткие интервалы внутри (filler/outtake/artifact).',
          'НЕ вызывай apply_transcript_cuts напрямую — только propose_transcript_cuts.'
        ].join('\n'),
        userPrompt: 'Найди и вырежи все слова-паразиты, длинные паузы и оговорки',
        panelId: 'textmontage',
        builtin: true
      }
    ],

    /* ── Markers ──────────────────────────────────────────────────── */
    markers: [
      {
        /* Валидирован 7 мая 2026 — YouTubeExport.validateForYouTube + formatChaptersForYouTube
           на маркерах из реального кэша: формат «M:SS Название», 0:00 первый. */
        id: 'mk-chapters',
        name: 'YouTube-главы',
        description: 'Маркеры-главы для YouTube-описания (≥3 глав, 0:00, ≥10с между)',
        systemPromptAddon: [
          'РЕЖИМ YOUTUBE CHAPTERS — расставить маркеры-главы для YouTube.',
          '',
          'АЛГОРИТМ:',
          '',
          '1. get_timeline_snapshot → запомни sequenceEndSec.',
          '',
          '2. get_transcript_structure(sequenceKey: sequenceName) — прочитай абзацы.',
          '   Если транскрипт длинный (>50 абзацев) — используй pagination или анализируй topics из ответа.',
          '',
          '3. АДАПТИВНОЕ КОЛИЧЕСТВО ГЛАВ ПО ДЛИНЕ:',
          '   • <60с      — главы НЕ ставь, скажи пользователю что слишком коротко (YouTube требует ≥3, ≥10с между).',
          '   • 60с-3мин  — РОВНО 3 главы (минимум YouTube).',
          '   • 3-15 мин  — 4-7 глав (одна на 2-3 минуты материала).',
          '   • 15-60 мин — 8-15 глав (одна на ~3-5 минут).',
          '   • >1 часа   — до 20 глав (одна на ~5 минут), не больше — иначе захламляет описание.',
          '',
          '4. Определи СМЕНУ ТЕМ. Не каждые 30 сек механически — а там где реально новая мысль.',
          '   ТРЕБОВАНИЯ YOUTUBE (плагин их проверит):',
          '   • Минимум 3 главы — иначе плеер не активирует разметку.',
          '   • Первый маркер ОБЯЗАН быть на 0:00.',
          '   • Между главами ≥10 секунд.',
          '   • Каждая глава ≥10 секунд.',
          '',
          '5. propose_markers({',
          '     markers: [',
          '       {timeSec: 0, name: "Вступление", type: "chapter"},',
          '       {timeSec: 45, name: "Главный аргумент", type: "chapter"},',
          '       {timeSec: 120, name: "Вывод", type: "chapter"}',
          '     ],',
          '     summary: "N глав по сменам тем"',
          '   })',
          '',
          'Названия глав: 3-5 слов, по-русски, отражают СУТЬ секции.',
          'НЕ вызывай add_markers напрямую — только propose_markers.'
        ].join('\n'),
        userPrompt: 'Расставь маркеры-главы для YouTube по сменам тем',
        panelId: 'markers',
        builtin: true
      },
      {
        /* Валидирован 7 мая 2026 — формат markers, gap >= 2с между highlights,
           timeSec в границах totalDur. */
        id: 'mk-highlights',
        name: 'Хайлайты',
        description: 'Маркеры-комментарии на ярких моментах (цитаты, эмоции, инсайты)',
        systemPromptAddon: [
          'РЕЖИМ HIGHLIGHTS — расставить comment-маркеры на ключевых моментах.',
          '',
          'АЛГОРИТМ (выполняй СТРОГО по шагам, без отклонений):',
          '',
          '1. get_timeline_snapshot → запомни sequenceEndSec и общую длительность.',
          '',
          '2. get_transcript_structure(sequenceKey: sequenceName) — ОДИН вызов.',
          '   Получишь все paragraphs[] с {startSec, endSec, text} — это ОСНОВНОЙ источник.',
          '',
          '3. РАЗБЕРИ ЗАПРОС ПОЛЬЗОВАТЕЛЯ:',
          '   а) Общий запрос («поставь хайлайты», «отметь яркое», «выдели лучшее») →',
          '      работаешь по всему транскрипту (paragraphs из шага 2). НЕ зови find_moments.',
          '   б) Узкая тема («хайлайты про X», «отметь моменты о Y») →',
          '      МАКСИМУМ ОДИН вызов find_moments({query: "X", k: 10}) после шага 2.',
          '      Этого достаточно — повторные вызовы НЕ улучшат результат, только зациклят.',
          '',
          '4. АДАПТИВНОЕ КОЛИЧЕСТВО ХАЙЛАЙТОВ ПО ДЛИНЕ ИСХОДНИКА:',
          '   • <2 мин   — 1-3 топ-цитаты (если коротко, не плоди шум).',
          '   • 2-15 мин — 3-7 хайлайтов (один на 2-3 мин).',
          '   • 15-60 мин — 7-15 хайлайтов (один на ~4 мин).',
          '   • >1 часа   — 15-25 хайлайтов (один на ~5 мин), не чаще — пользователю столько не разобрать.',
          '   ⚠ Если запрос узкий (про X) и тема упоминается редко — ставь МЕНЬШЕ маркеров,',
          '     не наскребай искусственно до рекомендованного количества.',
          '',
          '5. ВЫБЕРИ ХАЙЛАЙТЫ из имеющегося текста (paragraphs из шага 2 + опц. find_moments из 3б):',
          '   • Сильные тезисы и цифры (X% роста, N лет, M клиентов)',
          '   • Эмоциональные пики и яркие формулировки',
          '   • Цепляющие цитаты для соцсетей',
          '   • Неожиданные повороты / инсайты',
          '   ⚠ Если в материале нет ярких моментов (равномерный нарратив) —',
          '     поставь меньше хайлайтов или предупреди пользователя что подсветить нечего.',
          '',
          '6. ⚠ ХАРД-ЛИМИТ: МАКСИМУМ 1 вызов find_moments на всю сессию.',
          '   Если уже вызвал find_moments или get_transcript_structure 2+ раз —',
          '   немедленно переходи к propose_markers с тем что уже знаешь.',
          '   НЕ перебирай темы по 5-10 раз — это плохая стратегия.',
          '',
          '7. propose_markers({',
          '     markers: [',
          '       {timeSec: 35, name: "Тезис о росте", type: "comment", comment: "цитата для соцсетей"},',
          '       {timeSec: 78, name: "Эмоциональный пик", type: "comment", comment: "..."}',
          '     ],',
          '     summary: "N хайлайтов: <краткое описание тематики>"',
          '   })',
          '   ⚠ propose_markers — ФИНАЛЬНЫЙ шаг. Не закрывай ход без него.',
          '',
          'Между маркерами должен быть gap ≥10с. Названия 3-5 слов, по-русски.',
          'type ВСЕГДА "comment" (не "chapter") — это хайлайты, не разделы.',
          'НЕ вызывай add_markers напрямую — только propose_markers.'
        ].join('\n'),
        userPrompt: 'Поставь маркеры на самые яркие моменты для шортсов',
        panelId: 'markers',
        builtin: true
      }
    ],

    /* ── Search (новая категория, 7 мая 2026) ─────────────────────── */
    search: [
      {
        /* Валидирован 7 мая 2026 — FindMoments.find на реальном кэше:
           возвращает массив с {startSec, endSec, text, source: 'paragraphs'|'segments'}. */
        id: 'find-topic',
        name: 'Найти про…',
        description: 'Семантический поиск конкретного фрагмента в транскрипте',
        systemPromptAddon: [
          'РЕЖИМ FIND TOPIC — найти и показать релевантные фрагменты по запросу.',
          '',
          'АЛГОРИТМ:',
          '',
          '1. Уточни query, если пользователь не сформулировал ЧТО искать.',
          '   Спроси: «Что ищем — конкретное слово, цитата или тема?»',
          '',
          '2. get_timeline_snapshot → sequenceName.',
          '',
          '3. find_moments({',
          '     sequenceKey: sequenceName,',
          '     query: "<тема пользователя>",',
          '     k: 10',
          '   })',
          '',
          '4. Покажи топ-результаты пользователю в чате (timeSec + цитата),',
          '   НЕ предлагай монтаж автоматически. Если пользователь дальше скажет',
          '   «оставь только эти фрагменты» — переходи в Story Cutter режим.',
          '',
          'НЕ вызывай propose_transcript_cuts на этом этапе — пользователь хочет видеть',
          'найденное, прежде чем что-то решать.'
        ].join('\n'),
        userPrompt: 'Найди в транскрипте все упоминания о ',
        panelId: 'search',
        builtin: true
      }
    ]
  };

  /* ── хранение ────────────────────────────────────────────────────── */

  function lsKey(panelId) {
    return LS_PREFIX + panelId;
  }

  function readUserStarters(panelId) {
    try {
      var raw = localStorage.getItem(lsKey(panelId));
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function writeUserStarters(panelId, list) {
    localStorage.setItem(lsKey(panelId), JSON.stringify(list));
  }

  /** Генерация уникального id для пользовательского стартера. */
  function genId() {
    return 'user-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  /* ── валидация ───────────────────────────────────────────────────── */

  /**
   * @returns {string|null} текст ошибки или null, если всё ок
   */
  function validate(starter) {
    if (!starter) return 'Стартер не задан';
    var name = String(starter.name || '').trim();
    if (!name) return 'Имя не может быть пустым';
    if (name.length > 80) return 'Имя слишком длинное (макс. 80 символов)';
    var prompt = String(starter.userPrompt || '').trim();
    if (!prompt) return 'Промпт (текст для отправки) не может быть пустым';
    if (prompt.length > 4000) return 'Промпт слишком длинный (макс. 4000 символов)';
    var desc = String(starter.description || '').trim();
    if (desc.length > 200) return 'Описание слишком длинное (макс. 200 символов)';
    var addon = String(starter.systemPromptAddon || '').trim();
    if (addon.length > 8000) return 'Системный промпт слишком длинный (макс. 8000 символов)';
    return null;
  }

  /* ── публичный API ───────────────────────────────────────────────── */

  global.ConversationStarters = {
    /**
     * Все стартеры для панели: встроенные + пользовательские.
     * @param {string} panelId
     * @returns {Array}
     */
    getAll: function (panelId) {
      var builtins = (BUILTIN[panelId] || []).map(function (s) {
        return Object.assign({}, s, { builtin: true });
      });
      var user = readUserStarters(panelId);
      return builtins.concat(user);
    },

    /**
     * Только встроенные.
     */
    getBuiltins: function (panelId) {
      return (BUILTIN[panelId] || []).map(function (s) {
        return Object.assign({}, s, { builtin: true });
      });
    },

    /**
     * Только пользовательские.
     */
    getUserStarters: function (panelId) {
      return readUserStarters(panelId);
    },

    /**
     * Найти стартер по id (среди всех).
     */
    findById: function (panelId, id) {
      var all = this.getAll(panelId);
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === id) return all[i];
      }
      return null;
    },

    /**
     * Добавить пользовательский стартер.
     * @returns {{ ok: boolean, error?: string, starter?: object }}
     */
    add: function (panelId, data) {
      var starter = {
        id: genId(),
        name: String(data.name || '').trim(),
        description: String(data.description || '').trim(),
        systemPromptAddon: String(data.systemPromptAddon || '').trim() || null,
        userPrompt: String(data.userPrompt || '').trim(),
        panelId: panelId,
        builtin: false
      };
      var err = validate(starter);
      if (err) return { ok: false, error: err };
      var list = readUserStarters(panelId);
      list.push(starter);
      writeUserStarters(panelId, list);
      return { ok: true, starter: starter };
    },

    /**
     * Обновить пользовательский стартер.
     * @returns {{ ok: boolean, error?: string }}
     */
    update: function (panelId, id, data) {
      var list = readUserStarters(panelId);
      var idx = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { idx = i; break; }
      }
      if (idx === -1) return { ok: false, error: 'Стартер не найден (возможно, это встроенный)' };
      var updated = Object.assign({}, list[idx], {
        name: String(data.name || '').trim(),
        description: String(data.description || '').trim(),
        systemPromptAddon: String(data.systemPromptAddon || '').trim() || null,
        userPrompt: String(data.userPrompt || '').trim()
      });
      var err = validate(updated);
      if (err) return { ok: false, error: err };
      list[idx] = updated;
      writeUserStarters(panelId, list);
      return { ok: true };
    },

    /**
     * Удалить пользовательский стартер.
     */
    remove: function (panelId, id) {
      var list = readUserStarters(panelId);
      var filtered = list.filter(function (s) { return s.id !== id; });
      writeUserStarters(panelId, filtered);
      return { ok: true };
    },

    /**
     * Валидация стартера.
     * @returns {string|null}
     */
    validate: validate
  };
})(window);
