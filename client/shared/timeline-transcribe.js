/**
 * Нормализация ответа Whisper для транскрибации с таймлайна (экспорт In–Out или один медиафайл).
 */
(function (global) {
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
        loudnessError: res.loudness && res.loudness.error ? res.loudness.error : null
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
    /* Облачный путь — как раньше: multipart через CloudRuClient */
    var CC = opts.CloudRuClient;
    if (!CC) throw new Error('CloudRuClient не передан в backendTranscribe');
    var blob = readPathAsBlob(opts.path);
    return CC.transcribeAudio(Object.assign({}, opts.transcribeOptsBase, {
      fileBlob: blob,
      fileName: opts.fileName
    }));
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
      var ci, ch, sz, blob, data, norm;
      for (ci = 0; ci < prep.chunks.length; ci++) {
        beforeAwait();
        ch = prep.chunks[ci];
        progress('Транскрибация: фрагмент ' + (ci + 1) + '/' + prep.chunks.length + '…');
        sz = fileSizeSync(ch.path);
        if (sz > maxBytes) {
          throw new Error(
            'Файл слишком большой для API (~' + Math.round(sz / 1024 / 1024) + ' МБ). Уменьшите transcribeExportChunkSec в fm-defaults.js.'
          );
        }
        beforeAwait();
        var ext = String(ch.path || '').replace(/^.*\./, '') || 'wav';
        data = await backendTranscribe(settings, {
          path: ch.path,
          fileName: 'chunk_' + ci + '.' + ext,
          signal: signal,
          onProgress: progress,
          CloudRuClient: CC,
          transcribeOptsBase: transcribeOptsBase
        });
        norm = normalizeWhisperExport(data, ch.timelineOffsetSec);
        combined = combined.concat(norm.segments);
        textAcc += (norm.text || '') + ' ';
      }
      /* 1.1 аудиопрепроцессинг: анализируем первый чанк как репрезентативный образец
         (полный файл чанками уже удалён по одному, но первый ещё доступен до unlinkWorkFiles). */
      var audioAnalysisChunks = null;
      try {
        audioAnalysisChunks = await computeAudioPreprocess(prep.chunks[0].path, prep.chunks[0].timelineOffsetSec, progress);
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
      progress('Транскрибация: отправка в Whisper…');
      var szW = fileSizeSync(prep.path);
      if (szW > maxBytes) {
        throw new Error('Файл экспорта слишком большой; задайте transcribeExportChunkSec и пресет .epr.');
      }
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
      var ffmpegTempFiles = [];
      var qi, it, pathQ, szQ, blobQ, rawW, nq;
      for (qi = 0; qi < prep.items.length; qi++) {
        beforeAwait();
        it = prep.items[qi];
        pathQ = it.path;
        progress('Транскрибация: клип ' + (qi + 1) + '/' + prep.items.length + '…');
        szQ = fileSizeSync(pathQ);
        var spanQ = it.workOutSec - it.workInSec;
        var srcStartQ = (it.clipInPointSec || 0) + (it.workInSec - (it.clipStartSec || 0));
        /* Для whisper.cpp: если исходник — видео, всегда уходим в ffmpeg-чанкинг. */
        var needChunkQ = spanQ > chunkSecCfgQ * 1.5 || szQ > maxBytes || (isLocal && !isAudioExt(pathQ));
        if (needChunkQ) {
          /* Нарезаем нужный диапазон через ffmpeg на короткие WAV-чанки */
          beforeAwait();
          var qChunks = await extractAudioChunksWithFfmpeg(pathQ, srcStartQ, spanQ, chunkSecCfgQ, progress);
          ffmpegTempFiles = ffmpegTempFiles.concat(qChunks.map(function (c) { return c.path; }));
          var qLocal = [];
          for (var qci = 0; qci < qChunks.length; qci++) {
            beforeAwait();
            var qch = qChunks[qci];
            progress('Транскрибация: клип ' + (qi + 1) + '/' + prep.items.length + ', фрагмент ' + (qci + 1) + '/' + qChunks.length + '…');
            var qData = await backendTranscribe(settings, {
              path: qch.path,
              fileName: 'clip_' + qi + '_chunk_' + qci + '.wav',
              signal: signal,
              onProgress: progress,
              CloudRuClient: CC,
              transcribeOptsBase: transcribeOptsBase
            });
            var qNorm = normalizeWhisperExport(qData, it.workInSec + qch.offsetInSpanSec);
            qLocal = qLocal.concat(qNorm.segments);
            allText += (qNorm.text || '') + ' ';
          }
          segLists.push(qLocal);
          continue;
        }
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
      }
      /* Удаляем временные файлы ffmpeg */
      ffmpegTempFiles.forEach(function (tf) {
        try { if (typeof require !== 'undefined') require('fs').unlinkSync(tf); } catch (eU) {}
      });
      /* Для clip_queue анализ делаем на первом оригинальном файле (до удаления ffmpeg-tmp). */
      var audioAnalysisCQ = null;
      try {
        var firstQ = prep.items && prep.items[0];
        if (firstQ && firstQ.path) {
          audioAnalysisCQ = await computeAudioPreprocess(firstQ.path, firstQ.clipStartSec || 0, progress);
        }
      } catch (eACQ) {}
      return {
        raw: whisperByPath,
        segments: mergeSegmentLists(segLists),
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
      /* Для whisper.cpp: видеоконтейнер → ffmpeg-чанкинг (там и диапазон -ss/-t, и pcm). */
      var needChunkM = spanSecM > chunkSecCfgM * 1.5 || szPre > maxBytes || (isLocal && !isAudioExt(prep.path));
      if (needChunkM) {
        beforeAwait();
        progress('Извлечение аудио чанками через ffmpeg (минует 413)…');
        var mChunks = await extractAudioChunksWithFfmpeg(prep.path, srcStartM, spanSecM, chunkSecCfgM, progress);
        var combinedM = [];
        var textAccM = '';
        try {
          for (var mci = 0; mci < mChunks.length; mci++) {
            beforeAwait();
            var mch = mChunks[mci];
            progress('Транскрибация: фрагмент ' + (mci + 1) + '/' + mChunks.length + '…');
            var mData = await backendTranscribe(settings, {
              path: mch.path,
              fileName: 'mediafile_chunk_' + mci + '.wav',
              signal: signal,
              onProgress: progress,
              CloudRuClient: CC,
              transcribeOptsBase: transcribeOptsBase
            });
            var mNorm = normalizeWhisperExport(mData, prep.workInSec + mch.offsetInSpanSec);
            combinedM = combinedM.concat(mNorm.segments);
            textAccM += (mNorm.text || '') + ' ';
          }
          var audioAnalysisM = null;
          try {
            audioAnalysisM = await computeAudioPreprocess(mChunks[0].path, prep.workInSec, progress);
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
          try { if (typeof require !== 'undefined') require('fs').unlinkSync(ffmpegTmpM); } catch (eU) {}
          throw new Error('Даже после извлечения аудио файл слишком большой (' + Math.round(szM / 1024 / 1024) + ' МБ). Задайте exportAudioPresetPath (.epr) для экспорта чанками.');
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
