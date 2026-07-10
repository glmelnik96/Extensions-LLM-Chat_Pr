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
});
