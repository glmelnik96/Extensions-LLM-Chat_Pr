# Nest Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcribe a nested-sequence ("nest") clip on the Premiere timeline by descending into the nest to its underlying real source media, reconstructing the nest's *audible* audio offline with ffmpeg, and routing it through the existing Whisper path — bypassing PP 2026's broken export API entirely.

**Architecture:** The host detects a nest clip (`projectItem.isSequence()`), resolves it to the inner sequence by matching `projectItem.nodeId`, enumerates only *audible* inner audio clips (track not muted + clip not disabled), and returns a `nest_reconstruct` manifest carrying each contributing segment's source media path, source in-point, and its position mapped onto the OUTER (active) sequence timeline. The client builds a single 16 kHz mono WAV by laying each segment onto a silent bed (`adelay`) and summing tracks (`amix=normalize=0`) — gaps stay silent, matching what the nest actually plays. That reconstructed file then goes through the existing chunk-and-transcribe pipeline, with transcript timestamps already in outer-timeline coordinates.

**Tech Stack:** ExtendScript ES3 (host, tested live via CDP), browser ES5 + Node child_process/ffmpeg (client), `node --test` for pure client units.

---

## Background facts (verified live 2026-07-06, PP 26.2.2, project "1_SYNCED")

- **PP export is broken** (memory `env_pp2026_export_broken.md`): `exportAsMediaDirect`/`encodeSequence` → "Unknown Error"; `setInPoint(String)` ignored. The `export_chunks` path cannot produce audio in this build. This feature does NOT touch or rely on it.
- **Nest detection:** the timeline clip's `clip.projectItem.isSequence() === true`; `getMediaPath()` is empty; `pi.type === 1`. `pi.getSequence` is NOT a function in this build.
- **Nest → inner sequence:** the nest clip's `projectItem.nodeId` equals the inner sequence's `projectItem.nodeId` (both `"000f7244"` in the probe). Resolve by iterating `app.project.sequences` and matching `sq.projectItem.nodeId`.
- **Inner "Nested Sequence 01" (ec8ab26f) audio:** 3 tracks, every clip points to a real `.braw` on `D:\` carrying a `pcm_s24le 48 kHz` audio stream that ffmpeg extracts cleanly (verified 8 s → valid mp3). Audible = only A3 "Общий" (its clips `disabled:false`); A1/A2 clips `disabled:true`. A3 has time gaps → those become silence.
- **Outer nest clip:** on active seq d35da840 at `start=0`, `end=4007.42`; `inPoint` = how far into the nest it begins.
- **ExtendScript is ES3:** NO `Array.prototype.forEach`/`map`/`trim`, NO `Object.keys`, NO `String.trim`. JSON polyfill already present in host. Use `for` loops and index access only.
- **Client ffmpeg helpers already exist** in `client/shared/timeline-transcribe.js`: `findFfmpegPath()`, `extractAudioChunksWithFfmpeg(inputPath, srcStartSec, totalSpanSec, chunkSec, progress, format)`, `tempAudioPath(inputPath)`, `isAudioExt(p)`, `fileSizeSync(p)`, `normalizeWhisperExport(data, offset)`, `backendTranscribe(...)`, `analyzeChunksInParallel(...)`, `promisePool(tasks, N)`, `mergeSegmentLists(lists)`. The `media_file` handler (line ~864) is the template for chunk-and-transcribe.

## Offset math (single source of truth — used by host manifest and client)

Given outer nest clip: `outerStart = clip.start.seconds`, `outerEnd = clip.end.seconds`, `nestIn = clip.inPoint.seconds`, `windowDur = outerEnd - outerStart`. The visible nest-internal window is `[nestIn, nestIn + windowDur]`.

For each inner audible audio clip with `innerStart = c.start.seconds`, `innerEnd = c.end.seconds`, `mediaIn = c.inPoint.seconds`, `mediaPath`:
- Clamp to visible window: `vs = max(innerStart, nestIn)`, `ve = min(innerEnd, nestIn + windowDur)`. Skip if `ve <= vs + EPS`.
- **Local offset on the reconstructed bed (seconds):** `localOffset = vs - nestIn`  (bed spans `[0, windowDur]`).
- **Source media segment:** `srcStart = mediaIn + (vs - innerStart)`, `segDur = ve - vs`.
- **Outer-timeline time of any bed time τ:** `outerTime = outerStart + τ`. So the transcript base offset is `outerStart`.

---

## File Structure

- `host/premiere.jsx` — add `_resolveNestInner(clip)`, `_enumerateNestAudibleAudio(...)`, and a nest branch in `prepareTranscribeFromTimeline`. New response `mode:'nest_reconstruct'`.
- `client/shared/nest-reconstruct.js` — NEW. Pure function `buildNestReconstructFilter(segments, opts)` → `{ inputs, filterComplex, outLabel }`. No ffmpeg/Node dependency → unit-testable.
- `client/shared/timeline-transcribe.js` — add `reconstructNestAudio(prep, progress)` (runs ffmpeg using the builder) and a `prep.mode === 'nest_reconstruct'` handler that reconstructs then chunk-transcribes.
- `client/unified/panel.js` — no signature change needed (already passes `extensionRoot`); confirm the new mode flows through the existing result plumbing.
- `tests/nest-reconstruct.test.mjs` — NEW. Unit tests for the filter builder + offset mapping.
- Host verification is LIVE via CDP (`node tools/cep-debug.mjs hostfile <probe>`), not `node --test` (ES3 host can't run under node).

---

### Task 1: Pure client filter-builder `buildNestReconstructFilter`

**Files:**
- Create: `client/shared/nest-reconstruct.js`
- Test: `tests/nest-reconstruct.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// tests/nest-reconstruct.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildNestReconstructFilter } = require('../client/shared/nest-reconstruct.js');

test('single segment: one input, adelay by localOffset, single-input mix passthrough', () => {
  const segs = [{ mediaPath: 'D:/a.braw', srcStart: 10, segDur: 5, localOffset: 0, streamIndex: 2 }];
  const r = buildNestReconstructFilter(segs, { sampleRate: 16000 });
  assert.equal(r.inputs.length, 1);
  assert.deepEqual(r.inputs[0], { path: 'D:/a.braw', ss: 10, t: 5, streamIndex: 2 });
  // one input → no amix needed, just format the single stream
  assert.match(r.filterComplex, /\[0:a:0\]/);
  assert.match(r.filterComplex, /adelay=0\|0/);
  assert.match(r.filterComplex, new RegExp('\\[' + r.outLabel + '\\]$'));
});

test('two segments across gap: delays in ms, amix normalize=0', () => {
  const segs = [
    { mediaPath: 'D:/a.braw', srcStart: 0,  segDur: 4, localOffset: 0,    streamIndex: 1 },
    { mediaPath: 'D:/a.braw', srcStart: 8,  segDur: 6, localOffset: 12.5, streamIndex: 1 }
  ];
  const r = buildNestReconstructFilter(segs, { sampleRate: 16000 });
  assert.equal(r.inputs.length, 2);
  assert.equal(r.inputs[1].ss, 8);
  assert.match(r.filterComplex, /adelay=0\|0/);        // first at t=0
  assert.match(r.filterComplex, /adelay=12500\|12500/); // second at 12.5s → 12500 ms
  assert.match(r.filterComplex, /amix=inputs=2:normalize=0/);
});

test('empty segments throws', () => {
  assert.throws(() => buildNestReconstructFilter([], {}), /no audible/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/nest-reconstruct.test.mjs`
Expected: FAIL — `Cannot find module '../client/shared/nest-reconstruct.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// client/shared/nest-reconstruct.js
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NestReconstruct = api;
  if (typeof global !== 'undefined') global.NestReconstruct = api;
})(this, function () {
  'use strict';

  /**
   * Build ffmpeg inputs + filter_complex that lay each audible segment onto a
   * silent bed at its local offset and sum them. Gaps stay silent.
   *
   * segments: [{ mediaPath, srcStart, segDur, localOffset, streamIndex }]
   *   srcStart/segDur/localOffset in seconds; streamIndex = audio stream index in the source.
   * opts: { sampleRate=16000 }
   * returns { inputs:[{path,ss,t,streamIndex}], filterComplex:String, outLabel:String }
   */
  function buildNestReconstructFilter(segments, opts) {
    opts = opts || {};
    var sr = opts.sampleRate || 16000;
    if (!segments || !segments.length) {
      throw new Error('buildNestReconstructFilter: no audible segments');
    }
    var inputs = [];
    var parts = [];
    var labels = [];
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      inputs.push({ path: s.mediaPath, ss: s.srcStart, t: s.segDur, streamIndex: s.streamIndex });
      var delayMs = Math.round((s.localOffset || 0) * 1000);
      var lab = 'a' + i;
      // Select the input's audio stream, resample to target, mono, then delay onto the bed.
      parts.push(
        '[' + i + ':a:0]' +
        'aresample=' + sr + ',aformat=sample_fmts=s16:channel_layouts=mono,' +
        'adelay=' + delayMs + '|' + delayMs +
        '[' + lab + ']'
      );
      labels.push('[' + lab + ']');
    }
    var outLabel = 'mix';
    if (segments.length === 1) {
      // single input: relabel a0 → mix (amix of 1 is a no-op but avoid it)
      var only = parts[0].replace(/\[a0\]$/, '[' + outLabel + ']');
      return { inputs: inputs, filterComplex: only, outLabel: outLabel };
    }
    parts.push(labels.join('') + 'amix=inputs=' + segments.length + ':normalize=0[' + outLabel + ']');
    return { inputs: inputs, filterComplex: parts.join(';'), outLabel: outLabel };
  }

  return { buildNestReconstructFilter: buildNestReconstructFilter };
});
```

Note: the test expects `[0:a:0]` and `adelay=0|0` and trailing `[mix]`. For the single-segment case the code relabels `a0`→`mix`; adjust the regex in Step 1 already targets `outLabel`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/nest-reconstruct.test.mjs`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add client/shared/nest-reconstruct.js tests/nest-reconstruct.test.mjs
git commit -m "$(cat <<'EOF'
feat(transcribe): чистый билдер ffmpeg-фильтра для реконструкции аудио nest

adelay каждого слышимого сегмента на тихую подложку + amix normalize=0;
пропуски остаются тишиной. Юнит-тесты на смещения/мс/один-vs-много входов.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Host — resolve nest & enumerate audible audio

**Files:**
- Modify: `host/premiere.jsx` (add two helpers before `prepareTranscribeFromTimeline` at line ~2183)

Host cannot be unit-tested under node (ES3). Verify LIVE via CDP probe in Step 2/4.

- [ ] **Step 1: Add `_resolveNestInner` and `_enumerateNestAudibleAudio` helpers**

Insert after `_audioClipsIntersecting` (ends line 2109), before `_exportInOutAsChunks`:

```javascript
/**
 * Если clip — вложенная секвенция, вернуть внутреннюю Sequence по совпадению
 * projectItem.nodeId (getSequence() отсутствует в PP 2026). Иначе null.
 */
$._EXT_PRM_._resolveNestInner = function (clip) {
  try {
    var pi = clip && clip.projectItem;
    if (!pi) return null;
    var isSeq = false;
    try { isSeq = (typeof pi.isSequence === 'function') && pi.isSequence() === true; } catch (eIs) {}
    if (!isSeq) return null;
    var nid = null;
    try { nid = pi.nodeId; } catch (eN) {}
    if (!nid) return null;
    var seqs = app.project.sequences, i, sq, sid;
    for (i = 0; i < seqs.numSequences; i++) {
      sq = seqs[i];
      sid = null;
      try { if (sq.projectItem) sid = sq.projectItem.nodeId; } catch (eS) {}
      if (sid && sid === nid) return sq;
    }
    return null;
  } catch (e) { return null; }
};

/**
 * Перечислить СЛЫШИМЫЕ аудиосегменты внутренней секвенции, спроецированные на
 * внешний таймлайн. audible = дорожка не muted И клип не disabled.
 * nestIn = clip.inPoint.seconds, outerStart = clip.start.seconds,
 * windowDur = clip.end.seconds - clip.start.seconds.
 * Возвращает массив { mediaPath, streamIndex, srcStart, segDur, localOffset,
 *                     outerStart, outerEnd, trackIndex }.
 */
$._EXT_PRM_._enumerateNestAudibleAudio = function (inner, nestIn, outerStart, windowDur) {
  var out = [];
  var eps = $._EXT_PRM_._EPS;
  var winStart = nestIn, winEnd = nestIn + windowDur;
  var ti, j, tr, c, pi, muted, innerStart, innerEnd, mediaIn, mp, vs, ve;
  for (ti = 0; ti < inner.audioTracks.numTracks; ti++) {
    tr = inner.audioTracks[ti];
    muted = false;
    try { if (typeof tr.isMuted === 'function') muted = tr.isMuted() === true; } catch (eM) {}
    if (muted) continue;
    for (j = 0; j < tr.clips.numItems; j++) {
      c = tr.clips[j];
      if (!c) continue;
      if (c.disabled === true) continue;
      pi = c.projectItem;
      if (!pi) continue;
      mp = '';
      try { if (typeof pi.getMediaPath === 'function') mp = pi.getMediaPath(); } catch (eP) {}
      if (!mp || !$._EXT_PRM_._fileExists(mp)) continue;
      innerStart = c.start.seconds;
      innerEnd = c.end.seconds;
      mediaIn = c.inPoint ? c.inPoint.seconds : 0;
      vs = innerStart > winStart ? innerStart : winStart;
      ve = innerEnd < winEnd ? innerEnd : winEnd;
      if (ve <= vs + eps) continue;
      out.push({
        mediaPath: String(mp).replace(/\\/g, '/'),
        streamIndex: 0,
        srcStart: mediaIn + (vs - innerStart),
        segDur: ve - vs,
        localOffset: vs - winStart,
        outerStart: outerStart + (vs - winStart),
        outerEnd: outerStart + (ve - winStart),
        trackIndex: ti
      });
    }
  }
  return out;
};
```

Note on `streamIndex`: emitted as `0` and the client maps with `-map 0:a:0` per input (ffmpeg selects the first audio stream of each input file regardless of its absolute index), which is correct because each ffmpeg input is opened separately with its own `-i`.

- [ ] **Step 2: Verify helpers live (probe, do not commit the probe)**

Create `tools/_probe_nest_enum.jsx`:

```javascript
(function () {
  try {
    var seq = app.project.activeSequence;
    var found = null, ti, j, tr, c;
    for (ti = 0; ti < seq.videoTracks.numTracks && !found; ti++) {
      tr = seq.videoTracks[ti];
      for (j = 0; j < tr.clips.numItems; j++) {
        c = tr.clips[j];
        if (c && c.projectItem && typeof c.projectItem.isSequence === 'function' && c.projectItem.isSequence()) { found = c; break; }
      }
    }
    if (!found) return JSON.stringify({ ok:false, err:'no nest clip' });
    var inner = $._EXT_PRM_._resolveNestInner(found);
    if (!inner) return JSON.stringify({ ok:false, err:'resolve failed' });
    var nestIn = found.inPoint ? found.inPoint.seconds : 0;
    var segs = $._EXT_PRM_._enumerateNestAudibleAudio(inner, nestIn, found.start.seconds, found.end.seconds - found.start.seconds);
    return JSON.stringify({ ok:true, innerName: inner.name, nestIn: nestIn, count: segs.length, segs: segs });
  } catch (e) { return JSON.stringify({ ok:false, err:''+e }); }
})();
```

Run: `node tools/cep-debug.mjs hardreload` then `node tools/cep-debug.mjs hostfile tools/_probe_nest_enum.jsx`
Expected: `ok:true`, `innerName:"Nested Sequence 01"`, `count:3` (the 3 audible A3 clips), each seg with a real `D:/.../Общий/1098_...braw` path, ascending `localOffset` (≈6.17, 77.12, 124.08 minus nestIn), `outerStart`≈ same (nestIn≈0).
Then delete the probe: `rm -f tools/_probe_nest_enum.jsx`.

- [ ] **Step 3: Commit**

```bash
git add host/premiere.jsx
git commit -m "$(cat <<'EOF'
feat(host): резолв nest→внутренняя секвенция по nodeId + перечисление слышимого аудио

_resolveNestInner (isSequence + match projectItem.nodeId, getSequence отсутствует
в PP 2026), _enumerateNestAudibleAudio (audible = track не muted + clip не disabled)
с проекцией сегментов на внешний таймлайн. Проверено live CDP на 1_SYNCED.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Host — `nest_reconstruct` branch in `prepareTranscribeFromTimeline`

**Files:**
- Modify: `host/premiere.jsx` — single-clip branch, before the `NO_MEDIA_PATH` return at lines 2350-2357.

- [ ] **Step 1: Insert nest branch before the empty-media-path error**

Locate (line ~2336-2357):

```javascript
    var one = hits[0];
    var clip = one.clip;
    var pi = clip.projectItem;
    if (!pi) {
      return JSON.stringify({ ok: false, error: 'Нет projectItem у клипа', code: 'NO_PI' });
    }
    var mediaPath = '';
    try {
      if (typeof pi.getMediaPath === 'function') {
        mediaPath = pi.getMediaPath();
      } else if (pi.mediaPath) {
        mediaPath = String(pi.mediaPath);
      }
    } catch (eP) {}
    if (!mediaPath || !$._EXT_PRM_._fileExists(mediaPath)) {
      return JSON.stringify({
        ok: false,
        error:
          'У клипа нет пути к файлу на диске (вложенная секвенция/генератор). Нужен exportAudioPresetPath + .epr для экспорта In–Out.',
        code: 'NO_MEDIA_PATH'
      });
    }
```

Change the empty-media-path block to first attempt nest descent. Replace the `if (!mediaPath || !$._EXT_PRM_._fileExists(mediaPath)) { ... NO_MEDIA_PATH ... }` block with:

```javascript
    if (!mediaPath || !$._EXT_PRM_._fileExists(mediaPath)) {
      /* Вложенная секвенция: спускаемся внутрь, собираем слышимое аудио,
         клиент реконструирует его через ffmpeg (PP-экспорт в 2026 сломан). */
      var inner = $._EXT_PRM_._resolveNestInner(clip);
      if (inner) {
        var nestIn = clip.inPoint ? clip.inPoint.seconds : 0;
        var outerStart = one.startSec;
        var windowDur = one.endSec - one.startSec;
        var segs = $._EXT_PRM_._enumerateNestAudibleAudio(inner, nestIn, outerStart, windowDur);
        if (!segs.length) {
          return JSON.stringify({
            ok: false,
            error: 'Во вложенной секвенции нет слышимых аудиоклипов с файлом на диске (всё выключено/заглушено?).',
            code: 'NEST_NO_AUDIBLE',
            innerName: inner.name
          });
        }
        return JSON.stringify({
          ok: true,
          mode: 'nest_reconstruct',
          innerName: inner.name,
          segments: segs,
          workInSec: inSec,
          workOutSec: outSec,
          timelineOffsetSec: outerStart,
          windowDurSec: windowDur,
          hostVersion: $._EXT_PRM_.version
        });
      }
      return JSON.stringify({
        ok: false,
        error:
          'У клипа нет пути к файлу на диске (вложенная секвенция/генератор). Нужен exportAudioPresetPath + .epr для экспорта In–Out.',
        code: 'NO_MEDIA_PATH'
      });
    }
```

- [ ] **Step 2: Verify live (probe)**

Set In/Out spanning the nest on the active sequence, then create `tools/_probe_prep.jsx`:

```javascript
(function(){
  var payload = { extensionRoot: 'x', maxDirectTranscribeMediaSec: 999999 };
  return $._EXT_PRM_.prepareTranscribeFromTimeline(JSON.stringify(payload));
})();
```

Run: `node tools/cep-debug.mjs hardreload` then set In=0/Out≈30 on the nest (via UI or a setInPoint(0)/setOutPoint(30) probe using NUMBERS), then `node tools/cep-debug.mjs hostfile tools/_probe_prep.jsx`
Expected: JSON `mode:'nest_reconstruct'`, `segments` = audible A3 clips intersecting In/Out, `timelineOffsetSec`=0. Delete probe after.

- [ ] **Step 3: Commit**

```bash
git add host/premiere.jsx
git commit -m "$(cat <<'EOF'
feat(host): ветка nest_reconstruct в prepareTranscribeFromTimeline

Когда единственный клип In–Out — вложенная секвенция без пути к файлу,
спускаемся внутрь и отдаём манифест слышимых сегментов вместо NO_MEDIA_PATH.
Обходит сломанный PP-экспорт 2026. Проверено live CDP.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Client — reconstruct + transcribe handler

**Files:**
- Modify: `client/shared/timeline-transcribe.js` — add `reconstructNestAudio(...)` helper and a `prep.mode === 'nest_reconstruct'` handler.
- Ensure `client/shared/nest-reconstruct.js` is loaded in the panel (add `<script>` tag in `client/unified/index.html` next to other `client/shared/*.js` includes if not auto-bundled — verify how timeline-transcribe.js is loaded and mirror it).

- [ ] **Step 1: Add the reconstruct helper (uses the Task 1 builder + existing ffmpeg lookup)**

Add near the other ffmpeg helpers (after `extractAudioChunksWithFfmpeg`, ~line 307):

```javascript
  /**
   * Реконструировать слышимое аудио вложенной секвенции в один 16k mono WAV.
   * segments из host-манифеста (mode nest_reconstruct). Возвращает Promise<string> путь к WAV.
   */
  function reconstructNestAudio(segments, progress) {
    if (typeof require === 'undefined') return Promise.reject(new Error('Node.js недоступен для ffmpeg'));
    var ffmpegBin = findFfmpegPath();
    if (!ffmpegBin) return Promise.reject(new Error('ffmpeg не найден (см. host/presets/README.txt / установку ffmpeg).'));
    var builderApi = (typeof global !== 'undefined' && global.NestReconstruct) ||
                     (typeof window !== 'undefined' && window.NestReconstruct);
    if (!builderApi) return Promise.reject(new Error('nest-reconstruct.js не загружен'));
    var built = builderApi.buildNestReconstructFilter(segments, { sampleRate: 16000 });
    var os = require('os'), path = require('path');
    var outPath = path.join(os.tmpdir(), '_llm_nestmix_' + Date.now() + '.wav');
    var args = [];
    for (var i = 0; i < built.inputs.length; i++) {
      var inp = built.inputs[i];
      args.push('-ss', String(inp.ss), '-t', String(inp.t), '-i', inp.path);
    }
    args.push('-filter_complex', built.filterComplex, '-map', '[' + built.outLabel + ']',
              '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-y', outPath);
    var execFile = require('child_process').execFile;
    if (progress) progress('Реконструкция аудио nest через ffmpeg (' + built.inputs.length + ' сегм.)…');
    return new Promise(function (resolve, reject) {
      execFile(ffmpegBin, args, { timeout: 1800000 }, function (err) {
        if (err) { reject(new Error('ffmpeg nest reconstruct error: ' + String(err.message || err))); return; }
        var fs = require('fs');
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
          reject(new Error('ffmpeg создал пустой nest-mix (' + outPath + ')')); return;
        }
        resolve(outPath);
      });
    });
  }
```

- [ ] **Step 2: Add the mode handler**

Add before the `media_file` handler (line ~864), so it reuses the chunking that follows:

```javascript
    if (prep.mode === 'nest_reconstruct' && prep.segments && prep.segments.length) {
      beforeAwait();
      var nestWavPath = await reconstructNestAudio(prep.segments, progress);
      try {
        var chunkSecCfgN = (typeof settings.transcribeExportChunkSec === 'number' && settings.transcribeExportChunkSec >= 15)
          ? settings.transcribeExportChunkSec : 90;
        var baseOffN = (typeof prep.timelineOffsetSec === 'number') ? prep.timelineOffsetSec : 0;
        var spanN = (typeof prep.windowDurSec === 'number') ? prep.windowDurSec : 0;
        beforeAwait();
        progress('Транскрибация nest: нарезка ffmpeg…');
        var nChunks = await extractAudioChunksWithFfmpeg(nestWavPath, 0, spanN, chunkSecCfgN, progress, chunkFmt);
        var combinedN = [], textAccN = '', nDone = 0;
        var nTasks = nChunks.map(function (nch, nci) {
          return function () {
            return backendTranscribe(settings, {
              path: nch.path,
              fileName: 'nestmix_chunk_' + nci + '.' + (String(nch.path || '').replace(/^.*\./, '') || 'wav'),
              signal: signal, onProgress: function () {}, CloudRuClient: CC, transcribeOptsBase: transcribeOptsBase
            }).then(function (nData) {
              nDone++; progress('Транскрибация nest: ' + nDone + '/' + nChunks.length + ' готово…');
              return { index: nci, data: nData, offset: baseOffN + nch.offsetInSpanSec };
            });
          };
        });
        var nResults = await promisePool(nTasks, CLOUD_CONCURRENCY);
        nResults.sort(function (a, b) { return a.index - b.index; });
        for (var nri = 0; nri < nResults.length; nri++) {
          var nNorm = normalizeWhisperExport(nResults[nri].data, nResults[nri].offset);
          combinedN = combinedN.concat(nNorm.segments);
          textAccN += (nNorm.text || '') + ' ';
        }
        var audioAnalysisN = null;
        try {
          audioAnalysisN = await analyzeChunksInParallel(
            nChunks.map(function (c) { return { path: c && c.path, timelineOffsetSec: baseOffN + ((c && c.offsetInSpanSec) || 0) }; }),
            progress
          );
        } catch (eAN) {}
        return {
          raw: { nestSegments: prep.segments.length, ffmpegChunks: nChunks.length },
          segments: mergeSegmentLists([combinedN]),
          text: textAccN.trim(),
          timelineOffsetSec: baseOffN,
          mode: 'nest_reconstruct',
          audioAnalysis: audioAnalysisN
        };
      } finally {
        try { if (typeof require !== 'undefined') require('fs').unlinkSync(nestWavPath); } catch (eUN) {}
      }
    }
```

- [ ] **Step 3: Ensure the new module is loaded**

Grep how `timeline-transcribe.js` is included: `grep -rn "timeline-transcribe.js" client/unified/*.html`. Add a `<script src="../shared/nest-reconstruct.js"></script>` immediately BEFORE the `timeline-transcribe.js` include (so `window.NestReconstruct` exists). If the panel bundles via a loader manifest instead, add it there mirroring an existing `client/shared/*.js` entry.

- [ ] **Step 4: Run the pure unit tests + a lint sanity**

Run: `node --test tests/nest-reconstruct.test.mjs`
Expected: PASS. (No new node-testable logic added in this task, but confirm nothing regressed.)

- [ ] **Step 5: Commit**

```bash
git add client/shared/timeline-transcribe.js client/unified/index.html
git commit -m "$(cat <<'EOF'
feat(transcribe): клиентский путь nest_reconstruct (ffmpeg-микс → Whisper)

reconstructNestAudio строит один 16k mono WAV из слышимых сегментов nest и
прогоняет его через существующий чанк-транскрибатор с offset во внешний таймлайн.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: End-to-end live validation on 1_SYNCED

**Files:** none (verification only). Per memory `feedback_e2e_validation.md`: validate the real scenario + ground truth, not "code runs".

- [ ] **Step 1: Hard-reload host + panel**

Run: `node tools/cep-debug.mjs hardreload`

- [ ] **Step 2: Drive a real transcription**

Set In/Out on the active 1_SYNCED nest to a known-speech window (e.g. In=120, Out=200 — inside A3 clip 3 which starts ≈124 s). Trigger transcription from the panel (user drives UI per workflow memory). Watch progress: expect "Реконструкция аудио nest…" then "Транскрибация nest: N/N готово".

- [ ] **Step 3: Verify ground truth**

Confirm: (a) a transcript is produced (non-empty segments), (b) segment `startSec` values fall within the outer In/Out window [120,200] (offset math correct — NOT shifted by nestIn or media in-point), (c) the silent gap regions (e.g. 53–77 s if included) produce no phantom text. Spot-check 1-2 segments' text against the actual audio at that timecode.

- [ ] **Step 4: Verify it feeds montage-by-meaning**

Confirm the produced transcript lands in the transcript cache (`ContextStore.findTranscriptEntry`) so `propose_montage_plan` can consume it. This closes the deferred montage task.

- [ ] **Step 5: Commit any fixes found**

If validation surfaces an offset or filter bug, fix at root cause (systematic-debugging), re-run Step 2-4, then commit with a Russian message + the Co-Authored-By trailer.

---

## Self-Review Notes

- **Spec coverage:** approved design = "A, only audible tracks, gaps = silence, = render nest audio via ffmpeg". Covered: audible filter (Task 2 `_enumerateNestAudibleAudio`), silence-in-gaps (bed via `adelay`, no clip → silence), single rendered file (Task 4 `reconstructNestAudio`), outer-timeline offset (offset math + `timelineOffsetSec`).
- **No placeholders:** all code shown in full; ffmpeg args, filter strings, host helpers complete.
- **Type/name consistency:** manifest field names identical across host (`segments[].{mediaPath,srcStart,segDur,localOffset,streamIndex,outerStart,outerEnd,trackIndex}`), builder input (`{mediaPath,srcStart,segDur,localOffset,streamIndex}`), and client. `outLabel`/`filterComplex`/`inputs` consistent between Task 1 builder and Task 4 consumer.
- **ES3 safety:** host helpers use only `for` loops, index access, `String()`, no `forEach`/`map`/`Object.keys`/`trim`. Client `.map` is browser ES5 (allowed).
- **Known risk:** `amix=normalize=0` sums overlapping active tracks and could clip if two loud mics overlap; acceptable for Whisper intelligibility. If clipping harms recognition, add `dynaudnorm` before Whisper (follow-up, not in scope).
