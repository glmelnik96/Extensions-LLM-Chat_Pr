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
      this.ensureHost(function (err) {
        if (err) {
          callback(err, null);
          return;
        }
        cs.evalScript(extendScriptExpr, function (raw) {
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

    undoLast: function (cb) {
      this.evalJson('$._EXT_PRM_.undoLast()', cb);
    }
  };
})(window);
