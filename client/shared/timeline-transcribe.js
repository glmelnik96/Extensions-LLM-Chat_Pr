/**
 * Нормализация ответа Whisper для транскрибации с таймлайна (экспорт In–Out или один медиафайл).
 */
(function (global) {
  function normalizeWhisperExport(data, timelineOffsetSec) {
    var off = typeof timelineOffsetSec === 'number' && !isNaN(timelineOffsetSec) ? timelineOffsetSec : 0;
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
    var maxBytes =
      typeof settings.maxTranscribeUploadBytes === 'number' && !isNaN(settings.maxTranscribeUploadBytes)
        ? settings.maxTranscribeUploadBytes
        : 24 * 1024 * 1024;

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
        blob = readPathAsBlob(ch.path);
        beforeAwait();
        var ext = String(ch.path || '').replace(/^.*\./, '') || 'wav';
        data = await CC.transcribeAudio(
          Object.assign({}, transcribeOptsBase, {
            fileBlob: blob,
            fileName: 'chunk_' + ci + '.' + ext
          })
        );
        norm = normalizeWhisperExport(data, ch.timelineOffsetSec);
        combined = combined.concat(norm.segments);
        textAcc += (norm.text || '') + ' ';
      }
      return {
        raw: { chunks: prep.chunks.length },
        segments: mergeSegmentLists([combined]),
        text: textAcc.trim(),
        timelineOffsetSec: prep.chunks[0].timelineOffsetSec,
        mode: 'export_chunks'
      };
    }

    if (prep.mode === 'export_wav') {
      beforeAwait();
      progress('Транскрибация: отправка в Whisper…');
      var szW = fileSizeSync(prep.path);
      if (szW > maxBytes) {
        throw new Error('Файл экспорта слишком большой; задайте transcribeExportChunkSec и пресет .epr.');
      }
      var blobW = readPathAsBlob(prep.path);
      beforeAwait();
      var dataW = await CC.transcribeAudio(
        Object.assign({}, transcribeOptsBase, {
          fileBlob: blobW,
          fileName: 'timeline_inout.wav'
        })
      );
      return normalizeWhisperExport(dataW, prep.timelineOffsetSec);
    }

    if (prep.mode === 'clip_queue' && prep.items && prep.items.length) {
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
        if (!whisperByPath[pathQ]) {
          szQ = fileSizeSync(pathQ);
          var actualPath = pathQ;
          if (szQ > maxBytes) {
            /* Файл слишком большой — извлекаем аудио через ffmpeg */
            progress('Извлечение аудио из ' + String(pathQ).replace(/^.*[\\/]/, '') + ' (ffmpeg)…');
            var tmpQ = tempAudioPath(pathQ);
            beforeAwait();
            await extractAudioWithFfmpeg(pathQ, tmpQ);
            ffmpegTempFiles.push(tmpQ);
            actualPath = tmpQ;
            szQ = fileSizeSync(tmpQ);
            if (szQ > maxBytes) {
              throw new Error('Даже после извлечения аудио файл слишком большой (' + Math.round(szQ / 1024 / 1024) + ' МБ). Уменьшите длину In–Out или задайте exportAudioPresetPath.');
            }
          }
          blobQ = readPathAsBlob(actualPath);
          beforeAwait();
          whisperByPath[pathQ] = await CC.transcribeAudio(
            Object.assign({}, transcribeOptsBase, {
              fileBlob: blobQ,
              fileName: String(pathQ).replace(/^.*[\\/]/, '') || 'media'
            })
          );
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
      return {
        raw: whisperByPath,
        segments: mergeSegmentLists(segLists),
        text: allText.trim(),
        timelineOffsetSec: prep.workInSec,
        mode: 'clip_queue'
      };
    }

    if (prep.mode === 'media_file') {
      beforeAwait();
      progress('Транскрибация: отправка в Whisper…');
      var szM = fileSizeSync(prep.path);
      var actualPathM = prep.path;
      var ffmpegTmpM = null;
      if (szM > maxBytes) {
        /* Файл слишком большой — извлекаем аудио через ffmpeg */
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
      var blobM = readPathAsBlob(actualPathM);
      beforeAwait();
      var dataM = await CC.transcribeAudio(
        Object.assign({}, transcribeOptsBase, {
          fileBlob: blobM,
          fileName: String(prep.path || 'media').replace(/^.*[\\/]/, '') || 'media'
        })
      );
      if (ffmpegTmpM) {
        try { if (typeof require !== 'undefined') require('fs').unlinkSync(ffmpegTmpM); } catch (eU2) {}
      }
      return normalizeWhisperMediaFile(
        dataM,
        prep.clipStartSec,
        prep.clipInPointSec,
        prep.workInSec,
        prep.workOutSec
      );
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
