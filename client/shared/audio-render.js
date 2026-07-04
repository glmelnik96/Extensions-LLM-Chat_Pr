/**
 * AudioRender: офлайн-рендер аудио через ffmpeg (Node.js child_process в CEP-панели).
 *
 * Зачем: ScriptingAPI Premiere Pro 2025 не даёт стабильно ставить keyframes Volume и
 * применять loudnorm на клипе. Поэтому реальное ducking/loudness делаем «снаружи»:
 * рендерим новый WAV-файл на диске, импортируем в проект — пользователь перетаскивает
 * на дорожку (одно ручное действие).
 *
 * Зависимости: ffmpeg в PATH (см. timeline-transcribe.js → findFfmpegPath).
 */
(function (global) {
  function findFfmpeg() {
    if (typeof require === 'undefined') return null;
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
        : String(execSync('which ffmpeg', { timeout: 5000, env: Object.assign({}, process.env, { PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin' }) })).trim();
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
    return null;
  }

  function rendersDir() {
    if (typeof require === 'undefined') return '/tmp';
    var os = require('os');
    var path = require('path');
    var fs = require('fs');
    var d = path.join(os.homedir(), '.extensions_llm_chat_pr', 'renders');
    try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
    return d;
  }

  function basenameNoExt(p) {
    var b = String(p || '').replace(/^.*[\\/]/, '');
    return b.replace(/\.[^.]+$/, '');
  }

  /**
   * Построить ffmpeg volume-фильтр для ducking:
   * volume=enable='between(t,X1,Y1)+between(t,X2,Y2)+...':volume=<linear>
   *
   * Интервалы — в координатах ИСХОДНОГО файла (не таймлайна).
   * timelineToSourceOffset = clipInPointSec - clipStartSec, т.е. sourceTime = timelineTime + offset.
   */
  function buildDuckingFilter(speechIntervalsTimeline, timelineToSourceOffset, duckDb, fadeSec) {
    var linear = Math.pow(10, duckDb / 20);
    /* Используем enable='between(t,a,b)' для нескольких интервалов через сложение булевых выражений */
    var parts = [];
    for (var i = 0; i < speechIntervalsTimeline.length; i++) {
      var iv = speechIntervalsTimeline[i];
      var a = Math.max(0, iv.startSec + timelineToSourceOffset - (fadeSec || 0));
      var b = iv.endSec + timelineToSourceOffset + (fadeSec || 0);
      if (b > a) parts.push('between(t,' + a.toFixed(3) + ',' + b.toFixed(3) + ')');
    }
    if (!parts.length) return null;
    var enableExpr = parts.join('+');
    /* volume фильтр в ffmpeg: volume=<value>:enable='<expr>' */
    return "volume=enable='" + enableExpr + "':volume=" + linear.toFixed(4);
  }

  /**
   * Рендер ducking: на источнике inputPath применяет понижение громкости на интервалах речи.
   * @param {object} opts
   *   inputPath           — путь к исходному WAV/MP3 (музыка)
   *   speechIntervalsTimeline — [{startSec,endSec}] в координатах таймлайна
   *   clipStartSec        — где клип стоит на таймлайне
   *   clipInPointSec      — inPoint клипа в исходнике
   *   duckDb              — целевой ducking (например -12)
   *   fadeSec             — расширение интервала на fade (по 0.15-0.3 с)
   *   onProgress(str)
   * @returns Promise<{ ok, outputPath, summary }>
   */
  function renderDucking(opts) {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof require === 'undefined') throw new Error('Node.js недоступен в панели');
        var bin = findFfmpeg();
        if (!bin) {
          throw new Error('ffmpeg не найден. Установите: brew install ffmpeg (macOS).');
        }
        var input = String(opts.inputPath || '');
        if (!input) throw new Error('inputPath обязателен');
        var fs = require('fs');
        if (!fs.existsSync(input)) throw new Error('Файл не найден: ' + input);
        var ivs = opts.speechIntervalsTimeline || [];
        if (!ivs.length) throw new Error('Нет речевых интервалов для ducking');
        var duckDb = typeof opts.duckDb === 'number' ? opts.duckDb : -12;
        var fadeSec = typeof opts.fadeSec === 'number' ? opts.fadeSec : 0.2;
        /* Координаты исходника = таймлайн - clipStartSec + clipInPointSec */
        var offset = (opts.clipInPointSec || 0) - (opts.clipStartSec || 0);
        var filter = buildDuckingFilter(ivs, offset, duckDb, fadeSec);
        if (!filter) throw new Error('Не удалось построить фильтр (нет валидных интервалов)');

        var path = require('path');
        var outName = basenameNoExt(input) + '_ducked_' + Math.round(Math.abs(duckDb)) + 'dB_' + Date.now() + '.wav';
        var outPath = path.join(rendersDir(), outName);
        if (opts.onProgress) opts.onProgress('ffmpeg: рендер ducking ' + duckDb + ' dB на ' + ivs.length + ' интервалах…');

        var args = [
          '-y',
          '-i', input,
          '-af', filter,
          '-acodec', 'pcm_s16le',
          '-ar', '48000',
          outPath
        ];
        var execFile = require('child_process').execFile;
        execFile(bin, args, { timeout: 600000, maxBuffer: 8 * 1024 * 1024 }, function (err, stdout, stderr) {
          if (err) {
            reject(new Error('ffmpeg ducking упал: ' + String(err.message || err) + '\n' + String(stderr || '').slice(0, 600)));
            return;
          }
          if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 4096) {
            reject(new Error('ffmpeg создал пустой файл: ' + outPath));
            return;
          }
          resolve({
            ok: true,
            outputPath: outPath,
            summary: {
              intervalCount: ivs.length,
              duckDb: duckDb,
              fadeSec: fadeSec,
              outputBytes: fs.statSync(outPath).size
            }
          });
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Рендер LUFS-нормализации через двухпроходный loudnorm.
   * @param {object} opts
   *   inputPath
   *   targetLufs (default -16)
   *   targetTp   (default -1)
   *   targetLra  (default 11)
   *   onProgress
   */
  function renderLoudnorm(opts) {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof require === 'undefined') throw new Error('Node.js недоступен');
        var bin = findFfmpeg();
        if (!bin) throw new Error('ffmpeg не найден. Установите: brew install ffmpeg.');
        var input = String(opts.inputPath || '');
        var fs = require('fs');
        if (!fs.existsSync(input)) throw new Error('Файл не найден: ' + input);
        var I = typeof opts.targetLufs === 'number' ? opts.targetLufs : -16;
        var TP = typeof opts.targetTp === 'number' ? opts.targetTp : -1;
        var LRA = typeof opts.targetLra === 'number' ? opts.targetLra : 11;

        var path = require('path');
        var outName = basenameNoExt(input) + '_loudnorm_I' + Math.round(I) + '_' + Date.now() + '.wav';
        var outPath = path.join(rendersDir(), outName);
        if (opts.onProgress) opts.onProgress('ffmpeg: loudnorm I=' + I + ' (1 проход)…');

        /* Однопроходный loudnorm проще, потери качества для речи незначительны.
           Двухпроходный был бы точнее, но требует парсинга stderr и второй передачи. */
        var filter = 'loudnorm=I=' + I + ':TP=' + TP + ':LRA=' + LRA + ':print_format=summary';
        var args = [
          '-y',
          '-i', input,
          '-af', filter,
          '-acodec', 'pcm_s16le',
          '-ar', '48000',
          outPath
        ];
        var execFile = require('child_process').execFile;
        execFile(bin, args, { timeout: 600000, maxBuffer: 8 * 1024 * 1024 }, function (err, stdout, stderr) {
          if (err) {
            reject(new Error('ffmpeg loudnorm упал: ' + String(err.message || err) + '\n' + String(stderr || '').slice(0, 600)));
            return;
          }
          if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 4096) {
            reject(new Error('ffmpeg loudnorm: пустой файл'));
            return;
          }
          /* Парсим Output Integrated из stderr (если есть) */
          var measured = null;
          var m = String(stderr || '').match(/Output Integrated:\s*(-?\d+(?:\.\d+)?)/);
          if (m) measured = parseFloat(m[1]);
          resolve({
            ok: true,
            outputPath: outPath,
            summary: {
              targetLufs: I,
              targetTp: TP,
              targetLra: LRA,
              measuredOutputLufs: measured,
              outputBytes: fs.statSync(outPath).size
            }
          });
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  global.AudioRender = {
    renderDucking: renderDucking,
    renderLoudnorm: renderLoudnorm
  };
})(typeof window !== 'undefined' ? window : this);
