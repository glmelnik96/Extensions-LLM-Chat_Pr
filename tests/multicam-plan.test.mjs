import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadMulticamPlan } from './load-multicam-plan.mjs';

const MP = loadMulticamPlan();

/* ──────────────────────────────────────────────────────────────
 * Helpers — генератор кадров для тестов.
 * ────────────────────────────────────────────────────────────── */

const FRAME_SEC = 0.05;

function makeFrames(specs) {
  /* specs: [{count, rms: [r0, r1, ...]}] — описание серий кадров */
  const frames = [];
  let t = 0;
  for (const s of specs) {
    for (let i = 0; i < s.count; i++) {
      frames.push({
        tStart: t,
        tEnd: t + FRAME_SEC,
        rmsByTrack: s.rms.slice()
      });
      t += FRAME_SEC;
    }
  }
  return frames;
}

const STD_MAPPING = {
  wideVideoTrack: 0,
  speakers: [
    { audioTrack: 0, videoTrack: 1, label: 'Гость 1' },
    { audioTrack: 1, videoTrack: 2, label: 'Гость 2' }
  ]
};

/* ──────────────────────────────────────────────────────────────
 * decideActiveMic
 * ────────────────────────────────────────────────────────────── */

describe('MulticamPlan._decideActiveMic', () => {
  test('никто не говорит → -1', () => {
    assert.equal(MP._decideActiveMic([-50, -55], -35, 6), -1);
  });

  test('один громкий → его индекс', () => {
    assert.equal(MP._decideActiveMic([-15, -50], -35, 6), 0);
    assert.equal(MP._decideActiveMic([-50, -10], -35, 6), 1);
  });

  test('оба громкие, лидер с margin ≥6 → лидер', () => {
    assert.equal(MP._decideActiveMic([-10, -20], -35, 6), 0);
  });

  test('оба громкие, разница < margin → -2 (overlap)', () => {
    assert.equal(MP._decideActiveMic([-10, -13], -35, 6), -2);
  });

  test('пустой / null → -1', () => {
    assert.equal(MP._decideActiveMic([], -35, 6), -1);
    assert.equal(MP._decideActiveMic(null, -35, 6), -1);
  });
});

/* ──────────────────────────────────────────────────────────────
 * micToVideoTrack
 * ────────────────────────────────────────────────────────────── */

describe('MulticamPlan._micToVideoTrack', () => {
  const params = { wideOnSilence: true, wideOnOverlap: true };

  test('silence → wide', () => {
    assert.equal(MP._micToVideoTrack(-1, STD_MAPPING, params), 0);
  });

  test('overlap → wide', () => {
    assert.equal(MP._micToVideoTrack(-2, STD_MAPPING, params), 0);
  });

  test('mic 0 → V2 (videoTrack=1)', () => {
    assert.equal(MP._micToVideoTrack(0, STD_MAPPING, params), 1);
  });

  test('mic 1 → V3 (videoTrack=2)', () => {
    assert.equal(MP._micToVideoTrack(1, STD_MAPPING, params), 2);
  });

  test('неизвестный mic → wide (fallback)', () => {
    assert.equal(MP._micToVideoTrack(99, STD_MAPPING, params), 0);
  });
});

/* ──────────────────────────────────────────────────────────────
 * smoothLabels
 * ────────────────────────────────────────────────────────────── */

describe('MulticamPlan._smoothLabels', () => {
  test('majority vote убирает single-frame flicker', () => {
    /* В основном 1, но один 2-кадр → должен сглаживаться к 1 */
    const out = MP._smoothLabels([1, 1, 1, 2, 1, 1, 1], 5);
    assert.deepEqual(out, [1, 1, 1, 1, 1, 1, 1]);
  });

  test('длинный участок сохраняется', () => {
    const out = MP._smoothLabels([1, 1, 1, 1, 2, 2, 2, 2, 2], 5);
    /* На границе сглаживание может затронуть 1-2 элемента, но 2-серия должна остаться */
    assert.equal(out[7], 2);
    assert.equal(out[8], 2);
    assert.equal(out[0], 1);
    assert.equal(out[1], 1);
  });

  test('пустой → пустой', () => {
    /* Не используем deepEqual([], []) — vm-prototype mismatch (см. memory: feedback_pure_logic_pattern). */
    assert.equal(MP._smoothLabels([], 5).length, 0);
  });

  test('один элемент → как есть', () => {
    assert.deepEqual(MP._smoothLabels([5], 5), [5]);
  });
});

/* ──────────────────────────────────────────────────────────────
 * labelsToSegments
 * ────────────────────────────────────────────────────────────── */

describe('MulticamPlan._labelsToSegments', () => {
  test('одна серия → один сегмент', () => {
    const segs = MP._labelsToSegments([1, 1, 1, 1], 0.05);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].activeVideoTrack, 1);
    assert.equal(segs[0].tStart, 0);
    assert.ok(Math.abs(segs[0].tEnd - 0.2) < 1e-9);
  });

  test('переключение → два сегмента', () => {
    const segs = MP._labelsToSegments([1, 1, 2, 2], 0.05);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].activeVideoTrack, 1);
    assert.equal(segs[1].activeVideoTrack, 2);
    assert.ok(Math.abs(segs[0].tEnd - 0.1) < 1e-9);
    assert.ok(Math.abs(segs[1].tStart - 0.1) < 1e-9);
  });

  test('пустой → пустой', () => {
    assert.equal(MP._labelsToSegments([], 0.05).length, 0);
  });
});

/* ──────────────────────────────────────────────────────────────
 * enforceMinHold
 * ────────────────────────────────────────────────────────────── */

describe('MulticamPlan._enforceMinHold', () => {
  test('короткий сегмент поглощается предыдущим', () => {
    /* [V1: 0-2с] [V2: 2-2.3с] [V1: 2.3-4с] → V2 короче 1.5с → поглотится */
    const segs = [
      { tStart: 0, tEnd: 2, activeVideoTrack: 1 },
      { tStart: 2, tEnd: 2.3, activeVideoTrack: 2 },
      { tStart: 2.3, tEnd: 4, activeVideoTrack: 1 }
    ];
    const out = MP._enforceMinHold(segs, 1.5);
    /* Ожидаем 2 сегмента (после mergeAdjacentSame в buildSwitchPlan их станет 1, но enforceMinHold сама не мерджит) */
    assert.ok(out.length <= 2);
    /* Длинных коротышей нет */
    for (const s of out) {
      assert.ok(s.tEnd - s.tStart >= 1.5 || out.length === 1);
    }
  });

  test('все сегменты длинные → не меняется', () => {
    const segs = [
      { tStart: 0, tEnd: 2, activeVideoTrack: 1 },
      { tStart: 2, tEnd: 4, activeVideoTrack: 2 }
    ];
    const out = MP._enforceMinHold(segs, 1.5);
    assert.equal(out.length, 2);
  });
});

/* ──────────────────────────────────────────────────────────────
 * snapToSilences
 * ────────────────────────────────────────────────────────────── */

describe('MulticamPlan._snapToSilences', () => {
  test('граница перетягивается к ближайшей silence в окне', () => {
    const segs = [
      { tStart: 0, tEnd: 2.0, activeVideoTrack: 1 },
      { tStart: 2.0, tEnd: 4.0, activeVideoTrack: 2 }
    ];
    /* silence-интервал 1.9-2.2 → середина 2.05, в окне 0.3 */
    const out = MP._snapToSilences(segs, [{ startSec: 1.9, endSec: 2.2 }], 0.3);
    assert.ok(Math.abs(out[0].tEnd - 2.05) < 1e-9);
    assert.ok(Math.abs(out[1].tStart - 2.05) < 1e-9);
  });

  test('нет silence в окне → граница не двигается', () => {
    const segs = [
      { tStart: 0, tEnd: 2.0, activeVideoTrack: 1 },
      { tStart: 2.0, tEnd: 4.0, activeVideoTrack: 2 }
    ];
    const out = MP._snapToSilences(segs, [{ startSec: 5.0, endSec: 5.5 }], 0.3);
    assert.equal(out[0].tEnd, 2.0);
    assert.equal(out[1].tStart, 2.0);
  });

  test('пустой silences → segments не меняются', () => {
    const segs = [
      { tStart: 0, tEnd: 2.0, activeVideoTrack: 1 },
      { tStart: 2.0, tEnd: 4.0, activeVideoTrack: 2 }
    ];
    const out = MP._snapToSilences(segs, [], 0.3);
    assert.deepEqual(out[0], segs[0]);
    assert.deepEqual(out[1], segs[1]);
  });
});

/* ──────────────────────────────────────────────────────────────
 * buildSwitchPlan — main
 * ────────────────────────────────────────────────────────────── */

describe('MulticamPlan.buildSwitchPlan', () => {
  test('Speaker 1 один говорит весь ролик → один сегмент V2', () => {
    const frames = makeFrames([{ count: 200, rms: [-15, -50] }]);
    const r = MP.buildSwitchPlan(frames, STD_MAPPING, {});
    assert.equal(r.segments.length, 1);
    assert.equal(r.segments[0].activeVideoTrack, 1);
    assert.equal(r.switchCount, 0);
  });

  test('Чередование двух спикеров с долгими репликами', () => {
    /* 3с speaker1, 3с speaker2, 3с speaker1 → 3 сегмента */
    const frames = makeFrames([
      { count: 60, rms: [-15, -50] },
      { count: 60, rms: [-50, -15] },
      { count: 60, rms: [-15, -50] }
    ]);
    const r = MP.buildSwitchPlan(frames, STD_MAPPING, {});
    assert.equal(r.segments.length, 3);
    assert.equal(r.segments[0].activeVideoTrack, 1);
    assert.equal(r.segments[1].activeVideoTrack, 2);
    assert.equal(r.segments[2].activeVideoTrack, 1);
    assert.equal(r.switchCount, 2);
  });

  test('Min-hold блокирует кратковременный peak', () => {
    /* speaker1 (3с) + краткий speaker2 (0.5с) + speaker1 (3с)
       Peak speaker2 короче 1.5с → должен быть поглощён */
    const frames = makeFrames([
      { count: 60, rms: [-15, -50] },
      { count: 10, rms: [-50, -15] },
      { count: 60, rms: [-15, -50] }
    ]);
    const r = MP.buildSwitchPlan(frames, STD_MAPPING, {});
    /* Ожидаем 1 сегмент V2 — короткий peak съеден */
    assert.equal(r.segments.length, 1);
    assert.equal(r.segments[0].activeVideoTrack, 1);
  });

  test('Overlap (оба громкие, маленький margin) → wide', () => {
    /* 3с overlap (rms close, разница < bleedMarginDb=6) → wide */
    const frames = makeFrames([{ count: 60, rms: [-15, -17] }]);
    const r = MP.buildSwitchPlan(frames, STD_MAPPING, {});
    assert.equal(r.segments.length, 1);
    assert.equal(r.segments[0].activeVideoTrack, 0);
  });

  test('Silence → wide', () => {
    const frames = makeFrames([{ count: 60, rms: [-50, -55] }]);
    const r = MP.buildSwitchPlan(frames, STD_MAPPING, {});
    assert.equal(r.segments.length, 1);
    assert.equal(r.segments[0].activeVideoTrack, 0);
  });

  test('Bleed-margin защита: speaker2 на 3dB громче → остаёмся на speaker1 (overlap=wide)', () => {
    /* spk1=-15, spk2=-12 → разница 3dB < margin 6dB → overlap → wide */
    const frames = makeFrames([{ count: 60, rms: [-15, -12] }]);
    const r = MP.buildSwitchPlan(frames, STD_MAPPING, {});
    assert.equal(r.segments[0].activeVideoTrack, 0);
  });

  test('Empty input → пустой результат, без ошибок', () => {
    const r = MP.buildSwitchPlan([], STD_MAPPING, {});
    /* Не deepEqual([], []) — vm-prototype mismatch */
    assert.equal(r.segments.length, 0);
    assert.equal(r.switchCount, 0);
    assert.equal(r.stats.framesAnalyzed, 0);
  });

  test('Нет mapping → throw', () => {
    assert.throws(
      () => MP.buildSwitchPlan([{ tStart: 0, tEnd: 0.05, rmsByTrack: [-15, -50] }], null, {}),
      /mapping/
    );
  });

  test('Stats: perTrackSeconds считается корректно', () => {
    const frames = makeFrames([
      { count: 60, rms: [-15, -50] },  /* 3с V2 */
      { count: 60, rms: [-50, -15] }   /* 3с V3 */
    ]);
    const r = MP.buildSwitchPlan(frames, STD_MAPPING, {});
    assert.equal(r.segments.length, 2);
    /* perTrackSeconds["1"] ≈ 3, perTrackSeconds["2"] ≈ 3 */
    assert.ok(Math.abs(r.stats.perTrackSeconds["1"] - 3) < 0.1);
    assert.ok(Math.abs(r.stats.perTrackSeconds["2"] - 3) < 0.1);
  });
});
