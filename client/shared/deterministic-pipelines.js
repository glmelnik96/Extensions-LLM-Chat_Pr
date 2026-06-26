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

    /* Merge overlapping/adjacent intervals */
    removeIntervals = _mergeIntervals(removeIntervals);

    /* Фильтр микро-зазоров: интервалы < 0.15с оставляют 2-3 кадра мусора после razor */
    var MIN_CUT = 0.15;
    removeIntervals = removeIntervals.filter(function (iv) {
      return (iv.endSec - iv.startSec) >= MIN_CUT;
    });

    if (removeIntervals.length === 0) {
      var modeLabel = expanded ? 'расширенном' : 'строгом';
      return {
        ok: true,
        summary: 'Слова-паразиты не обнаружены (в ' + modeLabel + ' режиме, ' +
          segments.length + ' сегментов проверено).',
        noChanges: true
      };
    }

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
   * detectSilenceIntervals — унифицированный детектор тишин для cutSilences/jumpCuts.
   *
   * @param {Object} entry — transcript entry с опциональным audioAnalysis
   * @param {Object} opts:
   *   - minDuration (сек, default 1.0): мин. длительность чтобы считать тишиной
   *   - padding (сек, default 0.15): отступ внутри тишины (не режем край)
   *   - thresholdDb (dB, default null): порог громкости для ffmpeg-тишин.
   *     Если null — используем silenceThresholdUsed из entry.audioAnalysis.
   *     Если задан И строже (меньше) чем thresholdUsed — ffmpeg-тишины отфильтровываются
   *     (они обнаружены при менее строгом пороге, могут содержать слышимый звук).
   *   - source (default 'gaps+ffmpeg'): 'gaps' | 'ffmpeg' | 'gaps+ffmpeg'
   * @returns {Array<{startSec, endSec, reason}>}
   */
  function detectSilenceIntervals(entry, opts) {
    opts = opts || {};
    var minDuration = typeof opts.minDuration === 'number' ? opts.minDuration : 1.0;
    var padding = typeof opts.padding === 'number' ? opts.padding : 0.15;
    var source = opts.source || 'gaps+ffmpeg';

    var segs = (entry && entry.segments) || [];
    var audio = (entry && entry.audioAnalysis) || null;
    var thresholdUsed = (audio && typeof audio.silenceThresholdUsed === 'number') ? audio.silenceThresholdUsed : -30;
    var effectiveThreshold = typeof opts.thresholdDb === 'number' ? opts.thresholdDb : thresholdUsed;
    var includeFFmpeg = (source !== 'gaps') && (effectiveThreshold >= thresholdUsed);

    var intervals = [];

    /* Источник 1: gaps между Whisper-сегментами (Whisper знает границы речи). */
    if (source === 'gaps' || source === 'gaps+ffmpeg') {
      for (var gi = 1; gi < segs.length; gi++) {
        var prevEnd = typeof segs[gi - 1].endSec === 'number' ? segs[gi - 1].endSec :
                      (typeof segs[gi - 1].end === 'number' ? segs[gi - 1].end : NaN);
        var nextStart = typeof segs[gi].startSec === 'number' ? segs[gi].startSec :
                        (typeof segs[gi].start === 'number' ? segs[gi].start : NaN);
        if (isNaN(prevEnd) || isNaN(nextStart)) continue;
        var gap = nextStart - prevEnd;
        if (gap < minDuration) continue;
        var gs = prevEnd + padding;
        var ge = nextStart - padding;
        if (ge > gs + 0.02) {
          intervals.push({
            startSec: gs,
            endSec: ge,
            reason: 'пауза между фразами ' + gap.toFixed(2) + 'с'
          });
        }
      }
    }

    /* Источник 2: ffmpeg silencedetect (ловит тишину внутри сегментов). */
    if (includeFFmpeg) {
      var silences = (audio && audio.silences) || [];
      var threshLabel = effectiveThreshold + ' dB';
      for (var i = 0; i < silences.length; i++) {
        var sil = silences[i];
        var silStart = typeof sil.startSec === 'number' ? sil.startSec : (typeof sil.start === 'number' ? sil.start : NaN);
        var silEnd = typeof sil.endSec === 'number' ? sil.endSec : (typeof sil.end === 'number' ? sil.end : NaN);
        if (isNaN(silStart) || isNaN(silEnd)) continue;
        var dur = silEnd - silStart;
        if (dur < minDuration) continue;
        var ss = silStart + padding;
        var se = silEnd - padding;
        if (se <= ss + 0.02) continue;
        intervals.push({
          startSec: ss,
          endSec: se,
          reason: 'тишина ' + dur.toFixed(2) + 'с (уровень < ' + threshLabel + ')'
        });
      }
    }

    return intervals;
  }

  /**
   * silenceIntervalsFromRms — детекция тишин ИЗ RMS-таймлайна, полностью
   * client-side (без ffmpeg). Enabler интерактивного waveform-превью: один проход
   * ffmpeg (astats) даёт rmsTimeline, дальше всё фильтруется мгновенно в браузере.
   *
   * ПОРОГ — относительный (по умолчанию): «тишина» = на marginDb тише, чем громкий
   * уровень речи в ЭТОМ регионе (P92 RMS). Абсолютные dB не работают: уровень записи
   * варьируется (камерные мики -50dB vs студийные -20dB), а inputI (EBU R128 LUFS)
   * не совпадает по шкале с astats RMS (dBFS) — отсюда баг «вырезал речь как тишину».
   * Если передан thresholdDb — используется абсолютный порог (для явных вызовов/тестов).
   *
   * @param {Array<{t:number, rms:number}>} rmsTimeline — sequence-time
   * @param {object} opts
   *   - marginDb (default 22): насколько тише речи = тишина (относительный порог)
   *   - thresholdDb: абсолютный порог dB (переопределяет marginDb)
   *   - minDuration (default 1.0): мин. длительность паузы (сек) — микропаузы между
   *     словами короче этого ОТСЕИВАЮТСЯ (защита речи)
   *   - padding (default 0.15): отступ внутрь от краёв
   * @returns {Array<{startSec, endSec, reason}>}
   */
  /**
   * rmsThresholdInfo — вычисляет порог тишины (dB) для RMS-таймлайна. ОБЩИЙ
   * источник истины для детекции (silenceIntervalsFromRms) и для линии порога на
   * waveform-превью — чтобы линия совпадала с реальным срезом.
   * @returns {{thresholdDb:number, speechRefDb:number|null}|null}
   */
  function rmsThresholdInfo(rmsTimeline, opts) {
    opts = opts || {};
    var tl = Array.isArray(rmsTimeline) ? rmsTimeline : [];
    if (typeof opts.thresholdDb === 'number') {
      return { thresholdDb: opts.thresholdDb, speechRefDb: null };
    }
    var margin = typeof opts.marginDb === 'number' ? opts.marginDb : 22;
    var vals = [];
    for (var v = 0; v < tl.length; v++) { var rr = tl[v].rms; if (typeof rr === 'number' && isFinite(rr)) vals.push(rr); }
    if (!vals.length) return null;
    vals.sort(function (a, b) { return a - b; });
    var speechRef = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.92))];
    return { thresholdDb: speechRef - margin, speechRefDb: speechRef };
  }

  function silenceIntervalsFromRms(rmsTimeline, opts) {
    opts = opts || {};
    var minDuration = typeof opts.minDuration === 'number' ? opts.minDuration : 1.0;
    var padding = typeof opts.padding === 'number' ? opts.padding : 0.15;
    var tl = Array.isArray(rmsTimeline) ? rmsTimeline : [];
    if (tl.length < 2) return [];

    var dts = [];
    for (var i = 1; i < tl.length; i++) {
      var d = tl[i].t - tl[i - 1].t;
      if (d > 0 && isFinite(d)) dts.push(d);
    }
    if (!dts.length) return [];
    dts.sort(function (a, b) { return a - b; });
    var frameDur = dts[Math.floor(dts.length / 2)] || 0.05;

    /* Порог: абсолютный (thresholdDb) ИЛИ относительный от уровня речи региона. */
    var thInfo = rmsThresholdInfo(tl, opts);
    if (thInfo == null) return [];
    var thr = thInfo.thresholdDb;
    var relInfo = thInfo.speechRefDb != null ? (', речь≈' + Math.round(thInfo.speechRefDb) + ' dB') : '';

    function isSilent(p) {
      var r = p && p.rms;
      return r == null || !isFinite(r) || r < thr;
    }

    /* Склейка тихих сэмплов в runs. Допуск < frameDur — чтобы ОДИН речевой сэмпл
       МЕЖДУ тишинами РАЗРЫВАЛ run (раньше frameDur*1.5 перепрыгивал речь и сливал
       все микропаузы в одну «тишину на весь клип» — баг «удалил весь клип речи»). */
    var BRIDGE = frameDur * 0.5;
    var runs = [];
    var cur = null;
    for (var k = 0; k < tl.length; k++) {
      var p = tl[k];
      if (typeof p.t !== 'number' || !isFinite(p.t)) continue;
      if (!isSilent(p)) continue;
      var segStart = p.t;
      var segEnd = p.t + frameDur;
      if (cur && segStart - cur.e <= BRIDGE) {
        cur.e = Math.max(cur.e, segEnd);
      } else {
        if (cur) runs.push(cur);
        cur = { s: segStart, e: segEnd };
      }
    }
    if (cur) runs.push(cur);

    /* minDuration-фильтр (микропаузы между словами отсеиваются) + padding-сжатие. */
    var out = [];
    for (var j = 0; j < runs.length; j++) {
      var dur = runs[j].e - runs[j].s;
      if (dur < minDuration) continue;
      var ss = runs[j].s + padding;
      var se = runs[j].e - padding;
      if (se - ss < 0.02) continue;
      out.push({
        startSec: Math.round(ss * 1000) / 1000,
        endSec: Math.round(se * 1000) / 1000,
        reason: 'тишина ' + dur.toFixed(2) + 'с (порог ' + Math.round(thr) + ' dB' + relInfo + ')'
      });
    }
    return out;
  }

  /**
   * /cut_silences — гигиена: убрать явные длинные паузы (≥1с).
   * Параметры: minDuration (сек), padding (сек), silenceThresholdDelta (dB).
   *
   * Использует detectSilenceIntervals с source='gaps+ffmpeg'.
   * Сохраняет естественный ритм речи.
   */
  async function cutSilences(ctx, params) {
    params = params || {};
    var entry = ctx.transcriptEntry;
    /* Phase 1.6 (6 мая 2026): cutSilences НЕ требует транскрипта — работает по
       audioAnalysis.silences (ffmpeg silencedetect). Раньше gate отвергал любой
       `!entry`, что заставляло транскрибировать ради silence removal — это в 20×
       медленнее (Whisper 10 мин на 1ч vs ffmpeg 30 сек). Match AutoPod/FireCut UX. */
    if (!entry || (!entry.audioAnalysis && (!entry.segments || !entry.segments.length))) {
      return { ok: false, error: 'Нет данных. Запустите «Анализ аудио» или «Транскрибировать In-Out».' };
    }

    var minDuration = typeof params.minDuration === 'number' ? params.minDuration : 1.0;
    var padding = typeof params.padding === 'number' ? params.padding : 0.15;

    var thresholdUsed = (entry.audioAnalysis && typeof entry.audioAnalysis.silenceThresholdUsed === 'number')
      ? entry.audioAnalysis.silenceThresholdUsed : -30;

    /* silenceThresholdDelta (ползунок «Тише речи на N dB») — ОТНОСИТЕЛЬНЫЙ запас:
       тишина = на N dB тише уровня речи региона. Раньше считался как inputI - N
       (абсолютный порог), но inputI (LUFS) ≠ astats RMS (dBFS) → порог попадал в
       середину речи и резал её. Теперь N передаётся как marginDb в
       silenceIntervalsFromRms, который сам берёт уровень речи из сигнала. */
    var userDelta = typeof params.silenceThresholdDelta === 'number' ? params.silenceThresholdDelta : 0;
    var inputI = (entry.audioAnalysis && typeof entry.audioAnalysis.inputI === 'number')
      ? entry.audioAnalysis.inputI : -24;
    var effectiveThreshold = userDelta > 0 ? Math.floor(inputI - userDelta) : thresholdUsed;
    var threshLabel = effectiveThreshold + ' dB';

    /* preview==apply: если есть RMS-таймлайн (после «Анализ аудио»), детекция тишин
       идёт через silenceIntervalsFromRms — ТУ ЖЕ функцию, что waveform-превью
       «Инструментов» фильтрует на лету при движении ползунков. Fallback на
       detectSilenceIntervals (gaps+ffmpeg) — когда RMS не считался. */
    var rmsTl = entry.audioAnalysis && entry.audioAnalysis.rmsTimeline;
    var removeIntervals;
    if (Array.isArray(rmsTl) && rmsTl.length > 1) {
      removeIntervals = silenceIntervalsFromRms(rmsTl, {
        marginDb: userDelta > 0 ? userDelta : 22,  /* относительный порог от уровня речи */
        minDuration: minDuration,
        padding: padding
      });
    } else {
      removeIntervals = detectSilenceIntervals(entry, {
        minDuration: minDuration,
        padding: padding,
        thresholdDb: effectiveThreshold,
        source: 'gaps+ffmpeg'
      });
    }

    var silences = (entry.audioAnalysis && entry.audioAnalysis.silences) || [];
    var segs = entry.segments || [];

    /* Мержим перекрытия */
    removeIntervals = _mergeIntervals(removeIntervals);

    /* Фильтр микро-зазоров: интервалы < 0.15с оставляют 2-3 кадра мусора после razor */
    var MIN_CUT = 0.15;
    removeIntervals = removeIntervals.filter(function (iv) {
      return (iv.endSec - iv.startSec) >= MIN_CUT;
    });

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
  async function chapterize(ctx, params) {
    params = params || {};
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

    /* US-005: валидация «бойлерплейт» имён и замена на реальный текст.
       Имена вида «Часть N», «Part N», «Продолжение», «Следующая часть» — мусор. */
    var boilerplateRe = /^(часть|part)\s*\d+$|^продолжение$|^следующ.+\s*часть$/i;
    var paragraphsForNames = entry.paragraphs || _segmentsToParagraphs(entry.segments);

    /* Convert topics to markers */
    var markers = topics.map(function (t) {
      var title = String(t.title || '').trim();
      if (!title || boilerplateRe.test(title)) {
        title = _firstWordsForChapter(paragraphsForNames, entry.segments, t.startSec, t.endSec);
      }
      return {
        timeSec: t.startSec,
        endSec: t.endSec || undefined,
        name: title.slice(0, 40),
        type: 'chapter',
        comment: t.summary || ''
      };
    });

    /* US-005: адаптивный минимальный интервал между главами.
       <3min=10s, 3-10min=20s, >10min=45s (вместо жёстких 15с) */
    var totalDurForSpacing = _getEntryDuration(entry);
    var minChapterInterval = _adaptiveChapterMinInterval(totalDurForSpacing);

    /* Filter: remove markers too close together */
    var filtered = [markers[0]];
    for (var i = 1; i < markers.length; i++) {
      if (markers[i].timeSec - filtered[filtered.length - 1].timeSec >= minChapterInterval) {
        filtered.push(markers[i]);
      }
    }

    /* maxChapters: ограничить количество глав (равномерно выбираем из имеющихся) */
    var maxChapters = typeof params.maxChapters === 'number' ? params.maxChapters : 0;
    if (maxChapters > 0 && filtered.length > maxChapters) {
      /* Всегда сохраняем первый (Вступление) и последний маркер.
         Из оставшихся равномерно выбираем нужное количество. */
      var reduced = [filtered[0]];
      var inner = filtered.slice(1, filtered.length - 1);
      var need = maxChapters - 2; /* минус первый и последний */
      if (need > 0 && inner.length > 0) {
        var step = inner.length / (need + 1);
        for (var ri = 0; ri < need && ri < inner.length; ri++) {
          reduced.push(inner[Math.round(step * (ri + 1) - 1)]);
        }
      }
      if (filtered.length > 1) reduced.push(filtered[filtered.length - 1]);
      /* Если maxChapters=1 — только первый */
      if (maxChapters === 1) reduced = [filtered[0]];
      filtered = reduced;
    }

    var chNote = maxChapters > 0 ? ' (лимит: ' + maxChapters + ')' : '';

    return {
      ok: true,
      proposal: {
        kind: 'markers',
        markers: filtered,
        summary: 'Автоматические главы (' + filtered.length + ')' + chNote + ': по темам из транскрипта.'
      }
    };
  }

  /**
   * /jump_cuts — ритм: агрессивно сжать все паузы (YouTube-стиль).
   *
   * Отличия от cutSilences:
   *   - Более низкий порог maxPause (default 0.5с vs 1.0с)
   *   - keepBreathing (default 0.05с): не режем в ноль — оставляем дыхание
   *   - minSegmentDuration (default 0.3с): соседние интервалы с крошечным
   *     остаточным сегментом между ними объединяются
   *   - Gating по threshold применяется ТАК ЖЕ, как в cutSilences (R13) —
   *     не цепляем фоновый шум как «тишину»
   */
  async function jumpCuts(ctx, params) {
    params = params || {};
    var entry = ctx.transcriptEntry;
    /* Phase 1.6 (6 мая 2026): jumpCuts НЕ требует транскрипта — работает по
       audioAnalysis.silences. Match AutoPod/FireCut: amplitude-only path. */
    if (!entry || (!entry.audioAnalysis && (!entry.segments || !entry.segments.length))) {
      return { ok: false, error: 'Нет данных. Запустите «Анализ аудио» или «Транскрибировать In-Out».' };
    }

    var maxPause = typeof params.maxPause === 'number' ? params.maxPause : 0.5;
    /* keepBreathing: падинг по краям тишины. 0 = резать в ноль (жёстко),
       0.05 = оставлять 50 мс дыхания с каждой стороны (естественно). */
    var keepBreathing = typeof params.keepBreathing === 'number' ? params.keepBreathing : 0.05;
    if (keepBreathing < 0) keepBreathing = 0;
    /* minSegmentDuration: если между двумя вырезаемыми интервалами остаётся
       сегмент речи короче этого — поглотить его (визуальный мусор). */
    var minSegmentDuration = typeof params.minSegmentDuration === 'number' ? params.minSegmentDuration : 0.3;
    if (minSegmentDuration < 0) minSegmentDuration = 0;

    var segs = entry.segments || [];
    var silences = (entry.audioAnalysis && entry.audioAnalysis.silences) || [];

    /* 26.06.2026: ЕДИНЫЙ детектор с «Убрать тишины» — silenceIntervalsFromRms по
       RMS-таймлайну. Раньше jumpCuts шёл через detectSilenceIntervals (ffmpeg
       silencedetect at silenceThresholdUsed≈-30) — ДРУГОЙ движок, чем «Тишины» и
       чем сама waveform-волна на карточке. Последствия: (1) на тихих записях
       порог -30 ловил >40% хронометража как «паузу» (over-aggressive — резал
       речь); (2) красные зоны не совпадали с RMS-волной превью (тот же класс
       «не там», что и в «Тишинах»). Теперь оба инструмента используют один
       относительный порог (на marginDb тише уровня речи региона) → WYSIWYG и
       консистентность. jumpCuts = «агрессивнее» за счёт меньших maxPause/дыхания,
       НЕ за счёт более громкого порога. Fallback на detectSilenceIntervals, когда
       RMS-таймлайна нет (старые кэши / транскрипт без аудио-анализа). */
    var rmsTl = entry.audioAnalysis && entry.audioAnalysis.rmsTimeline;
    var removeIntervals;
    if (Array.isArray(rmsTl) && rmsTl.length > 1) {
      removeIntervals = silenceIntervalsFromRms(rmsTl, {
        marginDb: 22,
        minDuration: maxPause,
        padding: keepBreathing
      });
    } else {
      removeIntervals = detectSilenceIntervals(entry, {
        minDuration: maxPause,
        padding: keepBreathing,
        source: 'gaps+ffmpeg'
        /* thresholdDb опущен → detectSilenceIntervals использует silenceThresholdUsed из entry */
      });
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

    /* R15: поглощаем крошечные речевые сегменты между соседними вырезами.
       Если между cur.endSec и next.startSec меньше minSegmentDuration —
       мёрджим интервалы (мусорный микро-клип исчезает). */
    if (minSegmentDuration > 0 && removeIntervals.length > 1) {
      var merged = [removeIntervals[0]];
      for (var mi = 1; mi < removeIntervals.length; mi++) {
        var prev = merged[merged.length - 1];
        var cur = removeIntervals[mi];
        var gapBetween = cur.startSec - prev.endSec;
        if (gapBetween > 0 && gapBetween < minSegmentDuration) {
          prev.endSec = cur.endSec;
          prev.reason = prev.reason + '; ' + cur.reason +
            ' (+ мини-сегмент ' + gapBetween.toFixed(2) + 'с поглощён)';
        } else {
          merged.push(cur);
        }
      }
      removeIntervals = merged;
    }

    /* Фильтр микро-зазоров: интервалы < 0.15с оставляют 2-3 кадра мусора после razor */
    var MIN_CUT = 0.15;
    removeIntervals = removeIntervals.filter(function (iv) {
      return (iv.endSec - iv.startSec) >= MIN_CUT;
    });

    if (removeIntervals.length === 0) {
      return {
        ok: true,
        summary: 'Пауз длиннее ' + maxPause + 'с не найдено после фильтрации микро-зазоров.',
        noChanges: true
      };
    }

    var totalRemoveSec = 0;
    removeIntervals.forEach(function (iv) { totalRemoveSec += iv.endSec - iv.startSec; });

    var breathLabel = keepBreathing > 0 ? ', дыхание ' + (keepBreathing * 1000).toFixed(0) + 'мс' : ', без дыхания';

    return {
      ok: true,
      proposal: {
        kind: 'transcript_cuts',
        removeIntervals: removeIntervals,
        summary: 'Jump cuts: ' + removeIntervals.length + ' пауз (>' + maxPause + 'с, суммарно ' +
          totalRemoveSec.toFixed(1) + 'с' + breathLabel + '). Вырезать?',
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

      /* US-005: осмысленные названия вместо «Часть N».
         Для первой главы оставляем «Вступление», для остальных — первые 4 слова
         ближайшего сегмента. Если текста нет — fallback на «Часть N». */
      var title;
      if (c === 0) {
        title = 'Вступление';
      } else {
        title = _firstWordsFromSegments(segments, snapTime, nextTime) || ('Часть ' + (c + 1));
      }

      chapters.push({
        startSec: snapTime,
        endSec: nextTime,
        title: title,
        summary: previewText || ''
      });
    }
    return chapters;
  }

  /**
   * US-005: адаптивный min-interval между главами в зависимости от длительности.
   *   <3min  = 10s
   *   3-10min = 20s
   *   >10min = 45s
   */
  function _adaptiveChapterMinInterval(totalDurSec) {
    if (!totalDurSec || totalDurSec <= 0) return 15;
    if (totalDurSec < 180) return 10;
    if (totalDurSec <= 600) return 20;
    return 45;
  }

  /**
   * US-005: первые 4 слова из абзаца/сегмента в диапазоне [startSec, endSec].
   * Используется для замены boilerplate-заголовков вроде «Часть N».
   */
  function _firstWordsForChapter(paragraphs, segments, startSec, endSec) {
    var reference = (typeof endSec === 'number' && endSec > startSec) ? endSec : (startSec + 15);
    /* Ищем первый абзац, пересекающий окно */
    if (paragraphs && paragraphs.length) {
      for (var p = 0; p < paragraphs.length; p++) {
        var par = paragraphs[p];
        var ps = typeof par.startSec === 'number' ? par.startSec : par.start;
        var pe = typeof par.endSec === 'number' ? par.endSec : par.end;
        if (typeof ps !== 'number' || typeof pe !== 'number') continue;
        if (pe > startSec && ps < reference) {
          var w = _firstNWords(par.text, 4);
          if (w) return w;
        }
      }
    }
    /* Fallback — по сегментам в окне */
    return _firstWordsFromSegments(segments, startSec, reference) || 'Глава';
  }

  function _firstWordsFromSegments(segments, startSec, endSec) {
    if (!segments || !segments.length) return '';
    var collected = '';
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var s = typeof seg.startSec === 'number' ? seg.startSec : seg.start;
      var e = typeof seg.endSec === 'number' ? seg.endSec : seg.end;
      if (typeof s !== 'number') continue;
      if (typeof e === 'number' ? (e > startSec && s < endSec) : (s >= startSec && s < endSec)) {
        collected += ' ' + String(seg.text || '').trim();
        if (collected.split(/\s+/).filter(Boolean).length >= 6) break;
      }
    }
    return _firstNWords(collected, 4);
  }

  function _firstNWords(text, n) {
    var words = String(text || '')
      .replace(/[«»"'()\[\]{}]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, n);
    return words.join(' ').trim();
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

  /**
   * Снэппинг интервалов к границам кадров (аудит 2026-06-09, HIGH quality).
   *
   * Проблема: интервалы идут float-секундами, округление к кадру происходит
   * только в _secToTimecode на хосте → дрейф 1-3 кадра, накапливается на ripple.
   *
   * Правило: startSec — ВНИЗ (floor), endSec — ВВЕРХ (ceil) к границе кадра:
   * вырез никогда не оставляет частичный кадр мусора по краям. После снэппинга
   * фильтруем схлопнувшиеся интервалы (< 1 кадра).
   *
   * fps может быть дробным (29.97 NTSC). Прочие свойства интервалов сохраняются.
   * Возвращает НОВЫЙ массив; при невалидном fps — исходные интервалы как есть.
   */
  function snapIntervalsToFrame(intervals, fps) {
    if (!Array.isArray(intervals)) return [];
    if (typeof fps !== 'number' || !isFinite(fps) || fps <= 0) return intervals.slice();
    var frameDur = 1 / fps;
    var EPS = 1e-6;
    var out = [];
    for (var i = 0; i < intervals.length; i++) {
      var iv = intervals[i];
      if (!iv || typeof iv.startSec !== 'number' || typeof iv.endSec !== 'number') continue;
      var snapped = {};
      for (var k in iv) {
        if (Object.prototype.hasOwnProperty.call(iv, k)) snapped[k] = iv[k];
      }
      snapped.startSec = Math.floor(iv.startSec * fps + EPS) / fps;
      snapped.endSec = Math.ceil(iv.endSec * fps - EPS) / fps;
      if (snapped.startSec < 0) snapped.startSec = 0;
      /* Схлопнувшийся интервал (< 1 кадра) — пропускаем */
      if (snapped.endSec - snapped.startSec < frameDur - EPS) continue;
      out.push(snapped);
    }
    return out;
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
      '/l_cuts': jCuts,
      /* B1-8 (заимствовано из CVP): русские алиасы — пользователь не обязан помнить англ. имена */
      '/паразиты': cutFillers,
      '/тишины': cutSilences,
      '/главы': chapterize,
      '/джампкаты': jumpCuts
    };

    if (cmd === '/l_cuts') {
      params.mode = params.mode || 'l';
    }

    if (PIPELINES[cmd]) {
      return { pipeline: PIPELINES[cmd], params: params, name: cmd };
    }
    return null;
  }

  /**
   * MultiCam Phase 1 MVP (2026-04-30):
   * Авто-нарезка multicam-композиции (3V+2A) для подкаста.
   *
   * MVP-стратегия (без ffmpeg-астатс):
   *   - Используем транскрипт как proxy для активности.
   *   - Пока что НЕ можем определить кто из 2 спикеров говорит — у нас один
   *     транскрипт на всю секвенцию. В Phase 1.5 добавим per-track audio analysis.
   *   - Поэтому MVP делает простую нарезку: чередует V2/V3 каждые ~6 секунд
   *     по абзацам транскрипта, между ними wide-вставки.
   *
   * Это даёт пользователю РАБОЧУЮ нарезку для теста razor+disabled пайплайна
   * в Premiere. Реальный «кто говорит» — следующий шаг.
   *
   * См. .omc/plans/multicam-phase1-mvp.md
   */
  async function multicamFromTranscript(ctx, params) {
    params = params || {};
    var entry = ctx.transcriptEntry;
    if (!entry || !entry.segments || !entry.segments.length) {
      return { ok: false, error: 'Нет транскрипта. Транскрибируйте секвенцию (In-Out).' };
    }
    var snap = ctx.snapshot;
    if (!snap || !snap.ok) {
      return { ok: false, error: 'Нет снимка таймлайна.' };
    }

    /* Проверка структуры: нужно >=3 видео и >=2 аудио. */
    var vTracks = (snap.tracks || []).filter(function (t) { return t.type === 'video'; });
    var aTracks = (snap.tracks || []).filter(function (t) { return t.type === 'audio'; });
    if (vTracks.length < 3) {
      return { ok: false, error: 'Нужно ≥3 видеодорожки (V1=wide, V2/V3=гости). Найдено ' + vTracks.length + '.' };
    }
    if (aTracks.length < 2) {
      return { ok: false, error: 'Нужно ≥2 аудиодорожки. Найдено ' + aTracks.length + '.' };
    }

    /* Hardcoded mapping для Phase 1 MVP. */
    var mapping = {
      wideVideoTrack: 0,
      speakers: [
        { audioTrack: 0, videoTrack: 1, label: 'Гость 1' },
        { audioTrack: 1, videoTrack: 2, label: 'Гость 2' }
      ]
    };

    /* Phase 1 MVP: чередуем V2/V3 по абзацам.
       Если paragraphs нет — сделаем из сегментов (~6с группы). */
    var paragraphs = entry.paragraphs;
    if (!paragraphs || !paragraphs.length) {
      paragraphs = _buildSimpleParagraphs(entry.segments, 6);
    }
    if (!paragraphs.length) {
      return { ok: false, error: 'Не удалось построить абзацы из транскрипта.' };
    }

    /* Простой план: чередование V2/V3 для абзацев, wide между ними при паузах ≥1с. */
    var segments = [];
    for (var pi = 0; pi < paragraphs.length; pi++) {
      var p = paragraphs[pi];
      var ps = typeof p.startSec === 'number' ? p.startSec : p.start;
      var pe = typeof p.endSec === 'number' ? p.endSec : p.end;
      if (typeof ps !== 'number' || typeof pe !== 'number' || pe <= ps) continue;
      /* Если перед этим абзацем — длинная пауза, вставляем wide. */
      var prevEnd = pi === 0 ? 0 : (segments.length ? segments[segments.length - 1].tEnd : 0);
      if (ps - prevEnd >= 1.0) {
        segments.push({ tStart: prevEnd, tEnd: ps, activeVideoTrack: mapping.wideVideoTrack });
      } else if (segments.length) {
        /* Иначе расширяем предыдущий до начала текущего. */
        segments[segments.length - 1].tEnd = ps;
      }
      var activeVT = (pi % 2 === 0) ? mapping.speakers[0].videoTrack : mapping.speakers[1].videoTrack;
      segments.push({ tStart: ps, tEnd: pe, activeVideoTrack: activeVT });
    }

    /* Объединяем подряд идущие одинаковые segments. */
    var merged = [];
    for (var mi = 0; mi < segments.length; mi++) {
      var s = segments[mi];
      var last = merged[merged.length - 1];
      if (last && last.activeVideoTrack === s.activeVideoTrack && Math.abs(last.tEnd - s.tStart) < 0.05) {
        last.tEnd = s.tEnd;
      } else {
        merged.push({ tStart: s.tStart, tEnd: s.tEnd, activeVideoTrack: s.activeVideoTrack });
      }
    }

    if (!merged.length) {
      return { ok: false, error: 'Не удалось построить план переключений.' };
    }

    /* Стат для UI. */
    var perTrack = {};
    for (var ms = 0; ms < merged.length; ms++) {
      var k = String(merged[ms].activeVideoTrack);
      perTrack[k] = (perTrack[k] || 0) + (merged[ms].tEnd - merged[ms].tStart);
    }

    var plan = {
      version: 1,
      rangeSec: [merged[0].tStart, merged[merged.length - 1].tEnd],
      mapping: mapping,
      params: { mode: 'disable' },
      segments: merged
    };

    return {
      ok: true,
      proposal: {
        kind: 'multicam_cuts',
        plan: plan,
        summary: 'Авто-MultiCam: ' + merged.length + ' сегментов, ' + (merged.length - 1) +
          ' переключений. V1: ' + ((perTrack['0'] || 0).toFixed(1)) + 'с, V2: ' +
          ((perTrack['1'] || 0).toFixed(1)) + 'с, V3: ' + ((perTrack['2'] || 0).toFixed(1)) + 'с.',
        stats: { perTrackSeconds: perTrack, switchCount: merged.length - 1 }
      }
    };
  }

  /**
   * Простые абзацы из сегментов (если transcript-structure не сработал).
   * Группирует подряд идущие сегменты пока сумма не превысит maxSec.
   */
  function _buildSimpleParagraphs(segments, maxSec) {
    var out = [];
    var cur = null;
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      var ss = typeof s.startSec === 'number' ? s.startSec : s.start;
      var se = typeof s.endSec === 'number' ? s.endSec : s.end;
      if (typeof ss !== 'number' || typeof se !== 'number') continue;
      if (!cur) {
        cur = { startSec: ss, endSec: se };
      } else if (se - cur.startSec > maxSec) {
        out.push(cur);
        cur = { startSec: ss, endSec: se };
      } else {
        cur.endSec = se;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /**
   * B1-7 (10 июня 2026): pre-flight детект «общего звука».
   * Главный публичный фейл AutoPod-класса инструментов: на всех дорожках один
   * и тот же микс (общий рекордер/файл) → RMS-профили идентичны → свитчер
   * не работает, пользователь винит плагин. Ловим ДО построения плана.
   * timelines: [[{t, rms}], ...] — если у пары среднее |Δ| < thresholdDb,
   * дорожки считаем дублями. Возвращает массив пар [i, j].
   */
  function _detectSharedAudio(timelines, thresholdDb) {
    var thr = typeof thresholdDb === 'number' ? thresholdDb : 1.0;
    var pairs = [];
    if (!timelines || timelines.length < 2) return pairs;
    for (var i = 0; i < timelines.length; i++) {
      for (var j = i + 1; j < timelines.length; j++) {
        var a = timelines[i] || [];
        var b = timelines[j] || [];
        var n = Math.min(a.length, b.length);
        if (n < 20) continue; /* слишком мало данных для вывода */
        var sum = 0;
        var cnt = 0;
        for (var k = 0; k < n; k++) {
          var va = a[k] && a[k].rms;
          var vb = b[k] && b[k].rms;
          if (typeof va !== 'number' || typeof vb !== 'number') continue;
          sum += Math.abs(va - vb);
          cnt++;
        }
        if (cnt >= 20 && sum / cnt < thr) pairs.push([i, j]);
      }
    }
    return pairs;
  }

  /**
   * Детект «плоских» дорожек: live-находка 11 июня 2026 — реальный микрофонный
   * WAV с лимитером/шумом держал RMS в коридоре <1 дБ (p10–p99), всегда
   * «побеждал» в детекте говорящего, и второй спикер не получал ни секунды.
   * Дорожка без динамики бесполезна для свитчера — честно предупреждаем.
   * Возвращает массив индексов дорожек со спредом p10–p90 < minSpreadDb.
   */
  function _detectFlatAudio(timelines, minSpreadDb) {
    var minSpread = typeof minSpreadDb === 'number' ? minSpreadDb : 3.0;
    var flat = [];
    if (!timelines) return flat;
    for (var i = 0; i < timelines.length; i++) {
      var tl = timelines[i] || [];
      var vals = [];
      for (var k = 0; k < tl.length; k++) {
        var v = tl[k] && tl[k].rms;
        if (typeof v === 'number' && isFinite(v)) vals.push(v);
      }
      if (vals.length < 20) continue; /* слишком мало данных для вывода */
      vals.sort(function (a, b) { return a - b; });
      var p10 = vals[Math.floor(vals.length * 0.1)];
      var p90 = vals[Math.floor(vals.length * 0.9)];
      if (p90 - p10 < minSpread) flat.push(i);
    }
    return flat;
  }

  /**
   * Перевод RMS-таймлайна из media-time в sequence-time по геометрии клипа.
   * Live-находка 11 июня 2026: computeRmsTimeline анализирует ВЕСЬ файл с
   * media t=0, а клип на таймлайне обычно подрезан (в реальном проекте
   * inPoint был 658с у микрофонных WAV и 473с у камер) — без ремапа план
   * переключений строится по чужому участку звука и выходит за конец
   * секвенции. Кадры вне используемого окна клипа отбрасываются.
   * clip: {startSec, endSec, inPointSec} из getTimelineSnapshot.
   */
  function remapRmsToSequenceTime(timeline, clip) {
    if (!timeline || !timeline.length || !clip) return timeline || [];
    var inPt = typeof clip.inPointSec === 'number' ? clip.inPointSec : 0;
    var start = typeof clip.startSec === 'number' ? clip.startSec : 0;
    var end = typeof clip.endSec === 'number' ? clip.endSec : Infinity;
    var span = end - start;
    var out = [];
    for (var i = 0; i < timeline.length; i++) {
      var f = timeline[i];
      if (!f || typeof f.t !== 'number') continue;
      var t = f.t - inPt;
      if (t < 0 || t > span) continue;
      out.push({ t: t + start, rms: f.rms });
    }
    return out;
  }

  /**
   * Кастомный маппинг дорожек по спикерам (AutoPod-паттерн «теги дорожек»,
   * live-запрос 12 июня 2026): авто-схема «V1 wide, A(i)→V(i+1)» ломается,
   * когда микрофоны не на первых аудиодорожках (камерный звук BRAW) или
   * аудио не засинхронено с порядком видео — свитчер включает молчащего
   * спикера. raw: {wideVideoTrack, speakers:[{audioTrack, videoTrack, label?}]},
   * индексы 0-based. Возвращает {ok, mapping} либо {ok:false, error}.
   */
  function _normalizeMulticamMapping(raw, vCount, aCount, maxSpeakers) {
    function isIdx(v, max) { return typeof v === 'number' && isFinite(v) && v % 1 === 0 && v >= 0 && v < max; }
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Маппинг дорожек не задан.' };
    }
    var wide = raw.wideVideoTrack;
    if (!isIdx(wide, vCount)) {
      return { ok: false, error: 'Общий план: нет видеодорожки с индексом ' + String(wide) + ' (видеодорожек: ' + vCount + ').' };
    }
    var src = raw.speakers;
    if (!src || !src.length) {
      return { ok: false, error: 'Не выбран ни один спикер.' };
    }
    if (src.length > maxSpeakers) {
      return { ok: false, error: 'Максимум спикеров: ' + maxSpeakers + ', выбрано ' + src.length + '.' };
    }
    var speakers = [];
    var usedV = {};
    var usedA = {};
    for (var i = 0; i < src.length; i++) {
      var sp = src[i] || {};
      if (!isIdx(sp.audioTrack, aCount)) {
        return { ok: false, error: 'Спикер ' + (i + 1) + ': нет аудиодорожки с индексом ' + String(sp.audioTrack) + ' (аудиодорожек: ' + aCount + ').' };
      }
      if (!isIdx(sp.videoTrack, vCount)) {
        return { ok: false, error: 'Спикер ' + (i + 1) + ': нет видеодорожки с индексом ' + String(sp.videoTrack) + ' (видеодорожек: ' + vCount + ').' };
      }
      if (sp.videoTrack === wide) {
        return { ok: false, error: 'Спикер ' + (i + 1) + ': видеодорожка V' + (sp.videoTrack + 1) + ' уже занята общим планом.' };
      }
      if (typeof usedV[sp.videoTrack] === 'number') {
        return { ok: false, error: 'Спикеры ' + (usedV[sp.videoTrack] + 1) + ' и ' + (i + 1) + ' назначены на одну видеодорожку V' + (sp.videoTrack + 1) + '.' };
      }
      if (typeof usedA[sp.audioTrack] === 'number') {
        return { ok: false, error: 'Спикеры ' + (usedA[sp.audioTrack] + 1) + ' и ' + (i + 1) + ' слушают одну аудиодорожку A' + (sp.audioTrack + 1) + ' — детект по голосу их не различит.' };
      }
      usedV[sp.videoTrack] = i;
      usedA[sp.audioTrack] = i;
      speakers.push({
        audioTrack: sp.audioTrack,
        videoTrack: sp.videoTrack,
        label: sp.label || ('Гость ' + (i + 1))
      });
    }
    return { ok: true, mapping: { wideVideoTrack: wide, speakers: speakers } };
  }

  /**
   * MultiCam Phase 2A: реальный детект говорящего через per-track RMS.
   * ctx.rmsExtractor(ctx, mapping, params) → Promise<{timelines:[[{t,rms}],...]}>
   *   по одному [{t,rms}] на mic-дорожку спикера, в порядке mapping.speakers.
   * params.mapping — опциональный кастомный выбор дорожек (см.
   * _normalizeMulticamMapping); без него — авто-схема «V1 wide, A(i)→V(i+1)».
   * Чистый план строит MulticamPlan.buildSwitchPlan (тот же контракт, что и Phase 1).
   */
  async function multicamFromAudio(ctx, params) {
    params = params || {};
    var snap = ctx && ctx.snapshot;
    if (!snap || !snap.ok) {
      return { ok: false, error: 'Нет снимка таймлайна.' };
    }
    var vTracks = (snap.tracks || []).filter(function (t) { return t.type === 'video'; });
    var aTracks = (snap.tracks || []).filter(function (t) { return t.type === 'audio'; });
    var MAX_SPEAKERS = 4;
    if (vTracks.length < 2) {
      return { ok: false, error: 'Нужно ≥2 видеодорожки (V1=wide + ≥1 гость). Найдено ' + vTracks.length + '.' };
    }
    if (aTracks.length < 1) {
      return { ok: false, error: 'Нужно ≥1 аудиодорожки (mic). Найдено ' + aTracks.length + '.' };
    }
    if (typeof ctx.rmsExtractor !== 'function') {
      return { ok: false, error: 'Нет источника аудио (rmsExtractor). Установите ffmpeg.' };
    }

    var mapping;
    if (params.mapping) {
      /* Кастомный выбор дорожек из UI — валидируем против реальной секвенции. */
      var nm = _normalizeMulticamMapping(params.mapping, vTracks.length, aTracks.length, MAX_SPEAKERS);
      if (!nm.ok) return { ok: false, error: nm.error };
      mapping = nm.mapping;
    } else {
      /* Авто-детект микрофонов (19.06.2026): раньше брали первые N аудиодорожек
         (audioTrack 0,1,2…) вслепую. На реальном мультикаме первые дорожки —
         камерное BRAW-аудио, которое ffmpeg НЕ декодирует → «0 кадров RMS», авто
         падал. Теперь предпочитаем дорожки с декодируемым аудио: сначала чистые
         микрофоны (WAV/MP3/FLAC), затем видео-с-аудио (MP4/MOV/MXF), BRAW/R3D
         пропускаем. mediaPath берём из клипов снапшота (по первому клипу дорожки). */
      var MIC_EXT = /\.(wav|mp3|m4a|aac|flac|ogg|opus)$/i;
      var CAM_EXT = /\.(mp4|mov|mxf|avi|mkv|m4v)$/i;
      var SKIP_EXT = /\.(braw|r3d|ari|arx)$/i;
      var trackMedia = {};
      (snap.clips || []).forEach(function (c) {
        if (c.trackType === 'audio' && trackMedia[c.trackIndex] === undefined) {
          trackMedia[c.trackIndex] = c.mediaPath || '';
        }
      });
      var micTracks = [], camTracks = [], otherTracks = [];
      for (var ati = 0; ati < aTracks.length; ati++) {
        var idx = aTracks[ati].index;
        var mp = trackMedia[idx] || '';
        if (SKIP_EXT.test(mp)) continue;           /* BRAW/R3D — ffmpeg не извлечёт RMS */
        if (MIC_EXT.test(mp)) micTracks.push(idx);
        else if (CAM_EXT.test(mp)) camTracks.push(idx);
        else otherTracks.push(idx);                /* неизвестный/пустой путь — как запасной */
      }
      var usable = micTracks.concat(camTracks).concat(otherTracks);
      /* Fallback: если все отсеяли (нет mediaPath) — старое поведение. */
      if (!usable.length) { for (var u = 0; u < aTracks.length; u++) usable.push(aTracks[u].index); }
      var autoCount = Math.min(usable.length, vTracks.length - 1, MAX_SPEAKERS);
      var autoSpeakers = [];
      for (var spi = 0; spi < autoCount; spi++) {
        autoSpeakers.push({ audioTrack: usable[spi], videoTrack: spi + 1, label: 'Гость ' + (spi + 1) });
      }
      mapping = { wideVideoTrack: 0, speakers: autoSpeakers };
    }
    var speakers = mapping.speakers;
    var speakerCount = speakers.length;

    var extracted;
    try {
      extracted = await ctx.rmsExtractor(ctx, mapping, params);
    } catch (e) {
      return { ok: false, error: 'Ошибка анализа аудио: ' + String(e && e.message || e) };
    }
    var timelines = extracted && extracted.timelines;
    if (!timelines || !timelines.length) {
      return { ok: false, error: 'Не удалось извлечь аудио-RMS дорожек.' };
    }
    var mediaPaths = extracted.mediaPaths || [];

    /* Честная ошибка вместо вырожденного плана: пустой RMS-таймлайн значит,
       что аудио не извлеклось (live-находка 11 июня 2026: ffmpeg молча отдаёт
       0 кадров на BRAW — без этой проверки строился план «1 сегмент,
       0 переключений» на весь таймлайн). */
    var emptyTracks = [];
    for (var eti = 0; eti < timelines.length; eti++) {
      if (!timelines[eti] || !timelines[eti].length) {
        emptyTracks.push(mediaPaths[eti]
          ? String(mediaPaths[eti]).split(/[\\\/]/).pop()
          : 'дорожка A' + ((speakers[eti] ? speakers[eti].audioTrack : eti) + 1));
      }
    }
    if (emptyTracks.length) {
      return {
        ok: false,
        error: 'Аудио-анализ не дал ни одного кадра RMS: ' + emptyTracks.join(', ') +
          '. Формат может не поддерживаться ffmpeg (например BRAW). ' +
          'Нужны дорожки с раздельными микрофонными записями (WAV/MP4).'
      };
    }

    /* B1-7: pre-flight варнинги — не блокируем, но честно предупреждаем.
       Подписи дорожек берём из mapping: при кастомном выборе индекс спикера
       не совпадает с индексом аудиодорожки. */
    function aLabel(speakerIdx) {
      var s = speakers[speakerIdx];
      return 'A' + ((s ? s.audioTrack : speakerIdx) + 1);
    }
    var warnings = [];
    for (var dpi = 0; dpi < mediaPaths.length; dpi++) {
      for (var dpj = dpi + 1; dpj < mediaPaths.length; dpj++) {
        if (mediaPaths[dpi] && mediaPaths[dpi] === mediaPaths[dpj]) {
          warnings.push('Дорожки ' + aLabel(dpi) + ' и ' + aLabel(dpj) + ' указывают на ОДИН файл — переключение по голосу не сработает. Нужны раздельные микрофонные записи.');
        }
      }
    }
    if (!warnings.length) {
      var sharedPairs = _detectSharedAudio(timelines, 1.0);
      for (var shp = 0; shp < sharedPairs.length; shp++) {
        warnings.push('Дорожки ' + aLabel(sharedPairs[shp][0]) + ' и ' + aLabel(sharedPairs[shp][1]) + ' звучат почти идентично (общий звук/микс?). Свитчер по голосу будет ненадёжен.');
      }
    }
    var flatTracks = _detectFlatAudio(timelines, 3.0);
    for (var flt = 0; flt < flatTracks.length; flt++) {
      var fSpeaker = speakers[flatTracks[flt]];
      warnings.push('Микрофон спикера ' + (flatTracks[flt] + 1) +
        (fSpeaker ? ' (A' + (fSpeaker.audioTrack + 1) + ')' : '') +
        ' почти без динамики (разброс RMS < 3 дБ — лимитер или шум?). ' +
        'Детект говорящего по нему ненадёжен: спикер может всегда «побеждать» или никогда не включаться.');
    }

    var frameSec = typeof params.frameSec === 'number' ? params.frameSec : 0.05;
    var frames = MulticamPlan.framesFromRmsTimelines(timelines, frameSec);
    if (!frames.length) {
      return { ok: false, error: 'Пустой аудио-анализ.' };
    }

    var planParams = {
      frameSec: frameSec,
      minHoldSec: typeof params.minHoldSec === 'number' ? params.minHoldSec : 1.5,
      bleedMarginDb: typeof params.bleedMarginDb === 'number' ? params.bleedMarginDb : 6,
      silenceThresholdDb: typeof params.silenceThresholdDb === 'number' ? params.silenceThresholdDb : -35
    };
    /* Phase 2B: опциональные параметры — отдаём только если заданы,
       иначе buildSwitchPlan возьмёт свои DEFAULTS */
    if (typeof params.maxHoldSec === 'number') planParams.maxHoldSec = params.maxHoldSec;
    if (typeof params.overlapWideMinSec === 'number') planParams.overlapWideMinSec = params.overlapWideMinSec;
    if (typeof params.maxAllSpeakersSec === 'number') planParams.maxAllSpeakersSec = params.maxAllSpeakersSec;
    if (typeof params.variationsJitterSec === 'number') planParams.variationsJitterSec = params.variationsJitterSec;
    if (typeof params.variationsSeed === 'number') planParams.variationsSeed = params.variationsSeed;
    if (Array.isArray(params.speechOnsets)) planParams.speechOnsets = params.speechOnsets;
    var built = MulticamPlan.buildSwitchPlan(frames, mapping, planParams, params.silences || null);
    if (!built.segments || !built.segments.length) {
      return { ok: false, error: 'Не удалось построить план переключений.' };
    }

    var perTrack = (built.stats && built.stats.perTrackSeconds) || {};
    var plan = {
      version: 1,
      rangeSec: [built.segments[0].tStart, built.segments[built.segments.length - 1].tEnd],
      mapping: mapping,
      params: { mode: (params.mode === 'delete' ? 'delete' : 'disable') },
      segments: built.segments
    };

    return {
      ok: true,
      proposal: {
        kind: 'multicam_cuts',
        plan: plan,
        summary: 'Авто-MultiCam (по голосу): ' + built.segments.length + ' сегментов, ' +
          built.switchCount + ' переключений. Спикеров: ' + speakerCount + '.',
        warnings: warnings,
        stats: { perTrackSeconds: perTrack, switchCount: built.switchCount }
      }
    };
  }

  global.DeterministicPipelines = {
    cutFillers: cutFillers,
    cutSilences: cutSilences,
    chapterize: chapterize,
    jumpCuts: jumpCuts,
    jCuts: jCuts,
    multicamFromTranscript: multicamFromTranscript,
    multicamFromAudio: multicamFromAudio,
    remapRmsToSequenceTime: remapRmsToSequenceTime,
    _normalizeMulticamMapping: _normalizeMulticamMapping,
    detectSilenceIntervals: detectSilenceIntervals,
    silenceIntervalsFromRms: silenceIntervalsFromRms,
    rmsThresholdInfo: rmsThresholdInfo,
    parsePipelineCommand: parsePipelineCommand,
    snapIntervalsToFrame: snapIntervalsToFrame,
    _mergeIntervals: _mergeIntervals,
    _detectSharedAudio: _detectSharedAudio,
    _detectFlatAudio: _detectFlatAudio,
    _silencesFromSegmentGaps: _silencesFromSegmentGaps,
    _buildSimpleParagraphs: _buildSimpleParagraphs
  };
})(window);
