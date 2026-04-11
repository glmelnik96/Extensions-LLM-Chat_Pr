/**
 * Локальный препроцессинг аудио через ffmpeg (Node.js child_process).
 *
 * Три анализатора:
 *   1. detectSilences(path, {threshold, minDurationSec}) → [{startSec, endSec, durationSec}]
 *   2. analyzeLoudness(path) → {inputI, inputTP, inputLRA, inputThresh, targetOffset}  (EBU R128)
 *   3. computeRmsTimeline(path, {windowSec}) → [{t, rms}]
 *
 * Используется:
 *   - timeline-transcribe.js (постпроцесс после экспорта аудио таймлайна)
 *   - tool `analyze_audio` в панелях (по запросу агента)
 *
 * Все функции no-op при отсутствии Node.js (CEP без разрешения <CEFCommandLine>).
 */
(function (global) {
  'use strict';

  function hasNode() {
    return typeof require !== 'undefined';
  }

  /**
   * Найти путь к ffmpeg — CEP Node.js не наследует пользовательский PATH.
   * Дубликат логики из timeline-transcribe.js — оставлено намеренно, чтобы модули были независимы.
   */
  function findFfmpegPath() {
    if (!hasNode()) return null;
    var fs = require('fs');
    var candidates = [
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/usr/bin/ffmpeg',
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
    ];
    for (var i = 0; i < candidates.length; i++) {
      try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
    }
    try {
      var execSync = require('child_process').execSync;
      var p = process.platform === 'win32'
        ? String(execSync('where ffmpeg', { timeout: 5000 })).trim().split('\n')[0]
        : String(execSync('which ffmpeg', {
            timeout: 5000,
            env: Object.assign({}, process.env, {
              PATH: (process.env.PATH || '') + ':/opt/homebrew/bin:/usr/local/bin'
            })
          })).trim();
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
    return null;
  }

  function runFfmpeg(args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!hasNode()) return reject(new Error('Node.js недоступен'));
      var bin = findFfmpegPath();
      if (!bin) return reject(new Error('ffmpeg не найден'));
      var execFile = require('child_process').execFile;
      execFile(bin, args, { timeout: timeoutMs || 180000, maxBuffer: 32 * 1024 * 1024 },
        function (err, stdout, stderr) {
          /* ffmpeg даже при "успехе" пишет метрики в stderr и иногда выходит с кодом 0.
             Также для -f null детектор выходит с кодом 0 и всей информацией в stderr. */
          var exitCode = (err && (err.code != null)) ? err.code : 0;
          if (err && err.code !== 0 && err.code !== null && !(stderr && stderr.length)) {
            return reject(new Error('ffmpeg exit: ' + String(err.message || err)));
          }
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), exitCode: exitCode });
        });
    });
  }

  /**
   * silencedetect: парсим stderr ffmpeg.
   * threshold в dB (например -30 → тише -30 dBFS считается тишиной).
   * minDurationSec — минимальная длина тихого участка.
   *
   * Выход: массив [{startSec, endSec, durationSec}] в секундах внутри файла (НЕ таймлайна).
   */
  function detectSilences(inputPath, opt) {
    opt = opt || {};
    var threshold = typeof opt.thresholdDb === 'number' ? opt.thresholdDb : -30;
    var minDuration = typeof opt.minDurationSec === 'number' ? opt.minDurationSec : 0.5;
    var filter = 'silencedetect=noise=' + threshold + 'dB:d=' + minDuration;
    var args = ['-hide_banner', '-nostats', '-i', inputPath, '-af', filter, '-f', 'null', '-'];
    return runFfmpeg(args, 300000).then(function (res) {
      var out = [];
      var stderr = res.stderr;
      /* Строки:
         [silencedetect @ 0x...] silence_start: 12.345
         [silencedetect @ 0x...] silence_end: 13.210 | silence_duration: 0.865 */
      var startRe = /silence_start:\s*([\d.]+)/g;
      var endRe = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g;
      var starts = [];
      var ends = [];
      var m;
      while ((m = startRe.exec(stderr)) !== null) starts.push(parseFloat(m[1]));
      while ((m = endRe.exec(stderr)) !== null) {
        ends.push({ end: parseFloat(m[1]), duration: parseFloat(m[2]) });
      }
      var n = Math.min(starts.length, ends.length);
      for (var i = 0; i < n; i++) {
        out.push({
          startSec: Math.round(starts[i] * 1000) / 1000,
          endSec: Math.round(ends[i].end * 1000) / 1000,
          durationSec: Math.round(ends[i].duration * 1000) / 1000
        });
      }
      /* Если остался "silence_start" без соответствующего end — тишина тянется до конца файла.
         Оставляем только пары — half-open игнорируем, это безопаснее. */
      return out;
    });
  }

  /**
   * EBU R128 loudness (ebur128-filter, первый проход loudnorm в режиме анализа).
   * Выход: {inputI, inputTP, inputLRA, inputThresh, targetOffset} — все в dB/LUFS.
   */
  function analyzeLoudness(inputPath) {
    /* Камерные mp4 имеют несколько потоков (видео + аудио + timecode + metadata).
       -map 0:a:0? — выбираем первый аудио-стрим (опционально, без падения если нет);
       -vn — отключаем видео; -ac 2 — приводим к стерео для совместимости с loudnorm. */
    var args = [
      '-hide_banner', '-nostats', '-i', inputPath,
      '-map', '0:a:0?', '-vn', '-ac', '2',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null', '-'
    ];
    return runFfmpeg(args, 300000).then(function (res) {
      var stderr = res.stderr || '';
      /* ffmpeg печатает JSON-блок в stderr после строки "[Parsed_loudnorm_X ...]".
         Парсим двумя путями: сначала пробуем найти и распарсить целиком как JSON,
         потом — построчно ключ-значение по отдельности (форматы у разных версий ffmpeg различаются). */
      var parsed = null;
      var m = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (e) { parsed = null; } }
      if (!parsed) {
        parsed = {};
        var kvRe = /"(input_i|input_tp|input_lra|input_thresh|target_offset|output_i|output_tp|output_lra|output_thresh|normalization_type)"\s*:\s*"([^"]*)"/g;
        var lm;
        while ((lm = kvRe.exec(stderr)) !== null) parsed[lm[1]] = lm[2];
      }
      if (!parsed || parsed.input_i == null || parsed.input_i === '') {
        /* Диагностика: собираем строки с loudnorm/Error/Invalid; если их нет — последние 800 символов */
        var lines = stderr.split('\n');
        var hint = [];
        for (var li = 0; li < lines.length; li++) {
          var ln = lines[li];
          if (/loudnorm|Parsed_loudnorm|"input_|Error|Invalid|No such|Unrecognized|Unable|fail/i.test(ln)) hint.push(ln.trim());
        }
        var rawSnippet = hint.length ? hint.slice(-15).join(' | ') : stderr.slice(-800).replace(/\s+/g, ' ');
        return {
          error: 'loudnorm не отработал (exit=' + res.exitCode + ', stderr=' + stderr.length + 'b): ' + rawSnippet
        };
      }
      return {
        inputI: parseFloat(parsed.input_i),       /* integrated LUFS */
        inputTp: parseFloat(parsed.input_tp),     /* true peak dBTP */
        inputLra: parseFloat(parsed.input_lra),   /* loudness range */
        inputThresh: parseFloat(parsed.input_thresh),
        targetOffset: parseFloat(parsed.target_offset),
        normalizationType: parsed.normalization_type || null
      };
    });
  }

  /**
   * RMS-таймлайн через astats + ametadata=print (может быть тяжело на длинных файлах).
   * Для длинных дорожек лучше использовать grep по astats -reset.
   * windowSec — окно усреднения.
   */
  function computeRmsTimeline(inputPath, opt) {
    opt = opt || {};
    var win = typeof opt.windowSec === 'number' ? opt.windowSec : 0.5;
    var args = [
      '-hide_banner', '-nostats', '-i', inputPath,
      '-af', 'astats=metadata=1:reset=' + win + ',ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f', 'null', '-'
    ];
    return runFfmpeg(args, 300000).then(function (res) {
      var out = [];
      /* Строки вида:
         frame:###   pts:###   pts_time:12.345000
         lavfi.astats.Overall.RMS_level=-23.456000
         Стандартный вывод printMetadata идёт в stdout потому что file=- */
      var combined = (res.stdout || '') + '\n' + (res.stderr || '');
      var lines = combined.split('\n');
      var curT = null;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var mt = line.match(/pts_time:\s*([\d.]+)/);
        if (mt) { curT = parseFloat(mt[1]); continue; }
        var mr = line.match(/Overall\.RMS_level\s*=\s*(-?[\d.]+)/);
        if (mr && curT !== null) {
          out.push({ t: Math.round(curT * 1000) / 1000, rms: parseFloat(mr[1]) });
          curT = null;
        }
      }
      return out;
    });
  }

  /**
   * Все три анализа одним махом. Возвращает объект с тремя полями.
   * Если какой-то шаг упал — в поле кладётся {error}.
   */
  function analyzeAll(inputPath, opt) {
    opt = opt || {};
    return Promise.all([
      detectSilences(inputPath, opt.silence || {}).then(function (v) { return { ok: true, v: v }; },
                                                         function (e) { return { ok: false, e: String(e.message || e) }; }),
      analyzeLoudness(inputPath).then(function (v) { return { ok: true, v: v }; },
                                      function (e) { return { ok: false, e: String(e.message || e) }; }),
      opt.rms ? computeRmsTimeline(inputPath, opt.rms).then(function (v) { return { ok: true, v: v }; },
                                                            function (e) { return { ok: false, e: String(e.message || e) }; })
              : Promise.resolve({ ok: true, v: null })
    ]).then(function (r) {
      return {
        silences: r[0].ok ? r[0].v : { error: r[0].e },
        loudness: r[1].ok ? r[1].v : { error: r[1].e },
        rms: r[2].ok ? r[2].v : { error: r[2].e }
      };
    });
  }

  global.AudioPreprocess = {
    hasNode: hasNode,
    findFfmpegPath: findFfmpegPath,
    detectSilences: detectSilences,
    analyzeLoudness: analyzeLoudness,
    computeRmsTimeline: computeRmsTimeline,
    analyzeAll: analyzeAll
  };
})(typeof window !== 'undefined' ? window : this);
