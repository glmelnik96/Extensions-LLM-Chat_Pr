/**
 * AudioDucking: расчёт ducking-кривой и LUFS-нормализации из cached audioAnalysis + paragraphs.
 *
 * Премьер 2025 ScriptingAPI не даёт надёжного контроля над keyframes Volume через ExtendScript
 * (Component.properties API нестабилен и часть свойств read-only). Поэтому стратегия здесь:
 *
 *  1. Считаем рекомендуемые точки ducking (start речи → -duckDb, end речи → 0 dB) с учётом fade-in/out.
 *  2. Считаем единый gain delta для LUFS-нормализации (target − inputI).
 *  3. Возвращаем план, который можно применить либо как **маркеры-подсказки** (точно работает),
 *     либо как **попытку записи keyframes** через хост (best-effort, см. host/premiere.jsx).
 *
 * Точки на основе paragraphs (а не сегментов) — иначе будет визуальный мусор на каждом 2-секундном сегменте.
 */
(function (global) {
  /**
   * @param {Array} paragraphs  [{startSec, endSec, text, ...}] из TranscriptStructure
   * @param {object} opt        { duckDb?:-12, fadeInSec?:0.15, fadeOutSec?:0.3, mergeGapSec?:0.5 }
   * @returns {{intervals, keyframes, summary}}
   */
  function computeDucking(paragraphs, opt) {
    opt = opt || {};
    var duckDb = typeof opt.duckDb === 'number' ? opt.duckDb : -12;
    var fadeIn = typeof opt.fadeInSec === 'number' ? opt.fadeInSec : 0.15;
    var fadeOut = typeof opt.fadeOutSec === 'number' ? opt.fadeOutSec : 0.3;
    var mergeGap = typeof opt.mergeGapSec === 'number' ? opt.mergeGapSec : 0.5;

    var ps = (paragraphs || []).slice().sort(function (a, b) {
      return a.startSec - b.startSec;
    });
    if (!ps.length) {
      return { intervals: [], keyframes: [], summary: { intervalCount: 0, totalDuckSec: 0 } };
    }

    /* объединение близких параграфов */
    var merged = [];
    var cur = { startSec: ps[0].startSec, endSec: ps[0].endSec };
    for (var i = 1; i < ps.length; i++) {
      if (ps[i].startSec - cur.endSec <= mergeGap) {
        cur.endSec = Math.max(cur.endSec, ps[i].endSec);
      } else {
        merged.push(cur);
        cur = { startSec: ps[i].startSec, endSec: ps[i].endSec };
      }
    }
    merged.push(cur);

    var keyframes = [];
    var totalDuck = 0;
    merged.forEach(function (iv) {
      var preStart = Math.max(0, iv.startSec - fadeIn);
      var afterEnd = iv.endSec + fadeOut;
      keyframes.push({ timeSec: round3(preStart), gainDb: 0 });
      keyframes.push({ timeSec: round3(iv.startSec), gainDb: duckDb });
      keyframes.push({ timeSec: round3(iv.endSec), gainDb: duckDb });
      keyframes.push({ timeSec: round3(afterEnd), gainDb: 0 });
      totalDuck += iv.endSec - iv.startSec;
    });

    return {
      intervals: merged,
      keyframes: keyframes,
      summary: {
        intervalCount: merged.length,
        totalDuckSec: Math.round(totalDuck * 100) / 100,
        duckDb: duckDb,
        fadeInSec: fadeIn,
        fadeOutSec: fadeOut
      }
    };
  }

  /**
   * @param {object} loudness   { inputI, inputTp, inputLra, inputThresh, ... } из audioAnalysis.loudness
   * @param {object} opt        { targetLufs?:-16, maxGainDb?:12, minGainDb?:-24 }
   * @returns {{ ok, gainDb?, reason?, targetLufs, inputLufs, clipped? }}
   */
  function computeLoudnessGain(loudness, opt) {
    opt = opt || {};
    var target = typeof opt.targetLufs === 'number' ? opt.targetLufs : -16;
    var maxGain = typeof opt.maxGainDb === 'number' ? opt.maxGainDb : 12;
    var minGain = typeof opt.minGainDb === 'number' ? opt.minGainDb : -24;

    if (!loudness || typeof loudness.inputI !== 'number' || isNaN(loudness.inputI)) {
      return { ok: false, reason: 'нет данных loudness в audioAnalysis (запусти транскрибацию)' };
    }
    var inI = loudness.inputI;
    var raw = target - inI;
    var clipped = false;
    var g = raw;
    if (g > maxGain) {
      g = maxGain;
      clipped = true;
    }
    if (g < minGain) {
      g = minGain;
      clipped = true;
    }
    var tpHeadroom = null;
    if (typeof loudness.inputTp === 'number') {
      tpHeadroom = -1 - loudness.inputTp; /* доступно до true peak -1 dBTP */
      if (g > tpHeadroom) {
        g = Math.max(minGain, tpHeadroom);
        clipped = true;
      }
    }
    return {
      ok: true,
      gainDb: Math.round(g * 100) / 100,
      rawGainDb: Math.round(raw * 100) / 100,
      targetLufs: target,
      inputLufs: Math.round(inI * 100) / 100,
      inputTpDb: typeof loudness.inputTp === 'number' ? loudness.inputTp : null,
      tpHeadroomDb: tpHeadroom !== null ? Math.round(tpHeadroom * 100) / 100 : null,
      clipped: clipped
    };
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  global.AudioDucking = {
    computeDucking: computeDucking,
    computeLoudnessGain: computeLoudnessGain
  };
})(typeof window !== 'undefined' ? window : this);
