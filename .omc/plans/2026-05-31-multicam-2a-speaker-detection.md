# MultiCam Phase 2A — Real Speaker Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the naive "alternate cameras by paragraph index" multicam with real audio-driven active-speaker switching by wiring the existing (but unused) `MulticamPlan.buildSwitchPlan` to real per-track RMS.

**Architecture:** Add one pure function (`framesFromRmsTimelines`) that aligns per-mic ffmpeg `astats` RMS timelines onto a common frame grid, producing the exact `audioFrames` shape `buildSwitchPlan` already consumes. Add a new pipeline `multicamFromAudio(ctx, params)` that orchestrates extraction → frames → plan, with the RMS extraction **injectable** (`ctx.rmsExtractor`) so the orchestration is unit-testable without ffmpeg/Premiere. Finally, wire the Tools dispatch to the new pipeline and provide the real default extractor (validated manually in Premiere). The apply side (`host/premiere.jsx applyMulticamCuts`) is already done and its plan contract is unchanged.

**Tech Stack:** ES5 IIFE modules (no bundler), Node `node --test` via vm-loader pattern, ffmpeg `astats` (existing `audio-preprocess.computeRmsTimeline`), Premiere CEP bridge.

---

## Background (read before starting)

- `client/shared/multicam-plan.js` — `MulticamPlan.buildSwitchPlan(audioFrames, mapping, params, silences)` already exists, is unit-tested, and is the correct "brain". `audioFrames` shape: `[{tStart, tEnd, rmsByTrack:[r0_dB, r1_dB, ...]}]`. **It is currently NOT called by any shipped path.**
- `client/shared/deterministic-pipelines.js:931` — `multicamFromTranscript(ctx, params)` is the shipped path; it only alternates `V2/V3` by paragraph index. We add `multicamFromAudio` next to it (keep the old one as fallback).
- `client/shared/audio-preprocess.js:187` — `computeRmsTimeline(inputPath, {windowSec})` returns `[{t, rms}]` (RMS in dB at each reset window). This is our per-track RMS source.
- `client/unified/panel.js:4615` — Tools dispatch maps `case 'multicam'` to a pipeline fn; `ctx` is built at :4637 with `{settings, snapshot, transcriptEntry, onStatus, abortCheck}`.
- `host/premiere.jsx:2241` — `applyMulticamCuts(jsonPlan)` consumes `{segments, mapping, params}`. **Do not change this contract.**
- Test pattern: `tests/load-multicam-plan.mjs` returns `ctx.MulticamPlan`; `tests/multicam-plan.test.mjs` uses `node:test` (`describe`/`it`) + `node:assert/strict`.

---

## File Structure

- **Modify** `client/shared/multicam-plan.js` — add pure `framesFromRmsTimelines`, export it on the `api` object and on `_internals`-style direct exports (alongside `_decideActiveMic` etc.).
- **Modify** `tests/multicam-plan.test.mjs` — add a `describe('MulticamPlan.framesFromRmsTimelines')` block.
- **Modify** `client/shared/deterministic-pipelines.js` — add `multicamFromAudio(ctx, params)`; export it in the `global.DeterministicPipelines` object (after `multicamFromTranscript`).
- **Create** `tests/load-deterministic-pipelines.mjs` only if it does not already exist (it does — reuse it).
- **Modify** `tests/deterministic-pipelines.test.mjs` — add a `describe('DeterministicPipelines.multicamFromAudio')` block using a fake `ctx.rmsExtractor`.
- **Modify** `client/unified/panel.js:4615` — point `case 'multicam'` at `multicamFromAudio`; add the default real RMS extractor onto `ctx`.

---

## Task 1: Pure frame aligner `framesFromRmsTimelines`

Aligns N per-track RMS timelines (`[{t, rms}]`, sorted ascending) onto a common frame grid of width `frameSec`. Each frame's per-track value is the **last RMS sample with `t <= frameEnd`** (step-hold), or a quiet floor (`-120` dB) before the first sample. Frame count derives from the longest timeline.

**Files:**
- Modify: `client/shared/multicam-plan.js` (add function inside the IIFE, before `var api = {`; add to `api`)
- Test: `tests/multicam-plan.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add this block to `tests/multicam-plan.test.mjs` (after the existing `describe` blocks, before any trailing code):

```js
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
    assert.deepEqual(MP.framesFromRmsTimelines([], 0.05), []);
    assert.deepEqual(MP.framesFromRmsTimelines(null, 0.05), []);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/multicam-plan.test.mjs`
Expected: FAIL — `MP.framesFromRmsTimelines is not a function`.

- [ ] **Step 3: Implement `framesFromRmsTimelines`**

In `client/shared/multicam-plan.js`, add this function immediately before `var api = {` (around line 297):

```js
  /**
   * Выровнять N per-track RMS-таймлайнов ([{t, rms}], отсортированы по t)
   * на общую сетку кадров шириной frameSec.
   * Значение трека в кадре = последний sample с t <= tEnd кадра (step-hold);
   * до первого sample — floorDb (тихо). Кол-во кадров — по самому длинному треку.
   *
   * Возвращает audioFrames в формате buildSwitchPlan:
   *   [{tStart, tEnd, rmsByTrack:[r0_dB, r1_dB, ...]}]
   */
  function framesFromRmsTimelines(timelines, frameSec, opts) {
    if (!timelines || !timelines.length) return [];
    opts = opts || {};
    var floorDb = typeof opts.floorDb === 'number' ? opts.floorDb : -120;
    var fs = frameSec > 0 ? frameSec : 0.05;
    var eps = 1e-6;

    var maxT = 0;
    for (var ti = 0; ti < timelines.length; ti++) {
      var tl = timelines[ti];
      if (tl && tl.length) {
        var lastT = tl[tl.length - 1].t;
        if (typeof lastT === 'number' && lastT > maxT) maxT = lastT;
      }
    }
    var frameCount = Math.max(1, Math.round(maxT / fs));

    var ptr = [];
    var lastVal = [];
    for (var p = 0; p < timelines.length; p++) { ptr[p] = 0; lastVal[p] = floorDb; }

    var frames = [];
    for (var fi = 0; fi < frameCount; fi++) {
      var tStart = fi * fs;
      var tEnd = tStart + fs;
      var rmsByTrack = [];
      for (var k = 0; k < timelines.length; k++) {
        var tlk = timelines[k] || [];
        while (ptr[k] < tlk.length && tlk[ptr[k]].t <= tEnd + eps) {
          var v = tlk[ptr[k]].rms;
          if (typeof v === 'number' && !isNaN(v)) lastVal[k] = v;
          ptr[k]++;
        }
        rmsByTrack.push(lastVal[k]);
      }
      frames.push({ tStart: tStart, tEnd: tEnd, rmsByTrack: rmsByTrack });
    }
    return frames;
  }
```

Then add `framesFromRmsTimelines: framesFromRmsTimelines,` to the `api` object (right after `buildSwitchPlan: buildSwitchPlan,` near line 299).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/multicam-plan.test.mjs`
Expected: PASS — all 4 new tests green, no regressions in the file.

- [ ] **Step 5: Syntax-check the module**

Run: `node --check client/shared/multicam-plan.js`
Expected: no output (exit 0).

- [ ] **Step 6: Commit** (await explicit user go-ahead before committing — see durable rules)

```bash
git add client/shared/multicam-plan.js tests/multicam-plan.test.mjs
git commit -m "feat(multicam): add framesFromRmsTimelines RMS-grid aligner"
```

---

## Task 2: Orchestrator `multicamFromAudio` (injectable extractor)

New pipeline that builds the plan from real audio. RMS extraction is injected via `ctx.rmsExtractor` so the orchestration is unit-testable; the real extractor is supplied by panel.js in Task 3.

**Extractor interface (contract):**
`ctx.rmsExtractor(ctx, mapping, params)` returns a Promise resolving to
`{ timelines: [ [{t,rms}], ... ] }` — one `[{t,rms}]` array **per speaker mic track**, in the same order as `mapping.speakers`.

**Files:**
- Modify: `client/shared/deterministic-pipelines.js` (add function before `global.DeterministicPipelines = {`; export it)
- Test: `tests/deterministic-pipelines.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `tests/deterministic-pipelines.test.mjs` (the file already imports its loader as `DP` — match the existing variable name used in that file; if the loaded module is bound to a different name, use that):

```js
describe('DeterministicPipelines.multicamFromAudio', () => {
  function snap3v2a() {
    return {
      ok: true,
      sequenceName: 'seq',
      tracks: [
        { type: 'video', index: 0 }, { type: 'video', index: 1 }, { type: 'video', index: 2 },
        { type: 'audio', index: 0 }, { type: 'audio', index: 1 }
      ]
    };
  }

  it('switches to the louder mic per frame', async () => {
    // Track A (speaker 0) loud for first 2s, Track B (speaker 1) loud for next 2s.
    const fs = 0.05;
    const loud = -10, quiet = -50;
    const tlA = [], tlB = [];
    for (let i = 1; i <= 80; i++) {
      const t = +(i * fs).toFixed(3);
      tlA.push({ t, rms: i <= 40 ? loud : quiet });
      tlB.push({ t, rms: i <= 40 ? quiet : loud });
    }
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.resolve({ timelines: [tlA, tlB] })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.equal(res.proposal.kind, 'multicam_cuts');
    const segs = res.proposal.plan.segments;
    // First segment should be speaker-0 video (track 1), a later one speaker-1 video (track 2).
    assert.equal(segs[0].activeVideoTrack, 1);
    assert.ok(segs.some(s => s.activeVideoTrack === 2));
    // Plan contract intact for the host:
    assert.equal(res.proposal.plan.mapping.wideVideoTrack, 0);
    assert.equal(res.proposal.plan.params.mode, 'disable');
  });

  it('errors when fewer than 3 video tracks', async () => {
    const ctx = {
      snapshot: { ok: true, tracks: [{ type: 'video', index: 0 }, { type: 'audio', index: 0 }] },
      rmsExtractor: () => Promise.resolve({ timelines: [[]] })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, false);
    assert.match(res.error, /3 видеодорожк/);
  });

  it('errors when extractor yields no timelines', async () => {
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.resolve({ timelines: [] })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, false);
    assert.match(res.error, /аудио/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/deterministic-pipelines.test.mjs`
Expected: FAIL — `DP.multicamFromAudio is not a function`.

- [ ] **Step 3: Implement `multicamFromAudio`**

In `client/shared/deterministic-pipelines.js`, add this function immediately before `global.DeterministicPipelines = {` (around line 1059). It reuses the hardcoded mapping from `multicamFromTranscript` (V1=wide, A1↔V2, A2↔V3) and delegates to `MulticamPlan`:

```js
  /**
   * MultiCam Phase 2A: реальный детект говорящего через per-track RMS.
   * ctx.rmsExtractor(ctx, mapping, params) → Promise<{timelines:[[{t,rms}],...]}>
   *   по одному [{t,rms}] на mic-дорожку спикера, в порядке mapping.speakers.
   * Чистый план строит MulticamPlan.buildSwitchPlan (тот же контракт, что и Phase 1).
   */
  async function multicamFromAudio(ctx, params) {
    params = params || {};
    var snap = ctx && ctx.snapshot;
    if (!snap || !snap.ok) {
      return { ok: false, error: 'Нет снимка таймлайна.' };
    }
    var vTracks = (snap.tracks || []).filter(function (t) { return t.type === 'video'; });
    var aTracks = (snap.tracks || []).filter(function (t) { return t.type === 'audio'; });
    if (vTracks.length < 3) {
      return { ok: false, error: 'Нужно ≥3 видеодорожки (V1=wide, V2/V3=гости). Найдено ' + vTracks.length + '.' };
    }
    if (aTracks.length < 2) {
      return { ok: false, error: 'Нужно ≥2 аудиодорожки. Найдено ' + aTracks.length + '.' };
    }
    if (typeof ctx.rmsExtractor !== 'function') {
      return { ok: false, error: 'Нет источника аудио (rmsExtractor). Установите ffmpeg.' };
    }

    var mapping = {
      wideVideoTrack: 0,
      speakers: [
        { audioTrack: 0, videoTrack: 1, label: 'Гость 1' },
        { audioTrack: 1, videoTrack: 2, label: 'Гость 2' }
      ]
    };

    var extracted;
    try {
      extracted = await ctx.rmsExtractor(ctx, mapping, params);
    } catch (e) {
      return { ok: false, error: 'Ошибка анализа аудио: ' + String(e && e.message || e) };
    }
    var timelines = extracted && extracted.timelines;
    if (!timelines || !timelines.length) {
      return { ok: false, error: 'Не удалось извлечь аудио-RMS дорожек.' };
    }

    var frameSec = typeof params.frameSec === 'number' ? params.frameSec : 0.05;
    var frames = MulticamPlan.framesFromRmsTimelines(timelines, frameSec);
    if (!frames.length) {
      return { ok: false, error: 'Пустой аудио-анализ.' };
    }

    var planParams = {
      frameSec: frameSec,
      minHoldSec: typeof params.minHoldSec === 'number' ? params.minHoldSec : 1.5,
      bleedMarginDb: typeof params.bleedMarginDb === 'number' ? params.bleedMarginDb : 6,
      silenceThresholdDb: typeof params.silenceThresholdDb === 'number' ? params.silenceThresholdDb : -35
    };
    var built = MulticamPlan.buildSwitchPlan(frames, mapping, planParams, params.silences || null);
    if (!built.segments || !built.segments.length) {
      return { ok: false, error: 'Не удалось построить план переключений.' };
    }

    var perTrack = built.stats && built.stats.perTrackSeconds || {};
    var plan = {
      version: 1,
      rangeSec: [built.segments[0].tStart, built.segments[built.segments.length - 1].tEnd],
      mapping: mapping,
      params: { mode: (params.mode === 'delete' ? 'delete' : 'disable') },
      segments: built.segments
    };

    return {
      ok: true,
      proposal: {
        kind: 'multicam_cuts',
        plan: plan,
        summary: 'Авто-MultiCam (по голосу): ' + built.segments.length + ' сегментов, ' +
          built.switchCount + ' переключений. V1: ' + ((perTrack['0'] || 0).toFixed(1)) +
          'с, V2: ' + ((perTrack['1'] || 0).toFixed(1)) + 'с, V3: ' + ((perTrack['2'] || 0).toFixed(1)) + 'с.',
        stats: { perTrackSeconds: perTrack, switchCount: built.switchCount }
      }
    };
  }
```

Then add `multicamFromAudio: multicamFromAudio,` to the `global.DeterministicPipelines = {` object, right after the `multicamFromTranscript: multicamFromTranscript,` line.

**Note on `MulticamPlan` availability:** `deterministic-pipelines.js` runs in the panel with `MulticamPlan` already on `window` (loaded earlier in `index2.html`). For the Node test, verify the loader for deterministic-pipelines exposes `MulticamPlan` in its vm context — see Step 3a.

- [ ] **Step 3a: Ensure the test loader provides `MulticamPlan`**

Open `tests/load-deterministic-pipelines.mjs`. If its vm context does not already define `MulticamPlan`, load `multicam-plan.js` into the same context before evaluating `deterministic-pipelines.js`. Add (adapting to the file's existing variable names):

```js
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
// inside the loader, before running deterministic-pipelines.js source:
const mcSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../client/shared/multicam-plan.js'), 'utf8');
vm.runInContext(mcSrc, ctx); // ctx is the existing vm context; this sets ctx.MulticamPlan
```

If the loader already exposes `MulticamPlan`, skip this step.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/deterministic-pipelines.test.mjs`
Expected: PASS — 3 new `multicamFromAudio` tests green, existing tests unaffected.

- [ ] **Step 5: Syntax-check**

Run: `node --check client/shared/deterministic-pipelines.js`
Expected: exit 0.

- [ ] **Step 6: Full regression**

Run: `npm test`
Expected: all tests green (304 prior + new tests), no regressions.

- [ ] **Step 7: Commit** (await explicit user go-ahead)

```bash
git add client/shared/deterministic-pipelines.js tests/deterministic-pipelines.test.mjs tests/load-deterministic-pipelines.mjs
git commit -m "feat(multicam): add audio-driven multicamFromAudio pipeline"
```

---

## Task 3: Wire Tools dispatch + real RMS extractor

Point the `multicam` tool at `multicamFromAudio` and supply the real `rmsExtractor` that derives per-mic source media paths from the snapshot and runs `AudioPreprocess.computeRmsTimeline` on each. This task is **glue that touches Premiere/ffmpeg**, so it is validated manually (no unit test); keep it thin.

**Files:**
- Modify: `client/unified/panel.js:4615` (dispatch) and `:4637` (ctx construction)

- [ ] **Step 1: Switch the dispatch target**

In `client/unified/panel.js`, change the `case 'multicam'` block (currently at :4615):

```js
        case 'multicam':
          pipelineFn = DeterministicPipelines.multicamFromAudio;
          proposalId = 'proposal-multicam';
          break;
```

- [ ] **Step 2: Add the real extractor to `ctx`**

In the `ctx` object built around :4637, add an `rmsExtractor`. It maps each speaker mic track to the media file path of its (single, synced) audio clip from the snapshot, then computes a per-track RMS timeline. Add this property to the `ctx` literal:

```js
          rmsExtractor: async function (innerCtx, mapping, p) {
            var aTracks = (snap.tracks || []).filter(function (t) { return t.type === 'audio'; });
            var fs = typeof p.frameSec === 'number' ? p.frameSec : 0.05;
            var timelines = [];
            for (var si = 0; si < mapping.speakers.length; si++) {
              var aIdx = mapping.speakers[si].audioTrack;
              var trk = aTracks[aIdx];
              var clip = trk && trk.clips && trk.clips.length ? trk.clips[0] : null;
              var mediaPath = clip && (clip.mediaPath || clip.filePath || clip.path);
              if (!mediaPath) {
                throw new Error('Аудиодорожка ' + (aIdx + 1) + ': нет файла на диске (нужен один синхронизированный клип на дорожку).');
              }
              var tl = await AudioPreprocess.computeRmsTimeline(mediaPath, { windowSec: fs });
              timelines.push(tl);
            }
            return { timelines: timelines };
          },
```

**Verify before writing:** confirm the snapshot clip objects expose a media path field and its exact name by inspecting `getTimelineSnapshot` output in `host/premiere.jsx` (search for where audio-track clips are serialized). Use the actual field name(s); the `clip.mediaPath || clip.filePath || clip.path` fallback above must include the real one. If the snapshot does not carry media paths for audio clips, fetch them via `PremiereBridge.getClipMediaPath(nodeId, cb)` (already exists at `bridge-premiere.js:214`) wrapped in a Promise.

- [ ] **Step 3: Syntax-check**

Run: `node --check client/unified/panel.js`
Expected: exit 0.

- [ ] **Step 4: Full regression**

Run: `npm test`
Expected: all green (panel.js is not unit-tested but must not break the syntax/loaders).

- [ ] **Step 5: Manual validation in Premiere** (record result in `docs/MANUAL_TESTS.md`)

1. Open a 3V+2A synced podcast (V1 wide, V2/V3 guests; A1/A2 = the two mics), 2–5 min.
2. Tools → «Авто-MultiCam» → Run.
3. Confirm the proposal summary shows a realistic per-track split (not a mechanical 50/50 paragraph alternation).
4. Apply → verify the active camera follows whoever is actually speaking; audio untouched; Cmd/Ctrl+Z reverts cleanly; no track desync.
5. If `getClipMediaPath` fallback was needed, confirm it resolves all mic paths.

- [ ] **Step 6: Commit** (await explicit user go-ahead)

```bash
git add client/unified/panel.js docs/MANUAL_TESTS.md
git commit -m "feat(multicam): wire Tools dispatch to audio-driven speaker detection"
```

---

## Done criteria (Phase 2A)

- `framesFromRmsTimelines` and `multicamFromAudio` are unit-tested and green.
- Tools «Авто-MultiCam» produces a plan that follows the real speaker, verified manually in Premiere.
- `npm test` green; `node --check` clean on all three modified JS files.
- The `applyMulticamCuts` host contract is unchanged.

Phase 2B (max-hold/wide-injection, variations, frame-offset) and Phase 2C (mapping UI + sliders) follow in separate plans — see `.omc/plans/multicam-phase2-wraith-parity.md`.

---

## Self-Review

**Spec coverage (vs `multicam-phase2-wraith-parity.md` Phase 2A):**
- 2A.1 per-track RMS extraction → Task 1 (`framesFromRmsTimelines`) + Task 3 (real extractor). ✓
- 2A.2 wire `buildSwitchPlan` into executor → Task 2 (`multicamFromAudio`) + Task 3 (dispatch). ✓
- 2A.3 sensitivity mapping → exposed via `params.silenceThresholdDb` in `multicamFromAudio` (slider UI deferred to Phase 2C, noted). ✓ (logic present; UI control is explicitly Phase 2C)

**Placeholder scan:** No TBD/“handle edge cases”/“similar to” — every code step shows full code. Task 3 Step 2 contains an explicit *verify-the-field-name* instruction (not a placeholder): the snapshot clip media-path field name must be confirmed against `getTimelineSnapshot`, with a concrete `getClipMediaPath` fallback path given.

**Type consistency:** `framesFromRmsTimelines(timelines, frameSec)` → `[{tStart,tEnd,rmsByTrack}]` matches `buildSwitchPlan` input. Extractor contract `{timelines:[[{t,rms}]]}` matches `computeRmsTimeline` output (`[{t,rms}]`) and `framesFromRmsTimelines` input. Plan object `{version,rangeSec,mapping,params,segments}` matches `applyMulticamCuts` reads (`plan.segments`, `plan.mapping.wideVideoTrack`, `plan.params.mode`).
