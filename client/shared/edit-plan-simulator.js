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
  var MATCH_TOLERANCE_SEC = 0.5;

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

  /* ─── Компактный дифф таймлайна после мутирующих операций ─────────── */

  /**
   * Считает max endSec по массиву клипов (= длительность секвенции с точки зрения клипов).
   */
  /* см. также ToolValidators.timelineSpanSec — дублирование осознанное: разные IIFE */
  function _maxEndSec(clips) {
    var mx = 0;
    for (var i = 0; i < clips.length; i++) {
      if (clips[i].endSec > mx) mx = clips[i].endSec;
    }
    return mx;
  }

  /**
   * buildTimelineDiff(beforeSnap, afterSnap, expectedDeltaSec)
   *
   * Сравнивает состояние таймлайна до и после мутации.
   * Возвращает компактный объект для LLM: длительности, дельту, совпадение с ожиданием.
   *
   * @param {object|null} beforeSnap  снимок ДО мутации (lastSnap)
   * @param {object|null} afterSnap   снимок ПОСЛЕ мутации (свежий getTimelineSnapshot)
   * @param {number|null} expectedDeltaSec  ожидаемое изменение длительности (null если непредсказуемо)
   * @returns {object} { before, after, deltaDurationSec, expectedDeltaSec, match, hint }
   */
  function buildTimelineDiff(beforeSnap, afterSnap, expectedDeltaSec) {
    var before = null;
    var after = null;

    if (beforeSnap && beforeSnap.ok && Array.isArray(beforeSnap.clips)) {
      before = {
        durationSec: Math.round(_maxEndSec(beforeSnap.clips) * 100) / 100,
        clipCount: beforeSnap.clips.length
      };
    }

    if (afterSnap && afterSnap.ok && Array.isArray(afterSnap.clips)) {
      after = {
        durationSec: Math.round(_maxEndSec(afterSnap.clips) * 100) / 100,
        clipCount: afterSnap.clips.length
      };
    }

    var deltaDurationSec = (before && after)
      ? Math.round((after.durationSec - before.durationSec) * 100) / 100
      : null;

    var expDelta = (typeof expectedDeltaSec === 'number') ? expectedDeltaSec : null;

    var match = null;
    if (expDelta !== null && deltaDurationSec !== null) {
      match = Math.abs(deltaDurationSec - expDelta) <= MATCH_TOLERANCE_SEC;
    }

    var hint = null;
    if (match === false) {
      hint = 'Ожидалось изменение длительности на ' + expDelta +
        ' с, фактически ' + deltaDurationSec +
        ' с — операция сделала не то, что планировалось. ' +
        'Вызови get_timeline_snapshot, проверь состояние и НЕ продолжай резать по старому плану.';
    }

    return {
      before: before,
      after: after,
      deltaDurationSec: deltaDurationSec,
      expectedDeltaSec: expDelta,
      match: match,
      hint: hint
    };
  }

  /* ─── Компактор снимка для контекста LLM ─────────────────────────── */

  /**
   * compactSnapshotForLlm(snap, maxClips)
   *
   * Возвращает компактное представление снимка для LLM-контекста:
   * строка на клип вместо полного объекта, усечение при >maxClips.
   *
   * @param {object|null} snap  результат getTimelineSnapshot
   * @param {number} [maxClips=80]  максимум клипов в выдаче
   * @returns {object|null} { sequenceName, clipCount, clips:[], truncated, note }
   */
  function compactSnapshotForLlm(snap, maxClips) {
    if (!snap || !snap.ok || !Array.isArray(snap.clips)) return null;
    var max = (typeof maxClips === 'number' && maxClips > 0) ? maxClips : 80;
    var clips = snap.clips;
    var truncated = clips.length > max;
    var shown = truncated ? clips.slice(0, max) : clips;
    var lines = [];
    for (var i = 0; i < shown.length; i++) {
      var c = shown[i];
      var start = (typeof c.startSec === 'number') ? c.startSec.toFixed(2) : '?';
      var end = (typeof c.endSec === 'number') ? c.endSec.toFixed(2) : '?';
      var track = c.trackType ? (c.trackType + (typeof c.trackIndex === 'number' ? c.trackIndex : '')) : (c.track || '');
      lines.push((c.nodeId || '?') + '|' + (c.name || '') + '|' + track + '|' + start + '-' + end);
    }
    var note = null;
    if (truncated) {
      note = 'Показаны первые ' + max + ' из ' + clips.length +
        ' — полный список через get_timeline_snapshot.';
    }
    return {
      sequenceName: snap.sequenceName || null,
      clipCount: clips.length,
      clips: lines,
      truncated: truncated,
      note: note
    };
  }

  /**
   * buildAutoSnapshotText(snap, opts) — текст [auto-snapshot] для чата.
   *
   * Извлечено из panel.js onSend (11.07.2026): инлайн-версия строила строку на
   * КАЖДЫЙ видеоклип без капа — плотный пост-мультикам таймлайн (11 429
   * видеоклипов на 6_SYNCED) дал ~170K токенов, Cloud.ru ответил 400
   * «maximum context length» и чат становился непригоден на такой секвенции.
   *
   * Формат (как раньше): видео-строки nodeId|name|vN|start-end[|off][|a=<id>@aN],
   * несвязанное аудио — отдельными строками. Линкованное аудио матчится по
   * name + |ΔstartSec|<0.1 (live-баг 19.06: BRAW-аудио пропадало из снимка).
   *
   * При clips > maxClips (дефолт 250) список опущен: пер-дорожечная сводка +
   * подсказка работать через транскрипт-инструменты (get_transcript_structure /
   * propose_montage_plan) — им список клипов не нужен.
   *
   * @param {object|null} snap результат getTimelineSnapshot
   * @param {object} [opts] { maxClips=250 }
   * @returns {string|null}
   */
  function buildAutoSnapshotText(snap, opts) {
    if (!snap || !snap.ok || !Array.isArray(snap.clips)) return null;
    opts = opts || {};
    var maxClips = (typeof opts.maxClips === 'number' && opts.maxClips > 0) ? opts.maxClips : 250;
    var all = snap.clips;
    var videoClips = [];
    var audioClipsAll = [];
    var i;
    for (i = 0; i < all.length; i++) {
      if (all[i].trackType === 'video') videoClips.push(all[i]);
      else if (all[i].trackType === 'audio') audioClipsAll.push(all[i]);
    }
    /* Реальная длительность — sequenceEndSec бывает 0 */
    var effectiveEndSec = snap.sequenceEndSec || 0;
    for (i = 0; i < all.length; i++) {
      if (all[i].endSec > effectiveEndSec) effectiveEndSec = all[i].endSec;
    }
    var head = '[auto-snapshot] seq=' + snap.sequenceName +
      ' dur=' + effectiveEndSec.toFixed(1) + 's fps=' + snap.fps;

    if (all.length > maxClips) {
      var perTrack = {};
      for (i = 0; i < all.length; i++) {
        var tk = (all[i].trackType ? all[i].trackType[0] : '?') +
          (typeof all[i].trackIndex === 'number' ? all[i].trackIndex : '?');
        perTrack[tk] = (perTrack[tk] || 0) + 1;
      }
      var parts = [];
      for (var k in perTrack) {
        if (Object.prototype.hasOwnProperty.call(perTrack, k)) parts.push(k + ': ' + perTrack[k]);
      }
      parts.sort();
      return head +
        '\nПлотный таймлайн: ' + all.length + ' клипов — список опущен (не влезает в контекст).' +
        '\nПо дорожкам: ' + parts.join(', ') + '.' +
        '\nРаботай через транскрипт: get_transcript_structure / propose_montage_plan; ' +
        'точечные клипы — get_timeline_snapshot не вызывай, проси пользователя указать таймкоды.';
    }

    /* Линкованное аудио НЕ прячем (live-баг 19.06.2026: BRAW-аудио линковано
       с видео → пропадало из снапшота → «нет аудиоклипа»). */
    var linkedAudioBy = {};
    var audioOnlyClips = [];
    for (i = 0; i < audioClipsAll.length; i++) {
      var c = audioClipsAll[i];
      var v = null;
      for (var vi3 = 0; vi3 < videoClips.length; vi3++) {
        if (videoClips[vi3].name === c.name && Math.abs(videoClips[vi3].startSec - c.startSec) < 0.1) { v = videoClips[vi3]; break; }
      }
      if (v) { if (!linkedAudioBy[v.nodeId]) linkedAudioBy[v.nodeId] = c; }
      else audioOnlyClips.push(c);
    }
    var lines = [];
    for (i = 0; i < videoClips.length; i++) {
      var vc = videoClips[i];
      var la = linkedAudioBy[vc.nodeId];
      lines.push(vc.nodeId + '|' + vc.name + '|' + vc.trackType[0] + vc.trackIndex + '|' + vc.startSec + '-' + vc.endSec +
        (vc.disabled ? '|off' : '') + (la ? '|a=' + la.nodeId + '@' + la.trackType[0] + la.trackIndex : ''));
    }
    for (i = 0; i < audioOnlyClips.length; i++) {
      var ac = audioOnlyClips[i];
      lines.push(ac.nodeId + '|' + ac.name + '|' + ac.trackType[0] + ac.trackIndex + '|' + ac.startSec + '-' + ac.endSec +
        (ac.disabled ? '|off' : ''));
    }
    return head + '\nclips(' + lines.length + '):\n' + lines.join('\n');
  }

  /* ─── Ожидаемая дельта длительности для набора операций ────────── */

  /**
   * calcExpectedDeltaSec(operations)
   *
   * Почему null = безопасный fallback: move_clip / trim / remove_clip и прочие операции
   * меняют длительность секвенции непредсказуемо без полной симуляции (зависят от
   * позиции клипа, перекрытий и т.д.). Возврат null сигнализирует вызывающему коду,
   * что проверять совпадение дельты бессмысленно — match останется null и hint не
   * сработает, что безопаснее ложного «mismatch».
   *
   * @param {Array} operations  нормализованные операции (action/kind)
   * @returns {number|null}  суммарная дельта в секундах, или null если непредсказуемо
   */
  function calcExpectedDeltaSec(operations) {
    if (!Array.isArray(operations) || !operations.length) return null;
    var delta = 0;
    for (var i = 0; i < operations.length; i++) {
      var op = operations[i];
      if (!op) continue;
      var a = op.action || op.kind || '';
      if (a === 'ripple_delete_range' || a === 'ripple_delete_range_all_tracks' ||
          a === 'ripple_delete_interval') {
        if (typeof op.startSec === 'number' && typeof op.endSec === 'number' && op.endSec > op.startSec) {
          delta -= (op.endSec - op.startSec);
        }
      } else if (a === 'shift_timeline_ripple' || a === 'shift_ripple') {
        /* shift увеличивает (+deltaSec) или уменьшает (−deltaSec) длительность секвенции */
        if (typeof op.deltaSec === 'number') {
          delta += op.deltaSec;
        } else {
          return null; /* непредсказуемо */
        }
      } else if (a === 'lift_delete_range' || a === 'lift_delete_range_all_tracks' ||
                 a === 'lift_delete_interval' || a === 'set_clip_enabled' ||
                 a === 'set_clips_enabled_by_name' || a === 'mute_track' || a === 'note') {
        /* Эти операции НЕ меняют длительность секвенции — 0-вклад */
      } else {
        /* move_clip, trim_in, trim_out, set_timeline_bounds, remove_clip и прочие —
           эффект на длительность непредсказуем без полной симуляции */
        return null;
      }
    }
    return Math.round(delta * 100) / 100;
  }

  /* ─── Гейт геометрии входа для монтажа по смыслам ──────────────── */

  /**
   * analyzeInputGeometry(snap)
   *
   * Проверяет, «сведён» ли вход для монтажа по смыслам. Корень всех классов сбоев —
   * НЕ количество дорожек, а ВРЕМЕННЫ́Е ПЕРЕСЕЧЕНИЯ: несведённый мультикам = 2+
   * видеоклипа играют одновременно; перекрывающиеся микрофоны = 2+ аудиоклипа
   * звучат одновременно. Последовательная раскладка по нескольким дорожкам
   * (клипы прыгают V1→V2→V1 без пересечений во времени) — это НЕ мультикам и
   * должна проходить. Доказано экспериментом 06.07.2026: те же removeIntervals
   * на сведённом входе дают gap=0/desync=0, на пересекающемся — 7с гэп + десинхрон.
   *
   * Чистая функция: работает по снимку getTimelineSnapshot, не трогает Premiere.
   *
   * @param {object|null} snap  результат getTimelineSnapshot
   * @returns {{consolidated: (boolean|null), reasons: Array<{code,message}>, details: (object|null)}}
   *   consolidated=null — снимок невалиден/пуст, определить нельзя (НЕ блокируем).
   */
  function analyzeInputGeometry(snap) {
    var START_EPS = 0.1;     /* начало контента считаем «нулевым» в пределах этого допуска */
    var OVERLAP_EPS = 0.05;  /* стык клипов (end==next.start) с точностью до кадра — НЕ пересечение */
    if (!snap || !snap.ok || !Array.isArray(snap.clips) || !snap.clips.length) {
      return { consolidated: null, reasons: [], details: null };
    }
    /* Собираем интервалы отдельно для видео и аудио (по ВСЕМ дорожкам сразу). */
    var vids = [], auds = [], minStart = null, i, c;
    for (i = 0; i < snap.clips.length; i++) {
      c = snap.clips[i];
      if (!c || typeof c.startSec !== 'number' || typeof c.endSec !== 'number') continue;
      if (c.disabled) continue; /* выключенный клип не играет — не создаёт пересечения */
      if (minStart === null || c.startSec < minStart) minStart = c.startSec;
      if ((c.trackType || 'video') === 'audio') auds.push(c); else vids.push(c);
    }
    /* Есть ли временно́е пересечение внутри набора клипов? Сортируем по началу,
       ведём «максимальный конец до сих пор»: если следующий стартует раньше него —
       два клипа играют одновременно. */
    function maxOverlap(list) {
      if (list.length < 2) return 0;
      var arr = list.slice().sort(function (a, b) { return a.startSec - b.startSec; });
      var maxEnd = arr[0].endSec, worst = 0, j, ov;
      for (j = 1; j < arr.length; j++) {
        ov = maxEnd - arr[j].startSec;
        if (ov > worst) worst = ov;
        if (arr[j].endSec > maxEnd) maxEnd = arr[j].endSec;
      }
      return worst;
    }
    var vOv = maxOverlap(vids), aOv = maxOverlap(auds);
    if (minStart === null) minStart = 0;
    var reasons = [];
    if (vOv > OVERLAP_EPS) {
      reasons.push({ code: 'OVERLAP_VIDEO', message: 'Видеоклипы перекрываются во времени (до ' + (Math.round(vOv * 100) / 100) + 'с) — несведённый мультикам' });
    }
    if (aOv > OVERLAP_EPS) {
      reasons.push({ code: 'OVERLAP_AUDIO', message: 'Аудиоклипы перекрываются во времени (до ' + (Math.round(aOv * 100) / 100) + 'с) — перекрывающиеся микрофоны' });
    }
    if (minStart > START_EPS) {
      reasons.push({ code: 'LEAD_GAP', message: 'Контент начинается не с 0 (' + (Math.round(minStart * 100) / 100) + 'с) — будет лид-гэп' });
    }
    return {
      consolidated: reasons.length === 0,
      reasons: reasons,
      details: {
        videoOverlapSec: Math.round(vOv * 100) / 100,
        audioOverlapSec: Math.round(aOv * 100) / 100,
        leadGapSec: Math.round(minStart * 100) / 100,
        videoClips: vids.length,
        audioClips: auds.length
      }
    };
  }

  global.EditPlanSimulator = {
    simulate: simulate,
    simulateUnified: simulateUnified,
    normalizeUnifiedPlan: normalizeUnifiedPlan,
    extractRippleIntervals: extractRippleIntervals,
    buildTimelineDiff: buildTimelineDiff,
    compactSnapshotForLlm: compactSnapshotForLlm,
    buildAutoSnapshotText: buildAutoSnapshotText,
    calcExpectedDeltaSec: calcExpectedDeltaSec,
    analyzeInputGeometry: analyzeInputGeometry
  };
})(typeof window !== 'undefined' ? window : this);
