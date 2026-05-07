/**
 * AnalysisRouting — чистая логика роутинга меток анализа по агрессивности (US-003).
 *
 *   gentle:     только filler + artifact → toRemove
 *   normal:     + intro/outro/outtake/repeat → toRemove (digression остаётся в toKeep)
 *   aggressive: всё не-content → toRemove (включая digression)
 *
 * Вынесено из panel.js для unit-тестирования.
 */
(function (global) {
  'use strict';

  function shouldRemoveLabel(label, aggressiveness) {
    if (label === 'content') return false;
    var mode = aggressiveness || 'normal';
    if (mode === 'gentle') {
      return label === 'filler' || label === 'artifact';
    }
    if (mode === 'aggressive') {
      return label !== 'content';
    }
    /* normal (default) */
    return label !== 'content' && label !== 'digression';
  }

  /**
   * invertKeepToRemove — чистая инверсия keepIntervals → removeIntervals (US-004).
   *
   * @param {Array<{startSec, endSec}>} keepIntervals — что оставить
   * @param {Object} opts
   *   - minSec, maxSec (обязательно) — границы транскрипта/таймлайна
   *   - segments (опц.) — список {startSec, endSec} для выравнивания границ
   * @returns {{removeIntervals: Array}|{error: string}}
   */
  function invertKeepToRemove(keepIntervals, opts) {
    opts = opts || {};
    if (!Array.isArray(keepIntervals) || !keepIntervals.length) {
      return { error: 'keepIntervals пуст.' };
    }
    var minSec = typeof opts.minSec === 'number' ? opts.minSec : 0;
    var maxSec = typeof opts.maxSec === 'number' ? opts.maxSec : 0;
    if (maxSec <= minSec) {
      return { error: 'Не заданы границы [minSec, maxSec].' };
    }

    for (var i = 0; i < keepIntervals.length; i++) {
      var k = keepIntervals[i];
      if (typeof k.startSec !== 'number' || typeof k.endSec !== 'number' || k.endSec <= k.startSec) {
        return { error: 'keepIntervals[' + i + ']: некорректные границы.' };
      }
    }

    /* Сортируем + clipping по [minSec, maxSec] + merge пересечений */
    var sorted = keepIntervals.slice().sort(function (a, b) { return a.startSec - b.startSec; });
    var merged = [];
    for (var si = 0; si < sorted.length; si++) {
      var curS = Math.max(sorted[si].startSec, minSec);
      var curE = Math.min(sorted[si].endSec, maxSec);
      if (curE <= curS) continue;
      if (merged.length && curS <= merged[merged.length - 1].endSec + 0.05) {
        merged[merged.length - 1].endSec = Math.max(merged[merged.length - 1].endSec, curE);
      } else {
        merged.push({ startSec: curS, endSec: curE });
      }
    }

    /* Выравнивание границ по сегментам: расширяем keep до ближайших
       границ перекрывающих сегментов (не режем слова). */
    var segments = opts.segments;
    if (segments && segments.length) {
      merged = merged.map(function (iv) {
        var adjStart = iv.startSec;
        var adjEnd = iv.endSec;
        for (var k = 0; k < segments.length; k++) {
          var seg = segments[k];
          var ss = typeof seg.startSec === 'number' ? seg.startSec : seg.start;
          var se = typeof seg.endSec === 'number' ? seg.endSec : seg.end;
          if (typeof ss !== 'number' || typeof se !== 'number') continue;
          if (se > iv.startSec && ss < iv.endSec) {
            if (ss < adjStart) adjStart = ss;
            if (se > adjEnd) adjEnd = se;
          }
        }
        return { startSec: Math.max(adjStart, minSec), endSec: Math.min(adjEnd, maxSec) };
      });
      /* Повторный merge после расширения */
      var remerged = [];
      for (var mi = 0; mi < merged.length; mi++) {
        if (remerged.length && merged[mi].startSec <= remerged[remerged.length - 1].endSec + 0.05) {
          remerged[remerged.length - 1].endSec = Math.max(remerged[remerged.length - 1].endSec, merged[mi].endSec);
        } else {
          remerged.push(merged[mi]);
        }
      }
      merged = remerged;
    }

    /* Complement в [minSec, maxSec] */
    var removeIntervals = [];
    var cursor = minSec;
    for (var ki = 0; ki < merged.length; ki++) {
      var keep = merged[ki];
      if (keep.startSec > cursor + 0.01) {
        removeIntervals.push({
          startSec: cursor,
          endSec: keep.startSec,
          reason: 'не входит в keepIntervals[' + ki + ']'
        });
      }
      cursor = Math.max(cursor, keep.endSec);
    }
    if (maxSec > cursor + 0.01) {
      removeIntervals.push({
        startSec: cursor,
        endSec: maxSec,
        reason: 'после последнего keepInterval'
      });
    }

    /* HIGH #5 (6 мая 2026): если keepIntervals покрывают весь [minSec, maxSec],
       removeIntervals === [] → проактивно сообщаем об ошибке. Иначе UI ставит
       proposal с «вырезано 0 интервалов» — пользователь не понимает что произошло. */
    if (removeIntervals.length === 0) {
      return {
        error: 'keepIntervals покрывают весь транскрипт — нечего вырезать. ' +
          'Чтобы построить план, оставьте только нужные фрагменты в keepIntervals.'
      };
    }

    return { removeIntervals: removeIntervals };
  }

  /**
   * HIGH (6 мая 2026): валидация хронометража keep против target.
   *
   * Проблема: LLM на «уложи в 40 секунд» часто возвращает 60-70с keep —
   * не считает сумму durations. Передаём сюда, проверяем превышение, при overshoot >20%
   * возвращаем структурированную ошибку с подсказкой → LLM пересоберёт план.
   *
   * @param {Array<{startSec, endSec}>} keepIntervals
   * @param {number} targetSec — целевой хронометраж
   * @param {number} [allowedOvershoot=1.20] — допустимое превышение (1.20 = 20%)
   * @returns {{ok: true, keepSumSec: number}|{error: string, keepSumSec: number, overshootPct: number}}
   */
  function validateKeepDuration(keepIntervals, targetSec, allowedOvershoot) {
    var allowed = typeof allowedOvershoot === 'number' && allowedOvershoot > 1 ? allowedOvershoot : 1.20;
    if (!Array.isArray(keepIntervals) || !keepIntervals.length) {
      return { ok: true, keepSumSec: 0 };
    }
    if (typeof targetSec !== 'number' || targetSec <= 0) {
      return { ok: true, keepSumSec: 0 }; /* без target — пропускаем */
    }
    var sum = 0;
    for (var i = 0; i < keepIntervals.length; i++) {
      var iv = keepIntervals[i];
      if (typeof iv.startSec === 'number' && typeof iv.endSec === 'number' && iv.endSec > iv.startSec) {
        sum += iv.endSec - iv.startSec;
      }
    }
    if (sum <= targetSec * allowed) {
      return { ok: true, keepSumSec: sum };
    }
    var overshootPct = Math.round(((sum / targetSec) - 1) * 100);
    return {
      error: 'Сумма keepIntervals = ' + sum.toFixed(1) + 'с при цели ' + targetSec.toFixed(0) +
        'с (превышение на ' + overshootPct + '%). ' +
        'Сократи выбор: оставь топ-приоритеты (вступление + 1–2 ключевые мысли + заключение). ' +
        'Просуммируй endSec−startSec по каждому интервалу и убедись, что итог ≤ ' +
        targetSec.toFixed(0) + 'с (допуск +20%). ' +
        'Передай keepIntervals заново в propose_transcript_cuts с тем же targetDurationSec.',
      keepSumSec: sum,
      overshootPct: overshootPct
    };
  }

  global.AnalysisRouting = {
    shouldRemoveLabel: shouldRemoveLabel,
    invertKeepToRemove: invertKeepToRemove,
    validateKeepDuration: validateKeepDuration
  };
})(typeof window !== 'undefined' ? window : this);
