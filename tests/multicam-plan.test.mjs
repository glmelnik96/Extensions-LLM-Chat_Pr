import { test, describe, it } from 'node:test';
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

describe('MulticamPlan.framesFromRmsTimelines', () => {
  it('aligns two equal-length timelines onto a 0.05s grid', () => {
    const timelines = [
      [{ t: 0.05, rms: -10 }, { t: 0.10, rms: -11 }, { t: 0.15, rms: -12 }],
      [{ t: 0.05, rms: -40 }, { t: 0.10, rms: -41 }, { t: 0.15, rms: -42 }]
    ];
    const frames = MP.framesFromRmsTimelines(timelines, 0.05);
    assert.equal(frames.length, 3);
    assert.deepEqual([...frames[0].rmsByTrack], [-10, -40]);
    assert.deepEqual([...frames[1].rmsByTrack], [-11, -41]);
    assert.deepEqual([...frames[2].rmsByTrack], [-12, -42]);
    assert.ok(Math.abs(frames[0].tStart - 0) < 1e-9);
    assert.ok(Math.abs(frames[0].tEnd - 0.05) < 1e-9);
  });

  it('holds the last known value when a track has fewer samples', () => {
    const timelines = [
      [{ t: 0.05, rms: -10 }, { t: 0.10, rms: -10 }, { t: 0.15, rms: -10 }],
      [{ t: 0.05, rms: -40 }] // shorter — should hold -40
    ];
    const frames = MP.framesFromRmsTimelines(timelines, 0.05);
    assert.equal(frames.length, 3);
    assert.deepEqual([...frames[2].rmsByTrack], [-10, -40]);
  });

  it('uses the quiet floor for a fully empty track timeline', () => {
    const timelines = [
      [{ t: 0.05, rms: -10 }],
      [] // no data → floor -120
    ];
    const frames = MP.framesFromRmsTimelines(timelines, 0.05);
    assert.equal(frames.length, 1);
    assert.deepEqual([...frames[0].rmsByTrack], [-10, -120]);
  });

  it('returns empty array for empty input', () => {
    assert.equal(MP.framesFromRmsTimelines([], 0.05).length, 0);
    assert.equal(MP.framesFromRmsTimelines(null, 0.05).length, 0);
  });
});

describe('MulticamPlan._enforceMaxHold', () => {
  const wide = 0;
  it('splits a 20s mono segment into chunks ≤ maxHoldSec with wide bridges', () => {
    const segs = [{ tStart: 0, tEnd: 20, activeVideoTrack: 1 }];
    const out = MP._enforceMaxHold(segs, { maxHoldSec: 8, maxAllSpeakersSec: 4 }, wide);
    // Должно быть как минимум 1 wide-инжект.
    assert.ok(out.some(s => s.activeVideoTrack === wide));
    // Все не-wide сегменты ≤ maxHoldSec.
    out.filter(s => s.activeVideoTrack !== wide).forEach(s => {
      assert.ok((s.tEnd - s.tStart) <= 8 + 1e-9, 'chunk too long: ' + (s.tEnd - s.tStart));
    });
    // Не-wide track тот же (1).
    out.filter(s => s.activeVideoTrack !== wide).forEach(s => {
      assert.equal(s.activeVideoTrack, 1);
    });
    // Покрытие времени: суммарная длительность == 20с (с точностью до eps).
    const total = out.reduce((acc, s) => acc + (s.tEnd - s.tStart), 0);
    assert.ok(Math.abs(total - 20) < 1e-6, 'total duration drifted: ' + total);
    // Границы строго возрастают.
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i].tStart >= out[i - 1].tEnd - 1e-9);
    }
  });

  it('does not touch short segments', () => {
    const segs = [
      { tStart: 0, tEnd: 3, activeVideoTrack: 1 },
      { tStart: 3, tEnd: 7, activeVideoTrack: 2 },
      { tStart: 7, tEnd: 10, activeVideoTrack: 1 }
    ];
    const out = MP._enforceMaxHold(segs, { maxHoldSec: 8, maxAllSpeakersSec: 4 }, wide);
    assert.deepEqual(out, segs);
  });

  it('is no-op when maxHoldSec is 0 or absent', () => {
    const segs = [{ tStart: 0, tEnd: 20, activeVideoTrack: 1 }];
    assert.deepEqual(MP._enforceMaxHold(segs, { maxHoldSec: 0 }, wide), segs);
    assert.deepEqual(MP._enforceMaxHold(segs, {}, wide), segs);
  });

  it('does not split wide segments themselves', () => {
    const segs = [{ tStart: 0, tEnd: 20, activeVideoTrack: wide }];
    const out = MP._enforceMaxHold(segs, { maxHoldSec: 8, maxAllSpeakersSec: 4 }, wide);
    // wide остаётся одним куском
    assert.equal(out.length, 1);
    assert.equal(out[0].activeVideoTrack, wide);
  });
});

describe('MulticamPlan._applyVariations', () => {
  function mkSegs() {
    return [
      { tStart: 0, tEnd: 5, activeVideoTrack: 1 },
      { tStart: 5, tEnd: 10, activeVideoTrack: 2 },
      { tStart: 10, tEnd: 15, activeVideoTrack: 1 }
    ];
  }

  it('is no-op when jitterSec is 0', () => {
    const segs = mkSegs();
    const out = MP._applyVariations(segs, 0, 42);
    assert.deepEqual(out, segs);
  });

  it('produces deterministic results for the same seed', () => {
    const a = MP._applyVariations(mkSegs(), 0.5, 42);
    const b = MP._applyVariations(mkSegs(), 0.5, 42);
    assert.deepEqual(a, b);
  });

  it('produces different boundaries for different seeds', () => {
    const a = MP._applyVariations(mkSegs(), 0.5, 1);
    const b = MP._applyVariations(mkSegs(), 0.5, 999);
    // Хотя бы одна граница должна отличаться.
    const aBoundaries = a.slice(0, -1).map(s => s.tEnd);
    const bBoundaries = b.slice(0, -1).map(s => s.tEnd);
    assert.notDeepEqual(aBoundaries, bBoundaries);
  });

  it('keeps boundaries within ±jitterSec of original', () => {
    const segs = mkSegs();
    const out = MP._applyVariations(segs, 0.5, 7);
    for (let i = 0; i < segs.length - 1; i++) {
      const drift = Math.abs(out[i].tEnd - segs[i].tEnd);
      assert.ok(drift <= 0.5 + 1e-9, 'drift exceeded jitter: ' + drift);
    }
  });

  it('does not collapse a segment past the midpoint of its neighbor', () => {
    const segs = mkSegs();
    const out = MP._applyVariations(segs, 100, 5); // абсурдно большой jitter
    // Все сегменты остаются положительной длины.
    out.forEach(s => assert.ok(s.tEnd > s.tStart, 'collapsed: ' + JSON.stringify(s)));
  });
});

describe('MulticamPlan._snapToSpeechOnset', () => {
  function mkSegs() {
    return [
      { tStart: 0, tEnd: 5, activeVideoTrack: 1 },
      { tStart: 5, tEnd: 10, activeVideoTrack: 2 }
    ];
  }

  it('snaps boundary to the nearest onset within window', () => {
    const out = MP._snapToSpeechOnset(mkSegs(), [4.8, 7.0], 0.5, 0);
    assert.ok(Math.abs(out[0].tEnd - 4.8) < 1e-9, 'got tEnd=' + out[0].tEnd);
    assert.equal(out[0].tEnd, out[1].tStart);
  });

  it('applies frame offset to the snap point', () => {
    const out = MP._snapToSpeechOnset(mkSegs(), [4.8], 0.5, -0.1);
    assert.ok(Math.abs(out[0].tEnd - (4.8 - 0.1)) < 1e-9);
  });

  it('leaves boundary unchanged when no onset in window', () => {
    const out = MP._snapToSpeechOnset(mkSegs(), [2.0, 8.0], 0.5, 0);
    assert.equal(out[0].tEnd, 5);
  });

  it('is no-op for empty/null onsets or zero window', () => {
    const segs = mkSegs();
    assert.deepEqual(MP._snapToSpeechOnset(segs, [], 0.5, 0), segs);
    assert.deepEqual(MP._snapToSpeechOnset(segs, null, 0.5, 0), segs);
    assert.deepEqual(MP._snapToSpeechOnset(segs, [4.8], 0, 0), segs);
  });
});

describe('MulticamPlan._resolveShortOverlaps (B2-10: политика кросс-токов)', () => {
  it('replaces a short overlap run with the previous speaker', () => {
    // 5 кадров спикер 0, 3 кадра перебивка (-2), 5 кадров спикер 1
    const labels = [0, 0, 0, 0, 0, -2, -2, -2, 1, 1, 1, 1, 1];
    const out = MP._resolveShortOverlaps(labels, 5);
    assert.deepEqual(out.slice(5, 8), [0, 0, 0], 'короткий кросс-ток держит предыдущего спикера');
  });

  it('keeps a long overlap run (>= minFrames) untouched', () => {
    const labels = [0, 0, -2, -2, -2, -2, -2, 1, 1];
    const out = MP._resolveShortOverlaps(labels, 5);
    assert.deepEqual(out.slice(2, 7), [-2, -2, -2, -2, -2], 'долгая перебивка остаётся overlap → wide');
  });

  it('fills forward from the next speaker when run starts the timeline', () => {
    const labels = [-2, -2, 1, 1, 1];
    const out = MP._resolveShortOverlaps(labels, 5);
    assert.deepEqual(out.slice(0, 2), [1, 1], 'нет предыдущего — берём следующего спикера');
  });

  it('skips backward over silence (-1) to find previous speaker', () => {
    const labels = [0, 0, -1, -2, -2, 1, 1];
    const out = MP._resolveShortOverlaps(labels, 5);
    assert.deepEqual(out.slice(3, 5), [0, 0], 'тишина не прерывает поиск спикера назад');
  });

  it('is a no-op copy when minFrames <= 1', () => {
    const labels = [0, -2, 1];
    const out = MP._resolveShortOverlaps(labels, 1);
    assert.deepEqual(out, labels);
    assert.notEqual(out, labels, 'возвращает копию, не исходный массив');
  });

  it('handles empty input', () => {
    assert.deepEqual(MP._resolveShortOverlaps([], 5), []);
  });

  it('buildSwitchPlan respects overlapWideMinSec=0 (политика выключена)', () => {
    // Просто smoke: параметр прокидывается без падения
    const frames = [];
    let t = 0;
    for (let i = 0; i < 100; i++) {
      frames.push({ tStart: t, tEnd: t + FRAME_SEC, rmsByTrack: [-12, -50] });
      t += FRAME_SEC;
    }
    const mapping = { wideVideoTrack: 1, speakers: [
      { audioTrack: 1, videoTrack: 2, label: 'A' },
      { audioTrack: 2, videoTrack: 3, label: 'B' }
    ] };
    const plan = MP.buildSwitchPlan(frames, mapping, { overlapWideMinSec: 0, frameSec: FRAME_SEC });
    assert.ok(plan.segments.length >= 1);
  });
});

/* ──────────────────────────────────────────────────────────────
 * splitPlanIntoBatches — батчевое применение длинных планов
 * (2026-07-10: 1.2ч подкаст → сотни сегментов → один evalScript
 * упирался в 120с watchdog; план бьётся на пачки, host зовётся
 * несколько раз, стык между батчами рэйзорит предыдущий батч
 * через razorTrailingEdge).
 * ────────────────────────────────────────────────────────────── */

describe('splitPlanIntoBatches', () => {
  function mkPlan(nSegments, extra) {
    const segments = [];
    let t = 0;
    for (let i = 0; i < nSegments; i++) {
      segments.push({ tStart: t, tEnd: t + 2, activeVideoTrack: i % 3 });
      t += 2;
    }
    return Object.assign({
      version: 1,
      rangeSec: [0, t],
      mapping: STD_MAPPING,
      params: { mode: 'disable' },
      segments
    }, extra || {});
  }

  it('бьёт 100 сегментов на батчи по 40: [40, 40, 20]', () => {
    const batches = MP.splitPlanIntoBatches(mkPlan(100), { batchSegments: 40 });
    assert.equal(batches.length, 3);
    /* спред → native-массив (vm-prototype mismatch, см. выше) */
    assert.deepEqual([...batches].map((b) => b.segments.length), [40, 40, 20]);
  });

  it('razorTrailingEdge: true у всех, кроме последнего батча', () => {
    const batches = MP.splitPlanIntoBatches(mkPlan(100), { batchSegments: 40 });
    assert.deepEqual([...batches].map((b) => b.razorTrailingEdge === true), [true, true, false]);
  });

  it('план, влезающий в один батч → 1 батч без razorTrailingEdge', () => {
    const batches = MP.splitPlanIntoBatches(mkPlan(15), { batchSegments: 40 });
    assert.equal(batches.length, 1);
    assert.equal(batches[0].razorTrailingEdge, false);
    assert.equal(batches[0].segments.length, 15);
  });

  it('конкатенация сегментов батчей === исходные сегменты (порядок цел)', () => {
    const plan = mkPlan(97);
    const batches = MP.splitPlanIntoBatches(plan, { batchSegments: 40 });
    const glued = [].concat(...batches.map((b) => b.segments));
    assert.deepEqual(glued, plan.segments);
  });

  it('mapping/params/version копируются в каждый батч', () => {
    const batches = MP.splitPlanIntoBatches(mkPlan(50), { batchSegments: 40 });
    for (const b of batches) {
      assert.deepEqual(b.mapping, STD_MAPPING);
      assert.deepEqual(b.params, { mode: 'disable' });
      assert.equal(b.version, 1);
    }
  });

  it('expectedSequenceName прокидывается в каждый батч', () => {
    const batches = MP.splitPlanIntoBatches(
      mkPlan(50, { expectedSequenceName: 'Podcast 16' }),
      { batchSegments: 40 }
    );
    for (const b of batches) assert.equal(b.expectedSequenceName, 'Podcast 16');
  });

  it('дефолтный batchSegments = 40 (без opts)', () => {
    const batches = MP.splitPlanIntoBatches(mkPlan(81));
    assert.deepEqual([...batches].map((b) => b.segments.length), [40, 40, 1]);
  });

  it('пустой/битый план → []', () => {
    /* Не deepEqual([], []) — vm-prototype mismatch */
    assert.equal(MP.splitPlanIntoBatches(null).length, 0);
    assert.equal(MP.splitPlanIntoBatches({}).length, 0);
    assert.equal(MP.splitPlanIntoBatches({ segments: [] }).length, 0);
  });

  it('batchSegments < 1 клампится к 1 (защита от мусора)', () => {
    const batches = MP.splitPlanIntoBatches(mkPlan(3), { batchSegments: 0 });
    assert.equal(batches.length, 3);
    assert.deepEqual([...batches].map((b) => b.segments.length), [1, 1, 1]);
  });
});
