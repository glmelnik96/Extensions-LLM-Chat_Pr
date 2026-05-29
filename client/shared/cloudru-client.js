/**
 * Cloud.ru Evolution Foundation Models — OpenAI-совместимый chat + транскрипция.
 * URL и ключ: client/shared/fm-defaults.js и fm-secrets.js.
 *
 * v2: retry with exponential backoff, streaming SSE support.
 */
(function (global) {
  function normalizeBase(url) {
    if (!url || typeof url !== 'string') return '';
    return url.replace(/\/+$/, '');
  }

  function apiV1Root(baseUrl) {
    var b = normalizeBase(baseUrl);
    if (!b) return '';
    return /\/v1$/i.test(b) ? b : b + '/v1';
  }

  function parseJsonResponse(text, errPrefix) {
    try {
      return JSON.parse(text);
    } catch (e) {
      var hint = /<\s*!?\s*DOCTYPE|<\s*html/i.test(text) ? ' (HTML вместо JSON — часто неверный URL API или 413.)' : '';
      throw new Error((errPrefix || 'Ответ не JSON') + ': ' + text.slice(0, 200) + hint);
    }
  }

  function throwIfAbortCheck(abortCheck) {
    if (typeof abortCheck === 'function' && abortCheck()) {
      var err = new Error('Остановлено пользователем');
      err.name = 'AbortError';
      throw err;
    }
  }

  function isPayloadTooLarge(status, text) {
    if (status === 413) return true;
    /* Проверяем тело ТОЛЬКО для ошибочных ответов (4xx/5xx).
       Для 200 OK не проверяем — в теле Whisper verbose_json
       могут быть token ID вроде 23413, ложно триггерящие /413/. */
    if (status >= 200 && status < 300) return false;
    var head = String(text || '').slice(0, 600);
    return /\b413\b|Payload Too Large/i.test(head);
  }

  function isRetryable(status) {
    return status >= 500 || status === 429;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ─── Retry wrapper ───────────────────────────────────────────────
   * Retry 2-3x for 5xx/429 errors with exponential backoff + jitter.
   * Don't retry 4xx (except 429) — those are client errors.
   *
   * Встроенный timeout: если запрос висит >FETCH_TIMEOUT_MS без ответа —
   * прерываем через AbortController. Без этого при зависшем FM UI замирал
   * до ручной отмены пользователем.
   */
  /* Phase 1.5 (6 мая 2026): MAX_RETRIES 3 → 5. На длинных GLM-4.7 запросах
     наблюдали `fetch failed` (Node-side network reset) после 4+ минут — частая
     transient на Cloud.ru free preview. 5 попыток с backoff 1/2/4/8/16с
     перекрывает 30-сек выпадения сети. */
  var MAX_RETRIES = 5;
  var BASE_DELAY_MS = 1000;
  /* Доп. фиксированная задержка после `fetch failed` (Node TypeError, не HTTP).
     Это network-reset transient — лучше дать сети «успокоиться» дольше чем
     обычный exp-backoff. */
  var NETWORK_TRANSIENT_DELAY_MS = 5000;
  /* Phase 1.5 (май 2026): 120 → 300 сек (5 мин). На GLM-4.7 с thinking mode
     запросы analyze + buildTopics на 50+ сегментах легко занимают 3-4 мин.
     Real-call test показал 214сек на одном chunk без таймаута, и failed на
     третьей попытке. Поднимаем default чтобы перекрыть worst case. */
  var FETCH_TIMEOUT_MS = 300000;

  async function fetchWithRetry(url, fetchOpts, abortCheck, opts) {
    opts = opts || {};
    var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : FETCH_TIMEOUT_MS;
    var lastErr = null;
    /* HIGH #3 (6 мая 2026): pre-aborted external signal проверяем явно.
       addEventListener('abort') не сработает если signal уже aborted. */
    if (fetchOpts && fetchOpts.signal && fetchOpts.signal.aborted) {
      var preAbortErr = new Error('Остановлено пользователем');
      preAbortErr.name = 'AbortError';
      throw preAbortErr;
    }
    for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
      throwIfAbortCheck(abortCheck);

      /* Per-attempt AbortController — отдельный, чтобы внешний signal
         от caller'а продолжал работать параллельно. */
      var ctrl = null;
      var tmId = null;
      var mergedOpts = fetchOpts;
      var externalAbortHandler = null; /* HIGH #3: ссылку храним для removeEventListener */
      if (typeof AbortController !== 'undefined' && timeoutMs > 0) {
        ctrl = new AbortController();
        tmId = setTimeout(function () {
          try { ctrl.abort(); } catch (_) {}
        }, timeoutMs);
        mergedOpts = Object.assign({}, fetchOpts, { signal: ctrl.signal });
        /* Если caller передал свой signal — слушаем оба. */
        if (fetchOpts && fetchOpts.signal) {
          try {
            externalAbortHandler = function () {
              try { ctrl.abort(); } catch (_) {}
            };
            fetchOpts.signal.addEventListener('abort', externalAbortHandler);
          } catch (_) {}
        }
      }
      /* Helper для cleanup перед каждым return/throw — снимает listener чтобы
         не накапливать на shared external signal через retry-цикл. */
      function _cleanupAttempt() {
        if (tmId) { try { clearTimeout(tmId); } catch (_) {} tmId = null; }
        if (externalAbortHandler && fetchOpts && fetchOpts.signal) {
          try { fetchOpts.signal.removeEventListener('abort', externalAbortHandler); } catch (_) {}
          externalAbortHandler = null;
        }
      }

      try {
        var res = await fetch(url, mergedOpts);
        _cleanupAttempt();
        if (!isRetryable(res.status) || attempt === MAX_RETRIES - 1) {
          return res;
        }
        /* Retryable error — wait and try again */
        lastErr = new Error('HTTP ' + res.status);
      } catch (fetchErr) {
        _cleanupAttempt();
        /* AbortError от внешнего abortCheck — пробрасываем. */
        if (fetchErr && fetchErr.name === 'AbortError') {
          if (typeof abortCheck === 'function' && abortCheck()) throw fetchErr;
          /* Иначе это наш таймаут — делаем retryable ошибкой. */
          lastErr = new Error('Таймаут запроса (' + (timeoutMs / 1000).toFixed(0) + 'с)');
          if (attempt === MAX_RETRIES - 1) throw lastErr;
        } else {
          if (attempt === MAX_RETRIES - 1) throw fetchErr;
          lastErr = fetchErr;
        }
      }
      /* Exponential backoff с джиттером (±20%): 1s, 2s, 4s, 8s, 16s — рандомизация
         спасает от синхронного retry-шторма при параллельных чанках.
         Для network-transient (fetch failed) — extra 5с поверх backoff. */
      var base = BASE_DELAY_MS * Math.pow(2, attempt);
      var jitter = base * 0.2 * (Math.random() * 2 - 1);
      var extraDelay = 0;
      var errMsg = String(lastErr && lastErr.message || '');
      if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(errMsg)) {
        extraDelay = NETWORK_TRANSIENT_DELAY_MS;
      }
      await sleep(Math.round(base + jitter + extraDelay));
    }
    throw lastErr || new Error('Retry exhausted');
  }

  /* ─── SSE streaming parser ──────────────────────────────────────── */

  /**
   * Parse SSE stream from Cloud.ru FM (OpenAI-compatible).
   * Returns aggregated response equivalent to non-streaming response.
   *
   * onChunk(delta) — optional callback for progressive text display.
   * delta = { content?: string, tool_calls?: [...] }
   */
  async function parseSSEStream(response, onChunk) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    /* Accumulated result */
    var fullContent = '';
    var toolCallsMap = {}; /* index → {id, type, function: {name, arguments}} */
    var finishReason = null;
    var model = '';

    try {
      while (true) {
        var readResult = await reader.read();
        if (readResult.done) break;
        buffer += decoder.decode(readResult.value, { stream: true });

        /* Process complete SSE lines */
        var lines = buffer.split('\n');
        buffer = lines.pop() || ''; /* keep incomplete line */

        for (var li = 0; li < lines.length; li++) {
          var line = lines[li].trim();
          if (!line || line.startsWith(':')) continue; /* comment or empty */
          if (line === 'data: [DONE]') continue;
          if (!line.startsWith('data: ')) continue;

          var jsonStr = line.slice(6);
          var chunk;
          try { chunk = JSON.parse(jsonStr); } catch (e) { continue; }

          if (chunk.model) model = chunk.model;
          var delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (!delta) {
            if (chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
            continue;
          }

          /* Text content */
          if (delta.content) {
            fullContent += delta.content;
            if (onChunk) {
              try { onChunk({ content: delta.content }); } catch (e) {}
            }
          }

          /* Tool calls (streamed as deltas with index) */
          if (delta.tool_calls) {
            for (var ti = 0; ti < delta.tool_calls.length; ti++) {
              var tcDelta = delta.tool_calls[ti];
              var idx = tcDelta.index !== undefined ? tcDelta.index : ti;
              if (!toolCallsMap[idx]) {
                toolCallsMap[idx] = {
                  id: tcDelta.id || ('call_' + idx),
                  type: 'function',
                  'function': { name: '', arguments: '' }
                };
              }
              var tc = toolCallsMap[idx];
              if (tcDelta.id) tc.id = tcDelta.id;
              if (tcDelta['function']) {
                if (tcDelta['function'].name) tc['function'].name += tcDelta['function'].name;
                if (tcDelta['function'].arguments) tc['function'].arguments += tcDelta['function'].arguments;
              }
            }
          }

          if (chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason) {
            finishReason = chunk.choices[0].finish_reason;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    /* Build aggregated response */
    var toolCallsList = [];
    var keys = Object.keys(toolCallsMap).sort(function (a, b) { return Number(a) - Number(b); });
    for (var ki = 0; ki < keys.length; ki++) {
      toolCallsList.push(toolCallsMap[keys[ki]]);
    }

    var message = {
      role: 'assistant',
      content: fullContent || null
    };
    if (toolCallsList.length > 0) {
      message.tool_calls = toolCallsList;
    }

    return {
      choices: [{
        message: message,
        finish_reason: finishReason || 'stop',
        index: 0
      }],
      model: model
    };
  }

  global.CloudRuClient = {
    /**
     * POST /v1/chat/completions
     * opts.stream — if true, uses SSE streaming
     * opts.onChunk — callback for streaming text chunks
     */
    chatCompletions: async function (opts) {
      var base = normalizeBase(opts.baseUrl);
      var apiKey = opts.apiKey;
      var model = opts.model;
      if (!base || !apiKey || !model) {
        throw new Error('Проверьте fm-defaults.js (baseUrl, модель) и fm-secrets.js (apiKey).');
      }
      var url = apiV1Root(base) + '/chat/completions';
      var extra = opts.chatParams || {};
      var body = {
        model: model,
        messages: opts.messages
      };
      if (typeof extra.max_tokens === 'number') body.max_tokens = extra.max_tokens;
      if (typeof extra.temperature === 'number') body.temperature = extra.temperature;
      if (typeof extra.presence_penalty === 'number') body.presence_penalty = extra.presence_penalty;
      if (typeof extra.top_p === 'number') body.top_p = extra.top_p;
      if (body.temperature === undefined && opts.temperature !== undefined) {
        body.temperature = opts.temperature;
      }
      /* Default temperature 0.1 (Phase 1 quality fix, май 2026): для tool-calling
         нужна детерминированность. Раньше дефолт 0.5 → hallucinated nodeIds,
         markdown-обёртки в JSON. См. project_transcript_pipeline_audit (HIGH#2). */
      if (body.temperature === undefined) body.temperature = 0.1;
      if (opts.tools && opts.tools.length) {
        body.tools = opts.tools;
        body.tool_choice = opts.tool_choice || 'auto';
      }

      /* Phase 1: response_format passthrough.
         Для structured-output вызовов (analyze, build topics) — JSON object mode.
         Не используем вместе с tools[] — OpenAI API контракт несовместим. */
      if (opts.responseFormat && (!opts.tools || !opts.tools.length)) {
        body.response_format = (typeof opts.responseFormat === 'string')
          ? { type: opts.responseFormat }
          : opts.responseFormat;
      }

      /* Phase 1: GLM thinking mode passthrough (chat_template_kwargs).
         Для не-thinking моделей (gpt-oss-120b, Qwen3) поле игнорируется. */
      if (typeof opts.enableThinking === 'boolean') {
        body.chat_template_kwargs = body.chat_template_kwargs || {};
        body.chat_template_kwargs.enable_thinking = opts.enableThinking;
      }

      /* Streaming: enable if requested and supported */
      var useStreaming = !!opts.stream;
      if (useStreaming) {
        body.stream = true;
      }

      var bodyStr = JSON.stringify(body);
      var fetchOpts = {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: bodyStr
      };
      if (opts.signal) fetchOpts.signal = opts.signal;
      throwIfAbortCheck(opts.abortCheck);

      var res = await fetchWithRetry(url, fetchOpts, opts.abortCheck);
      throwIfAbortCheck(opts.abortCheck);

      /* Streaming response */
      if (useStreaming && res.ok && res.body) {
        return parseSSEStream(res, opts.onChunk);
      }

      var text = await res.text();
      if (isPayloadTooLarge(res.status, text)) {
        throw new Error('413 Payload Too Large — запрос к чату слишком большой (сократите историю сообщений).');
      }
      var data = parseJsonResponse(text, 'Ответ не JSON');
      if (!res.ok) {
        throw new Error(data.error && data.error.message ? data.error.message : text.slice(0, 300));
      }
      return data;
    },

    /**
     * Транскрипция аудио.
     */
    transcribeAudio: async function (opts) {
      var base = normalizeBase(opts.baseUrl);
      var apiKey = opts.apiKey;
      var model = opts.model || 'openai/whisper-large-v3';
      if (!base || !apiKey) {
        throw new Error('Проверьте fm-defaults.js (baseUrl) и fm-secrets.js (apiKey).');
      }
      var url = apiV1Root(base) + '/audio/transcriptions';
      var form = new FormData();
      form.append('file', opts.fileBlob, opts.fileName || 'audio.wav');
      form.append('model', model);
      var tx = opts.transcribeParams || {};
      if (tx.language) form.append('language', String(tx.language));
      else if (opts.language) form.append('language', opts.language);
      var rf = opts.response_format || tx.response_format || 'verbose_json';
      form.append('response_format', String(rf));
      if (tx.temperature !== undefined && tx.temperature !== null) {
        form.append('temperature', String(tx.temperature));
      }
      var trFetch = {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey },
        body: form
      };
      if (opts.signal) trFetch.signal = opts.signal;
      throwIfAbortCheck(opts.abortCheck);

      var res = await fetchWithRetry(url, trFetch, opts.abortCheck);
      throwIfAbortCheck(opts.abortCheck);

      var text = await res.text();
      if (isPayloadTooLarge(res.status, text)) {
        throw new Error(
          '413 Payload Too Large — аудио слишком большое для API. Установите ffmpeg (brew install ffmpeg / apt install ffmpeg) — плагин автоматически нарежет диапазон на чанки. Альтернатива: создайте .epr пресет и пропишите exportAudioPresetPath в fm-defaults.js (см. host/presets/README.txt).'
        );
      }
      var data = parseJsonResponse(text, 'Транскрипция: не JSON');
      if (!res.ok) {
        throw new Error(data.error && data.error.message ? data.error.message : text.slice(0, 300));
      }
      return data;
    }
  };

  /* Export for testing (pure helpers + SSE parser) */
  global._cloudRuInternals = {
    normalizeBase: normalizeBase,
    apiV1Root: apiV1Root,
    parseJsonResponse: parseJsonResponse,
    isPayloadTooLarge: isPayloadTooLarge,
    isRetryable: isRetryable,
    parseSSEStream: parseSSEStream
  };
})(window);
