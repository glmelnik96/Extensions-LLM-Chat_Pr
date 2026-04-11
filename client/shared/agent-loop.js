/**
 * Универсальный цикл агента: chat.completions + tool_calls (OpenAI-формат).
 * Каждый шаг цикла = один HTTP POST к FM (chat/completions), пока модель возвращает tool_calls.
 * Опционально: opts.abortSignal (AbortController.signal) — прервать ожидание ответа и цикл.
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

  /**
   * Усечение истории сообщений: оставляем все system-сообщения + последние N не-system,
   * стараясь не разрывать пары tool_call → tool (иначе 400 от FM).
   *
   * Дополнительно: tool-результаты компрессируем — крупные снимки/транскрипты
   * (десятки КБ) забивают контекст и приводят к 413 после нескольких шагов.
   * Свежие N tool-результатов оставляем как есть, более старые усекаем до 600 байт
   * с пометкой «[truncated, see earlier in context]».
   */
  var TOOL_KEEP_FULL = 4;
  var TOOL_TRUNC_BYTES = 600;

  function compressToolHistory(messages) {
    /* Идём с конца, оставляем последние TOOL_KEEP_FULL tool-сообщений нетронутыми,
       остальные — урезаем content. Не трогаем оригинальные объекты — клонируем. */
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
        signal: signal,
        abortCheck: abortCheck
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

      messages.push({
        role: 'assistant',
        content: assistantMsg.content || null,
        tool_calls: toolCalls
      });

      for (var i = 0; i < toolCalls.length; i++) {
        throwIfAborted(signal, abortCheck);
        var tc = toolCalls[i];
        var fn = tc.function;
        var name = fn.name;
        var args = {};
        try {
          args = JSON.parse(fn.arguments || '{}');
        } catch (e) {
          args = {};
        }
        onStatus({
          phase: 'tool',
          name: name,
          step: step,
          maxSteps: maxSteps,
          message: 'Шаг ' + step + '/' + maxSteps + ' · инструмент: ' + name
        });
        var exec = toolExecutors[name];
        var resultStr = '';
        try {
          if (!exec) {
            resultStr = JSON.stringify({ error: 'Неизвестный инструмент: ' + name });
          } else {
            var out = await exec(args);
            resultStr = typeof out === 'string' ? out : JSON.stringify(out);
          }
        } catch (err) {
          resultStr = JSON.stringify({ error: String(err.message || err) });
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultStr
        });
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
})(window);
