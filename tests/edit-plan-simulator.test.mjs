import { test, describe } from 'node:test';
import assert from 'node:assert';
import { loadEditPlanSimulator } from './load-edit-plan-simulator.mjs';

const EP = loadEditPlanSimulator();

const snap = {
  ok: true,
  sequenceName: 'Seq',
  sequenceEndSec: 60,
  clips: [
    { nodeId: 'v1', name: 'intro.mp4', trackType: 'video', startSec: 0, endSec: 10, durationSec: 10 },
    { nodeId: 'v2', name: 'main.mp4', trackType: 'video', startSec: 10, endSec: 40, durationSec: 30 },
    { nodeId: 'v3', name: 'outro.mp4', trackType: 'video', startSec: 40, endSec: 60, durationSec: 20 }
  ]
};

describe('EditPlanSimulator.simulate — legacy form', () => {
  test('ripple_delete_range смыкает дыру', () => {
    const r = EP.simulate(snap, {
      operations: [{ action: 'ripple_delete_range', startSec: 5, endSec: 15 }]
    });
    assert.equal(r.ok, true);
    assert.equal(r.summary.clipsAfter, 3);
    assert.equal(r.summary.durationAfterSec, 50);
    assert.equal(r.summary.deltaSec, -10);
  });

  test('remove_clip убирает один клип', () => {
    const r = EP.simulate(snap, {
      operations: [{ action: 'remove_clip', nodeId: 'v1' }]
    });
    assert.equal(r.summary.removedCount, 1);
    assert.equal(r.summary.clipsAfter, 2);
  });

  test('move_clip помечает клип moved', () => {
    const r = EP.simulate(snap, {
      operations: [{ action: 'move_clip', nodeId: 'v1', newStartSec: 100 }]
    });
    assert.ok(r.moved.includes('v1'));
  });
});

describe('EditPlanSimulator.simulateUnified — новый контракт', () => {
  test('ripple_delete_interval эквивалентно legacy ripple_delete_range', () => {
    const legacy = EP.simulate(snap, {
      operations: [{ action: 'ripple_delete_range', startSec: 5, endSec: 15 }]
    });
    const unified = EP.simulateUnified(snap, {
      ops: [{ kind: 'ripple_delete_interval', startSec: 5, endSec: 15, reason: 'повтор' }]
    });
    assert.deepEqual(unified.summary, legacy.summary);
    assert.deepEqual(unified.rejectedOpIdxs, []);
  });

  test('смешанные ops: ripple + remove_clip + trim_in', () => {
    const r = EP.simulateUnified(snap, {
      ops: [
        { kind: 'ripple_delete_interval', startSec: 2, endSec: 4 },
        { kind: 'remove_clip', nodeId: 'v3' },
        { kind: 'trim_in', nodeId: 'v1', timeSec: 1 }
      ]
    });
    assert.equal(r.ok, true);
    assert.equal(r.summary.removedCount, 1); // v3 removed
    assert.ok(r.trimmed.includes('v1'));
    assert.equal(r.rejectedOpIdxs.length, 0);
  });

  test('неизвестный kind попадает в rejected', () => {
    const r = EP.simulateUnified(snap, {
      ops: [
        { kind: 'ripple_delete_interval', startSec: 1, endSec: 3 },
        { kind: 'hocus_pocus', foo: 42 }
      ]
    });
    assert.deepEqual(r.rejectedOpIdxs, [1]);
    assert.equal(r.normalizedOperations.length, 1);
  });

  test('nodeId нормализуется в строку', () => {
    const r = EP.simulateUnified(snap, {
      ops: [{ kind: 'remove_clip', nodeId: 123 }]
    });
    // Не найдено — клипов с nodeId='123' нет, rejected нет (синтаксически валиден)
    assert.equal(r.normalizedOperations[0].nodeId, '123');
  });
});

describe('EditPlanSimulator.simulate — kind/type alias for action', () => {
  test('kind вместо action работает', () => {
    const r = EP.simulate(snap, {
      operations: [{ kind: 'ripple_delete_range', startSec: 5, endSec: 15 }]
    });
    assert.equal(r.ok, true);
    assert.equal(r.summary.deltaSec, -10);
  });

  test('type вместо action работает', () => {
    const r = EP.simulate(snap, {
      operations: [{ type: 'remove_clip', nodeId: 'v1' }]
    });
    assert.equal(r.summary.removedCount, 1);
  });
});

describe('EditPlanSimulator.extractRippleIntervals', () => {
  test('извлекает только ripple-интервалы', () => {
    const { operations } = EP.normalizeUnifiedPlan({
      ops: [
        { kind: 'ripple_delete_interval', startSec: 1, endSec: 2 },
        { kind: 'remove_clip', nodeId: 'v1' },
        { kind: 'ripple_delete_interval', startSec: 5, endSec: 7 }
      ]
    });
    const ivs = EP.extractRippleIntervals(operations);
    assert.equal(ivs.length, 2);
    assert.deepEqual(ivs[0], { startSec: 1, endSec: 2 });
    assert.deepEqual(ivs[1], { startSec: 5, endSec: 7 });
  });
});
