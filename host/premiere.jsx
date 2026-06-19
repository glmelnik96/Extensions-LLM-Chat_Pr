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
 * - откат таймкодов/textmontage: НЕ реализован (Cmd+Z в таймлайне Premiere вручную)
 * - removeMarkersBySeconds: markers.deleteMarker — единственный механизм отката маркеров
 */
if (typeof $._EXT_PRM_ === 'undefined') {
  $._EXT_PRM_ = {};
}

$._EXT_PRM_.version = '2.6.6';

$._EXT_PRM_._EPS = 0.04;

/**
 * Счётчик «шагов» Premiere в рамках одной операции applyTimecodeEdits /
 * applyTranscriptCuts / addSequenceMarkers. Раньше использовался для пакетного
 * отката Edit→Undo×N — функция удалена как нереализуемая. Сейчас счётчик
 * остаётся информационным полем `undoSteps` в ответе хоста (для логов/отладки).
 */
$._EXT_PRM_._opCounter = 0;
$._EXT_PRM_._bump = function (n) {
  $._EXT_PRM_._opCounter += typeof n === 'number' ? n : 1;
};
$._EXT_PRM_._resetOps = function () {
  $._EXT_PRM_._opCounter = 0;
};

/**
 * JSON-полифилл для ExtendScript (2026-06-18).
 *
 * ПРОБЛЕМА: движок ExtendScript у части сборок Premiere НЕ имеет нативного
 *   объекта JSON. На таких машинах любой из ~85 вызовов JSON.stringify/parse в
 *   этом файле падал с `ReferenceError: JSON is undefined`, и плагин не работал
 *   вовсе (подтверждено логом установки на стороннем устройстве). На других
 *   сборках (напр. ExtendScript 4.5.6 в PP 26.2) JSON присутствует — поэтому
 *   баг латентный и проявляется только при переносе на другую машину/ОС.
 *
 * РЕШЕНИЕ: защищённый гард `if (typeof JSON === 'undefined')` — полифилл
 *   ставится ТОЛЬКО когда нативного JSON нет. Где JSON есть — блок пропускается,
 *   используется родная (быстрая) реализация. Полностью безопасно для обеих сред.
 *
 * Почему не json2.js Крокфорда: оригинал содержит regex с Unicode-диапазонами,
 *   на которых парсер ExtendScript падает с SyntaxError ещё до выполнения (файл
 *   не загружается). Здесь stringify — посимвольный обход с escape-картой (без
 *   regex), parse — eval с минимальной проверкой первого символа.
 *
 * БЕЗОПАСНОСТЬ parse: вход host-функций — это строго JSON, сериализованный нашим
 *   же panel.js (V8). Это не сетевой/сторонний ввод, поэтому eval-парсинг
 *   (стандартный для ExtendScript) приемлем. Не используйте этот JSON.parse для
 *   недоверенных данных.
 *
 * _wrap (ниже) сохраняет optimistic try/catch как defense-in-depth: даже если
 *   сериализация всё же упадёт, наружу уйдёт структурированная ошибка, а не
 *   немой "EvalScript error.".
 */
if (typeof JSON === 'undefined') {
  JSON = {};
  (function () {
    var esc = {};
    esc['\b'] = '\\b';
    esc['\t'] = '\\t';
    esc['\n'] = '\\n';
    esc['\f'] = '\\f';
    esc['\r'] = '\\r';
    esc['"'] = '\\"';
    esc['\\'] = '\\\\';
    function quote(s) {
      var out = '',
        i,
        c,
        e;
      for (i = 0; i < s.length; i++) {
        c = s.charAt(i);
        e = esc[c];
        if (e) {
          out += e;
        } else if (c.charCodeAt(0) < 32) {
          out += '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
        } else {
          out += c;
        }
      }
      return '"' + out + '"';
    }
    function str(v) {
      var i, k, part, parts;
      if (v === null) return 'null';
      switch (typeof v) {
        case 'string':
          return quote(v);
        case 'number':
          return isFinite(v) ? String(v) : 'null';
        case 'boolean':
          return String(v);
        case 'object':
          parts = [];
          if (v instanceof Array) {
            for (i = 0; i < v.length; i++) parts[i] = str(v[i]) || 'null';
            return '[' + parts.join(',') + ']';
          }
          for (k in v) {
            if (v.hasOwnProperty(k)) {
              part = str(v[k]);
              if (part !== undefined) parts.push(quote(k) + ':' + part);
            }
          }
          return '{' + parts.join(',') + '}';
        default:
          return undefined; /* function / undefined — пропускаем */
      }
    }
    JSON.stringify = function (v) {
      return str(v);
    };
    JSON.parse = function (t) {
      t = String(t);
      var first = t.replace(/^\s+/, '').charAt(0);
      if (first !== '{' && first !== '[' && first !== '"' &&
          first !== '-' && (first < '0' || first > '9') &&
          t.replace(/^\s+|\s+$/g, '') !== 'true' &&
          t.replace(/^\s+|\s+$/g, '') !== 'false' &&
          t.replace(/^\s+|\s+$/g, '') !== 'null') {
        throw new SyntaxError('JSON.parse: неожиданный ввод');
      }
      return eval('(' + t + ')');
    };
  })();
}

/**
 * Phase 1 (PP-26 stabilization, 2026-04-29; revised 2026-06-18):
 * Полифилл выше гарантирует наличие JSON. _wrap дополнительно держит optimistic
 * try/catch — если сериализация всё же упадёт, наружу уходит структурированная
 * ошибка вместо немого "EvalScript error.".
 */

/**
 * Phase 1: wrap-decorator для экспортируемых функций.
 *
 * Раньше: исключение в exported-функции попадало в CEP как литерал
 *   "EvalScript error." без деталей — отладка слепая.
 * Теперь: возвращаем структурированный JSON {_hostError:true, msg, line, source, fn},
 *   bridge-premiere.js парсит его и кидает ОСМЫСЛЕННУЮ ошибку с реальным
 *   номером строки и stack-trace из ExtendScript-движка.
 *
 * Использование:
 *   $._EXT_PRM_.foo = $._EXT_PRM_._wrap('foo', function (arg) {
 *     // ... обычный код функции, может бросать ...
 *     return JSON.stringify({ ok: true, data: ... });
 *   });
 */
$._EXT_PRM_._wrap = function (name, fn) {
  return function () {
    try {
      var result = fn.apply(this, arguments);
      /* Если функция уже вернула строку — отдаём как есть (legacy-контракт).
         Все наши exported-функции исторически сами зовут JSON.stringify
         внутри и возвращают строку. Этот путь не зависит от внешнего JSON. */
      if (typeof result === 'string') return result;
      /* Только если функция вернула объект — пытаемся сериализовать. */
      try {
        return JSON.stringify(result);
      } catch (eJ) {
        return '{"_hostError":true,"msg":"JSON.stringify failed","fn":"' + name + '"}';
      }
    } catch (e) {
      /* Структурированный отчёт об ошибке. Поля e.line/e.source/e.fileName
         доступны в ExtendScript Error-объекте; $.stack даёт callstack. */
      var info = {
        _hostError: true,
        fn: name,
        msg: (e && e.toString) ? e.toString() : String(e),
        line: (e && typeof e.line === 'number') ? e.line : null,
        source: (e && e.source) ? String(e.source).slice(0, 200) : null,
        fileName: (e && e.fileName) ? String(e.fileName) : null,
        stack: (typeof $ !== 'undefined' && $.stack) ? String($.stack).slice(0, 800) : null
      };
      try {
        return JSON.stringify(info);
      } catch (eJ) {
        /* JSON.stringify сам упал — отдаём минимум вручную. */
        return '{"_hostError":true,"fn":"' + name + '","msg":"' +
               String(info.msg).replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"}';
      }
    }
  };
};

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

/**
 * Phase 1: безопасное чтение времени клипа.
 * Раньше: прямые цепочки clip.start.seconds — на PP 26 при null/undefined
 *   падало с непрозрачным "EvalScript error.".
 * Теперь: каждое поле читается через try/catch, отсутствие → 0.
 *   Вызывается из десятков мест — лучше получить нули чем уронить весь снапшот.
 */
$._EXT_PRM_._clipTimes = function (clip) {
  function safeSeconds(timeObj) {
    try {
      if (timeObj && typeof timeObj.seconds === 'number') return timeObj.seconds;
    } catch (e) {}
    return 0;
  }
  if (!clip) return { s: 0, e: 0, srcIn: 0, srcOut: 0 };
  return {
    s: safeSeconds(clip.start),
    e: safeSeconds(clip.end),
    srcIn: safeSeconds(clip.inPoint),
    srcOut: safeSeconds(clip.outPoint)
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

  /* Используем _findLinkedClips (getLinkedItems API), а не name-matching —
     name-matching может случайно удалить чужие клипы с таким же именем. */
  var toRemove = $._EXT_PRM_._findLinkedClips(seq, clip);

  var removed = [];
  /* Удаляем в обратном порядке (по позиции), чтобы индексы не сбивались */
  toRemove.sort(function (a, b) {
    try { return b.start.seconds - a.start.seconds; } catch (eS) { return 0; }
  });
  for (var k = 0; k < toRemove.length; k++) {
    try {
      var nid = String(toRemove[k].nodeId);
      toRemove[k].remove(1, 1);
      $._EXT_PRM_._bump();
      removed.push(nid);
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
 * Точный FPS активной секвенции как float — БЕЗ округления.
 * Округление ломает NTSC: 29.97 → 30 даёт дрейф razor-таймкода ~3.6 с на часе.
 * Порядок источников: seq.timebase (тики на кадр, 254016000000 тиков/сек) →
 * seq.getSettings().videoFrameRate.seconds (длительность кадра) → fallback 25.
 */
$._EXT_PRM_._sequenceFps = function (seq) {
  try {
    var tb = parseFloat(seq.timebase);
    if (tb > 0) return 254016000000 / tb;
  } catch (eT) {}
  try {
    var st = seq.getSettings();
    if (st && st.videoFrameRate) {
      var frSec = st.videoFrameRate.seconds;
      if (typeof frSec === 'number' && frSec > 0) return 1 / frSec;
    }
  } catch (eS) {}
  return 25;
};

/**
 * Учёт неудачной razor/remove/trim-операции в stats
 * (см. _applyOneTimelineInterval, applyTranscriptCuts, applyMulticamCuts).
 * stats = { applied: Number, failed: Number, reasons: [String] }.
 * reasons — уникальные сообщения, максимум 5, чтобы не раздувать ответ хоста.
 */
$._EXT_PRM_._statFail = function (stats, e) {
  if (!stats) return;
  stats.failed++;
  var msg = String(e && e.message ? e.message : e);
  if (stats.reasons.length >= 5) return;
  for (var ri = 0; ri < stats.reasons.length; ri++) {
    if (stats.reasons[ri] === msg) return;
  }
  stats.reasons.push(msg);
};

/**
 * Заблокирована ли дорожка. Канон API: Track.isLocked() — метод (как isMuted()).
 * Pre-check через typeof ненадёжен в ExtendScript (может вернуть 'unknown'),
 * поэтому optimistic try/catch: сначала вызов метода, затем property-вариант.
 * Если API отсутствует (старые сборки) — считаем НЕ заблокированной (не блокируем работу).
 */
$._EXT_PRM_._trackIsLocked = function (track) {
  if (!track) return false;
  try { return track.isLocked() === true; } catch (eL0) {}
  try { return track.isLocked === true; } catch (eL1) {}
  return false;
};

/**
 * Список заблокированных дорожек активной секвенции.
 * videoIdxList: массив индексов видеодорожек (0-based) — проверяем только их
 *   (для applyMulticamCuts, который аудио не трогает);
 * null/undefined → проверяем ВСЕ видео- и аудиодорожки.
 * Возвращает массив человекочитаемых меток: ['V1', 'A2', ...].
 */
$._EXT_PRM_._findLockedTracks = function (seq, videoIdxList) {
  var locked = [];
  var vi, ai, idx;
  if (videoIdxList) {
    for (vi = 0; vi < videoIdxList.length; vi++) {
      idx = videoIdxList[vi];
      if (typeof idx !== 'number' || idx < 0 || idx >= seq.videoTracks.numTracks) continue;
      if ($._EXT_PRM_._trackIsLocked(seq.videoTracks[idx])) locked.push('V' + (idx + 1));
    }
    return locked;
  }
  for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
    if ($._EXT_PRM_._trackIsLocked(seq.videoTracks[vi])) locked.push('V' + (vi + 1));
  }
  for (ai = 0; ai < seq.audioTracks.numTracks; ai++) {
    if ($._EXT_PRM_._trackIsLocked(seq.audioTracks[ai])) locked.push('A' + (ai + 1));
  }
  return locked;
};

/**
 * Конвертация секунд в таймкод HH:MM:SS;FF для QE DOM razor().
 * fps может быть дробным (NTSC 29.97 / 59.94) — индекс кадра считаем по ТОЧНОМУ
 * fps, а строку собираем как SMPTE drop-frame (стандартный алгоритм Heidelberger:
 * первые dropFrames номеров кадров каждой минуты пропускаются, кроме каждой 10-й).
 * Для целых fps (24/25/30/50/60) поведение идентично прежнему (non-drop).
 * 23.976 — по стандарту non-drop: общая ветка с номиналом 24.
 */
$._EXT_PRM_._secToTimecode = function (sec, fps) {
  if (!fps || fps <= 0) fps = 25;
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  /* Индекс кадра — по точному (возможно дробному) fps. Главное исправление:
     раньше fps округлялся до целого и на 29.97 razor дрейфовал. */
  var totalFrames = Math.round(sec * fps);
  if (totalFrames < 0) totalFrames = 0;
  var nominal = Math.round(fps);
  if (nominal < 1) nominal = 1;
  var isFractional = Math.abs(fps - nominal) > 0.001;
  if (isFractional && (nominal === 30 || nominal === 60)) {
    /* SMPTE drop-frame: переводим реальный индекс кадра в "номинальный"
       номер кадра с учётом пропусков. */
    var dropFrames = Math.round(fps * 0.066666);     /* 2 для 29.97, 4 для 59.94 */
    var framesPer10Min = Math.round(fps * 600);      /* 17982 / 35964 */
    var framesPerMinute = nominal * 60 - dropFrames; /* 1798 / 3596 */
    var d10 = Math.floor(totalFrames / framesPer10Min);
    var m10 = totalFrames % framesPer10Min;
    if (m10 > dropFrames) {
      totalFrames += dropFrames * 9 * d10 +
        dropFrames * Math.floor((m10 - dropFrames) / framesPerMinute);
    } else {
      totalFrames += dropFrames * 9 * d10;
    }
  }
  var ff = totalFrames % nominal;
  var ss = Math.floor(totalFrames / nominal) % 60;
  var mm = Math.floor(totalFrames / (nominal * 60)) % 60;
  var hh = Math.floor(totalFrames / (nominal * 3600));
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
$._EXT_PRM_._applyOneTimelineInterval = function (seq, t0, t1, log, ripple, stats) {
  var doRipple = ripple !== false;
  var ripFlag = doRipple ? 1 : 0;
  var eps = $._EXT_PRM_._EPS;
  /* stats: счётчик применённых/неудачных razor/remove/trim (см. _statFail).
     Если вызывающий не передал — локальный объект, чтобы код ниже не ветвился. */
  if (!stats) stats = { applied: 0, failed: 0, reasons: [] };

  /* --- Определяем FPS для таймкода QE (точный float — NTSC-safe) --- */
  var fps = $._EXT_PRM_._sequenceFps(seq);

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
        try { vt.razor(tc0, true, true); $._EXT_PRM_._bump(); stats.applied++; } catch (eVR0) { $._EXT_PRM_._statFail(stats, eVR0); }
        try { vt.razor(tc1, true, true); $._EXT_PRM_._bump(); stats.applied++; } catch (eVR1) { $._EXT_PRM_._statFail(stats, eVR1); }
      } catch (eVR) { $._EXT_PRM_._statFail(stats, eVR); }
    }
    for (ai = 0; ai < numA; ai++) {
      try {
        var at = qeSeq.getAudioTrackAt(ai);
        try { at.razor(tc0, true, true); $._EXT_PRM_._bump(); stats.applied++; } catch (eAR0) { $._EXT_PRM_._statFail(stats, eAR0); }
        try { at.razor(tc1, true, true); $._EXT_PRM_._bump(); stats.applied++; } catch (eAR1) { $._EXT_PRM_._statFail(stats, eAR1); }
      } catch (eAR) { $._EXT_PRM_._statFail(stats, eAR); }
    }

    /* Теперь находим и удаляем все клипы, попавшие целиком в [t0,t1].
     *
     * Оптимизация (вместо реверс-скана ВСЕХ клипов дорожки): клипы на дорожке
     * упорядочены по времени, поэтому собираем кандидатов одним прямым проходом
     * с ранним выходом при start >= t1 (дальше только более поздние клипы),
     * затем удаляем собранное справа налево — ripple-сдвиг от удаления не
     * затрагивает клипы ЛЕВЕЕ удаляемого, ссылки остаются валидными.
     *
     * Полный кэш клипов МЕЖДУ интервалами невозможен: razor пересоздаёт
     * коллекцию clips (split рождает новые TrackItem'ы), поэтому скан
     * выполняется заново на каждый интервал, но ограничен окном [0..t1]. */
    var removed = 0;
    function purgeTrack(curTrack) {
      var doomed = [];
      var jj, cnd, cs2, ce2;
      for (jj = 0; jj < curTrack.clips.numItems; jj++) {
        try {
          cnd = curTrack.clips[jj];
          if (!cnd) continue;
          cs2 = cnd.start.seconds;
          if (cs2 >= t1 + eps) break; /* дорожка упорядочена — дальше только позже */
          ce2 = cnd.end.seconds;
          /* Клип целиком внутри [t0, t1] (с допуском eps) */
          if (cs2 >= t0 - eps && ce2 <= t1 + eps) doomed.push(cnd);
        } catch (eScan) {}
      }
      for (jj = doomed.length - 1; jj >= 0; jj--) {
        try {
          doomed[jj].remove(ripFlag, 1);
          $._EXT_PRM_._bump();
          removed++;
          stats.applied++;
        } catch (eRem) { $._EXT_PRM_._statFail(stats, eRem); }
      }
    }
    for (vi = 0; vi < seq.videoTracks.numTracks; vi++) purgeTrack(seq.videoTracks[vi]);
    for (ai = 0; ai < seq.audioTracks.numTracks; ai++) purgeTrack(seq.audioTracks[ai]);
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
      try { clip.remove(ripFlag, 1); $._EXT_PRM_._bump(); stats.applied++; } catch (eR) { $._EXT_PRM_._statFail(stats, eR); }
      log.push({ op: doRipple ? 'remove_clip_ripple' : 'remove_clip_lift', nodeId: String(clip.nodeId) });
      continue;
    }

    /* Case 2: отрезает начало клипа */
    if (i0 <= s + eps && i1 < e - eps) {
      clip.inPoint.seconds = srcIn + (i1 - s); $._EXT_PRM_._bump();
      if (Math.abs(clip.start.seconds - i1) > eps) { clip.start.seconds = i1; $._EXT_PRM_._bump(); }
      stats.applied++;
      log.push({ op: 'trim_prefix', nodeId: String(clip.nodeId), newStartSec: i1 });
      continue;
    }

    /* Case 3: отрезает конец клипа */
    if (i0 > s + eps && i1 >= e - eps) {
      clip.outPoint.seconds = srcIn + (i0 - s); $._EXT_PRM_._bump();
      if (Math.abs(clip.end.seconds - i0) > eps) { clip.end.seconds = i0; $._EXT_PRM_._bump(); }
      stats.applied++;
      log.push({ op: 'trim_suffix', nodeId: String(clip.nodeId), newEndSec: i0 });
      continue;
    }

    /* Case 4: середина — без QE только обрезка до t0 (правая часть потеряна) */
    if (i0 > s + eps && i1 < e - eps) {
      clip.outPoint.seconds = srcIn + (i0 - s); $._EXT_PRM_._bump();
      if (Math.abs(clip.end.seconds - i0) > eps) { clip.end.seconds = i0; $._EXT_PRM_._bump(); }
      stats.applied++;
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
      c.start.seconds = ns; $._EXT_PRM_._bump();
      c.end.seconds = ne; $._EXT_PRM_._bump();
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
      c.start.seconds = ns; $._EXT_PRM_._bump();
      c.end.seconds = ne; $._EXT_PRM_._bump();
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
      c.inPoint.seconds = newIn; $._EXT_PRM_._bump();
      /* Premiere может автоматически скорректировать start/end.
         Если start не сместился — двигаем вручную: */
      if (Math.abs(c.start.seconds - newStartSec) > $._EXT_PRM_._EPS) {
        c.start.seconds = newStartSec; $._EXT_PRM_._bump();
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
      c.outPoint.seconds = c.outPoint.seconds - delta; $._EXT_PRM_._bump();
      /* Если end не скорректировался — поправляем вручную: */
      if (Math.abs(c.end.seconds - newEndSec) > $._EXT_PRM_._EPS) {
        c.end.seconds = newEndSec; $._EXT_PRM_._bump();
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
    /* seq.end.seconds на ряде сборок PP возвращает 0 (особенно на мультикам/
       вложенных секвенциях) — считаем реальный конец как максимум по клипам. */
    var maxClipEnd = 0;
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
          if (item.end.seconds > maxClipEnd) maxClipEnd = item.end.seconds;
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
          var aMediaPath = '';
          try {
            var aPi = item.projectItem;
            if (aPi) {
              if (typeof aPi.getMediaPath === 'function') aMediaPath = String(aPi.getMediaPath() || '');
              else if (aPi.mediaPath) aMediaPath = String(aPi.mediaPath);
            }
          } catch (eMP) {}
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
            disabled: aDisabled,
            mediaPath: aMediaPath.replace(/\\/g, '/')
          });
          if (item.end.seconds > maxClipEnd) maxClipEnd = item.end.seconds;
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
      sequenceEndSec: (seqEndSec > maxClipEnd ? seqEndSec : maxClipEnd),
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

/**
 * J-cut / L-cut: сдвинуть точку монтажа аудио относительно видео.
 *
 * J-cut: аудио следующего клипа начинается ДО видео (offsetFrames < 0 на аудио-inPoint).
 * L-cut: аудио предыдущего клипа продолжается ПОСЛЕ видео (offsetFrames > 0 на аудио-outPoint).
 *
 * Параметры (JSON): { offsetFrames: number (default -4), mode: "j"|"l"|"both" }
 * Применяется ко всем стыкам на V1/A1 (linked пары).
 *
 * Ограничение: работает только если есть запас source-медиа (handle) для сдвига.
 */
/**
 * J-cuts / L-cuts — сдвиг точки монтажа видео относительно аудио.
 *
 * Подход: модифицируем ВИДЕО-клипы, оставляя аудио на месте.
 * - J-cut: видео B обрезается позже (зритель ещё видит A, но слышит B)
 *   → Реализация: обрезаем END видео A на offsetFrames РАНЬШЕ (видео A короче),
 *     а START видео B сдвигаем на offsetFrames РАНЬШЕ (видео B начинается раньше).
 * - L-cut: видео A продолжается дольше (зритель видит A, но слышит уже B)
 *   → Реализация: обрезаем START видео B на offsetFrames ПОЗЖЕ (видео B короче).
 *
 * Ограничения Premiere ExtendScript:
 * - На одной дорожке клипы НЕ МОГУТ перекрываться.
 * - Поэтому мы УКОРАЧИВАЕМ видеоклип с одной стороны стыка,
 *   создавая «окно», где аудио играет, а видео уже переключилось (или ещё нет).
 * - Для полноценных J/L-cuts с перекрытием нужны multi-track (V2/A2).
 */
$._EXT_PRM_.applyJCuts = function (jsonParams) {
  /*
   * J/L-cuts невозможны на связанных клипах одной дорожки (V1+A1).
   * В Premiere Pro при обрезке видео-части связанного клипа аудио-часть
   * обрезается вместе с ней — клип просто укорачивается.
   *
   * J/L-cuts требуют:
   *  1. Клипы на V1/A1 (первый) и V2/A2 (второй) с нахлёстом, ИЛИ
   *  2. Отвязанные (unlinked) клипы на одной дорожке.
   *
   * ExtendScript API не предоставляет метод unlink() для программного
   * разрыва связи видео/аудио. Поэтому эта функция отключена до
   * появления поддержки unlink в ExtendScript или UXP.
   */
  return JSON.stringify({
    ok: false,
    error: 'J/L-cuts невозможны на связанных клипах одной дорожки. ' +
      'При обрезке видео-части связанного клипа аудио обрезается вместе с ним. ' +
      'J/L-cuts требуют клипы на отдельных дорожках (V1/A1 + V2/A2) с перекрытием, ' +
      'либо отвязанные (unlinked) клипы. ExtendScript не поддерживает программное ' +
      'отвязывание клипов. Выполните J/L-cuts вручную в Premiere Pro.'
  });
};

$._EXT_PRM_.applyTimecodeEdits = function (jsonPlan) {
  var undoOpened = false;
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    }
    var seq = app.project.activeSequence;
    var plan = JSON.parse(jsonPlan);

    /* Preflight: если план содержит интервальные операции (razor+remove на ВСЕХ
       дорожках) — заранее проверяем locked-дорожки. Razor/remove на заблокированной
       дорожке молча не сработает → ripple рассинхронизирует дорожки между собой.
       Точечные операции (set_playhead, mute_track и т.п.) не блокируем. */
    var opsPre = plan.operations || [];
    var hasRangeOps = false;
    for (var pi = 0; pi < opsPre.length; pi++) {
      var aPre = opsPre[pi] ? (opsPre[pi].action || opsPre[pi].kind || opsPre[pi].type) : null;
      if (aPre === 'ripple_delete_range' || aPre === 'ripple_delete_range_all_tracks' ||
          aPre === 'lift_delete_range' || aPre === 'lift_delete_range_all_tracks') {
        hasRangeOps = true;
        break;
      }
    }
    if (hasRangeOps) {
      var lockedTE = $._EXT_PRM_._findLockedTracks(seq, null);
      if (lockedTE.length) {
        return JSON.stringify({
          ok: false,
          error: 'Заблокированы дорожки: ' + lockedTE.join(', ') + ' — разблокируйте и повторите',
          lockedTracks: lockedTE
        });
      }
    }

    if (typeof app.beginUndoGroup === 'function') {
      app.beginUndoGroup('ИИ: таймкоды');
      undoOpened = true;
    }
    $._EXT_PRM_._resetOps();
    var ops = plan.operations || [];
    /* Сводный счётчик razor/remove/trim по всем интервальным операциям плана. */
    var rangeStats = { applied: 0, failed: 0, reasons: [] };
    var results = [];
    var i,
      op,
      found,
      r,
      a,
      b;

    for (i = 0; i < ops.length; i++) {
      op = ops[i];
      a = op.action || op.kind || op.type;

      if (a === 'ripple_delete_range' || a === 'ripple_delete_range_all_tracks') {
        if (typeof op.startSec !== 'number' || typeof op.endSec !== 'number') {
          results.push({ op: a, ok: false, error: 'Нужны startSec и endSec' });
          continue;
        }
        /* 19.06.2026: отклоняем negative startSec на границе host (last line of
           defense). JS-слой ловит это для transcript_cuts (HIGH #6), но через
           timecode_edits negative проходил и razor [neg,endSec] молча удалял
           [0,endSec] реального контента. Отклоняем, а не клампим: negative =
           баг вызывающей стороны, тихое удаление [0,endSec] хуже явной ошибки. */
        if (op.startSec < 0) {
          results.push({ op: a, ok: false, error: 'startSec не может быть отрицательным' });
          continue;
        }
        if (op.endSec <= op.startSec) {
          results.push({ op: a, ok: false, error: 'endSec должен быть > startSec' });
          continue;
        }
        var lgR = [];
        $._EXT_PRM_._applyOneTimelineInterval(seq, op.startSec, op.endSec, lgR, true, rangeStats);
        results.push({ op: a, ok: true, log: lgR });
        continue;
      }

      if (a === 'lift_delete_range' || a === 'lift_delete_range_all_tracks') {
        if (typeof op.startSec !== 'number' || typeof op.endSec !== 'number') {
          results.push({ op: a, ok: false, error: 'Нужны startSec и endSec' });
          continue;
        }
        if (op.startSec < 0) {
          results.push({ op: a, ok: false, error: 'startSec не может быть отрицательным' });
          continue;
        }
        if (op.endSec <= op.startSec) {
          results.push({ op: a, ok: false, error: 'endSec должен быть > startSec' });
          continue;
        }
        var lgL = [];
        $._EXT_PRM_._applyOneTimelineInterval(seq, op.startSec, op.endSec, lgL, false, rangeStats);
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
        /* 19.06.2026: negative fromSec на границе host (симметрично negative-guard
           ripple/lift/move_clip). При negative _rippleShiftAllClipsFrom сдвинул бы
           ВСЕ клипы от отрицательной отметки, включая [0..], → порча таймлайна. */
        if (op.fromSec < 0) {
          results.push({ op: a, ok: false, error: 'fromSec не может быть отрицательным' });
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
        /* 19.06.2026: отклоняем inverted bounds ДО модификации. Иначе _setTimelineIn
           подрезал бы start (применился), затем _setTimelineOut с endSec<startSec
           вернул бы ok:false — клип оставался в полу-подрезанном состоянии. */
        if (typeof op.startSec !== 'number' || typeof op.endSec !== 'number') {
          results.push({ op: a, ok: false, error: 'Нужны startSec и endSec (числа)' });
          continue;
        }
        if (op.endSec <= op.startSec) {
          results.push({ op: a, ok: false, error: 'endSec должен быть > startSec' });
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
          try { linked[le].disabled = !enabled; $._EXT_PRM_._bump(); } catch (eEn) {}
        }
        results.push({ op: a, ok: true, enabled: enabled, affectedClips: linked.length });
        continue;
      }

      /* --- set_clips_enabled_by_name: все сегменты с данным именем клипа на секвенции --- */
      if (a === 'set_clips_enabled_by_name') {
        /* ExtendScript (ES3) не имеет String.prototype.trim — используем regex. */
        var nm = String(op.clipName || op.name || '').replace(/^\s+|\s+$/g, '');
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
            $._EXT_PRM_._bump();
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
        /* 19.06.2026: negative newStartSec на границе host (last line of defense,
           симметрично negative-startSec guard для ripple/lift_delete_range). JS-слой
           ловит это в обоих валидаторах (validateTimecodePlan + validateEditPlan),
           но host обязан валидировать свои входы сам: при negative
           _rippleShiftAllClipsFrom сдвигает ВСЕ клипы от отрицательной отметки и
           ставит связку на negative-время → тихая порча всего таймлайна. */
        if (op.newStartSec < 0) {
          results.push({ op: a, ok: false, error: 'newStartSec не может быть отрицательным' });
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
              leadClip.move(tDelta); $._EXT_PRM_._bump();
              moved = _verifyMove();
            }
          } catch (eM1) { mvErr = 'move(Time): ' + String(eM1.message || eM1); }
        }

        /* Стратегия 2: TrackItem.move(ticks как число). */
        if (!moved && Math.abs(deltaSec) > $._EXT_PRM_._EPS) {
          try {
            if (typeof leadClip.move === 'function') {
              var tps2 = $._EXT_PRM_._ticksPerSecond(seq);
              leadClip.move(Math.round(deltaSec * tps2)); $._EXT_PRM_._bump();
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
              var fps = 30;
              try {
                var fpsTime = seq.timebase ? Math.round(254016000000 / parseFloat(seq.timebase)) : 30;
                if (fpsTime > 0 && fpsTime < 1000) fps = fpsTime;
              } catch (eF) {}
              function pad(n) { return n < 10 ? '0' + n : '' + n; }
              /* 19.06.2026: tcStr считаем ПО-КЛИПНО от ТЕКУЩЕЙ позиции до newStartSec.
                 Раньше дельта была фиксированной (newStartSec-oldStartSec) и применялась
                 ко ВСЕМ клипам, включая те, что уже сдвинула стратегия 1 (move(Time)) →
                 двойной сдвиг видео и A/V-десинк (live-баг: target 48.24 → факт 53.25).
                 Теперь каждый клип едет ровно на остаток до цели; уже на месте → пропуск. */
              function _tcFromDelta(perDelta) {
                var sgn = perDelta < 0 ? '-' : '';
                var ad = Math.abs(perDelta);
                var hh = Math.floor(ad / 3600);
                var mm = Math.floor((ad - hh * 3600) / 60);
                var ssF = ad - hh * 3600 - mm * 60;
                var ss = Math.floor(ssF);
                var ff = Math.round((ssF - ss) * fps);
                if (ff >= fps) { ff = 0; ss++; }
                return sgn + pad(hh) + ';' + pad(mm) + ';' + pad(ss) + ';' + pad(ff);
              }
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
                var qeClipStart = origStart;
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
                          if (isVideo && trackLists[qtl].kind === 'video') { qeClip = cit2; qeClipStart = cs2; break; }
                          if (!isVideo && trackLists[qtl].kind === 'audio') { qeClip = cit2; qeClipStart = cs2; break; }
                          /* Если mediaType неопределён — берём первый совпавший. */
                          if (!qeClip) { qeClip = cit2; qeClipStart = cs2; }
                        }
                      } catch (eCs2) {}
                    }
                  }
                } catch (eFindL) {}

                /* По-клипная дельта: остаток от текущей позиции до целевого newStartSec.
                   Если клип уже на месте (стратегия 1 его сдвинула) — не двигаем повторно. */
                var perDeltaQ = op.newStartSec - qeClipStart;
                if (qeClip && typeof qeClip.move === 'function' && Math.abs(perDeltaQ) > 0.02) {
                  try {
                    qeClip.move(_tcFromDelta(perDeltaQ)); $._EXT_PRM_._bump();
                    qeMoveLog.push({ ok: true, kind: isVideo ? 'video' : 'audio', from: qeClipStart, perDelta: perDeltaQ });
                  } catch (eQEm) {
                    qeFails++;
                    qeMoveLog.push({ ok: false, kind: isVideo ? 'video' : 'audio', from: qeClipStart, error: String(eQEm.message || eQEm) });
                  }
                } else if (qeClip && Math.abs(perDeltaQ) <= 0.02) {
                  /* Уже на целевой позиции — успех без движения. */
                  qeMoveLog.push({ ok: true, kind: isVideo ? 'video' : 'audio', from: qeClipStart, perDelta: 0, skipped: true });
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
              mvOrder[lm].start.seconds = op.newStartSec; $._EXT_PRM_._bump();
              mvOrder[lm].end.seconds = op.newStartSec + dur; $._EXT_PRM_._bump();
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

      /* --- set_clip_speed: УДАЛЕНО как нереализуемое на PP 2025 ---
       * TrackItem.setSpeed() отсутствует в Premiere Pro 2024+ ScriptingAPI
       * (есть только TrackItem.getSpeed). Программное изменение скорости
       * через ExtendScript не поддерживается. Пользователь меняет скорость
       * вручную в Premiere (правый клик → Speed/Duration). */
      if (a === 'set_clip_speed') {
        results.push({ op: a, ok: false, error: 'set_clip_speed не поддерживается ScriptingAPI Premiere Pro 2025' });
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
          targetTrack.setMute(trMute ? 1 : 0); $._EXT_PRM_._bump();
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

    /* Если БЫЛИ интервальные операции и НИ ОДИН razor/remove не прошёл —
       таймлайн фактически не изменился, честно отвечаем ok:false. */
    if (hasRangeOps && rangeStats.failed > 0 && rangeStats.applied === 0) {
      return JSON.stringify({
        ok: false,
        error: 'ни одна операция не применилась — проверьте, не заблокированы ли дорожки',
        results: results,
        appliedCount: 0,
        failedCount: rangeStats.failed,
        failedReasons: rangeStats.reasons,
        undoSteps: $._EXT_PRM_._opCounter,
        hostVersion: $._EXT_PRM_.version
      });
    }
    return JSON.stringify({
      ok: true,
      results: results,
      appliedCount: rangeStats.applied,
      failedCount: rangeStats.failed,
      failedReasons: rangeStats.reasons,
      undoSteps: $._EXT_PRM_._opCounter,
      hostVersion: $._EXT_PRM_.version
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e), undoSteps: $._EXT_PRM_._opCounter });
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

    /* Preflight: заблокированные дорожки. Razor/remove на locked-дорожке молча
       не сработает → рассинхрон видео/аудио. Не трогаем таймлайн вообще. */
    var lockedTC = $._EXT_PRM_._findLockedTracks(seq, null);
    if (lockedTC.length) {
      return JSON.stringify({
        ok: false,
        error: 'Заблокированы дорожки: ' + lockedTC.join(', ') + ' — разблокируйте и повторите',
        lockedTracks: lockedTC
      });
    }

    if (typeof app.beginUndoGroup === 'function') {
      app.beginUndoGroup('ИИ: монтаж по тексту');
      undoOpened = true;
    }
    $._EXT_PRM_._resetOps();
    var intervals = cuts.removeIntervals || [];
    var sorted = intervals.slice().sort(function (x, y) {
      return y.startSec - x.startSec;
    });
    var allLog = [];
    /* Сводный счётчик razor/remove/trim по всем интервалам (см. _statFail). */
    var stats = { applied: 0, failed: 0, reasons: [] };
    var k,
      iv,
      lg;
    for (k = 0; k < sorted.length; k++) {
      iv = sorted[k];
      if (typeof iv.startSec !== 'number' || typeof iv.endSec !== 'number') continue;
      /* 19.06.2026: пропускаем negative startSec (симметрично negative-guard в
         ripple/lift_delete_range и move_clip). _applyOneTimelineInterval через
         _secToTimecode клампит negative→0 и razor молча удаляет [0,endSec]
         реального контента. JS-слой (validateTranscriptCuts HIGH #6) это ловит,
         но host обязан валидировать сам как last line of defense. */
      if (iv.startSec < 0) continue;
      if (iv.endSec <= iv.startSec) continue;
      lg = [];
      $._EXT_PRM_._applyOneTimelineInterval(seq, iv.startSec, iv.endSec, lg, true, stats);
      allLog.push({ interval: iv, log: lg });
    }
    /* Все операции провалились (например, дорожки заблокировали после preflight,
       или QE отказал) — честный ok:false вместо тихого «успеха». */
    if (stats.failed > 0 && stats.applied === 0) {
      return JSON.stringify({
        ok: false,
        error: 'ни одна операция не применилась — проверьте, не заблокированы ли дорожки',
        appliedIntervals: sorted.length,
        appliedCount: 0,
        failedCount: stats.failed,
        failedReasons: stats.reasons,
        details: allLog,
        undoSteps: $._EXT_PRM_._opCounter,
        hostVersion: $._EXT_PRM_.version
      });
    }
    return JSON.stringify({
      ok: true,
      appliedIntervals: sorted.length,
      appliedCount: stats.applied,
      failedCount: stats.failed,
      failedReasons: stats.reasons,
      details: allLog,
      undoSteps: $._EXT_PRM_._opCounter,
      hostVersion: $._EXT_PRM_.version
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e), undoSteps: $._EXT_PRM_._opCounter });
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
    $._EXT_PRM_._resetOps();
    var markers = seq.markers;
    if (!markers) {
      if (undoOpened && typeof app.endUndoGroup === 'function') { try { app.endUndoGroup(); } catch (eUE) {} }
      return JSON.stringify({ ok: false, error: 'Коллекция markers недоступна у активной секвенции' });
    }
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
      $._EXT_PRM_._bump(); /* createMarker → шаг undo */
      var vs = _mkPos(mmk);
      var dr = vs !== null ? Math.abs(vs - targetSec) : null;
      return { mk: mmk, verifiedSec: vs, drift: dr };
    };
    /* Вспом.: удалить маркер (для retry). Откатывает счётчик: создание + удаление = 0 чистых шагов. */
    var _mkDelete = function (mm) {
      try {
        if (mm && typeof markers.deleteMarker === 'function') {
          markers.deleteMarker(mm);
          if ($._EXT_PRM_._opCounter > 0) $._EXT_PRM_._opCounter--;
        }
      } catch (eDel) {}
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

        /* Span-маркер: KNOWN BROKEN на PP 2025 (см. .omc/research/premiere-api-audit.md).
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
    /* Агрегация дрейфа: максимальный (мс) и число маркеров с дрейфом > 100 мс.
       Раньше per-marker drift вычислялся и терялся — UI не видел проблему. */
    var maxDriftSec = 0;
    var driftWarnings = 0;
    var createdSeconds = [];
    for (var cd = 0; cd < created.length; cd++) {
      var dsc = created[cd].driftSec;
      if (dsc !== null && dsc !== undefined && !isNaN(dsc)) {
        if (dsc > maxDriftSec) maxDriftSec = dsc;
        if (dsc > 0.1) driftWarnings++;
        if (dsc > 1.0) anyDrift = true;
      }
      if (created[cd].spanRequested) anySpanRequested = true;
      if (created[cd].spanApplied) anySpanApplied = true;
      var ks = created[cd].verifiedSec !== null && created[cd].verifiedSec !== undefined
        ? created[cd].verifiedSec : created[cd].timeSec;
      if (typeof ks === 'number' && !isNaN(ks)) createdSeconds.push(ks);
    }
    var spanNotSupported = anySpanRequested && !anySpanApplied;
    return JSON.stringify({
      ok: true,
      created: created,
      createdSeconds: createdSeconds,
      count: created.length,
      failed: failed,
      failedCount: failed.length,
      undoSteps: $._EXT_PRM_._opCounter,
      undoMode: 'markers',
      maxDriftMs: Math.round(maxDriftSec * 1000),
      driftWarnings: driftWarnings,
      driftWarning: anyDrift ? 'Некоторые маркеры сместились более чем на 1 с от запрошенной позиции — проверьте визуально' : null,
      spanNotSupported: spanNotSupported,
      spanNotice: spanNotSupported
        ? 'Known-broken на этой сборке PP 2025: API не позволяет создавать span-маркеры (длительность) программно — все маркеры получились точечными, несмотря на endSec. Диапазон добавлен в comments маркера текстом. См. .omc/research/premiere-api-audit.md.'
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
 * Откат таймкодов / монтажа по тексту средствами плагина НЕ реализован.
 * Причина: Edit→Undo на PP 2025 нестабилен после ripple-cuts, а пакетный
 * откат N шагов (десятки операций в реальных монтажах) — нерабочее решение.
 * Пользователь откатывает штатно: Cmd+Z / Ctrl+Z в таймлайне Premiere.
 * Для маркеров откат сохранён ниже через removeMarkersBySeconds
 * (markers.deleteMarker по списку секунд) — Edit→Undo маркеры не откатывает.
 *
 * Ранее здесь жили: $._EXT_PRM_.undoSteps(n), $._EXT_PRM_.undoLast(),
 * $._EXT_PRM_._resolveUndoCid() — все удалены.
 */

/**
 * Удалить маркеры по их позициям (секундам). Используется как механизм undo
 * для addSequenceMarkers, потому что Edit→Undo на PP 2025 НЕ откатывает
 * создание маркеров (known broken). Толерантность ±0.1 с к дрейфу.
 */
$._EXT_PRM_.removeMarkersBySeconds = function (jsonArg) {
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    }
    var seq = app.project.activeSequence;
    var arg = JSON.parse(jsonArg);
    var seconds = arg.seconds || [];
    if (!seconds.length) return JSON.stringify({ ok: true, removed: 0 });
    var tol = typeof arg.tolerance === 'number' ? arg.tolerance : 0.15;
    var markers = seq.markers;
    if (!markers) {
      return JSON.stringify({ ok: false, error: 'Коллекция markers недоступна у активной секвенции' });
    }
    var removed = 0;
    var failed = [];
    /* Проходим по каждому запрошенному секундному значению; для каждого ищем самый близкий маркер. */
    var s, mk, best, bestD, found;
    for (var i = 0; i < seconds.length; i++) {
      s = parseFloat(seconds[i]);
      if (isNaN(s)) continue;
      best = null; bestD = 1e9;
      try {
        if (typeof markers.getFirstMarker === 'function') {
          mk = markers.getFirstMarker();
          while (mk) {
            try {
              var ms = mk.start && typeof mk.start.seconds === 'number' ? mk.start.seconds : null;
              if (ms !== null) {
                var d = Math.abs(ms - s);
                if (d < bestD && d <= tol) { bestD = d; best = mk; }
              }
            } catch (eGS) {}
            try { mk = markers.getNextMarker(mk); } catch (eGN) { mk = null; }
          }
        } else if (markers.numMarkers !== undefined) {
          for (var k = 0; k < markers.numMarkers; k++) {
            try {
              var mm = markers[k];
              if (!mm) continue;
              var ms2 = mm.start && typeof mm.start.seconds === 'number' ? mm.start.seconds : null;
              if (ms2 !== null) {
                var d2 = Math.abs(ms2 - s);
                if (d2 < bestD && d2 <= tol) { bestD = d2; best = mm; }
              }
            } catch (eIx) {}
          }
        }
      } catch (eIter) {}
      if (best) {
        try {
          markers.deleteMarker(best);
          removed++;
        } catch (eDel) {
          failed.push({ sec: s, error: String(eDel.message || eDel) });
        }
      } else {
        failed.push({ sec: s, error: 'не найден маркер ближе ' + tol + ' с' });
      }
    }
    return JSON.stringify({
      ok: true,
      removed: removed,
      requested: seconds.length,
      failed: failed,
      hostVersion: $._EXT_PRM_.version
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/**
 * Импортировать файл в проект (в корневой bin или в "AI Renders" если задано).
 * jsonArg: { path:string, binName?:string }
 * Возвращает { ok, projectItemName }
 */
$._EXT_PRM_.importMediaFile = function (jsonArg) {
  try {
    if (!app.project) return JSON.stringify({ ok: false, error: 'Нет открытого проекта' });
    var arg = JSON.parse(jsonArg);
    var p = String(arg.path || '').replace(/\\/g, '/');
    if (!p || !$._EXT_PRM_._fileExists(p)) {
      return JSON.stringify({ ok: false, error: 'Файл не найден: ' + p });
    }
    var binName = String(arg.binName || 'AI Renders');
    /* Находим/создаём bin */
    var rootItem = app.project.rootItem;
    var targetBin = null;
    try {
      for (var ci = 0; ci < rootItem.children.numItems; ci++) {
        var ch = rootItem.children[ci];
        if (ch && ch.name === binName && ch.type === 2 /* BIN */) {
          targetBin = ch; break;
        }
      }
    } catch (eFind) {}
    if (!targetBin) {
      try {
        targetBin = rootItem.createBin(binName);
      } catch (eBin) { targetBin = rootItem; }
    }
    /* Определяем количество элементов до импорта, чтобы найти новый */
    var beforeCount = 0;
    try { beforeCount = targetBin.children.numItems; } catch (eBC) {}
    var imported = false;
    try {
      app.project.importFiles([p], false, targetBin, false);
      imported = true;
    } catch (eImp1) {
      try { app.project.importFiles([p]); imported = true; } catch (eImp2) {
        return JSON.stringify({ ok: false, error: 'importFiles упал: ' + String(eImp1.message || eImp1) });
      }
    }
    /* Имя нового элемента — basename файла. Не используем regex с '/' в char class —
       ExtendScript некорректно завершает regex literal на '/' даже внутри [...]. */
    var basename = p;
    var slashIdx = basename.lastIndexOf('/');
    if (slashIdx >= 0) basename = basename.substring(slashIdx + 1);
    var bsIdx = basename.lastIndexOf('\\');
    if (bsIdx >= 0) basename = basename.substring(bsIdx + 1);
    return JSON.stringify({
      ok: true,
      projectItemName: basename,
      binName: binName,
      imported: imported,
      hostVersion: $._EXT_PRM_.version
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/**
 * Получить mediaPath клипа по nodeId (быстрый lookup без полного снимка).
 */
$._EXT_PRM_.getClipMediaPath = function (nodeId) {
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    }
    var seq = app.project.activeSequence;
    var found = $._EXT_PRM_._findClipByNodeId(seq, nodeId);
    if (!found) return JSON.stringify({ ok: false, error: 'Клип не найден: ' + nodeId });
    var clip = found.clip;
    var pi = clip.projectItem;
    var mp = '';
    try {
      if (pi && typeof pi.getMediaPath === 'function') mp = String(pi.getMediaPath() || '');
      else if (pi && pi.mediaPath) mp = String(pi.mediaPath);
    } catch (eGP) {}
    if (!mp) return JSON.stringify({ ok: false, error: 'У клипа нет mediaPath (вложенная секвенция/генератор)' });
    return JSON.stringify({
      ok: true,
      mediaPath: mp.replace(/\\/g, '/'),
      name: clip.name || '',
      startSec: clip.start.seconds,
      endSec: clip.end.seconds,
      inPointSec: clip.inPoint ? clip.inPoint.seconds : 0,
      outPointSec: clip.outPoint ? clip.outPoint.seconds : null
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/**
 * B1-1 (2026-06-11): переместить плейхед активной секвенции на заданную секунду.
 * Используется кликабельными таймкодами в карточках предложений панели.
 */
$._EXT_PRM_.setPlayheadSec = function (timeSec) {
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    }
    var sec = Number(timeSec);
    if (isNaN(sec) || sec < 0) {
      return JSON.stringify({ ok: false, error: 'Нужен timeSec (число >= 0)' });
    }
    var seq = app.project.activeSequence;
    var t = new Time();
    t.seconds = sec;
    seq.setPlayerPosition(t.ticks);
    return JSON.stringify({ ok: true, timeSec: sec });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/**
 * B2-9 (2026-06-11, заимствовано из Descript Underlord v2 «checkpoint»):
 * Бэкап активной секвенции перед разрушительным apply.
 * Sequence.clone() дублирует секвенцию; новую находим по diff sequenceID
 * (clone() ничего не возвращает), переименовываем с меткой времени.
 * Revert = activateSequenceById(backupId) — пользователь продолжает работу
 * в нетронутой копии (программный undo ripple-удалений невозможен).
 */
$._EXT_PRM_.backupActiveSequence = function () {
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    }
    var seq = app.project.activeSequence;
    if (typeof seq.clone !== 'function') {
      return JSON.stringify({ ok: false, error: 'Sequence.clone() недоступен в этой версии Premiere' });
    }
    var seqs = app.project.sequences;
    var before = {};
    for (var i = 0; i < seqs.numSequences; i++) {
      before[String(seqs[i].sequenceID)] = 1;
    }
    seq.clone();
    seqs = app.project.sequences;
    var created = null;
    for (var j = 0; j < seqs.numSequences; j++) {
      if (!before[String(seqs[j].sequenceID)]) { created = seqs[j]; break; }
    }
    if (!created) {
      return JSON.stringify({ ok: false, error: 'clone() не создал новую секвенцию' });
    }
    var d = new Date();
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var stamp = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
    try { created.name = String(seq.name) + ' [бэкап ' + stamp + ']'; } catch (eN) {}
    /* clone() может сделать копию активной — возвращаем фокус на оригинал */
    try {
      if (app.project.activeSequence &&
          String(app.project.activeSequence.sequenceID) !== String(seq.sequenceID)) {
        app.project.activeSequence = seq;
      }
    } catch (eA) {}
    return JSON.stringify({
      ok: true,
      backupId: String(created.sequenceID),
      backupName: String(created.name || ''),
      originalName: String(seq.name || '')
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/** B2-9: активировать секвенцию по sequenceID (Revert на бэкап). */
$._EXT_PRM_.activateSequenceById = function (seqId) {
  try {
    if (!app.project) return JSON.stringify({ ok: false, error: 'Нет проекта' });
    var want = String(seqId);
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) {
      if (String(seqs[i].sequenceID) === want) {
        app.project.activeSequence = seqs[i];
        return JSON.stringify({ ok: true, name: String(seqs[i].name || '') });
      }
    }
    return JSON.stringify({ ok: false, error: 'Секвенция не найдена: ' + want });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/**
 * Phase 1 (PP-26 stabilization, 2026-04-29):
 * Декорируем все экспортируемые функции через _wrap. Каждый необработанный
 * exception теперь попадёт в bridge как структурированный JSON
 * {_hostError:true, fn, msg, line, source, stack} — вместо непрозрачной
 * литеральной строки "EvalScript error.".
 *
 * Идемпотентно: повторный $.evalFile() не двойной обёрткой.
 * Отсутствует в legacy путь — если _wrap не загрузился, оригиналы остаются.
 */
/**
 * MultiCam Phase 1 MVP (2026-04-30):
 * Применить план переключения камер.
 *
 * План — это:
 *   plan.segments = [{tStart, tEnd, activeVideoTrack}]
 *   plan.mapping  = {wideVideoTrack, speakers: [{audioTrack, videoTrack, label}]}
 *   plan.params.mode = 'disable' | 'delete'
 *
 * Алгоритм:
 *   1. Razor каждой видеодорожки (только тех что в mapping — wide + speakers) в каждой
 *      внутренней границе сегментов (т.е. tEnd_i, кроме самого последнего).
 *   2. Для каждого сегмента и каждой видеодорожки:
 *      - Найти TrackItem'ы, попадающие в [tStart, tEnd] (после razor — это будет 1 клип).
 *      - Если track !== activeVideoTrack:
 *          mode='disable' → clip.disabled = true
 *          mode='delete'  → clip.remove(0, 0)  (lift, без ripple — оставляем дыру)
 *
 * Аудиодорожки НЕ трогаем — пользователь выбирает что слышно через A1/A2 микшер.
 *
 * Возвращает: {ok, cutsApplied, segmentsApplied, mode, undoSteps}.
 *
 * См. .omc/plans/multicam-phase1-mvp.md и .omc/research/multicam-podcast-feature.md.
 */
$._EXT_PRM_.applyMulticamCuts = function (jsonPlan) {
  if (!app.project || !app.project.activeSequence) {
    return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
  }
  var plan;
  try {
    plan = JSON.parse(jsonPlan);
  } catch (eJ) {
    return JSON.stringify({ ok: false, error: 'Невалидный JSON плана: ' + String(eJ) });
  }
  if (!plan || !plan.segments || !plan.segments.length) {
    return JSON.stringify({ ok: false, error: 'plan.segments пустой' });
  }
  if (!plan.mapping || typeof plan.mapping.wideVideoTrack !== 'number') {
    return JSON.stringify({ ok: false, error: 'plan.mapping обязателен' });
  }

  var mode = (plan.params && plan.params.mode) === 'delete' ? 'delete' : 'disable';
  var seq = app.project.activeSequence;
  var eps = $._EXT_PRM_._EPS;

  /* Открываем undo group если поддерживается. */
  var undoOpened = false;
  try {
    if (typeof app.beginUndoGroup === 'function') {
      app.beginUndoGroup('ИИ: авто-MultiCam');
      undoOpened = true;
    }
  } catch (eU) {}
  $._EXT_PRM_._resetOps();

  /* Список видеодорожек, которые мы реально режем. */
  var managedTracks = [plan.mapping.wideVideoTrack];
  if (plan.mapping.speakers && plan.mapping.speakers.length) {
    for (var sp = 0; sp < plan.mapping.speakers.length; sp++) {
      var v = plan.mapping.speakers[sp].videoTrack;
      if (typeof v === 'number') {
        var dup = false;
        for (var d = 0; d < managedTracks.length; d++) {
          if (managedTracks[d] === v) { dup = true; break; }
        }
        if (!dup) managedTracks.push(v);
      }
    }
  }

  /* Preflight: заблокированные управляемые дорожки. Razor на locked-дорожке
     молча не сработает → план «порежется» частично и сегменты разъедутся. */
  var lockedMC = $._EXT_PRM_._findLockedTracks(seq, managedTracks);
  if (lockedMC.length) {
    if (undoOpened) try { app.endUndoGroup(); } catch (eEUL) {}
    return JSON.stringify({
      ok: false,
      error: 'Заблокированы дорожки: ' + lockedMC.join(', ') + ' — разблокируйте и повторите',
      lockedTracks: lockedMC
    });
  }

  /* FPS для QE razor таймкода — точный float (NTSC-safe, см. _sequenceFps). */
  var fps = $._EXT_PRM_._sequenceFps(seq);

  /* QE razor доступен? */
  var qeAvailable = false;
  var qeSeq = null;
  try {
    if (typeof app.enableQE === 'function') app.enableQE();
    if (typeof qe !== 'undefined' && qe.project && typeof qe.project.getActiveSequence === 'function') {
      qeSeq = qe.project.getActiveSequence();
      if (qeSeq) qeAvailable = true;
    }
  } catch (eQE) {}

  if (!qeAvailable) {
    if (undoOpened) try { app.endUndoGroup(); } catch (eEU) {}
    return JSON.stringify({
      ok: false,
      error: 'QE DOM недоступен. MultiCam требует razor() — невозможно без QE.'
    });
  }

  /* HIGH #2 (6 мая 2026): outer try/finally чтобы endUndoGroup ВСЕГДА вызывался,
     даже если razor/disable выбросил unexpected throw в горячем пути. Без этого
     открытая undo group leaks в Premiere → пользователь видит «битую» undo. */
  var cutsApplied = 0;
  var segmentsApplied = 0;
  var disabledCount = 0;
  var deletedCount = 0;
  /* Счётчик неудачных razor/remove — раньше ошибки глотались молча. */
  var mcStats = { applied: 0, failed: 0, reasons: [] };
  try {
    /* Шаг 1: razor на ВСЕХ внутренних границах сегментов. */
    var cutTimes = [];
    for (var si = 0; si < plan.segments.length - 1; si++) {
      var t = plan.segments[si].tEnd;
      if (typeof t !== 'number') continue;
      cutTimes.push(t);
    }
    /* Дедупликация (на случай если соседние сегменты одинаковые). */
    cutTimes.sort(function (a, b) { return a - b; });
    var dedup = [];
    for (var ct = 0; ct < cutTimes.length; ct++) {
      if (ct === 0 || Math.abs(cutTimes[ct] - cutTimes[ct - 1]) > eps) {
        dedup.push(cutTimes[ct]);
      }
    }
    cutTimes = dedup;

    for (var cti = 0; cti < cutTimes.length; cti++) {
      var tc = $._EXT_PRM_._secToTimecode(cutTimes[cti], fps);
      for (var mt = 0; mt < managedTracks.length; mt++) {
        var trackIdx = managedTracks[mt];
        try {
          var qVT = qeSeq.getVideoTrackAt(trackIdx);
          if (qVT) {
            try { qVT.razor(tc, true, true); $._EXT_PRM_._bump(); cutsApplied++; } catch (eRZ) { $._EXT_PRM_._statFail(mcStats, eRZ); }
          }
        } catch (eGT) { $._EXT_PRM_._statFail(mcStats, eGT); }
      }
    }

    /* Шаг 2: для каждого сегмента — disable неактивные V-track'и. */
    for (var sgi = 0; sgi < plan.segments.length; sgi++) {
      var seg = plan.segments[sgi];
      var t0 = seg.tStart;
      var t1 = seg.tEnd;
      var activeV = seg.activeVideoTrack;
      if (typeof t0 !== 'number' || typeof t1 !== 'number' || typeof activeV !== 'number') continue;

      for (var mvt = 0; mvt < managedTracks.length; mvt++) {
        var trk = managedTracks[mvt];
        if (trk >= seq.videoTracks.numTracks) continue;
        var isActive = (trk === activeV);
        var vTrack = seq.videoTracks[trk];

        /* Идём по клипам в обратном порядке (если delete-mode — индексы не сбьются). */
        for (var ci = vTrack.clips.numItems - 1; ci >= 0; ci--) {
          try {
            var clip = vTrack.clips[ci];
            if (!clip) continue;
            var cs = clip.start.seconds;
            var ce = clip.end.seconds;
            /* Клип попадает в [t0, t1] — целиком внутри сегмента (после razor так и должно быть). */
            if (cs >= t0 - eps && ce <= t1 + eps) {
              if (isActive) {
                /* Активная — гарантируем что enabled. */
                try {
                  if (clip.disabled) { clip.disabled = false; $._EXT_PRM_._bump(); }
                } catch (eEn) {}
              } else {
                /* Неактивная — disable или удалить. */
                if (mode === 'delete') {
                  try { clip.remove(0, 0); $._EXT_PRM_._bump(); deletedCount++; } catch (eRm) { $._EXT_PRM_._statFail(mcStats, eRm); }
                } else {
                  try {
                    if (!clip.disabled) { clip.disabled = true; $._EXT_PRM_._bump(); disabledCount++; }
                  } catch (eDi) { $._EXT_PRM_._statFail(mcStats, eDi); }
                }
              }
            }
          } catch (eC) {}
        }
      }
      segmentsApplied++;
    }
  } finally {
    /* GUARANTEED endUndoGroup даже на throw из горячего пути. */
    if (undoOpened) try { app.endUndoGroup(); } catch (eEU2) {}
  }

  /* Razor хотел резать, но НИ ОДИН cut не прошёл — план не применился. */
  if (mcStats.failed > 0 && cutsApplied === 0 && deletedCount === 0 && disabledCount === 0) {
    return JSON.stringify({
      ok: false,
      error: 'ни одна операция MultiCam не применилась: ' + (mcStats.reasons[0] || 'причина неизвестна'),
      cutsApplied: 0,
      cutsFailed: mcStats.failed,
      failedReasons: mcStats.reasons,
      fpsUsed: fps,
      undoSteps: $._EXT_PRM_._opCounter
    });
  }
  return JSON.stringify({
    ok: true,
    cutsApplied: cutsApplied,
    cutsFailed: mcStats.failed,
    failedReasons: mcStats.reasons,
    segmentsApplied: segmentsApplied,
    disabledCount: disabledCount,
    deletedCount: deletedCount,
    mode: mode,
    managedTracks: managedTracks,
    fpsUsed: fps,
    undoSteps: $._EXT_PRM_._opCounter
  });
};

(function _decorateExportedFunctions() {
  if (typeof $._EXT_PRM_._wrap !== 'function') return;
  var EXPORTED = [
    'getTimelineSnapshot',
    'applyJCuts',
    'applyTimecodeEdits',
    'applyTranscriptCuts',
    'addSequenceMarkers',
    'prepareTranscribeFromTimeline',
    'removeMarkersBySeconds',
    'importMediaFile',
    'getClipMediaPath',
    'applyMulticamCuts',
    'setPlayheadSec',
    'backupActiveSequence',
    'activateSequenceById'
  ];
  for (var i = 0; i < EXPORTED.length; i++) {
    var name = EXPORTED[i];
    var orig = $._EXT_PRM_[name];
    if (typeof orig !== 'function') continue;
    if (orig._wrapped) continue; /* уже обёрнут — пропускаем */
    var wrapped = $._EXT_PRM_._wrap(name, orig);
    wrapped._wrapped = true;
    $._EXT_PRM_[name] = wrapped;
  }
  /* Маркер для bridge — отметить что host подгружен с Phase-1 wrap'ами. */
  $._EXT_PRM_._phase1 = true;
})();

