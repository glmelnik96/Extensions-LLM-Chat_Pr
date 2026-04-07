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
        id: 'story-cutter-timed',
        name: 'Story Cutter (по хронометражу)',
        description: 'Сборка ролика заданной длительности',
        systemPromptAddon: null,
        userPrompt: 'Собери ролик длительностью примерно 60 секунд из самых интересных фрагментов транскрипта',
        panelId: 'textmontage',
        builtin: true
      },
      {
        id: 'filler-words',
        name: 'Чистка речи',
        description: 'Убрать слова-паразиты, паузы, оговорки',
        systemPromptAddon: null,
        userPrompt: 'Найди и вырежи все слова-паразиты (ээ, ну, типа, короче, так сказать), длинные паузы между фразами и явные оговорки/повторы',
        panelId: 'textmontage',
        builtin: true
      },
      {
        id: 'remove-intro-outro',
        name: 'Без вступления и финала',
        description: 'Убрать вводные и заключительные части',
        systemPromptAddon: null,
        userPrompt: 'Убери вступительную часть (приветствия, «сегодня поговорим о…») и финальную (прощания, призывы подписаться). Оставь только основной контент',
        panelId: 'textmontage',
        builtin: true
      }
    ],

    /* ── Timecode ─────────────────────────────────────────────────── */
    timecode: [
      {
        id: 'tc-overview',
        name: 'Обзор таймлайна',
        description: 'Показать все клипы с таймкодами',
        systemPromptAddon: null,
        userPrompt: 'Покажи все клипы на секвенции: имена, время начала и конца, длительность',
        panelId: 'timecode',
        builtin: true
      },
      {
        id: 'tc-cleanup',
        name: 'Подчистить концы',
        description: 'Обрезать пустые хвосты клипов',
        systemPromptAddon: null,
        userPrompt: 'Посмотри на таймлайн: если у клипов в конце пустое место (клип длиннее, чем нужно), подрежь хвосты',
        panelId: 'timecode',
        builtin: true
      }
    ],

    /* ── Markers ──────────────────────────────────────────────────── */
    markers: [
      {
        id: 'mk-chapters',
        name: 'YouTube-главы',
        description: 'Автоматические chapter-маркеры для YouTube',
        systemPromptAddon: null,
        userPrompt: 'Расставь маркеры-главы (type=chapter) по смене тем для YouTube. Название каждой главы — 3-5 слов, описывающих тему. Минимум 30 секунд между главами',
        panelId: 'markers',
        builtin: true
      },
      {
        id: 'mk-highlights',
        name: 'Хайлайты',
        description: 'Маркеры на ключевых моментах',
        systemPromptAddon: null,
        userPrompt: 'Поставь маркеры на самые яркие и интересные моменты: сильные тезисы, эмоциональные пики, цифры, неожиданные повороты',
        panelId: 'markers',
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
