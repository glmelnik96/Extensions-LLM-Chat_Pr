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

  /* Фолбэк на запасную модель (21.07.2026). Триггерим ТОЛЬКО когда сама модель
     недоступна, а не когда запрос кривой:
       • наш таймаут (fetchWithRetry:184 «Таймаут запроса») — модель молча висит
         (реальный кейс 21.07: GLM-5.1 не отдавала ни 500, ни ответ, сокет висел
         до 300с × 5 ретраев);
       • 5xx после исчерпания ретраев (message «HTTP 5xx»);
       • 404 — модель снята/недоступна на аккаунте (см. fm-defaults: preview-модели
         отдают 404);
       • 403 — RBAC: модель есть в каталоге, но недоступна аккаунту (живой кейс
         11.07: внешние vision-модели отдают 403). Запасная из своего пула часто
         доступна — есть смысл переключиться (22.07);
       • 408/409/425 — request timeout / conflict / too-early: транзиентные
         статусы, на другой модели запрос может пройти;
       • сетевой обрыв (fetch failed / ECONNRESET).
     НЕ фолбэчим: AbortError (пользователь нажал Стоп), 413 (payload — на любой
     модели то же, помечаем err.noFallback), 400/401/422 (кривой запрос или ключ —
     одинаково падает на любой модели), «Ответ не JSON» на 200 (тело битое, но
     модель отвечает). */
  function isModelUnavailable(err) {
    if (!err || err.noFallback) return false;
    if (err.name === 'AbortError') return false;
    if (typeof err.httpStatus === 'number') {
      var s = err.httpStatus;
      return s >= 500 || s === 404 || s === 403 || s === 408 || s === 409 || s === 425;
    }
    var m = String((err && err.message) || '');
    return /Таймаут запроса|fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|HTTP\s*5\d\d/i.test(m);
  }

  /* Волна 1.1 (10.07.2026): 429 приходит с заголовком Retry-After (секунды или
     HTTP-date), но backoff был чисто экспоненциальным (1/2/4с) — при лимите
     60с мы долбили API раньше времени и снова ловили 429 до исчерпания retry.
     Теперь ждём max(backoff, Retry-After) с капом — защита от абсурдного
     значения сервера и вечного ожидания. */
  var RETRY_AFTER_CAP_MS = 60000;
  function parseRetryAfterMs(headerVal) {
    if (!headerVal) return 0;
    var s = String(headerVal).trim();
    if (/^\d+$/.test(s)) {
      return Math.min(parseInt(s, 10) * 1000, RETRY_AFTER_CAP_MS);
    }
    var dt = Date.parse(s);
    if (!isNaN(dt)) {
      var ms = dt - Date.now();
      if (ms > 0) return Math.min(ms, RETRY_AFTER_CAP_MS);
    }
    return 0;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* 19.06.2026: abort-aware sleep для retry-backoff. Раньше backoff был обычным
     setTimeout (до ~16с), и нажатие «Стоп» во время сна не прерывало запрос до
     следующей итерации цикла — UI оставался «занят» до конца backoff. Дробим сон
     на срезы ~150мс и просыпаемся рано при abort; throwIfAbortCheck в начале
     следующей итерации бросит AbortError. */
  function abortableSleep(ms, abortCheck) {
    if (typeof abortCheck !== 'function') return sleep(ms);
    var SLICE = 150;
    return new Promise(function (resolve) {
      var elapsed = 0;
      function tick() {
        if (abortCheck() || elapsed >= ms) { resolve(); return; }
        var step = Math.min(SLICE, ms - elapsed);
        elapsed += step;
        setTimeout(tick, step);
      }
      tick();
    });
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
    /* Фолбэк моделей (21.07.2026): вызывающий может урезать число попыток
       на ПЕРВИЧНОЙ модели, чтобы после N таймаутов/5xx быстрее переключиться
       на запасную, а не долбить мёртвую модель все 5×300с (см. chatCompletions). */
    var maxRetries = (typeof opts.maxRetries === 'number' && opts.maxRetries > 0)
      ? Math.floor(opts.maxRetries)
      : MAX_RETRIES;
    var lastErr = null;
    /* HIGH #3 (6 мая 2026): pre-aborted external signal проверяем явно.
       addEventListener('abort') не сработает если signal уже aborted. */
    if (fetchOpts && fetchOpts.signal && fetchOpts.signal.aborted) {
      var preAbortErr = new Error('Остановлено пользователем');
      preAbortErr.name = 'AbortError';
      throw preAbortErr;
    }
    for (var attempt = 0; attempt < maxRetries; attempt++) {
      throwIfAbortCheck(abortCheck);
      var retryAfterMs = 0; /* Волна 1.1: из заголовка Retry-After при 429/5xx */

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
        if (!isRetryable(res.status) || attempt === maxRetries - 1) {
          return res;
        }
        /* Retryable error — wait and try again */
        lastErr = new Error('HTTP ' + res.status);
        try {
          if (res.headers && typeof res.headers.get === 'function') {
            retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'));
          }
        } catch (_ra) {}
      } catch (fetchErr) {
        _cleanupAttempt();
        /* AbortError от внешнего abortCheck — пробрасываем. */
        if (fetchErr && fetchErr.name === 'AbortError') {
          if (typeof abortCheck === 'function' && abortCheck()) throw fetchErr;
          /* Иначе это наш таймаут — делаем retryable ошибкой. */
          lastErr = new Error('Таймаут запроса (' + (timeoutMs / 1000).toFixed(0) + 'с)');
          if (attempt === maxRetries - 1) throw lastErr;
        } else {
          if (attempt === maxRetries - 1) throw fetchErr;
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
      var waitMs = Math.round(base + jitter + extraDelay);
      if (retryAfterMs > waitMs) waitMs = retryAfterMs; /* уважаем rate-limit сервера */
      await abortableSleep(waitMs, abortCheck);
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
  async function parseSSEStream(response, onChunk, abortCheck) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    /* Accumulated result */
    var fullContent = '';
    var toolCallsMap = {}; /* index → {id, type, function: {name, arguments}} */
    var finishReason = null;
    var model = '';
    var usage = null;

    try {
      while (true) {
        /* 19.06.2026: abort прерывает read-loop стрима. Раньше parseSSEStream не
           принимал abortCheck — нажатие «Стоп» во время стриминга не останавливало
           чтение до конца ответа модели (UI «занят» секунды). Теперь проверяем в
           начале каждой итерации: отменяем reader и бросаем AbortError. */
        if (typeof abortCheck === 'function' && abortCheck()) {
          try { if (reader.cancel) reader.cancel(); } catch (_c) {}
          var abErr = new Error('Остановлено пользователем');
          abErr.name = 'AbortError';
          throw abErr;
        }
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
          if (chunk.usage) usage = chunk.usage;
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
      try { reader.releaseLock(); } catch (_rl) {}
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
      model: model,
      usage: usage
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
        body.stream_options = { include_usage: true };
      }

      /* Одна попытка на конкретной модели: fetch+retry, парс, классификация.
         Бросает классифицированную ошибку (httpStatus / noFallback), чтобы
         внешний цикл решил, стоит ли фолбэчить на запасную модель. */
      async function attemptModel(modelName, maxRetries) {
        body.model = modelName;
        var fetchOpts = {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        };
        if (opts.signal) fetchOpts.signal = opts.signal;
        throwIfAbortCheck(opts.abortCheck);

        var res = await fetchWithRetry(url, fetchOpts, opts.abortCheck, { maxRetries: maxRetries });
        throwIfAbortCheck(opts.abortCheck);

        /* Streaming response */
        if (useStreaming && res.ok && res.body) {
          var streamed = await parseSSEStream(res, opts.onChunk, opts.abortCheck);
          if (global.UsageMeter && streamed && streamed.usage) {
            UsageMeter.recordChat(streamed.model || modelName, streamed.usage);
          }
          return streamed;
        }

        var text = await res.text();
        if (isPayloadTooLarge(res.status, text)) {
          var e413 = new Error('413 Payload Too Large — запрос к чату слишком большой (сократите историю сообщений).');
          e413.noFallback = true; /* payload одинаков на любой модели — не фолбэчим */
          throw e413;
        }
        /* Классифицируем ПО СТАТУСУ до JSON-парса: недоступная модель часто
           отдаёт 404/502 с ПУСТЫМ или HTML-телом (живой тест 21.07: 404 «»).
           Если парсить сначала — падаем в «Ответ не JSON» без httpStatus и
           фолбэк не срабатывает. Тело парсим лениво только ради текста ошибки. */
        if (!res.ok) {
          var errMsg = '';
          try {
            var errData = JSON.parse(text);
            errMsg = (errData && errData.error && errData.error.message) ? errData.error.message : '';
          } catch (_parseErr) {}
          if (!errMsg) errMsg = String(text || '').slice(0, 300) || ('HTTP ' + res.status);
          var eHttp = new Error(errMsg);
          eHttp.httpStatus = res.status; /* 404/5xx → модель недоступна, isModelUnavailable решит */
          throw eHttp;
        }
        var data = parseJsonResponse(text, 'Ответ не JSON');
        if (global.UsageMeter && data && data.usage) {
          UsageMeter.recordChat(data.model || modelName, data.usage);
        }
        return data;
      }

      /* Список моделей: основная + запасные (дедуп, без пустых). */
      var modelList = [model];
      var fbs = opts.fallbackModels || [];
      for (var fi = 0; fi < fbs.length; fi++) {
        if (fbs[fi] && modelList.indexOf(fbs[fi]) < 0) modelList.push(fbs[fi]);
      }
      /* На НЕпоследней модели урезаем ретраи (по умолчанию 1), чтобы не ждать
         5×timeout на мёртвой модели перед переключением. Последняя модель
         получает полный бюджет MAX_RETRIES. */
      var retriesBeforeFallback = (typeof opts.retriesBeforeFallback === 'number' && opts.retriesBeforeFallback > 0)
        ? Math.floor(opts.retriesBeforeFallback)
        : 1;

      var lastErr = null;
      for (var mi = 0; mi < modelList.length; mi++) {
        var isLast = mi === modelList.length - 1;
        try {
          return await attemptModel(modelList[mi], isLast ? undefined : retriesBeforeFallback);
        } catch (err) {
          lastErr = err;
          if (err && err.name === 'AbortError') throw err;
          if (isLast || !isModelUnavailable(err)) throw err;
          if (typeof opts.onModelFallback === 'function') {
            try {
              opts.onModelFallback({
                from: modelList[mi],
                to: modelList[mi + 1],
                reason: String((err && err.message) || err)
              });
            } catch (_cbErr) {}
          }
        }
      }
      throw lastErr;
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
      if (global.UsageMeter && data && typeof data.duration === 'number') {
        UsageMeter.recordWhisper(data.duration);
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
    isModelUnavailable: isModelUnavailable,
    parseRetryAfterMs: parseRetryAfterMs,
    fetchWithRetry: fetchWithRetry,
    parseSSEStream: parseSSEStream,
    chatCompletions: global.CloudRuClient.chatCompletions
  };
})(window);
