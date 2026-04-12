/**
 * Загрузка host/premiere.jsx и вызовы ExtendScript.
 */
(function (global) {
  var cs = new CSInterface();
  var hostLoaded = false;

  function escapeDoubleQuoted(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n');
  }

  function extensionRoot() {
    var p = cs.getExtensionPath();
    return (p || '').replace(/\\/g, '/');
  }

  global.PremiereBridge = {
    ensureHost: function (callback) {
      if (hostLoaded) {
        if (callback) callback(null);
        return;
      }
      var root = extensionRoot();
      if (!root) {
        if (callback) callback(new Error('Нет пути расширения'));
        return;
      }
      var jsxPath = root + '/host/premiere.jsx';
      var cmd = 'try{$.evalFile("' + jsxPath.replace(/"/g, '\\"') + '");"OK";}catch(e){"ERR:"+e.toString();}';
      cs.evalScript(cmd, function (res) {
        var s = String(res || '');
        if (s.indexOf('OK') !== -1) {
          hostLoaded = true;
          if (callback) callback(null);
        } else {
          if (callback) callback(new Error('Не удалось загрузить host/premiere.jsx: ' + s));
        }
      });
    },

    evalJson: function (extendScriptExpr, callback) {
      var TIMEOUT_MS = 30000; /* 30 секунд — защита от зависания ExtendScript */
      this.ensureHost(function (err) {
        if (err) {
          callback(err, null);
          return;
        }
        var called = false;
        var timer = setTimeout(function () {
          if (!called) {
            called = true;
            callback(new Error('ExtendScript не ответил за ' + (TIMEOUT_MS / 1000) + 'с. Premiere может быть занят — попробуйте снова.'), null);
          }
        }, TIMEOUT_MS);
        cs.evalScript(extendScriptExpr, function (raw) {
          if (called) return;
          called = true;
          clearTimeout(timer);
          try {
            var s = typeof raw === 'string' ? raw : String(raw);
            if (s === 'EvalScript error.' || s === 'undefined') {
              callback(new Error('ExtendScript вернул ошибку. Проверьте консоль Premiere (Window → Developer Tools). raw=' + s), null);
              return;
            }
            callback(null, JSON.parse(s));
          } catch (e) {
            callback(new Error('JSON от хоста: ' + String(raw).slice(0, 500)), null);
          }
        });
      });
    },

    getTimelineSnapshot: function (cb) {
      this.evalJson('$._EXT_PRM_.getTimelineSnapshot()', cb);
    },

    applyTimecodeEdits: function (planObj, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(planObj));
      this.evalJson('$._EXT_PRM_.applyTimecodeEdits("' + json + '")', cb);
    },

    applyTranscriptCuts: function (cutsObj, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(cutsObj));
      this.evalJson('$._EXT_PRM_.applyTranscriptCuts("' + json + '")', cb);
    },

    addSequenceMarkers: function (markersArr, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(markersArr));
      this.evalJson('$._EXT_PRM_.addSequenceMarkers("' + json + '")', cb);
    },

    /** extensionRoot, exportPresetPath, maxDirectTranscribeMediaSec */
    prepareTranscribeFromTimeline: function (params, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(params));
      this.evalJson('$._EXT_PRM_.prepareTranscribeFromTimeline("' + json + '")', cb);
    },

    /* Откат таймкодов / монтажа по тексту средствами плагина не реализован.
       Edit→Undo на PP 2025 нестабилен на ripple-cuts; пакетный откат N шагов
       в реальных монтажах (десятки операций) — нерабочее решение. Пользователь
       откатывает штатно: Cmd+Z / Ctrl+Z в таймлайне Premiere. Для маркеров
       откат остаётся через removeMarkersBySeconds. */

    /** Удалить маркеры по списку секунд (откат для add_markers — Edit→Undo не работает по маркерам в PP 2025). */
    removeMarkersBySeconds: function (secondsArr, cb) {
      var json = escapeDoubleQuoted(JSON.stringify({ seconds: secondsArr || [] }));
      this.evalJson('$._EXT_PRM_.removeMarkersBySeconds("' + json + '")', cb);
    },

    /** Импорт файла в проект (в bin "AI Renders" по умолчанию). */
    importMediaFile: function (params, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(params || {}));
      this.evalJson('$._EXT_PRM_.importMediaFile("' + json + '")', cb);
    },

    /** J-cut / L-cut automation. params: {offsetFrames, mode} */
    applyJCuts: function (params, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(params || {}));
      this.evalJson('$._EXT_PRM_.applyJCuts("' + json + '")', cb);
    },

    /** Получить mediaPath клипа на таймлайне по nodeId. */
    getClipMediaPath: function (nodeId, cb) {
      var s = String(nodeId).replace(/"/g, '\\"');
      this.evalJson('$._EXT_PRM_.getClipMediaPath("' + s + '")', cb);
    }
  };
})(window);
