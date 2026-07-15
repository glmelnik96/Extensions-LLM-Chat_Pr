/**
 * nest-reconstruct.js — builds an ffmpeg filter_complex to lay audible audio
 * segments onto a silent bed and sum them. Gaps stay silent. Browser IIFE.
 */
(function (global) {
  'use strict';

  /* Не-медиа источники, которые ffmpeg декодировать не может: проекты
     (Dynamic Link After Effects/Premiere) и графические шаблоны. У них нет
     аудиофайла на диске — попытка скормить их ffmpeg даёт "Invalid data
     found when processing input". */
  var NON_MEDIA_EXT = {
    aep: 1, prproj: 1, aepx: 1, mogrt: 1, aegraphic: 1,
    psd: 1, psb: 1, ai: 1, prfpset: 1
  };

  function isReconstructableMediaPath(p) {
    if (!p) return false;
    var s = String(p);
    var dot = s.lastIndexOf('.');
    if (dot < 0 || dot === s.length - 1) return true; /* без расширения — не наш случай, не блокируем */
    var ext = s.substring(dot + 1).toLowerCase();
    return !NON_MEDIA_EXT[ext];
  }

  function buildNestReconstructFilter(segments, opts) {
    opts = opts || {};
    var sr = opts.sampleRate || 16000;
    if (!segments || !segments.length) {
      throw new Error('buildNestReconstructFilter: no audible segments');
    }
    /* Отсекаем Dynamic Link / графические источники: их аудио оффлайн-
       реконструкцией не достать (нет медиафайла). Оставшиеся сегменты
       по-прежнему адресуются абсолютным adelay, поэтому выпад части не
       ломает тайминг остальных. */
    var droppedNonMedia = [];
    var kept = [];
    for (var g = 0; g < segments.length; g++) {
      if (isReconstructableMediaPath(segments[g].mediaPath)) kept.push(segments[g]);
      else droppedNonMedia.push(segments[g]);
    }
    if (!kept.length) {
      throw new Error(
        'Во вложенной секвенции слышимое аудио — только Dynamic Link (After Effects) / ' +
        'графические клипы, у них нет аудиофайла на диске. Отрендерите AE-композицию ' +
        'в медиа (WAV/MOV) или замените клип обычным файлом, затем повторите транскрипцию.'
      );
    }
    segments = kept;
    var inputs = [];
    var parts = [];
    var labels = [];
    /* Реальная длина реконструированного аудио = самый поздний конец сегмента
       (localOffset + segDur). Нужна нарезчику, чтобы не резать пустые чанки за
       концом WAV после выпадения Dynamic Link-сегментов. */
    var effectiveDurSec = 0;
    for (var e = 0; e < segments.length; e++) {
      var end = (segments[e].localOffset || 0) + (segments[e].segDur || 0);
      if (end > effectiveDurSec) effectiveDurSec = end;
    }
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
      return { inputs: inputs, filterComplex: only, outLabel: outLabel, droppedNonMedia: droppedNonMedia, effectiveDurSec: effectiveDurSec };
    }
    parts.push(labels.join('') + 'amix=inputs=' + segments.length + ':normalize=0[' + outLabel + ']');
    return { inputs: inputs, filterComplex: parts.join(';'), outLabel: outLabel, droppedNonMedia: droppedNonMedia, effectiveDurSec: effectiveDurSec };
  }

  global.NestReconstruct = {
    buildNestReconstructFilter: buildNestReconstructFilter,
    isReconstructableMediaPath: isReconstructableMediaPath
  };
})(typeof window !== 'undefined' ? window : this);
