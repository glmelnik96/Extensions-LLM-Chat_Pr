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
    overlapWideMinSec: 1.0,     /* кросс-ток: уходим в wide только если перебивка длится ≥ N сек */
    wideVideoTrack: 0,          /* индекс wide-дорожки */
    maxHoldSec: 8,
    maxAllSpeakersSec: 3,       /* длина вставки в монолог (реальная, а не потолок — 09.2026) */
    bridgeStyle: 'mix',         /* вставка в монолог: 'wide' | 'reaction' (камера собеседника) | 'mix' */
    variationsJitterSec: 0,
    variationsSeed: 1,
    frameOffsetSec: 0
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
   * B2-10 (10 июня 2026): политика кросс-токов.
   * Короткая перебивка («ага», смех, до minFrames кадров) НЕ должна уводить
   * в wide — остаёмся на текущем спикере. Только устойчивый кросс-ток
   * (≥ overlapWideMinSec) переключает на wide. Закрывает главный публичный
   * фейл AutoPod: пинг-понг камер на перекрывающейся речи.
   *
   * micLabels: per-frame результат decideActiveMic (≥0 спикер, -1 тишина, -2 overlap).
   * Короткие runs из -2 заменяем на спикера ПЕРЕД перебивкой (он «держит» план);
   * если перед runs нет спикера (старт записи) — на спикера после.
   */
  function resolveShortOverlaps(micLabels, minFrames) {
    if (!micLabels || micLabels.length === 0 || minFrames <= 1) {
      return micLabels ? micLabels.slice() : micLabels;
    }
    var out = micLabels.slice();
    var i = 0;
    while (i < out.length) {
      if (out[i] !== -2) { i++; continue; }
      var runStart = i;
      while (i < out.length && out[i] === -2) i++;
      var runLen = i - runStart;
      if (runLen >= minFrames) continue; /* устойчивый кросс-ток — wide легитимен */
      /* Спикер перед перебивкой... */
      var repl = -2;
      for (var b = runStart - 1; b >= 0; b--) {
        if (out[b] >= 0) { repl = out[b]; break; }
        if (out[b] === -2) break; /* соседний длинный overlap — не тянем через него */
      }
      /* ...иначе спикер после */
      if (repl < 0) {
        for (var a = i; a < micLabels.length; a++) {
          if (micLabels[a] >= 0) { repl = micLabels[a]; break; }
          if (micLabels[a] === -2) break;
        }
      }
      if (repl >= 0) {
        for (var r = runStart; r < runStart + runLen; r++) out[r] = repl;
      }
    }
    return out;
  }

  /**
   * Mapping: индекс активного mic'а → индекс активной видеодорожки.
   *   activeMic == -1 (silence) → wide
   *   activeMic == -2 (overlap) → wide
   *   activeMic = N → mapping.speakers[N].videoTrack
   */
  function micToVideoTrack(activeMic, mapping, params, lastSpeakerTrack) {
    /* При wideOnSilence/wideOnOverlap=false тишина/перебивка НЕ уводят в общий
       план, а держат последнего спикера (4-й арг). Если спикера ещё не было —
       падаем в wide. Раньше здесь стоял безусловный fallthrough `activeMic < 0
       → wide`, из-за которого флаги false ничего не меняли (мёртвые тумблеры). */
    var hold = (typeof lastSpeakerTrack === 'number') ? lastSpeakerTrack : mapping.wideVideoTrack;
    if (activeMic === -1) return params.wideOnSilence ? mapping.wideVideoTrack : hold;
    if (activeMic === -2) return params.wideOnOverlap ? mapping.wideVideoTrack : hold;
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
    /* Один проход слева-направо, O(n), без потолка итераций.
       Инвариант: каждый сегмент в out (кроме единственного) в итоге ≥ minHold.
       Правила поглощения коротыша:
         - текущий короче minHold → отдаём его время предыдущему (prev расширяется,
           побеждает трек prev — блип уходит к соседу, длинные сегменты не флипаются);
         - предыдущий короче minHold, а текущий длинный (например самый первый
           сегмент оказался коротким) → поглощаем prev в текущий: расширяем назад,
           побеждает трек длинного.
       Прежняя реализация имела safety<1000 (за проход поглощался ровно 1 коротыш):
       на плотном/шумном входе цикл молча обрывался, оставляя тысячи под-minHold
       склеек (покадровый пинг-понг), и был O(n²) из-за рескана с нуля. */
    var out = [{ tStart: segments[0].tStart, tEnd: segments[0].tEnd, activeVideoTrack: segments[0].activeVideoTrack }];
    for (var i = 1; i < segments.length; i++) {
      var seg = segments[i];
      var segDur = seg.tEnd - seg.tStart;
      var prev = out[out.length - 1];
      var prevDur = prev.tEnd - prev.tStart;
      if (segDur < minHoldSec) {
        prev.tEnd = seg.tEnd;
      } else if (prevDur < minHoldSec) {
        prev.tEnd = seg.tEnd;
        prev.activeVideoTrack = seg.activeVideoTrack;
      } else {
        out.push({ tStart: seg.tStart, tEnd: seg.tEnd, activeVideoTrack: seg.activeVideoTrack });
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
   * Tier 3 (11.07.2026): источники привязки границ для мультикама.
   * Из кадров RMS выводит:
   *   silences: [{startSec, endSec}] — интервалы, где никто не говорит (mic == -1);
   *   speechOnsets: [tSec] — моменты, где спикер начинает говорить (переход
   *                 из тишины/перебивки в реального спикера).
   * Раньше snap-to-onset/silence в мультикаме простаивал: не было кто их считает.
   */
  function computeSnapSources(audioFrames, params) {
    var silences = [];
    var speechOnsets = [];
    if (!Array.isArray(audioFrames) || audioFrames.length === 0) {
      return { silences: silences, speechOnsets: speechOnsets };
    }
    var p = params || {};
    var silenceDb = typeof p.silenceThresholdDb === 'number' ? p.silenceThresholdDb : -35;
    var margin = typeof p.bleedMarginDb === 'number' ? p.bleedMarginDb : 6;
    var labels = new Array(audioFrames.length);
    for (var i = 0; i < audioFrames.length; i++) {
      labels[i] = decideActiveMic(audioFrames[i].rmsByTrack, silenceDb, margin);
    }
    var k = 0;
    while (k < labels.length) {
      if (labels[k] === -1) {
        var start = audioFrames[k].tStart;
        while (k < labels.length && labels[k] === -1) k++;
        silences.push({ startSec: start, endSec: audioFrames[k - 1].tEnd });
      } else {
        k++;
      }
    }
    for (var m = 0; m < labels.length; m++) {
      if (labels[m] >= 0 && (m === 0 || labels[m - 1] < 0)) {
        speechOnsets.push(audioFrames[m].tStart);
      }
    }
    return { silences: silences, speechOnsets: speechOnsets };
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
    var micLabels = new Array(audioFrames.length);
    for (var mi = 0; mi < audioFrames.length; mi++) {
      micLabels[mi] = decideActiveMic(audioFrames[mi].rmsByTrack, p.silenceThresholdDb, p.bleedMarginDb);
    }

    /* Шаг 1b: политика кросс-токов — короткая перебивка не уводит в wide */
    if (p.overlapWideMinSec > 0) {
      micLabels = resolveShortOverlaps(micLabels, Math.round(p.overlapWideMinSec / p.frameSec));
    }

    var labels = new Array(audioFrames.length);
    var lastSpeakerTrack = mapping.wideVideoTrack; /* для hold-last-speaker */
    for (var i = 0; i < audioFrames.length; i++) {
      labels[i] = micToVideoTrack(micLabels[i], mapping, p, lastSpeakerTrack);
      if (micLabels[i] >= 0) lastSpeakerTrack = labels[i]; /* обновляем только на реальном спикере */
    }

    /* Шаг 2: smoothing */
    labels = smoothLabels(labels, p.smoothingWindow);

    /* Шаг 3: свернуть в сегменты */
    var segments = labelsToSegments(labels, p.frameSec);

    /* Шаг 4: enforce min-hold */
    segments = enforceMinHold(segments, p.minHoldSec);
    segments = mergeAdjacentSame(segments);

    /* Шаг 4b: enforce max-hold (Wraith Max Camera Duration) — вставки в монолог
       с живым ритмом (09.2026): кандидаты реза = начала фраз + середины пауз. */
    var cutCandidates = [];
    if (Array.isArray(p.cutCandidates) && p.cutCandidates.length) {
      cutCandidates = p.cutCandidates.slice();
    } else {
      var snapSrcMH = computeSnapSources(audioFrames, p);
      cutCandidates = snapSrcMH.speechOnsets.slice();
      for (var cs = 0; cs < snapSrcMH.silences.length; cs++) {
        cutCandidates.push((snapSrcMH.silences[cs].startSec + snapSrcMH.silences[cs].endSec) / 2);
      }
    }
    cutCandidates.sort(function (a, b) { return a - b; });
    var speakerTracksMH = [];
    if (mapping.speakers) {
      for (var spk = 0; spk < mapping.speakers.length; spk++) {
        if (typeof mapping.speakers[spk].videoTrack === 'number') speakerTracksMH.push(mapping.speakers[spk].videoTrack);
      }
    }
    segments = enforceMaxHold(segments, p, mapping.wideVideoTrack, {
      cutCandidates: cutCandidates,
      speakerTracks: speakerTracksMH
    });

    /* Шаг 4c: variations (анти-монотонность, seeded) */
    if (p.variationsJitterSec > 0) {
      segments = applyVariations(segments, p.variationsJitterSec, p.variationsSeed);
    }

    /* Шаг 5: snap границ — приоритет onset'ам речи, fallback на silence */
    if (p.speechOnsets && p.speechOnsets.length && p.snapWindowSec > 0) {
      segments = snapToSpeechOnset(segments, p.speechOnsets, p.snapWindowSec, p.frameOffsetSec || 0);
    } else if (silences && silences.length && p.snapWindowSec > 0) {
      segments = snapToSilences(segments, silences, p.snapWindowSec);
    }

    /* Спикер сегмента (09.2026, для глушения микрофонов молчащих): доминирующий
       микрофон по кадрам сегмента. Вставка в монолог (общий план / камера
       собеседника) наследует говорящего — звук идёт за речью, а не за камерой.
       -1 = никто/перебивка: микрофоны не глушим. */
    for (var si2 = 0; si2 < segments.length; si2++) {
      segments[si2].speaker = dominantMic(micLabels, segments[si2].tStart, segments[si2].tEnd, p.frameSec);
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
   * Доминирующий микрофон на [tStart, tEnd): индекс спикера (≥0), либо -1,
   * если большинство кадров — тишина/перебивка. micLabels — per-frame метки
   * decideActiveMic (после resolveShortOverlaps), frameSec — шаг кадра.
   */
  function dominantMic(micLabels, tStart, tEnd, frameSec) {
    if (!micLabels || !micLabels.length || !(frameSec > 0)) return -1;
    var i0 = Math.max(0, Math.floor(tStart / frameSec + 1e-6));
    var i1 = Math.min(micLabels.length, Math.ceil(tEnd / frameSec - 1e-6));
    if (i1 <= i0) { i0 = Math.min(micLabels.length - 1, i0); i1 = i0 + 1; }
    var counts = {};
    var best = -1, bestN = 0, speechN = 0;
    for (var i = i0; i < i1; i++) {
      var m = micLabels[i];
      if (m < 0) continue;
      speechN++;
      counts[m] = (counts[m] || 0) + 1;
      if (counts[m] > bestN) { bestN = counts[m]; best = m; }
    }
    /* речи меньше трети сегмента — считаем «никто» (пауза/перебивка) */
    if (speechN * 3 < (i1 - i0)) return -1;
    return best;
  }

  /**
   * Выровнять N per-track RMS-таймлайнов ([{t, rms}], отсортированы по t)
   * на общую сетку кадров шириной frameSec.
   * Значение трека в кадре = последний sample с t <= tEnd кадра (step-hold);
   * до первого sample — floorDb (тихо). Кол-во кадров — по самому длинному треку.
   *
   * Допущения:
   *   - Каждый таймлайн обязан быть отсортирован по t по возрастанию;
   *     неупорядоченные данные дадут неопределённый результат.
   *   - tEnd последнего кадра может превышать реальный конец аудио
   *     до одного frameSec, если maxT не кратен frameSec — это допустимо.
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

  /**
   * Разбивает длинные сегменты одной камеры (не-wide), вставляя короткие
   * «вставки» — анти-монотонность Wraith «Max Camera Duration».
   *
   * Ревью 09.2026 (жалоба: «общие планы появляются с одинаковыми интервалами и
   * одинаковой длины»). Раньше вставки были ровно maxHold/4 длиной (слайдер
   * «Длина общего плана» на деле был потолком) и стояли строго через равные
   * промежутки — на таймлайне это читалось как метроном: 8с спикер / 2с общий.
   * Теперь, детерминированно от seed (params.variationsSeed):
   *   • интервал до вставки — случайный в [0.6, 1.0]×maxHold;
   *   • длина вставки — случайная в [0.6, 1.2]×maxAllSpeakersSec (слайдер честный);
   *   • граница вставки притягивается к ближайшей естественной точке реза
   *     (opts.cutCandidates: паузы/начала фраз) в окне ±0.25×maxHold;
   *   • стиль (params.bridgeStyle): 'wide' — общий план; 'reaction' — камера
   *     собеседника (кто говорил перед монологом, иначе следующий, иначе любой
   *     другой спикер из opts.speakerTracks); 'mix' — чередуются случайно.
   *     Без второго спикера reaction деградирует в wide.
   * Хвост после последней вставки не короче 1.5с (иначе вставка не ставится).
   * Wide-сегменты сами не делим (обрезка длинных wide — отдельная мера).
   * maxHoldSec 0/absent = выкл (вход возвращается slice()'ом).
   */
  function enforceMaxHold(segments, params, wideVideoTrack, opts) {
    var p = params || {};
    var o = opts || {};
    var maxHold = typeof p.maxHoldSec === 'number' ? p.maxHoldSec : 0;
    if (!segments || !segments.length || maxHold <= 0) return (segments || []).slice();
    var bridgeBase = typeof p.maxAllSpeakersSec === 'number' && p.maxAllSpeakersSec > 0 ? p.maxAllSpeakersSec : 3;
    if (bridgeBase > maxHold) bridgeBase = maxHold;
    var style = p.bridgeStyle === 'wide' || p.bridgeStyle === 'reaction' ? p.bridgeStyle : 'mix';
    var rand = typeof o.rng === 'function' ? o.rng : _seededRng(typeof p.variationsSeed === 'number' ? p.variationsSeed : 1);
    var candidates = Array.isArray(o.cutCandidates) ? o.cutCandidates : [];
    var MIN_TAIL = 1.5;
    var MIN_CHUNK = 1.0;

    /* Спикерские дорожки: из opts либо из самих сегментов. */
    var speakerTracks = [];
    var seenT = {};
    var srcTracks = Array.isArray(o.speakerTracks) ? o.speakerTracks : [];
    for (var st = 0; st < srcTracks.length; st++) {
      if (srcTracks[st] !== wideVideoTrack && !seenT[srcTracks[st]]) { seenT[srcTracks[st]] = 1; speakerTracks.push(srcTracks[st]); }
    }
    for (var sg = 0; sg < segments.length; sg++) {
      var tr = segments[sg].activeVideoTrack;
      if (tr !== wideVideoTrack && !seenT[tr]) { seenT[tr] = 1; speakerTracks.push(tr); }
    }

    /* Ни один сегмент не нужно делить — возвращаем slice() входа (prototype-chain
       важна для vm-loaded тестов). */
    var anyToSplit = false;
    for (var qi = 0; qi < segments.length; qi++) {
      var qs = segments[qi];
      if (qs.activeVideoTrack !== wideVideoTrack && (qs.tEnd - qs.tStart) > maxHold + bridgeBase) {
        anyToSplit = true; break;
      }
    }
    if (!anyToSplit) return segments.slice();

    /* Естественная точка реза, ближайшая к цели t среди кандидатов в допустимом
       диапазоне [lo, hi]; кандидатов нет — сама цель. Диапазон (а не узкое окно)
       — потому что редактору важно попасть В ПАУЗУ, а не в конкретную секунду. */
    function snapCut(t, lo, hi) {
      var best = t, bestD = Infinity;
      for (var ci = 0; ci < candidates.length; ci++) {
        var c = candidates[ci];
        if (c < lo || c > hi) continue;
        var d = Math.abs(c - t);
        if (d < bestD) { best = c; bestD = d; }
      }
      return best;
    }
    /* Камера собеседника для монолога сегмента i: предыдущий другой спикер,
       иначе следующий, иначе любой другой. Нет → wide. */
    function reactionTrack(i) {
      var own = segments[i].activeVideoTrack;
      for (var b = i - 1; b >= 0; b--) {
        var tb = segments[b].activeVideoTrack;
        if (tb !== wideVideoTrack && tb !== own) return tb;
      }
      for (var a = i + 1; a < segments.length; a++) {
        var ta = segments[a].activeVideoTrack;
        if (ta !== wideVideoTrack && ta !== own) return ta;
      }
      for (var k = 0; k < speakerTracks.length; k++) {
        if (speakerTracks[k] !== own) return speakerTracks[k];
      }
      return wideVideoTrack;
    }
    function pickBridgeTrack(i) {
      if (style === 'wide') return wideVideoTrack;
      var rt = reactionTrack(i);
      if (style === 'reaction') return rt;
      return rand() < 0.5 ? rt : wideVideoTrack;
    }

    var out = [];
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var dur = seg.tEnd - seg.tStart;
      if (seg.activeVideoTrack === wideVideoTrack || dur <= maxHold + bridgeBase) {
        out.push({ tStart: seg.tStart, tEnd: seg.tEnd, activeVideoTrack: seg.activeVideoTrack });
        continue;
      }
      var t = seg.tStart;
      var own = seg.activeVideoTrack;
      var prevBridgeTrack = null;
      while (true) {
        var remaining = seg.tEnd - t;
        if (remaining <= maxHold) break;
        /* Верхняя граница реза: план ≤ maxHold И после вставки (≥0.5с) остаётся
           хвост ≥ MIN_TAIL — иначе инвариант «ни один план длиннее maxHold» ломается. */
        var hiCut = Math.min(t + maxHold, seg.tEnd - MIN_TAIL - 0.5);
        if (hiCut - t < MIN_CHUNK) break;
        /* интервал до вставки: цель в [0.6, 1.0]×maxHold, рез — на паузе в
           диапазоне [0.5×maxHold, hiCut] (ближайшей к цели) */
        var interval = maxHold * (0.6 + 0.4 * rand());
        var cutAt = snapCut(Math.min(t + interval, hiCut), Math.max(t + MIN_CHUNK, t + maxHold * 0.5), hiCut);
        if (cutAt > hiCut) cutAt = hiCut;
        /* длина вставки: цель [0.6, 1.2]×base, конец — на паузе в [0.5с, 1.6×base] */
        var bLen = bridgeBase * (0.6 + 0.6 * rand());
        var bEnd = snapCut(cutAt + bLen, cutAt + 0.5, Math.min(cutAt + bridgeBase * 1.6, seg.tEnd - MIN_TAIL));
        if (bEnd - cutAt < 0.5 || bEnd > seg.tEnd - MIN_TAIL) {
          bEnd = Math.min(cutAt + bLen, seg.tEnd - MIN_TAIL);
          if (bEnd - cutAt < 0.5) bEnd = Math.min(cutAt + 0.5, seg.tEnd - MIN_TAIL);
          if (bEnd - cutAt < 0.5) break;
        }
        var bTrack = pickBridgeTrack(i);
        /* две вставки одной камеры подряд в 'mix' — заменяем на общий план */
        if (style === 'mix' && prevBridgeTrack !== null && bTrack === prevBridgeTrack && bTrack !== wideVideoTrack) bTrack = wideVideoTrack;
        if (bTrack === own) bTrack = wideVideoTrack;
        out.push({ tStart: t, tEnd: cutAt, activeVideoTrack: own });
        out.push({ tStart: cutAt, tEnd: bEnd, activeVideoTrack: bTrack });
        prevBridgeTrack = bTrack;
        t = bEnd;
      }
      out.push({ tStart: t, tEnd: seg.tEnd, activeVideoTrack: own });
    }
    return out;
  }

  /**
   * Простой PRNG mulberry32 для детерминированных variations (Phase 2B).
   * seed → unsigned int32; результат: () => float ∈ [0, 1).
   */
  function _seededRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Анти-монотонность: сдвигает каждую границу между сегментами в [-jitterSec, +jitterSec]
   * детерминированно из seed. Гарантирует, что граница не пересечёт середину
   * соседнего сегмента (чтобы сегмент не схлопнулся).
   */
  function applyVariations(segments, jitterSec, seed) {
    if (!segments || segments.length <= 1) return (segments || []).slice();
    if (!jitterSec || jitterSec <= 0) {
      // Быстрый путь: jitter=0 — возвращаем slice() входа, чтобы сохранить
      // prototype-chain (важно для vm-loaded тестов и deepEqual).
      return segments.slice();
    }
    var rand = _seededRng(seed || 1);
    var out = segments.map(function (s) { return { tStart: s.tStart, tEnd: s.tEnd, activeVideoTrack: s.activeVideoTrack }; });
    for (var i = 0; i < out.length - 1; i++) {
      var delta = (rand() * 2 - 1) * jitterSec;
      var newBoundary = out[i].tEnd + delta;
      var minB = (out[i].tStart + out[i].tEnd) / 2 + 1e-6;
      var maxB = (out[i + 1].tStart + out[i + 1].tEnd) / 2 - 1e-6;
      if (newBoundary < minB) newBoundary = minB;
      if (newBoundary > maxB) newBoundary = maxB;
      out[i].tEnd = newBoundary;
      out[i + 1].tStart = newBoundary;
    }
    return out;
  }

  /**
   * Снап границы к ближайшему началу речи (onset) в окне ±windowSec,
   * со смещением offsetSec («frame offset» в терминологии Wraith).
   * Если onset'ов в окне нет — граница не двигается.
   */
  function snapToSpeechOnset(segments, onsets, windowSec, offsetSec) {
    if (!segments || segments.length <= 1) return (segments || []).slice();
    if (!onsets || !onsets.length || !windowSec || windowSec <= 0) {
      // Быстрый путь: no-op — возвращаем slice() входа, чтобы сохранить
      // prototype-chain (важно для vm-loaded тестов и deepEqual).
      return segments.slice();
    }
    var os = typeof offsetSec === 'number' ? offsetSec : 0;
    var out = segments.map(function (s) { return { tStart: s.tStart, tEnd: s.tEnd, activeVideoTrack: s.activeVideoTrack }; });
    for (var i = 0; i < out.length - 1; i++) {
      var boundary = out[i].tEnd;
      var bestOnset = null;
      var bestDist = windowSec + 1;
      for (var j = 0; j < onsets.length; j++) {
        var d = Math.abs(onsets[j] - boundary);
        if (d < bestDist && d <= windowSec) { bestDist = d; bestOnset = onsets[j]; }
      }
      if (bestOnset !== null) {
        var newB = bestOnset + os;
        out[i].tEnd = newB;
        out[i + 1].tStart = newB;
      }
    }
    return out;
  }

  /**
   * Разбить длинный план applyMulticamCuts на батчи по batchSegments сегментов
   * (2026-07-10): один evalScript на сотни сегментов упирался в 120с-watchdog
   * клиента. Каждый батч — самостоятельный план (version/mapping/params/
   * expectedSequenceName копируются); у всех, кроме последнего,
   * razorTrailingEdge=true — host рэйзорит и tEnd последнего сегмента батча,
   * чтобы следующий батч начинался с готовой границы.
   */
  function splitPlanIntoBatches(plan, opts) {
    if (!plan || !Array.isArray(plan.segments) || plan.segments.length === 0) return [];
    opts = opts || {};
    var size = typeof opts.batchSegments === 'number' && !isNaN(opts.batchSegments)
      ? Math.max(1, Math.floor(opts.batchSegments))
      : 40;
    var batches = [];
    for (var i = 0; i < plan.segments.length; i += size) {
      var chunk = plan.segments.slice(i, i + size);
      var batch = {
        version: plan.version,
        mapping: plan.mapping,
        params: plan.params,
        segments: chunk,
        razorTrailingEdge: i + size < plan.segments.length
      };
      if (plan.expectedSequenceName) batch.expectedSequenceName = plan.expectedSequenceName;
      batches.push(batch);
    }
    return batches;
  }

  var api = {
    DEFAULTS: DEFAULTS,
    buildSwitchPlan: buildSwitchPlan,
    framesFromRmsTimelines: framesFromRmsTimelines,
    computeSnapSources: computeSnapSources,
    splitPlanIntoBatches: splitPlanIntoBatches,
    /* Экспортируем internals для unit-тестов */
    _decideActiveMic: decideActiveMic,
    _resolveShortOverlaps: resolveShortOverlaps,
    _micToVideoTrack: micToVideoTrack,
    _smoothLabels: smoothLabels,
    _labelsToSegments: labelsToSegments,
    _enforceMinHold: enforceMinHold,
    _mergeAdjacentSame: mergeAdjacentSame,
    _snapToSilences: snapToSilences,
    _enforceMaxHold: enforceMaxHold,
    _dominantMic: dominantMic,
    _applyVariations: applyVariations,
    _snapToSpeechOnset: snapToSpeechOnset
  };

  /* CEP с --enable-nodejs имеет `module` в browser-context, поэтому CommonJS-fallback
     ломал бы window.MulticamPlan. Привязываемся к global напрямую — vm-loader тестов
     передаёт ctx как global и читает ctx.MulticamPlan. */
  global.MulticamPlan = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
