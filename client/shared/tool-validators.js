/**
 * Локальная валидация аргументов инструментов до вызова Premiere (не замена LLM).
 */
(function (global) {
  function clipIdSet(snap) {
    var set = {};
    if (!snap || !snap.clips) return set;
    snap.clips.forEach(function (c) {
      if (c && c.nodeId) set[String(c.nodeId)] = true;
    });
    return set;
  }

  function timelineSpanSec(snap) {
    var maxEnd = 0;
    if (!snap || !snap.clips) return 0;
    snap.clips.forEach(function (c) {
      if (c && typeof c.endSec === 'number' && c.endSec > maxEnd) maxEnd = c.endSec;
    });
    return maxEnd;
  }

  function findClip(snap, nodeId) {
    if (!snap || !snap.clips) return null;
    var id = String(nodeId);
    for (var i = 0; i < snap.clips.length; i++) {
      if (String(snap.clips[i].nodeId) === id) return snap.clips[i];
    }
    return null;
  }

  global.ToolValidators = {
    /**
     * @returns {string|null} текст ошибки или null если ок
     */
    validateTimecodePlan: function (snap, plan) {
      if (!plan || !Array.isArray(plan.operations)) {
        return 'apply_timecode_edits: нужен объект с массивом operations';
      }
      if (!snap || !snap.ok) {
        return 'Сначала вызовите get_timeline_snapshot (нет актуального снимка).';
      }
      var ids = clipIdSet(snap);
      var j,
        op,
        a,
        clip;
      for (j = 0; j < plan.operations.length; j++) {
        op = plan.operations[j];
        a = op.action;
        if (!a) continue;
        if (a === 'ripple_delete_range' || a === 'ripple_delete_range_all_tracks') {
          if (typeof op.startSec !== 'number' || typeof op.endSec !== 'number') {
            return 'ripple_delete_range: нужны числа startSec и endSec';
          }
          if (op.endSec <= op.startSec) {
            return 'ripple_delete_range: endSec должен быть больше startSec';
          }
        }
        /* Проверка nodeId для действий, требующих клип */
        var needsNodeId = (a === 'remove_clip' || a === 'set_clip_enabled' || a === 'move_clip' || a === 'set_clip_speed' ||
          a.indexOf('timeline') >= 0 || a === 'set_timeline_bounds');
        if (needsNodeId) {
          if (!op.nodeId) continue;
          if (!ids[String(op.nodeId)]) {
            return 'nodeId не найден на таймлайне в последнем снимке: ' + op.nodeId;
          }
        }
        if (a === 'set_timeline_in' || a === 'trim_to_timeline_in') {
          clip = findClip(snap, op.nodeId);
          if (clip && typeof op.timeSec === 'number') {
            if (op.timeSec <= clip.startSec + 0.02 || op.timeSec >= clip.endSec - 0.02) {
              return 'set_timeline_in: timeSec (' + op.timeSec + ') должен быть строго внутри клипа (' + clip.startSec.toFixed(2) + '–' + clip.endSec.toFixed(2) + ')';
            }
          }
        }
        if (a === 'set_timeline_out' || a === 'trim_to_timeline_out') {
          clip = findClip(snap, op.nodeId);
          if (clip && typeof op.timeSec === 'number') {
            if (op.timeSec <= clip.startSec + 0.02 || op.timeSec >= clip.endSec - 0.02) {
              return 'set_timeline_out: timeSec (' + op.timeSec + ') должен быть строго внутри клипа (' + clip.startSec.toFixed(2) + '–' + clip.endSec.toFixed(2) + ')';
            }
          }
        }
        if (a === 'set_timeline_bounds') {
          clip = findClip(snap, op.nodeId);
          if (clip && typeof op.startSec === 'number' && typeof op.endSec === 'number') {
            if (op.endSec <= op.startSec) return 'set_timeline_bounds: endSec > startSec';
            if (op.startSec < clip.startSec - 0.02 || op.endSec > clip.endSec + 0.02) {
              return 'set_timeline_bounds: границы выходят за пределы клипа на таймлайне';
            }
          }
        }
        if (a === 'move_clip') {
          if (typeof op.newStartSec !== 'number') return 'move_clip: нужен числовой newStartSec';
          if (op.newStartSec < 0) return 'move_clip: newStartSec не может быть отрицательным';
        }
        if (a === 'set_clip_speed') {
          if (typeof op.speed !== 'number' || op.speed <= 0) return 'set_clip_speed: speed должен быть > 0';
        }
        if (a === 'set_playhead') {
          if (typeof op.timeSec !== 'number') return 'set_playhead: нужен числовой timeSec';
          if (op.timeSec < 0) return 'set_playhead: timeSec не может быть отрицательным';
        }
        if (a === 'mute_track') {
          if (typeof op.trackIndex !== 'number') return 'mute_track: нужен числовой trackIndex';
          var tt = String(op.trackType || 'video');
          if (tt !== 'video' && tt !== 'audio') return 'mute_track: trackType должен быть video или audio';
        }
      }
      return null;
    },

    /**
     * @returns {{ error: string|null, warn: string|null }}
     */
    validateTranscriptCuts: function (snap, cuts) {
      if (!cuts || !Array.isArray(cuts.removeIntervals)) {
        return { error: 'apply_transcript_cuts: нужен removeIntervals (массив)', warn: null };
      }
      var span = snap && snap.ok ? timelineSpanSec(snap) : 0;
      var i,
        iv,
        warn = null;
      for (i = 0; i < cuts.removeIntervals.length; i++) {
        iv = cuts.removeIntervals[i];
        if (typeof iv.startSec !== 'number' || typeof iv.endSec !== 'number') {
          return { error: 'Интервал ' + i + ': нужны startSec и endSec (числа)', warn: null };
        }
        if (iv.endSec <= iv.startSec) {
          return { error: 'Интервал ' + i + ': endSec должен быть > startSec', warn: null };
        }
        if (span > 0 && iv.endSec > span + 120) {
          warn =
            'Предупреждение: интервал выходит далеко за конец клипов на снимке — проверьте сдвиг транскрипта.';
        }
      }
      return { error: null, warn: warn };
    },

    validateMarkersList: function (snap, markers) {
      if (!markers || !Array.isArray(markers)) {
        return 'add_markers: нужен массив markers';
      }
      if (markers.length === 0) {
        return 'add_markers: передайте хотя бы один маркер';
      }
      var span = timelineSpanSec(snap);
      var k,
        m;
      for (k = 0; k < markers.length; k++) {
        m = markers[k];
        if (typeof m.timeSec !== 'number' || isNaN(m.timeSec)) {
          return 'Маркер ' + k + ': нужен числовой timeSec';
        }
        if (m.timeSec < 0) return 'Маркер ' + k + ': timeSec < 0';
        if (span > 0 && m.timeSec > span + 60) {
          return 'Маркер ' + k + ': timeSec сильно за пределами таймлайна по снимку; обновите снимок или проверьте время';
        }
      }
      return null;
    }
  };
})(window);
