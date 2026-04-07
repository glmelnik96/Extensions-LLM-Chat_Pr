/**
 * Adobe Premiere Pro 2025+ ExtendScript host
 * https://ppro-scripting.docsforadobe.dev/
 *
 * Соответствие API (см. официальный Scripting Guide):
 * - getTimelineSnapshot: Sequence.videoTracks/audioTracks → TrackItem.start/end/inPoint/outPoint, nodeId
 * - applyTimecodeEdits: TrackItem.remove(ripple, align) — ripple-delete; in/out через присвоение .seconds
 * - ripple_delete_range: split средней части клипа через Track.insertClip(projectItem, time, …) + подгонка in/out
 * - applyTranscriptCuts: тот же механизм вырезания интервалов
 * - addSequenceMarkers: createMarker(String(Math.round(sec * timebase))); lift/ripple через remove(0|1,1)
 * - move_clip: по умолчанию ripple-insert (все start >= newStartSec += dur), затем установка клипа; shift_timeline_ripple
 * - exportInOutAudio: Sequence.exportAsMediaDirect(path, preset, ENCODE_IN_TO_OUT)
 * - undoLast: app.findMenuCommandId + app.executeCommand (локализованные названия меню)
 */
if (typeof $._EXT_PRM_ === 'undefined') {
  $._EXT_PRM_ = {};
}

$._EXT_PRM_.version = '2.4.7';

$._EXT_PRM_._EPS = 0.04;

/**
 * Тики на секунде для активной секвенции (timebase в тиках/сек, см. getTimelineSnapshot).
 * Fallback ~25 fps, если timebase недоступен.
 */
$._EXT_PRM_._ticksPerSecond = function (seq) {
  var tb = parseFloat(seq.timebase);
  if (!tb || isNaN(tb)) tb = 10160640000;
  return tb;
};

/** Конвертация секунд → строка тиков (insertClip и др.). */
$._EXT_PRM_._ticksStr = function (seq, sec) {
  return String(Math.round(sec * $._EXT_PRM_._ticksPerSecond(seq)));
};

$._EXT_PRM_._clipTimes = function (clip) {
  return {
    s: clip.start.seconds,
    e: clip.end.seconds,
    srcIn: clip.inPoint.seconds,
    srcOut: clip.outPoint.seconds
  };
};

$._EXT_PRM_._findClipByNodeId = function (seq, nodeId) {
  var id = String(nodeId);
  var vi,
    ai,
    j,
    tr,
    it,
    n,
    found = null;
  for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
    tr = seq.videoTracks[vi];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (it && String(it.nodeId) === id) {
          return { clip: it, isVideo: true, trackIndex: vi };
        }
      } catch (e0) {}
    }
  }
  for (ai = 0; ai < seq.audioTracks.numTracks; ai++) {
    tr = seq.audioTracks[ai];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (it && String(it.nodeId) === id) {
          return { clip: it, isVideo: false, trackIndex: ai };
        }
      } catch (e1) {}
    }
  }
  return null;
};

$._EXT_PRM_._findClipAtTimelineStart = function (seq, isVideo, trackIndex, targetSec, epsOverride) {
  var tr = isVideo ? seq.videoTracks[trackIndex] : seq.audioTracks[trackIndex];
  var eps = typeof epsOverride === 'number' ? epsOverride : $._EXT_PRM_._EPS;
  var j,
    n = tr.clips.numItems,
    it,
    best = null,
    bestD = 1e9;
  for (j = 0; j < n; j++) {
    try {
      it = tr.clips[j];
      if (!it) continue;
      var d = Math.abs(it.start.seconds - targetSec);
      if (d < eps && d < bestD) {
        bestD = d;
        best = it;
      }
    } catch (e2) {}
  }
  return best;
};

/**
 * Удалить клип и все связанные (linked A/V) по nodeId.
 * Ищет клип по nodeId, затем удаляет ВСЕ клипы с тем же именем и позицией на всех дорожках.
 */
$._EXT_PRM_._removeClipAndLinked = function (seq, nodeId) {
  var found = $._EXT_PRM_._findClipByNodeId(seq, nodeId);
  if (!found) return { ok: false, error: 'Клип не найден: ' + nodeId };
  var clip = found.clip;
  var name = clip.name || '';
  var s = clip.start.seconds;
  var e = clip.end.seconds;
  var eps = $._EXT_PRM_._EPS;
  var toRemove = [];
  var vi, ai, j, tr, it, n;
  for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
    tr = seq.videoTracks[vi];
    n = tr.clips.numItems;
    for (j = n - 1; j >= 0; j--) {
      try {
        it = tr.clips[j];
        if (!it) continue;
        if (it.name === name && Math.abs(it.start.seconds - s) < eps && Math.abs(it.end.seconds - e) < eps) {
          toRemove.push(it);
        }
      } catch (e0) {}
    }
  }
  for (ai = 0; ai < seq.audioTracks.numTracks; ai++) {
    tr = seq.audioTracks[ai];
    n = tr.clips.numItems;
    for (j = n - 1; j >= 0; j--) {
      try {
        it = tr.clips[j];
        if (!it) continue;
        if (it.name === name && Math.abs(it.start.seconds - s) < eps && Math.abs(it.end.seconds - e) < eps) {
          toRemove.push(it);
        }
      } catch (e1) {}
    }
  }
  var removed = [];
  for (var k = 0; k < toRemove.length; k++) {
    try {
      toRemove[k].remove(1, 1);
      removed.push(String(toRemove[k].nodeId));
    } catch (eR) {}
  }
  return { ok: true, removed: removed, count: removed.length };
};

$._EXT_PRM_._collectIntersecting = function (seq, t0, t1) {
  var out = [];
  var vi,
    ai,
    j,
    tr,
    it,
    n,
    s,
    e;
  function pushClip(isVideo, idx, clip, startSec, endSec) {
    out.push({
      clip: clip,
      isVideo: isVideo,
      trackIndex: idx,
      start: startSec,
      end: endSec
    });
  }
  for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
    tr = seq.videoTracks[vi];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (!it) continue;
        s = it.start.seconds;
        e = it.end.seconds;
        if (e - $._EXT_PRM_._EPS <= t0 || s + $._EXT_PRM_._EPS >= t1) continue;
        pushClip(true, vi, it, s, e);
      } catch (e3) {}
    }
  }
  for (ai = 0; ai < seq.audioTracks.numTracks; ai++) {
    tr = seq.audioTracks[ai];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (!it) continue;
        s = it.start.seconds;
        e = it.end.seconds;
        if (e - $._EXT_PRM_._EPS <= t0 || s + $._EXT_PRM_._EPS >= t1) continue;
        pushClip(false, ai, it, s, e);
      } catch (e4) {}
    }
  }
  return out;
};

/**
 * Конвертация секунд в таймкод HH:MM:SS;FF для QE DOM razor().
 */
$._EXT_PRM_._secToTimecode = function (sec, fps) {
  if (!fps || fps <= 0) fps = 24;
  var totalFrames = Math.round(sec * fps);
  var ff = totalFrames % fps;
  var ss = Math.floor(totalFrames / fps) % 60;
  var mm = Math.floor(totalFrames / (fps * 60)) % 60;
  var hh = Math.floor(totalFrames / (fps * 3600));
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ';' + pad(ff);
};

/**
 * Удаляет содержимое интервала [t0,t1] на всех дорожках.
 *
 * Стратегия (из AutoPod): QE DOM razor() для разрезания, затем clip.remove() для удаления.
 * ripple === false → lift (remove(0,1)), дыра на таймлайне остаётся; true → ripple (remove(1,1)).
 * Если QE DOM недоступен — fallback на trim outPoint/inPoint (lift только для полного удаления клипа в интервале).
 * Никогда не используем insertClip (он создаёт дубликаты).
 */
$._EXT_PRM_._applyOneTimelineInterval = function (seq, t0, t1, log, ripple) {
  var doRipple = ripple !== false;
  var ripFlag = doRipple ? 1 : 0;
  var eps = $._EXT_PRM_._EPS;

  /* --- Определяем FPS для таймкода QE --- */
  var fps = 24;
  try {
    var tb = parseFloat(seq.timebase);
    if (tb > 0) fps = Math.round(254016000000 / tb);
  } catch (eF) {}

  /* --- Пробуем QE DOM razor (как AutoPod) --- */
  var qeAvailable = false;
  var qeSeq = null;
  try {
    if (typeof qe !== 'undefined' && qe.project && typeof qe.project.getActiveSequence === 'function') {
      qeSeq = qe.project.getActiveSequence();
      if (qeSeq) qeAvailable = true;
    }
  } catch (eQE) {}

  if (qeAvailable) {
    /* ===== СТРАТЕГИЯ QE RAZOR (надёжная, без дубликатов) =====
     *
     * 1. razor на t0 и t1 на ВСЕХ дорожках — это создаёт точки разреза,
     *    разбивая клипы на 3 части: [s,t0], [t0,t1], [t1,e]
     * 2. Удаляем фрагменты, попадающие в [t0,t1] через clip.remove(1,1)
     */
    var tc0 = $._EXT_PRM_._secToTimecode(t0, fps);
    var tc1 = $._EXT_PRM_._secToTimecode(t1, fps);
    var vi, ai, numV, numA;

    /* Razor на всех видео- и аудиодорожках */
    try { numV = qeSeq.numVideoTracks; } catch (eNV) { numV = 0; }
    try { numA = qeSeq.numAudioTracks; } catch (eNA) { numA = 0; }
    for (vi = 0; vi < numV; vi++) {
      try {
        var vt = qeSeq.getVideoTrackAt(vi);
        vt.razor(tc0, true, true);
        vt.razor(tc1, true, true);
      } catch (eVR) {}
    }
    for (ai = 0; ai < numA; ai++) {
      try {
        var at = qeSeq.getAudioTrackAt(ai);
        at.razor(tc0, true, true);
        at.razor(tc1, true, true);
      } catch (eAR) {}
    }

    /* Теперь находим и удаляем все клипы, которые попадают в [t0,t1] */
    /* Итерируем в обратном порядке чтобы индексы не сбивались при удалении */
    var removed = 0;
    for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
      var vTrack = seq.videoTracks[vi];
      for (var j = vTrack.clips.numItems - 1; j >= 0; j--) {
        try {
          var c = vTrack.clips[j];
          if (!c) continue;
          var cs = c.start.seconds;
          var ce = c.end.seconds;
          /* Клип целиком внутри [t0, t1] (с допуском eps) */
          if (cs >= t0 - eps && ce <= t1 + eps) {
            c.remove(ripFlag, 1);
            removed++;
          }
        } catch (eVC) {}
      }
    }
    for (ai = 0; ai < seq.audioTracks.numTracks; ai++) {
      var aTrack = seq.audioTracks[ai];
      for (var k = aTrack.clips.numItems - 1; k >= 0; k--) {
        try {
          var ac = aTrack.clips[k];
          if (!ac) continue;
          var as2 = ac.start.seconds;
          var ae = ac.end.seconds;
          if (as2 >= t0 - eps && ae <= t1 + eps) {
            ac.remove(ripFlag, 1);
            removed++;
          }
        } catch (eAC) {}
      }
    }
    log.push({ op: doRipple ? 'qe_razor_delete' : 'qe_razor_lift', t0: t0, t1: t1, removed: removed, ripple: doRipple });
    return;
  }

  /* ===== FALLBACK: trim без insertClip (если QE недоступен) =====
   * Не используем insertClip — он создаёт дубликаты.
   * Для Case 4 (середина) — обрезаем только левую часть (до t0).
   * Правая часть остаётся необрезанной. Пользователь получит предупреждение.
   */
  var batch = $._EXT_PRM_._collectIntersecting(seq, t0, t1);
  if (!batch.length) return;

  batch.sort(function (a, b) { return b.start - a.start; });

  var i, ctx, clip, s, e, i0, i1, T, srcIn, srcOut, isVideo;
  for (i = 0; i < batch.length; i++) {
    ctx = batch[i];
    clip = ctx.clip;
    isVideo = ctx.isVideo;

    try { s = clip.start.seconds; e = clip.end.seconds; } catch (eDead) { continue; }
    if (e <= s + eps) continue;

    i0 = Math.max(t0, s);
    i1 = Math.min(t1, e);
    if (i1 - i0 <= eps) continue;

    T = $._EXT_PRM_._clipTimes(clip);
    srcIn = T.srcIn;

    /* Case 1: клип целиком внутри [t0,t1] → удалить (ripple или lift) */
    if (i0 <= s + eps && i1 >= e - eps) {
      try { clip.remove(ripFlag, 1); } catch (eR) {}
      log.push({ op: doRipple ? 'remove_clip_ripple' : 'remove_clip_lift', nodeId: String(clip.nodeId) });
      continue;
    }

    /* Case 2: отрезает начало клипа */
    if (i0 <= s + eps && i1 < e - eps) {
      clip.inPoint.seconds = srcIn + (i1 - s);
      if (Math.abs(clip.start.seconds - i1) > eps) clip.start.seconds = i1;
      log.push({ op: 'trim_prefix', nodeId: String(clip.nodeId), newStartSec: i1 });
      continue;
    }

    /* Case 3: отрезает конец клипа */
    if (i0 > s + eps && i1 >= e - eps) {
      clip.outPoint.seconds = srcIn + (i0 - s);
      if (Math.abs(clip.end.seconds - i0) > eps) clip.end.seconds = i0;
      log.push({ op: 'trim_suffix', nodeId: String(clip.nodeId), newEndSec: i0 });
      continue;
    }

    /* Case 4: середина — без QE только обрезка до t0 (правая часть потеряна) */
    if (i0 > s + eps && i1 < e - eps) {
      clip.outPoint.seconds = srcIn + (i0 - s);
      if (Math.abs(clip.end.seconds - i0) > eps) clip.end.seconds = i0;
      log.push({ op: 'trim_suffix_no_split', nodeId: String(clip.nodeId), newEndSec: i0,
        warn: 'QE DOM недоступен — правая часть клипа после ' + i1.toFixed(2) + ' с потеряна. Включите QE DOM.' });
      continue;
    }
  }
};

/**
 * Найти все клипы с тем же именем и позицией (linked A/V пара).
 */
$._EXT_PRM_._findLinkedClips = function (seq, clip) {
  /* Канонический путь PP: TrackItem.getLinkedItems() — возвращает массив реально
     связанных клипов (A/V пары), вне зависимости от имени и таймкодов. */
  var result = [clip];
  var seen = {};
  try { seen[String(clip.nodeId)] = true; } catch (eN0) {}
  try {
    if (typeof clip.getLinkedItems === 'function') {
      var linked = clip.getLinkedItems();
      if (linked && linked.numItems !== undefined) {
        for (var li = 0; li < linked.numItems; li++) {
          var lit = linked[li];
          if (!lit) continue;
          var lid = String(lit.nodeId);
          if (!seen[lid]) { seen[lid] = true; result.push(lit); }
        }
        if (result.length > 1) return result;
      } else if (linked && linked.length) {
        for (var lj = 0; lj < linked.length; lj++) {
          var lit2 = linked[lj];
          if (!lit2) continue;
          var lid2 = String(lit2.nodeId);
          if (!seen[lid2]) { seen[lid2] = true; result.push(lit2); }
        }
        if (result.length > 1) return result;
      }
    }
  } catch (eGL) {}

  /* Fallback (для самых старых сборок без getLinkedItems): эвристика
     name+start+end. ВНИМАНИЕ: ненадёжно — может включить независимый клип
     с тем же source media, который случайно стоит на той же позиции. */
  var name = clip.name || '';
  var s = 0, e = 0;
  try { s = clip.start.seconds; e = clip.end.seconds; } catch (eSE) { return result; }
  var eps = $._EXT_PRM_._EPS;
  var vi, ai, j, tr, it, n;
  for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
    tr = seq.videoTracks[vi];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (!it) continue;
        var idV = String(it.nodeId);
        if (seen[idV]) continue;
        if (it.name === name && Math.abs(it.start.seconds - s) < eps && Math.abs(it.end.seconds - e) < eps) {
          seen[idV] = true;
          result.push(it);
        }
      } catch (e0) {}
    }
  }
  for (ai = 0; ai < seq.audioTracks.numTracks; ai++) {
    tr = seq.audioTracks[ai];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (!it) continue;
        var idA = String(it.nodeId);
        if (seen[idA]) continue;
        if (it.name === name && Math.abs(it.start.seconds - s) < eps && Math.abs(it.end.seconds - e) < eps) {
          seen[idA] = true;
          result.push(it);
        }
      } catch (e1) {}
    }
  }
  return result;
};

/**
 * Все клипы на секвенции с точным совпадением отображаемого имени (все дорожки).
 */
$._EXT_PRM_._findClipsByDisplayName = function (seq, clipName) {
  var want = String(clipName || '');
  var out = [];
  var vi, ai, j, tr, it, n;
  for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
    tr = seq.videoTracks[vi];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (it && String(it.name) === want) out.push(it);
      } catch (e0) {}
    }
  }
  for (ai = 0; ai < seq.audioTracks.numTracks; ai++) {
    tr = seq.audioTracks[ai];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (it && String(it.name) === want) out.push(it);
      } catch (e1) {}
    }
  }
  return out;
};

/**
 * Сдвинуть вправо на deltaSec все клипы, пересекающие [rangeStart, rangeEnd),
 * кроме исключённых по nodeId (связка переносимого клипа). Сортировка справа налево.
 */
$._EXT_PRM_._shiftClipsOverlappingRangeRight = function (seq, rangeStart, rangeEnd, deltaSec, excludeNodeIdSet) {
  var eps = $._EXT_PRM_._EPS;
  var items = [];
  var vi,
    ai,
    j,
    tr,
    it,
    n,
    s,
    e;
  function pushClip(clip) {
    var id = String(clip.nodeId);
    if (excludeNodeIdSet[id]) return;
    try {
      s = clip.start.seconds;
      e = clip.end.seconds;
    } catch (e0) {
      return;
    }
    if (e <= rangeStart + eps || s >= rangeEnd - eps) return;
    if (s < rangeEnd - eps && e > rangeStart + eps) items.push(clip);
  }
  for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
    tr = seq.videoTracks[vi];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (it) pushClip(it);
      } catch (e1) {}
    }
  }
  for (ai = 0; ai < seq.audioTracks.numTracks; ai++) {
    tr = seq.audioTracks[ai];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (it) pushClip(it);
      } catch (e2) {}
    }
  }
  var scored = [];
  for (var k = 0; k < items.length; k++) {
    try {
      scored.push({ clip: items[k], s: items[k].start.seconds });
    } catch (e3) {}
  }
  scored.sort(function (a, b) {
    return b.s - a.s;
  });
  var log = [];
  for (var m = 0; m < scored.length; m++) {
    var c = scored[m].clip;
    try {
      var ns = c.start.seconds + deltaSec;
      var ne = c.end.seconds + deltaSec;
      c.start.seconds = ns;
      c.end.seconds = ne;
      log.push({ nodeId: String(c.nodeId), newStartSec: ns, newEndSec: ne });
    } catch (eMv) {}
  }
  return log;
};

/**
 * Ripple: сдвинуть вправо на deltaSec все клипы с start >= fromSec (кроме exclude по nodeId).
 * Порядок справа налево. Нужен для move_clip: иначе сдвиг только пересекающих [0,L] заводит длинный клип на соседний.
 * @returns {Array} лог { nodeId, newStartSec, newEndSec }
 */
$._EXT_PRM_._rippleShiftAllClipsFrom = function (seq, fromSec, deltaSec, excludeNodeIdSet) {
  var eps = $._EXT_PRM_._EPS;
  if (!seq || typeof fromSec !== 'number' || typeof deltaSec !== 'number' || deltaSec === 0) return [];
  var ex = excludeNodeIdSet || {};
  var items = [];
  var vi,
    ai,
    j,
    tr,
    it,
    n,
    s0;
  function consider(clip) {
    var id = String(clip.nodeId);
    if (ex[id]) return;
    try {
      s0 = clip.start.seconds;
    } catch (e0) {
      return;
    }
    if (s0 < fromSec - eps) return;
    items.push(clip);
  }
  for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
    tr = seq.videoTracks[vi];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (it) consider(it);
      } catch (e1) {}
    }
  }
  for (ai = 0; ai < seq.audioTracks.numTracks; ai++) {
    tr = seq.audioTracks[ai];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (it) consider(it);
      } catch (e2) {}
    }
  }
  var scored = [];
  for (var k = 0; k < items.length; k++) {
    try {
      scored.push({ clip: items[k], s: items[k].start.seconds });
    } catch (e3) {}
  }
  scored.sort(function (a, b) {
    return b.s - a.s;
  });
  var log = [];
  for (var m = 0; m < scored.length; m++) {
    var c = scored[m].clip;
    try {
      var ns = c.start.seconds + deltaSec;
      var ne = c.end.seconds + deltaSec;
      c.start.seconds = ns;
      c.end.seconds = ne;
      log.push({ nodeId: String(c.nodeId), newStartSec: ns, newEndSec: ne });
    } catch (eMv) {}
  }
  return log;
};

$._EXT_PRM_._setTimelineIn = function (found, newStartSec) {
  var clip = found.clip;
  var s = clip.start.seconds;
  var e = clip.end.seconds;
  if (newStartSec <= s + $._EXT_PRM_._EPS || newStartSec >= e - $._EXT_PRM_._EPS) {
    return { ok: false, error: 'set_timeline_in вне диапазона клипа (' + s.toFixed(2) + '–' + e.toFixed(2) + '), timeSec=' + newStartSec.toFixed(2) };
  }
  var seq = app.project.activeSequence;
  var linked = seq ? $._EXT_PRM_._findLinkedClips(seq, clip) : [clip];
  var delta = newStartSec - s;
  for (var k = 0; k < linked.length; k++) {
    try {
      /* Premiere: end = start + (outPoint - inPoint).
         Для trim-left: увеличиваем inPoint → Premiere сокращает clip с начала.
         Затем двигаем start на новую позицию. */
      var c = linked[k];
      var newIn = c.inPoint.seconds + delta;
      c.inPoint.seconds = newIn;
      /* Premiere может автоматически скорректировать start/end.
         Если start не сместился — двигаем вручную: */
      if (Math.abs(c.start.seconds - newStartSec) > $._EXT_PRM_._EPS) {
        c.start.seconds = newStartSec;
      }
    } catch (eL) {}
  }
  return { ok: true, trimmedClips: linked.length };
};

$._EXT_PRM_._setTimelineOut = function (found, newEndSec) {
  var clip = found.clip;
  var s = clip.start.seconds;
  var e = clip.end.seconds;
  if (newEndSec >= e - $._EXT_PRM_._EPS || newEndSec <= s + $._EXT_PRM_._EPS) {
    return { ok: false, error: 'set_timeline_out вне диапазона клипа (' + s.toFixed(2) + '–' + e.toFixed(2) + '), timeSec=' + newEndSec.toFixed(2) };
  }
  var seq = app.project.activeSequence;
  var linked = seq ? $._EXT_PRM_._findLinkedClips(seq, clip) : [clip];
  var delta = e - newEndSec;
  for (var k = 0; k < linked.length; k++) {
    try {
      /* Premiere: end = start + (outPoint - inPoint).
         Для trim-right: уменьшаем outPoint → Premiere сокращает clip с конца. */
      var c = linked[k];
      c.outPoint.seconds = c.outPoint.seconds - delta;
      /* Если end не скорректировался — поправляем вручную: */
      if (Math.abs(c.end.seconds - newEndSec) > $._EXT_PRM_._EPS) {
        c.end.seconds = newEndSec;
      }
    } catch (eL) {}
  }
  return { ok: true, trimmedClips: linked.length };
};

$._EXT_PRM_.getTimelineSnapshot = function () {
  function ticksToSeconds(ticks, timebase) {
    if (!timebase || timebase === 0) return 0;
    return ticks / timebase;
  }
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    }
    var seq = app.project.activeSequence;
    var tb = seq.timebase;

    /* --- Мета-информация секвенции --- */
    var playheadSec = 0;
    try { playheadSec = seq.getPlayerPosition().seconds; } catch (ePH) {}
    var seqEndSec = 0;
    try { seqEndSec = seq.end.seconds || 0; } catch (eE) {}
    var seqInSec = null, seqOutSec = null;
    try { seqInSec = parseFloat(seq.getInPoint()); if (isNaN(seqInSec)) seqInSec = null; } catch (eI) {}
    try { seqOutSec = parseFloat(seq.getOutPoint()); if (isNaN(seqOutSec)) seqOutSec = null; } catch (eO) {}
    var fps = 0;
    try {
      var fW = seq.frameSizeHorizontal || 0;
      var fH = seq.frameSizeVertical || 0;
      /* videoDisplayFormat: 0=24, 1=25, 2=29.97df, ... — ненадёжно, вычисляем из timebase */
      fps = tb > 0 ? Math.round(254016000000 / tb * 100) / 100 : 0;
    } catch (eFps) {}

    /* --- Дорожки --- */
    var tracks = [];
    var vi, ti, track, item, j, n;
    for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
      track = seq.videoTracks[vi];
      var vMuted = false;
      try { vMuted = track.isMuted() ? true : false; } catch (eM) {}
      tracks.push({ type: 'video', index: vi, name: track.name || ('V' + (vi + 1)), muted: vMuted, clipCount: track.clips.numItems });
    }
    for (ti = 0; ti < seq.audioTracks.numTracks; ti++) {
      track = seq.audioTracks[ti];
      var aMuted = false;
      try { aMuted = track.isMuted() ? true : false; } catch (eM2) {}
      tracks.push({ type: 'audio', index: ti, name: track.name || ('A' + (ti + 1)), muted: aMuted, clipCount: track.clips.numItems });
    }

    /* --- Клипы --- */
    var clips = [];
    for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
      track = seq.videoTracks[vi];
      n = track.clips.numItems;
      for (j = 0; j < n; j++) {
        try {
          item = track.clips[j];
          if (!item) continue;
          var vDisabled = false;
          try { vDisabled = item.disabled ? true : false; } catch (eD) {}
          clips.push({
            trackIndex: vi,
            trackType: 'video',
            name: item.name || '',
            nodeId: String(item.nodeId),
            startSec: item.start.seconds,
            endSec: item.end.seconds,
            durationSec: item.end.seconds - item.start.seconds,
            inPointSec: item.inPoint ? item.inPoint.seconds : null,
            outPointSec: item.outPoint ? item.outPoint.seconds : null,
            disabled: vDisabled
          });
        } catch (e5) {}
      }
    }
    for (ti = 0; ti < seq.audioTracks.numTracks; ti++) {
      track = seq.audioTracks[ti];
      n = track.clips.numItems;
      for (j = 0; j < n; j++) {
        try {
          item = track.clips[j];
          if (!item) continue;
          var aDisabled = false;
          try { aDisabled = item.disabled ? true : false; } catch (eD2) {}
          clips.push({
            trackIndex: ti,
            trackType: 'audio',
            name: item.name || '',
            nodeId: String(item.nodeId),
            startSec: item.start.seconds,
            endSec: item.end.seconds,
            durationSec: item.end.seconds - item.start.seconds,
            inPointSec: item.inPoint ? item.inPoint.seconds : null,
            outPointSec: item.outPoint ? item.outPoint.seconds : null,
            disabled: aDisabled
          });
        } catch (e6) {}
      }
    }
    return JSON.stringify({
      ok: true,
      sequenceName: seq.name,
      timebase: tb,
      fps: fps,
      frameSizeH: seq.frameSizeHorizontal || 0,
      frameSizeV: seq.frameSizeVertical || 0,
      playheadSec: playheadSec,
      sequenceEndSec: seqEndSec,
      sequenceInSec: seqInSec,
      sequenceOutSec: seqOutSec,
      videoTrackCount: seq.videoTracks.numTracks,
      audioTrackCount: seq.audioTracks.numTracks,
      tracks: tracks,
      hostVersion: $._EXT_PRM_.version,
      clips: clips
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

$._EXT_PRM_.applyTimecodeEdits = function (jsonPlan) {
  var undoOpened = false;
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    }
    var seq = app.project.activeSequence;
    var plan = JSON.parse(jsonPlan);
    if (typeof app.beginUndoGroup === 'function') {
      app.beginUndoGroup('ИИ: таймкоды');
      undoOpened = true;
    }
    var ops = plan.operations || [];
    var results = [];
    var i,
      op,
      found,
      r,
      a,
      b;

    for (i = 0; i < ops.length; i++) {
      op = ops[i];
      a = op.action;

      if (a === 'ripple_delete_range' || a === 'ripple_delete_range_all_tracks') {
        if (typeof op.startSec !== 'number' || typeof op.endSec !== 'number') {
          results.push({ op: a, ok: false, error: 'Нужны startSec и endSec' });
          continue;
        }
        if (op.endSec <= op.startSec) {
          results.push({ op: a, ok: false, error: 'endSec должен быть > startSec' });
          continue;
        }
        var lgR = [];
        $._EXT_PRM_._applyOneTimelineInterval(seq, op.startSec, op.endSec, lgR, true);
        results.push({ op: a, ok: true, log: lgR });
        continue;
      }

      if (a === 'lift_delete_range' || a === 'lift_delete_range_all_tracks') {
        if (typeof op.startSec !== 'number' || typeof op.endSec !== 'number') {
          results.push({ op: a, ok: false, error: 'Нужны startSec и endSec' });
          continue;
        }
        if (op.endSec <= op.startSec) {
          results.push({ op: a, ok: false, error: 'endSec должен быть > startSec' });
          continue;
        }
        var lgL = [];
        $._EXT_PRM_._applyOneTimelineInterval(seq, op.startSec, op.endSec, lgL, false);
        results.push({ op: a, ok: true, log: lgL });
        continue;
      }

      if (a === 'remove_clip') {
        var rmResult = $._EXT_PRM_._removeClipAndLinked(seq, op.nodeId);
        results.push({ op: a, ok: rmResult.ok, detail: rmResult });
        continue;
      }

      /* --- shift_timeline_ripple: сдвинуть вправо все клипы с start >= fromSec --- */
      if (a === 'shift_timeline_ripple') {
        if (typeof op.fromSec !== 'number' || typeof op.deltaSec !== 'number') {
          results.push({ op: a, ok: false, error: 'Нужны fromSec и deltaSec (числа)' });
          continue;
        }
        if (op.deltaSec <= 0) {
          results.push({ op: a, ok: false, error: 'deltaSec должен быть > 0 (сдвиг вправо)' });
          continue;
        }
        var exRip = {};
        if (op.excludeNodeIds && op.excludeNodeIds.length) {
          for (var xr = 0; xr < op.excludeNodeIds.length; xr++) {
            exRip[String(op.excludeNodeIds[xr])] = true;
          }
        }
        var ripLog = $._EXT_PRM_._rippleShiftAllClipsFrom(seq, op.fromSec, op.deltaSec, exRip);
        results.push({ op: a, ok: true, shifted: ripLog, count: ripLog.length });
        continue;
      }

      if (a === 'set_timeline_in' || a === 'trim_to_timeline_in') {
        found = $._EXT_PRM_._findClipByNodeId(seq, op.nodeId);
        if (!found) {
          results.push({ op: a, ok: false, error: 'Клип не найден' });
          continue;
        }
        r = $._EXT_PRM_._setTimelineIn(found, op.timeSec);
        results.push({ op: a, ok: r.ok, detail: r });
        continue;
      }

      if (a === 'set_timeline_out' || a === 'trim_to_timeline_out') {
        found = $._EXT_PRM_._findClipByNodeId(seq, op.nodeId);
        if (!found) {
          results.push({ op: a, ok: false, error: 'Клип не найден' });
          continue;
        }
        r = $._EXT_PRM_._setTimelineOut(found, op.timeSec);
        results.push({ op: a, ok: r.ok, detail: r });
        continue;
      }

      if (a === 'set_timeline_bounds') {
        found = $._EXT_PRM_._findClipByNodeId(seq, op.nodeId);
        if (!found) {
          results.push({ op: a, ok: false, error: 'Клип не найден' });
          continue;
        }
        r = $._EXT_PRM_._setTimelineIn(found, op.startSec);
        if (!r.ok) {
          results.push({ op: a, ok: false, step: 'in', detail: r });
          continue;
        }
        found = $._EXT_PRM_._findClipByNodeId(seq, op.nodeId);
        if (!found) {
          results.push({ op: a, ok: false, error: 'Клип потерян после trim in' });
          continue;
        }
        r = $._EXT_PRM_._setTimelineOut(found, op.endSec);
        results.push({ op: a, ok: r.ok, step: 'out', detail: r });
        continue;
      }

      /* --- set_clip_enabled: включить/выключить клип (non-destructive, от AutoPod) --- */
      if (a === 'set_clip_enabled') {
        found = $._EXT_PRM_._findClipByNodeId(seq, op.nodeId);
        if (!found) {
          results.push({ op: a, ok: false, error: 'Клип не найден: ' + op.nodeId });
          continue;
        }
        var enabled = op.enabled !== false;
        var linked = $._EXT_PRM_._findLinkedClips(seq, found.clip);
        for (var le = 0; le < linked.length; le++) {
          try { linked[le].disabled = !enabled; } catch (eEn) {}
        }
        results.push({ op: a, ok: true, enabled: enabled, affectedClips: linked.length });
        continue;
      }

      /* --- set_clips_enabled_by_name: все сегменты с данным именем клипа на секвенции --- */
      if (a === 'set_clips_enabled_by_name') {
        var nm = String(op.clipName || op.name || '').trim();
        if (!nm) {
          results.push({ op: a, ok: false, error: 'Нужен clipName (имя клипа как в снимке)' });
          continue;
        }
        var en = op.enabled !== false;
        var byName = $._EXT_PRM_._findClipsByDisplayName(seq, nm);
        var ch,
          aff = 0;
        for (ch = 0; ch < byName.length; ch++) {
          try {
            byName[ch].disabled = !en;
            aff++;
          } catch (eBn) {}
        }
        results.push({ op: a, ok: true, clipName: nm, enabled: en, affectedClips: aff });
        continue;
      }

      /* --- move_clip: переместить клип; shiftBlockingClips — сдвинуть мешающие клипы вправо на длительность --- */
      if (a === 'move_clip') {
        found = $._EXT_PRM_._findClipByNodeId(seq, op.nodeId);
        if (!found) {
          results.push({ op: a, ok: false, error: 'Клип не найден: ' + op.nodeId });
          continue;
        }
        if (typeof op.newStartSec !== 'number') {
          results.push({ op: a, ok: false, error: 'Нужен newStartSec (число)' });
          continue;
        }
        var nodeRef = String(found.clip.nodeId);
        var linked2 = $._EXT_PRM_._findLinkedClips(seq, found.clip);
        var dur = found.clip.end.seconds - found.clip.start.seconds;
        var oldStartSec = found.clip.start.seconds;

        /* Собираем nodeId связки (переносимый клип + его linked A/V) для исключения из сдвига */
        var linkedNodeIds = {};
        for (var ln = 0; ln < linked2.length; ln++) {
          try { linkedNodeIds[String(linked2[ln].nodeId)] = true; } catch (eLn) {}
        }
        linkedNodeIds[nodeRef] = true;

        var useRippleInsert = op.shiftBlockingClips !== false && op.makeRoom !== false;
        var shiftLog = null;
        if (useRippleInsert) {
          /* Сдвигаем ВСЕ клипы КРОМЕ переносимой связки: освобождаем место в [newStartSec, newStartSec+dur] */
          shiftLog = $._EXT_PRM_._rippleShiftAllClipsFrom(seq, op.newStartSec, dur, linkedNodeIds);
          /* Перечитываем клип (после сдвига индексы могли измениться, но сам клип НЕ двигался) */
          found = $._EXT_PRM_._findClipByNodeId(seq, nodeRef);
          if (!found) {
            results.push({ op: a, ok: false, error: 'Клип не найден после ripple-сдвига', shiftedBeforeAttempt: shiftLog });
            continue;
          }
          linked2 = $._EXT_PRM_._findLinkedClips(seq, found.clip);
        }

        /* Перемещаем связку на newStartSec.
         *
         * В PP 2025 прямое присваивание clip.start.seconds = X часто НЕ работает
         * (свойство read-only после определённых операций). Канон API — TrackItem.move(timeDelta),
         * где timeDelta — Time-объект со знаковой дельтой. move() автоматически тащит за собой
         * linked A/V, поэтому достаточно вызвать на одном клипе связки (берём видео, если есть).
         *
         * Стратегии (последовательно, до успеха):
         *   1) move() с Time-объектом (каноничный путь).
         *   2) move() с числом тиков (некоторые сборки).
         *   3) Прямое присваивание start.seconds / end.seconds на всей связке (fallback).
         */
        var mvErr = null;
        var deltaSec = op.newStartSec - oldStartSec;

        /* Выбираем «ведущий» клип для move(): предпочтительно видео. */
        var leadClip = found.clip;
        for (var lv = 0; lv < linked2.length; lv++) {
          try {
            if (linked2[lv] && String(linked2[lv].mediaType || '').toLowerCase() === 'video') {
              leadClip = linked2[lv];
              break;
            }
          } catch (eLv) {}
        }

        /* Все nodeId связки для верификации (lead + linked) */
        var verifyIds = [];
        for (var lvi = 0; lvi < linked2.length; lvi++) {
          try { verifyIds.push(String(linked2[lvi].nodeId)); } catch (eVI) {}
        }
        function _verifyMove() {
          /* Все клипы связки должны оказаться на newStartSec. */
          for (var vi2 = 0; vi2 < verifyIds.length; vi2++) {
            var vv = $._EXT_PRM_._findClipByNodeId(seq, verifyIds[vi2]);
            if (!vv) return false;
            try {
              if (Math.abs(vv.clip.start.seconds - op.newStartSec) > 0.05) return false;
            } catch (eV) { return false; }
          }
          return true;
        }

        var moved = false;

        /* Стратегия 1: TrackItem.move(Time). */
        if (!moved && Math.abs(deltaSec) > $._EXT_PRM_._EPS) {
          try {
            if (typeof leadClip.move === 'function') {
              var tDelta = new Time();
              tDelta.seconds = deltaSec;
              leadClip.move(tDelta);
              moved = _verifyMove();
            }
          } catch (eM1) { mvErr = 'move(Time): ' + String(eM1.message || eM1); }
        }

        /* Стратегия 2: TrackItem.move(ticks как число). */
        if (!moved && Math.abs(deltaSec) > $._EXT_PRM_._EPS) {
          try {
            if (typeof leadClip.move === 'function') {
              var tps2 = $._EXT_PRM_._ticksPerSecond(seq);
              leadClip.move(Math.round(deltaSec * tps2));
              moved = _verifyMove();
            }
          } catch (eM2) { mvErr = (mvErr ? mvErr + '; ' : '') + 'move(ticks): ' + String(eM2.message || eM2); }
        }

        /* Стратегия 2.5: QE DOM move(timecodeString).
         * ВАЖНО: QE.move() НЕ тянет linked-связку — двигает только тот клип, на котором вызвали.
         * Поэтому вызываем move() для КАЖДОГО клипа связки (видео + аудио) индивидуально с одной и той же дельтой. */
        if (!moved && Math.abs(deltaSec) > $._EXT_PRM_._EPS) {
          try {
            if (typeof app.enableQE === 'function') app.enableQE();
            var qeSeq = (typeof qe !== 'undefined' && qe.project) ? qe.project.getActiveSequence() : null;
            if (qeSeq) {
              /* Сформировать timecode-строку дельты. */
              var fps = 30;
              try {
                var fpsTime = seq.timebase ? Math.round(254016000000 / parseFloat(seq.timebase)) : 30;
                if (fpsTime > 0 && fpsTime < 1000) fps = fpsTime;
              } catch (eF) {}
              var sign = deltaSec < 0 ? '-' : '';
              var ad = Math.abs(deltaSec);
              var hh = Math.floor(ad / 3600);
              var mm = Math.floor((ad - hh * 3600) / 60);
              var ssF = ad - hh * 3600 - mm * 60;
              var ss = Math.floor(ssF);
              var ff = Math.round((ssF - ss) * fps);
              if (ff >= fps) { ff = 0; ss++; }
              function pad(n) { return n < 10 ? '0' + n : '' + n; }
              var tcStr = sign + pad(hh) + ';' + pad(mm) + ';' + pad(ss) + ';' + pad(ff);

              /* Перебор: для каждого linked-клипа найти QE-аналог по (mediaType, start.secs ≈ oldStartSec) и вызвать .move(tcStr).
                 Порядок R→L при перемещении вправо, L→R при перемещении влево, чтобы не наступать на собственные клипы. */
              var goingRightQ = op.newStartSec > oldStartSec;
              var qeMoveLog = [];
              var qeFails = 0;
              for (var lk = 0; lk < linked2.length; lk++) {
                var origClip = linked2[lk];
                var origStart = oldStartSec;
                try { origStart = origClip.start.seconds; } catch (eOS) {}
                var isVideo = false;
                try { isVideo = String(origClip.mediaType || '').toLowerCase() === 'video'; } catch (eMT) {}
                /* Иногда mediaType пуст — определяем по тому, на каком треке. */

                var qeClip = null;
                try {
                  /* Сначала ищем в видео-треках, потом в аудио. */
                  var trackLists = [];
                  var nvT = qeSeq.numVideoTracks ? qeSeq.numVideoTracks : 0;
                  var naT = qeSeq.numAudioTracks ? qeSeq.numAudioTracks : 0;
                  for (var qti = 0; qti < nvT; qti++) trackLists.push({ tr: qeSeq.getVideoTrackAt(qti), kind: 'video' });
                  for (var qti2 = 0; qti2 < naT; qti2++) trackLists.push({ tr: qeSeq.getAudioTrackAt(qti2), kind: 'audio' });

                  for (var qtl = 0; qtl < trackLists.length && !qeClip; qtl++) {
                    var qvT2 = trackLists[qtl].tr;
                    if (!qvT2) continue;
                    var nci2 = qvT2.numItems ? qvT2.numItems : 0;
                    for (var qci2 = 0; qci2 < nci2; qci2++) {
                      var cit2 = null;
                      try { cit2 = qvT2.getItemAt(qci2); } catch (eGI) {}
                      if (!cit2) continue;
                      try {
                        var cs2 = parseFloat(cit2.start.secs || cit2.start.seconds || '0');
                        if (Math.abs(cs2 - origStart) < 0.06) {
                          /* Если это видео-клип linked2[lk], предпочесть совпадающий kind. */
                          if (isVideo && trackLists[qtl].kind === 'video') { qeClip = cit2; break; }
                          if (!isVideo && trackLists[qtl].kind === 'audio') { qeClip = cit2; break; }
                          /* Если mediaType неопределён — берём первый совпавший. */
                          if (!qeClip) qeClip = cit2;
                        }
                      } catch (eCs2) {}
                    }
                  }
                } catch (eFindL) {}

                if (qeClip && typeof qeClip.move === 'function') {
                  try {
                    qeClip.move(tcStr);
                    qeMoveLog.push({ ok: true, kind: isVideo ? 'video' : 'audio', from: origStart });
                  } catch (eQEm) {
                    qeFails++;
                    qeMoveLog.push({ ok: false, kind: isVideo ? 'video' : 'audio', from: origStart, error: String(eQEm.message || eQEm) });
                  }
                } else {
                  qeFails++;
                  qeMoveLog.push({ ok: false, kind: isVideo ? 'video' : 'audio', from: origStart, error: 'qe clip not found' });
                }
              }
              moved = _verifyMove();
              if (!moved) {
                mvErr = (mvErr ? mvErr + '; ' : '') + 'qe partial: ' + qeFails + '/' + linked2.length + ' fails';
              }
            }
          } catch (eQE) { mvErr = (mvErr ? mvErr + '; ' : '') + 'qe: ' + String(eQE.message || eQE); }
        }

        /* Стратегия 3: прямое присваивание по всей связке (порядок R→L или L→R). */
        if (!moved) {
          var goingRight = op.newStartSec > oldStartSec;
          var mvOrder = linked2.slice();
          mvOrder.sort(function (aa, bb) {
            try {
              return goingRight
                ? bb.start.seconds - aa.start.seconds
                : aa.start.seconds - bb.start.seconds;
            } catch (eS) { return 0; }
          });
          for (var lm = 0; lm < mvOrder.length; lm++) {
            try {
              mvOrder[lm].start.seconds = op.newStartSec;
              mvOrder[lm].end.seconds = op.newStartSec + dur;
            } catch (eMv) {
              mvErr = (mvErr ? mvErr + '; ' : '') + 'start.seconds=: ' + String(eMv.message || eMv);
            }
          }
          moved = _verifyMove();
        }
        var verify = $._EXT_PRM_._findClipByNodeId(seq, nodeRef);
        var epsM = $._EXT_PRM_._EPS;
        var movedOk =
          verify &&
          Math.abs(verify.clip.start.seconds - op.newStartSec) < epsM &&
          Math.abs(verify.clip.end.seconds - (op.newStartSec + dur)) < epsM;
        if (!movedOk) {
          results.push({
            op: a,
            ok: false,
            error:
              'Premiere не переместил клип (коллизия или занято). actualStart=' +
              (verify ? verify.clip.start.seconds.toFixed(2) : '?') + ', requested=' + op.newStartSec.toFixed(2) +
              '. Попробуйте: 1) ripple_delete_range + shift_timeline_ripple чтобы освободить место, 2) затем move_clip повторно. ' +
              (mvErr || ''),
            requestedStartSec: op.newStartSec,
            actualStartSec: verify ? verify.clip.start.seconds : null,
            shiftedBeforeAttempt: shiftLog
          });
        } else {
          results.push({
            op: a,
            ok: true,
            newStartSec: op.newStartSec,
            newEndSec: op.newStartSec + dur,
            shiftedClips: shiftLog
          });
        }
        continue;
      }

      /* --- set_playhead: переместить курсор воспроизведения --- */
      if (a === 'set_playhead') {
        if (typeof op.timeSec !== 'number') {
          results.push({ op: a, ok: false, error: 'Нужен timeSec (число)' });
          continue;
        }
        try {
          var phTime = new Time();
          phTime.seconds = op.timeSec;
          seq.setPlayerPosition(phTime.ticks);
          results.push({ op: a, ok: true, timeSec: op.timeSec });
        } catch (ePH) {
          results.push({ op: a, ok: false, error: String(ePH.message || ePH) });
        }
        continue;
      }

      /* --- set_clip_speed: изменить скорость клипа --- */
      if (a === 'set_clip_speed') {
        found = $._EXT_PRM_._findClipByNodeId(seq, op.nodeId);
        if (!found) {
          results.push({ op: a, ok: false, error: 'Клип не найден: ' + op.nodeId });
          continue;
        }
        if (typeof op.speed !== 'number' || op.speed <= 0) {
          results.push({ op: a, ok: false, error: 'Нужен speed > 0 (1.0 = нормально, 2.0 = 2x)' });
          continue;
        }
        try {
          var speedOk = found.clip.setSpeed(op.speed, true);
          results.push({ op: a, ok: speedOk !== false, speed: op.speed });
        } catch (eSp) {
          results.push({ op: a, ok: false, error: String(eSp.message || eSp) });
        }
        continue;
      }

      /* --- mute_track: включить/выключить дорожку --- */
      if (a === 'mute_track') {
        var trType = String(op.trackType || 'video');
        var trIdx = typeof op.trackIndex === 'number' ? op.trackIndex : 0;
        var trMute = op.muted !== false;
        try {
          var targetTrack = trType === 'audio' ? seq.audioTracks[trIdx] : seq.videoTracks[trIdx];
          if (!targetTrack) {
            results.push({ op: a, ok: false, error: 'Дорожка не найдена: ' + trType + '[' + trIdx + ']' });
            continue;
          }
          targetTrack.setMute(trMute ? 1 : 0);
          results.push({ op: a, ok: true, trackType: trType, trackIndex: trIdx, muted: trMute });
        } catch (eTM) {
          results.push({ op: a, ok: false, error: String(eTM.message || eTM) });
        }
        continue;
      }

      if (a === 'note') {
        results.push({ op: 'note', text: op.note || '' });
        continue;
      }

      results.push({ op: a || '?', ok: false, error: 'Неизвестное действие' });
    }

    return JSON.stringify({ ok: true, results: results, hostVersion: $._EXT_PRM_.version });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  } finally {
    if (undoOpened && typeof app.endUndoGroup === 'function') {
      try {
        app.endUndoGroup();
      } catch (eU) {}
    }
  }
};

$._EXT_PRM_.applyTranscriptCuts = function (jsonCuts) {
  var undoOpened = false;
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    }
    var seq = app.project.activeSequence;
    var cuts = JSON.parse(jsonCuts);
    if (typeof app.beginUndoGroup === 'function') {
      app.beginUndoGroup('ИИ: монтаж по тексту');
      undoOpened = true;
    }
    var intervals = cuts.removeIntervals || [];
    var sorted = intervals.slice().sort(function (x, y) {
      return y.startSec - x.startSec;
    });
    var allLog = [];
    var k,
      iv,
      lg;
    for (k = 0; k < sorted.length; k++) {
      iv = sorted[k];
      if (typeof iv.startSec !== 'number' || typeof iv.endSec !== 'number') continue;
      if (iv.endSec <= iv.startSec) continue;
      lg = [];
      $._EXT_PRM_._applyOneTimelineInterval(seq, iv.startSec, iv.endSec, lg, true);
      allLog.push({ interval: iv, log: lg });
    }
    return JSON.stringify({
      ok: true,
      appliedIntervals: sorted.length,
      details: allLog,
      hostVersion: $._EXT_PRM_.version
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  } finally {
    if (undoOpened && typeof app.endUndoGroup === 'function') {
      try {
        app.endUndoGroup();
      } catch (eU2) {}
    }
  }
};

$._EXT_PRM_.addSequenceMarkers = function (jsonMarkers) {
  var undoOpened = false;
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    }
    var seq = app.project.activeSequence;
    var list = JSON.parse(jsonMarkers);
    if (typeof app.beginUndoGroup === 'function') {
      app.beginUndoGroup('ИИ: маркеры');
      undoOpened = true;
    }
    var markers = seq.markers;
    var i,
      m,
      mk;
    var created = [];
    var failed = [];
    var tps = $._EXT_PRM_._ticksPerSecond(seq);
    /* Вспом.: проверить, куда встал маркер после создания. */
    var _mkPos = function (mm) {
      try {
        if (mm && mm.start && typeof mm.start.seconds === 'number') return mm.start.seconds;
      } catch (ePos) {}
      return null;
    };
    /* Вспом.: попытаться создать маркер по стратегии и проверить дрейф; вернёт {mk, verifiedSec, drift}. */
    var _tryCreate = function (strategyFn, targetSec) {
      var mmk = null;
      try { mmk = strategyFn(); } catch (eTC) { mmk = null; }
      if (!mmk) return { mk: null, verifiedSec: null, drift: null };
      var vs = _mkPos(mmk);
      var dr = vs !== null ? Math.abs(vs - targetSec) : null;
      return { mk: mmk, verifiedSec: vs, drift: dr };
    };
    /* Вспом.: удалить маркер (для retry). */
    var _mkDelete = function (mm) {
      try { if (mm && typeof markers.deleteMarker === 'function') markers.deleteMarker(mm); } catch (eDel) {}
    };

    for (i = 0; i < list.length; i++) {
      m = list[i];
      if (typeof m.timeSec !== 'number' || isNaN(m.timeSec)) continue;
      var ticksNum = Math.round(m.timeSec * tps);
      mk = null;
      var lastErr = null;
      var bestDrift = null;
      var bestVS = null;
      var DRIFT_OK = 0.25; /* приемлемо — в пределах четверти секунды */
      var targetSec = m.timeSec;

      /* Перебор 4 стратегий с верификацией позиции и retry.
       * В PP 2025 createMarker() может «молча» создать маркер в 0
       * для одной стратегии и корректно — для другой, в зависимости от сборки. */
      var strategies = [
        /* 1) КАНОН docsforadobe: createMarker(seconds as Number). */
        function () { return markers.createMarker(Number(targetSec)); },
        /* 2) Time-объект с .seconds. */
        function () {
          var tP = new Time();
          tP.seconds = targetSec;
          return markers.createMarker(tP);
        },
        /* 3) Целое тиков (старые сборки PP ≤ 2020). */
        function () { return markers.createMarker(ticksNum); },
        /* 4) Строка тиков (совсем старый формат). */
        function () { return markers.createMarker(String(ticksNum)); }
      ];

      for (var si = 0; si < strategies.length; si++) {
        var res = _tryCreate(strategies[si], targetSec);
        if (!res.mk) { lastErr = 'strategy ' + (si + 1) + ' returned null'; continue; }

        /* Если встал с дрейфом > DRIFT_OK — пытаемся откорректировать mk.start.seconds. */
        if (res.drift !== null && res.drift > DRIFT_OK) {
          try { res.mk.start.seconds = targetSec; } catch (eFix) {}
          var vs2 = _mkPos(res.mk);
          if (vs2 !== null) {
            res.verifiedSec = vs2;
            res.drift = Math.abs(vs2 - targetSec);
          }
        }

        if (res.drift !== null && res.drift <= DRIFT_OK) {
          /* Успех — принимаем этот маркер. */
          mk = res.mk;
          bestVS = res.verifiedSec;
          bestDrift = res.drift;
          break;
        }

        /* Эта стратегия «подвела»: маркер не там. Запомним лучший, удалим плохой, пробуем следующую. */
        if (bestDrift === null || (res.drift !== null && res.drift < bestDrift)) {
          /* Сохранить как «лучший» — но если следующая не удастся, мы откатимся к нему. */
          if (mk) _mkDelete(mk);
          mk = res.mk;
          bestVS = res.verifiedSec;
          bestDrift = res.drift;
        } else {
          _mkDelete(res.mk);
        }
      }

      if (mk) {
        mk.name = m.name || 'ИИ';
        mk.comments = m.comment || '';
        if (m.type === 'chapter') {
          try {
            mk.setTypeAsChapter();
          } catch (e7) {}
        } else {
          try {
            mk.setTypeAsComment();
          } catch (e8) {}
        }

        /* Span-маркер: KNOWN BROKEN на PP 2025 (см. docs/premiere-extension-audit.md).
         *
         * Эмпирически на сборке пользователя (PP 2025) Marker API:
         *   - Пробовали 11+ стратегий: прямое mk.end.seconds, get→modify→put,
         *     new Time() seconds/ticks, setEndTime, mk.duration, QE DOM.
         *   - Во ВСЕХ случаях mk.end читается обратно равным mk.start → маркер рисуется точкой.
         *   - `verifiedEndSec === verifiedSec` подтверждено на живом данных пользователя v2.4.6.
         *
         * Делаем ОДНУ лучшую попытку (get→modify→put по ticks, абсолют) ради будущих сборок PP,
         * и если не сработало — возвращаем spanApplied:false + notSupported:true без дальнейшего спама. */
        var hasSpan = false;
        var spanEnd = null;
        var spanRequested = false;
        if (typeof m.endSec === 'number' && !isNaN(m.endSec) && m.endSec > m.timeSec + 0.001) {
          spanRequested = true;
          spanEnd = m.endSec;
          var spanLen = m.endSec - m.timeSec;
          var startActualPre = _mkPos(mk);
          var startActual = (typeof startActualPre === 'number' && startActualPre !== null) ? startActualPre : m.timeSec;

          var endTicksAbs = Math.round(m.endSec * tps);
          var lenTicks = Math.round(spanLen * tps);

          function _verifySpan() {
            try {
              if (mk.end && typeof mk.end.seconds === 'number') {
                var es = mk.end.seconds;
                /* Считаем полосу выставленной, если mk.end.seconds либо ≈ abs endSec,
                 * либо ≈ start+spanLen, либо ≈ сама длительность. */
                if (Math.abs(es - m.endSec) < 0.1) return true;
                if (Math.abs(es - (startActual + spanLen)) < 0.1) return true;
                if (Math.abs(es - spanLen) < 0.1) return true;
                /* дополнительно, если есть duration.seconds */
                if (mk.duration && typeof mk.duration.seconds === 'number' &&
                    Math.abs(mk.duration.seconds - spanLen) < 0.1) return true;
              }
            } catch (eVS) {}
            return false;
          }

          /* Одна best-effort попытка для будущих сборок PP, которые могут это поддержать.
             GET→MODIFY→PUT по ticks (абсолют) — самый каноничный путь. */
          try {
            var tBest = mk.end;
            if (tBest) { tBest.ticks = String(endTicksAbs); mk.end = tBest; }
          } catch (eBest) {}
          if (_verifySpan()) hasSpan = true;

          /* Встраиваем пояснение в comments маркера, чтобы в Premiere видна была длительность хотя бы текстом. */
          if (!hasSpan) {
            try {
              var hh = function (t) { var a = Math.floor(t / 60), b = Math.round(t - a * 60); return a + ':' + (b < 10 ? '0' : '') + b; };
              var rangeTxt = '[' + hh(m.timeSec) + '–' + hh(m.endSec) + ', ' + (m.endSec - m.timeSec).toFixed(1) + 'с]';
              var existing = mk.comments || '';
              mk.comments = (existing ? existing + ' ' : '') + rangeTxt;
            } catch (eAug) {}
          }
        }

        /* Финальная перепроверка позиции (mk.start мог «уплыть»). */
        var verifiedSec = _mkPos(mk);
        if (verifiedSec === null) verifiedSec = bestVS;
        var drift = verifiedSec !== null ? Math.abs(verifiedSec - m.timeSec) : bestDrift;
        var verifiedEndSec = null;
        try {
          if (mk.end && typeof mk.end.seconds === 'number') verifiedEndSec = mk.end.seconds;
        } catch (eVE) {}
        created.push({
          timeSec: m.timeSec,
          endSec: spanEnd,
          name: mk.name,
          ticks: ticksNum,
          verifiedSec: verifiedSec,
          verifiedEndSec: verifiedEndSec,
          spanApplied: hasSpan,
          spanRequested: spanRequested,
          driftSec: drift !== null ? Math.round(drift * 100) / 100 : null
        });
      } else {
        failed.push({ timeSec: m.timeSec, name: m.name || '', error: 'createMarker вернул null (все 4 стратегии). last=' + lastErr });
      }
    }
    var anyDrift = false;
    var anySpanRequested = false;
    var anySpanApplied = false;
    for (var cd = 0; cd < created.length; cd++) {
      if (created[cd].driftSec !== null && created[cd].driftSec > 1.0) anyDrift = true;
      if (created[cd].spanRequested) anySpanRequested = true;
      if (created[cd].spanApplied) anySpanApplied = true;
    }
    var spanNotSupported = anySpanRequested && !anySpanApplied;
    return JSON.stringify({
      ok: true,
      created: created,
      count: created.length,
      failed: failed,
      failedCount: failed.length,
      driftWarning: anyDrift ? 'Некоторые маркеры сместились более чем на 1 с от запрошенной позиции — проверьте визуально' : null,
      spanNotSupported: spanNotSupported,
      spanNotice: spanNotSupported
        ? 'Known-broken на этой сборке PP 2025: API не позволяет создавать span-маркеры (длительность) программно — все маркеры получились точечными, несмотря на endSec. Диапазон добавлен в comments маркера текстом. См. docs/premiere-extension-audit.md.'
        : null,
      hostVersion: $._EXT_PRM_.version
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  } finally {
    if (undoOpened && typeof app.endUndoGroup === 'function') {
      try {
        app.endUndoGroup();
      } catch (eM) {}
    }
  }
};

$._EXT_PRM_._fileExists = function (path) {
  if (!path) return false;
  var f = new File(path);
  return f.exists === true;
};

$._EXT_PRM_._encodeInToOut = function () {
  try {
    if (app.encoder && typeof app.encoder.ENCODE_IN_TO_OUT === 'number') {
      return app.encoder.ENCODE_IN_TO_OUT;
    }
  } catch (eEnc) {}
  return 1;
};

/**
 * Аудиоклипы на таймлайне, пересекающие [t0, t1] (сек), только audioTracks.
 */
$._EXT_PRM_._audioClipsIntersecting = function (seq, t0, t1) {
  var out = [];
  var ti,
    j,
    tr,
    it,
    n,
    s,
    e,
    eps = $._EXT_PRM_._EPS;
  for (ti = 0; ti < seq.audioTracks.numTracks; ti++) {
    tr = seq.audioTracks[ti];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try {
        it = tr.clips[j];
        if (!it) continue;
        s = it.start.seconds;
        e = it.end.seconds;
        if (e - eps <= t0 || s + eps >= t1) continue;
        out.push({ clip: it, startSec: s, endSec: e, trackIndex: ti });
      } catch (eA) {}
    }
  }
  return out;
};

/**
 * Экспорт In–Out чанками (меньше 413 на Whisper). Восстанавливает In/Out.
 */
$._EXT_PRM_._exportInOutAsChunks = function (seq, preset, root, chunkSec, chunkExt) {
  chunkExt = chunkExt || 'wav';
  var eps = $._EXT_PRM_._EPS;
  var savedIn = parseFloat(seq.getInPoint());
  var savedOut = parseFloat(seq.getOutPoint());
  if (isNaN(savedIn)) savedIn = 0;
  if (isNaN(savedOut)) savedOut = 0;
  if (savedOut <= savedIn + eps) {
    return { ok: false, error: 'NO_IN_OUT', code: 'NO_IN_OUT' };
  }
  var enc = $._EXT_PRM_._encodeInToOut();
  var chunks = [];
  var idx = 0;
  var t = savedIn;
  var maxChunks = 500;
  try {
    while (t < savedOut - eps && idx < maxChunks) {
      var segEnd = Math.min(t + chunkSec, savedOut);
      try {
        seq.setInPoint(String(t));
        seq.setOutPoint(String(segEnd));
      } catch (eSO) {
        return { ok: false, error: String(eSO && eSO.message ? eSO.message : eSO), code: 'SET_IN_OUT_FAIL', partial: chunks };
      }
      var outPath = root + '/host/_llm_chunk_' + idx + '.' + chunkExt;
      try {
        var outF = new File(outPath);
        if (outF.exists) outF.remove();
      } catch (eRm) {}
      try {
        seq.exportAsMediaDirect(outPath, preset, enc);
      } catch (eEx) {}
      if (!$._EXT_PRM_._fileExists(outPath)) {
        return {
          ok: false,
          error:
            'Экспорт чанка не создал файл (' +
            t.toFixed(2) +
            '–' +
            segEnd.toFixed(2) +
            ' с). Проверьте пресет .epr (только аудио, короткие имена пути).',
          code: 'EXPORT_CHUNK_FAIL',
          atSec: t,
          chunksSoFar: chunks.length
        };
      }
      chunks.push({ path: outPath, timelineOffsetSec: t });
      t = segEnd;
      idx++;
    }
  } finally {
    try {
      seq.setInPoint(String(savedIn));
      seq.setOutPoint(String(savedOut));
    } catch (eF) {}
  }
  return { ok: true, chunks: chunks };
};

/**
 * Подготовка транскрибации по области In–Out активной секвенции.
 * JSON: { extensionRoot, exportPresetPath, transcribeExportChunkSec, maxDirectTranscribeMediaSec }
 */
$._EXT_PRM_.prepareTranscribeFromTimeline = function (jsonStr) {
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ ok: false, error: 'Нет активной секвенции', code: 'NO_SEQ' });
    }
    var p = JSON.parse(jsonStr);
    var root = String(p.extensionRoot || '').replace(/\\/g, '/');
    var presetFromSettings = String(p.exportPresetPath || '').replace(/\\/g, '/');
    var maxDirectSec =
      typeof p.maxDirectTranscribeMediaSec === 'number' && !isNaN(p.maxDirectTranscribeMediaSec)
        ? p.maxDirectTranscribeMediaSec
        : 3600;
    var chunkSec =
      typeof p.transcribeExportChunkSec === 'number' && !isNaN(p.transcribeExportChunkSec) && p.transcribeExportChunkSec >= 15
        ? Math.min(p.transcribeExportChunkSec, 600)
        : 180;
    var chunkExt = String(p.exportChunkExtension || 'wav').replace(/^\./, '');
    var seq = app.project.activeSequence;
    var inSec = parseFloat(seq.getInPoint());
    var outSec = parseFloat(seq.getOutPoint());
    if (isNaN(inSec)) inSec = 0;
    if (isNaN(outSec)) outSec = 0;
    /* В некоторых сборках PP getInPoint()/getOutPoint() возвращает гигантские
       отрицательные значения, если In/Out не выставлены или сброшены — clip к 0. */
    if (inSec < 0 || inSec > 360000) inSec = 0;
    if (outSec < 0 || outSec > 360000) outSec = 0;
    if (outSec <= inSec + $._EXT_PRM_._EPS) {
      return JSON.stringify({
        ok: false,
        error: 'Задайте In и Out на секвенции (Out должен быть правее In), затем снова нажмите транскрибацию.',
        code: 'NO_IN_OUT'
      });
    }

    var preset = '';
    if (presetFromSettings && $._EXT_PRM_._fileExists(presetFromSettings)) {
      preset = presetFromSettings;
    } else {
      var bundled = root + '/host/presets/TimelineAudio.epr';
      if ($._EXT_PRM_._fileExists(bundled)) preset = bundled;
    }

    if (preset) {
      var ch = $._EXT_PRM_._exportInOutAsChunks(seq, preset, root, chunkSec, chunkExt);
      if (ch.ok && ch.chunks && ch.chunks.length) {
        return JSON.stringify({
          ok: true,
          mode: 'export_chunks',
          chunks: ch.chunks,
          workInSec: inSec,
          workOutSec: outSec,
          hostVersion: $._EXT_PRM_.version
        });
      }
      if (!ch.ok && ch.code && ch.code !== 'NO_IN_OUT') {
        return JSON.stringify({
          ok: false,
          error: ch.error || 'Экспорт In–Out не удался',
          code: ch.code || 'EXPORT_FAIL',
          exportTried: true
        });
      }
    }

    var hits = $._EXT_PRM_._audioClipsIntersecting(seq, inSec, outSec);
    if (!hits.length) {
      return JSON.stringify({
        ok: false,
        error:
          'В области In–Out нет аудиоклипов. Добавьте аудио на таймлайн или укажите в fm-defaults.js путь exportAudioPresetPath к .epr пресету (экспорт только аудио) — см. host/presets/README.txt',
        code: 'NO_AUDIO',
        exportTried: !!preset
      });
    }

    if (hits.length > 1) {
      var items = [];
      var hi,
        h,
        clipM,
        piM,
        mediaPathM,
        workIn,
        workOut,
        clipInM,
        durSrcM;
      for (hi = 0; hi < hits.length; hi++) {
        h = hits[hi];
        clipM = h.clip;
        piM = clipM.projectItem;
        if (!piM) continue;
        mediaPathM = '';
        try {
          if (typeof piM.getMediaPath === 'function') {
            mediaPathM = piM.getMediaPath();
          } else if (piM.mediaPath) {
            mediaPathM = String(piM.mediaPath);
          }
        } catch (ePM) {}
        if (!mediaPathM || !$._EXT_PRM_._fileExists(mediaPathM)) {
          return JSON.stringify({
            ok: false,
            error:
              'В In–Out несколько клипов; у одного нет пути к файлу на диске. Задайте exportAudioPresetPath + .epr для экспорта In–Out.',
            code: 'NO_MEDIA_PATH_MULTI',
            clipIndex: hi
          });
        }
        durSrcM = 0;
        try {
          if (piM.duration) durSrcM = piM.duration.seconds;
        } catch (eDM) {}
        if (durSrcM > maxDirectSec) {
          return JSON.stringify({
            ok: false,
            error:
              'Клип дольше ' +
              maxDirectSec +
              ' с — задайте exportAudioPresetPath к .epr (экспорт In–Out чанками) или увеличьте maxDirectTranscribeMediaSec.',
            code: 'MEDIA_TOO_LONG',
            durationSec: durSrcM
          });
        }
        workIn = Math.max(inSec, h.startSec);
        workOut = Math.min(outSec, h.endSec);
        if (workOut <= workIn + $._EXT_PRM_._EPS) continue;
        clipInM = clipM.inPoint ? clipM.inPoint.seconds : 0;
        items.push({
          path: String(mediaPathM).replace(/\\/g, '/'),
          clipStartSec: h.startSec,
          clipEndSec: h.endSec,
          clipInPointSec: clipInM,
          workInSec: workIn,
          workOutSec: workOut
        });
      }
      if (!items.length) {
        return JSON.stringify({
          ok: false,
          error: 'Клипы в In–Out не пересекают интервал (проверьте границы).',
          code: 'NO_INTERSECT'
        });
      }
      return JSON.stringify({
        ok: true,
        mode: 'clip_queue',
        items: items,
        workInSec: inSec,
        workOutSec: outSec,
        hostVersion: $._EXT_PRM_.version
      });
    }

    var one = hits[0];
    var clip = one.clip;
    var pi = clip.projectItem;
    if (!pi) {
      return JSON.stringify({ ok: false, error: 'Нет projectItem у клипа', code: 'NO_PI' });
    }
    var mediaPath = '';
    try {
      if (typeof pi.getMediaPath === 'function') {
        mediaPath = pi.getMediaPath();
      } else if (pi.mediaPath) {
        mediaPath = String(pi.mediaPath);
      }
    } catch (eP) {}
    if (!mediaPath || !$._EXT_PRM_._fileExists(mediaPath)) {
      return JSON.stringify({
        ok: false,
        error:
          'У клипа нет пути к файлу на диске (вложенная секвенция/генератор). Нужен exportAudioPresetPath + .epr для экспорта In–Out.',
        code: 'NO_MEDIA_PATH'
      });
    }

    var durSrc = 0;
    try {
      if (pi.duration) durSrc = pi.duration.seconds;
    } catch (eDur) {}
    if (durSrc > maxDirectSec) {
      return JSON.stringify({
        ok: false,
        error:
          'Исходный файл дольше ' +
          maxDirectSec +
          ' с — задайте в fm-defaults.js exportAudioPresetPath к .epr и экспорт In–Out (или увеличьте maxDirectTranscribeMediaSec).',
        code: 'MEDIA_TOO_LONG',
        durationSec: durSrc
      });
    }

    var clipIn = clip.inPoint ? clip.inPoint.seconds : 0;
    return JSON.stringify({
      ok: true,
      mode: 'media_file',
      path: mediaPath.replace(/\\/g, '/'),
      clipStartSec: one.startSec,
      clipEndSec: one.endSec,
      clipInPointSec: clipIn,
      workInSec: inSec,
      workOutSec: outSec,
      timelineOffsetSec: inSec,
      hostVersion: $._EXT_PRM_.version
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e), code: 'ERR' });
  }
};

/**
 * Один шаг отмены в Premiere (меню Edit → Undo / локализованные варианты).
 */
$._EXT_PRM_.undoLast = function () {
  var labels = ['Edit > Undo', 'Undo', 'Отменить', 'Редактирование > Отменить'];
  var i,
    cid;
  for (i = 0; i < labels.length; i++) {
    try {
      cid = app.findMenuCommandId(labels[i]);
      if (cid > 0) {
        app.executeCommand(cid);
        return JSON.stringify({ ok: true, hostVersion: $._EXT_PRM_.version, via: labels[i] });
      }
    } catch (e1) {}
  }
  try {
    app.executeCommand(199);
    return JSON.stringify({ ok: true, hostVersion: $._EXT_PRM_.version, via: 'fallback_199' });
  } catch (e2) {}
  return JSON.stringify({
    ok: false,
    error: 'Команда Undo не найдена. Сфокусируйте таймлайн Premiere и нажмите Cmd+Z (Ctrl+Z).',
    hostVersion: $._EXT_PRM_.version
  });
};
