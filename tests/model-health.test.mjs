import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../client/shared/model-health.js');

function loadModelHealth() {
  const code = readFileSync(SRC, 'utf8');
  const ctx = {
    Array, Object, Math, String, Number, JSON, Error, RegExp, Date, isFinite,
    console, undefined,
    module: { exports: {} },
    exports: {}
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.ModelHealth;
}

const MH = loadModelHealth();

function fakeStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    _data: data
  };
}

function httpErr(status) {
  const e = new Error('HTTP ' + status);
  e.httpStatus = status;
  return e;
}

describe('ModelHealth.classifyError', () => {
  test('403 RBAC → недоступна', () => {
    const c = MH.classifyError(httpErr(403));
    assert.equal(c.state, MH.UNAVAILABLE);
    assert.match(c.reason, /403/);
  });

  test('404 → снята', () => {
    assert.equal(MH.classifyError(httpErr(404)).state, MH.UNAVAILABLE);
  });

  test('5xx → недоступна', () => {
    assert.equal(MH.classifyError(httpErr(500)).state, MH.UNAVAILABLE);
    assert.equal(MH.classifyError(httpErr(503)).state, MH.UNAVAILABLE);
  });

  test('429 → неизвестно (лимит, не поломка модели)', () => {
    assert.equal(MH.classifyError(httpErr(429)).state, MH.UNKNOWN);
  });

  test('401/400/422 → неизвестно (ключ/запрос, а не модель)', () => {
    assert.equal(MH.classifyError(httpErr(401)).state, MH.UNKNOWN);
    assert.equal(MH.classifyError(httpErr(400)).state, MH.UNKNOWN);
    assert.equal(MH.classifyError(httpErr(422)).state, MH.UNKNOWN);
  });

  test('отмена пользователем → неизвестно', () => {
    const e = new Error('aborted'); e.name = 'AbortError';
    assert.equal(MH.classifyError(e).state, MH.UNKNOWN);
  });

  test('таймаут → недоступна, сетевой обрыв → неизвестно', () => {
    assert.equal(MH.classifyError(new Error('Таймаут запроса (300с)')).state, MH.UNAVAILABLE);
    assert.equal(MH.classifyError(new Error('fetch failed')).state, MH.UNKNOWN);
  });

  test('нет ошибки → ok', () => {
    assert.equal(MH.classifyError(null).state, MH.OK);
  });
});

describe('ModelHealth.createStore', () => {
  test('set/get возвращает записанный статус', () => {
    const s = MH.createStore({ storage: fakeStorage() });
    s.set('m1', MH.UNAVAILABLE, 'нет доступа (403 RBAC)', 'проба');
    const got = s.get('m1');
    assert.equal(got.state, MH.UNAVAILABLE);
    assert.equal(got.source, 'проба');
    assert.equal(got.stale, false);
  });

  test('неизвестная модель → unknown без причины', () => {
    const s = MH.createStore({ storage: fakeStorage() });
    assert.equal(s.get('нет-такой').state, MH.UNKNOWN);
  });

  test('статус старше TTL → unknown + stale, причина помнится', () => {
    let t = 1000;
    const s = MH.createStore({ storage: fakeStorage(), now: () => t, ttlMs: 60000 });
    s.set('m1', MH.UNAVAILABLE, 'нет доступа (403 RBAC)');
    t += 60001;
    const got = s.get('m1');
    assert.equal(got.state, MH.UNKNOWN);
    assert.equal(got.stale, true);
    assert.match(got.reason, /403/);
  });

  test('переживает пересоздание через storage', () => {
    const st = fakeStorage();
    MH.createStore({ storage: st }).set('m1', MH.OK, '');
    assert.equal(MH.createStore({ storage: st }).get('m1').state, MH.OK);
  });

  test('битый JSON в storage не роняет загрузку', () => {
    const st = fakeStorage();
    st.setItem(MH.STORAGE_KEY, '{битый');
    const s = MH.createStore({ storage: st });
    assert.equal(s.get('m1').state, MH.UNKNOWN);
  });

  test('работает без storage вообще', () => {
    const s = MH.createStore({});
    s.set('m1', MH.OK, '');
    assert.equal(s.get('m1').state, MH.OK);
  });

  test('noteError пишет только определённые статусы', () => {
    const s = MH.createStore({ storage: fakeStorage() });
    s.noteError('m1', httpErr(403));
    assert.equal(s.get('m1').state, MH.UNAVAILABLE);
    assert.equal(s.get('m1').source, 'наблюдение');

    s.noteError('m2', httpErr(429));
    assert.equal(s.get('m2').state, MH.UNKNOWN);
    assert.equal(s.get('m2').at, 0, '429 не должен записываться');
  });

  test('noteError не затирает ok ложным статусом при 401', () => {
    const s = MH.createStore({ storage: fakeStorage() });
    s.noteSuccess('m1');
    s.noteError('m1', httpErr(401));
    assert.equal(s.get('m1').state, MH.OK);
  });

  test('noteFallback: from → недоступна, to → доступна', () => {
    const s = MH.createStore({ storage: fakeStorage() });
    s.noteFallback({ from: 'a', to: 'b', reason: '403' });
    assert.equal(s.get('a').state, MH.UNAVAILABLE);
    assert.equal(s.get('b').state, MH.OK);
  });

  test('clear стирает всё', () => {
    const s = MH.createStore({ storage: fakeStorage() });
    s.set('m1', MH.OK, '');
    s.clear();
    assert.equal(s.get('m1').state, MH.UNKNOWN);
  });

  test('all отдаёт статусы с учётом TTL', () => {
    let t = 1000;
    const s = MH.createStore({ storage: fakeStorage(), now: () => t, ttlMs: 10 });
    s.set('m1', MH.OK, '');
    t += 100;
    s.set('m2', MH.UNAVAILABLE, 'x');
    const all = s.all();
    assert.equal(all.m1.state, MH.UNKNOWN);
    assert.equal(all.m2.state, MH.UNAVAILABLE);
  });
});

describe('ModelHealth.decorateLabel / statusTitle / marker', () => {
  test('маркеры по состояниям', () => {
    assert.equal(MH.marker(MH.OK), '✓');
    assert.equal(MH.marker(MH.UNAVAILABLE), '✗');
    assert.equal(MH.marker(MH.UNKNOWN), '·');
  });

  test('подпись опции содержит маркер и исходный текст', () => {
    assert.equal(MH.decorateLabel('GLM-5.1 · топ', { state: MH.OK }), '✓ GLM-5.1 · топ');
    assert.equal(MH.decorateLabel('GLM-5.1', null), '· GLM-5.1');
  });

  test('title объясняет причину недоступности и возраст', () => {
    const t = MH.statusTitle('m1', { state: MH.UNAVAILABLE, reason: 'нет доступа (403 RBAC)', at: 1000, source: 'проба' }, 1000 + 5 * 60000);
    assert.match(t, /недоступна: нет доступа \(403 RBAC\)/);
    assert.match(t, /проба, 5 мин назад/);
  });

  test('title для устаревшей проверки', () => {
    const t = MH.statusTitle('m1', { state: MH.UNKNOWN, stale: true, at: 0 }, 0);
    assert.match(t, /статус неизвестен \(проверка устарела\)/);
  });

  test('ageText: минуты и часы', () => {
    assert.equal(MH.ageText(10000), 'только что');
    assert.equal(MH.ageText(5 * 60000), '5 мин назад');
    assert.equal(MH.ageText(2 * 3600000), '2 ч назад');
  });
});

describe('ModelHealth.summarize', () => {
  test('считает доступные, недоступные и неясные', () => {
    assert.equal(
      MH.summarize([{ state: MH.OK }, { state: MH.OK }, { state: MH.UNAVAILABLE }, { state: MH.UNKNOWN }]),
      'доступно 2 · недоступно 1 · неясно 1'
    );
  });

  test('все доступны — без лишних хвостов', () => {
    assert.equal(MH.summarize([{ state: MH.OK }]), 'доступно 1');
  });

  test('пустой список', () => {
    assert.equal(MH.summarize([]), 'доступно 0');
  });
});
