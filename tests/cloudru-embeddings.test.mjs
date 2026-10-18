import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCloudRuClientRoot } from './load-cloudru-client.mjs';

/* CloudRuClient.embeddings — POST /v1/embeddings для find_moments (18.10.2026). */

const M = 'ai-sage/Giga-Embeddings-instruct-3B';

function b64(floats) {
  return Buffer.from(new Float32Array(floats).buffer).toString('base64');
}
function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get() { return null; } },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}
function load(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(calls[calls.length - 1]);
  };
  const root = loadCloudRuClientRoot({ fetch, atob });
  return { CC: root.CloudRuClient, root, calls };
}
const near = (a, b) => Math.abs(a - b) < 1e-6;

describe('CloudRuClient.embeddings', () => {
  test('POST /v1/embeddings: модель, тексты, base64, ключ в Bearer', async () => {
    const { CC, calls } = load(() => fakeResponse(200, {
      data: [{ index: 0, embedding: b64([1, 0]) }],
      usage: { prompt_tokens: 3 }
    }));
    await CC.embeddings({ baseUrl: 'https://fm.example/', apiKey: 'k1', model: M, input: ['привет'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://fm.example/v1/embeddings');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer k1');
    assert.equal(calls[0].body.model, M);
    assert.deepEqual([...calls[0].body.input], ['привет']);
    assert.equal(calls[0].body.encoding_format, 'base64');
  });

  test('раскладывает векторы по index (порядок входа), декодирует base64 float32', async () => {
    const { CC } = load(() => fakeResponse(200, {
      data: [
        { index: 1, embedding: b64([0, 1, 0]) },
        { index: 0, embedding: b64([0.6, 0, 0.8]) }
      ],
      usage: { prompt_tokens: 7 }
    }));
    const r = await CC.embeddings({ baseUrl: 'https://fm.example', apiKey: 'k', model: M, input: ['a', 'b'] });
    assert.equal(r.vectors.length, 2);
    assert.ok(near(r.vectors[0][0], 0.6) && near(r.vectors[0][2], 0.8), String(r.vectors[0]));
    assert.ok(near(r.vectors[1][1], 1));
  });

  test('сервер вернул массивы чисел вместо base64 — тоже принимаем', async () => {
    const { CC } = load(() => fakeResponse(200, { data: [{ index: 0, embedding: [0.25, 0.5] }] }));
    const r = await CC.embeddings({ baseUrl: 'https://fm.example', apiKey: 'k', model: M, input: ['a'] });
    assert.ok(near(r.vectors[0][0], 0.25) && near(r.vectors[0][1], 0.5));
  });

  test('403 «не в проекте» → ошибка с httpStatus и текстом сервера', async () => {
    const { CC } = load(() => fakeResponse(403, 'Requested model is not available for this project'));
    await assert.rejects(
      CC.embeddings({ baseUrl: 'https://fm.example', apiKey: 'k', model: M, input: ['a'] }),
      (e) => e.httpStatus === 403 && /not available for this project/.test(e.message) && e.message.includes(M)
    );
  });

  test('векторов меньше, чем текстов → ошибка', async () => {
    const { CC } = load(() => fakeResponse(200, { data: [{ index: 0, embedding: [1] }] }));
    await assert.rejects(
      CC.embeddings({ baseUrl: 'https://fm.example', apiKey: 'k', model: M, input: ['a', 'b'] }),
      /векторов 1 на 2 текстов/
    );
  });

  test('расход пишется в UsageMeter.recordEmbedding', async () => {
    const { CC, root } = load(() => fakeResponse(200, {
      model: M, data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 42 }
    }));
    const seen = [];
    root.UsageMeter = { recordEmbedding: (model, tokens) => seen.push([model, tokens]) };
    await CC.embeddings({ baseUrl: 'https://fm.example', apiKey: 'k', model: M, input: ['a'] });
    assert.deepEqual(seen, [[M, 42]]);
  });

  test('без ключа — понятная ошибка до сети', async () => {
    const { CC, calls } = load(() => fakeResponse(200, {}));
    await assert.rejects(CC.embeddings({ baseUrl: 'https://fm.example', apiKey: '', model: M, input: ['a'] }), /fm-secrets\.js/);
    assert.equal(calls.length, 0);
  });
});
