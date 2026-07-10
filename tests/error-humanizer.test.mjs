import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadErrorHumanizer } from './load-error-humanizer.mjs';

const EH = loadErrorHumanizer();

/* Волна 2 п.1 плана усиления: каталог человеко-читаемых ошибок.
   Проверяем kind + что hint содержит конкретную инструкцию (не generic). */
describe('ErrorHumanizer.classify — каталог', () => {
  const cases = [
    /* [входное сообщение, ожидаемый kind, фрагмент подсказки] */
    ['AbortError: The user aborted a request.', 'cancel', 'отменена'],
    ['Остановлено пользователем', 'cancel', 'отменена'],
    ['HTTP 401 Unauthorized', 'auth', 'fm-secrets'],
    ['invalid api key provided', 'auth', 'ключ'],
    ['HTTP 403 Forbidden', 'auth', 'прав'],
    ['HTTP 404: model glm-5 not found', 'model', 'fm-defaults'],
    ['HTTP 413 Payload Too Large', 'payload', '25MB'],
    ['HTTP 429 Too Many Requests: rate limit', 'quota', 'Retry-After'],
    ['HTTP 502 Bad Gateway', 'server', 'Cloud.ru'],
    ['HTTP 503 Service Unavailable', 'server', 'повторите'],
    ['self signed certificate in certificate chain', 'tls', 'TLS'],
    ['getaddrinfo ENOTFOUND foundation-models.api.cloud.ru', 'network', 'DNS'],
    ['connect ETIMEDOUT 1.2.3.4:443', 'network', 'Таймаут'],
    ['read ECONNRESET', 'network', 'файрвол'],
    ['connect ECONNREFUSED 127.0.0.1:443', 'network', 'файрвол'],
    ['spawn ffmpeg ENOENT', 'ffmpeg', 'winget'],
    ['ffmpeg error (chunk 3): Invalid data found', 'ffmpeg', 'формат'],
    ['ffmpeg вернул пустой чанк', 'ffmpeg', 'формат'],
    ['Whisper вернул пустой транскрипт', 'media', 'речь'],
    ['TypeError: Failed to fetch', 'network', 'VPN'],
  ];

  for (const [msg, kind, hintFrag] of cases) {
    test(`«${msg}» → ${kind}`, () => {
      const c = EH.classify(msg);
      assert.equal(c.kind, kind, `kind: got ${c.kind}`);
      assert.ok(
        c.hint.toLowerCase().includes(hintFrag.toLowerCase()),
        `hint должен содержать «${hintFrag}»: ${c.hint}`
      );
    });
  }

  test('принимает Error-объект (не только строку)', () => {
    const c = EH.classify(new Error('HTTP 429 rate limit'));
    assert.equal(c.kind, 'quota');
  });

  test('неизвестная ошибка → other без hint', () => {
    const c = EH.classify('что-то совсем странное');
    assert.equal(c.kind, 'other');
    assert.equal(c.hint, '');
  });

  test('null/пусто → other, не падает', () => {
    assert.equal(EH.classify(null).kind, 'other');
    assert.equal(EH.classify('').kind, 'other');
    assert.equal(EH.classify(undefined).kind, 'other');
  });

  test('приоритет: cancel побеждает сеть (abort при fetch)', () => {
    /* abort посреди fetch содержит оба маркера — это отмена, не сбой сети */
    const c = EH.classify('AbortError: fetch aborted');
    assert.equal(c.kind, 'cancel');
  });

  test('приоритет: специфичный HTTP-статус побеждает generic network', () => {
    const c = EH.classify('fetch failed: HTTP 429 rate limit');
    assert.equal(c.kind, 'quota');
  });

  test('токен 23413 в теле НЕ триггерит payload (нужна граница слова)', () => {
    const c = EH.classify('response tokens: 23413');
    assert.notEqual(c.kind, 'payload');
  });
});

describe('ErrorHumanizer.withHint', () => {
  test('добавляет подсказку через « — »', () => {
    const s = EH.withHint('HTTP 401 Unauthorized');
    assert.ok(s.startsWith('HTTP 401 Unauthorized — '));
    assert.ok(s.includes('fm-secrets'));
  });

  test('не дублирует подсказку, если она уже в сообщении', () => {
    const first = EH.withHint('HTTP 401 Unauthorized');
    assert.equal(EH.withHint(first), first);
  });

  test('без матча — сообщение как есть', () => {
    assert.equal(EH.withHint('просто текст'), 'просто текст');
  });

  test('пусто → пустая строка', () => {
    assert.equal(EH.withHint(''), '');
    assert.equal(EH.withHint(null), '');
  });
});
