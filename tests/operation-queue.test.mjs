import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadIife } from './helpers.mjs';

const OperationQueue = loadIife('client/shared/operation-queue.js', 'OperationQueue');

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
