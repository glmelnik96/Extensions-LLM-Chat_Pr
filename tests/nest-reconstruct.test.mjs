import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNestReconstruct } from './load-nest-reconstruct.mjs';
const { buildNestReconstructFilter, isReconstructableMediaPath } = loadNestReconstruct();

test('single segment: one input, adelay by localOffset, single-input mix passthrough', () => {
  const segs = [{ mediaPath: 'D:/a.braw', srcStart: 10, segDur: 5, localOffset: 0, streamIndex: 2 }];
  const r = buildNestReconstructFilter(segs, { sampleRate: 16000 });
  assert.equal(r.inputs.length, 1);
  assert.deepEqual(r.inputs[0], { path: 'D:/a.braw', ss: 10, t: 5, streamIndex: 2 });
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
  assert.match(r.filterComplex, /adelay=0\|0/);
  assert.match(r.filterComplex, /adelay=12500\|12500/);
  assert.match(r.filterComplex, /amix=inputs=2:normalize=0/);
});

test('empty segments throws', () => {
  assert.throws(() => buildNestReconstructFilter([], {}), /no audible/i);
});

test('effectiveDurSec = max(localOffset + segDur) over kept segments', () => {
  const one = buildNestReconstructFilter(
    [{ mediaPath: 'D:/a.braw', srcStart: 10, segDur: 5, localOffset: 0, streamIndex: 2 }], {});
  assert.equal(one.effectiveDurSec, 5);

  const two = buildNestReconstructFilter([
    { mediaPath: 'D:/a.braw', srcStart: 0, segDur: 4, localOffset: 0,    streamIndex: 1 },
    { mediaPath: 'D:/a.braw', srcStart: 8, segDur: 6, localOffset: 12.5, streamIndex: 1 }
  ], {});
  assert.equal(two.effectiveDurSec, 18.5);
});

test('effectiveDurSec ignores dropped Dynamic Link segments (reflects only kept media)', () => {
  const r = buildNestReconstructFilter([
    { mediaPath: '/vol/PRJ/Podcast_Pack.aep', srcStart: 0, segDur: 25, localOffset: 0,       streamIndex: 0 },
    { mediaPath: '/vol/SFX/bed.wav',          srcStart: 0, segDur: 40, localOffset: 5,       streamIndex: 0 },
    { mediaPath: '/vol/PRJ/Podcast_Pack.aep', srcStart: 0, segDur: 22, localOffset: 4738.56, streamIndex: 0 }
  ], {});
  assert.equal(r.effectiveDurSec, 45);
});

test('isReconstructableMediaPath: media true, project/graphic sources false', () => {
  assert.equal(isReconstructableMediaPath('D:/a.braw'), true);
  assert.equal(isReconstructableMediaPath('/x/y.wav'), true);
  assert.equal(isReconstructableMediaPath('/x/y.MOV'), true);
  assert.equal(isReconstructableMediaPath('/x/y.mp4'), true);
  assert.equal(isReconstructableMediaPath('/vol/PRJ/Podcast_Pack.aep'), false);
  assert.equal(isReconstructableMediaPath('/vol/PRJ/Show.prproj'), false);
  assert.equal(isReconstructableMediaPath('/vol/lower.aep'), false);
  assert.equal(isReconstructableMediaPath('/vol/UP.AEP'), false);
  assert.equal(isReconstructableMediaPath('/vol/title.mogrt'), false);
  assert.equal(isReconstructableMediaPath(''), false);
});

test('drops Dynamic Link (.aep) segments, keeps media, reports droppedNonMedia', () => {
  const segs = [
    { mediaPath: '/vol/PRJ/Podcast_Pack.aep', srcStart: 0, segDur: 25, localOffset: 0,  streamIndex: 0 },
    { mediaPath: '/vol/SFX/bed.wav',          srcStart: 0, segDur: 40, localOffset: 5,  streamIndex: 0 },
    { mediaPath: '/vol/PRJ/Podcast_Pack.aep', srcStart: 0, segDur: 22, localOffset: 79, streamIndex: 0 }
  ];
  const r = buildNestReconstructFilter(segs, { sampleRate: 16000 });
  assert.equal(r.inputs.length, 1);
  assert.equal(r.inputs[0].path, '/vol/SFX/bed.wav');
  assert.equal(r.droppedNonMedia.length, 2);
  assert.match(r.filterComplex, /adelay=5000\|5000/);
});

test('all segments non-media throws clear Dynamic Link message', () => {
  const segs = [
    { mediaPath: '/vol/PRJ/Podcast_Pack.aep', srcStart: 0, segDur: 25, localOffset: 0,  streamIndex: 0 },
    { mediaPath: '/vol/PRJ/Podcast_Pack.aep', srcStart: 0, segDur: 22, localOffset: 79, streamIndex: 0 }
  ];
  assert.throws(() => buildNestReconstructFilter(segs, {}), /Dynamic Link|After Effects/i);
});
