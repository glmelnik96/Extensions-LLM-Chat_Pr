/**
 * Локальный бэкенд транскрибации на whisper.cpp.
 *
 * whisper.cpp (https://github.com/ggerganov/whisper.cpp) запускается как
 * отдельный бинарник через Node child_process. Аудио подаётся файлом
 * (wav/mp3/flac/ogg — whisper-cli сам умеет), результат возвращается в
 * формате, совместимом с облачным Whisper verbose_json:
 *     { segments: [{ start, end, text }], text, language }
 *
 * Установка (macOS ARM):
 *     brew install cmake
 *     git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp
 *     cmake -B build && cmake --build build -j
 *     ./models/download-ggml-model.sh medium   # ~1.5 GB
 *
 * Конфигурация — в fm-defaults.js:
 *     transcribeBackend:    'whisper.cpp' | 'cloud'
 *     whisperCppBin:        '' | '/Users/you/whisper.cpp/build/bin/whisper-cli'
 *     whisperCppModel:      '' | '/Users/you/whisper.cpp/models/ggml-medium.bin'
 *     whisperCppLanguage:   'ru' (или 'auto')
 *     whisperCppThreads:    0 (0 = default whisper.cpp)
 *     whisperCppExtraArgs:  [] — дополнительные флаги для whisper-cli
 */
(function (global) {
  var fs, path, os, execFile;
  function ensureNode() {
    if (typeof require === 'undefined') {
      throw new Error('Node.js недоступен в панели (--enable-nodejs должен быть в манифесте).');
    }
    if (!fs) {
      fs = require('fs');
      path = require('path');
      os = require('os');
      execFile = require('child_process').execFile;
    }
  }

  /**
   * Поиск whisper-cli. Аналог findFfmpegPath() — CEP Node не наследует
   * пользовательский PATH, поэтому проходим по whitelist-директориям.
   * Ищем оба имени: whisper-cli (свежие сборки) и main (legacy).
   */
  function findWhisperCliPath(explicit) {
    ensureNode();
    if (explicit && fs.existsSync(explicit)) return explicit;
    var home = os.homedir();
    var candidates = [
      /* Пользовательские сборки из исходников */
      home + '/whisper.cpp/build/bin/whisper-cli',
      home + '/whisper.cpp/build/bin/main',
      home + '/whisper.cpp/main',
      home + '/src/whisper.cpp/build/bin/whisper-cli',
      home + '/projects/whisper.cpp/build/bin/whisper-cli',
      /* Brew */
      '/opt/homebrew/bin/whisper-cli',
      '/opt/homebrew/bin/whisper-cpp',
      '/usr/local/bin/whisper-cli',
      '/usr/local/bin/whisper-cpp',
      '/usr/bin/whisper-cli'
    ];
    for (var i = 0; i < candidates.length; i++) {
      try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
    }
    /* which с дополненным PATH */
    try {
      var execSync = require('child_process').execSync;
      var env = Object.assign({}, process.env, {
        PATH: (process.env.PATH || '') + ':/opt/homebrew/bin:/usr/local/bin:' + home + '/whisper.cpp/build/bin'
      });
      var out = String(execSync('which whisper-cli || which whisper-cpp || true', { env: env, timeout: 5000 })).trim();
      if (out && fs.existsSync(out)) return out;
    } catch (e) {}
    return null;
  }

  /**
   * Поиск модели. Если в конфиге пусто — берём ggml-medium рядом с бинарником.
   */
  function findWhisperModelPath(explicit, whisperBin) {
    ensureNode();
    if (explicit && fs.existsSync(explicit)) return explicit;
    var home = os.homedir();
    var candidates = [
      home + '/whisper.cpp/models/ggml-medium.bin',
      home + '/whisper.cpp/models/ggml-large-v3.bin',
      home + '/whisper.cpp/models/ggml-large-v3-turbo.bin',
      home + '/whisper.cpp/models/ggml-small.bin',
      home + '/whisper.cpp/models/ggml-base.bin'
    ];
    if (whisperBin) {
      /* <dir>/../models или <dir>/../../models */
      var dir = path.dirname(whisperBin);
      candidates.unshift(
        path.resolve(dir, '..', '..', 'models', 'ggml-medium.bin'),
        path.resolve(dir, '..', '..', '..', 'models', 'ggml-medium.bin')
      );
    }
    for (var i = 0; i < candidates.length; i++) {
      try { if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
    }
    return null;
  }

  /**
   * Парс JSON-вывода whisper.cpp (-oj) в формат Whisper verbose_json.
   * Структура -oj:
   *   {
   *     "result": { "language": "ru" },
   *     "transcription": [
   *       { "timestamps": {"from":"00:00:00,000","to":"00:00:04,560"},
   *         "offsets": {"from":0,"to":4560},
   *         "text": " Hello" }, ...
   *     ]
   *   }
   * offsets в миллисекундах.
   */
  function parseWhisperCppJson(raw) {
    var out = { segments: [], text: '', language: null };
    if (!raw || typeof raw !== 'object') return out;
    if (raw.result && raw.result.language) out.language = raw.result.language;
    var tr = raw.transcription;
    if (!Array.isArray(tr)) return out;
    var combined = [];
    for (var i = 0; i < tr.length; i++) {
      var seg = tr[i];
      if (!seg || !seg.offsets) continue;
      var startSec = (typeof seg.offsets.from === 'number' ? seg.offsets.from : 0) / 1000;
      var endSec = (typeof seg.offsets.to === 'number' ? seg.offsets.to : 0) / 1000;
      var txt = String(seg.text || '').replace(/^\s+|\s+$/g, '');
      if (!txt) continue;
      out.segments.push({ start: startSec, end: endSec, text: txt });
      combined.push(txt);
    }
    out.text = combined.join(' ');
    return out;
  }

  /**
   * Запуск whisper-cli на один файл. Возвращает Promise с распарсенным JSON.
   * opts:
   *   filePath          — абсолютный путь к аудио (wav/mp3/…)
   *   binPath?          — явный путь к whisper-cli (иначе авто)
   *   modelPath?        — явный путь к модели (иначе авто)
   *   language?         — 'ru' / 'auto' / ...
   *   threads?          — число потоков (0 = default)
   *   extraArgs?        — array дополнительных флагов
   *   onProgress?       — function(msg)
   *   timeoutMs?        — таймаут на процесс (по умолчанию 30 минут)
   */
  function transcribeFile(opts) {
    ensureNode();
    opts = opts || {};
    if (!opts.filePath) return Promise.reject(new Error('WhisperCpp: filePath обязателен'));
    if (!fs.existsSync(opts.filePath)) {
      return Promise.reject(new Error('WhisperCpp: файл не найден — ' + opts.filePath));
    }
    var bin = findWhisperCliPath(opts.binPath);
    if (!bin) {
      return Promise.reject(new Error(
        'WhisperCpp: whisper-cli не найден. Установите whisper.cpp и пропишите whisperCppBin в fm-defaults.js, ' +
        'либо положите бинарник в ~/whisper.cpp/build/bin/whisper-cli. Проверено: ~/whisper.cpp/build/bin, /opt/homebrew/bin, /usr/local/bin.'
      ));
    }
    var model = findWhisperModelPath(opts.modelPath, bin);
    if (!model) {
      return Promise.reject(new Error(
        'WhisperCpp: модель не найдена. Скачайте: cd ~/whisper.cpp && ./models/download-ggml-model.sh medium. ' +
        'Или пропишите абсолютный путь whisperCppModel в fm-defaults.js.'
      ));
    }

    var lang = opts.language || 'ru';
    var outPrefix = path.join(os.tmpdir(), '_llm_whisper_' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
    var outJson = outPrefix + '.json';

    var args = [
      '-m', model,
      '-f', opts.filePath,
      '-l', lang,
      '-oj',
      '-of', outPrefix,
      '-np'                 /* отключаем лишний stdout */
    ];
    if (opts.threads && opts.threads > 0) args.push('-t', String(opts.threads));
    if (Array.isArray(opts.extraArgs)) args = args.concat(opts.extraArgs.map(String));

    var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30 * 60 * 1000;

    if (typeof opts.onProgress === 'function') {
      opts.onProgress('whisper.cpp: ' + path.basename(opts.filePath) + '…');
    }

    return new Promise(function (resolve, reject) {
      var child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, function (err, stdout, stderr) {
        if (err) {
          /* whisper.cpp пишет «подсказки» в stderr — полезно увидеть последние строки */
          var tail = String(stderr || '').split('\n').slice(-8).join('\n');
          reject(new Error('whisper-cli failed: ' + String(err.message || err) + (tail ? '\n' + tail : '')));
          return;
        }
        var rawJson;
        try {
          if (!fs.existsSync(outJson)) {
            reject(new Error('whisper-cli не создал JSON: ' + outJson));
            return;
          }
          rawJson = JSON.parse(fs.readFileSync(outJson, 'utf8'));
        } catch (ePars) {
          reject(new Error('whisper-cli JSON parse: ' + String(ePars.message || ePars)));
          return;
        }
        /* cleanup */
        try { fs.unlinkSync(outJson); } catch (eU) {}
        var parsed = parseWhisperCppJson(rawJson);
        resolve(parsed);
      });
      /* Abort через signal */
      if (opts.signal && typeof opts.signal.addEventListener === 'function') {
        opts.signal.addEventListener('abort', function () {
          try { child.kill('SIGTERM'); } catch (eK) {}
        });
      }
    });
  }

  /**
   * Быстрая диагностика: установлено ли всё, что нужно. Возвращает
   *   { ok, binPath, modelPath, error }
   */
  function diagnose(opts) {
    try {
      ensureNode();
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    opts = opts || {};
    var bin = findWhisperCliPath(opts.binPath);
    if (!bin) {
      return { ok: false, error: 'whisper-cli не найден (искали в ~/whisper.cpp/build/bin и /opt/homebrew/bin).' };
    }
    var model = findWhisperModelPath(opts.modelPath, bin);
    if (!model) {
      return { ok: false, binPath: bin, error: 'Модель ggml-*.bin не найдена. Скачайте: ~/whisper.cpp/models/download-ggml-model.sh medium' };
    }
    return { ok: true, binPath: bin, modelPath: model };
  }

  global.WhisperCppClient = {
    transcribeFile: transcribeFile,
    parseWhisperCppJson: parseWhisperCppJson,
    findWhisperCliPath: findWhisperCliPath,
    findWhisperModelPath: findWhisperModelPath,
    diagnose: diagnose
  };
})(window);
