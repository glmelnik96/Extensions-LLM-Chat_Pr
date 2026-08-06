/**
 * Runtime diagnostic v2 — вставить в DevTools консоль панели (http://localhost:8098).
 *
 * Шаг 1: Перезапусти Premiere Pro (чтобы подхватились изменения)
 * Шаг 2: Открой панель «ИИ: монтаж»
 * Шаг 3: В Chrome открой http://localhost:8098 → Console
 * Шаг 4: Вставь этот код → Enter
 * Шаг 5: Скопируй JSON и отправь мне
 */
(function runDiagnostic() {
  var R = {};
  var log = function (k, v) { R[k] = v; console.log('[DIAG] ' + k + ':', v); };
  var cs = new CSInterface();

  // 1. Extension path — ДО и ПОСЛЕ фикса
  var rawPath = cs.getExtensionPath();
  log('rawExtensionPath', rawPath);
  log('hasFileProtocol', /^file:/.test(rawPath));
  log('hasPercentEncoding', /%\d/.test(rawPath));

  // 2. ContextStore — проверяем что _extensionRoot нормализован
  // (он уже установлен при загрузке панели)
  var keys = ContextStore.listTranscriptCacheKeys('unified');
  log('transcriptKeys', keys && keys.length ? keys : '[]');

  // 3. Cache file existence
  if (typeof require !== 'undefined') {
    var path = require('path');
    var fs = require('fs');
    // Проверяем по ПРАВИЛЬНОМУ пути
    var fixedRoot = rawPath.replace(/^file:\/{2,3}/, '');
    try { fixedRoot = decodeURIComponent(fixedRoot); } catch(e) {}
    var cachePath = path.join(fixedRoot, '_llm_transcript_cache.json');
    var cacheHostPath = path.join(fixedRoot, 'host', '_llm_transcript_cache.json');
    log('fixedRoot', fixedRoot);
    log('cacheAtFixedRoot', fs.existsSync(cachePath) ? 'EXISTS (' + fs.statSync(cachePath).size + 'b)' : 'MISSING');
    log('cacheAtFixedHost', fs.existsSync(cacheHostPath) ? 'EXISTS (' + fs.statSync(cacheHostPath).size + 'b)' : 'MISSING');

    // Проверяем стрейнивший file: каталог
    var strayDir = path.join(process.cwd(), 'file:');
    log('strayFileDir', fs.existsSync(strayDir) ? 'EXISTS (leftover from bug!)' : 'none');
  }

  // 4. LED и карточки
  var led = document.getElementById('tools-led');
  log('toolsLed', led ? led.className : 'N/A');
  var disabled = document.querySelectorAll('.tool-card.disabled').length;
  log('disabledCards', disabled);

  // 5. Snapshot
  PremiereBridge.getTimelineSnapshot(function (err, data) {
    if (err) {
      log('snapshot', 'ERROR: ' + (err.message || err));
    } else if (data && data.ok) {
      log('snapshot', 'OK: seq=' + data.sequenceName + ' clips=' + (data.clips||[]).length);
    } else {
      log('snapshot', 'FAIL: ' + JSON.stringify(data).slice(0, 200));
    }

    // 6. Если транскрипт есть — показать детали
    if (keys && keys.length) {
      var entry = ContextStore.findTranscriptEntry('unified', keys[0]);
      if (entry && entry.entry) {
        log('entry.key', entry.matchedKey);
        log('entry.segments', (entry.entry.segments||[]).length);
        log('entry.audioAnalysis', entry.entry.audioAnalysis ? 'yes' : 'no');
        if (entry.entry.audioAnalysis) {
          log('entry.silences', (entry.entry.audioAnalysis.silences||[]).length);
          log('entry.threshold', entry.entry.audioAnalysis.silenceThresholdUsed);
        }
      }
    }

    console.log('\n===== DIAGNOSTIC v2 =====');
    console.log(JSON.stringify(R, null, 2));
    console.log('=========================');
  });
})();
