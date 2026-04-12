/**
 * Deterministic Pipelines — детерминированные пайплайны для типовых задач.
 *
 * Обходят LLM-агента полностью или сводят к 1 вызову.
 * Конкуренты (AutoPod, Firecut) не используют LLM для silence removal,
 * filler removal, chapterize — это алгоритмы, а не чат.
 *
 * Каждый пайплайн = async function(ctx) → {ok, summary, proposal?}
 * ctx = { settings, snapshot, transcriptEntry, onStatus, abortCheck }
 *
 * Пайплайны могут:
 *  1. Возвращать proposal (карточка подтверждения в UI)
 *  2. Возвращать результат напрямую (для quick-path)
 */
(function (global) {
  'use strict';

  /* ── Константы ──────────────────────────────────────────── */

  /**
   * Строгие филлеры — слова, которые ВСЕГДА паразиты, вне контекста.
   * Проверяются ПО ОТДЕЛЬНЫМ СЛОВАМ, не по целому сегменту.
   */
  var STRICT_FILLERS = [
    'э', 'ээ', 'эээ', 'эм', 'ээм', 'эмм',
    'м', 'мм', 'ммм', 'хм', 'хмм',
    'ам', 'аам', 'ааа',
    'ну', 'нуу',
    'блин'
  ];

  /**
   * Расширенные филлеры — контекстно-зависимые фразы.
   * Включаются только в режиме 'normal'/'expanded'.
   * Проверяются ПО ОТДЕЛЬНЫМ СЛОВАМ / ФРАЗАМ.
   */
  var EXTENDED_FILLERS = [
    'как бы', 'типа', 'короче', 'ну типа', 'как бы это',
    'вот', 'значит', 'в общем', 'допустим', 'ладно',
    'ну вот', 'слушай', 'слушайте', 'так сказать',
    'собственно', 'собственно говоря'
  ];

  /** Максимальная длительность сегмента, чтобы считать его целиком филлером (сек). */
  var MAX_FILLER_DURATION = 1.5;
  /** Расширенная макс. длительность для normal-режима */
  var MAX_FILLER_DURATION_NORMAL = 2.5;

  /** Padding при вырезке филлеров (сек) — оставляем края, чтобы не рвать речь. */
  var FILLER_PADDING = 0.07;

  /* ── Helpers ──────────────────────────────────────────────── */

  /**
   * Нормализует текст: нижний регистр, удаляет пунктуацию по краям.
   */
  function normText(t) {
    return String(t || '').trim().toLowerCase()
      .replace(/^[.,!?:;…\-–—]+/, '')
      .replace(/[.,!?:;…\-–—]+$/, '')
      .trim();
  }

  /**
   * Проверяет, является ли текст сегмента целиком филлером.
   * @param {string} text — текст сегмента
   * @param {boolean} expanded — использовать расширенный список
   * @returns {string|null} — найденный филлер или null
   */
  function isWholeFiller(text, expanded) {
    var t = normText(text);
    if (!t) return null;

    for (var i = 0; i < STRICT_FILLERS.length; i++) {
      if (t === STRICT_FILLERS[i]) return STRICT_FILLERS[i];
    }
    /* Проверка повторов типа "э-э-э", "м-м-м" */
    if (/^[эеe][э\-еe\s]*$/i.test(t)) return t;
    if (/^[мm][м\-m\s]*$/i.test(t)) return t;
    if (/^а+[мm]+$/i.test(t)) return t;

    if (expanded) {
      for (var j = 0; j < EXTENDED_FILLERS.length; j++) {
        if (t === EXTENDED_FILLERS[j]) return EXTENDED_FILLERS[j];
      }
    }
    return null;
  }

  /**
   * Считает количество слов в тексте.
   */
  function wordCount(text) {
    var t = String(text || '').trim();
    if (!t) return 0;
    return t.split(/\s+/).length;
  }

  /* ── Pipelines ──────────────────────────────────────────── */

  /**
   * /cut_fillers — убрать слова-паразиты (без LLM).
   *
   * ЛОГИКА (v2):
   * 1. Короткие сегменты (≤4 слова, ≤maxDur): весь текст = филлер → вырезать
   * 2. Длинные сегменты: ищем филлер-слова в начале/конце текста.
   *    Если Whisper склеил «Ну... и вот мы приехали» — вырезаем «Ну...» по
   *    приблизительной пропорции длительности от числа слов.
   *
   * Параметры: sensitivity ('strict' | 'normal').
   */
  async function cutFillers(ctx, params) {
    params = params || {};
    var entry = ctx.transcriptEntry;
    if (!entry || !entry.segments || !entry.segments.length) {
      return { ok: false, error: 'Нет транскрипта. Нажмите «Транскрибировать In–Out».' };
    }

    var sensitivity = params.sensitivity || 'strict';
    var expanded = sensitivity === 'normal' || sensitivity === 'expanded';
    var maxDur = expanded ? MAX_FILLER_DURATION_NORMAL : MAX_FILLER_DURATION;

    var segments = entry.segments;
    var removeIntervals = [];

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var text = String(seg.text || '').trim();
      if (!text) continue;

      var startSec = typeof seg.startSec === 'number' ? seg.startSec : seg.start;
      var endSec = typeof seg.endSec === 'number' ? seg.endSec : seg.end;
      if (typeof startSec !== 'number' || typeof endSec !== 'number') continue;

      var segDuration = endSec - startSec;
      if (segDuration <= 0.01) continue;

      var wc = wordCount(text);

      /* === Путь A: весь сегмент — чистый филлер (короткий, ≤4 слова) === */
      if (segDuration <= maxDur && wc <= 4) {
        var filler = isWholeFiller(text, expanded);
        if (filler) {
          var padStart = Math.min(FILLER_PADDING, segDuration * 0.15);
          var padEnd = Math.min(FILLER_PADDING, segDuration * 0.15);
          var cutStart = startSec + padStart;
          var cutEnd = endSec - padEnd;
          if (cutEnd > cutStart + 0.02) {
            removeIntervals.push({
              startSec: cutStart,
              endSec: cutEnd,
              reason: 'паразит: «' + text.slice(0, 30) + '»'
            });
          }
          continue;
        }
      }

      /* === Путь B: филлер в начале/конце длинного сегмента === */
      if (wc < 2) continue; /* одно слово, но не филлер — пропустить */

      var words = text.split(/\s+/);
      var secPerWord = segDuration / Math.max(words.length, 1);

      /* Проверяем первые 1-2 слова */
      for (var fw = 1; fw <= Math.min(2, words.length - 1); fw++) {
        var frontText = words.slice(0, fw).join(' ');
        if (isWholeFiller(frontText, expanded)) {
          var frontDur = secPerWord * fw;
          if (frontDur > 0.08 && frontDur <= maxDur) {
            var fCutEnd = startSec + frontDur;
            removeIntervals.push({
              startSec: startSec,
              endSec: fCutEnd,
              reason: 'паразит в начале: «' + frontText + '»'
            });
          }
          break; /* не проверять 2 слова если 1 совпало */
        }
      }

      /* Проверяем последние 1-2 слова */
      for (var lw = 1; lw <= Math.min(2, words.length - 1); lw++) {
        var tailText = words.slice(words.length - lw).join(' ');
        if (isWholeFiller(tailText, expanded)) {
          var tailDur = secPerWord * lw;
          if (tailDur > 0.08 && tailDur <= maxDur) {
            var tCutStart = endSec - tailDur;
            removeIntervals.push({
              startSec: tCutStart,
              endSec: endSec,
              reason: 'паразит в конце: «' + tailText + '»'
            });
          }
          break;
        }
      }
    }

    if (removeIntervals.length === 0) {
      var modeLabel = expanded ? 'расширенном' : 'строгом';
      return {
        ok: true,
        summary: 'Слова-паразиты не обнаружены (в ' + modeLabel + ' режиме, ' +
          segments.length + ' сегментов проверено).',
        noChanges: true
      };
    }

    /* Merge overlapping/adjacent intervals */
    removeIntervals = _mergeIntervals(removeIntervals);

    var totalRemoveSec = 0;
    removeIntervals.forEach(function (iv) { totalRemoveSec += iv.endSec - iv.startSec; });

    var modeNote = expanded
      ? ' (расширенный: ну, вот, типа, значит, как бы, короче…)'
      : ' (строгий: э, мм, ну, блин)';

    return {
      ok: true,
      proposal: {
        kind: 'transcript_cuts',
        removeIntervals: removeIntervals,
        summary: 'Найдено ' + removeIntervals.length + ' паразитов (' +
          totalRemoveSec.toFixed(1) + 'с)' + modeNote + '. Вырезать?',
        removeSummary: removeIntervals.map(function (iv) {
          return { startSec: iv.startSec, endSec: iv.endSec, reason: iv.reason };
        })
      }
    };
  }

  /**
   * /cut_silences — убрать длинные паузы (без LLM).
   * Параметры: minDuration (сек), padding (сек).
   *
   * Гибридный подход:
   *   1. Gaps между сегментами транскрипта ≥ minDuration → тишина
   *   2. ffmpeg silencedetect → дополнительные тишины
   * Результаты мержатся, перекрытия объединяются.
   */
  async function cutSilences(ctx, params) {
    params = params || {};
    var entry = ctx.transcriptEntry;
    if (!entry) {
      return { ok: false, error: 'Нет транскрипта.' };
    }

    var minDuration = typeof params.minDuration === 'number' ? params.minDuration : 1.0;
    var padding = typeof params.padding === 'number' ? params.padding : 0.15;

    var thresholdUsed = (entry.audioAnalysis && typeof entry.audioAnalysis.silenceThresholdUsed === 'number')
      ? entry.audioAnalysis.silenceThresholdUsed : -30;
    var threshLabel = thresholdUsed + ' dB';

    var removeIntervals = [];
    var segs = entry.segments || [];

    /* Источник 1: Gaps между сегментами транскрипта.
       Whisper знает, где заканчивается речь → gap = реальная пауза. */
    for (var gi = 1; gi < segs.length; gi++) {
      var prevEnd = typeof segs[gi - 1].endSec === 'number' ? segs[gi - 1].endSec :
                    (typeof segs[gi - 1].end === 'number' ? segs[gi - 1].end : NaN);
      var nextStart = typeof segs[gi].startSec === 'number' ? segs[gi].startSec :
                      (typeof segs[gi].start === 'number' ? segs[gi].start : NaN);
      if (isNaN(prevEnd) || isNaN(nextStart)) continue;
      var gap = nextStart - prevEnd;
      if (gap >= minDuration) {
        var gs = prevEnd + padding;
        var ge = nextStart - padding;
        if (ge > gs + 0.05) {
          removeIntervals.push({
            startSec: gs,
            endSec: ge,
            reason: 'пауза между фразами ' + gap.toFixed(1) + 'с'
          });
        }
      }
    }

    /* Источник 2: ffmpeg silencedetect */
    var silences = (entry.audioAnalysis && entry.audioAnalysis.silences) || [];
    for (var i = 0; i < silences.length; i++) {
      var sil = silences[i];
      var silStart = typeof sil.startSec === 'number' ? sil.startSec : (typeof sil.start === 'number' ? sil.start : NaN);
      var silEnd = typeof sil.endSec === 'number' ? sil.endSec : (typeof sil.end === 'number' ? sil.end : NaN);
      if (isNaN(silStart) || isNaN(silEnd)) continue;
      var dur = silEnd - silStart;
      if (dur < minDuration) continue;

      var start = silStart + padding;
      var end = silEnd - padding;
      if (end <= start + 0.05) continue;

      removeIntervals.push({
        startSec: start,
        endSec: end,
        reason: 'тишина ' + dur.toFixed(1) + 'с (уровень < ' + threshLabel + ')'
      });
    }

    /* Мержим перекрытия */
    removeIntervals = _mergeIntervals(removeIntervals);

    if (removeIntervals.length === 0) {
      var maxSilDur = 0;
      for (var si = 0; si < silences.length; si++) {
        var sd = (silences[si].endSec || silences[si].end || 0) - (silences[si].startSec || silences[si].start || 0);
        if (sd > maxSilDur) maxSilDur = sd;
      }
      var maxGap = 0;
      for (var gj = 1; gj < segs.length; gj++) {
        var pgE = segs[gj - 1].endSec || segs[gj - 1].end || 0;
        var ngS = segs[gj].startSec || segs[gj].start || 0;
        var g = ngS - pgE;
        if (g > maxGap) maxGap = g;
      }
      return {
        ok: true,
        summary: 'Длинных пауз (>' + minDuration + 'с) не обнаружено. ' +
          'Всего тишин в аудио: ' + silences.length +
          (maxSilDur > 0 ? ' (макс. ' + maxSilDur.toFixed(1) + 'с)' : '') +
          '. Попробуйте снизить «Мин. длительность». Порог: ' + threshLabel + '.',
        noChanges: true
      };
    }

    removeIntervals = _mergeIntervals(removeIntervals);

    var totalRemoveSec = 0;
    removeIntervals.forEach(function (iv) { totalRemoveSec += iv.endSec - iv.startSec; });

    return {
      ok: true,
      proposal: {
        kind: 'transcript_cuts',
        removeIntervals: removeIntervals,
        summary: 'Найдено ' + removeIntervals.length + ' пауз (>' + minDuration + 'с, суммарно ' +
          totalRemoveSec.toFixed(1) + 'с). Порог: ' + threshLabel + '. Вырезать?',
        removeSummary: removeIntervals.map(function (iv) {
          return { startSec: iv.startSec, endSec: iv.endSec, reason: iv.reason };
        })
      }
    };
  }

  /**
   * /chapterize — расставить маркеры-главы (1 LLM-вызов через topics).
   * Если topics уже есть в кэше — 0 LLM-вызовов.
   */
  async function chapterize(ctx) {
    var entry = ctx.transcriptEntry;
    if (!entry || !entry.segments || !entry.segments.length) {
      return { ok: false, error: 'Нет транскрипта.' };
    }

    /* Ensure paragraphs exist before building topics */
    if ((!entry.paragraphs || !entry.paragraphs.length) && typeof TranscriptStructure !== 'undefined') {
      try {
        var silences = (entry.audioAnalysis && entry.audioAnalysis.silences) || [];
        entry.paragraphs = TranscriptStructure.buildParagraphs(entry.segments, silences);
      } catch (e) { /* fallback: buildTopicsWithLLM will work with raw segments */ }
    }

    var topics = entry.topics;
    if (!topics || !topics.length) {
      /* Need 1 LLM call for topics */
      if (typeof TranscriptStructure !== 'undefined' && typeof TranscriptStructure.buildTopicsWithLLM === 'function') {
        if (ctx.onStatus) ctx.onStatus('Определяю темы через LLM…');

        /* Подготовить paragraphs для buildTopicsWithLLM */
        var paragraphs = entry.paragraphs;
        if (!paragraphs || !paragraphs.length) {
          /* Если paragraphs не удалось построить — делаем из сегментов напрямую */
          paragraphs = _segmentsToParagraphs(entry.segments);
        }

        try {
          topics = await TranscriptStructure.buildTopicsWithLLM(paragraphs, {
            settings: ctx.settings,
            CloudRuClient: typeof CloudRuClient !== 'undefined' ? CloudRuClient : undefined
          });
          if (topics && topics.length) {
            entry.topics = topics;
          }
        } catch (e) {
          return { ok: false, error: 'Не удалось определить темы: ' + String(e.message || e) };
        }
      }
    }

    if (!topics || !topics.length) {
      /* Fallback: time-based chapters every ~60s */
      var totalDur = _getEntryDuration(entry);
      if (totalDur > 30) {
        topics = _timeBasedChapters(entry.segments, totalDur);
        if (topics.length) {
          entry.topics = topics;
        }
      }
    }

    if (!topics || !topics.length) {
      return { ok: false, error: 'Не удалось определить темы видео. Возможно, транскрипт слишком короткий или API недоступен. Попробуйте через чат: «Поставь маркеры на главы».' };
    }

    /* Convert topics to markers */
    var markers = topics.map(function (t) {
      return {
        timeSec: t.startSec,
        endSec: t.endSec || undefined,
        name: String(t.title || '').slice(0, 40),
        type: 'chapter',
        comment: t.summary || ''
      };
    });

    /* Filter: remove markers too close together (<15s) */
    var filtered = [markers[0]];
    for (var i = 1; i < markers.length; i++) {
      if (markers[i].timeSec - filtered[filtered.length - 1].timeSec >= 15) {
        filtered.push(markers[i]);
      }
    }

    return {
      ok: true,
      proposal: {
        kind: 'markers',
        markers: filtered,
        summary: 'Автоматические главы (' + filtered.length + '): по темам из транскрипта.'
      }
    };
  }

  /**
   * /jump_cuts — создать jump cuts по паузам (без LLM).
   * Убирает паузы от maxPause.
   *
   * Двойной источник пауз:
   *   1. Gaps между сегментами транскрипта (надёжный — Whisper знает, где речь)
   *   2. ffmpeg silencedetect (дополнительно — ловит тихие паузы внутри сегментов)
   * Результаты объединяются и мержатся.
   */
  async function jumpCuts(ctx, params) {
    params = params || {};
    var entry = ctx.transcriptEntry;
    if (!entry || !entry.segments || !entry.segments.length) {
      return { ok: false, error: 'Нет транскрипта.' };
    }

    var maxPause = typeof params.maxPause === 'number' ? params.maxPause : 0.5;
    var padding = 0.08;

    var removeIntervals = [];

    /* Источник 1: Gaps между сегментами транскрипта.
       Это самый надёжный способ: Whisper чётко знает, где заканчивается и начинается речь. */
    var segs = entry.segments;
    for (var gi = 1; gi < segs.length; gi++) {
      var prevEnd = typeof segs[gi - 1].endSec === 'number' ? segs[gi - 1].endSec :
                    (typeof segs[gi - 1].end === 'number' ? segs[gi - 1].end : NaN);
      var nextStart = typeof segs[gi].startSec === 'number' ? segs[gi].startSec :
                      (typeof segs[gi].start === 'number' ? segs[gi].start : NaN);
      if (isNaN(prevEnd) || isNaN(nextStart)) continue;
      var gap = nextStart - prevEnd;
      if (gap >= maxPause) {
        var s = prevEnd + padding;
        var e = nextStart - padding;
        if (e > s + 0.02) {
          removeIntervals.push({
            startSec: s,
            endSec: e,
            reason: 'пауза между фразами ' + gap.toFixed(2) + 'с'
          });
        }
      }
    }

    /* Источник 2: ffmpeg silencedetect (дополнительные тишины) */
    var silences = (entry.audioAnalysis && entry.audioAnalysis.silences) || [];
    for (var si = 0; si < silences.length; si++) {
      var sil = silences[si];
      var silStart = typeof sil.startSec === 'number' ? sil.startSec : (typeof sil.start === 'number' ? sil.start : NaN);
      var silEnd = typeof sil.endSec === 'number' ? sil.endSec : (typeof sil.end === 'number' ? sil.end : NaN);
      if (isNaN(silStart) || isNaN(silEnd)) continue;
      var silDur = silEnd - silStart;
      if (silDur >= maxPause) {
        var ss = silStart + padding;
        var se = silEnd - padding;
        if (se > ss + 0.02) {
          removeIntervals.push({
            startSec: ss,
            endSec: se,
            reason: 'тишина (аудио) ' + silDur.toFixed(2) + 'с'
          });
        }
      }
    }

    if (removeIntervals.length === 0) {
      return {
        ok: true,
        summary: 'Пауз длиннее ' + maxPause + 'с не найдено (сегментов: ' + segs.length +
          ', тишин в аудио: ' + silences.length + ').',
        noChanges: true
      };
    }

    removeIntervals = _mergeIntervals(removeIntervals);

    var totalRemoveSec = 0;
    removeIntervals.forEach(function (iv) { totalRemoveSec += iv.endSec - iv.startSec; });

    return {
      ok: true,
      proposal: {
        kind: 'transcript_cuts',
        removeIntervals: removeIntervals,
        summary: 'Jump cuts: ' + removeIntervals.length + ' пауз (>' + maxPause + 'с, суммарно ' +
          totalRemoveSec.toFixed(1) + 'с). Вырезать?',
        removeSummary: removeIntervals.map(function (iv) {
          return { startSec: iv.startSec, endSec: iv.endSec, reason: iv.reason };
        })
      }
    };
  }

  /* ── Helpers ──────────────────────────────────────────────── */

  /**
   * Fallback paragraphs из сегментов (для chapterize, когда buildParagraphs не сработал).
   */
  function _segmentsToParagraphs(segments) {
    var result = [];
    var curPar = null;
    var MAX_PAR_SEC = 30;

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var startSec = typeof seg.startSec === 'number' ? seg.startSec : seg.start;
      var endSec = typeof seg.endSec === 'number' ? seg.endSec : seg.end;
      var text = String(seg.text || '').trim();
      if (typeof startSec !== 'number' || typeof endSec !== 'number') continue;

      if (!curPar || (startSec - curPar.endSec > 0.8) || (endSec - curPar.startSec > MAX_PAR_SEC)) {
        if (curPar) result.push(curPar);
        curPar = { startSec: startSec, endSec: endSec, text: text };
      } else {
        curPar.endSec = endSec;
        curPar.text += ' ' + text;
      }
    }
    if (curPar) result.push(curPar);
    return result;
  }

  /**
   * Получить длительность транскрипта (по сегментам).
   */
  function _getEntryDuration(entry) {
    if (!entry || !entry.segments || !entry.segments.length) return 0;
    var segs = entry.segments;
    var last = segs[segs.length - 1];
    return (typeof last.endSec === 'number' ? last.endSec : last.end) || 0;
  }

  /**
   * Fallback: time-based chapters (когда LLM не вернул темы).
   * Равномерные главы каждые ~45-60с, с привязкой к ближайшему началу сегмента.
   */
  function _timeBasedChapters(segments, totalDur) {
    var chapterInterval = totalDur <= 120 ? 30 : totalDur <= 300 ? 45 : 60;
    var numChapters = Math.max(2, Math.min(12, Math.floor(totalDur / chapterInterval)));
    var step = totalDur / numChapters;
    var chapters = [];

    for (var c = 0; c < numChapters; c++) {
      var targetTime = c * step;
      /* Привязка к ближайшему началу сегмента */
      var bestSeg = null;
      var bestDist = Infinity;
      for (var si = 0; si < segments.length; si++) {
        var segStart = typeof segments[si].startSec === 'number' ? segments[si].startSec : segments[si].start;
        if (typeof segStart !== 'number') continue;
        var dist = Math.abs(segStart - targetTime);
        if (dist < bestDist) {
          bestDist = dist;
          bestSeg = segments[si];
        }
      }
      var snapTime = bestSeg
        ? (typeof bestSeg.startSec === 'number' ? bestSeg.startSec : bestSeg.start)
        : targetTime;

      var nextTime = (c + 1 < numChapters) ? (c + 1) * step : totalDur;
      var previewText = _getTextInRange(segments, snapTime, snapTime + 10).slice(0, 40);

      chapters.push({
        startSec: snapTime,
        endSec: nextTime,
        title: c === 0 ? 'Вступление' : 'Часть ' + (c + 1),
        summary: previewText || ''
      });
    }
    return chapters;
  }

  /**
   * Собрать текст из сегментов в заданном временном диапазоне.
   */
  function _getTextInRange(segments, fromSec, toSec) {
    var parts = [];
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var s = typeof seg.startSec === 'number' ? seg.startSec : seg.start;
      if (typeof s !== 'number') continue;
      if (s >= fromSec && s < toSec) {
        parts.push(String(seg.text || '').trim());
      }
    }
    return parts.join(' ');
  }

  /**
   * Fallback: вычислить тишины из зазоров между Whisper-сегментами.
   * Менее точный чем ffmpeg silencedetect, оставлен для обратной совместимости.
   * НЕ используется в pipelines — только как экспортируемый хелпер.
   */
  function _silencesFromSegmentGaps(segments, minGap) {
    var result = [];
    for (var i = 1; i < segments.length; i++) {
      var prev = segments[i - 1];
      var cur = segments[i];
      var prevEnd = typeof prev.endSec === 'number' ? prev.endSec : prev.end;
      var curStart = typeof cur.startSec === 'number' ? cur.startSec : cur.start;
      if (typeof prevEnd !== 'number' || typeof curStart !== 'number') continue;

      var gap = curStart - prevEnd;
      if (gap >= minGap) {
        result.push({ startSec: prevEnd, endSec: curStart });
      }
    }
    return result;
  }

  function _mergeIntervals(intervals) {
    if (!intervals.length) return intervals;
    intervals.sort(function (a, b) { return a.startSec - b.startSec; });
    var merged = [intervals[0]];
    for (var i = 1; i < intervals.length; i++) {
      var last = merged[merged.length - 1];
      if (intervals[i].startSec <= last.endSec + 0.05) {
        last.endSec = Math.max(last.endSec, intervals[i].endSec);
        if (intervals[i].reason && last.reason.indexOf(intervals[i].reason) === -1) {
          last.reason += '; ' + intervals[i].reason;
        }
      } else {
        merged.push({
          startSec: intervals[i].startSec,
          endSec: intervals[i].endSec,
          reason: intervals[i].reason || ''
        });
      }
    }
    return merged;
  }

  /**
   * /j_cuts — ОТКЛЮЧЕНО.
   *
   * J/L-cuts невозможны на связанных клипах одной дорожки (V1+A1).
   * При обрезке видео-части связанного клипа Premiere Pro обрезает и аудио.
   * Для J/L-cuts нужны клипы на V1/A1 + V2/A2 с перекрытием, либо
   * отвязанные (unlinked) клипы. ExtendScript не поддерживает unlink().
   */
  async function jCuts(ctx, params) {
    return {
      ok: false,
      error: 'J/L-cuts временно отключены. ' +
        'В Premiere Pro связанные клипы (V1+A1) обрезаются вместе — видео и аудио. ' +
        'J/L-cuts требуют клипы на отдельных дорожках (V1/A1 + V2/A2) с перекрытием, ' +
        'либо отвязанные клипы. ExtendScript API не поддерживает программное ' +
        'отвязывание (unlink). Выполните J/L-cuts вручную.'
    };
  }

  /**
   * parsePipelineCommand — разбирает текст на pipeline-команду.
   * Возвращает {pipeline, params} или null если не pipeline.
   *
   * Поддерживаемые форматы:
   *   /cut_fillers
   *   /cut_silences [minDuration=1.5] [padding=0.2]
   *   /chapterize
   *   /jump_cuts [maxPause=0.5]
   *   /j_cuts [offsetFrames=6]
   *   /l_cuts [offsetFrames=6]
   */
  function parsePipelineCommand(text) {
    if (!text || typeof text !== 'string') return null;
    var t = text.trim();
    if (t[0] !== '/') return null;

    var parts = t.split(/\s+/);
    var cmd = parts[0].toLowerCase();
    var params = {};

    for (var i = 1; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv.length === 2) {
        var num = parseFloat(kv[1]);
        params[kv[0]] = isNaN(num) ? kv[1] : num;
      }
    }

    var PIPELINES = {
      '/cut_fillers': cutFillers,
      '/cut_silences': cutSilences,
      '/chapterize': chapterize,
      '/jump_cuts': jumpCuts,
      '/j_cuts': jCuts,
      '/l_cuts': jCuts
    };

    if (cmd === '/l_cuts') {
      params.mode = params.mode || 'l';
    }

    if (PIPELINES[cmd]) {
      return { pipeline: PIPELINES[cmd], params: params, name: cmd };
    }
    return null;
  }

  global.DeterministicPipelines = {
    cutFillers: cutFillers,
    cutSilences: cutSilences,
    chapterize: chapterize,
    jumpCuts: jumpCuts,
    jCuts: jCuts,
    parsePipelineCommand: parsePipelineCommand,
    _mergeIntervals: _mergeIntervals,
    _silencesFromSegmentGaps: _silencesFromSegmentGaps
  };
})(window);
