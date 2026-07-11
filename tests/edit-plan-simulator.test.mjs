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

/* ─── buildTimelineDiff ──────────────────────────────────────────── */

describe('EditPlanSimulator.buildTimelineDiff', () => {
  const beforeSnap = {
    ok: true,
    clips: [
      { nodeId: 'a', startSec: 0, endSec: 30 },
      { nodeId: 'b', startSec: 30, endSec: 60 }
    ]
  };

  test('нормальный случай match=true', () => {
    const afterSnap = {
      ok: true,
      clips: [
        { nodeId: 'a', startSec: 0, endSec: 30 },
        { nodeId: 'b', startSec: 30, endSec: 50 }
      ]
    };
    const d = EP.buildTimelineDiff(beforeSnap, afterSnap, -10);
    assert.deepEqual(d.before, { durationSec: 60, clipCount: 2 });
    assert.deepEqual(d.after, { durationSec: 50, clipCount: 2 });
    assert.equal(d.deltaDurationSec, -10);
    assert.equal(d.expectedDeltaSec, -10);
    assert.equal(d.match, true);
    assert.equal(d.hint, null);
  });

  test('расхождение match=false + hint', () => {
    const afterSnap = {
      ok: true,
      clips: [
        { nodeId: 'a', startSec: 0, endSec: 30 },
        { nodeId: 'b', startSec: 30, endSec: 55 }
      ]
    };
    const d = EP.buildTimelineDiff(beforeSnap, afterSnap, -10);
    assert.equal(d.deltaDurationSec, -5);
    assert.equal(d.expectedDeltaSec, -10);
    assert.equal(d.match, false);
    assert.ok(d.hint.length > 0);
    assert.ok(d.hint.indexOf('-10') >= 0);
    assert.ok(d.hint.indexOf('-5') >= 0);
  });

  test('expected=null → match=null', () => {
    const afterSnap = {
      ok: true,
      clips: [{ nodeId: 'a', startSec: 0, endSec: 45 }]
    };
    const d = EP.buildTimelineDiff(beforeSnap, afterSnap, null);
    assert.equal(d.match, null);
    assert.equal(d.hint, null);
    assert.equal(d.expectedDeltaSec, null);
    assert.equal(d.deltaDurationSec, -15);
  });

  test('before=null → before null, match null', () => {
    const afterSnap = {
      ok: true,
      clips: [{ nodeId: 'x', startSec: 0, endSec: 20 }]
    };
    const d = EP.buildTimelineDiff(null, afterSnap, -5);
    assert.equal(d.before, null);
    assert.deepEqual(d.after, { durationSec: 20, clipCount: 1 });
    assert.equal(d.deltaDurationSec, null);
    assert.equal(d.match, null);
  });

  test('пустые clips → durationSec=0', () => {
    const emptyBefore = { ok: true, clips: [] };
    const emptyAfter = { ok: true, clips: [] };
    const d = EP.buildTimelineDiff(emptyBefore, emptyAfter, 0);
    assert.deepEqual(d.before, { durationSec: 0, clipCount: 0 });
    assert.deepEqual(d.after, { durationSec: 0, clipCount: 0 });
    assert.equal(d.deltaDurationSec, 0);
    assert.equal(d.match, true);
  });

  test('допуск 0.5с: |delta−expected|=0.5 → match=true', () => {
    const afterSnap = {
      ok: true,
      clips: [{ nodeId: 'a', startSec: 0, endSec: 50.5 }]
    };
    const d = EP.buildTimelineDiff(beforeSnap, afterSnap, -10);
    // delta = 50.5 - 60 = -9.5; |(-9.5) - (-10)| = 0.5 → ≤ 0.5 → true
    assert.equal(d.match, true);
  });

  test('after=null → after null, deltaDurationSec null, match null', () => {
    const d = EP.buildTimelineDiff(beforeSnap, null, -5);
    assert.deepEqual(d.before, { durationSec: 60, clipCount: 2 });
    assert.equal(d.after, null);
    assert.equal(d.deltaDurationSec, null);
    assert.equal(d.match, null);
  });
});

/* ─── compactSnapshotForLlm ──────────────────────────────────────── */

describe('EditPlanSimulator.compactSnapshotForLlm', () => {
  test('<80 клипов — без усечения', () => {
    const s = {
      ok: true,
      sequenceName: 'My Seq',
      clips: [
        { nodeId: 'n1', name: 'a.mp4', trackType: 'video', trackIndex: 1, startSec: 0, endSec: 10.567 },
        { nodeId: 'n2', name: 'b.wav', trackType: 'audio', trackIndex: 2, startSec: 10, endSec: 25.1 }
      ]
    };
    const c = EP.compactSnapshotForLlm(s);
    assert.equal(c.sequenceName, 'My Seq');
    assert.equal(c.clipCount, 2);
    assert.equal(c.truncated, false);
    assert.equal(c.note, null);
    assert.equal(c.clips[0], 'n1|a.mp4|video1|0.00-10.57');
    assert.equal(c.clips[1], 'n2|b.wav|audio2|10.00-25.10');
  });

  test('>maxClips — усечение + note', () => {
    const clips = [];
    for (let i = 0; i < 100; i++) {
      clips.push({ nodeId: 'c' + i, name: 'clip' + i, trackType: 'video', trackIndex: 1, startSec: i, endSec: i + 1 });
    }
    const s = { ok: true, sequenceName: 'Big', clips };
    const c = EP.compactSnapshotForLlm(s, 50);
    assert.equal(c.clipCount, 100);
    assert.equal(c.clips.length, 50);
    assert.equal(c.truncated, true);
    assert.ok(c.note.indexOf('50') >= 0);
    assert.ok(c.note.indexOf('100') >= 0);
  });

  test('snap null → null', () => {
    assert.equal(EP.compactSnapshotForLlm(null), null);
  });

  test('snap не ok → null', () => {
    assert.equal(EP.compactSnapshotForLlm({ ok: false, error: 'no seq' }), null);
  });

  test('snap без clips → null', () => {
    assert.equal(EP.compactSnapshotForLlm({ ok: true }), null);
  });
});

/* ─── calcExpectedDeltaSec ─────────────────────────────────────────── */

describe('EditPlanSimulator.calcExpectedDeltaSec', () => {
  test('чистый ripple-набор — сумма отрицательная', () => {
    const ops = [
      { action: 'ripple_delete_range', startSec: 0, endSec: 5 },
      { action: 'ripple_delete_range', startSec: 10, endSec: 13 }
    ];
    assert.equal(EP.calcExpectedDeltaSec(ops), -8);
  });

  test('shift_timeline_ripple — положительный deltaSec', () => {
    const ops = [
      { action: 'shift_timeline_ripple', fromSec: 0, deltaSec: 4.5 }
    ];
    assert.equal(EP.calcExpectedDeltaSec(ops), 4.5);
  });

  test('смесь с move_clip → null (непредсказуемая операция)', () => {
    const ops = [
      { action: 'ripple_delete_range', startSec: 0, endSec: 3 },
      { action: 'move_clip', nodeId: 'v1', newStartSec: 10 }
    ];
    assert.equal(EP.calcExpectedDeltaSec(ops), null);
  });

  test('смесь с trim → null', () => {
    const ops = [
      { kind: 'ripple_delete_interval', startSec: 1, endSec: 2 },
      { action: 'set_timeline_in', nodeId: 'v1', timeSec: 5 }
    ];
    assert.equal(EP.calcExpectedDeltaSec(ops), null);
  });

  test('смесь с remove_clip → null', () => {
    const ops = [
      { action: 'ripple_delete_range', startSec: 0, endSec: 2 },
      { action: 'remove_clip', nodeId: 'v1' }
    ];
    assert.equal(EP.calcExpectedDeltaSec(ops), null);
  });

  test('lift_delete / set_clip_enabled / mute_track / note — 0-вклад', () => {
    const ops = [
      { action: 'ripple_delete_range', startSec: 0, endSec: 5 },
      { action: 'lift_delete_range', startSec: 10, endSec: 20 },
      { action: 'set_clip_enabled', nodeId: 'v1', enabled: false },
      { action: 'mute_track', trackType: 'audio', trackIndex: 0, muted: true },
      { action: 'note', note: 'test' }
    ];
    // Только ripple -5, остальные 0-вклад
    assert.equal(EP.calcExpectedDeltaSec(ops), -5);
  });

  test('пустой массив → null', () => {
    assert.equal(EP.calcExpectedDeltaSec([]), null);
  });

  test('не массив → null', () => {
    assert.equal(EP.calcExpectedDeltaSec(null), null);
    assert.equal(EP.calcExpectedDeltaSec(undefined), null);
    assert.equal(EP.calcExpectedDeltaSec('ops'), null);
    assert.equal(EP.calcExpectedDeltaSec(42), null);
  });
});

describe('EditPlanSimulator.analyzeInputGeometry — гейт входа монтажа', () => {
  /* Сведённый nest: одна видео- + одна аудиоклипа [0..4007.42], как после Nest. */
  const nestSnap = {
    ok: true,
    sequenceName: '1_SYNCED [nest]',
    videoTrackCount: 3,
    audioTrackCount: 4,
    clips: [
      { nodeId: 'v', trackType: 'video', trackIndex: 0, startSec: 0, endSec: 4007.42 },
      { nodeId: 'a', trackType: 'audio', trackIndex: 0, startSec: 0, endSec: 4007.42 }
    ]
  };

  /* Несведённый мультикам: видеоклипы играют ОДНОВРЕМЕННО (пересекаются во времени). */
  const multicamSnap = {
    ok: true,
    sequenceName: '1_SYNCED',
    videoTrackCount: 3,
    audioTrackCount: 4,
    clips: [
      { nodeId: 'v1', trackType: 'video', trackIndex: 0, startSec: 0, endSec: 4007.42 },
      { nodeId: 'v3', trackType: 'video', trackIndex: 1, startSec: 6.17, endSec: 3876 },
      { nodeId: 'v2', trackType: 'video', trackIndex: 2, startSec: 21.27, endSec: 3610 },
      { nodeId: 'a1', trackType: 'audio', trackIndex: 0, startSec: 0, endSec: 4007.42 },
      { nodeId: 'a2', trackType: 'audio', trackIndex: 1, startSec: 0, endSec: 3876 }
    ]
  };

  test('сведённый nest → consolidated=true, без причин', () => {
    const r = EP.analyzeInputGeometry(nestSnap);
    assert.equal(r.consolidated, true);
    assert.deepEqual(r.reasons, []);
  });

  test('мультикам (пересечение во времени) → OVERLAP_VIDEO + OVERLAP_AUDIO', () => {
    const r = EP.analyzeInputGeometry(multicamSnap);
    assert.equal(r.consolidated, false);
    const codes = r.reasons.map((x) => x.code);
    assert.ok(codes.includes('OVERLAP_VIDEO'), 'ждём OVERLAP_VIDEO');
    assert.ok(codes.includes('OVERLAP_AUDIO'), 'ждём OVERLAP_AUDIO');
  });

  test('последовательные клипы на нескольких дорожках без пересечений → consolidated=true', () => {
    /* Клипы прыгают V1→V2→V1 и A1→A2→A1, но во времени НЕ пересекаются — это НЕ мультикам. */
    const r = EP.analyzeInputGeometry({
      ok: true,
      clips: [
        { nodeId: 'v1', trackType: 'video', trackIndex: 0, startSec: 0, endSec: 100 },
        { nodeId: 'v2', trackType: 'video', trackIndex: 1, startSec: 100, endSec: 250 },
        { nodeId: 'v3', trackType: 'video', trackIndex: 0, startSec: 250, endSec: 400 },
        { nodeId: 'a1', trackType: 'audio', trackIndex: 0, startSec: 0, endSec: 100 },
        { nodeId: 'a2', trackType: 'audio', trackIndex: 1, startSec: 100, endSec: 250 },
        { nodeId: 'a3', trackType: 'audio', trackIndex: 0, startSec: 250, endSec: 400 }
      ]
    });
    assert.equal(r.consolidated, true);
    assert.deepEqual(r.reasons, []);
  });

  test('стык клип-в-клип (end==next.start) не считается пересечением', () => {
    const r = EP.analyzeInputGeometry({
      ok: true,
      clips: [
        { nodeId: 'v1', trackType: 'video', trackIndex: 0, startSec: 0, endSec: 50.02 },
        { nodeId: 'v2', trackType: 'video', trackIndex: 1, startSec: 50, endSec: 120 }
      ]
    });
    assert.equal(r.consolidated, true);
  });

  test('одна V + одна A с ненулевым стартом → LEAD_GAP', () => {
    const r = EP.analyzeInputGeometry({
      ok: true,
      clips: [
        { nodeId: 'v', trackType: 'video', trackIndex: 0, startSec: 6.17, endSec: 100 },
        { nodeId: 'a', trackType: 'audio', trackIndex: 0, startSec: 6.17, endSec: 100 }
      ]
    });
    assert.equal(r.consolidated, false);
    assert.deepEqual(r.reasons.map((x) => x.code), ['LEAD_GAP']);
  });

  test('выключенный (disabled) перекрывающий клип игнорируется', () => {
    const r = EP.analyzeInputGeometry({
      ok: true,
      clips: [
        { nodeId: 'v1', trackType: 'video', trackIndex: 0, startSec: 0, endSec: 400 },
        { nodeId: 'v2', trackType: 'video', trackIndex: 1, startSec: 50, endSec: 120, disabled: true },
        { nodeId: 'a1', trackType: 'audio', trackIndex: 0, startSec: 0, endSec: 400 }
      ]
    });
    assert.equal(r.consolidated, true);
  });

  test('невалидный снимок → consolidated=null (не блокируем)', () => {
    assert.equal(EP.analyzeInputGeometry(null).consolidated, null);
    assert.equal(EP.analyzeInputGeometry({ ok: false }).consolidated, null);
    assert.equal(EP.analyzeInputGeometry({ ok: true, clips: [] }).consolidated, null);
  });
});

/* ══════════════════════════════════════════════════════════════
 * buildAutoSnapshotText (11.07.2026, live-находка на 6_SYNCED):
 * авто-снапшот в чате строил строку на КАЖДЫЙ видеоклип без капа —
 * плотный пост-мультикам таймлайн (11 429 видеоклипов) дал ~170K токенов,
 * Cloud.ru ответил 400 «maximum context length» и чат стал непригоден
 * на такой секвенции. Логика извлечена в чистую функцию с капом.
 * ══════════════════════════════════════════════════════════════ */
describe('EditPlanSimulator.buildAutoSnapshotText', () => {
  function mkSnap(nVideo, nAudioLinked) {
    const clips = [];
    for (let i = 0; i < nVideo; i++) {
      clips.push({ nodeId: 'v' + i, name: 'cam.mp4', trackType: 'video', trackIndex: i % 3, startSec: i, endSec: i + 1 });
      if (i < nAudioLinked) {
        clips.push({ nodeId: 'a' + i, name: 'cam.mp4', trackType: 'audio', trackIndex: 0, startSec: i, endSec: i + 1 });
      }
    }
    return { ok: true, sequenceName: 'Seq', sequenceEndSec: nVideo, fps: 25, clips };
  }

  test('невалидный снимок → null', () => {
    assert.equal(EP.buildAutoSnapshotText(null), null);
    assert.equal(EP.buildAutoSnapshotText({ ok: false }), null);
  });

  test('малый таймлайн: полный список, формат nodeId|name|vN|start-end', () => {
    const txt = EP.buildAutoSnapshotText(mkSnap(3, 0));
    assert.match(txt, /\[auto-snapshot\] seq=Seq dur=3\.0s fps=25/);
    assert.match(txt, /clips\(3\):/);
    assert.match(txt, /v0\|cam\.mp4\|v0\|0-1/);
  });

  test('линкованное аудио привязывается маркером a=<nodeId>@aN', () => {
    const txt = EP.buildAutoSnapshotText(mkSnap(2, 2));
    assert.match(txt, /v0\|cam\.mp4\|v0\|0-1\|a=a0@a0/);
  });

  test('несвязанное аудио — отдельной строкой', () => {
    const snap = mkSnap(1, 0);
    snap.clips.push({ nodeId: 'w1', name: 'zoom.wav', trackType: 'audio', trackIndex: 1, startSec: 0, endSec: 5 });
    const txt = EP.buildAutoSnapshotText(snap);
    assert.match(txt, /w1\|zoom\.wav\|a1\|0-5/);
  });

  test('disabled-клип помечен |off', () => {
    const snap = mkSnap(1, 0);
    snap.clips[0].disabled = true;
    assert.match(EP.buildAutoSnapshotText(snap), /v0\|cam\.mp4\|v0\|0-1\|off/);
  });

  test('плотный таймлайн (> maxClips): список опущен, есть сводка по дорожкам и подсказка', () => {
    const txt = EP.buildAutoSnapshotText(mkSnap(1000, 0), { maxClips: 250 });
    assert.ok(txt.length < 2000, 'сводка компактная, а не 1000 строк: ' + txt.length);
    assert.match(txt, /1000 клип/);
    assert.match(txt, /v0: \d+/, 'пер-дорожечные счётчики');
    assert.match(txt, /get_transcript_structure|propose_montage_plan/, 'подсказка про инструменты');
    assert.ok(!/v500\|/.test(txt), 'список клипов не включён');
  });

  test('дефолтный кап 250 — 240 клипов проходят полностью', () => {
    const txt = EP.buildAutoSnapshotText(mkSnap(240, 0));
    assert.match(txt, /clips\(240\):/);
    assert.match(txt, /v239\|/);
  });

  test('sequenceEndSec=0 → длительность из максимального endSec клипов', () => {
    const snap = mkSnap(3, 0);
    snap.sequenceEndSec = 0;
    assert.match(EP.buildAutoSnapshotText(snap), /dur=3\.0s/);
  });
});
