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

  global.runAgentLoop = async function (opts) {
    var settings = opts.settings;
    var onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : function () {};
    var signal = opts.abortSignal;
    var abortCheck = opts.abortCheck;
    var messages = opts.messages.slice();
    var tools = opts.tools;
    var toolExecutors = opts.toolExecutors;
    var maxSteps = opts.maxSteps || 14;
    var step = 0;
    var lastAssistantText = '';
    var model = settings.activeAgentModel || settings.chatModel;

    while (step < maxSteps) {
      throwIfAborted(signal, abortCheck);
      step++;
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
