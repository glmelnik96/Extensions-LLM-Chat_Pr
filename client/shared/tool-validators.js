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
        a = op.action || op.kind || op.type;
        if (!a) continue;
        if (a === 'shift_timeline_ripple') {
          if (typeof op.fromSec !== 'number' || typeof op.deltaSec !== 'number') {
            return 'shift_timeline_ripple: нужны числа fromSec и deltaSec';
          }
          if (op.deltaSec <= 0) {
            return 'shift_timeline_ripple: deltaSec должен быть > 0';
          }
        }
        if (
          a === 'ripple_delete_range' ||
          a === 'ripple_delete_range_all_tracks' ||
          a === 'lift_delete_range' ||
          a === 'lift_delete_range_all_tracks'
        ) {
          if (typeof op.startSec !== 'number' || typeof op.endSec !== 'number') {
            return a + ': нужны числа startSec и endSec';
          }
          if (op.endSec <= op.startSec) {
            return a + ': endSec должен быть больше startSec';
          }
        }
        if (a === 'set_clips_enabled_by_name') {
          if (!String(op.clipName || op.name || '').trim()) {
            return 'set_clips_enabled_by_name: укажите clipName (имя клипа из снимка)';
          }
        }
        /* Проверка nodeId для действий, требующих клип */
        var needsNodeId =
          a !== 'set_clips_enabled_by_name' &&
          a !== 'shift_timeline_ripple' &&
          (a === 'remove_clip' ||
            a === 'set_clip_enabled' ||
            a === 'move_clip' ||
            a.indexOf('timeline') >= 0 ||
            a === 'set_timeline_bounds');
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
          /* set_clip_speed помечен как нереализуемый на PP 2025 (TrackItem.setSpeed
             отсутствует в ScriptingAPI). Валидатор отбивает запрос на уровне панели,
             чтобы не делать заведомо неуспешный round-trip к хосту. */
          return 'set_clip_speed: операция не поддерживается ScriptingAPI Premiere Pro 2025 (измените скорость вручную: правый клик → Speed/Duration)';
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

    /**
     * Валидатор унифицированного EditPlan (§2.1).
     * Принимает {ops:[...]} с высокоуровневыми op.kind.
     * Возвращает error string или null.
     */
    validateEditPlan: function (snap, plan) {
      if (!plan || typeof plan !== 'object') {
        return 'propose_edit_plan: ожидается объект { ops: [...] }';
      }
      var ops = plan.ops;
      if (!Array.isArray(ops) || !ops.length) {
        return 'propose_edit_plan: поле ops должно быть непустым массивом';
      }
      if (!snap || !snap.ok) {
        return 'propose_edit_plan: сначала вызовите get_timeline_snapshot';
      }
      var ids = clipIdSet(snap);
      var span = timelineSpanSec(snap);
      var clipKinds = {
        ripple_delete_interval: 1,
        lift_delete_interval: 1,
        remove_clip: 1,
        trim_in: 1,
        trim_out: 1,
        trim_bounds: 1,
        move_clip: 1,
        set_clip_enabled: 1,
        disable_clip: 1,
        enable_clip: 1,
        shift_ripple: 1,
        mute_track: 1,
        note: 1
      };
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        if (!op || typeof op !== 'object') return 'ops[' + i + ']: не объект';
        var kind = String(op.kind || op.action || '').toLowerCase();
        if (!kind) return 'ops[' + i + ']: нужно поле kind';
        if (!clipKinds[kind]) {
          return 'ops[' + i + ']: неизвестный kind "' + kind + '"';
        }
        if (kind === 'ripple_delete_interval' || kind === 'lift_delete_interval') {
          if (typeof op.startSec !== 'number' || typeof op.endSec !== 'number') {
            return 'ops[' + i + '] (' + kind + '): нужны числа startSec/endSec';
          }
          if (op.endSec <= op.startSec) {
            return 'ops[' + i + '] (' + kind + '): endSec должен быть > startSec';
          }
          if (span > 0 && op.endSec > span + 120) {
            return 'ops[' + i + '] (' + kind + '): интервал выходит далеко за конец таймлайна';
          }
        } else if (kind === 'remove_clip' || kind === 'set_clip_enabled' || kind === 'enable_clip' || kind === 'disable_clip') {
          if (!op.nodeId) return 'ops[' + i + '] (' + kind + '): нужен nodeId';
          if (!ids[String(op.nodeId)]) {
            return 'ops[' + i + '] (' + kind + '): клип ' + op.nodeId + ' не найден в снимке';
          }
        } else if (kind === 'trim_in' || kind === 'trim_out') {
          if (!op.nodeId) return 'ops[' + i + '] (' + kind + '): нужен nodeId';
          if (typeof op.timeSec !== 'number') return 'ops[' + i + '] (' + kind + '): нужен timeSec';
          if (!ids[String(op.nodeId)]) return 'ops[' + i + '] (' + kind + '): клип не найден';
        } else if (kind === 'trim_bounds') {
          if (!op.nodeId) return 'ops[' + i + '] (trim_bounds): нужен nodeId';
          if (typeof op.startSec !== 'number' || typeof op.endSec !== 'number') {
            return 'ops[' + i + '] (trim_bounds): нужны startSec/endSec';
          }
          if (op.endSec <= op.startSec) return 'ops[' + i + '] (trim_bounds): endSec > startSec';
        } else if (kind === 'move_clip') {
          if (!op.nodeId) return 'ops[' + i + '] (move_clip): нужен nodeId';
          if (typeof op.newStartSec !== 'number' || op.newStartSec < 0) {
            return 'ops[' + i + '] (move_clip): нужен newStartSec >= 0';
          }
        } else if (kind === 'shift_ripple') {
          if (typeof op.fromSec !== 'number' || typeof op.deltaSec !== 'number') {
            return 'ops[' + i + '] (shift_ripple): нужны числа fromSec/deltaSec';
          }
        } else if (kind === 'mute_track') {
          if (typeof op.trackIndex !== 'number') return 'ops[' + i + '] (mute_track): нужен trackIndex';
        }
      }
      return null;
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
