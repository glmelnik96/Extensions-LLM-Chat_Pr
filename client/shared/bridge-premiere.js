/**
 * Загрузка host/premiere.jsx и вызовы ExtendScript.
 */
(function (global) {
  var cs = new CSInterface();
  var hostLoaded = false;

  function escapeDoubleQuoted(s) {
    /* Порядок важен: сначала нормализуем \r\n в \n, потом экранируем backslash,
       потом кавычки, и ТОЛЬКО В КОНЦЕ разворачиваем \n в литерал "\\n".
       Иначе реальный backslash в пути "foo\\n" (маловероятно, но возможно)
       после первой замены стал бы "foo\\\\n", а последняя добавила бы ещё \\n —
       получилось бы "foo\\\\\\n", ломающее JSON.parse в ExtendScript. */
    return s
      .replace(/\r/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }

  function extensionRoot() {
    var p = cs.getExtensionPath();
    return (p || '').replace(/\\/g, '/');
  }

  /* Признак «холодного старта» ExtendScript-движка / CEP-bridge:
     на macOS CEP 12 первые вызовы после открытия панели часто возвращают:
     - 'EvalScript error.' — движок ExtendScript ещё не прогрелся
     - 'undefined'         — Premiere ответил, но result не сериализовался
     - ''                  — пустой ответ (timing issue)
     - '__adobe_cep__ unavailable' — наш csinterface-shim видит, что bridge
       window.__adobe_cep__ ещё не инжектирован Premiere в страницу панели
     Все 4 — известные timing-проблемы. Лечим повтором 2-3 раза с задержкой. */
  function isColdStartGlitch(s) {
    return s === 'EvalScript error.' ||
           s === 'undefined' ||
           s === '' ||
           s === '__adobe_cep__ unavailable';
  }

  global.PremiereBridge = {
    ensureHost: function (callback) {
      if (hostLoaded) {
        if (callback) callback(null);
        return;
      }
      /* Cold-start retry: до 3 попыток с задержкой 0мс / 300мс / 900мс.
         Только для glitch-ответов — реальные «ERR:...» из try/catch не ретраим.
         extensionRoot() читается ВНУТРИ цикла: если __adobe_cep__ ещё не
         инжектирован, путь пустой → ждём и пробуем снова. */
      var attempt = 0;
      var DELAYS = [0, 300, 900];
      function tryLoad() {
        var root = extensionRoot();
        if (!root) {
          /* __adobe_cep__ ещё не доступен — это тоже cold-start. */
          attempt++;
          if (attempt < DELAYS.length) {
            setTimeout(tryLoad, DELAYS[attempt]);
          } else if (callback) {
            callback(new Error('Нет пути расширения (__adobe_cep__ unavailable после ' + attempt + ' попыток)'));
          }
          return;
        }
        var jsxPath = root + '/host/premiere.jsx';
        var cmd = 'try{$.evalFile("' + jsxPath.replace(/"/g, '\\"') + '");"OK";}catch(e){"ERR:"+e.toString();}';
        cs.evalScript(cmd, function (res) {
          var s = String(res || '');
          if (s.indexOf('OK') !== -1) {
            hostLoaded = true;
            if (callback) callback(null);
            return;
          }
          attempt++;
          if (isColdStartGlitch(s) && attempt < DELAYS.length) {
            setTimeout(tryLoad, DELAYS[attempt]);
          } else {
            if (callback) callback(new Error(
              'Не удалось загрузить host/premiere.jsx: ' + s +
              (attempt >= DELAYS.length ? ' (после ' + attempt + ' попыток)' : '')
            ));
          }
        });
      }
      setTimeout(tryLoad, DELAYS[attempt]);
    },

    /**
     * opts (необязателен):
     *   mutating:  true для операций, меняющих таймлайн. ExtendScript однопоточный
     *              и отменить запущенную операцию нельзя — при таймауте она,
     *              скорее всего, ещё выполняется. Поэтому: длинный таймаут по
     *              умолчанию (120с) и сообщение «НЕ запускайте повторно» вместо
     *              «попробуйте снова» (повтор = двойное применение резов по уже
     *              сдвинутым координатам). См. аудит 04.07.2026, M4.
     *   timeoutMs: явный таймаут в мс.
     */
    evalJson: function (extendScriptExpr, callback, opts) {
      opts = opts || {};
      var mutating = opts.mutating === true;
      var TIMEOUT_MS = typeof opts.timeoutMs === 'number'
        ? opts.timeoutMs
        : (mutating ? 120000 : 30000);
      this.ensureHost(function (err) {
        if (err) {
          callback(err, null);
          return;
        }
        /* State machine: 'pending' | 'completed' | 'timed_out'. */
        var state = 'pending';
        var finish = function (errArg, dataArg) {
          if (state !== 'pending') return;
          state = errArg ? 'timed_out' : 'completed';
          try { callback(errArg, dataArg); } catch (cbErr) { /* callback сам отвечает за обработку */ }
        };
        var timer = setTimeout(function () {
          finish(new Error(mutating
            ? 'ExtendScript не ответил за ' + (TIMEOUT_MS / 1000) + 'с, но операция могла продолжить выполняться в Premiere. НЕ запускайте её повторно: сначала проверьте таймлайн и при необходимости откатите через Edit → Undo.'
            : 'ExtendScript не ответил за ' + (TIMEOUT_MS / 1000) + 'с. Premiere может быть занят — попробуйте снова.'), null);
        }, TIMEOUT_MS);

        /* Cold-start retry для evalJson: первая операция после загрузки JSX
           тоже может наткнуться на непрогретый движок и получить
           литеральную строку 'EvalScript error.'. Делаем до 3 попыток
           с возрастающей задержкой. После прогрева retry не нужен. */
        var attempt = 0;
        var DELAYS = [0, 250, 750];
        function tryEval() {
          cs.evalScript(extendScriptExpr, function (raw) {
            if (state !== 'pending') {
              /* Поздний ответ после таймаута: операция в host всё же завершилась.
                 Для мутирующих операций фиксируем это в консоли — важная улика,
                 если пользователь сообщит о «двойных резах». */
              if (state === 'timed_out') {
                try { console.warn('[PremiereBridge] Host ответил ПОСЛЕ таймаута' + (mutating ? ' (мутирующая операция — таймлайн изменён!)' : '') + ': ' + String(raw).slice(0, 200)); } catch (eW) {}
              }
              return;
            }
            var s = typeof raw === 'string' ? raw : String(raw);
            if (isColdStartGlitch(s)) {
              attempt++;
              if (attempt < DELAYS.length) {
                /* Холодный старт — ждём и повторяем. */
                setTimeout(tryEval, DELAYS[attempt]);
                return;
              }
              clearTimeout(timer);
              finish(new Error('ExtendScript вернул ошибку. Проверьте консоль Premiere (Window → Developer Tools). raw=' + s + ' (после ' + attempt + ' попыток)'), null);
              return;
            }
            clearTimeout(timer);
            try {
              var parsed = JSON.parse(s);
              /* HIGH #4 (6 мая 2026): JSON.parse('null') возвращает null — это
                 НЕ валидный success. Caller'ы делают `data.ok` → TypeError. Считаем как glitch. */
              if (parsed === null) {
                finish(new Error('Host вернул null — возможно ExtendScript синхронно вернул литерал null, не валидный JSON-ответ. raw=' + String(raw).slice(0, 200)), null);
                return;
              }
              /* Phase 1 (PP-26 stabilization): host теперь оборачивает все
                 экспортируемые функции через _wrap и при exception возвращает
                 структурированный JSON {_hostError:true, fn, msg, line, source, stack}.
                 Поднимаем это как осмысленную ошибку с реальным номером строки. */
              if (parsed && parsed._hostError === true) {
                var detail = '[' + (parsed.fn || '?') + '] ' + (parsed.msg || 'unknown error');
                if (parsed.line != null) detail += ' @line:' + parsed.line;
                if (parsed.source) detail += ' source="' + String(parsed.source).slice(0, 80) + '"';
                var hostErr = new Error('Host: ' + detail);
                hostErr.hostError = parsed; /* полные детали доступны caller'у */
                finish(hostErr, null);
                return;
              }
              finish(null, parsed);
            } catch (e) {
              finish(new Error('JSON от хоста: ' + String(raw).slice(0, 500)), null);
            }
          });
        }
        tryEval();
      });
    },

    getTimelineSnapshot: function (cb) {
      this.evalJson('$._EXT_PRM_.getTimelineSnapshot()', cb);
    },

    /* Лёгкий опрос: имя секвенции + In/Out (без клипов). Для периодического
       обновления LED/гейтов «Инструментов» — быстрый и с коротким таймаутом. */
    getSequenceRegionInfo: function (cb) {
      this.evalJson('$._EXT_PRM_.getSequenceRegionInfo()', cb, { timeoutMs: 10000 });
    },

    applyTimecodeEdits: function (planObj, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(planObj));
      this.evalJson('$._EXT_PRM_.applyTimecodeEdits("' + json + '")', cb, { mutating: true });
    },

    applyMulticamCuts: function (planObj, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(planObj));
      this.evalJson('$._EXT_PRM_.applyMulticamCuts("' + json + '")', cb, { mutating: true });
    },

    applyTranscriptCuts: function (cutsObj, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(cutsObj));
      this.evalJson('$._EXT_PRM_.applyTranscriptCuts("' + json + '")', cb, { mutating: true });
    },

    addSequenceMarkers: function (markersArr, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(markersArr));
      this.evalJson('$._EXT_PRM_.addSequenceMarkers("' + json + '")', cb, { mutating: true });
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
      this.evalJson('$._EXT_PRM_.removeMarkersBySeconds("' + json + '")', cb, { mutating: true });
    },

    /** Импорт файла в проект (в bin "AI Renders" по умолчанию). */
    importMediaFile: function (params, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(params || {}));
      this.evalJson('$._EXT_PRM_.importMediaFile("' + json + '")', cb);
    },

    /** J-cut / L-cut automation. params: {offsetFrames, mode} */
    applyJCuts: function (params, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(params || {}));
      this.evalJson('$._EXT_PRM_.applyJCuts("' + json + '")', cb, { mutating: true });
    },

    /** B1-1: переместить плейхед активной секвенции (клик по таймкоду в карточке). */
    setPlayhead: function (timeSec, cb) {
      this.evalJson('$._EXT_PRM_.setPlayheadSec(' + Number(timeSec) + ')', cb);
    },

    /** B2-9: checkpoint — клон активной секвенции перед разрушительным apply. */
    backupActiveSequence: function (cb) {
      this.evalJson('$._EXT_PRM_.backupActiveSequence()', cb);
    },

    /** Диаризация: перечислить микрофоны активной секвенции (read-only). */
    getDiarizeMicSources: function (cb) {
      this.evalJson('$._EXT_PRM_.getDiarizeMicSources()', cb);
    },

    /** Вертикаль 9:16: перечислить видеоклипы активной секвенции (read-only). */
    getVerticalReframeSources: function (cb) {
      this.evalJson('$._EXT_PRM_.getVerticalReframeSources()', cb);
    },

    /** Вертикаль 9:16: clone → setSettings 1080×1920 → Motion Scale/Position по плану. */
    applyVerticalReframe: function (planObj, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(planObj));
      this.evalJson('$._EXT_PRM_.applyVerticalReframe("' + json + '")', cb, { mutating: true });
    },

    /** Субтитры: импорт .srt + createCaptionTrack на активной секвенции. */
    importSrtAsCaptions: function (payloadObj, cb) {
      var json = escapeDoubleQuoted(JSON.stringify(payloadObj));
      this.evalJson('$._EXT_PRM_.importSrtAsCaptions("' + json + '")', cb, { mutating: true });
    },

    /** Vision: перечислить видеоклипы активной секвенции с таймингом и mediaPath (read-only). */
    getFrameSources: function (cb) {
      this.evalJson('$._EXT_PRM_.getFrameSources()', cb);
    },

    /** B2-9: Revert — активировать бэкап-секвенцию по sequenceID. */
    activateSequenceById: function (seqId, cb) {
      var s = String(seqId).replace(/"/g, '\\"');
      this.evalJson('$._EXT_PRM_.activateSequenceById("' + s + '")', cb);
    }
  };
})(window);
