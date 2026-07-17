/**
 * transcript-view.js — pure helpers to turn a stored transcript entry into
 * readable rows for the viewer UI. Browser IIFE (global.TranscriptView), no DOM.
 *
 * Priority: paragraphs (readable, with speakers) → segments (raw) → plain text.
 */
(function (global) {
  'use strict';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Секунды → «M:SS» (или «H:MM:SS» от часа и выше). */
  function formatTimecode(sec) {
    if (typeof sec !== 'number' || isNaN(sec) || sec < 0) sec = 0;
    var total = Math.floor(sec);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
    return m + ':' + pad2(s);
  }

  function nonEmptyArr(a) { return a && a.length ? a : null; }

  function collectSpeakers(rows) {
    var seen = {};
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var sp = rows[i].speaker;
      if (sp && !seen[sp]) { seen[sp] = 1; out.push(sp); }
    }
    return out;
  }

  /**
   * @param {object} entry — { paragraphs?, segments?, text? }
   * @returns {{ rows: Array<{time,startSec,endSec,speaker,text}>, source: string, meta: object }}
   */
  function buildTranscriptViewRows(entry) {
    var empty = {
      rows: [],
      source: 'empty',
      meta: { paragraphCount: 0, segmentCount: 0, speakers: [], durationSec: 0 }
    };
    if (!entry || typeof entry !== 'object') return empty;

    var paras = nonEmptyArr(entry.paragraphs);
    var segs = nonEmptyArr(entry.segments);
    var rows = [];
    var source;

    if (paras) {
      source = 'paragraphs';
      for (var i = 0; i < paras.length; i++) {
        var p = paras[i];
        rows.push({
          time: formatTimecode(p.startSec),
          startSec: typeof p.startSec === 'number' ? p.startSec : 0,
          endSec: typeof p.endSec === 'number' ? p.endSec : 0,
          speaker: p.speaker ? String(p.speaker) : '',
          text: p.text != null ? String(p.text) : ''
        });
      }
    } else if (segs) {
      source = 'segments';
      for (var j = 0; j < segs.length; j++) {
        var s = segs[j];
        rows.push({
          time: formatTimecode(s.startSec),
          startSec: typeof s.startSec === 'number' ? s.startSec : 0,
          endSec: typeof s.endSec === 'number' ? s.endSec : 0,
          speaker: '',
          text: s.text != null ? String(s.text) : ''
        });
      }
    } else if (entry.text && String(entry.text).trim()) {
      source = 'text';
      rows.push({ time: '', startSec: 0, endSec: 0, speaker: '', text: String(entry.text) });
    } else {
      return empty;
    }

    var durationSec = rows.length ? (rows[rows.length - 1].endSec || 0) : 0;
    return {
      rows: rows,
      source: source,
      meta: {
        paragraphCount: paras ? paras.length : 0,
        segmentCount: segs ? segs.length : 0,
        speakers: collectSpeakers(rows),
        durationSec: durationSec
      }
    };
  }

  global.TranscriptView = {
    buildTranscriptViewRows: buildTranscriptViewRows,
    formatTimecode: formatTimecode
  };
})(typeof window !== 'undefined' ? window : this);
