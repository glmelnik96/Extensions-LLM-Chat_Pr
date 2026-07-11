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
          /* M3 (аудит 04.07.2026): kill по таймауту давал err.code === null и
             непустой stderr → старое условие resolve'ило ЧАСТИЧНЫЙ результат как
             успех (анализ «успешен», но найдена только часть тишин). Таймаут —
             всегда ошибка. */
          if (err && (err.killed || err.signal)) {
            return reject(new Error('ffmpeg прерван по таймауту (' + (err.signal || 'kill') + ', лимит ' +
              Math.round((timeoutMs || 180000) / 1000) + 'с) — результат неполный. Файл слишком длинный или диск занят.'));
          }
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
   * Реальная длительность медиафайла в секундах (парс «Duration: HH:MM:SS.xx»
   * из stderr ffmpeg). Замена байт-эвристикам вида size/32000: у WAV из
   * Premiere-пресета (48kHz stereo) реальный битрейт ~192000 B/s — эвристика
   * завышала длительность в 6 раз, чанки уходили за EOF (M2, аудит 04.07.2026).
   * Возвращает Promise<number|null> — null, если ffmpeg не сообщил Duration.
   */
  function probeDurationSec(inputPath) {
    /* Без выходного файла ffmpeg завершается с ошибкой, но Duration уже в stderr —
       runFfmpeg резолвит, т.к. stderr непустой. */
    return runFfmpeg(['-hide_banner', '-i', inputPath], 30000).then(function (res) {
      var m = String(res.stderr || '').match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (!m) return null;
      var sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
      return isFinite(sec) && sec > 0 ? Math.round(sec * 1000) / 1000 : null;
    }).catch(function () { return null; });
  }

  /**
   * Размеры кадра первого видеопотока (парс «Stream #… Video: … WxH» из
   * stderr ffmpeg). Для карточки «📱 Вертикаль 9:16»: cover-скейл считается
   * от родных размеров исходника. Promise<{width, height}|null>.
   */
  function probeVideoDimensions(inputPath) {
    return runFfmpeg(['-hide_banner', '-i', inputPath], 30000).then(function (res) {
      var lines = String(res.stderr || '').split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (!/Stream #\d+:\d+.*: Video:/.test(lines[i])) continue;
        var m = lines[i].match(/\b(\d{2,5})x(\d{2,5})\b/);
        if (m) {
          var w = parseInt(m[1], 10);
          var h = parseInt(m[2], 10);
          if (w > 0 && h > 0) return { width: w, height: h };
        }
      }
      return null;
    }).catch(function () { return null; });
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
      /* Half-open silence: silence_start без silence_end → тишина до конца файла.
         Определяем длительность файла из stderr (Duration: HH:MM:SS.xx) и замыкаем. */
      if (starts.length > ends.length) {
        var lastStart = starts[starts.length - 1];
        var durM = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        if (durM) {
          var fileDur = parseInt(durM[1], 10) * 3600 + parseInt(durM[2], 10) * 60 + parseFloat(durM[3]);
          var halfDur = Math.round((fileDur - lastStart) * 1000) / 1000;
          if (halfDur > 0) {
            out.push({
              startSec: Math.round(lastStart * 1000) / 1000,
              endSec: Math.round(fileDur * 1000) / 1000,
              durationSec: halfDur
            });
          }
        }
      }
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
    var win = typeof opt.windowSec === 'number' && opt.windowSec > 0 ? opt.windowSec : 0.5;
    /* ОКНО задаём ЧЕРЕЗ asetnsamples, а НЕ через astats reset.
       БАГ (до 26.06.2026): фильтр был `astats=...:reset=` + win, т.е. reset=0.025.
       Параметр astats `reset` — это ЦЕЛОЕ ЧИСЛО КАДРОВ, а не секунды; ffmpeg
       округляет 0.025 → 0 = reset ОТКЛЮЧЁН. Тогда Overall.RMS_level — это
       КУМУЛЯТИВНОЕ среднее с начала файла (сходится к общему RMS и «застывает»),
       а Overall.Peak_level — кумулятивный максимум (лестница вверх, потом полка).
       Результат: waveform = почти плоская линия (интеграл сигнала, НЕ сам сигнал),
       детекция тишин лупит по сошедшейся константе → «находит тишины не там» и
       ползунки «ничего не меняют». ПРОВЕРЕНО ffmpeg'ом на реальном клипе.
       ФИКС: aresample к фикс-частоте → asetnsamples=N (N = win*rate сэмплов на
       окно) → astats reset=1 (сброс на КАЖДОМ окне) → Overall.* = метрики ИМЕННО
       этого окна. Печатаем RMS_level (детекция) и Peak_level (waveform-структура). */
    var RMS_RATE = 48000;
    var nsamp = Math.max(1, Math.round(win * RMS_RATE));
    var args = [
      '-hide_banner', '-nostats', '-i', inputPath,
      '-af', 'aresample=' + RMS_RATE + ',asetnsamples=' + nsamp + ':p=0,astats=metadata=1:reset=1,ametadata=print:file=-',
      '-f', 'null', '-'
    ];
    return runFfmpeg(args, 300000).then(function (res) {
      var out = [];
      var combined = (res.stdout || '') + '\n' + (res.stderr || '');
      var lines = combined.split('\n');
      var curT = null, curRms = null, curPeak = null;
      function flush() {
        if (curT !== null && curRms !== null) {
          out.push({ t: Math.round(curT * 1000) / 1000, rms: curRms, peak: curPeak });
        }
        curRms = null; curPeak = null;
      }
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var mt = line.match(/pts_time:\s*([\d.]+)/);
        if (mt) { flush(); curT = parseFloat(mt[1]); continue; }
        var mr = line.match(/Overall\.RMS_level\s*=\s*(-?[\d.]+|-?inf)/);
        if (mr) { curRms = (mr[1].indexOf('inf') >= 0) ? -Infinity : parseFloat(mr[1]); continue; }
        var mp = line.match(/Overall\.Peak_level\s*=\s*(-?[\d.]+|-?inf)/);
        if (mp) { curPeak = (mp[1].indexOf('inf') >= 0) ? -Infinity : parseFloat(mp[1]); continue; }
      }
      flush();
      return out;
    });
  }

  /**
   * Все три анализа одним махом. Возвращает объект с тремя полями.
   * Если какой-то шаг упал — в поле кладётся {error}.
   *
   * Двухпроходная стратегия silencedetect:
   *   1-й проход: loudness (EBU R128) → получаем inputI (средний уровень).
   *   2-й проход: silencedetect с адаптивным порогом:
   *     - Если inputI > silenceOpt.thresholdDb → используем заданный порог.
   *     - Если inputI ≤ порога → порог = inputI - 10 dB (ниже среднего уровня).
   *       Это гарантирует, что silencedetect найдёт реальные паузы даже в тихом аудио.
   *   3-й проход (retry): если silences всё ещё пустые и половина от адаптивного порога
   *     даст разумное значение — пробуем ещё раз.
   */
  function analyzeAll(inputPath, opt) {
    opt = opt || {};
    var silenceOpt = opt.silence || {};
    var requestedThreshold = typeof silenceOpt.thresholdDb === 'number' ? silenceOpt.thresholdDb : -30;

    /* Шаг 1: loudness + rms параллельно */
    return Promise.all([
      analyzeLoudness(inputPath).then(function (v) { return { ok: true, v: v }; },
                                      function (e) { return { ok: false, e: String(e.message || e) }; }),
      opt.rms ? computeRmsTimeline(inputPath, opt.rms).then(function (v) { return { ok: true, v: v }; },
                                                            function (e) { return { ok: false, e: String(e.message || e) }; })
              : Promise.resolve({ ok: true, v: null })
    ]).then(function (r) {
      var loudness = r[0].ok ? r[0].v : { error: r[0].e };
      var rms = r[1].ok ? r[1].v : { error: r[1].e };

      /* Шаг 2: адаптивный порог на основе loudness */
      var adaptiveThreshold = requestedThreshold;
      if (loudness && typeof loudness.inputI === 'number' && !isNaN(loudness.inputI)) {
        /* Если средний уровень тише (или равен) порога — silencedetect ничего не найдёт.
           Опускаем порог на 10 dB ниже среднего уровня. */
        if (loudness.inputI <= requestedThreshold + 3) {
          adaptiveThreshold = Math.floor(loudness.inputI - 10);
          /* Не опускать ниже -60 dB — там уже шум квантования */
          if (adaptiveThreshold < -60) adaptiveThreshold = -60;
        }
      }

      var silOpt = { thresholdDb: adaptiveThreshold, minDurationSec: silenceOpt.minDurationSec };

      return detectSilences(inputPath, silOpt).then(
        function (sils) {
          /* Retry: если 0 тишин и можно понизить порог ещё */
          if (sils.length === 0 && adaptiveThreshold > -55) {
            var retryThreshold = adaptiveThreshold - 10;
            if (retryThreshold < -60) retryThreshold = -60;
            return detectSilences(inputPath, { thresholdDb: retryThreshold, minDurationSec: silOpt.minDurationSec })
              .then(
                function (sils2) {
                  return {
                    silences: sils2,
                    loudness: loudness,
                    rms: rms,
                    silenceThresholdUsed: sils2.length > 0 ? retryThreshold : adaptiveThreshold
                  };
                },
                function () {
                  return { silences: sils, loudness: loudness, rms: rms, silenceThresholdUsed: adaptiveThreshold };
                }
              );
          }
          return {
            silences: sils,
            loudness: loudness,
            rms: rms,
            silenceThresholdUsed: adaptiveThreshold
          };
        },
        function (e) {
          return { silences: { error: String(e.message || e) }, loudness: loudness, rms: rms };
        }
      );
    });
  }

  /**
   * Кадр видео в момент sourceSec → data URL JPEG (Волна 3 п.1, vision).
   * Через временный файл: runFfmpeg отдаёт stdout строкой, бинарь через pipe
   * порежется. Даунскейл до maxWidth (по умолчанию 768 — достаточно для
   * vision-модели, экономит токены). BRAW ffmpeg НЕ декодирует («no decoder
   * found») — для таких проектов кадры берут из черновика/прокси (sourceFile).
   * Promise<string> 'data:image/jpeg;base64,…'; reject с понятной причиной.
   */
  function extractFrameJpeg(inputPath, sourceSec, opts) {
    var o = opts || {};
    var maxW = o.maxWidth > 0 ? Math.floor(o.maxWidth) : 768;
    var sec = Number(sourceSec);
    if (!isFinite(sec) || sec < 0) return Promise.reject(new Error('Некорректное время кадра: ' + sourceSec));
    if (!hasNode()) return Promise.reject(new Error('Node.js недоступен'));
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var tmp = path.join(os.tmpdir(), '_llm_frame_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.jpg');
    /* -ss ДО -i — быстрый seek по ключевым кадрам; для превью сцены точности хватает. */
    var args = [
      '-hide_banner', '-ss', String(sec), '-i', inputPath,
      '-frames:v', '1', '-vf', 'scale=min(' + maxW + '\\,iw):-2',
      '-q:v', '3', '-y', tmp
    ];
    return runFfmpeg(args, 60000).then(function (res) {
      var buf = null;
      try { if (fs.existsSync(tmp)) buf = fs.readFileSync(tmp); } catch (eR) {}
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (eU) {}
      if (!buf || !buf.length) {
        var stderr = String(res && res.stderr || '');
        var hint = /no decoder found|Decoding requested/i.test(stderr)
          ? 'кодек не декодируется ffmpeg (BRAW?) — укажите файл-источник кадров (черновой экспорт/прокси)'
          : 'ffmpeg не выдал кадр (время за концом файла?)';
        throw new Error(hint);
      }
      return 'data:image/jpeg;base64,' + buf.toString('base64');
    }, function (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (eU2) {}
      throw e;
    });
  }

  global.AudioPreprocess = {
    hasNode: hasNode,
    findFfmpegPath: findFfmpegPath,
    probeDurationSec: probeDurationSec,
    probeVideoDimensions: probeVideoDimensions,
    extractFrameJpeg: extractFrameJpeg,
    detectSilences: detectSilences,
    analyzeLoudness: analyzeLoudness,
    computeRmsTimeline: computeRmsTimeline,
    analyzeAll: analyzeAll
  };
})(typeof window !== 'undefined' ? window : this);
