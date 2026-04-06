import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadToolValidators } from './load-tool-validators.mjs';

const TV = loadToolValidators();

const snapOk = {
  ok: true,
  sequenceName: 'TestSeq',
  clips: [
    { nodeId: 'clip-a', startSec: 0, endSec: 10, name: 'Interview' },
    { nodeId: 'clip-b', startSec: 10, endSec: 25, name: 'B-Roll' }
  ]
};

describe('validateTimecodePlan', () => {
  test('отклоняет план без operations', () => {
    const err = TV.validateTimecodePlan(snapOk, {});
    assert.match(err, /operations/);
  });

  test('требует актуальный снимок', () => {
    const err = TV.validateTimecodePlan({ ok: false }, { operations: [] });
    assert.match(err, /get_timeline_snapshot/);
  });

  test('ripple_delete_range: нужны числа', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [{ action: 'ripple_delete_range', startSec: 1 }]
    });
    assert.match(err, /startSec|endSec|числа/);
  });

  test('ripple_delete_range: endSec <= startSec', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [{ action: 'ripple_delete_range', startSec: 5, endSec: 3 }]
    });
    assert.ok(err);
  });

  test('ripple_delete_range валиден', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'ripple_delete_range', startSec: 1, endSec: 4 }]
      }),
      null
    );
  });

  test('lift_delete_range валиден', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'lift_delete_range', startSec: 2, endSec: 5 }]
      }),
      null
    );
  });

  test('set_clips_enabled_by_name без clipName — ошибка', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [{ action: 'set_clips_enabled_by_name', enabled: false }]
    });
    assert.match(err, /clipName/);
  });

  test('set_clips_enabled_by_name валиден', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'set_clips_enabled_by_name', clipName: 'Interview.braw', enabled: false }]
      }),
      null
    );
  });

  test('remove_clip: неизвестный nodeId', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [{ action: 'remove_clip', nodeId: 'ghost' }]
    });
    assert.match(err, /nodeId/);
  });

  test('set_timeline_in: timeSec на границе клипа — ошибка', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [{ action: 'set_timeline_in', nodeId: 'clip-a', timeSec: 0.01 }]
    });
    assert.ok(err);
  });

  test('set_timeline_in: timeSec внутри клипа — ок', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'set_timeline_in', nodeId: 'clip-a', timeSec: 5 }]
      }),
      null
    );
  });

  test('set_timeline_bounds: выход за клип', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [
        { action: 'set_timeline_bounds', nodeId: 'clip-a', startSec: 0, endSec: 11 }
      ]
    });
    assert.ok(err);
  });

  test('move_clip: отрицательный newStartSec', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [{ action: 'move_clip', nodeId: 'clip-a', newStartSec: -1 }]
    });
    assert.ok(err);
  });

  test('move_clip: валидный', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'move_clip', nodeId: 'clip-a', newStartSec: 5 }]
      }),
      null
    );
  });

  test('move_clip: shiftBlockingClips / makeRoom не ломают валидацию', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [
          { action: 'move_clip', nodeId: 'clip-b', newStartSec: 0, shiftBlockingClips: true }
        ]
      }),
      null
    );
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'move_clip', nodeId: 'clip-a', newStartSec: 2, makeRoom: true }]
      }),
      null
    );
  });

  test('lift_delete_range_all_tracks валиден', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'lift_delete_range_all_tracks', startSec: 1, endSec: 3 }]
      }),
      null
    );
  });

  test('shift_timeline_ripple валиден', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'shift_timeline_ripple', fromSec: 0, deltaSec: 2 }]
      }),
      null
    );
  });

  test('shift_timeline_ripple: deltaSec <= 0', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [{ action: 'shift_timeline_ripple', fromSec: 0, deltaSec: 0 }]
    });
    assert.ok(err);
  });

  test('set_clip_speed: speed <= 0', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [{ action: 'set_clip_speed', nodeId: 'clip-a', speed: 0 }]
    });
    assert.ok(err);
  });

  test('set_clip_speed: валидный', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'set_clip_speed', nodeId: 'clip-a', speed: 2 }]
      }),
      null
    );
  });

  test('set_playhead: отрицательный', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [{ action: 'set_playhead', timeSec: -5 }]
    });
    assert.ok(err);
  });

  test('set_playhead: валидный', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'set_playhead', timeSec: 3 }]
      }),
      null
    );
  });

  test('mute_track: trackType невалидный', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [{ action: 'mute_track', trackType: 'midi', trackIndex: 0 }]
    });
    assert.ok(err);
  });

  test('mute_track: валидный', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'mute_track', trackType: 'audio', trackIndex: 0, muted: true }]
      }),
      null
    );
  });

  test('set_clip_enabled: неизвестный nodeId', () => {
    const err = TV.validateTimecodePlan(snapOk, {
      operations: [{ action: 'set_clip_enabled', nodeId: 'ghost', enabled: false }]
    });
    assert.match(err, /nodeId/);
  });

  test('set_clip_enabled: валидный', () => {
    assert.equal(
      TV.validateTimecodePlan(snapOk, {
        operations: [{ action: 'set_clip_enabled', nodeId: 'clip-a', enabled: false }]
      }),
      null
    );
  });
});

describe('validateTranscriptCuts', () => {
  test('нужен removeIntervals', () => {
    const r = TV.validateTranscriptCuts(snapOk, {});
    assert.ok(r.error);
  });

  test('интервал: end <= start', () => {
    const r = TV.validateTranscriptCuts(snapOk, {
      removeIntervals: [{ startSec: 5, endSec: 3 }]
    });
    assert.ok(r.error);
  });

  test('успех без предупреждения', () => {
    const r = TV.validateTranscriptCuts(snapOk, {
      removeIntervals: [{ startSec: 1, endSec: 2, reason: 'test' }]
    });
    assert.equal(r.error, null);
    assert.equal(r.warn, null);
  });

  test('предупреждение если интервал далеко за конец таймлайна', () => {
    const r = TV.validateTranscriptCuts(snapOk, {
      removeIntervals: [{ startSec: 0, endSec: 500 }]
    });
    assert.equal(r.error, null);
    assert.ok(r.warn);
  });
});

describe('validateMarkersList', () => {
  test('пустой массив', () => {
    const err = TV.validateMarkersList(snapOk, []);
    assert.ok(err);
  });

  test('timeSec не число', () => {
    const err = TV.validateMarkersList(snapOk, [{ timeSec: 'x', name: 'm' }]);
    assert.ok(err);
  });

  test('timeSec сильно за пределы снимка', () => {
    const err = TV.validateMarkersList(snapOk, [{ timeSec: 500, name: 'far' }]);
    assert.ok(err);
  });

  test('валидные маркеры', () => {
    assert.equal(
      TV.validateMarkersList(snapOk, [
        { timeSec: 0, name: 'Intro' },
        { timeSec: 12, name: 'Mid', comment: 'ok' }
      ]),
      null
    );
  });
});
