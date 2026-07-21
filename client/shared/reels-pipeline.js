/**
 * ReelsPipeline — чистая логика функции «Рилс» (17.07.2026).
 *
 * Караоке-кьюи с пословными таймкодами, правило точек, guard LLM-корректуры,
 * генерация ASS-субтитров (none/color/box), ffmpeg-аргументы прозрачного
 * оверлея, план vision-запросов. Без DOM, без Node-зависимостей — тестируется
 * в vm. Оркестрация — в panel.js (toolsRunReels).
 */
(function (global) {
  'use strict';

  /* ── Правило точек ─────────────────────────────────────────────────────
   * Убирается ТОЛЬКО одиночная точка в самом конце титра.
   * «?», «!», «…», «...» и точки в середине текста остаются. */
  function stripCueFinalPeriod(text) {
    var s = String(text == null ? '' : text);
    if (/[^.]\.$/.test(s)) return s.slice(0, -1);
    return s;
  }

  /* ── Vision: cx (0..1, центр лица) → offsetPct для planVerticalReframe ── */
  function offsetPctFromCx(cx) {
    var n = (typeof cx === 'number') ? cx
      : (typeof cx === 'string' && cx !== '') ? Number(cx) : NaN;
    if (!isFinite(n)) return null;
    var pct = (n - 0.5) * 100;
    return Math.max(-50, Math.min(50, Math.round(pct * 10) / 10));
  }

  /* ── Перенос слов в ≤maxLines строк по ≤maxChars (greedy).
   * Копия приватной _wrapWords из deterministic-pipelines (модули shared
   * независимы). null — не влезает. */
  function _wrapWords(words, maxChars, maxLines) {
    var lines = [''];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var cur = lines[lines.length - 1];
      if (!cur.length) {
        if (w.length > maxChars) return null;
        lines[lines.length - 1] = w;
      } else if (cur.length + 1 + w.length <= maxChars) {
        lines[lines.length - 1] = cur + ' ' + w;
      } else {
        if (lines.length >= maxLines || w.length > maxChars) return null;
        lines.push(w);
      }
    }
    return lines.join('\n');
  }

  /* ── Выравнивание слов по речи (Cloud.ru Whisper НЕ отдаёт word-таймкоды,
   * проверено live 17.07.2026: timestamp_granularities[]=word → 200 OK, слов
   * нет). Детерминированная замена: интервал сегмента минус тишины ≥0.3с
   * (ffmpeg silencedetect из audioAnalysis), слова раскладываются по
   * озвученным подынтервалам пропорционально длине слова в символах. ── */

  /* Озвученные интервалы [start,end] за вычетом тишин ≥ minSilenceSec.
   * Формы тишин: {startSec,endSec} и {start,end} (как в deterministic-pipelines).
   * Всё вырезано → деградация: весь [start,end]. */
  function _speechIntervals(start, end, silences, minSilenceSec) {
    var minSil = minSilenceSec > 0 ? minSilenceSec : 0.3;
    var sils = [];
    var n = silences ? silences.length : 0;
    for (var i = 0; i < n; i++) {
      var sl = silences[i];
      if (!sl) continue;
      var s = Number(sl.startSec !== undefined ? sl.startSec : sl.start);
      var e = Number(sl.endSec !== undefined ? sl.endSec : sl.end);
      if (!isFinite(s) || !isFinite(e) || e - s < minSil) continue;
      var cs = Math.max(s, start), ce = Math.min(e, end);
      if (ce > cs) sils.push({ s: cs, e: ce });
    }
    if (!sils.length) return [{ s: start, e: end }];
    sils.sort(function (a, b) { return a.s - b.s; });
    var out = [], cur = start;
    for (var k = 0; k < sils.length; k++) {
      if (sils[k].s > cur + 1e-9) out.push({ s: cur, e: sils[k].s });
      cur = Math.max(cur, sils[k].e);
    }
    if (cur < end - 1e-9) out.push({ s: cur, e: end });
    if (!out.length) return [{ s: start, e: end }];
    return out;
  }

  /**
   * Char-weighted раскладка слов по озвученным интервалам сегмента.
   * words: массив строк; silences: см. _speechIntervals (может быть null).
   * Возвращает [{w,s,e}], слова стыкуются встык, последнее до конца речи.
   */
  function alignWordsChar(words, start, end, silences) {
    var iv = _speechIntervals(start, end, silences, 0.3);
    var total = 0, i;
    for (i = 0; i < iv.length; i++) total += iv[i].e - iv[i].s;
    var chars = 0;
    for (i = 0; i < words.length; i++) chars += Math.max(1, String(words[i]).length);
    /* Позиция на «речевой оси» (0..total) → реальное время: кусочно-линейно,
       тишины перепрыгиваются. */
    function toReal(pos) {
      var acc = 0;
      for (var k = 0; k < iv.length; k++) {
        var d = iv[k].e - iv[k].s;
        if (pos <= acc + d + 1e-9) return iv[k].s + (pos - acc);
        acc += d;
      }
      return iv[iv.length - 1].e;
    }
    var out = [], cum = 0;
    for (i = 0; i < words.length; i++) {
      var w = String(words[i]);
      var dur = total * Math.max(1, w.length) / chars;
      out.push({
        w: w,
        s: Math.round(toReal(cum) * 1000) / 1000,
        e: Math.round(toReal(cum + dur) * 1000) / 1000
      });
      cum += dur;
    }
    return out;
  }

  /**
   * Караоке-кьюи для рилса: Whisper-сегменты → короткие титры с пословными
   * таймкодами. Тайминг слов — из seg.words (если число слов совпадает с
   * текстом), иначе char-weighted по озвученным интервалам. Спикеры не размечаются.
   * Возвращает [{startSec, endSec, text, words:[{w,s,e}]}].
   */
  function buildKaraokeCues(segments, opts) {
    var o = opts || {};
    var maxChars = o.maxCharsPerLine > 0 ? o.maxCharsPerLine : 20;
    var maxLines = o.maxLines > 0 ? o.maxLines : 2;
    var maxDur = o.maxDurSec > 0 ? o.maxDurSec : 4;
    var cues = [];
    if (!segments || !segments.length) return cues;
    for (var i = 0; i < segments.length; i++) {
      var sg = segments[i];
      if (!sg) continue;
      var text = String(sg.text == null ? '' : sg.text).replace(/\s+/g, ' ');
      text = text.replace(/^\s+|\s+$/g, '');
      if (!text) continue;
      var start = Number(sg.startSec);
      var end = Number(sg.endSec);
      if (!isFinite(start) || !isFinite(end) || end <= start) continue;
      var words = text.split(' ');
      /* Пословные таймкоды: нативные seg.words при совпадении длины (приоритет),
         иначе char-weighted + вычитание тишин (opts.silences). */
      var timed = null;
      if (sg.words && sg.words.length === words.length) {
        timed = [];
        for (var k = 0; k < words.length; k++) {
          var ws = Number(sg.words[k].s), we = Number(sg.words[k].e);
          if (!isFinite(ws) || !isFinite(we) || we < ws) { timed = null; break; }
          timed.push({ w: words[k], s: ws, e: we });
        }
      }
      if (!timed) timed = alignWordsChar(words, start, end, o.silences);
      var idx = 0;
      while (idx < words.length) {
        var cueStartIdx = idx;
        var take = [];
        while (idx < words.length) {
          var wrapped = _wrapWords(take.concat([words[idx]]), maxChars, maxLines);
          var candDur = timed[idx].e - timed[cueStartIdx].s;
          if (take.length && (wrapped === null || candDur > maxDur + 1e-9)) break;
          take.push(words[idx]);
          idx++;
          if (wrapped === null) break; /* одно сверхдлинное слово — титром целиком */
        }
        var cueText = wrapCueLines(take, maxChars, maxLines, { hintBreakAfter: null });
        cues.push({
          startSec: Math.round(timed[cueStartIdx].s * 1000) / 1000,
          endSec: Math.round(timed[idx - 1].e * 1000) / 1000,
          text: cueText,
          words: timed.slice(cueStartIdx, idx)
        });
      }
    }
    return cues;
  }

  /* ── LLM-корректура: guard против искажения содержимого ──────────────── */

  /** Нормализация слова для сравнения «то же ли слово»: lowercase, без пунктуации. */
  function _normWord(w) {
    return String(w).toLowerCase().replace(/[.,!?…:;«»"'()\u2014\u2013-]/g, '');
  }

  /** Расстояние Левенштейна (классический DP, слова короткие). */
  function _lev(a, b) {
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  /**
   * Guard корректуры: правка принимается, только если число слов совпадает
   * И каждое изменённое слово отличается от исходного на ≤2 символа
   * (опечатка). Пунктуация/регистр игнорируются при сравнении слов, но
   * сама правка (запятые, заглавные) применяется.
   */
  function proofreadGuardOk(orig, fixed) {
    var a = String(orig == null ? '' : orig).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').split(' ');
    var b = String(fixed == null ? '' : fixed).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').split(' ');
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      var na = _normWord(a[i]), nb = _normWord(b[i]);
      if (na === nb) continue;
      if (_lev(na, nb) > 2) return false;
    }
    return true;
  }

  /**
   * Применение результатов корректуры [{i, text}] к кьюям (без мутации).
   * Guard-провал → правка отклоняется. Переносы строк пересобираются через
   * wrapCueLines, тайминги words не меняются.
   * opts: {maxCharsPerLine, maxLines} — дефолты 20/2 (как в buildKaraokeCues).
   * Возвращает {cues, applied, rejected}.
   */
  function applyProofread(cues, results, opts) {
    var o = opts || {};
    var maxChars = o.maxCharsPerLine > 0 ? o.maxCharsPerLine : 20;
    var maxLines = o.maxLines > 0 ? o.maxLines : 2;
    var out = [];
    for (var i = 0; i < cues.length; i++) out.push(cues[i]);
    var applied = 0, rejected = 0;
    if (!results || !results.length) return { cues: out, applied: applied, rejected: rejected };
    for (var r = 0; r < results.length; r++) {
      var res = results[r];
      if (!res || typeof res.i !== 'number' || !out[res.i] || typeof res.text !== 'string') continue;
      var cue = out[res.i];
      var origFlat = cue.text.replace(/\n/g, ' ');
      var fixedFlat = String(res.text).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
      if (fixedFlat === origFlat) continue; /* без изменений */
      if (!proofreadGuardOk(origFlat, fixedFlat)) { rejected++; continue; }
      var newWords = fixedFlat.split(' ');
      /* Пересборка переносов через wrapCueLines. hintBreakAfter из results[r] если есть, иначе null. */
      var hint = (res && typeof res.hintBreakAfter === 'number') ? res.hintBreakAfter : null;
      var newText = wrapCueLines(newWords, maxChars, maxLines, { hintBreakAfter: hint });
      var words2 = [];
      for (var k = 0; k < cue.words.length; k++) {
        words2.push({ w: newWords[k], s: cue.words[k].s, e: cue.words[k].e });
      }
      out[res.i] = {
        startSec: cue.startSec, endSec: cue.endSec,
        text: newText, words: words2
      };
      applied++;
    }
    return { cues: out, applied: applied, rejected: rejected };
  }

  /**
   * Правка текста кью из модалки (без LLM-guard — правки монтажёра
   * авторитетны). Границы [startSec, endSec] не двигаются; переносы
   * пересобираются greedy; words — char-weighted с вычитанием тишин.
   * Пустой текст → null (кью не меняется). Без мутации входа.
   * opts: {maxCharsPerLine, maxLines, silences}
   * Не влезает в maxChars×maxLines → best-effort: пополам по словам ('\n'),
   * одно сверхдлинное слово — как есть (строка может превысить maxChars).
   */
  function rebuildCueText(cue, newText, opts) {
    var o = opts || {};
    var maxChars = o.maxCharsPerLine > 0 ? o.maxCharsPerLine : 20;
    var maxLines = o.maxLines > 0 ? o.maxLines : 2;
    var flat = String(newText == null ? '' : newText).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!flat) return null;
    var words = flat.split(' ');
    var wrapped = wrapCueLines(words, maxChars, maxLines, { hintBreakAfter: null });
    return {
      startSec: cue.startSec,
      endSec: cue.endSec,
      text: wrapped,
      words: alignWordsChar(words, cue.startSec, cue.endSec, o.silences)
    };
  }

  /* ── ASS-генерация ─────────────────────────────────────────────────────
   * Караоке-приёмы: anim 'color' — \k-теги (Secondary→Primary по мере
   * произнесения: Primary = подсветка, Secondary = цвет текста);
   * anim 'box' — слой 0 статичный текст + слой 1 пословные события стилем
   * Box (BorderStyle=3), не-текущие слова скрыты alpha-масками — libass
   * рисует box per-run, плашка ровно под текущим словом. */

  /** #RRGGBB → &H00BBGGRR (ASS = BGR). Невалидный вход → null. */
  function assColor(hex) {
    var m = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(String(hex == null ? '' : hex));
    if (!m) return null;
    return '&H00' + (m[3] + m[2] + m[1]).toUpperCase();
  }

  /** Секунды → ASS-время H:MM:SS.CC (сантисекунды). */
  function assTime(sec) {
    var cs = Math.max(0, Math.floor(Number(sec) * 100 + 1e-6));
    var h = Math.floor(cs / 360000); cs -= h * 360000;
    var m = Math.floor(cs / 6000); cs -= m * 6000;
    var s = Math.floor(cs / 100); cs -= s * 100;
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return h + ':' + p2(m) + ':' + p2(s) + '.' + p2(cs);
  }

  /* Границы подсветки слов: лид до первого слова вливается в первое,
   * последнее тянется до конца кью. b.length = words.length + 1. */
  function _wordBounds(cue) {
    var b = [cue.startSec];
    for (var i = 1; i < cue.words.length; i++) b.push(cue.words[i].s);
    b.push(cue.endSec);
    return b;
  }

  /* Сборка текста кью из пословных токенов с сохранением переносов:
   * разделители внутри строки ' ', между строками '\N'.
   * tokenFn(wordIndex) → строка токена. */
  function _joinTokens(cue, tokenFn) {
    var lines = cue.text.split('\n');
    var out = '', wi = 0;
    for (var L = 0; L < lines.length; L++) {
      var cnt = lines[L].split(' ').length;
      for (var k = 0; k < cnt; k++) {
        out += (k > 0 ? ' ' : (L > 0 ? '\\N' : '')) + tokenFn(wi);
        wi++;
      }
    }
    return out;
  }

  /**
   * Кьюи → полный текст .ass.
   * opts: {w, h, fontName, textColor:'#RRGGBB', hlColor:'#RRGGBB',
   *        anim:'none'|'color'|'box'}
   */
  function buildAss(cues, opts) {
    var w = opts.w, h = opts.h;
    var anim = opts.anim || 'none';
    var textC = assColor(opts.textColor) || '&H00FFFFFF';
    var hlC = assColor(opts.hlColor) || '&H0038A021';
    var black = '&H00000000';
    var fontSize = Math.round(h * 0.045);
    var marginV = Math.round(h * 0.12);
    var boxPad = Math.max(6, Math.round(fontSize * 0.18));
    /* color: караоке заливает Secondary→Primary → Primary = подсветка */
    var primary = anim === 'color' ? hlC : textC;
    var lines = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: ' + w,
      'PlayResY: ' + h,
      'WrapStyle: 2',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Base,' + opts.fontName + ',' + fontSize + ',' + primary + ',' + textC + ',' + black + ',' + black + ',0,0,0,0,100,100,0,0,1,3,0,2,60,60,' + marginV + ',1'
    ];
    if (anim === 'box') {
      /* BorderStyle=3: box рисуется OutlineColour (у некоторых сборок BackColour) → оба = hl */
      lines.push('Style: Box,' + opts.fontName + ',' + fontSize + ',' + textC + ',' + textC + ',' + hlC + ',' + hlC + ',0,0,0,0,100,100,0,0,3,' + boxPad + ',0,2,60,60,' + marginV + ',1');
    }
    lines.push('', '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

    var ON = '{\\1a&H00&\\3a&H00&\\4a&H00&}';
    var OFF = '{\\1a&HFF&\\3a&HFF&\\4a&HFF&}';
    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var t0 = assTime(cue.startSec), t1 = assTime(cue.endSec);
      var plain = cue.text.replace(/\n/g, '\\N');
      if (anim === 'color' && cue.words && cue.words.length) {
        var b = _wordBounds(cue);
        var karaoke = _joinTokens(cue, function (wi) {
          var cs = Math.max(1, Math.round((b[wi + 1] - b[wi]) * 100));
          return '{\\k' + cs + '}' + cue.words[wi].w;
        });
        lines.push('Dialogue: 0,' + t0 + ',' + t1 + ',Base,,0,0,0,,' + karaoke);
      } else if (anim === 'box' && cue.words && cue.words.length) {
        lines.push('Dialogue: 0,' + t0 + ',' + t1 + ',Base,,0,0,0,,' + plain);
        var bb = _wordBounds(cue);
        for (var k = 0; k < cue.words.length; k++) {
          var evText = (function (cur) {
            return _joinTokens(cue, function (wi) {
              return (wi === cur ? ON : OFF) + cue.words[wi].w;
            });
          })(k);
          lines.push('Dialogue: 1,' + assTime(bb[k]) + ',' + assTime(bb[k + 1]) + ',Box,,0,0,0,,' + evText);
        }
      } else {
        lines.push('Dialogue: 0,' + t0 + ',' + t1 + ',Base,,0,0,0,,' + plain);
      }
    }
    return lines.join('\n') + '\n';
  }

  /* ── ffmpeg: прозрачный оверлей субтитров ──────────────────────────────
   * lavfi-источник прозрачного холста + фильтр ass + ProRes 4444 с альфой
   * (yuva444p10le) — Premiere читает альфу нативно. */
  function buildOverlayFfmpegArgs(o) {
    var assEsc = String(o.assPath).replace(/\\/g, '/').replace(/:/g, '\\:');
    return ['-hide_banner', '-f', 'lavfi',
      '-i', 'color=black@0.0:s=' + o.w + 'x' + o.h + ':r=' + o.fps + ',format=rgba',
      /* alpha=1 ОБЯЗАТЕЛЕН: без него vf_ass рисует текст только в цветовые
       * плоскости, альфа остаётся 0 → в Premiere оверлей полностью прозрачен
       * (подтверждено live 17.07: текст был виден в RGB, alpha плоская). */
      '-vf', "ass='" + assEsc + "':alpha=1",
      '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
      '-t', String(o.durationSec), '-y', String(o.outPath)];
  }

  /* ── Vision по клипам таймлайна (спека 2026-07-20) ──────────────────────
   * Кадр из середины КАЖДОГО клипа таймлайна (source-время с учётом
   * inPoint), близкие кадры одного файла дедупятся, батчи ≤8 кадров
   * на запрос, оффсеты адресные (trackIndex/clipIndex). ── */

  /* planClipFrames: клипы host getVerticalReframeSources (с геометрией) →
   * группы кадров. 'nest:'/пустой mediaPath → skipped (vision недоступен,
   * центр). inPointSec == null (host не смог) → fileMidFallback: панель
   * возьмёт середину файла (текущее поведение как деградация). */
  function planClipFrames(clips, opts) {
    var o = opts || {};
    var dedupeSec = o.dedupeSec > 0 ? o.dedupeSec : 2;
    var frames = [], skipped = [];
    if (!clips || !clips.length) return { frames: frames, skipped: skipped };
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (!c || !c.mediaPath) {
        skipped.push({ name: (c && c.name) || '?', reason: 'нет mediaPath — vision недоступен, центр' });
        continue;
      }
      var p = String(c.mediaPath);
      if (p.indexOf('nest:') === 0) {
        skipped.push({ name: c.name || '?', reason: 'nested-секвенция — vision недоступен, центр' });
        continue;
      }
      var ref = { trackIndex: c.trackIndex, clipIndex: c.clipIndex };
      var mid = null, fallback = false;
      if (typeof c.inPointSec === 'number' && isFinite(c.inPointSec) &&
          typeof c.startSec === 'number' && isFinite(c.startSec) &&
          typeof c.endSec === 'number' && isFinite(c.endSec) &&
          c.endSec > c.startSec) {
        mid = c.inPointSec + (c.endSec - c.startSec) / 2;
      } else {
        fallback = true;
      }
      var joined = false;
      for (var g = 0; g < frames.length; g++) {
        var fr = frames[g];
        if (fr.mediaPath !== p) continue;
        if (fallback && fr.fileMidFallback) { fr.clipRefs.push(ref); joined = true; break; }
        if (!fallback && !fr.fileMidFallback && Math.abs(fr.frameSec - mid) < dedupeSec) {
          fr.clipRefs.push(ref); joined = true; break;
        }
      }
      if (!joined) {
        frames.push({
          mediaPath: p,
          frameSec: fallback ? null : Math.max(0, Math.round(mid * 100) / 100),
          fileMidFallback: fallback,
          clipRefs: [ref]
        });
      }
    }
    return { frames: frames, skipped: skipped };
  }

  /* buildVisionBatches: индексы frames батчами ≤batchSize (по 8 —
   * VISION_MAX_FRAMES, паттерн describe_frames). */
  function buildVisionBatches(frames, opts) {
    var size = (opts && opts.batchSize > 0) ? opts.batchSize : 8;
    var out = [];
    if (!frames || !frames.length) return out;
    var cur = [];
    for (var i = 0; i < frames.length; i++) {
      cur.push(i);
      if (cur.length >= size) { out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /* parseVisionBatchAnswer: ответ vision-модели → массив cx длиной count
   * (null = центр). Ждём JSON-массив [{"i":<1-based номер кадра>,"cx":0..1}],
   * допускаем markdown/текст вокруг. Невалидный cx, кривой JSON, индекс
   * вне диапазона → null. */
  function parseVisionBatchAnswer(text, count) {
    var out = [];
    for (var i = 0; i < count; i++) out.push(null);
    var s = String(text == null ? '' : text);
    var m = s.match(/\[[\s\S]*\]/);
    if (!m) return out;
    var arr;
    try { arr = JSON.parse(m[0]); } catch (e) { return out; }
    if (!arr || !arr.length) return out;
    for (var j = 0; j < arr.length; j++) {
      var it = arr[j];
      if (!it) continue;
      var idx = Number(it.i) - 1;
      if (!isFinite(idx) || idx !== Math.floor(idx) || idx < 0 || idx >= count) continue;
      var cx = (typeof it.cx === 'number') ? it.cx : NaN;
      if (!isFinite(cx) || cx < 0 || cx > 1) continue;
      out[idx] = cx;
    }
    return out;
  }

  /* assignClipOffsets: cx группы → offsetPct на каждый её clipRef.
   * null cx → клипы группы не получают оффсет (останутся центром). */
  function assignClipOffsets(frames, cxList) {
    var out = [];
    if (!frames || !frames.length) return out;
    for (var i = 0; i < frames.length; i++) {
      var cx = (cxList && i < cxList.length) ? cxList[i] : null;
      if (cx === null || cx === undefined) continue;
      var pct = offsetPctFromCx(cx);
      if (pct === null) continue;
      var refs = frames[i].clipRefs || [];
      for (var r = 0; r < refs.length; r++) {
        out.push({ trackIndex: refs[r].trackIndex, clipIndex: refs[r].clipIndex, offsetPct: pct });
      }
    }
    return out;
  }

  /* ── Умный перенос субтитров: висячий предлог + балансировка + LLM-hint ─
   *
   * wrapCueLines(words, maxChars, maxLines, opts) → строка с '\n' между строками.
   *
   * Перебирает все валидные разбивки words на ≤maxLines строк (каждая ≤maxChars
   * символов), выбирает с минимальным штрафом:
   *   HANGING +100: последнее слово строки (не последней) — glue-слово
   *   BALANCE +(max_len - min_len): балансировка длин строк
   *   HINT   -30: разрыв совпадает с opts.hintBreakAfter (LLM-подсказка)
   * Fallback при отсутствии валидных: _wrapWords, затем best-effort пополам.
   */

  /* Словарь glue-слов (предлоги, союзы, частицы). */
  var _GLUE = (function () {
    var g = {};
    var words = [
      'в','во','на','над','под','по','за','к','ко','с','со','о','об','от','до',
      'из','у','для','без','при','про','через','между','перед',
      'и','а','но','да','или','либо','что','чтобы','как','когда','если','чем','то',
      'не','ни','же','бы','ли','уж'
    ];
    for (var _i = 0; _i < words.length; _i++) g[words[_i]] = 1;
    return g;
  }());

  /** Является ли слово glue (сравнение без пунктуации, lowercase). */
  function isGlueWord(w) {
    var bare = String(w).toLowerCase().replace(/[.,!?…:;«»"'()\u2014\u2013-]/g, '');
    return _GLUE[bare] === 1;
  }

  /**
   * Длина строки-группы: слова[from..to] join пробелами.
   * from и to включительно.
   */
  function _groupLen(words, from, to) {
    var n = 0;
    for (var i = from; i <= to; i++) {
      if (i > from) n += 1; /* пробел */
      n += words[i].length;
    }
    return n;
  }

  /**
   * Рекурсивный перебор всех валидных разбивок words[start..end] на linesLeft
   * непустых строк с каждой ≤maxChars. Каждая найденная разбивка — массив
   * индексов концов строк (inclusive): [k0, k1, ...] длиной linesLeft.
   * Результаты добавляются в out.
   */
  function _enumBreaks(words, start, end, linesLeft, breaksSoFar, out) {
    if (linesLeft === 1) {
      /* Последняя строка: words[start..end] должна влезть в maxChars. */
      /* Проверка уже выполнена снаружи (мы добавляем end, только если влезает). */
      var copy = [];
      for (var ci = 0; ci < breaksSoFar.length; ci++) copy.push(breaksSoFar[ci]);
      copy.push(end);
      out.push(copy);
      return;
    }
    /* Пробуем разместить первую из оставшихся строк на [start..k], k < end */
    for (var k = start; k < end; k++) {
      /* Строка [start..k] должна влезать в maxChars. */
      var len = _groupLen(words, start, k);
      if (len > out._maxChars) continue;
      /* Следующая строка начинается с k+1. Проверим, влезет ли последняя часть [k+1..end] в maxChars при linesLeft-1 = 1 (это пессимистичная проверка нижней рекурсии — нет, рекурсия сама проверит). */
      breaksSoFar.push(k);
      /* Проверяем, что оставшимся словам [k+1..end] хватит хотя бы linesLeft-1 строк (не менее одного слова на строку). */
      var remaining = end - k; /* слов от k+1 до end */
      if (remaining >= linesLeft - 1) {
        _enumBreaks(words, k + 1, end, linesLeft - 1, breaksSoFar, out);
      }
      breaksSoFar.pop();
    }
  }

  /**
   * Штраф за разбивку. breaks — массив конечных индексов строк (inclusive).
   * words — исходный массив.
   */
  function _scoreSplit(words, breaks, hintBreakAfter) {
    var penalty = 0;
    /* HANGING: за каждую строку кроме последней, если её последнее слово — glue */
    for (var i = 0; i < breaks.length - 1; i++) {
      var lastW = words[breaks[i]];
      if (isGlueWord(lastW)) penalty += 100;
    }
    /* BALANCE: (max_len - min_len) строк */
    var minLen = -1, maxLen = -1;
    var lineStart = 0;
    for (var j = 0; j < breaks.length; j++) {
      var ln = _groupLen(words, lineStart, breaks[j]);
      if (minLen < 0 || ln < minLen) minLen = ln;
      if (maxLen < 0 || ln > maxLen) maxLen = ln;
      lineStart = breaks[j] + 1;
    }
    penalty += (maxLen - minLen);
    /* HINT: если подсказка совпадает с одной из точек разрыва → бонус -30 */
    if (typeof hintBreakAfter === 'number' && hintBreakAfter >= 0) {
      for (var h = 0; h < breaks.length - 1; h++) {
        if (breaks[h] === hintBreakAfter) { penalty -= 30; break; }
      }
    }
    return penalty;
  }

  /**
   * Умный перенос субтитров.
   * @param {string[]} words  — слова
   * @param {number}   maxChars  — макс символов в строке (дефолт 20)
   * @param {number}   maxLines  — макс строк (дефолт 2)
   * @param {Object}   opts      — {hintBreakAfter: number|null}
   * @returns {string}  строки, разделённые '\n'
   */
  function wrapCueLines(words, maxChars, maxLines, opts) {
    var mxC = (maxChars > 0) ? maxChars : 20;
    var mxL = (maxLines > 0) ? maxLines : 2;
    var o = opts || {};
    var hint = (typeof o.hintBreakAfter === 'number') ? o.hintBreakAfter : null;

    if (!words || !words.length) return '';

    /* Если одно слово — возвращаем как есть, без переносов */
    if (words.length === 1) return words[0];

    /* Перебор всех валидных разбивок. */
    var candidates = [];
    candidates._maxChars = mxC; /* передаём максимум в рекурсию через свойство */

    /* Проверяем, не превышает ли последняя строка (весь хвост) maxChars.
     * _enumBreaks сам проверяет промежуточные строки, но последнюю — нет.
     * Поэтому оборачиваем: добавляем результаты только если последняя строка влезает. */
    var rawOut = [];
    rawOut._maxChars = mxC;

    /* Вызываем для разного числа строк от 1 до mxL */
    for (var nl = 1; nl <= mxL; nl++) {
      if (nl > words.length) break; /* нельзя больше строк, чем слов */
      _enumBreaks(words, 0, words.length - 1, nl, [], rawOut);
    }

    /* Фильтруем: все строки должны влезать в maxChars. */
    for (var ri = 0; ri < rawOut.length; ri++) {
      var breaks = rawOut[ri];
      var valid = true;
      var ls = 0;
      for (var bi = 0; bi < breaks.length; bi++) {
        var gl = _groupLen(words, ls, breaks[bi]);
        if (gl > mxC) { valid = false; break; }
        ls = breaks[bi] + 1;
      }
      if (valid) candidates.push(breaks);
    }

    /* Если нет ни одной валидной разбивки — fallback */
    if (!candidates.length) {
      var fw = _wrapWords(words, mxC, mxL);
      if (fw !== null) return fw;
      if (words.length === 1) return words[0];
      var half = Math.ceil(words.length / 2);
      return words.slice(0, half).join(' ') + '\n' + words.slice(half).join(' ');
    }

    /* Выбираем кандидата с минимальным штрафом */
    var bestBreaks = null;
    var bestScore = 0;
    for (var ci = 0; ci < candidates.length; ci++) {
      var sc = _scoreSplit(words, candidates[ci], hint);
      /* При равенстве — предпочесть меньше строк, затем ближе к центру */
      var better = false;
      if (bestBreaks === null) {
        better = true;
      } else if (sc < bestScore) {
        better = true;
      } else if (sc === bestScore) {
        /* меньше строк лучше */
        if (candidates[ci].length < bestBreaks.length) {
          better = true;
        } else if (candidates[ci].length === bestBreaks.length) {
          /* ближе к центру: смотрим первую точку разрыва (для 2 строк — единственная) */
          var center = (words.length - 1) / 2;
          var distNew = Math.abs(candidates[ci][0] - center);
          var distBest = Math.abs(bestBreaks[0] - center);
          if (distNew < distBest) better = true;
        }
      }
      if (better) {
        bestBreaks = candidates[ci];
        bestScore = sc;
      }
    }

    /* Собираем строки по bestBreaks */
    var lines = [];
    var lstart = 0;
    for (var li = 0; li < bestBreaks.length; li++) {
      lines.push(words.slice(lstart, bestBreaks[li] + 1).join(' '));
      lstart = bestBreaks[li] + 1;
    }
    return lines.join('\n');
  }

  /* ── SRT для caption-дорожки Premiere (importSrtAsCaptions) ──────────── */

  /** Секунды → SRT-время HH:MM:SS,mmm. */
  function srtTime(sec) {
    var ms = Math.round(Number(sec) * 1000); if (!isFinite(ms) || ms < 0) ms = 0;
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    function p3(n) { return (n < 100 ? (n < 10 ? '00' : '0') : '') + n; }
    return p2(h) + ':' + p2(m) + ':' + p2(s) + ',' + p3(ms);
  }

  /** Кьюи → текст .srt (переносы строк кью сохраняются как многострочный блок). */
  function buildSrt(cues) {
    if (!cues || !cues.length) return '';
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      out.push(String(i + 1));
      out.push(srtTime(cues[i].startSec) + ' --> ' + srtTime(cues[i].endSec));
      out.push(cues[i].text);
      out.push('');
    }
    return out.join('\n');
  }

  global.ReelsPipeline = {
    stripCueFinalPeriod: stripCueFinalPeriod,
    offsetPctFromCx: offsetPctFromCx,
    alignWordsChar: alignWordsChar,
    buildKaraokeCues: buildKaraokeCues,
    proofreadGuardOk: proofreadGuardOk,
    applyProofread: applyProofread,
    rebuildCueText: rebuildCueText,
    assColor: assColor,
    assTime: assTime,
    buildAss: buildAss,
    buildOverlayFfmpegArgs: buildOverlayFfmpegArgs,
    planClipFrames: planClipFrames,
    buildVisionBatches: buildVisionBatches,
    parseVisionBatchAnswer: parseVisionBatchAnswer,
    assignClipOffsets: assignClipOffsets,
    srtTime: srtTime,
    buildSrt: buildSrt,
    isGlueWord: isGlueWord,
    wrapCueLines: wrapCueLines
  };
})(window);
