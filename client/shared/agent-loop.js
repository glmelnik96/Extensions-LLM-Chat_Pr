/**
 * Универсальный цикл агента: chat.completions + tool_calls (OpenAI-формат).
 * Каждый шаг цикла = один HTTP POST к FM (chat/completions), пока модель возвращает tool_calls.
 * Опционально: opts.abortSignal (AbortController.signal) — прервать ожидание ответа и цикл.
 *
 * v2: guard rails (cycle detection), parallel tool execution, JSON repair.
 */
(function (global) {
  function msgContent(choice) {
    var m = choice.message;
    if (!m) return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter(function (p) {
          return p.type === 'text';
        })
        .map(function (p) {
          return p.text;
        })
        .join('\n');
    }
    return '';
  }

  /* ─── ETA (10 июня 2026): ожидаемое время ответа модели ─────────────
   * GLM-5.1 с thinking может «молчать» 30+ секунд — пользователь думает,
   * что зависло. Меряем время до ПЕРВОГО видимого ответа (первый content-чанк
   * при стриминге, либо весь запрос без стриминга) per-model, сглаживаем EMA
   * (α=0.3) и персистим в localStorage, чтобы оценка переживала перезапуск. */
  var ETA_LS_KEY = 'fmEtaByModel';
  /* Сиды из live-замеров TTFT 10 июня 2026 (Cloud.ru, стриминг):
     GLM-5.1 thinking=ON — 46-48с до первого content-токена(!),
     thinking=OFF — 0.3-0.8с, gpt-oss-120b / DeepSeek-V4-Pro — ~0.4с.
     EMA постепенно заместит сиды реальными значениями пользователя. */
  var SEED_ETA = {
    'zai-org/GLM-5.1#think': 45000,
    'zai-org/GLM-5.1': 1500,
    'openai/gpt-oss-120b': 1500,
    'deepseek-ai/DeepSeek-V4-Pro': 1500
  };
  var _etaByModel = (function () {
    try {
      var raw = global.localStorage && global.localStorage.getItem(ETA_LS_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) { return {}; }
  })();
  function recordModelLatency(model, ms) {
    if (!model || typeof ms !== 'number' || !(ms >= 0)) return;
    ms = Math.max(1, ms);
    var prev = _etaByModel[model];
    _etaByModel[model] = (typeof prev === 'number' && prev > 0)
      ? Math.round(prev * 0.7 + ms * 0.3)
      : Math.round(ms);
    try {
      if (global.localStorage) global.localStorage.setItem(ETA_LS_KEY, JSON.stringify(_etaByModel));
    } catch (e2) {}
  }
  function expectedLatencyMs(model) {
    var v = _etaByModel[model];
    if (typeof v === 'number' && v > 0) return v;
    var seed = SEED_ETA[model];
    return (typeof seed === 'number') ? seed : null;
  }
  global.AgentLoopStats = {
    recordModelLatency: recordModelLatency,
    expectedLatencyMs: expectedLatencyMs
  };

  function throwIfAborted(signal, abortCheck) {
    if (signal && signal.aborted) {
      var err = new Error('Остановлено');
      err.name = 'AbortError';
      throw err;
    }
    if (typeof abortCheck === 'function' && abortCheck()) {
      var err2 = new Error('Остановлено');
      err2.name = 'AbortError';
      throw err2;
    }
  }

  /* ─── JSON repair ──────────────────────────────────────────────────
   * Open-source модели иногда генерируют невалидный JSON в arguments:
   * - trailing commas: {a:1,}
   * - unquoted keys: {action: "remove"}
   * - truncated string (model hit max_tokens mid-JSON)
   * - single quotes instead of double
   * Пробуем починить перед отказом.
   */
  function repairJson(raw) {
    if (!raw || typeof raw !== 'string') return '{}';
    var s = raw.trim();
    /* 1. Trailing commas before } or ] */
    s = s.replace(/,\s*([}\]])/g, '$1');
    /* 2. Single quotes → double quotes (naive, handles simple cases) */
    s = s.replace(/'/g, '"');
    /* 3. Unquoted keys: {action: → {"action": */
    s = s.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
    /* 4. Truncated: try to close open braces/brackets */
    var opens = 0, openB = 0;
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '{') opens++;
      else if (s[i] === '}') opens--;
      else if (s[i] === '[') openB++;
      else if (s[i] === ']') openB--;
    }
    /* Close unclosed strings - very rough heuristic */
    var quoteCount = (s.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) s += '"';
    while (openB > 0) { s += ']'; openB--; }
    while (opens > 0) { s += '}'; opens--; }
    return s;
  }

  function safeParseArgs(raw) {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (e1) {
      try {
        return JSON.parse(repairJson(raw));
      } catch (e2) {
        return { _parseError: 'Невалидный JSON аргументов: ' + String(raw).slice(0, 200) };
      }
    }
  }

  /* ─── Cycle detection ──────────────────────────────────────────────
   * Если модель 3 раза подряд вызывает тот же инструмент с теми же аргументами —
   * принудительно останавливаем цикл. Это основной класс ошибок на open-source моделях.
   */
  var CYCLE_THRESHOLD = 3;

  function hashToolCall(tc) {
    return (tc.function.name || '') + ':' + (tc.function.arguments || '');
  }

  function detectCycle(history) {
    if (history.length < CYCLE_THRESHOLD) return false;
    var last = history[history.length - 1];
    var count = 0;
    for (var i = history.length - 1; i >= 0 && i >= history.length - CYCLE_THRESHOLD; i--) {
      if (history[i] === last) count++;
    }
    return count >= CYCLE_THRESHOLD;
  }

  /**
   * Усечение истории сообщений: оставляем все system-сообщения + последние N не-system,
   * стараясь не разрывать пары tool_call → tool (иначе 400 от FM).
   *
   * Дополнительно: tool-результаты компрессируем — крупные снимки/транскрипты
   * (десятки КБ) забивают контекст и приводят к 413 после нескольких шагов.
   * Свежие N tool-результатов оставляем как есть, более старые усекаем до 600 байт
   * с пометкой «[truncated]».
   */
  var TOOL_KEEP_FULL = 4;
  var TOOL_TRUNC_BYTES = 600;

  function compressToolHistory(messages) {
    var seenTools = 0;
    var out = new Array(messages.length);
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      if (m.role !== 'tool') {
        out[i] = m;
        continue;
      }
      seenTools++;
      if (seenTools <= TOOL_KEEP_FULL) {
        out[i] = m;
        continue;
      }
      var c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      if (c.length > TOOL_TRUNC_BYTES) {
        c = c.slice(0, TOOL_TRUNC_BYTES) + '… [truncated ' + (c.length - TOOL_TRUNC_BYTES) + ' bytes — данные есть выше в контексте]';
      }
      out[i] = { role: 'tool', tool_call_id: m.tool_call_id, content: c };
    }
    return out;
  }

  function trimHistory(messages, maxNonSystem) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    if (typeof maxNonSystem !== 'number' || maxNonSystem <= 0) {
      return compressToolHistory(messages);
    }
    var sys = [];
    var rest = [];
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === 'system') sys.push(messages[i]);
      else rest.push(messages[i]);
    }
    var keep;
    if (rest.length <= maxNonSystem) {
      keep = rest;
    } else {
      keep = rest.slice(-maxNonSystem);
      /* Не начинаем с tool-сообщения, иначе FM вернёт 400. */
      while (keep.length > 0 && keep[0].role === 'tool') keep.shift();
      /* Если первый assistant-сообщение содержит tool_calls, но соответствующих tool-ответов
         уже нет в keep — отбрасываем его до следующего «чистого» сообщения. */
      while (keep.length > 0 && keep[0].role === 'assistant' && keep[0].tool_calls) {
        keep.shift();
        while (keep.length > 0 && keep[0].role === 'tool') keep.shift();
      }
    }
    return sys.concat(compressToolHistory(keep));
  }

  global.runAgentLoop = async function (opts) {
    var settings = opts.settings;
    var onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : function () {};
    var signal = opts.abortSignal;
    var abortCheck = opts.abortCheck;
    var messages = opts.messages.slice();
    var tools = opts.tools;
    var toolExecutors = opts.toolExecutors;
    /* M5 (аудит 04.07.2026): имена инструментов, меняющих таймлайн. Если модель
       вернула несколько tool_calls и среди них есть мутирующий — выполняем ВСЕ
       последовательно: ExtendScript однопоточный, а ripple-правки сдвигают
       координаты, поэтому параллельный запуск двух apply_* даёт резы по уже
       устаревшим таймкодам. Список передаёт панель; по умолчанию пусто. */
    var mutatingTools = {};
    if (opts.mutatingTools && opts.mutatingTools.length) {
      for (var mti = 0; mti < opts.mutatingTools.length; mti++) {
        mutatingTools[opts.mutatingTools[mti]] = true;
      }
    }
    var maxSteps =
      opts.maxSteps ||
      (settings && typeof settings.maxAgentSteps === 'number' ? settings.maxAgentSteps : 24);
    var maxHistory =
      (settings && typeof settings.maxChatHistoryMessages === 'number' && settings.maxChatHistoryMessages > 0)
        ? settings.maxChatHistoryMessages
        : 60;
    var step = 0;
    var lastAssistantText = '';
    var model = settings.activeAgentModel || settings.chatModel;
    /* ETA-ключ учитывает thinking: GLM-5.1 с thinking ждёт первый токен ~45с,
       без — <1с. Это разные «модели» с точки зрения ожидания пользователя. */
    var chatThinking = (settings.thinkingPolicy && typeof settings.thinkingPolicy.chat === 'boolean')
      ? settings.thinkingPolicy.chat
      : settings.enableThinking;
    var etaKey = model + (chatThinking ? '#think' : '');

    /* Cycle detection: хэши последних tool_calls */
    var callHashes = [];

    while (step < maxSteps) {
      throwIfAborted(signal, abortCheck);
      step++;
      messages = trimHistory(messages, maxHistory);
      var etaMs = expectedLatencyMs(etaKey);
      var reqStart = Date.now();
      var firstVisibleTs = 0;
      onStatus({
        phase: 'llm',
        step: step,
        maxSteps: maxSteps,
        model: model,
        etaMs: etaMs,
        message:
          'Очередь агента: шаг ' +
          step +
          ' из ' +
          maxSteps +
          ' (лимит на сообщение). Запрос к FM: ' +
          model +
          (etaMs ? ' (обычно ~' + Math.max(1, Math.round(etaMs / 1000)) + 'с)' : '')
      });
      var data = await CloudRuClient.chatCompletions({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: model,
        messages: messages,
        tools: tools,
        chatParams: settings.chatParams || {},
        /* Phase 1.5 (6 мая 2026): per-role thinking — chat policy.
           Помогает на multi-step decision making (τ²-Bench 87.4%).
           Не-thinking модели игнорируют. */
        enableThinking: chatThinking,
        /* response_format НЕ задаём — несовместимо с tools[] по OpenAI API контракту. */
        signal: signal,
        abortCheck: abortCheck,
        stream: !!settings.stream,
        onChunk: (function () {
          var lastChunkTs = 0;
          var THROTTLE_MS = 150;
          /* UI-волна (10 июня 2026): накапливаем ПОЛНЫЙ текст до throttle —
             раньше дельты между эмитами просто терялись, и собрать связный
             текст на стороне UI было невозможно. */
          var acc = '';
          return function (delta) {
            if (delta.content) {
              if (!firstVisibleTs) {
                firstVisibleTs = Date.now();
                recordModelLatency(etaKey, firstVisibleTs - reqStart);
              }
              acc += delta.content;
              var now = Date.now();
              if (now - lastChunkTs < THROTTLE_MS) return;
              lastChunkTs = now;
              onStatus({
                phase: 'streaming',
                step: step,
                maxSteps: maxSteps,
                message: 'Шаг ' + step + '/' + maxSteps + ' · получаю ответ…',
                chunk: delta.content,
                accumulated: acc
              });
            }
          };
        })()
      });
      throwIfAborted(signal, abortCheck);
      /* Без стриминга (или ответ без content-чанков, только tool_calls):
         «видимый ответ» = весь запрос целиком. */
      if (!firstVisibleTs) recordModelLatency(etaKey, Date.now() - reqStart);
      var choice = data.choices && data.choices[0];
      if (!choice) throw new Error('Пустой ответ модели');

      var assistantMsg = choice.message;
      lastAssistantText = msgContent(choice) || lastAssistantText;

      var toolCalls = assistantMsg.tool_calls;
      if (!toolCalls || !toolCalls.length) {
        messages.push({
          role: 'assistant',
          content: assistantMsg.content || lastAssistantText || ''
        });
        return { messages: messages, finalText: lastAssistantText, aborted: false };
      }

      /* ── Cycle detection ─────────────────────────────────────── */
      for (var ci = 0; ci < toolCalls.length; ci++) {
        callHashes.push(hashToolCall(toolCalls[ci]));
      }
      if (detectCycle(callHashes)) {
        var cycleToolName = toolCalls[0].function.name;
        var cycleMsg =
          'Обнаружено зацикливание: инструмент «' + cycleToolName +
          '» вызван ' + CYCLE_THRESHOLD + ' раз подряд с одинаковыми аргументами. ' +
          'Останавливаю агента. Попробуйте переформулировать запрос или разбить задачу на шаги.';
        messages.push({
          role: 'assistant',
          content: cycleMsg
        });
        return { messages: messages, finalText: cycleMsg, aborted: false, cycleDetected: true };
      }

      messages.push({
        role: 'assistant',
        content: assistantMsg.content || null,
        tool_calls: toolCalls
      });

      /* ── Execute tool_calls ─────────────────────────────────── */
      /* Собираем задачи-фабрики (не запускаем сразу): режим исполнения
         зависит от наличия мутирующих инструментов в этой пачке. */
      var toolTasks = [];
      var hasMutating = false;
      for (var i = 0; i < toolCalls.length; i++) {
        throwIfAborted(signal, abortCheck);
        var tc = toolCalls[i];
        var fn = tc.function;
        var name = fn.name;
        var args = safeParseArgs(fn.arguments);
        if (mutatingTools[name]) hasMutating = true;

        /* If JSON repair injected _parseError, report it as tool result */
        if (args._parseError) {
          toolTasks.push((function (tcId, perr) {
            return function () { return _makeToolResult(tcId, JSON.stringify({ error: perr })); };
          })(tc.id, args._parseError));
          continue;
        }

        var exec = toolExecutors[name];
        if (!exec) {
          toolTasks.push((function (tcId, n) {
            return function () { return _makeToolResult(tcId, JSON.stringify({ error: 'Неизвестный инструмент: ' + n })); };
          })(tc.id, name));
        } else {
          toolTasks.push((function (ex, ar, tcId, n) {
            return function () {
              onStatus({
                phase: 'tool',
                name: n,
                step: step,
                maxSteps: maxSteps,
                message: 'Шаг ' + step + '/' + maxSteps + ' · инструмент: ' + n
              });
              return _execTool(ex, ar, tcId);
            };
          })(exec, args, tc.id, name));
        }
      }

      var toolResults;
      if (hasMutating && toolTasks.length > 1) {
        /* M5: мутирующая операция в пачке → строго последовательно, в порядке
           tool_calls. Промежуточные throwIfAborted: «Стоп» между операциями
           не даёт запустить следующую правку таймлайна. */
        toolResults = [];
        for (var si = 0; si < toolTasks.length; si++) {
          throwIfAborted(signal, abortCheck);
          toolResults.push(await toolTasks[si]());
        }
      } else {
        /* Только чтение/propose — параллельно, как раньше. */
        toolResults = await Promise.all(toolTasks.map(function (t) { return t(); }));
      }
      for (var ri = 0; ri < toolResults.length; ri++) {
        messages.push(toolResults[ri]);
      }
    }

    messages.push({
      role: 'assistant',
      content:
        'Достигнут лимит шагов (' +
        maxSteps +
        ') за одно сообщение. Разбейте задачу: сначала одна подзадача, затем следующее сообщением; либо сократите запрос. Кнопка «Стоп» обрывает ожидание FM, но не отменяет уже выполненный ExtendScript.'
    });
    return { messages: messages, finalText: lastAssistantText, aborted: false };
  };

  function _makeToolResult(toolCallId, content) {
    return Promise.resolve({ role: 'tool', tool_call_id: toolCallId, content: content });
  }

  async function _execTool(exec, args, toolCallId) {
    var resultStr = '';
    try {
      var out = await exec(args);
      resultStr = typeof out === 'string' ? out : JSON.stringify(out != null ? out : {});
    } catch (err) {
      resultStr = JSON.stringify({ error: String(err.message || err) });
    }
    return { role: 'tool', tool_call_id: toolCallId, content: resultStr };
  }

  /* Export for testing */
  global._agentLoopInternals = {
    repairJson: repairJson,
    safeParseArgs: safeParseArgs,
    detectCycle: detectCycle,
    hashToolCall: hashToolCall,
    trimHistory: trimHistory,
    compressToolHistory: compressToolHistory
  };
})(window);
