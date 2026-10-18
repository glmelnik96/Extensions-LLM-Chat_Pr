import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadIife } from './helpers.mjs';

/* MomentEmbeddings — семантический слой find_moments (18.10.2026):
   векторы абзацев в entry, запрос с инструкцией, гибрид FindMoments.rankHybrid,
   тихий фолбэк на лексический FindMoments.find. */

const root = {};
loadIife('client/shared/find-moments.js', 'FindMoments', root);
const ME = loadIife('client/shared/moment-embeddings.js', 'MomentEmbeddings', root);
const M = 'ai-sage/Giga-Embeddings-instruct-3B';

/* Фейковый эмбеддер: оси = ключевые темы; текст → нормированные счётчики тем. */
const AXES = [/steam|стим|комисс|площадк/i, /движ|unity/i, /погод|дожд/i, /тест|fps/i];
function vecOf(text) {
  const v = AXES.map((re) => (re.test(text) ? 1 : 0));
  v.push(0.05); /* фон: ненулевая норма у «ни о чём» */
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
}
function makeEmbedder() {
  const calls = [];
  const fn = (texts) => {
    calls.push(texts.slice());
    return Promise.resolve(texts.map(vecOf));
  };
  return { fn, calls, texts: () => calls.flat() };
}
function makeEntry() {
  return {
    paragraphs: [
      { startSec: 0, endSec: 10, text: 'Сначала про погоду, обещали дождь.' },
      { startSec: 10, endSec: 20, text: 'Площадка забирает тридцать процентов, это комиссия Steam.' },
      { startSec: 20, endSec: 30, text: 'Свой движок проще, чем Unity.' },
      { startSec: 30, endSec: 40, text: 'Про тесты и FPS поговорим позже.' }
    ],
    segments: [
      { startSec: 0, endSec: 10, text: 'Сначала про погоду, обещали дождь.' },
      { startSec: 10, endSec: 20, text: 'Площадка забирает тридцать процентов, это комиссия Steam.' },
      { startSec: 20, endSec: 30, text: 'Свой движок проще, чем Unity.' },
      { startSec: 30, endSec: 40, text: 'Про тесты и FPS поговорим позже.' }
    ]
  };
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

beforeEach(() => ME._resetForTests());

describe('MomentEmbeddings: ключи и сжатие векторов', () => {
  test('textKey стабилен для одного текста и различает разные', () => {
    assert.equal(ME.textKey('Привет, мир'), ME.textKey('Привет, мир'));
    assert.notEqual(ME.textKey('Привет, мир'), ME.textKey('Привет, мир!'));
    assert.match(ME.textKey('abc'), /^[0-9a-f]{8}-[0-9a-z]+$/);
  });

  test('int8 в base64: 2048 измерений → 2732 символа, направление сохраняется', () => {
    const v = Array.from({ length: 2048 }, (_, i) => Math.sin(i * 12.9898) * 0.5);
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    const unit = v.map((x) => x / n);
    const s = ME.encodeVector(unit);
    assert.equal(s.length, 2732);
    const back = ME.decodeVector(s);
    assert.equal(back.length, 2048);
    assert.ok(Math.abs(dot(back, back) - 1) < 1e-4, 'декод нормирован');
    assert.ok(dot(back, unit) > 0.999, `cos=${dot(back, unit)}`);
  });
});

describe('MomentEmbeddings.ensureParagraphVectors', () => {
  test('первый раз эмбеддит все абзацы и кладёт в entry, второй — ни одного запроса', async () => {
    const e = makeEntry();
    const emb = makeEmbedder();
    const r1 = await ME.ensureParagraphVectors(e, { model: M, embedTexts: emb.fn });
    assert.equal(r1.added, 4);
    assert.equal(r1.changed, true);
    assert.equal(r1.vectors.length, 4);
    assert.equal(e.momentEmbeddings.model, M);
    assert.equal(Object.keys(e.momentEmbeddings.vecs).length, 4);
    const r2 = await ME.ensureParagraphVectors(e, { model: M, embedTexts: emb.fn });
    assert.equal(r2.added, 0);
    assert.equal(r2.changed, false);
    assert.equal(emb.calls.length, 1);
    assert.ok(dot(r2.vectors[1], vecOf(e.paragraphs[1].text)) > 0.999);
  });

  test('после пересборки абзацев эмбеддит только изменившийся текст, устаревшие ключи чистит', async () => {
    const e = makeEntry();
    const emb = makeEmbedder();
    await ME.ensureParagraphVectors(e, { model: M, embedTexts: emb.fn });
    e.paragraphs[3] = { startSec: 30, endSec: 41, text: 'Профилирование и FPS — отдельная боль.' };
    const r = await ME.ensureParagraphVectors(e, { model: M, embedTexts: emb.fn });
    assert.equal(r.added, 1);
    assert.deepEqual(emb.calls[1], ['Профилирование и FPS — отдельная боль.']);
    assert.equal(Object.keys(e.momentEmbeddings.vecs).length, 4, 'старый вектор удалён');
  });

  test('повторный вызов без изменений не декодирует векторы заново (те же Float32Array)', async () => {
    const e = makeEntry();
    const emb = makeEmbedder();
    const r1 = await ME.ensureParagraphVectors(e, { model: M, embedTexts: emb.fn });
    const r2 = await ME.ensureParagraphVectors(e, { model: M, embedTexts: emb.fn });
    assert.equal(r2.vectors[0], r1.vectors[0]);
    e.paragraphs[0] = { startSec: 0, endSec: 10, text: 'Другая погода.' };
    const r3 = await ME.ensureParagraphVectors(e, { model: M, embedTexts: emb.fn });
    assert.equal(r3.vectors[1], r1.vectors[1], 'неизменившийся абзац — из памяти');
    assert.notEqual(r3.vectors[0], r1.vectors[0]);
  });

  test('смена модели — векторы считаются заново', async () => {
    const e = makeEntry();
    const emb = makeEmbedder();
    await ME.ensureParagraphVectors(e, { model: M, embedTexts: emb.fn });
    const r = await ME.ensureParagraphVectors(e, { model: 'other/model', embedTexts: emb.fn });
    assert.equal(r.added, 4);
    assert.equal(e.momentEmbeddings.model, 'other/model');
  });

  test('батчи по batchSize', async () => {
    const e = makeEntry();
    const emb = makeEmbedder();
    await ME.ensureParagraphVectors(e, { model: M, embedTexts: emb.fn, batchSize: 3 });
    assert.deepEqual(emb.calls.map((c) => c.length), [3, 1]);
  });

  test('сбой эмбеддера → reject, entry не тронут', async () => {
    const e = makeEntry();
    let n = 0;
    const flaky = (texts) => (++n === 2 ? Promise.reject(new Error('HTTP 502')) : Promise.resolve(texts.map(vecOf)));
    await assert.rejects(ME.ensureParagraphVectors(e, { model: M, embedTexts: flaky, batchSize: 2 }), /502/);
    assert.equal(e.momentEmbeddings, undefined);
  });
});

describe('MomentEmbeddings.search', () => {
  test('семантика: находит комиссию Steam по запросу без общих слов', async () => {
    const e = makeEntry();
    const emb = makeEmbedder();
    const r = await ME.search(e, 'сколько берёт стим', { model: M, embedTexts: emb.fn, k: 5 });
    assert.equal(r.mode, 'semantic');
    assert.equal(r.moments[0].startSec, 10);
    assert.equal(r.moments[0].matchType, 'semantic');
    assert.equal(r.persist, true, 'векторы добавлены — панели нужно сохранить entry');
    assert.equal(r.weak, false);
  });

  test('запрос эмбеддится с инструкцией, абзацы — без', async () => {
    const e = makeEntry();
    const emb = makeEmbedder();
    await ME.search(e, 'движок', { model: M, embedTexts: emb.fn });
    const all = emb.texts();
    assert.ok(all.includes(ME.QUERY_INSTRUCT + 'движок'));
    assert.ok(all.includes(e.paragraphs[0].text));
    assert.ok(ME.QUERY_INSTRUCT.indexOf('Instruct: ') === 0 && /\nQuery: $/.test(ME.QUERY_INSTRUCT));
  });

  test('повторный запрос: векторы абзацев и запроса из кэша, сеть не трогаем', async () => {
    const e = makeEntry();
    const emb = makeEmbedder();
    await ME.search(e, 'движок', { model: M, embedTexts: emb.fn });
    const n = emb.calls.length;
    const r = await ME.search(e, 'движок', { model: M, embedTexts: emb.fn });
    assert.equal(emb.calls.length, n);
    assert.equal(r.persist, false);
  });

  test('lexWeight пробрасывается в rankHybrid (0 — чистый косинус, для бенчмарка)', async () => {
    const e = {
      paragraphs: [
        { startSec: 0, endSec: 10, text: 'Площадка берёт свою долю.' },
        { startSec: 10, endSec: 20, text: 'Комиссия Steam — тридцать процентов.' },
        { startSec: 20, endSec: 30, text: 'Про погоду.' }
      ]
    };
    /* два абзаца на оси Steam, первый чуть ближе к запросу; третий далеко */
    const emb = (texts) => Promise.resolve(texts.map((t) =>
      (/Комиссия/.test(t) ? [0.95, 0.31] : /погод/.test(t) ? [0, 1] : [1, 0.2])));
    const pure = await ME.search(e, 'комиссия', { model: M, embedTexts: emb, lexWeight: 0 });
    assert.equal(pure.moments[0].startSec, 0);
    ME._resetForTests();
    const hybrid = await ME.search(e, 'комиссия', { model: M, embedTexts: emb });
    assert.equal(hybrid.moments[0].startSec, 10, 'словоформа запроса поднимает второй абзац');
  });

  test('слабое совпадение: тема не встречается → weak', async () => {
    const e = makeEntry();
    const r = await ME.search(e, 'рецепт борща', { model: M, embedTexts: makeEmbedder().fn });
    assert.equal(r.mode, 'semantic');
    assert.equal(r.weak, true);
  });

  test('нет модели или эмбеддера → лексика FindMoments.find', async () => {
    const e = makeEntry();
    const r = await ME.search(e, 'комиссия', { model: '', embedTexts: makeEmbedder().fn });
    assert.equal(r.mode, 'lexical');
    assert.deepEqual(r.moments, root.FindMoments.find(e, 'комиссия', { k: 20 }));
    assert.ok(r.fallbackReason);
  });

  test('нет абзацев → лексика по сегментам', async () => {
    const e = makeEntry();
    e.paragraphs = [];
    const emb = makeEmbedder();
    const r = await ME.search(e, 'комиссия', { model: M, embedTexts: emb.fn });
    assert.equal(r.mode, 'lexical');
    assert.equal(emb.calls.length, 0);
    assert.equal(r.moments[0].startSec, 10);
  });

  test('сбой сети → лексика с причиной; следующий вызов снова пробует эмбеддинги', async () => {
    const e = makeEntry();
    let fail = true;
    const emb = (texts) => (fail ? Promise.reject(Object.assign(new Error('HTTP 502'), { httpStatus: 502 })) : Promise.resolve(texts.map(vecOf)));
    const r1 = await ME.search(e, 'комиссия', { model: M, embedTexts: emb });
    assert.equal(r1.mode, 'lexical');
    assert.match(r1.fallbackReason, /502/);
    fail = false;
    const r2 = await ME.search(e, 'комиссия', { model: M, embedTexts: emb });
    assert.equal(r2.mode, 'semantic');
  });

  test('403 «модель не в проекте» → лексика и пауза 30 мин без запросов', async () => {
    const e = makeEntry();
    let calls = 0;
    const deny = () => { calls++; return Promise.reject(Object.assign(new Error('not available for this project'), { httpStatus: 403 })); };
    const t0 = 1_000_000;
    const r1 = await ME.search(e, 'комиссия', { model: M, embedTexts: deny, now: t0 });
    assert.equal(r1.mode, 'lexical');
    const r2 = await ME.search(e, 'комиссия', { model: M, embedTexts: deny, now: t0 + 60_000 });
    assert.equal(r2.mode, 'lexical');
    assert.equal(calls, 1, 'в паузе эмбеддер не зовём');
    assert.match(r2.fallbackReason, /недоступен: not available for this project/);
    await ME.search(e, 'комиссия', { model: M, embedTexts: deny, now: t0 + 31 * 60_000 });
    assert.equal(calls, 2, 'после паузы — новая попытка');
  });

  test('таймаут (API висит) → лексика и пауза 5 мин: агент не ждёт таймаут на каждом вызове', async () => {
    const e = makeEntry();
    let calls = 0;
    const hang = () => { calls++; return Promise.reject(new Error('Таймаут запроса (20с)')); };
    const t0 = 5_000_000;
    const r1 = await ME.search(e, 'комиссия', { model: M, embedTexts: hang, now: t0 });
    assert.equal(r1.mode, 'lexical');
    await ME.search(e, 'комиссия', { model: M, embedTexts: hang, now: t0 + 4 * 60_000 });
    assert.equal(calls, 1);
    await ME.search(e, 'комиссия', { model: M, embedTexts: hang, now: t0 + 6 * 60_000 });
    assert.equal(calls, 2);
  });

  test('Стоп (AbortError) пробрасывается, а не прячется в фолбэк', async () => {
    const e = makeEntry();
    const abort = () => Promise.reject(Object.assign(new Error('Остановлено пользователем'), { name: 'AbortError' }));
    await assert.rejects(ME.search(e, 'комиссия', { model: M, embedTexts: abort }), { name: 'AbortError' });
  });
});

describe('fm-defaults: модель эмбеддингов', () => {
  test('embeddingModel задана и есть в тарифах (UsageMeter считает ₽)', () => {
    const FM = loadIife('client/shared/fm-defaults.js', 'FM_DEFAULTS');
    assert.equal(FM.embeddingModel, M);
    const rate = FM.pricing.models[FM.embeddingModel];
    assert.ok(rate && rate.inPerM > 0, 'тариф эмбеддингов');
  });
});
