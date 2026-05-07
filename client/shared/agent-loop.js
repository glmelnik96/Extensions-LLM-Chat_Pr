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

    /* Cycle detection: хэши последних tool_calls */
    var callHashes = [];

    while (step < maxSteps) {
      throwIfAborted(signal, abortCheck);
      step++;
      messages = trimHistory(messages, maxHistory);
      onStatus({
        phase: 'llm',
        step: step,
        maxSteps: maxSteps,
        message:
          'Очередь агента: шаг ' +
          step +
          ' из ' +
          maxSteps +
          ' (лимит на сообщение). Запрос к FM: ' +
          model
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
        enableThinking: (settings.thinkingPolicy && typeof settings.thinkingPolicy.chat === 'boolean')
          ? settings.thinkingPolicy.chat
          : settings.enableThinking,
        /* response_format НЕ задаём — несовместимо с tools[] по OpenAI API контракту. */
        signal: signal,
        abortCheck: abortCheck,
        stream: !!settings.stream,
        onChunk: (function () {
          var lastChunkTs = 0;
          var THROTTLE_MS = 150;
          return function (delta) {
            if (delta.content) {
              var now = Date.now();
              if (now - lastChunkTs < THROTTLE_MS) return;
              lastChunkTs = now;
              onStatus({
                phase: 'streaming',
                step: step,
                maxSteps: maxSteps,
                message: 'Шаг ' + step + '/' + maxSteps + ' · получаю ответ…',
                chunk: delta.content
              });
            }
          };
        })()
      });
      throwIfAborted(signal, abortCheck);
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

      /* ── Execute tool_calls (parallel if independent) ──────── */
      var toolPromises = [];
      for (var i = 0; i < toolCalls.length; i++) {
        throwIfAborted(signal, abortCheck);
        var tc = toolCalls[i];
        var fn = tc.function;
        var name = fn.name;
        var args = safeParseArgs(fn.arguments);

        /* If JSON repair injected _parseError, report it as tool result */
        if (args._parseError) {
          toolPromises.push(
            _makeToolResult(tc.id, JSON.stringify({ error: args._parseError }))
          );
          continue;
        }

        onStatus({
          phase: 'tool',
          name: name,
          step: step,
          maxSteps: maxSteps,
          message: 'Шаг ' + step + '/' + maxSteps + ' · инструмент: ' + name
        });
        var exec = toolExecutors[name];
        if (!exec) {
          toolPromises.push(
            _makeToolResult(tc.id, JSON.stringify({ error: 'Неизвестный инструмент: ' + name }))
          );
        } else {
          toolPromises.push(_execTool(exec, args, tc.id));
        }
      }

      /* Parallel execution: all tool calls run concurrently */
      var toolResults = await Promise.all(toolPromises);
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
