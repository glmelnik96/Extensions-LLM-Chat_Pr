/**
 * Cloud.ru Evolution Foundation Models — OpenAI-совместимый chat + транскрипция.
 * URL и ключ: client/shared/fm-defaults.js и fm-secrets.js.
 */
(function (global) {
  function normalizeBase(url) {
    if (!url || typeof url !== 'string') return '';
    return url.replace(/\/+$/, '');
  }

  /** Корень OpenAI-совместимого API: …/v1 (без дубля, если в baseUrl уже есть /v1). */
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
    var head = String(text || '').slice(0, 600);
    return /413|Payload Too Large/i.test(head);
  }

  global.CloudRuClient = {
    /**
     * POST /v1/chat/completions
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
      if (body.temperature === undefined) body.temperature = 0.5;
      if (opts.tools && opts.tools.length) {
        body.tools = opts.tools;
        body.tool_choice = opts.tool_choice || 'auto';
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
      var res;
      try {
        res = await fetch(url, fetchOpts);
      } catch (fetchErr) {
        if (fetchErr && fetchErr.name === 'AbortError') throw fetchErr;
        throw new Error('Не удалось подключиться к ' + url + ': ' + (fetchErr.message || fetchErr));
      }
      throwIfAbortCheck(opts.abortCheck);
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
     * Транскрипция аудио (если ваш endpoint FM отличается — поправьте путь).
     * Ожидается multipart с полем file + model (как OpenAI whisper).
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
      var res;
      try {
        res = await fetch(url, trFetch);
      } catch (fetchErr) {
        if (fetchErr && fetchErr.name === 'AbortError') throw fetchErr;
        throw new Error('Не удалось подключиться к Whisper API (' + url + '): ' + (fetchErr.message || fetchErr));
      }
      throwIfAbortCheck(opts.abortCheck);
      var text = await res.text();
      if (isPayloadTooLarge(res.status, text)) {
        throw new Error(
          '413 Payload Too Large — аудио слишком большое для API. Включите пресет .epr и transcribeExportChunkSec в fm-defaults.js (экспорт In–Out чанками).'
        );
      }
      var data = parseJsonResponse(text, 'Транскрипция: не JSON');
      if (!res.ok) {
        throw new Error(data.error && data.error.message ? data.error.message : text.slice(0, 300));
      }
      return data;
    }
  };
})(window);
