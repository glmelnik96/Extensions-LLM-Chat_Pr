import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTranscriptView } from './load-transcript-view.mjs';
const { buildTranscriptViewRows, formatTimecode } = loadTranscriptView();

test('formatTimecode: M:SS under an hour, H:MM:SS at/над часом', () => {
  assert.equal(formatTimecode(0), '0:00');
  assert.equal(formatTimecode(5), '0:05');
  assert.equal(formatTimecode(65), '1:05');
  assert.equal(formatTimecode(600), '10:00');
  assert.equal(formatTimecode(3600), '1:00:00');
  assert.equal(formatTimecode(3725), '1:02:05');
});

test('prefers paragraphs when present; includes speaker and timecode', () => {
  const entry = {
    paragraphs: [
      { startSec: 0, endSec: 4, text: 'Привет', speaker: 'A' },
      { startSec: 4, endSec: 9, text: 'Как дела', speaker: 'B' }
    ],
    segments: [{ startSec: 0, endSec: 1, text: 'seg' }],
    text: 'всё'
  };
  const r = buildTranscriptViewRows(entry);
  assert.equal(r.source, 'paragraphs');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].time, '0:00');
  assert.equal(r.rows[0].speaker, 'A');
  assert.equal(r.rows[0].text, 'Привет');
  assert.equal(r.rows[1].time, '0:04');
  assert.deepEqual(r.meta.speakers, ['A', 'B']);
});

test('falls back to segments when no paragraphs', () => {
  const entry = {
    paragraphs: [],
    segments: [
      { startSec: 1.2, endSec: 3, text: 'один' },
      { startSec: 3, endSec: 5, text: 'два' }
    ],
    text: 'один два'
  };
  const r = buildTranscriptViewRows(entry);
  assert.equal(r.source, 'segments');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].time, '0:01');
  assert.equal(r.rows[0].speaker, '');
  assert.equal(r.rows[1].text, 'два');
});

test('falls back to plain text when no paragraphs/segments', () => {
  const r = buildTranscriptViewRows({ paragraphs: [], segments: [], text: 'сырой текст' });
  assert.equal(r.source, 'text');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].time, '');
  assert.equal(r.rows[0].text, 'сырой текст');
});

test('empty entry / falsy → source empty, no rows', () => {
  assert.equal(buildTranscriptViewRows(null).source, 'empty');
  assert.equal(buildTranscriptViewRows({}).source, 'empty');
  assert.equal(buildTranscriptViewRows({ paragraphs: [], segments: [], text: '' }).source, 'empty');
  assert.equal(buildTranscriptViewRows(null).rows.length, 0);
});

test('meta reports counts and total duration from last row end', () => {
  const entry = {
    paragraphs: [
      { startSec: 0, endSec: 4, text: 'a', speaker: 'A' },
      { startSec: 10, endSec: 15.5, text: 'b', speaker: 'A' }
    ]
  };
  const r = buildTranscriptViewRows(entry);
  assert.equal(r.meta.paragraphCount, 2);
  assert.equal(r.meta.durationSec, 15.5);
  assert.deepEqual(r.meta.speakers, ['A']);
});
