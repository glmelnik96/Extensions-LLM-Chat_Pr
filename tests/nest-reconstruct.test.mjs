import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNestReconstruct } from './load-nest-reconstruct.mjs';
const { buildNestReconstructFilter } = loadNestReconstruct();

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
