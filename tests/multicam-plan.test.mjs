import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadIife } from './helpers.mjs';

const MP = loadIife('client/shared/multicam-plan.js', 'MulticamPlan');

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

  /* Tier «оживления» тумблеров (11.07.2026): раньше fallthrough
     `if (activeMic < 0) return wide` перекрывал флаги — false ничего не менял.
     Теперь при false тишина/перебивка держат ПОСЛЕДНЕГО спикера (4-й арг). */
  test('wideOnSilence=false + есть последний спикер → держим его, не wide', () => {
    const f = { wideOnSilence: false, wideOnOverlap: true };
    assert.equal(MP._micToVideoTrack(-1, STD_MAPPING, f, 2), 2, 'тишина держит последнего спикера (track 2)');
  });

  test('wideOnOverlap=false + есть последний спикер → держим его, не wide', () => {
    const f = { wideOnSilence: true, wideOnOverlap: false };
    assert.equal(MP._micToVideoTrack(-2, STD_MAPPING, f, 1), 1, 'перебивка держит последнего спикера (track 1)');
  });

  test('wideOnSilence=false, но спикера ещё не было → wide (fallback)', () => {
    const f = { wideOnSilence: false, wideOnOverlap: true };
    assert.equal(MP._micToVideoTrack(-1, STD_MAPPING, f), 0, 'без 4-го арга падаем в wide');
  });

  test('wideOnSilence=true (дефолт) → wide, как раньше (регресс)', () => {
    const f = { wideOnSilence: true, wideOnOverlap: true };
    assert.equal(MP._micToVideoTrack(-1, STD_MAPPING, f, 2), 0, 'дефолт не меняется — тишина в wide');
  });
});

/* ──────────────────────────────────────────────────────────────
 * buildSwitchPlan — hold-last-speaker (интеграция)
 * ────────────────────────────────────────────────────────────── */

describe('MulticamPlan.buildSwitchPlan hold-last-speaker', () => {
  test('wideOnSilence=false: тишина после спикера держит его камеру, не уходит в wide', () => {
    /* Спикер 0 говорит 3с (track 1), затем 3с тишины. */
    const frames = makeFrames([
      { count: 60, rms: [-10, -50] }, // speaker 0 loud 3s
      { count: 60, rms: [-50, -50] }  // silence 3s
    ]);
    const on = MP.buildSwitchPlan(frames, STD_MAPPING, { minHoldSec: 1.0, wideOnSilence: true });
    const off = MP.buildSwitchPlan(frames, STD_MAPPING, { minHoldSec: 1.0, wideOnSilence: false });
    // с wideOnSilence=true — появляется wide-сегмент (track 0) на тишине
    assert.ok(on.segments.some(s => s.activeVideoTrack === 0), 'true → есть wide на тишине');
    // с wideOnSilence=false — весь ролик держит спикера 0 (track 1), wide нет
    assert.ok(!off.segments.some(s => s.activeVideoTrack === 0), 'false → wide на тишине нет');
    assert.ok(off.segments.every(s => s.activeVideoTrack === 1), 'false → всё на камере спикера 0');
  });
});

/* ──────────────────────────────────────────────────────────────
 * computeSnapSources — источники привязки (Tier 3, 11.07.2026)
 * ────────────────────────────────────────────────────────────── */

describe('MulticamPlan.computeSnapSources', () => {
  test('извлекает интервалы тишины и onset-ы речи из кадров', () => {
    /* Спикер0 2с → тишина 1с → спикер1 2с. */
    const frames = makeFrames([
      { count: 40, rms: [-10, -50] }, // speaker 0, onset at 0
      { count: 20, rms: [-50, -50] }, // silence [2,3]
      { count: 40, rms: [-50, -10] }  // speaker 1, onset at 3
    ]);
    const src = MP.computeSnapSources(frames, { silenceThresholdDb: -35, bleedMarginDb: 6 });
    // silences: один интервал [2,3]
    assert.equal(src.silences.length, 1);
    assert.ok(Math.abs(src.silences[0].startSec - 2.0) < 1e-6, 'silence start=2');
    assert.ok(Math.abs(src.silences[0].endSec - 3.0) < 1e-6, 'silence end=3');
    // onsets: начало речи спикера0 (0) и спикера1 (3)
    assert.equal(src.speechOnsets.length, 2);
    assert.ok(Math.abs(src.speechOnsets[0] - 0.0) < 1e-6, 'onset0=0');
    assert.ok(Math.abs(src.speechOnsets[1] - 3.0) < 1e-6, 'onset1=3');
  });

  test('нет тишины/речи → пустые массивы, не падает', () => {
    const src = MP.computeSnapSources([], { silenceThresholdDb: -35, bleedMarginDb: 6 });
    assert.equal(src.silences.length, 0);
    assert.equal(src.speechOnsets.length, 0);
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

  test('плотный вход (>1000 коротышей) — НИ ОДНОГО под-minHold сегмента на выходе', () => {
    /* Регрессия 11.07.2026: live-тест на 6_SYNCED (80 мин, тихая запись) дал
       3799 сегментов, 74% короче minHold. Причина — потолок safety<1000 в
       цикле: за проход поглощался ровно 1 коротыш, после 1000 удалений цикл
       молча обрывался, оставляя тысячи под-minHold склеек (покадровый пинг-понг). */
    const segs = [];
    for (let i = 0; i < 3000; i++) {
      segs.push({ tStart: i * 0.1, tEnd: (i + 1) * 0.1, activeVideoTrack: i % 2 });
    }
    const out = MP._enforceMinHold(segs, 1.5);
    for (const s of out) {
      const dur = s.tEnd - s.tStart;
      assert.ok(dur >= 1.5 - 1e-9 || out.length === 1,
        `сегмент ${dur.toFixed(3)}c < minHold 1.5c остался после enforceMinHold`);
    }
  });

  test('покрытие сохраняется — суммарная длительность и границы не рвутся', () => {
    const segs = [];
    for (let i = 0; i < 500; i++) {
      segs.push({ tStart: i * 0.2, tEnd: (i + 1) * 0.2, activeVideoTrack: i % 3 });
    }
    const totalIn = segs[segs.length - 1].tEnd - segs[0].tStart;
    const out = MP._enforceMinHold(segs, 1.5);
    /* Границы стыкуются без дыр/нахлёстов */
    for (let i = 1; i < out.length; i++) {
      assert.equal(out[i].tStart, out[i - 1].tEnd);
    }
    /* Полное покрытие исходного диапазона */
    assert.equal(out[0].tStart, segs[0].tStart);
    assert.equal(out[out.length - 1].tEnd, segs[segs.length - 1].tEnd);
    const totalOut = out[out.length - 1].tEnd - out[0].tStart;
    assert.ok(Math.abs(totalIn - totalOut) < 1e-9);
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

/* ═══ 09.2026: живой ритм вставок в монолог + спикер сегмента ═══ */
describe('MulticamPlan._enforceMaxHold — живой ритм (09.2026)', () => {
  const wide = 0;
  const mono = [{ tStart: 0, tEnd: 60, activeVideoTrack: 1 }];

  it('вставки НЕ одинаковой длины и НЕ через равные интервалы', () => {
    const out = MP._enforceMaxHold(mono, { maxHoldSec: 8, maxAllSpeakersSec: 3, variationsSeed: 3, bridgeStyle: 'wide' }, wide);
    const bridges = out.filter(s => s.activeVideoTrack === wide).map(s => +(s.tEnd - s.tStart).toFixed(3));
    const holds = out.filter(s => s.activeVideoTrack !== wide).map(s => +(s.tEnd - s.tStart).toFixed(3));
    assert.ok(bridges.length >= 4, 'мало вставок: ' + bridges.length);
    assert.ok(new Set(bridges).size > 1, 'все вставки одной длины: ' + bridges);
    assert.ok(new Set(holds.slice(0, -1)).size > 1, 'все интервалы одинаковые: ' + holds);
    bridges.forEach(b => assert.ok(b >= 0.5 && b <= 3 * 1.2 + 1e-9, 'длина вставки вне [0.5, 3.6]: ' + b));
    holds.forEach(h => assert.ok(h <= 8 + 1e-9, 'план длиннее maxHold: ' + h));
    const total = out.reduce((a, s) => a + (s.tEnd - s.tStart), 0);
    assert.ok(Math.abs(total - 60) < 1e-6);
    for (let i = 1; i < out.length; i++) assert.ok(Math.abs(out[i].tStart - out[i - 1].tEnd) < 1e-9);
  });

  it('детерминированно от seed; другой seed — другой рисунок', () => {
    const a = MP._enforceMaxHold(mono, { maxHoldSec: 8, maxAllSpeakersSec: 3, variationsSeed: 5 }, wide);
    const b = MP._enforceMaxHold(mono, { maxHoldSec: 8, maxAllSpeakersSec: 3, variationsSeed: 5 }, wide);
    const c = MP._enforceMaxHold(mono, { maxHoldSec: 8, maxAllSpeakersSec: 3, variationsSeed: 6 }, wide);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a.map(s => s.tEnd), c.map(s => s.tEnd));
  });

  it('граница вставки притягивается к кандидату реза (пауза) в окне', () => {
    const cands = [6.3, 9.1, 13.7, 17.2, 21.9, 26.4, 30.8, 35.1, 39.6, 44.0, 48.5, 52.9, 57.2];
    const out = MP._enforceMaxHold(mono, { maxHoldSec: 8, maxAllSpeakersSec: 3, variationsSeed: 2, bridgeStyle: 'wide' }, wide, { cutCandidates: cands });
    const starts = out.filter(s => s.activeVideoTrack === wide).map(s => s.tStart);
    assert.ok(starts.length >= 3);
    const onCand = starts.filter(t => cands.some(c => Math.abs(c - t) < 1e-9)).length;
    assert.ok(onCand >= Math.ceil(starts.length * 0.6), 'мало границ на паузах: ' + onCand + '/' + starts.length);
  });

  it('стиль reaction: вставка = камера собеседника (кто говорил ДО монолога)', () => {
    const segs = [
      { tStart: 0, tEnd: 4, activeVideoTrack: 2 },
      { tStart: 4, tEnd: 40, activeVideoTrack: 1 }
    ];
    const out = MP._enforceMaxHold(segs, { maxHoldSec: 8, maxAllSpeakersSec: 3, variationsSeed: 1, bridgeStyle: 'reaction' }, wide, { speakerTracks: [1, 2, 3] });
    const bridges = out.slice(1).filter(s => s.activeVideoTrack !== 1);
    assert.ok(bridges.length >= 2);
    bridges.forEach(b => assert.equal(b.activeVideoTrack, 2, 'ожидалась камера собеседника V2'));
  });

  it('стиль reaction без второго спикера → общий план', () => {
    const out = MP._enforceMaxHold(mono, { maxHoldSec: 8, maxAllSpeakersSec: 3, variationsSeed: 1, bridgeStyle: 'reaction' }, wide);
    out.filter(s => s.activeVideoTrack !== 1).forEach(b => assert.equal(b.activeVideoTrack, wide));
  });

  it('стиль mix: есть и общий план, и камера собеседника', () => {
    const segs = [{ tStart: 0, tEnd: 3, activeVideoTrack: 2 }, { tStart: 3, tEnd: 120, activeVideoTrack: 1 }];
    const out = MP._enforceMaxHold(segs, { maxHoldSec: 8, maxAllSpeakersSec: 3, variationsSeed: 4, bridgeStyle: 'mix' }, wide);
    const kinds = new Set(out.slice(1).filter(s => s.activeVideoTrack !== 1).map(s => s.activeVideoTrack));
    assert.ok(kinds.has(wide) && kinds.has(2), 'ожидались оба типа вставок: ' + [...kinds]);
  });

  it('короткие сегменты и wide не трогаются; хвост после вставки ≥ 1.5с', () => {
    const short = [{ tStart: 0, tEnd: 10, activeVideoTrack: 1 }];
    assert.deepEqual(MP._enforceMaxHold(short, { maxHoldSec: 8, maxAllSpeakersSec: 3 }, wide), short);
    const out = MP._enforceMaxHold(mono, { maxHoldSec: 8, maxAllSpeakersSec: 3, variationsSeed: 9 }, wide);
    const last = out[out.length - 1];
    assert.equal(last.activeVideoTrack, 1);
    assert.ok(last.tEnd - last.tStart >= 1.5 - 1e-9);
  });
});

describe('MulticamPlan._dominantMic + speaker в плане (09.2026)', () => {
  it('доминирующий микрофон сегмента; пауза/перебивка → -1', () => {
    const labels = [0, 0, 0, 1, 0, -1, -1, -1, -1, -2, -2, -2];
    assert.equal(MP._dominantMic(labels, 0, 0.25, 0.05), 0);       /* кадры 0..4 */
    assert.equal(MP._dominantMic(labels, 0.25, 0.45, 0.05), -1);   /* тишина */
    assert.equal(MP._dominantMic(labels, 0.45, 0.6, 0.05), -1);    /* перебивка */
    assert.equal(MP._dominantMic([], 0, 1, 0.05), -1);
  });

  it('buildSwitchPlan: у сегментов есть speaker; вставка в монолог наследует говорящего', () => {
    /* 60с монолога спикера 0 (mic0 громкий), затем 5с спикера 1 */
    const frames = [];
    for (let i = 0; i < 1300; i++) {
      const t = i * 0.05;
      frames.push({ tStart: t, tEnd: t + 0.05, rmsByTrack: t < 60 ? [-20, -60] : [-60, -20] });
    }
    const mapping = { wideVideoTrack: 0, speakers: [{ audioTrack: 0, videoTrack: 1 }, { audioTrack: 1, videoTrack: 2 }] };
    const res = MP.buildSwitchPlan(frames, mapping, { maxHoldSec: 8, maxAllSpeakersSec: 3, variationsSeed: 2, bridgeStyle: 'mix' });
    assert.ok(res.segments.length >= 4);
    res.segments.forEach(s => assert.equal(typeof s.speaker, 'number'));
    const bridges = res.segments.filter(s => s.tEnd <= 60 + 1e-6 && s.activeVideoTrack !== 1);
    assert.ok(bridges.length >= 2, 'нет вставок в монолог');
    bridges.forEach(b => assert.equal(b.speaker, 0, 'вставка должна наследовать спикера 0'));
    const tail = res.segments[res.segments.length - 1];
    assert.equal(tail.speaker, 1);
  });
});

describe('MulticamPlan.equalizeMicLevels (09.2026)', () => {
  /* 80% кадров — речь на level, 20% — тишина на −30 ниже: пики = level, шум (p10) = level−30 */
  const mk = (level, n = 200) => Array.from({ length: n }, (_, i) => ({ t: i * 0.05, rms: level + (i % 5 === 0 ? -30 : 0) }));
  it('тихий микрофон подтягивается к громкому по уровню речи (пики)', () => {
    const eq = MP.equalizeMicLevels([mk(-40), mk(-31)]);
    assert.deepEqual(eq.gainsDb, [9, 0]);
    assert.equal(eq.refDb, -31);
    const p90 = (tl) => tl.map(f => f.rms).sort((a, b) => a - b)[Math.floor(tl.length * 0.9)];
    assert.equal(p90(eq.timelines[0]), -31);
    assert.deepEqual(eq.skipped, []);
  });
  it('разница > 30 дБ не выравнивается и попадает в skipped', () => {
    const eq = MP.equalizeMicLevels([mk(-70), mk(-30)]);
    assert.deepEqual(eq.gainsDb, [0, 0]);
    assert.deepEqual(eq.skipped, [0]);
  });
  it('уровень речи по пикам: гость, говорящий 10% времени, выравнивается по СВОЕЙ речи, а не по пролезанию', () => {
    /* тихий микрофон: 10% кадров своя речь −45, 60% пролезание собеседника −60, 30% шум −75 */
    const quiet = Array.from({ length: 1000 }, (_, i) => ({ t: i * 0.05, rms: i % 10 === 0 ? -45 : (i % 10 < 7 ? -60 : -75) }));
    const loud = Array.from({ length: 1000 }, (_, i) => ({ t: i * 0.05, rms: i % 10 < 6 ? -25 : -65 }));
    const eq = MP.equalizeMicLevels([quiet, loud]);
    assert.equal(eq.refDb, -25);
    assert.equal(eq.gainsDb[0], 20, 'ожидался подъём на 20 дБ (−45 → −25), а не по p90');
  });
  it('шум после подъёма пересёк бы речь (SNR < 15 дБ) → skipped; плоский микрофон → skipped', () => {
    const noisy = Array.from({ length: 400 }, (_, i) => ({ t: i * 0.05, rms: i % 20 === 0 ? -45 : -52 })); /* речь −45, шум −52 */
    const loud = mk(-25);
    const eq = MP.equalizeMicLevels([noisy, loud]);
    assert.deepEqual(eq.skipped, [0]);
    assert.equal(eq.gainsDb[0], 0);
    const flat = Array.from({ length: 400 }, (_, i) => ({ t: i * 0.05, rms: -50 + (i % 3) }));
    assert.deepEqual(MP.equalizeMicLevels([flat, mk(-25)]).skipped, [0]);
  });
  it('после выравнивания тихий спикер побеждает на своих кадрах', () => {
    /* спикер 0 говорит на −40 (тихий микрофон), в мик 1 пролезает −52; при
       абсолютном пороге −35 он «молчал»; после +9 дБ — −31 против −43 → лидер */
    const eq = MP.equalizeMicLevels([mk(-40), mk(-31)]);
    const frames = MP.framesFromRmsTimelines([eq.timelines[0].map(f => ({ t: f.t, rms: f.rms })), mk(-31).map(f => ({ t: f.t, rms: -52 }))], 0.05);
    const lead = MP._decideActiveMic(frames[1].rmsByTrack, -35, 6);
    assert.equal(lead, 0);
  });
  it('пустой вход / мало сэмплов — без изменений', () => {
    assert.deepEqual(MP.equalizeMicLevels([]).timelines, []);
    const eq = MP.equalizeMicLevels([mk(-40, 5), mk(-31, 5)]);
    assert.deepEqual(eq.gainsDb, [0, 0]);
  });
});

describe('MulticamPlan._bridgeShortWideGaps (09.2026)', () => {
  const wide = 0;
  it('короткая пауза между двумя сегментами одного спикера → спикер, сегменты сливаются', () => {
    const out = MP._bridgeShortWideGaps([
      { tStart: 0, tEnd: 3, activeVideoTrack: 1 }, { tStart: 3, tEnd: 4.2, activeVideoTrack: wide },
      { tStart: 4.2, tEnd: 8, activeVideoTrack: 1 }, { tStart: 8, tEnd: 12, activeVideoTrack: wide }, { tStart: 12, tEnd: 15, activeVideoTrack: 2 }
    ], wide, 2.0);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), [
      { tStart: 0, tEnd: 8, activeVideoTrack: 1 }, { tStart: 8, tEnd: 12, activeVideoTrack: wide }, { tStart: 12, tEnd: 15, activeVideoTrack: 2 }
    ]);
  });
  it('пауза между РАЗНЫМИ спикерами и длинная пауза не трогаются; 0 = выкл', () => {
    const segs = [{ tStart: 0, tEnd: 3, activeVideoTrack: 1 }, { tStart: 3, tEnd: 4, activeVideoTrack: wide }, { tStart: 4, tEnd: 8, activeVideoTrack: 2 }];
    assert.deepEqual(JSON.parse(JSON.stringify(MP._bridgeShortWideGaps(segs, wide, 2.0))), segs);
    const long = [{ tStart: 0, tEnd: 3, activeVideoTrack: 1 }, { tStart: 3, tEnd: 6, activeVideoTrack: wide }, { tStart: 6, tEnd: 8, activeVideoTrack: 1 }];
    assert.deepEqual(JSON.parse(JSON.stringify(MP._bridgeShortWideGaps(long, wide, 2.0))), long);
    assert.deepEqual(MP._bridgeShortWideGaps(long, wide, 0), long);
  });
  it('buildSwitchPlan: дроблёная речь одного спикера с микропаузами не уходит в общий план', () => {
    /* тишина 0–2.5с (первый «длинный» сегмент — общий план, как в live), затем
       спикер 0 говорит до 40с всплесками 0.55с / паузы 0.55с; спикер 1 — 40–50 */
    const frames = [];
    for (let i = 0; i < 1000; i++) {
      const t = i * 0.05;
      const talking = t < 2.5 ? -1 : t < 40 ? (Math.floor(t / 0.55) % 2 === 0 ? 0 : -1) : 1;
      frames.push({ tStart: t, tEnd: t + 0.05, rmsByTrack: talking === 0 ? [-20, -60] : talking === 1 ? [-60, -20] : [-60, -60] });
    }
    const mapping = { wideVideoTrack: 0, speakers: [{ audioTrack: 0, videoTrack: 1 }, { audioTrack: 1, videoTrack: 2 }] };
    const res = MP.buildSwitchPlan(frames, mapping, { maxHoldSec: 0, smoothingWindow: 1, variationsJitterSec: 0 });
    const wideSec = (res.stats.perTrackSeconds['0'] || 0);
    assert.ok(wideSec < 4, 'общий план на дроблёной речи: ' + wideSec + 'с');
    const noHold = MP.buildSwitchPlan(frames, mapping, { maxHoldSec: 0, smoothingWindow: 1, variationsJitterSec: 0, silenceHoldSec: 0 });
    assert.ok((noHold.stats.perTrackSeconds['0'] || 0) > 20, 'без удержания min-hold клеит всплески в общий план: ' + noHold.stats.perTrackSeconds['0']);
  });
});
