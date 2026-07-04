/**
 * Симулятор операций apply_timecode_edits на снимке таймлайна (без обращения к Premiere).
 *
 * Назначение:
 *   - dry-run для пользователя ДО применения,
 *   - источник данных для diff-карточки «было / станет» в подтверждении плана.
 *
 * Принцип:
 *   - На вход — копия snapshot.clips ([{nodeId, name, startSec, endSec, ...}]).
 *   - На выход — { clips, removedNodeIds, trimmedNodeIds, movedNodeIds, disabledNodeIds, summary }.
 *
 * Точность:
 *   - Симулятор НЕ моделирует Linked A/V (несколько дорожек) — работает на едином плоском списке клипов.
 *     Это достаточно для diff-картинки «до/после», т.к. сам Premiere потом всё равно отработает по реальному таймлайну.
 *   - Не моделирует поведение PP при коллизиях move_clip (shiftBlockingClips/makeRoom): помечает клип «moved».
 */
(function (global) {
  function cloneClip(c) {
    return {
      nodeId: c.nodeId,
      name: c.name,
      startSec: c.startSec,
      endSec: c.endSec,
      durationSec: typeof c.durationSec === 'number' ? c.durationSec : (c.endSec - c.startSec),
      disabled: !!c.disabled,
      _trimmed: false,
      _moved: false
    };
  }

  function rippleDeleteRange(clips, startSec, endSec) {
    var span = endSec - startSec;
    if (span <= 0) return clips;
    var out = [];
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (c.endSec <= startSec) {
        out.push(c);
      } else if (c.startSec >= endSec) {
        c.startSec -= span;
        c.endSec -= span;
        out.push(c);
      } else if (c.startSec >= startSec && c.endSec <= endSec) {
        /* полностью внутри — удаляется */
      } else {
        /* частично перекрывается — обрезаем и сдвигаем хвост */
        var left = c.startSec < startSec ? { from: c.startSec, to: startSec } : null;
        var right = c.endSec > endSec ? { from: endSec, to: c.endSec } : null;
        if (left) {
          var lc = cloneClip(c);
          lc.startSec = left.from;
          lc.endSec = left.to;
          lc._trimmed = true;
          out.push(lc);
        }
        if (right) {
          var rc = cloneClip(c);
          rc.startSec = right.from - span;
          rc.endSec = right.to - span;
          rc._trimmed = true;
          out.push(rc);
        }
      }
    }
    return out;
  }

  function liftDeleteRange(clips, startSec, endSec) {
    var out = [];
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (c.endSec <= startSec || c.startSec >= endSec) {
        out.push(c);
        continue;
      }
      if (c.startSec >= startSec && c.endSec <= endSec) continue;
      if (c.startSec < startSec && c.endSec > endSec) {
        var lc = cloneClip(c);
        lc.endSec = startSec;
        lc._trimmed = true;
        out.push(lc);
        var rc = cloneClip(c);
        rc.startSec = endSec;
        rc._trimmed = true;
        out.push(rc);
      } else if (c.startSec < startSec) {
        c.endSec = startSec;
        c._trimmed = true;
        out.push(c);
      } else {
        c.startSec = endSec;
        c._trimmed = true;
        out.push(c);
      }
    }
    return out;
  }

  function shiftRipple(clips, fromSec, deltaSec, excludeIds) {
    var ex = {};
    (excludeIds || []).forEach(function (id) {
      ex[String(id)] = 1;
    });
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (ex[String(c.nodeId)]) continue;
      if (c.startSec >= fromSec) {
        c.startSec += deltaSec;
        c.endSec += deltaSec;
        c._moved = true;
      }
    }
    return clips;
  }

  function findById(clips, nodeId) {
    var id = String(nodeId);
    for (var i = 0; i < clips.length; i++) {
      if (String(clips[i].nodeId) === id) return clips[i];
    }
    return null;
  }

  /**
   * @param {object} snapshot  результат get_timeline_snapshot
   * @param {object} plan      { operations: [...] }
   * @returns {{ ok, clips, removed, trimmed, moved, disabled, errors, summary }}
   */
  function simulate(snapshot, plan) {
    var errors = [];
    if (!snapshot || !snapshot.ok || !Array.isArray(snapshot.clips)) {
      return { ok: false, error: 'Нет валидного снимка таймлайна' };
    }
    var clips = snapshot.clips.map(cloneClip);
    var originalIds = {};
    snapshot.clips.forEach(function (c) {
      originalIds[String(c.nodeId)] = true;
    });
    var disabledFlipped = {};

    var ops = (plan && plan.operations) || [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      /* Поддержка и action (legacy), и kind (unified), и type */
      var a = op && (op.action || op.kind || op.type);
      try {
        if (a === 'ripple_delete_range' || a === 'ripple_delete_range_all_tracks') {
          clips = rippleDeleteRange(clips, +op.startSec, +op.endSec);
        } else if (a === 'lift_delete_range' || a === 'lift_delete_range_all_tracks') {
          clips = liftDeleteRange(clips, +op.startSec, +op.endSec);
        } else if (a === 'remove_clip') {
          clips = clips.filter(function (c) {
            return String(c.nodeId) !== String(op.nodeId);
          });
        } else if (a === 'set_timeline_in' || a === 'trim_to_timeline_in') {
          var ci = findById(clips, op.nodeId);
          if (ci && typeof op.timeSec === 'number') {
            ci.startSec = op.timeSec;
            ci._trimmed = true;
          }
        } else if (a === 'set_timeline_out' || a === 'trim_to_timeline_out') {
          var co = findById(clips, op.nodeId);
          if (co && typeof op.timeSec === 'number') {
            co.endSec = op.timeSec;
            co._trimmed = true;
          }
        } else if (a === 'set_timeline_bounds') {
          var cb = findById(clips, op.nodeId);
          if (cb && typeof op.startSec === 'number' && typeof op.endSec === 'number') {
            cb.startSec = op.startSec;
            cb.endSec = op.endSec;
            cb._trimmed = true;
          }
        } else if (a === 'move_clip') {
          var cm = findById(clips, op.nodeId);
          if (cm && typeof op.newStartSec === 'number') {
            var dur = cm.endSec - cm.startSec;
            cm.startSec = op.newStartSec;
            cm.endSec = op.newStartSec + dur;
            cm._moved = true;
          }
        } else if (a === 'shift_timeline_ripple') {
          if (typeof op.fromSec === 'number' && typeof op.deltaSec === 'number') {
            clips = shiftRipple(clips, op.fromSec, op.deltaSec, op.excludeNodeIds);
          }
        } else if (a === 'set_clip_enabled') {
          var ce = findById(clips, op.nodeId);
          if (ce && typeof op.enabled === 'boolean') {
            ce.disabled = !op.enabled;
            disabledFlipped[String(ce.nodeId)] = true;
          }
        } else if (a === 'set_clips_enabled_by_name') {
          var nm = String(op.clipName || op.name || '').toLowerCase();
          for (var j = 0; j < clips.length; j++) {
            if (String(clips[j].name || '').toLowerCase().indexOf(nm) >= 0) {
              clips[j].disabled = !op.enabled;
              disabledFlipped[String(clips[j].nodeId)] = true;
            }
          }
        }
        /* note / set_playhead / mute_track — не влияют на геометрию клипов */
      } catch (e) {
        errors.push({ op: a, error: String(e && e.message || e) });
      }
    }

    var newIds = {};
    clips.forEach(function (c) {
      newIds[String(c.nodeId)] = true;
    });
    var removed = [];
    Object.keys(originalIds).forEach(function (id) {
      if (!newIds[id]) removed.push(id);
    });
    var trimmed = [];
    var moved = [];
    clips.forEach(function (c) {
      if (c._trimmed) trimmed.push(String(c.nodeId));
      if (c._moved) moved.push(String(c.nodeId));
    });

    var totalDur = 0;
    clips.forEach(function (c) {
      if (!c.disabled) totalDur += Math.max(0, c.endSec - c.startSec);
    });
    var origDur = 0;
    snapshot.clips.forEach(function (c) {
      if (!c.disabled) origDur += Math.max(0, c.endSec - c.startSec);
    });

    return {
      ok: true,
      clips: clips,
      removed: removed,
      trimmed: trimmed,
      moved: moved,
      disabled: Object.keys(disabledFlipped),
      errors: errors,
      summary: {
        clipsBefore: snapshot.clips.length,
        clipsAfter: clips.length,
        removedCount: removed.length,
        trimmedCount: trimmed.length,
        movedCount: moved.length,
        durationBeforeSec: Math.round(origDur * 100) / 100,
        durationAfterSec: Math.round(totalDur * 100) / 100,
        deltaSec: Math.round((totalDur - origDur) * 100) / 100
      }
    };
  }

  /**
   * Унифицированный EditPlan (§2.1): нормализует операции «высокого уровня»
   * (kind:'ripple_delete_interval' / 'remove_clip' / ...) в legacy-формат
   * apply_timecode_edits.operations и запускает simulate().
   *
   * Единый контракт на пропоз/dry-run/apply упрощает LLM работу:
   * один инструмент вместо выбора между propose_transcript_cuts и propose_timecode_edits.
   */
  function normalizeUnifiedOp(op) {
    if (!op || typeof op !== 'object') return null;
    var k = String(op.kind || op.action || '').toLowerCase();
    if (k === 'ripple_delete_interval' || k === 'ripple_delete_range') {
      return { action: 'ripple_delete_range', startSec: +op.startSec, endSec: +op.endSec, _reason: op.reason, _quote: op.quote };
    }
    if (k === 'lift_delete_interval' || k === 'lift_delete_range') {
      return { action: 'lift_delete_range', startSec: +op.startSec, endSec: +op.endSec, _reason: op.reason, _quote: op.quote };
    }
    if (k === 'remove_clip') {
      return { action: 'remove_clip', nodeId: String(op.nodeId), _reason: op.reason };
    }
    if (k === 'trim_in' || k === 'set_timeline_in') {
      return { action: 'set_timeline_in', nodeId: String(op.nodeId), timeSec: +op.timeSec, _reason: op.reason };
    }
    if (k === 'trim_out' || k === 'set_timeline_out') {
      return { action: 'set_timeline_out', nodeId: String(op.nodeId), timeSec: +op.timeSec, _reason: op.reason };
    }
    if (k === 'trim_bounds' || k === 'set_timeline_bounds') {
      return {
        action: 'set_timeline_bounds',
        nodeId: String(op.nodeId),
        startSec: +op.startSec,
        endSec: +op.endSec,
        _reason: op.reason
      };
    }
    if (k === 'move_clip') {
      return {
        action: 'move_clip',
        nodeId: String(op.nodeId),
        newStartSec: +op.newStartSec,
        shiftBlockingClips: op.shiftBlockingClips,
        makeRoom: op.makeRoom,
        _reason: op.reason
      };
    }
    if (k === 'set_clip_enabled' || k === 'disable_clip' || k === 'enable_clip') {
      var en = k === 'enable_clip' ? true : k === 'disable_clip' ? false : !!op.enabled;
      return { action: 'set_clip_enabled', nodeId: String(op.nodeId), enabled: en, _reason: op.reason };
    }
    if (k === 'shift_ripple' || k === 'shift_timeline_ripple') {
      return {
        action: 'shift_timeline_ripple',
        fromSec: +op.fromSec,
        deltaSec: +op.deltaSec,
        excludeNodeIds: op.excludeNodeIds,
        _reason: op.reason
      };
    }
    if (k === 'mute_track') {
      return {
        action: 'mute_track',
        trackType: String(op.trackType || 'audio'),
        trackIndex: +op.trackIndex,
        muted: !!op.muted,
        _reason: op.reason
      };
    }
    if (k === 'note') {
      return { action: 'note', note: String(op.note || op.text || ''), _reason: op.reason };
    }
    return null;
  }

  function normalizeUnifiedPlan(plan) {
    /* Принимаем две формы: {ops:[...]} (новый) и {operations:[...]} (legacy) */
    var src = plan && (plan.ops || plan.operations) || [];
    var out = [];
    var rejected = [];
    for (var i = 0; i < src.length; i++) {
      var n = normalizeUnifiedOp(src[i]);
      if (n) out.push(n);
      else rejected.push(i);
    }
    return { operations: out, rejected: rejected };
  }

  /**
   * Симулирует унифицированный EditPlan на текущем снимке.
   * Возвращает то же, что simulate(), плюс .rejectedOpIdxs.
   */
  function simulateUnified(snapshot, plan) {
    var norm = normalizeUnifiedPlan(plan);
    var res = simulate(snapshot, { operations: norm.operations });
    res.rejectedOpIdxs = norm.rejected;
    res.normalizedOperations = norm.operations;
    return res;
  }

  /**
   * Интервалы ripple-удалений из нормализованного плана — нужно для
   * ContextStore.applyRippleDeletionsToTranscript() после apply_edit_plan.
   */
  function extractRippleIntervals(normalizedOps) {
    var out = [];
    for (var i = 0; i < normalizedOps.length; i++) {
      var o = normalizedOps[i];
      if (o && (o.action === 'ripple_delete_range' || o.action === 'ripple_delete_range_all_tracks')) {
        if (typeof o.startSec === 'number' && typeof o.endSec === 'number') {
          out.push({ startSec: o.startSec, endSec: o.endSec });
        }
      }
    }
    return out;
  }

  global.EditPlanSimulator = {
    simulate: simulate,
    simulateUnified: simulateUnified,
    normalizeUnifiedPlan: normalizeUnifiedPlan,
    extractRippleIntervals: extractRippleIntervals
  };
})(typeof window !== 'undefined' ? window : this);
