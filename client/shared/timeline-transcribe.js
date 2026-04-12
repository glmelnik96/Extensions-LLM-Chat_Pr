/**
 * Нормализация ответа Whisper для транскрибации с таймлайна (экспорт In–Out или один медиафайл).
 */
(function (global) {
  /**
   * Запускает массив задач-функций с ограничением параллелизма.
   * tasks: [() => Promise<T>], concurrency: number
   * Возвращает Promise<T[]> в исходном порядке.
   */
  function promisePool(tasks, concurrency) {
    if (!tasks.length) return Promise.resolve([]);
    var limit = Math.min(concurrency, tasks.length);
    var results = new Array(tasks.length);
    var nextIdx = 0;
    var running = 0;

    return new Promise(function (resolve, reject) {
      var rejected = false;
      function runNext() {
        while (running < limit && nextIdx < tasks.length) {
          (function (idx) {
            running++;
            nextIdx++;
            tasks[idx]().then(
              function (val) {
                if (rejected) return;
                results[idx] = val;
                running--;
                if (nextIdx >= tasks.length && running === 0) {
                  resolve(results);
                } else {
                  runNext();
                }
              },
              function (err) {
                if (!rejected) { rejected = true; reject(err); }
              }
            );
          })(nextIdx);
        }
      }
      runNext();
    });
  }

  var CLOUD_CONCURRENCY = 20; /* Cloud.ru поддерживает до 20 параллельных запросов */

  function normalizeWhisperExport(data, timelineOffsetSec) {
    var off = typeof timelineOffsetSec === 'number' && !isNaN(timelineOffsetSec) ? timelineOffsetSec : 0;
    /* Защита от мусорных значений из ExtendScript: getInPoint() в редких случаях
       возвращает большое отрицательное число (тики, sequence zeroPoint и т.п.). */
    if (off < 0 || off > 360000) off = 0;
    var segments = [];
    if (data.segments && Array.isArray(data.segments)) {
      data.segments.forEach(function (seg) {
        var st = typeof seg.start === 'number' ? seg.start : parseFloat(seg.start) || 0;
        var en = typeof seg.end === 'number' ? seg.end : parseFloat(seg.end) || 0;
        segments.push({
          startSec: st + off,
          endSec: en + off,
          text: (seg.text || '').trim()
        });
      });
    } else if (data.text) {
      segments.push({ startSec: 0 + off, endSec: null, text: data.text.trim() });
    }
    return { raw: data, segments: segments, text: data.text || '', timelineOffsetSec: off, mode: 'export_wav' };
  }

  /**
   * Полный файл на диске: таймкод сегмента на секвенции = clipStart + (sourceTime - clipInPoint).
   * Обрезаем по [workIn, workOut].
   */
  function normalizeWhisperMediaFile(data, clipStartSec, clipInPointSec, workInSec, workOutSec) {
    var eps = 0.06;
    var segments = [];
    if (data.segments && Array.isArray(data.segments)) {
      data.segments.forEach(function (seg) {
        var srcStart = typeof seg.start === 'number' ? seg.start : parseFloat(seg.start) || 0;
        var srcEnd = typeof seg.end === 'number' ? seg.end : parseFloat(seg.end) || 0;
        var t0 = clipStartSec + (srcStart - clipInPointSec);
        var t1 = clipStartSec + (srcEnd - clipInPointSec);
        var lo = Math.max(t0, workInSec);
        var hi = Math.min(t1, workOutSec);
        if (hi - lo > eps) {
          segments.push({
            startSec: lo,
            endSec: hi,
            text: (seg.text || '').trim()
          });
        }
      });
    } else if (data.text) {
      segments.push({
        startSec: workInSec,
        endSec: workOutSec,
        text: data.text.trim()
      });
    }
    return {
      raw: data,
      segments: segments,
      text: data.text || '',
      timelineOffsetSec: workInSec,
      mode: 'media_file'
    };
  }

  /**
   * Проверка: файл — уже аудио в формате, который whisper.cpp принимает
   * без конвертации (wav/mp3/ogg/flac). Для mov/mp4/mkv вернёт false,
   * и вызывающий код должен извлечь аудио через ffmpeg перед whisper-cli.
   */
  function isAudioExt(p) {
    var low = String(p || '').toLowerCase();
    /* Форматы, которые whisper.cpp принимает напрямую (см. whisper-cli --help). */
    return /\.(wav|mp3|ogg|oga|flac)$/.test(low);
  }

  function guessMime(path) {
    var low = String(path || '').toLowerCase();
    if (low.indexOf('.wav') !== -1) return 'audio/wav';
    if (low.indexOf('.mp3') !== -1) return 'audio/mpeg';
    if (low.indexOf('.m4a') !== -1) return 'audio/mp4';
    if (low.indexOf('.mp4') !== -1) return 'video/mp4';
    if (low.indexOf('.mov') !== -1) return 'video/quicktime';
    return 'application/octet-stream';
  }

  /**
   * Чтение файла с диска в Blob (требуется Node в CEP).
   */
  function readPathAsBlob(absPath) {
    if (typeof require === 'undefined') {
      throw new Error('Для чтения файла с диска нужен Node в панели (в манифесте --enable-nodejs).');
    }
    var fs = require('fs');
    if (!fs.existsSync(absPath)) {
      throw new Error('Файл не найден: ' + absPath);
    }
    var buf = fs.readFileSync(absPath);
    var arr = new Uint8Array(buf);
    return new Blob([arr], { type: guessMime(absPath) });
  }

  function fileSizeSync(absPath) {
    try {
      if (typeof require === 'undefined') return 0;
      return require('fs').statSync(absPath).size;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Найти путь к ffmpeg — CEP Node.js не наследует пользовательский PATH.
   */
  function findFfmpegPath() {
    if (typeof require === 'undefined') return null;
    var fs = require('fs');
    var candidates = [
      '/opt/homebrew/bin/ffmpeg',       // macOS ARM (brew)
      '/usr/local/bin/ffmpeg',          // macOS Intel (brew) / Linux
      '/usr/bin/ffmpeg',                // Linux system
      'C:\\ffmpeg\\bin\\ffmpeg.exe',    // Windows common
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
    ];
    for (var i = 0; i < candidates.length; i++) {
      try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
    }
    /* Последняя попытка — через which/where */
    try {
      var execSync = require('child_process').execSync;
      var p = process.platform === 'win32'
        ? String(execSync('where ffmpeg', { timeout: 5000 })).trim().split('\n')[0]
        : String(execSync('which ffmpeg', { timeout: 5000, env: Object.assign({}, process.env, { PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin' }) })).trim();
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
    return null;
  }

  /**
   * Извлечь аудио из медиафайла через ffmpeg (Node.js child_process).
   * Возвращает Promise<string> — путь к временному WAV.
   */
  function extractAudioWithFfmpeg(inputPath, outputPath) {
    if (typeof require === 'undefined') {
      return Promise.reject(new Error('Node.js недоступен для ffmpeg'));
    }
    var ffmpegBin = findFfmpegPath();
    if (!ffmpegBin) {
      return Promise.reject(new Error(
        'ffmpeg не найден. Установите: brew install ffmpeg (macOS) или apt install ffmpeg (Linux). Путь проверен: /opt/homebrew/bin, /usr/local/bin, /usr/bin.'
      ));
    }
    var execFile = require('child_process').execFile;
    return new Promise(function (resolve, reject) {
      execFile(ffmpegBin, [
        '-i', inputPath,
        '-vn',              // no video
        '-acodec', 'pcm_s16le',
        '-ar', '16000',     // 16kHz
        '-ac', '1',         // mono
        '-y',               // overwrite
        outputPath
      ], { timeout: 300000 }, function (err, stdout, stderr) {
        if (err) {
          reject(new Error('ffmpeg error: ' + String(err.message || err)));
        } else {
          resolve(outputPath);
        }
      });
    });
  }

  /** Генерирует временный путь для извлечённого аудио */
  function tempAudioPath(inputPath) {
    if (typeof require === 'undefined') return '/tmp/_llm_extracted.wav';
    var os = require('os');
    var path = require('path');
    var base = path.basename(inputPath, path.extname(inputPath));
    return path.join(os.tmpdir(), '_llm_audio_' + base + '_' + Date.now() + '.wav');
  }

  /**
   * Нарезать [srcStartSec .. srcStartSec+totalSpanSec] исходника на короткие WAV-чанки
   * через ffmpeg (16 kHz mono PCM, ~1.92 МБ за 60 с) — минует 413 без .epr-пресета.
   *
   * Возвращает [{path, durationSec, offsetInSpanSec}], где offsetInSpanSec — смещение
   * от начала запрошенного диапазона (для перевода в координаты таймлайна).
   */
  function extractAudioChunksWithFfmpeg(inputPath, srcStartSec, totalSpanSec, chunkSec, progress) {
    if (typeof require === 'undefined') {
      return Promise.reject(new Error('Node.js недоступен для ffmpeg'));
    }
    var ffmpegBin = findFfmpegPath();
    if (!ffmpegBin) {
      return Promise.reject(new Error(
        'ffmpeg не найден. Установите: brew install ffmpeg (macOS) или apt install ffmpeg (Linux). ' +
        'Альтернатива — создайте .epr пресет (см. host/presets/README.txt) и пропишите exportAudioPresetPath в fm-defaults.js.'
      ));
    }
    var execFile = require('child_process').execFile;
    var os = require('os');
    var path = require('path');
    var fs = require('fs');
    var base = path.basename(inputPath, path.extname(inputPath));
    var stamp = Date.now();
    var step = Math.max(15, chunkSec || 90);
    var totalChunks = Math.max(1, Math.ceil(totalSpanSec / step));

    var chunks = [];
    var idx = 0;
    function nextChunk() {
      if (idx >= totalChunks) return Promise.resolve(chunks);
      var offset = idx * step;
      var dur = Math.min(step, totalSpanSec - offset);
      if (dur <= 0.05) return Promise.resolve(chunks);
      var outPath = path.join(os.tmpdir(), '_llm_chunk_' + base + '_' + stamp + '_' + idx + '.wav');
      if (progress) progress('Извлечение аудио (ffmpeg) ' + (idx + 1) + '/' + totalChunks + '…');
      var args = [
        '-ss', String(srcStartSec + offset),
        '-t', String(dur),
        '-i', inputPath,
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        '-y',
        outPath
      ];
      return new Promise(function (resolve, reject) {
        execFile(ffmpegBin, args, { timeout: 300000 }, function (err) {
          if (err) {
            reject(new Error('ffmpeg error (chunk ' + idx + '): ' + String(err.message || err)));
            return;
          }
          if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
            reject(new Error('ffmpeg создал пустой чанк ' + idx + ' (' + outPath + ')'));
            return;
          }
          chunks.push({ path: outPath, durationSec: dur, offsetInSpanSec: offset });
          idx++;
          resolve(nextChunk());
        });
      });
    }
    return nextChunk();
  }

  function unlinkChunkList(list) {
    if (typeof require === 'undefined' || !list) return;
    var fs = require('fs');
    list.forEach(function (c) {
      try { if (c && c.path && fs.existsSync(c.path)) fs.unlinkSync(c.path); } catch (eU) {}
    });
  }

  function mergeSegmentLists(lists) {
    var all = [];
    lists.forEach(function (list) {
      (list || []).forEach(function (s) {
        all.push(s);
      });
    });
    all.sort(function (a, b) {
      return a.startSec - b.startSec;
    });
    return all;
  }

  function throwIfAborted(signal, abortCheck) {
    if (signal && signal.aborted) {
      var err = new Error('Остановлено пользователем');
      err.name = 'AbortError';
      throw err;
    }
    if (typeof abortCheck === 'function' && abortCheck()) {
      var err2 = new Error('Остановлено пользователем');
      err2.name = 'AbortError';
      throw err2;
    }
  }

  /**
   * Постпроцесс аудио через AudioPreprocess (ffmpeg): silencedetect + loudnorm.
   * Вызывается после основной транскрибации. Не должен падать всю транскрибацию — ошибки глотаем.
   * pathForAnalysis — один реальный WAV-файл, который уже есть на диске (prep.path или первый чанк).
   * timelineOffsetSec — смещение, чтобы перевести "секунды файла" в "секунды таймлайна".
   */
  async function computeAudioPreprocess(pathForAnalysis, timelineOffsetSec, progress) {
    if (!pathForAnalysis || typeof global.AudioPreprocess === 'undefined') {
      return null;
    }
    var off = typeof timelineOffsetSec === 'number' && !isNaN(timelineOffsetSec) ? timelineOffsetSec : 0;
    try {
      if (progress) progress('Анализ аудио (silencedetect + loudnorm)…');
      var res = await global.AudioPreprocess.analyzeAll(pathForAnalysis, {
        silence: { thresholdDb: -30, minDurationSec: 0.5 }
        /* rms опущен — дорого на длинных файлах; подключим по прямому запросу пользователя */
      });
      /* Сдвигаем тишины в таймлайн-координаты */
      var silences = [];
      if (Array.isArray(res.silences)) {
        silences = res.silences.map(function (s) {
          return {
            startSec: Math.round((s.startSec + off) * 1000) / 1000,
            endSec: Math.round((s.endSec + off) * 1000) / 1000,
            durationSec: s.durationSec
          };
        });
      }
      return {
        silences: silences,
        loudness: res.loudness && !res.loudness.error ? res.loudness : null,
        silencesError: Array.isArray(res.silences) ? null : (res.silences && res.silences.error) || null,
        loudnessError: res.loudness && res.loudness.error ? res.loudness.error : null,
        silenceThresholdUsed: typeof res.silenceThresholdUsed === 'number' ? res.silenceThresholdUsed : null
      };
    } catch (eP) {
      return { error: String(eP && eP.message || eP) };
    }
  }

  /**
   * Универсальный вызов одного аудио-файла через выбранный бэкенд.
   * Возвращает объект в формате Whisper verbose_json: { segments:[{start,end,text}], text }.
   *
   * settings.transcribeBackend:
   *   'whisper.cpp' — локальный whisper.cpp (WhisperCppClient). Не имеет лимита
   *                   на размер; для .mov/.mp4 всё равно нужен промежуточный WAV
   *                   (вызывающий код делает это через ffmpeg).
   *   'cloud'       — облачный CloudRuClient.transcribeAudio. Лимит ~20 МБ.
   */
  async function backendTranscribe(settings, opts) {
    var backend = (settings && settings.transcribeBackend) || 'cloud';
    var onProgress = opts && opts.onProgress;
    if (backend === 'whisper.cpp') {
      if (typeof global.WhisperCppClient === 'undefined') {
        throw new Error('WhisperCppClient не загружен (проверь script в index.html).');
      }
      return global.WhisperCppClient.transcribeFile({
        filePath: opts.path,
        binPath: settings.whisperCppBin || '',
        modelPath: settings.whisperCppModel || '',
        language: settings.whisperCppLanguage || 'ru',
        threads: settings.whisperCppThreads || 0,
        extraArgs: Array.isArray(settings.whisperCppExtraArgs) ? settings.whisperCppExtraArgs : [],
        signal: opts.signal,
        onProgress: onProgress
      });
    }
    /* Облачный путь — multipart через CloudRuClient */
    var CC = opts.CloudRuClient;
    if (!CC) throw new Error('CloudRuClient не передан в backendTranscribe');
    var maxUpload = (settings && typeof settings.maxTranscribeUploadBytes === 'number')
      ? settings.maxTranscribeUploadBytes : 20 * 1024 * 1024;
    var filePath = opts.path;
    var tmpExtracted = null;
    /* Для облачного API: если файл — видео (не аудио), сначала извлечь аудио через ffmpeg.
       Это радикально уменьшает размер (500 МБ .mov → 5 МБ wav) и предотвращает 413. */
    if (!isAudioExt(filePath)) {
      var ffTmp = tempAudioPath(filePath);
      await extractAudioWithFfmpeg(filePath, ffTmp);
      tmpExtracted = ffTmp;
      filePath = ffTmp;
    }
    /* Проверяем размер перед отправкой */
    var sz = fileSizeSync(filePath);
    if (sz > maxUpload) {
      if (tmpExtracted) {
        try { require('fs').unlinkSync(tmpExtracted); } catch (e) {}
      }
      throw new Error(
        'Файл ' + Math.round(sz / 1024 / 1024) + ' МБ превышает лимит API (' +
        Math.round(maxUpload / 1024 / 1024) + ' МБ). Файл будет автоматически нарезан на чанки.'
      );
    }
    try {
      var blob = readPathAsBlob(filePath);
      return await CC.transcribeAudio(Object.assign({}, opts.transcribeOptsBase, {
        fileBlob: blob,
        fileName: opts.fileName || String(filePath).replace(/^.*[\\/]/, '')
      }));
    } finally {
      if (tmpExtracted) {
        try { require('fs').unlinkSync(tmpExtracted); } catch (e) {}
      }
    }
  }

  /**
   * prep — ответ prepareTranscribeFromTimeline (ok, mode, …).
   * opt: { settings, signal, abortCheck, onProgress(str), CloudRuClient }
   */
  async function runFromPrep(prep, opt) {
    if (!prep || !prep.ok) {
      throw new Error((prep && prep.error) || 'prepareTranscribe failed');
    }
    var settings = opt.settings || {};
    var signal = opt.signal;
    var abortCheck = opt.abortCheck;
    var progress = typeof opt.onProgress === 'function' ? opt.onProgress : function () {};
    var CC = opt.CloudRuClient || global.CloudRuClient;
    var backend = settings.transcribeBackend || 'cloud';
    var isLocal = backend === 'whisper.cpp';
    /* Для локального бэкенда размер файла не ограничен — ставим заведомо большой лимит. */
    var maxBytes = isLocal
      ? Number.POSITIVE_INFINITY
      : (typeof settings.maxTranscribeUploadBytes === 'number' && !isNaN(settings.maxTranscribeUploadBytes)
          ? settings.maxTranscribeUploadBytes
          : 24 * 1024 * 1024);
    if (progress) progress('Бэкенд транскрибации: ' + backend + (isLocal ? ' (локально, оффлайн)' : ' (Cloud.ru)'));

    function beforeAwait() {
      throwIfAborted(signal, abortCheck);
    }

    var transcribeOptsBase = {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.whisperModel,
      transcribeParams: settings.transcribeParams || {},
      signal: signal,
      abortCheck: abortCheck
    };

    if (prep.mode === 'export_chunks' && prep.chunks && prep.chunks.length) {
      var combined = [];
      var textAcc = '';
      var ci, ch, sz;
      /* Проверяем размеры ДО запуска */
      for (ci = 0; ci < prep.chunks.length; ci++) {
        sz = fileSizeSync(prep.chunks[ci].path);
        if (sz > maxBytes) {
          throw new Error(
            'Файл слишком большой для API (~' + Math.round(sz / 1024 / 1024) + ' МБ). Уменьшите transcribeExportChunkSec в fm-defaults.js.'
          );
        }
      }
      beforeAwait();
      /* Параллельная транскрибация всех чанков */
      var doneCount = 0;
      var totalChunks = prep.chunks.length;
      progress('Транскрибация: отправляю ' + totalChunks + ' фрагментов параллельно…');
      var chunkTasks = prep.chunks.map(function (ch, idx) {
        return function () {
          var ext = String(ch.path || '').replace(/^.*\./, '') || 'wav';
          return backendTranscribe(settings, {
            path: ch.path,
            fileName: 'chunk_' + idx + '.' + ext,
            signal: signal,
            onProgress: function () {},
            CloudRuClient: CC,
            transcribeOptsBase: transcribeOptsBase
          }).then(function (data) {
            doneCount++;
            progress('Транскрибация: ' + doneCount + '/' + totalChunks + ' готово…');
            return { index: idx, data: data, offset: ch.timelineOffsetSec };
          });
        };
      });
      var chunkResults = await promisePool(chunkTasks, CLOUD_CONCURRENCY);
      /* Сборка в правильном порядке */
      chunkResults.sort(function (a, b) { return a.index - b.index; });
      for (ci = 0; ci < chunkResults.length; ci++) {
        var norm = normalizeWhisperExport(chunkResults[ci].data, chunkResults[ci].offset);
        combined = combined.concat(norm.segments);
        textAcc += (norm.text || '') + ' ';
      }
      /* 1.1 аудиопрепроцессинг: анализируем ВСЕ чанки и объединяем silences.
         Раньше анализировался только первый чанк — тишины в остальных терялись. */
      var audioAnalysisChunks = null;
      try {
        var allSilCh = [];
        var firstLoudCh = null;
        var firstThreshCh = null;
        for (var ach = 0; ach < prep.chunks.length; ach++) {
          var ch = prep.chunks[ach];
          if (!ch || !ch.path) continue;
          try {
            var aaCh = await computeAudioPreprocess(ch.path, ch.timelineOffsetSec, progress);
            if (aaCh && Array.isArray(aaCh.silences)) {
              allSilCh = allSilCh.concat(aaCh.silences);
            }
            if (!firstLoudCh && aaCh && aaCh.loudness) {
              firstLoudCh = aaCh.loudness;
            }
            if (firstThreshCh == null && aaCh && aaCh.silenceThresholdUsed != null) {
              firstThreshCh = aaCh.silenceThresholdUsed;
            }
          } catch (eChA) {}
        }
        allSilCh.sort(function (a, b) { return a.startSec - b.startSec; });
        audioAnalysisChunks = {
          silences: allSilCh,
          loudness: firstLoudCh,
          silencesError: null,
          loudnessError: null,
          silenceThresholdUsed: firstThreshCh
        };
      } catch (eAC) {}
      return {
        raw: { chunks: prep.chunks.length },
        segments: mergeSegmentLists([combined]),
        text: textAcc.trim(),
        timelineOffsetSec: prep.chunks[0].timelineOffsetSec,
        mode: 'export_chunks',
        audioAnalysis: audioAnalysisChunks
      };
    }

    if (prep.mode === 'export_wav') {
      beforeAwait();
      var szW = fileSizeSync(prep.path);
      if (szW > maxBytes) {
        /* Файл слишком велик для API — авто-чанкование через ffmpeg */
        progress('Файл ' + Math.round(szW / 1024 / 1024) + ' МБ > лимита — нарезаю через ffmpeg…');
        var chunkSecW = (typeof settings.transcribeExportChunkSec === 'number' && settings.transcribeExportChunkSec >= 15)
          ? settings.transcribeExportChunkSec : 90;
        /* Определяем длительность файла. timelineOffsetSec = In, workOutSec может быть в prep */
        var spanSecW = 0;
        try {
          var probeRes = await AudioPreprocess.analyzeLoudness(prep.path);
          /* Длительность = из stderr Duration, но loudness не даёт напрямую.
             Рассчитаем из размера файла (PCM 16kHz mono = 32000 bytes/sec). */
        } catch (eP) {}
        /* Надёжный расчёт: для PCM 16kHz mono WAV ~32000 B/s; для MP3 ~16000 B/s */
        var estBytesPerSec = String(prep.path || '').match(/\.wav$/i) ? 32000 : 16000;
        spanSecW = Math.max(30, Math.ceil(szW / estBytesPerSec));
        var ewChunks = await extractAudioChunksWithFfmpeg(prep.path, 0, spanSecW, chunkSecW, progress);
        var combinedW = [];
        var textAccW = '';
        var wOff = typeof prep.timelineOffsetSec === 'number' ? prep.timelineOffsetSec : 0;
        try {
          /* Параллельная транскрибация чанков */
          var wDone = 0;
          progress('Транскрибация: отправляю ' + ewChunks.length + ' фрагментов параллельно…');
          var wTasks = ewChunks.map(function (wch, wci) {
            return function () {
              return backendTranscribe(settings, {
                path: wch.path,
                fileName: 'export_chunk_' + wci + '.wav',
                signal: signal,
                onProgress: function () {},
                CloudRuClient: CC,
                transcribeOptsBase: transcribeOptsBase
              }).then(function (wData) {
                wDone++;
                progress('Транскрибация: ' + wDone + '/' + ewChunks.length + ' готово…');
                return { index: wci, data: wData, offset: wOff + wch.offsetInSpanSec };
              });
            };
          });
          var wResults = await promisePool(wTasks, CLOUD_CONCURRENCY);
          wResults.sort(function (a, b) { return a.index - b.index; });
          for (var wri = 0; wri < wResults.length; wri++) {
            var wNorm = normalizeWhisperExport(wResults[wri].data, wResults[wri].offset);
            combinedW = combinedW.concat(wNorm.segments);
            textAccW += (wNorm.text || '') + ' ';
          }
          /* Аудиоанализ на оригинальном файле */
          var audioAnalysisW = null;
          try {
            audioAnalysisW = await computeAudioPreprocess(prep.path, wOff, progress);
          } catch (eAWC) {}
          return {
            raw: { ffmpegChunks: ewChunks.length },
            segments: mergeSegmentLists([combinedW]),
            text: textAccW.trim(),
            timelineOffsetSec: wOff,
            mode: 'export_wav_chunked',
            audioAnalysis: audioAnalysisW
          };
        } finally {
          unlinkChunkList(ewChunks);
        }
      }
      progress('Транскрибация: отправка в Whisper…');
      beforeAwait();
      var dataW = await backendTranscribe(settings, {
        path: prep.path,
        fileName: 'timeline_inout.wav',
        signal: signal,
        onProgress: progress,
        CloudRuClient: CC,
        transcribeOptsBase: transcribeOptsBase
      });
      var normW = normalizeWhisperExport(dataW, prep.timelineOffsetSec);
      try {
        normW.audioAnalysis = await computeAudioPreprocess(prep.path, prep.timelineOffsetSec, progress);
      } catch (eAW) {}
      return normW;
    }

    if (prep.mode === 'clip_queue' && prep.items && prep.items.length) {
      var chunkSecCfgQ = (typeof settings.transcribeExportChunkSec === 'number' && settings.transcribeExportChunkSec >= 15)
        ? settings.transcribeExportChunkSec : 90;
      var whisperByPath = {};
      var segLists = [];
      var allText = '';
      /* Собираем ВСЕ WAV-чанки со всех клипов для аудиоанализа ПОСЛЕ транскрибации */
      var allChunksForAnalysis = []; /* {path, timelineOffsetSec} */
      var qi, it, pathQ, szQ, blobQ, rawW, nq;
      for (qi = 0; qi < prep.items.length; qi++) {
        beforeAwait();
        it = prep.items[qi];
        pathQ = it.path;
        progress('Транскрибация: клип ' + (qi + 1) + '/' + prep.items.length + '…');
        szQ = fileSizeSync(pathQ);
        var spanQ = it.workOutSec - it.workInSec;
        var srcStartQ = (it.clipInPointSec || 0) + (it.workInSec - (it.clipStartSec || 0));
        /* Для cloud: видео → ffmpeg-чанкинг (предотвращает 413 и OOM).
           Для whisper.cpp: видео → ffmpeg-чанкинг (не принимает контейнеры). */
        var needChunkQ = spanQ > chunkSecCfgQ * 1.5 || szQ > maxBytes || !isAudioExt(pathQ);
        if (needChunkQ) {
          /* Нарезаем нужный диапазон через ffmpeg на короткие WAV-чанки */
          beforeAwait();
          var qChunks = await extractAudioChunksWithFfmpeg(pathQ, srcStartQ, spanQ, chunkSecCfgQ, progress);
          /* Сохраняем чанки для аудиоанализа (НЕ удаляем пока!) */
          for (var qci2 = 0; qci2 < qChunks.length; qci2++) {
            allChunksForAnalysis.push({
              path: qChunks[qci2].path,
              timelineOffsetSec: it.workInSec + qChunks[qci2].offsetInSpanSec
            });
          }
          /* Параллельная транскрибация чанков клипа */
          var qDoneCount = 0;
          progress('Транскрибация: клип ' + (qi + 1) + '/' + prep.items.length + ', ' + qChunks.length + ' фрагментов…');
          var qTasks = qChunks.map(function (qch, qci) {
            return function () {
              return backendTranscribe(settings, {
                path: qch.path,
                fileName: 'clip_' + qi + '_chunk_' + qci + '.wav',
                signal: signal,
                onProgress: function () {},
                CloudRuClient: CC,
                transcribeOptsBase: transcribeOptsBase
              }).then(function (qData) {
                qDoneCount++;
                progress('Транскрибация: клип ' + (qi + 1) + '/' + prep.items.length + ', ' + qDoneCount + '/' + qChunks.length + ' готово…');
                return { index: qci, data: qData, offset: it.workInSec + qch.offsetInSpanSec };
              });
            };
          });
          var qResults = await promisePool(qTasks, CLOUD_CONCURRENCY);
          qResults.sort(function (a, b) { return a.index - b.index; });
          var qLocal = [];
          for (var qri = 0; qri < qResults.length; qri++) {
            var qNorm = normalizeWhisperExport(qResults[qri].data, qResults[qri].offset);
            qLocal = qLocal.concat(qNorm.segments);
            allText += (qNorm.text || '') + ' ';
          }
          segLists.push(qLocal);
          continue;
        }
        /* Маленький аудиофайл — отправить напрямую */
        if (!whisperByPath[pathQ]) {
          beforeAwait();
          whisperByPath[pathQ] = await backendTranscribe(settings, {
            path: pathQ,
            fileName: String(pathQ).replace(/^.*[\\/]/, '') || 'media',
            signal: signal,
            onProgress: progress,
            CloudRuClient: CC,
            transcribeOptsBase: transcribeOptsBase
          });
        }
        rawW = whisperByPath[pathQ];
        nq = normalizeWhisperMediaFile(rawW, it.clipStartSec, it.clipInPointSec, it.workInSec, it.workOutSec);
        segLists.push(nq.segments);
        allText += (nq.text || '') + ' ';
        /* Для аудиоанализа: извлечь WAV из этого аудиофайла (только нужный диапазон) */
        try {
          var directChunkPath = tempAudioPath(pathQ);
          await extractAudioWithFfmpeg(pathQ, directChunkPath);
          allChunksForAnalysis.push({
            path: directChunkPath,
            timelineOffsetSec: it.clipStartSec || 0
          });
        } catch (eDirectExtract) {}
      }

      /* ── Аудиоанализ: запускаем на извлечённых WAV-чанках (не на исходных .braw/.mp3) ──
       * Это даёт корректные тишины: анализируется реальное аудио,
       * а offset уже в координатах таймлайна. */
      var audioAnalysisCQ = null;
      try {
        var allSilences = [];
        var firstLoudness = null;
        var firstThreshCQ = null;
        progress('Анализ аудио (silencedetect на ' + allChunksForAnalysis.length + ' чанков)…');
        for (var aq = 0; aq < allChunksForAnalysis.length; aq++) {
          var chunkForAA = allChunksForAnalysis[aq];
          if (!chunkForAA || !chunkForAA.path) continue;
          try {
            var aaQ = await computeAudioPreprocess(
              chunkForAA.path,
              chunkForAA.timelineOffsetSec,
              progress
            );
            if (aaQ && Array.isArray(aaQ.silences)) {
              allSilences = allSilences.concat(aaQ.silences);
            }
            if (!firstLoudness && aaQ && aaQ.loudness) {
              firstLoudness = aaQ.loudness;
            }
            if (firstThreshCQ == null && aaQ && aaQ.silenceThresholdUsed != null) {
              firstThreshCQ = aaQ.silenceThresholdUsed;
            }
          } catch (eChunkAA) {}
        }
        allSilences.sort(function (a, b) { return a.startSec - b.startSec; });
        audioAnalysisCQ = {
          silences: allSilences,
          loudness: firstLoudness,
          silencesError: null,
          loudnessError: null,
          silenceThresholdUsed: firstThreshCQ
        };
      } catch (eACQ) {}

      /* Удаляем ВСЕ временные файлы (чанки) ПОСЛЕ аудиоанализа */
      for (var cf = 0; cf < allChunksForAnalysis.length; cf++) {
        try { if (typeof require !== 'undefined') require('fs').unlinkSync(allChunksForAnalysis[cf].path); } catch (eU) {}
      }

      /* Дедупликация сегментов: убрать перекрытия (например, музыка + речь дают
         сегменты на одних и тех же таймкодах). Приоритет — более длинный текст. */
      var mergedSegs = mergeSegmentLists(segLists);
      var dedupedSegs = [];
      for (var di = 0; di < mergedSegs.length; di++) {
        var seg = mergedSegs[di];
        var dominated = false;
        for (var dj = 0; dj < mergedSegs.length; dj++) {
          if (di === dj) continue;
          var other = mergedSegs[dj];
          /* seg полностью внутри other И текст other длиннее → seg дубликат */
          if (other.startSec <= seg.startSec + 0.1 && other.endSec >= seg.endSec - 0.1 &&
              (other.text || '').length > (seg.text || '').length) {
            dominated = true;
            break;
          }
        }
        if (!dominated) dedupedSegs.push(seg);
      }

      return {
        raw: whisperByPath,
        segments: dedupedSegs,
        text: allText.trim(),
        timelineOffsetSec: prep.workInSec,
        mode: 'clip_queue',
        audioAnalysis: audioAnalysisCQ
      };
    }

    if (prep.mode === 'media_file') {
      var chunkSecCfgM = (typeof settings.transcribeExportChunkSec === 'number' && settings.transcribeExportChunkSec >= 15)
        ? settings.transcribeExportChunkSec : 90;
      var spanSecM = prep.workOutSec - prep.workInSec;
      var srcStartM = (prep.clipInPointSec || 0) + (prep.workInSec - (prep.clipStartSec || 0));
      var szPre = fileSizeSync(prep.path);
      /* Видеоконтейнеры (.mov/.mp4) всегда через ffmpeg — предотвращает 413 и OOM. */
      var needChunkM = spanSecM > chunkSecCfgM * 1.5 || szPre > maxBytes || !isAudioExt(prep.path);
      if (needChunkM) {
        beforeAwait();
        progress('Извлечение аудио чанками через ffmpeg (минует 413)…');
        var mChunks = await extractAudioChunksWithFfmpeg(prep.path, srcStartM, spanSecM, chunkSecCfgM, progress);
        var combinedM = [];
        var textAccM = '';
        try {
          /* Параллельная транскрибация чанков */
          var mDoneCount = 0;
          var mTotalChunks = mChunks.length;
          progress('Транскрибация: отправляю ' + mTotalChunks + ' фрагментов параллельно…');
          var mTasks = mChunks.map(function (mch, mci) {
            return function () {
              return backendTranscribe(settings, {
                path: mch.path,
                fileName: 'mediafile_chunk_' + mci + '.wav',
                signal: signal,
                onProgress: function () {},
                CloudRuClient: CC,
                transcribeOptsBase: transcribeOptsBase
              }).then(function (mData) {
                mDoneCount++;
                progress('Транскрибация: ' + mDoneCount + '/' + mTotalChunks + ' готово…');
                return { index: mci, data: mData, offset: prep.workInSec + mch.offsetInSpanSec };
              });
            };
          });
          var mResults = await promisePool(mTasks, CLOUD_CONCURRENCY);
          mResults.sort(function (a, b) { return a.index - b.index; });
          for (var mri = 0; mri < mResults.length; mri++) {
            var mNorm = normalizeWhisperExport(mResults[mri].data, mResults[mri].offset);
            combinedM = combinedM.concat(mNorm.segments);
            textAccM += (mNorm.text || '') + ' ';
          }
          /* Анализ всех ffmpeg-чанков — silences + loudness */
          var audioAnalysisM = null;
          try {
            var allSilM = [];
            var firstLoudM = null;
            var firstThreshM = null;
            for (var amci = 0; amci < mChunks.length; amci++) {
              var mck = mChunks[amci];
              if (!mck || !mck.path) continue;
              try {
                var aaMck = await computeAudioPreprocess(mck.path, prep.workInSec + (mck.offsetInSpanSec || 0), progress);
                if (aaMck && Array.isArray(aaMck.silences)) allSilM = allSilM.concat(aaMck.silences);
                if (!firstLoudM && aaMck && aaMck.loudness) firstLoudM = aaMck.loudness;
                if (firstThreshM == null && aaMck && aaMck.silenceThresholdUsed != null) firstThreshM = aaMck.silenceThresholdUsed;
              } catch (eMckA) {}
            }
            allSilM.sort(function (a, b) { return a.startSec - b.startSec; });
            audioAnalysisM = { silences: allSilM, loudness: firstLoudM, silencesError: null, loudnessError: null, silenceThresholdUsed: firstThreshM };
          } catch (eAMC) {}
          return {
            raw: { ffmpegChunks: mChunks.length },
            segments: mergeSegmentLists([combinedM]),
            text: textAccM.trim(),
            timelineOffsetSec: prep.workInSec,
            mode: 'media_file_ffmpeg_chunks',
            audioAnalysis: audioAnalysisM
          };
        } finally {
          unlinkChunkList(mChunks);
        }
      }
      beforeAwait();
      progress('Транскрибация: отправка в Whisper…');
      var szM = szPre;
      var actualPathM = prep.path;
      var ffmpegTmpM = null;
      /* Для whisper.cpp видео-контейнеры (.mov/.mp4) не принимаются — всегда извлекаем. */
      var needExtractForLocal = isLocal && !isAudioExt(prep.path);
      if (szM > maxBytes || needExtractForLocal) {
        progress('Извлечение аудио через ffmpeg…');
        ffmpegTmpM = tempAudioPath(prep.path);
        beforeAwait();
        await extractAudioWithFfmpeg(prep.path, ffmpegTmpM);
        actualPathM = ffmpegTmpM;
        szM = fileSizeSync(ffmpegTmpM);
        if (szM > maxBytes) {
          /* Файл всё ещё слишком велик — авто-чанкование */
          progress('Аудио ' + Math.round(szM / 1024 / 1024) + ' МБ > лимита — дополнительная нарезка…');
          var chunkSecFB = (typeof settings.transcribeExportChunkSec === 'number' && settings.transcribeExportChunkSec >= 15)
            ? settings.transcribeExportChunkSec : 90;
          var spanFB = Math.max(30, Math.ceil(szM / 32000));
          var fbChunks = await extractAudioChunksWithFfmpeg(ffmpegTmpM, 0, spanFB, chunkSecFB, progress);
          try {
            var fbDone = 0;
            progress('Транскрибация: отправляю ' + fbChunks.length + ' фрагментов параллельно…');
            var fbTasks = fbChunks.map(function (fbc, fbi) {
              return function () {
                return backendTranscribe(settings, {
                  path: fbc.path,
                  fileName: 'media_fb_' + fbi + '.wav',
                  signal: signal,
                  onProgress: function () {},
                  CloudRuClient: CC,
                  transcribeOptsBase: transcribeOptsBase
                }).then(function (fbData) {
                  fbDone++;
                  progress('Транскрибация: ' + fbDone + '/' + fbChunks.length + ' готово…');
                  return { index: fbi, data: fbData, offset: (prep.clipStartSec || 0) + fbc.offsetInSpanSec };
                });
              };
            });
            var fbResults = await promisePool(fbTasks, CLOUD_CONCURRENCY);
            fbResults.sort(function (a, b) { return a.index - b.index; });
            var fbSegs = [], fbText = '';
            for (var fbr = 0; fbr < fbResults.length; fbr++) {
              var fbNorm = normalizeWhisperMediaFile(
                fbResults[fbr].data, fbResults[fbr].offset, 0, prep.workInSec, prep.workOutSec
              );
              fbSegs = fbSegs.concat(fbNorm.segments);
              fbText += (fbNorm.text || '') + ' ';
            }
            var fbAA = null;
            try { fbAA = await computeAudioPreprocess(ffmpegTmpM, prep.clipStartSec || 0, progress); } catch (eAFB) {}
            return {
              raw: { ffmpegChunks: fbChunks.length },
              segments: mergeSegmentLists([fbSegs]),
              text: fbText.trim(),
              timelineOffsetSec: prep.workInSec,
              mode: 'media_file_auto_chunked',
              audioAnalysis: fbAA
            };
          } finally {
            unlinkChunkList(fbChunks);
            try { if (typeof require !== 'undefined') require('fs').unlinkSync(ffmpegTmpM); } catch (eU) {}
          }
        }
      }
      beforeAwait();
      var dataM = await backendTranscribe(settings, {
        path: actualPathM,
        fileName: String(prep.path || 'media').replace(/^.*[\\/]/, '') || 'media',
        signal: signal,
        onProgress: progress,
        CloudRuClient: CC,
        transcribeOptsBase: transcribeOptsBase
      });
      var normM = normalizeWhisperMediaFile(
        dataM,
        prep.clipStartSec,
        prep.clipInPointSec,
        prep.workInSec,
        prep.workOutSec
      );
      try {
        /* Для media_file используем путь к исходнику (или tmp если был извлечён).
           Смещение — clipStartSec, чтобы тишины были в координатах таймлайна. */
        normM.audioAnalysis = await computeAudioPreprocess(actualPathM, prep.clipStartSec || 0, progress);
      } catch (eAM) {}
      if (ffmpegTmpM) {
        try { if (typeof require !== 'undefined') require('fs').unlinkSync(ffmpegTmpM); } catch (eU2) {}
      }
      return normM;
    }

    throw new Error('Неизвестный режим транскрибации: ' + String(prep.mode));
  }

  global.TimelineTranscribe = {
    normalizeWhisperExport: normalizeWhisperExport,
    normalizeWhisperMediaFile: normalizeWhisperMediaFile,
    readPathAsBlob: readPathAsBlob,
    guessMime: guessMime,
    mergeSegmentLists: mergeSegmentLists,
    runFromPrep: runFromPrep,
    unlinkWorkFiles: function (prep) {
      if (typeof require === 'undefined') return;
      var fs = require('fs');
      function tryUnlink(p) {
        try {
          if (p && fs.existsSync(p)) fs.unlinkSync(p);
        } catch (eU) {}
      }
      if (!prep) return;
      if (prep.mode === 'export_chunks' && prep.chunks) {
        prep.chunks.forEach(function (c) {
          tryUnlink(c.path);
        });
      }
      if (prep.path && prep.mode === 'export_wav') tryUnlink(prep.path);
    }
  };
})(window);
