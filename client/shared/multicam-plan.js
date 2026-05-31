/**
 * MultiCam Plan Builder — чистая логика построения плана переключения камер
 * для multicam-композиций подкастов.
 *
 * Phase 1 MVP (см. .omc/plans/multicam-phase1-mvp.md и .omc/research/multicam-podcast-feature.md):
 *   • На вход: per-frame RMS по каждой аудиодорожке (gain-shared между mic'ами)
 *   • На выход: сегменты [{tStart, tEnd, activeVideoTrack}]
 *
 * Алгоритм:
 *   1. Для каждого кадра: кто из спикеров «активный» — громче на bleedMarginDb
 *      остальных и громче silenceThresholdDb.
 *   2. Mapping audio→video: speakerN → videoTrackIndex; никто/двое → wide.
 *   3. EMA-smoothing — гасим единичные всплески.
 *   4. Min-hold — не переключаем чаще чем раз в minHoldSec.
 *   5. Snap к ближайшей silence-границе (если есть).
 *
 * Чистая функция, без DOM. Тестируется в Node через tests/load-multicam-plan.mjs.
 */
(function (global) {
  /**
   * Дефолтные параметры (синхронизированы с .omc/plans/multicam-phase1-mvp.md).
   */
  var DEFAULTS = {
    frameSec: 0.05,
    minHoldSec: 1.5,
    bleedMarginDb: 6,
    silenceThresholdDb: -35,
    snapWindowSec: 0.3,
    smoothingWindow: 5,         /* EMA-окно в кадрах (5 × 50мс = 250мс) */
    wideOnOverlap: true,
    wideOnSilence: true,
    wideVideoTrack: 0           /* индекс wide-дорожки */
  };

  /**
   * Определить «активный mic» для одного кадра.
   *   audioRmsDb: массив RMS по mic'ам в dB (индексы соответствуют speakerIndex)
   *   silenceDb:  порог тишины
   *   marginDb:   на сколько громче должен быть лидер
   *
   * Возвращает:
   *   - индекс активного mic'а, если ровно один громкий
   *   - -1, если все ниже silence (никто не говорит)
   *   - -2, если несколько громких в пределах margin (overlap)
   */
  function decideActiveMic(audioRmsDb, silenceDb, marginDb) {
    if (!audioRmsDb || !audioRmsDb.length) return -1;
    var loud = [];
    for (var i = 0; i < audioRmsDb.length; i++) {
      var v = audioRmsDb[i];
      if (typeof v !== 'number' || isNaN(v)) continue;
      if (v >= silenceDb) loud.push({ idx: i, db: v });
    }
    if (loud.length === 0) return -1;
    if (loud.length === 1) return loud[0].idx;
    /* Сортируем по убыванию громкости. */
    loud.sort(function (a, b) { return b.db - a.db; });
    /* Лидер должен быть громче второго хотя бы на marginDb. */
    if (loud[0].db - loud[1].db >= marginDb) return loud[0].idx;
    /* Overlap. */
    return -2;
  }

  /**
   * Mapping: индекс активного mic'а → индекс активной видеодорожки.
   *   activeMic == -1 (silence) → wide
   *   activeMic == -2 (overlap) → wide
   *   activeMic = N → mapping.speakers[N].videoTrack
   */
  function micToVideoTrack(activeMic, mapping, params) {
    if (activeMic === -1 && params.wideOnSilence) return mapping.wideVideoTrack;
    if (activeMic === -2 && params.wideOnOverlap) return mapping.wideVideoTrack;
    if (activeMic < 0) return mapping.wideVideoTrack;
    var sp = mapping.speakers && mapping.speakers[activeMic];
    if (sp && typeof sp.videoTrack === 'number') return sp.videoTrack;
    return mapping.wideVideoTrack;
  }

  /**
   * EMA-сглаживание массива int-меток. Здесь используется простая
   * majority-vote в окне shape (skip-min 3): если в окне `window` кадров
   * большинство имеет одну и ту же метку — считаем её. Иначе — сохраняем
   * предыдущую.
   * Это убирает single-frame flicker без вмешательства в долгие участки.
   */
  function smoothLabels(labels, window) {
    if (!labels || labels.length <= 1) return labels.slice();
    var w = Math.max(1, Math.floor(window || 5));
    var out = labels.slice();
    var half = Math.floor(w / 2);
    for (var i = 0; i < labels.length; i++) {
      var lo = Math.max(0, i - half);
      var hi = Math.min(labels.length - 1, i + half);
      var counts = {};
      var bestKey = labels[i];
      var bestCount = 0;
      for (var j = lo; j <= hi; j++) {
        var k = String(labels[j]);
        counts[k] = (counts[k] || 0) + 1;
        if (counts[k] > bestCount) {
          bestCount = counts[k];
          bestKey = labels[j];
        }
      }
      out[i] = bestKey;
    }
    return out;
  }

  /**
   * Свернуть массив per-frame меток в сегменты:
   *   [{tStart, tEnd, activeVideoTrack}]
   */
  function labelsToSegments(labels, frameSec) {
    if (!labels || !labels.length) return [];
    var segs = [];
    var curLabel = labels[0];
    var curStart = 0;
    for (var i = 1; i < labels.length; i++) {
      if (labels[i] !== curLabel) {
        segs.push({
          tStart: curStart * frameSec,
          tEnd: i * frameSec,
          activeVideoTrack: curLabel
        });
        curLabel = labels[i];
        curStart = i;
      }
    }
    segs.push({
      tStart: curStart * frameSec,
      tEnd: labels.length * frameSec,
      activeVideoTrack: curLabel
    });
    return segs;
  }

  /**
   * Применить min-hold: если сегмент короче minHoldSec — поглощаем его соседом
   * (предпочитаем предыдущего соседа, если он существует, иначе следующего).
   * Повторяем пока есть короткие сегменты.
   */
  function enforceMinHold(segments, minHoldSec) {
    if (!segments || segments.length <= 1) return segments.slice();
    var out = segments.slice();
    var changed = true;
    var safety = 0;
    while (changed && safety++ < 1000) {
      changed = false;
      for (var i = 0; i < out.length; i++) {
        var dur = out[i].tEnd - out[i].tStart;
        if (dur >= minHoldSec) continue;
        /* поглощаем коротыша */
        if (i > 0) {
          out[i - 1].tEnd = out[i].tEnd;
          out.splice(i, 1);
        } else if (out.length > 1) {
          out[1].tStart = out[0].tStart;
          out.splice(0, 1);
        } else {
          /* единственный сегмент — оставляем как есть */
          break;
        }
        changed = true;
        break;
      }
    }
    return out;
  }

  /**
   * После enforceMinHold могут остаться соседние сегменты с одинаковым
   * activeVideoTrack (если поглощение оставило одно и то же). Сливаем.
   */
  function mergeAdjacentSame(segments) {
    if (!segments || segments.length <= 1) return segments.slice();
    var out = [{ tStart: segments[0].tStart, tEnd: segments[0].tEnd, activeVideoTrack: segments[0].activeVideoTrack }];
    for (var i = 1; i < segments.length; i++) {
      var prev = out[out.length - 1];
      if (prev.activeVideoTrack === segments[i].activeVideoTrack) {
        prev.tEnd = segments[i].tEnd;
      } else {
        out.push({ tStart: segments[i].tStart, tEnd: segments[i].tEnd, activeVideoTrack: segments[i].activeVideoTrack });
      }
    }
    return out;
  }

  /**
   * Snap границ сегментов к ближайшим silence-точкам.
   * silences: [{startSec, endSec}] — интервалы тишины.
   * window: окно поиска (сек). Двигаем границу не более чем на window.
   *
   * Принцип: для каждой границы между сегментами (кроме самых краёв)
   *   - найти ближайшую silence-точку в окне ±window
   *   - если есть — сдвинуть границу
   *   - предпочтение: середина silence-интервала (там точно нет речи)
   */
  function snapToSilences(segments, silences, windowSec) {
    if (!segments || segments.length <= 1) return segments.slice();
    if (!silences || !silences.length || !windowSec) return segments.slice();
    var out = segments.slice().map(function (s) {
      return { tStart: s.tStart, tEnd: s.tEnd, activeVideoTrack: s.activeVideoTrack };
    });
    for (var i = 0; i < out.length - 1; i++) {
      var boundary = out[i].tEnd; /* = out[i+1].tStart */
      var bestPoint = boundary;
      var bestDist = windowSec + 1;
      for (var j = 0; j < silences.length; j++) {
        var sIv = silences[j];
        var mid = (sIv.startSec + sIv.endSec) / 2;
        var d = Math.abs(mid - boundary);
        if (d < bestDist && d <= windowSec) {
          bestDist = d;
          bestPoint = mid;
        }
      }
      /* Сдвигаем границу. */
      out[i].tEnd = bestPoint;
      out[i + 1].tStart = bestPoint;
    }
    return out;
  }

  /**
   * Главная функция Phase 1.
   *
   * Args:
   *   audioFrames: [{tStart, tEnd, rmsByTrack: [r0_dB, r1_dB, ...]}]
   *                массив кадров с RMS по каждому mic'у.
   *                Предполагается, что кадры идут подряд без пропусков
   *                и frameSec соответствует tEnd-tStart.
   *   mapping: {
   *     wideVideoTrack: number,
   *     speakers: [{audioTrack: number, videoTrack: number, label: string}]
   *   }
   *   params: { ...DEFAULTS, можно перезаписывать }
   *   silences: optional [{startSec, endSec}] для snap'а границ
   *
   * Returns: {
   *   segments: [{tStart, tEnd, activeVideoTrack}],
   *   switchCount: number,
   *   stats: { framesAnalyzed, perTrackSeconds: {0: ..., 1: ..., 2: ...} }
   * }
   */
  function buildSwitchPlan(audioFrames, mapping, params, silences) {
    var p = Object.assign({}, DEFAULTS, params || {});
    if (!Array.isArray(audioFrames) || audioFrames.length === 0) {
      return { segments: [], switchCount: 0, stats: { framesAnalyzed: 0, perTrackSeconds: {} } };
    }
    if (!mapping || typeof mapping.wideVideoTrack !== 'number') {
      throw new Error('mapping.wideVideoTrack обязателен (number)');
    }

    /* Шаг 1: per-frame активный mic */
    var labels = new Array(audioFrames.length);
    for (var i = 0; i < audioFrames.length; i++) {
      var f = audioFrames[i];
      var activeMic = decideActiveMic(f.rmsByTrack, p.silenceThresholdDb, p.bleedMarginDb);
      labels[i] = micToVideoTrack(activeMic, mapping, p);
    }

    /* Шаг 2: smoothing */
    labels = smoothLabels(labels, p.smoothingWindow);

    /* Шаг 3: свернуть в сегменты */
    var segments = labelsToSegments(labels, p.frameSec);

    /* Шаг 4: enforce min-hold */
    segments = enforceMinHold(segments, p.minHoldSec);
    segments = mergeAdjacentSame(segments);

    /* Шаг 5: snap к silence-границам */
    if (silences && silences.length && p.snapWindowSec > 0) {
      segments = snapToSilences(segments, silences, p.snapWindowSec);
    }

    /* Статистика */
    var perTrack = {};
    for (var s = 0; s < segments.length; s++) {
      var dur = segments[s].tEnd - segments[s].tStart;
      var k = String(segments[s].activeVideoTrack);
      perTrack[k] = (perTrack[k] || 0) + dur;
    }
    var switchCount = Math.max(0, segments.length - 1);

    return {
      segments: segments,
      switchCount: switchCount,
      stats: {
        framesAnalyzed: audioFrames.length,
        perTrackSeconds: perTrack
      }
    };
  }

  /**
   * Выровнять N per-track RMS-таймлайнов ([{t, rms}], отсортированы по t)
   * на общую сетку кадров шириной frameSec.
   * Значение трека в кадре = последний sample с t <= tEnd кадра (step-hold);
   * до первого sample — floorDb (тихо). Кол-во кадров — по самому длинному треку.
   *
   * Возвращает audioFrames в формате buildSwitchPlan:
   *   [{tStart, tEnd, rmsByTrack:[r0_dB, r1_dB, ...]}]
   */
  function framesFromRmsTimelines(timelines, frameSec, opts) {
    if (!timelines || !timelines.length) return [];
    opts = opts || {};
    var floorDb = typeof opts.floorDb === 'number' ? opts.floorDb : -120;
    var fs = frameSec > 0 ? frameSec : 0.05;
    var eps = 1e-6;

    var maxT = 0;
    for (var ti = 0; ti < timelines.length; ti++) {
      var tl = timelines[ti];
      if (tl && tl.length) {
        var lastT = tl[tl.length - 1].t;
        if (typeof lastT === 'number' && lastT > maxT) maxT = lastT;
      }
    }
    var frameCount = Math.max(1, Math.round(maxT / fs));

    var ptr = [];
    var lastVal = [];
    for (var p = 0; p < timelines.length; p++) { ptr[p] = 0; lastVal[p] = floorDb; }

    var frames = [];
    for (var fi = 0; fi < frameCount; fi++) {
      var tStart = fi * fs;
      var tEnd = tStart + fs;
      var rmsByTrack = [];
      for (var k = 0; k < timelines.length; k++) {
        var tlk = timelines[k] || [];
        while (ptr[k] < tlk.length && tlk[ptr[k]].t <= tEnd + eps) {
          var v = tlk[ptr[k]].rms;
          if (typeof v === 'number' && !isNaN(v)) lastVal[k] = v;
          ptr[k]++;
        }
        rmsByTrack.push(lastVal[k]);
      }
      frames.push({ tStart: tStart, tEnd: tEnd, rmsByTrack: rmsByTrack });
    }
    return frames;
  }

  var api = {
    DEFAULTS: DEFAULTS,
    buildSwitchPlan: buildSwitchPlan,
    framesFromRmsTimelines: framesFromRmsTimelines,
    /* Экспортируем internals для unit-тестов */
    _decideActiveMic: decideActiveMic,
    _micToVideoTrack: micToVideoTrack,
    _smoothLabels: smoothLabels,
    _labelsToSegments: labelsToSegments,
    _enforceMinHold: enforceMinHold,
    _mergeAdjacentSame: mergeAdjacentSame,
    _snapToSilences: snapToSilences
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.MulticamPlan = api;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
