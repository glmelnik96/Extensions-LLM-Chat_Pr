import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import assertLoose from 'node:assert';
import { loadCloudRuClient, makeSSEResponse } from './load-cloudru-client.mjs';

const CR = loadCloudRuClient();

/* ═══════════════════════════════════════════════════════════════
 * normalizeBase / apiV1Root — нормализация URL
 * ═══════════════════════════════════════════════════════════════ */
describe('cloudru-client.normalizeBase', () => {
  test('срезает хвостовые слэши', () => {
    assert.equal(CR.normalizeBase('http://x/'), 'http://x');
    assert.equal(CR.normalizeBase('http://x///'), 'http://x');
  });
  test('без хвоста — без изменений', () => {
    assert.equal(CR.normalizeBase('http://x/api'), 'http://x/api');
  });
  test('пустой/не-строка → ""', () => {
    assert.equal(CR.normalizeBase(''), '');
    assert.equal(CR.normalizeBase(null), '');
    assert.equal(CR.normalizeBase(undefined), '');
  });
});

describe('cloudru-client.apiV1Root', () => {
  test('добавляет /v1 если нет', () => {
    assert.equal(CR.apiV1Root('http://x'), 'http://x/v1');
    assert.equal(CR.apiV1Root('http://x/'), 'http://x/v1');
  });
  test('не дублирует существующий /v1 (регистронезависимо)', () => {
    assert.equal(CR.apiV1Root('http://x/v1'), 'http://x/v1');
    assert.equal(CR.apiV1Root('http://x/V1'), 'http://x/V1');
  });
  test('пустой base → ""', () => {
    assert.equal(CR.apiV1Root(''), '');
  });
});

/* ═══════════════════════════════════════════════════════════════
 * parseJsonResponse — JSON или внятная ошибка
 * ═══════════════════════════════════════════════════════════════ */
describe('cloudru-client.parseJsonResponse', () => {
  test('валидный JSON парсится', () => {
    assertLoose.deepEqual(CR.parseJsonResponse('{"ok":true}'), { ok: true });
  });
  test('мусор → ошибка с префиксом и срезом тела', () => {
    assert.throws(() => CR.parseJsonResponse('garbage', 'Ответ не JSON'), /Ответ не JSON: garbage/);
  });
  test('HTML-тело → подсказка про неверный URL/413', () => {
    assert.throws(
      () => CR.parseJsonResponse('<!DOCTYPE html><html><body>oops</body></html>', 'Ответ не JSON'),
      /HTML вместо JSON/
    );
  });
});

/* ═══════════════════════════════════════════════════════════════
 * isPayloadTooLarge — классификация 413
 * ═══════════════════════════════════════════════════════════════ */
describe('cloudru-client.isPayloadTooLarge', () => {
  test('status 413 → true', () => {
    assert.equal(CR.isPayloadTooLarge(413, ''), true);
  });
  test('2xx → false даже если в теле есть похожие на 413 токены', () => {
    /* Whisper verbose_json: token id 23413 не должен триггерить 413 */
    assert.equal(CR.isPayloadTooLarge(200, '{"tokens":[23413]}'), false);
  });
  test('5xx/4xx с "Payload Too Large" в теле → true', () => {
    assert.equal(CR.isPayloadTooLarge(500, 'Payload Too Large'), true);
    assert.equal(CR.isPayloadTooLarge(502, 'Error 413 occurred'), true);
  });
  test('ошибочный статус без признаков → false', () => {
    assert.equal(CR.isPayloadTooLarge(500, 'internal error'), false);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * isRetryable — какие статусы повторяем
 * ═══════════════════════════════════════════════════════════════ */
describe('cloudru-client.isRetryable', () => {
  test('5xx → retry', () => {
    assert.equal(CR.isRetryable(500), true);
    assert.equal(CR.isRetryable(503), true);
  });
  test('429 → retry', () => {
    assert.equal(CR.isRetryable(429), true);
  });
  test('прочие 4xx и 2xx → нет', () => {
    assert.equal(CR.isRetryable(400), false);
    assert.equal(CR.isRetryable(404), false);
    assert.equal(CR.isRetryable(200), false);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * parseSSEStream — агрегация стрима в обычный ответ
 * ═══════════════════════════════════════════════════════════════ */
function sse(chunks) {
  return chunks.map((c) => 'data: ' + JSON.stringify(c)).join('\n\n') + '\n\ndata: [DONE]\n\n';
}

describe('cloudru-client.parseSSEStream', () => {
  test('агрегирует content-дельты и зовёт onChunk', async () => {
    const text = sse([
      { model: 'glm', choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
    const got = [];
    const res = await CR.parseSSEStream(makeSSEResponse(text), (d) => got.push(d.content));
    assert.equal(res.choices[0].message.content, 'Hello');
    assert.equal(res.choices[0].finish_reason, 'stop');
    assert.equal(res.model, 'glm');
    assert.deepEqual(got, ['Hel', 'lo']);
  });

  test('собирает tool_calls по index из дельт', async () => {
    const text = sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'cut', arguments: '{"a":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);
    const res = await CR.parseSSEStream(makeSSEResponse(text), null);
    const tc = res.choices[0].message.tool_calls;
    assert.equal(tc.length, 1);
    assert.equal(tc[0].id, 'call_1');
    assert.equal(tc[0].function.name, 'cut');
    assert.equal(tc[0].function.arguments, '{"a":1}');
    assert.equal(res.choices[0].finish_reason, 'tool_calls');
    /* при наличии tool_calls content == null */
    assert.equal(res.choices[0].message.content, null);
  });

  test('устойчив к нарезке потока на мелкие байтовые чанки', async () => {
    const text = sse([
      { choices: [{ delta: { content: 'привет ' } }] },
      { choices: [{ delta: { content: 'мир' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
    const res = await CR.parseSSEStream(makeSSEResponse(text, 3), null);
    assert.equal(res.choices[0].message.content, 'привет мир');
  });

  test('игнорирует комментарии, пустые строки и [DONE]', async () => {
    const text = ': keep-alive\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n\n\ndata: [DONE]\n\n';
    const res = await CR.parseSSEStream(makeSSEResponse(text), null);
    assert.equal(res.choices[0].message.content, 'ok');
    assert.equal(res.choices[0].finish_reason, 'stop'); /* дефолт когда finish_reason не пришёл */
  });

  test('reasoning_content собирается отдельно от content', async () => {
    const text = sse([
      { choices: [{ delta: { reasoning_content: 'Счи' } }] },
      { choices: [{ delta: { reasoning_content: 'таю…' } }] },
      { choices: [{ delta: { content: 'Ответ: 391' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
    const got = [];
    const res = await CR.parseSSEStream(makeSSEResponse(text), (d) => got.push(d));
    const msg = res.choices[0].message;
    assert.equal(msg.reasoning_content, 'Считаю…');
    assert.equal(msg.content, 'Ответ: 391', 'мысли не подмешиваются в ответ');
    /* JSON: объекты приходят из vm-песочницы (чужой realm) — deepEqual их не сводит */
    assert.equal(
      JSON.stringify(got),
      JSON.stringify([{ reasoning: 'Счи' }, { reasoning: 'таю…' }, { content: 'Ответ: 391' }])
    );
  });

  test('альтернативный ключ reasoning (часть OpenAI-прокси)', async () => {
    const text = sse([
      { choices: [{ delta: { reasoning: 'мысль' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
    const res = await CR.parseSSEStream(makeSSEResponse(text), null);
    assert.equal(res.choices[0].message.reasoning_content, 'мысль');
  });

  test('без размышлений поля reasoning_content нет вовсе', async () => {
    const text = sse([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
    const res = await CR.parseSSEStream(makeSSEResponse(text), null);
    assert.equal('reasoning_content' in res.choices[0].message, false);
  });

  test('размышления доезжают при нарезке на мелкие чанки', async () => {
    const text = sse([
      { choices: [{ delta: { reasoning_content: 'думаю про ' } }] },
      { choices: [{ delta: { reasoning_content: 'монтаж' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
    const res = await CR.parseSSEStream(makeSSEResponse(text, 3), null);
    assert.equal(res.choices[0].message.reasoning_content, 'думаю про монтаж');
  });

  test('не-строка в reasoning_content игнорируется', async () => {
    const text = sse([
      { choices: [{ delta: { reasoning_content: { a: 1 } } }] },
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
    const res = await CR.parseSSEStream(makeSSEResponse(text), null);
    assert.equal('reasoning_content' in res.choices[0].message, false);
    assert.equal(res.choices[0].message.content, 'ok');
  });

  test('исключение из onChunk на размышлениях не роняет стрим', async () => {
    const text = sse([
      { choices: [{ delta: { reasoning_content: 'r' } }] },
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
    const res = await CR.parseSSEStream(makeSSEResponse(text), () => { throw new Error('UI упал'); });
    assert.equal(res.choices[0].message.content, 'ok');
    assert.equal(res.choices[0].message.reasoning_content, 'r');
  });

  test('две параллельные tool_calls (index 0 и 1) собираются раздельно', async () => {
    const text = sse([
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'a', function: { name: 'f0', arguments: '{}' } },
        { index: 1, id: 'b', function: { name: 'f1', arguments: '{}' } }
      ] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);
    const res = await CR.parseSSEStream(makeSSEResponse(text), null);
    const tc = res.choices[0].message.tool_calls;
    assert.equal(tc.length, 2);
    assert.deepEqual([tc[0].function.name, tc[1].function.name], ['f0', 'f1']);
  });

  test('abortCheck прерывает стрим до завершения (AbortError)', async () => {
    const text = sse([
      { choices: [{ delta: { content: 'a' } }] },
      { choices: [{ delta: { content: 'b' } }] },
      { choices: [{ delta: { content: 'c' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
    /* abortCheck зовётся в начале каждой итерации: 1-я — false (читаем), 2-я — true (abort) */
    let calls = 0;
    const abortCheck = () => (++calls > 1);
    await assert.rejects(
      () => CR.parseSSEStream(makeSSEResponse(text, 8), null, abortCheck),
      (err) => err.name === 'AbortError'
    );
  });

  test('без abortCheck стрим завершается нормально (обратная совместимость)', async () => {
    const text = sse([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
    const res = await CR.parseSSEStream(makeSSEResponse(text), null);
    assert.equal(res.choices[0].message.content, 'ok');
  });
});

/* ═══════════════════════════════════════════════════════════════
 * Retry-After (429 rate limit) — Волна 1.1 плана усиления
 * ═══════════════════════════════════════════════════════════════ */
describe('cloudru-client.parseRetryAfterMs', () => {
  test('секунды → миллисекунды', () => {
    assert.equal(CR.parseRetryAfterMs('7'), 7000);
    assert.equal(CR.parseRetryAfterMs(' 2 '), 2000);
  });
  test('кап 60с против абсурдных значений сервера', () => {
    assert.equal(CR.parseRetryAfterMs('3600'), 60000);
  });
  test('HTTP-date в будущем → положительная задержка с капом', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = CR.parseRetryAfterMs(future);
    assert.ok(ms > 3000 && ms <= 60000, 'got ' + ms);
  });
  test('прошедшая дата / мусор / пусто → 0', () => {
    assert.equal(CR.parseRetryAfterMs(new Date(Date.now() - 5000).toUTCString()), 0);
    assert.equal(CR.parseRetryAfterMs('abc'), 0);
    assert.equal(CR.parseRetryAfterMs(''), 0);
    assert.equal(CR.parseRetryAfterMs(null), 0);
    assert.equal(CR.parseRetryAfterMs('-5'), 0);
  });
});

describe('cloudru-client.fetchWithRetry + Retry-After', () => {
  function make429Then200(retryAfterHeader) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) {
        return {
          status: 429,
          ok: false,
          headers: { get: (name) => (/^retry-after$/i.test(name) ? retryAfterHeader : null) }
        };
      }
      return { status: 200, ok: true, headers: { get: () => null } };
    };
    return { fetchImpl, getCalls: () => calls };
  }

  test('ждёт не меньше Retry-After (7с > базового backoff 1с)', async () => {
    const delays = [];
    /* setTimeout-шпион: записывает задержку, срабатывает мгновенно */
    const fakeSetTimeout = (fn, ms) => setTimeout(() => fn(), 0) && delays.push(ms || 0);
    const { fetchImpl, getCalls } = make429Then200('7');
    const CR2 = loadCloudRuClient({ fetch: fetchImpl, setTimeout: fakeSetTimeout });
    const res = await CR2.fetchWithRetry('http://x', {}, null);
    assert.equal(res.status, 200);
    assert.equal(getCalls(), 2);
    const maxDelay = Math.max(...delays, 0);
    assert.ok(maxDelay >= 7000, 'ожидали задержку ≥7000мс, получили ' + maxDelay);
  });

  test('429 без Retry-After — обычный exp-backoff (~1с ±20%)', async () => {
    const delays = [];
    const fakeSetTimeout = (fn, ms) => setTimeout(() => fn(), 0) && delays.push(ms || 0);
    const { fetchImpl, getCalls } = make429Then200(null);
    const CR2 = loadCloudRuClient({ fetch: fetchImpl, setTimeout: fakeSetTimeout });
    const res = await CR2.fetchWithRetry('http://x', {}, null);
    assert.equal(res.status, 200);
    assert.equal(getCalls(), 2);
    const maxDelay = Math.max(...delays, 0);
    assert.ok(maxDelay >= 700 && maxDelay <= 1300, 'ожидали ~1000мс, получили ' + maxDelay);
  });

  test('opts.maxRetries урезает число попыток (1 → одна попытка, без ретрая 500)', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { status: 500, ok: false, headers: { get: () => null } }; };
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    const res = await CR2.fetchWithRetry('http://x', {}, null, { maxRetries: 1 });
    assert.equal(res.status, 500);
    assert.equal(calls, 1, 'при maxRetries=1 — ровно одна попытка');
  });

  test('AbortError при отменённом fetchOpts.signal (без abortCheck) → пробрасывается, без ретраев', async () => {
    /* Регрессия: вызовы только с signal (без abortCheck) превращали отмену
       пользователя в retryable «Таймаут» и продолжали долбить сеть. */
    let calls = 0;
    const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    const fetchImpl = async () => {
      calls++;
      /* пользователь жмёт «Стоп» во время запроса */
      signal.aborted = true;
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    await assert.rejects(
      () => CR2.fetchWithRetry('http://x', { signal }, null),
      (err) => err.name === 'AbortError'
    );
    assert.equal(calls, 1, 'ровно одна попытка — отмена не ретраится');
  });
});

/* ═══════════════════════════════════════════════════════════════
 * isModelUnavailable — триггер фолбэка на запасную модель (21.07.2026)
 * ═══════════════════════════════════════════════════════════════ */
describe('cloudru-client.isModelUnavailable', () => {
  const U = CR.isModelUnavailable;
  test('наш таймаут (молчаливый висяк) → фолбэк', () => {
    assert.equal(U(new Error('Таймаут запроса (300с)')), true);
  });
  test('сетевой обрыв → фолбэк', () => {
    assert.equal(U(new Error('fetch failed')), true);
    assert.equal(U(new Error('ECONNRESET while reading')), true);
  });
  test('исчерпанный 5xx (message HTTP 5xx) → фолбэк', () => {
    assert.equal(U(new Error('HTTP 500')), true);
    assert.equal(U(new Error('HTTP 503')), true);
  });
  test('httpStatus 5xx/404 → фолбэк', () => {
    assert.equal(U(Object.assign(new Error('x'), { httpStatus: 500 })), true);
    assert.equal(U(Object.assign(new Error('x'), { httpStatus: 503 })), true);
    assert.equal(U(Object.assign(new Error('model not found'), { httpStatus: 404 })), true);
  });
  test('403 (RBAC: модель недоступна аккаунту) → фолбэк (22.07)', () => {
    assert.equal(U(Object.assign(new Error('forbidden'), { httpStatus: 403 })), true);
  });
  test('408/409/425 (транзиентные) → фолбэк', () => {
    assert.equal(U(Object.assign(new Error('req timeout'), { httpStatus: 408 })), true);
    assert.equal(U(Object.assign(new Error('conflict'), { httpStatus: 409 })), true);
    assert.equal(U(Object.assign(new Error('too early'), { httpStatus: 425 })), true);
  });
  test('400/401/422/429 (кривой запрос / ключ / rate-limit) → НЕ фолбэк', () => {
    assert.equal(U(Object.assign(new Error('bad request'), { httpStatus: 400 })), false);
    assert.equal(U(Object.assign(new Error('unauthorized'), { httpStatus: 401 })), false);
    assert.equal(U(Object.assign(new Error('unprocessable'), { httpStatus: 422 })), false);
    assert.equal(U(Object.assign(new Error('rate'), { httpStatus: 429 })), false);
  });
  test('413 (noFallback) и AbortError → НЕ фолбэк', () => {
    assert.equal(U(Object.assign(new Error('413'), { noFallback: true })), false);
    assert.equal(U(Object.assign(new Error('stop'), { name: 'AbortError' })), false);
  });
  test('битый JSON на 200 (модель отвечает) → НЕ фолбэк', () => {
    assert.equal(U(new Error('Ответ не JSON: garbage')), false);
  });
  test('пусто/undefined → НЕ фолбэк', () => {
    assert.equal(U(null), false);
    assert.equal(U(undefined), false);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * chatCompletions — фолбэк на запасную модель при недоступности
 * ═══════════════════════════════════════════════════════════════ */
describe('cloudru-client.chatCompletions fallback', () => {
  /* Мок fetch: поведение по модели (читаем model из тела запроса). */
  function chatFetch(behaviorByModel) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      const model = JSON.parse(opts.body).model;
      calls.push(model);
      const b = behaviorByModel[model];
      if (!b) throw new Error('нет поведения для модели ' + model);
      if (b.throw) {
        const e = new Error(b.throw);
        if (b.name) e.name = b.name;
        throw e;
      }
      return {
        status: b.status,
        ok: b.status >= 200 && b.status < 300,
        headers: { get: () => null },
        text: async () => (typeof b.body === 'string' ? b.body : JSON.stringify(b.body))
      };
    };
    return { fetchImpl, calls };
  }
  const ok = (model) => ({ status: 200, body: { model: model, choices: [{ message: { content: 'ok-' + model } }] } });
  const base = { baseUrl: 'http://x', apiKey: 'k', messages: [{ role: 'user', content: 'hi' }], chatParams: { max_tokens: 10 } };

  test('молчаливый висяк основной (fetch failed) → фолбэк на запасную', async () => {
    const { fetchImpl, calls } = chatFetch({ A: { throw: 'fetch failed' }, B: ok('B') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    const fb = [];
    const data = await CR2.chatCompletions({
      ...base, model: 'A', fallbackModels: ['B'], onModelFallback: (i) => fb.push(i)
    });
    assert.equal(data.choices[0].message.content, 'ok-B');
    assert.deepEqual(calls, ['A', 'B'], 'A один раз (maxRetries=1), затем B');
    assert.equal(fb.length, 1);
    assert.equal(fb[0].from, 'A');
    assert.equal(fb[0].to, 'B');
  });

  test('500 на основной → фолбэк', async () => {
    const { fetchImpl, calls } = chatFetch({ A: { status: 500, body: { error: { message: 'boom' } } }, B: ok('B') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    const data = await CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B'] });
    assert.equal(data.choices[0].message.content, 'ok-B');
    assert.deepEqual(calls, ['A', 'B']);
  });

  test('404 (модель снята) → фолбэк', async () => {
    const { fetchImpl, calls } = chatFetch({ A: { status: 404, body: { error: { message: 'model not found' } } }, B: ok('B') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    const data = await CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B'] });
    assert.equal(data.choices[0].message.content, 'ok-B');
    assert.deepEqual(calls, ['A', 'B']);
  });

  test('404 с ПУСТЫМ телом → фолбэк (живой баг 21.07: снятая модель отдаёт 404 «»)', async () => {
    const { fetchImpl, calls } = chatFetch({ A: { status: 404, body: '' }, B: ok('B') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    const data = await CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B'] });
    assert.equal(data.choices[0].message.content, 'ok-B');
    assert.deepEqual(calls, ['A', 'B'], 'пустое тело не должно ломать классификацию');
  });

  test('502 с HTML-телом (не JSON) → фолбэк', async () => {
    const { fetchImpl, calls } = chatFetch({ A: { status: 502, body: '<html><body>Bad Gateway</body></html>' }, B: ok('B') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    const data = await CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B'] });
    assert.equal(data.choices[0].message.content, 'ok-B');
    assert.deepEqual(calls, ['A', 'B']);
  });

  test('413 → НЕ фолбэк (payload одинаков на любой модели)', async () => {
    const { fetchImpl, calls } = chatFetch({ A: { status: 413, body: 'Payload Too Large' }, B: ok('B') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    await assert.rejects(
      () => CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B'] }),
      /413/
    );
    assert.deepEqual(calls, ['A'], 'B не должна вызываться');
  });

  test('400 (кривой запрос) → НЕ фолбэк', async () => {
    const { fetchImpl, calls } = chatFetch({ A: { status: 400, body: { error: { message: 'bad request' } } }, B: ok('B') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    await assert.rejects(
      () => CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B'] }),
      /bad request/
    );
    assert.deepEqual(calls, ['A']);
  });

  test('AbortError (Стоп) → НЕ фолбэк, пробрасывается', async () => {
    const { fetchImpl, calls } = chatFetch({ A: { throw: 'stop', name: 'AbortError' }, B: ok('B') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    let ac = 0;
    /* Проверки abortCheck до фетча: attemptModel-старт + начало цикла fetchWithRetry —
       обе false, чтобы дойти до fetch; 3-я (в catch на AbortError) — true. */
    const abortCheck = () => (ac++ >= 2);
    const fb = [];
    await assert.rejects(
      () => CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B'], abortCheck, onModelFallback: (i) => fb.push(i) }),
      (err) => err.name === 'AbortError'
    );
    assert.deepEqual(calls, ['A'], 'B не пробуем при отмене пользователем');
    assert.equal(fb.length, 0);
  });

  test('дедуп: primary повторно в fallbackModels не вызывается дважды подряд', async () => {
    const { fetchImpl, calls } = chatFetch({ A: { throw: 'fetch failed' }, B: ok('B') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    const data = await CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['A', 'B'] });
    assert.equal(data.choices[0].message.content, 'ok-B');
    assert.deepEqual(calls, ['A', 'B'], 'дубль A убран');
  });

  test('без fallbackModels — обычное поведение (успех на основной)', async () => {
    const { fetchImpl, calls } = chatFetch({ A: ok('A') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    const data = await CR2.chatCompletions({ ...base, model: 'A' });
    assert.equal(data.choices[0].message.content, 'ok-A');
    assert.deepEqual(calls, ['A']);
  });

  test('все модели недоступны → бросает последнюю ошибку', async () => {
    const { fetchImpl, calls } = chatFetch({ A: { throw: 'fetch failed' }, B: { throw: 'fetch failed' } });
    /* Последняя модель B получает полный MAX_RETRIES=5 с backoff — глушим таймеры. */
    const fakeSetTimeout = (fn) => setTimeout(() => fn(), 0);
    const CR2 = loadCloudRuClient({ fetch: fetchImpl, setTimeout: fakeSetTimeout });
    const fb = [];
    await assert.rejects(
      () => CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B'], onModelFallback: (i) => fb.push(i) }),
      /fetch failed/
    );
    assert.equal(fb.length, 1, 'один переход A→B');
    assert.equal(calls[0], 'A');
    assert.ok(calls.filter((m) => m === 'B').length >= 2, 'B ретраилась как последняя модель');
  });

  /* 18.10.2026: проект ключа пускает только модели из своего списка, остальные
     отвечают 403 plain text «Requested model is not available for this project». */
  const notInProject = { status: 403, body: 'Requested model is not available for this project' };
  const boom = { status: 500, body: { error: { message: 'boom' } } };
  const instantTimers = (fn) => setTimeout(() => fn(), 0);

  test('403 «not available for this project» (plain text) → понятная ошибка с флагами', async () => {
    const { fetchImpl, calls } = chatFetch({ A: notInProject });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    await assert.rejects(
      () => CR2.chatCompletions({ ...base, model: 'A' }),
      (err) => err.httpStatus === 403 && err.modelNotInProject === true && err.model === 'A' &&
        /^Модель A не включена в проект Cloud\.ru/.test(err.message)
    );
    assert.deepEqual(calls, ['A'], '403 не ретраится');
  });

  test('unavailableLead: что именно не работает — в начале сообщения', async () => {
    const { fetchImpl } = chatFetch({ V: notInProject });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    await assert.rejects(
      () => CR2.chatCompletions({ ...base, model: 'V', unavailableLead: 'Описание кадров недоступно' }),
      (err) => /^Описание кадров недоступно: модель V не включена в проект Cloud\.ru/.test(err.message)
    );
  });

  test('основная не в проекте → фолбэк на доступную, причина понятная', async () => {
    const { fetchImpl, calls } = chatFetch({ A: notInProject, B: ok('B') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    const fb = [];
    const data = await CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B'], onModelFallback: (i) => fb.push(i) });
    assert.equal(data.choices[0].message.content, 'ok-B');
    assert.deepEqual(calls, ['A', 'B']);
    assert.match(fb[0].reason, /не включена в проект/);
  });

  test('все запасные не в проекте → ошибка основной модели, а не запасной', async () => {
    const { fetchImpl, calls } = chatFetch({ A: boom, B: notInProject });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl, setTimeout: instantTimers });
    await assert.rejects(
      () => CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B'] }),
      (err) => err.httpStatus === 500 && /boom/.test(err.message) &&
        /Запасные модели не включены в проект Cloud\.ru: B/.test(err.message)
    );
    assert.deepEqual(calls, ['A', 'B']);
  });

  test('запасную, уже ответившую «не в проекте», больше не дёргаем', async () => {
    const { fetchImpl, calls } = chatFetch({ A: boom, B: notInProject, C: ok('C') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    await assert.rejects(() => CR2.chatCompletions({ ...base, model: 'B' }), (e) => e.modelNotInProject === true);
    const fb = [];
    const data = await CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B', 'C'], onModelFallback: (i) => fb.push(i) });
    assert.equal(data.choices[0].message.content, 'ok-C');
    assert.deepEqual(calls, ['B', 'A', 'C'], 'B второй раз не вызывается');
    assert.equal(fb[0].from, 'A');
    assert.equal(fb[0].to, 'C');
  });

  test('все запасные известно не в проекте → основная одна, с полным бюджетом ретраев', async () => {
    const { fetchImpl, calls } = chatFetch({ A: boom, B: notInProject });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl, setTimeout: instantTimers });
    await assert.rejects(() => CR2.chatCompletions({ ...base, model: 'B' }));
    await assert.rejects(
      () => CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B'] }),
      (err) => /boom/.test(err.message) && /не включены в проект Cloud\.ru: B/.test(err.message)
    );
    assert.equal(calls.filter((m) => m === 'B').length, 1, 'B — только в первом вызове');
    assert.ok(calls.filter((m) => m === 'A').length >= 2, 'A ретраилась как единственная модель');
  });

  test('пометка «не в проекте» живёт 30 мин, потом модель пробуем снова', async () => {
    let now = 1e12;
    class FakeDate extends Date { static now() { return now; } }
    const { fetchImpl, calls } = chatFetch({ A: boom, B: notInProject, C: ok('C') });
    const CR2 = loadCloudRuClient({ fetch: fetchImpl, Date: FakeDate });
    await assert.rejects(() => CR2.chatCompletions({ ...base, model: 'B' }));
    now += 31 * 60 * 1000;
    await CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B', 'C'] });
    assert.deepEqual(calls, ['B', 'A', 'B', 'C']);
  });

  test('успешный ответ снимает пометку (администратор включил модель)', async () => {
    const behavior = { A: boom, B: notInProject, C: ok('C') };
    const { fetchImpl } = chatFetch(behavior);
    const CR2 = loadCloudRuClient({ fetch: fetchImpl });
    await assert.rejects(() => CR2.chatCompletions({ ...base, model: 'B' }));
    behavior.B = ok('B');
    /* основную пробуем всегда, даже помеченную */
    await CR2.chatCompletions({ ...base, model: 'B' });
    const data = await CR2.chatCompletions({ ...base, model: 'A', fallbackModels: ['B', 'C'] });
    assert.equal(data.choices[0].message.content, 'ok-B');
  });
});

describe('cloudru-client.isModelNotInProject', () => {
  const N = CR.isModelNotInProject;
  const TEXT = 'Requested model is not available for this project';
  test('403 + plain text «not available for this project» → true', () => {
    assert.equal(N(403, TEXT), true);
  });
  test('тот же текст в JSON-обёртке → true', () => {
    assert.equal(N(403, JSON.stringify({ error: { message: TEXT } })), true);
  });
  test('старый 403 RBAC, другие статусы, пустое тело → false', () => {
    assert.equal(N(403, '403 RBAC: Access Denied'), false);
    assert.equal(N(404, TEXT), false);
    assert.equal(N(200, TEXT), false);
    assert.equal(N(403, ''), false);
    assert.equal(N(403, null), false);
  });
});

describe('cloudru-client.transcribeAudio — ошибки API', () => {
  function trFetch(status, body) {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => body };
    };
    return { fetchImpl, calls };
  }
  const trBase = { baseUrl: 'http://x', apiKey: 'k', model: 'openai/whisper-large-v3', fileBlob: new Blob(['x']), fileName: 'a.mp3' };

  test('403 plain text → «Транскрибация недоступна: модель … не включена в проект», а не «не JSON»', async () => {
    const { fetchImpl, calls } = trFetch(403, 'Requested model is not available for this project');
    const CR2 = loadCloudRuClient({ fetch: fetchImpl, FormData, Blob });
    await assert.rejects(
      () => CR2.transcribeAudio(trBase),
      (err) => err.httpStatus === 403 && err.modelNotInProject === true && err.model === 'openai/whisper-large-v3' &&
        /^Транскрибация недоступна: модель openai\/whisper-large-v3 не включена в проект Cloud\.ru/.test(err.message)
    );
    assert.equal(calls.length, 1, '403 не ретраится');
  });

  test('502 с HTML-телом → ошибка со статусом, а не «не JSON»', async () => {
    const { fetchImpl } = trFetch(502, '<html><body>upstream error</body></html>');
    const CR2 = loadCloudRuClient({ fetch: fetchImpl, FormData, Blob, setTimeout: (fn) => setTimeout(() => fn(), 0) });
    await assert.rejects(
      () => CR2.transcribeAudio(trBase),
      (err) => err.httpStatus === 502 && /^HTTP 502/.test(err.message) && !/не JSON/.test(err.message)
    );
  });

  test('успешный ответ разбирается как раньше', async () => {
    const { fetchImpl } = trFetch(200, JSON.stringify({ text: 'привет', segments: [] }));
    const CR2 = loadCloudRuClient({ fetch: fetchImpl, FormData, Blob });
    const data = await CR2.transcribeAudio(trBase);
    assert.equal(data.text, 'привет');
  });
});
