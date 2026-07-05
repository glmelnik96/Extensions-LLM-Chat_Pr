import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTranscriptStructure } from './load-transcript-structure.mjs';

const TS = loadTranscriptStructure();

test('applyCalibration: корректировки по blockId накладываются на labeled', () => {
  const labeled = [
    { i:0, blockId:'b0', importance:1, role:'hook', theme:'t', protect:null },
    { i:1, blockId:'b1', importance:2, role:'argument', theme:'t', protect:null }
  ];
  const calib = [ { blockId:'b0', importance:3, protect:'start' } ];
  const out = TS.applyCalibration(labeled, calib);
  assert.equal(out[0].importance, 3);
  assert.equal(out[0].protect, 'start');
  assert.equal(out[1].importance, 2); // без изменений
});

test('fallbackCalibration: первый/последний блок с importance>=2 получают protect', () => {
  const labeled = [
    { i:0, blockId:'b0', importance:2, role:'hook', theme:'t', protect:null },
    { i:1, blockId:'b1', importance:1, role:'filler', theme:'t', protect:null },
    { i:2, blockId:'b2', importance:3, role:'payoff', theme:'t', protect:null }
  ];
  const out = TS.fallbackCalibration(labeled);
  assert.equal(out.find(x => x.blockId === 'b0').protect, 'start');
  assert.equal(out.find(x => x.blockId === 'b2').protect, 'end');
});
