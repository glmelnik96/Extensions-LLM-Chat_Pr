import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsxSrc = fs.readFileSync(path.join(__dirname, '..', 'host', 'premiere.jsx'), 'utf8');

function extractHelpers() {
  const m = jsxSrc.match(/\/\* __FP_HELPERS_BEGIN__ \*\/([\s\S]*?)\/\* __FP_HELPERS_END__ \*\//);
  if (!m) throw new Error('Маркеры __FP_HELPERS_*__ не найдены в premiere.jsx');
  const fn = new Function(m[1] + '\nreturn { fnv1a: _extFnv1a, fpString: _extAudioFpString };');
  return fn();
}

/* Мок структур ExtendScript: коллекции = { numTracks/numItems, 0: …, 1: … } */
function clip(track, mediaPath, startTicks, endTicks, inTicks) {
  return {
    projectItem: { getMediaPath: function () { return mediaPath; } },
    name: 'clip',
    start: { ticks: String(startTicks) },
    end: { ticks: String(endTicks) },
    inPoint: { ticks: String(inTicks) }
  };
}
function seqWith(trackClipLists) {
  const at = { numTracks: trackClipLists.length };
  for (let t = 0; t < trackClipLists.length; t++) {
    const clipsObj = { numItems: trackClipLists[t].length };
    for (let c = 0; c < trackClipLists[t].length; c++) clipsObj[c] = trackClipLists[t][c];
    at[t] = { clips: clipsObj };
  }
  return { audioTracks: at, videoTracks: { numTracks: 99 } }; /* videoTracks не должен читаться */
}

test('fnv1a: известные векторы FNV-1a 32-bit', () => {
  const { fnv1a } = extractHelpers();
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(fnv1a('a'), 'e40c292c');
  assert.equal(fnv1a('foobar'), 'bf9cf968');
});

test('fnv1a: кириллица детерминирована и различима', () => {
  const { fnv1a } = extractHelpers();
  assert.equal(fnv1a('секвенция'), fnv1a('секвенция'));
  assert.notEqual(fnv1a('секвенция'), fnv1a('секвенцiя'));
  assert.match(fnv1a('секвенция'), /^[0-9a-f]{8}$/);
});

test('fpString: детерминированная сборка, формат поля через |, клипы через ;', () => {
  const { fpString } = extractHelpers();
  const seq = seqWith([[clip(0, 'C:\\a.wav', 0, 254016000000, 0)], [clip(1, '/b.wav', 100, 200, 50)]]);
  assert.equal(
    fpString(seq),
    '0|C:/a.wav|0|254016000000|0;1|/b.wav|100|200|50'
  );
});

test('fpString: чувствителен к каждому полю аудиоклипа', () => {
  const { fpString } = extractHelpers();
  const base = () => seqWith([[clip(0, 'C:/a.wav', 0, 1000, 0)]]);
  const ref = fpString(base());
  let s = base(); s.audioTracks[0].clips[0].start.ticks = '1'; assert.notEqual(fpString(s), ref);
  s = base(); s.audioTracks[0].clips[0].end.ticks = '999'; assert.notEqual(fpString(s), ref);
  s = base(); s.audioTracks[0].clips[0].inPoint.ticks = '5'; assert.notEqual(fpString(s), ref);
  s = base(); s.audioTracks[0].clips[0].projectItem = { getMediaPath: function () { return 'C:/b.wav'; } };
  assert.notEqual(fpString(s), ref);
});

test('fpString: fallback на clip.name при недоступном mediaPath; пустая секвенция → пустая строка', () => {
  const { fpString } = extractHelpers();
  const s = seqWith([[clip(0, 'x', 0, 1, 0)]]);
  s.audioTracks[0].clips[0].projectItem = null;
  assert.equal(fpString(s), '0|clip|0|1|0');
  assert.equal(fpString(seqWith([])), '');
});
