import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOperationQueue } from './load-operation-queue.mjs';

const OperationQueue = loadOperationQueue();

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('OperationQueue.tryBegin / end (mutex против гонок)', () => {
  test('свежая очередь — свободна', () => {
    const q = OperationQueue.create();
    assert.equal(q.isBusy(), false);
    assert.equal(q.label(), null);
  });

  test('tryBegin захватывает; повторный tryBegin занят → false', () => {
    const q = OperationQueue.create();
    assert.equal(q.tryBegin('send'), true);
    assert.equal(q.isBusy(), true);
    assert.equal(q.label(), 'send');
    /* вторая операция отвергается, пока первая не завершена */
    assert.equal(q.tryBegin('transcribe'), false);
    assert.equal(q.label(), 'send'); /* метка не перетёрта */
  });

  test('end освобождает мьютекс для следующего tryBegin', () => {
    const q = OperationQueue.create();
    q.tryBegin('a');
    q.end();
    assert.equal(q.isBusy(), false);
    assert.equal(q.tryBegin('b'), true);
    assert.equal(q.label(), 'b');
  });
});

describe('OperationQueue.enqueue (FIFO-сериализация)', () => {
  test('задачи выполняются строго по очереди, без перекрытия', async () => {
    const q = OperationQueue.create();
    const order = [];
    let activeCount = 0;
    let maxActive = 0;

    function task(name) {
      return async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        order.push('start:' + name);
        await tick();
        await tick();
        order.push('end:' + name);
        activeCount--;
        return name;
      };
    }

    const p1 = q.enqueue(task('A'), 'A');
    const p2 = q.enqueue(task('B'), 'B');
    const p3 = q.enqueue(task('C'), 'C');

    const results = await Promise.all([p1, p2, p3]);
    assert.deepEqual(results, ['A', 'B', 'C']);
    /* ни одна задача не выполнялась параллельно */
    assert.equal(maxActive, 1);
    /* строгий порядок start/end без чередования */
    assert.deepEqual(order, [
      'start:A', 'end:A',
      'start:B', 'end:B',
      'start:C', 'end:C'
    ]);
    assert.equal(q.isBusy(), false);
    assert.equal(q.pendingCount(), 0);
  });

  test('ошибка в задаче не ломает очередь — следующая выполняется', async () => {
    const q = OperationQueue.create();
    const ran = [];

    const p1 = q.enqueue(async () => { ran.push('A'); throw new Error('boom'); }, 'A');
    const p2 = q.enqueue(async () => { ran.push('B'); return 'ok'; }, 'B');

    await assert.rejects(p1, /boom/);
    assert.equal(await p2, 'ok');
    assert.deepEqual(ran, ['A', 'B']);
    assert.equal(q.isBusy(), false);
  });

  test('pendingCount отражает число ожидающих в очереди', async () => {
    const q = OperationQueue.create();
    let release;
    const gate = new Promise((r) => { release = r; });

    const p1 = q.enqueue(() => gate, 'A'); /* держим первую открытой */
    q.enqueue(async () => {}, 'B');
    q.enqueue(async () => {}, 'C');

    await tick();
    assert.equal(q.isBusy(), true);
    assert.equal(q.label(), 'A');
    assert.equal(q.pendingCount(), 2); /* B и C ждут */

    release();
    await p1;
    await tick();
    await tick();
    assert.equal(q.isBusy(), false);
    assert.equal(q.pendingCount(), 0);
  });

  test('tryBegin отвергается, пока enqueue-задача в работе', async () => {
    const q = OperationQueue.create();
    let release;
    const gate = new Promise((r) => { release = r; });
    const p = q.enqueue(() => gate, 'long');
    await tick();
    assert.equal(q.tryBegin('intruder'), false);
    release();
    await p;
    assert.equal(q.tryBegin('after'), true);
  });
});
