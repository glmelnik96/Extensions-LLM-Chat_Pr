/**
 * nest-reconstruct.js — builds an ffmpeg filter_complex to lay audible audio
 * segments onto a silent bed and sum them. Gaps stay silent. Browser IIFE.
 */
(function (global) {
  'use strict';

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
      var only = parts[0].replace(/\[a0\]$/, '[' + outLabel + ']');
      return { inputs: inputs, filterComplex: only, outLabel: outLabel };
    }
    parts.push(labels.join('') + 'amix=inputs=' + segments.length + ':normalize=0[' + outLabel + ']');
    return { inputs: inputs, filterComplex: parts.join(';'), outLabel: outLabel };
  }

  global.NestReconstruct = { buildNestReconstructFilter: buildNestReconstructFilter };
})(typeof window !== 'undefined' ? window : this);
