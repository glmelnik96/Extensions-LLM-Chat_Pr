/**
 * История чата по панели (localStorage).
 * Кэш транскриптов: JSON-файл(ы) на диске — общие для всех Extension Id пакета.
 * panelId: timecode | textmontage | markers
 */
(function (global) {
  var PREFIX = 'extllmpr_v1_';

  try {
    localStorage.removeItem(PREFIX + 'settings');
  } catch (e) {}

  var LS_TRANSCRIPT_LEGACY = PREFIX + 'tr_shared';

  var _extensionRoot = null;
  /** Один файл в CEP userData — общий для всех Extension Id пакета (T3). */
  var _transcriptUserDataFile = null;

  function keyMessages(panelId) {
    return PREFIX + 'msg_' + panelId;
  }

  function shallowCopy(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    }
    return out;
  }

  function discoverBundleRootFromExtension(extPath) {
    if (!extPath || typeof require === 'undefined') return null;
    try {
      var fs = require('fs');
      var path = require('path');
      var cur = extPath;
      var depth = 0;
      while (cur && depth++ < 14) {
        if (fs.existsSync(path.join(cur, 'CSXS', 'manifest.xml'))) {
          return cur;
        }
        var parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    } catch (e) {}
    return null;
  }

  /** Один путь на машине: одинаковый для всех Extension Id (в отличие от CEP userData, часто разный на панель). */
  function homeSharedTranscriptFilePath() {
    if (typeof require === 'undefined') return null;
    try {
      var os = require('os');
      var path = require('path');
      if (!os || typeof os.homedir !== 'function') return null;
      var h = os.homedir();
      if (!h) return null;
      return path.join(h, '.extensions_llm_chat_pr', '_llm_transcript_cache.json');
    } catch (eH) {
      return null;
    }
  }

  /**
   * Все файлы кэша транскриптов (чтение с merge по порядку, последний ключ побеждает; запись — во все).
   * Порядок: корень панели, host/, bundle…, CEP userData, в конце — ~/.extensions_llm_chat_pr/ (канон для кросс-панели).
   */
  function transcriptCacheFilePaths() {
    if (typeof require === 'undefined') return [];
    try {
      var path = require('path');
      var seen = {};
      var out = [];
      function add(abs) {
        if (!abs) return;
        var norm = String(abs).replace(/\\/g, '/');
        if (seen[norm]) return;
        seen[norm] = true;
        out.push(abs);
      }
      var r = _extensionRoot;
      if (r) {
        add(path.join(r, '_llm_transcript_cache.json'));
        add(path.join(r, 'host', '_llm_transcript_cache.json'));
        var bundle = discoverBundleRootFromExtension(r);
        if (bundle) {
          var br = path.normalize(bundle);
          var er = path.normalize(r);
          if (br !== er) {
            add(path.join(bundle, '_llm_transcript_cache.json'));
            add(path.join(bundle, 'host', '_llm_transcript_cache.json'));
          }
        }
      }
      if (_transcriptUserDataFile) {
        add(_transcriptUserDataFile);
      }
      add(homeSharedTranscriptFilePath());
      return out;
    } catch (e2) {
      return [];
    }
  }

  function readOneJsonFile(p) {
    try {
      var fs = require('fs');
      if (!fs.existsSync(p)) return null;
      var raw = fs.readFileSync(p, 'utf8');
      var parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  /** Объединяет ключи из всех существующих файлов (последний путь перезаписывает совпадающие ключи). */
  function readTranscriptFileMerged() {
    var paths = transcriptCacheFilePaths();
    if (!paths.length) return null;
    var merged = {};
    var pi,
      part,
      k;
    for (pi = 0; pi < paths.length; pi++) {
      part = readOneJsonFile(paths[pi]);
      if (part && typeof part === 'object') {
        for (k in part) {
          if (Object.prototype.hasOwnProperty.call(part, k)) merged[k] = part[k];
        }
      }
    }
    return Object.keys(merged).length ? merged : null;
  }

  function writeTranscriptFileToAll(map) {
    var paths = transcriptCacheFilePaths();
    if (!paths.length) return false;
    var fs = require('fs');
    var pathMod = require('path');
    var ok = false;
    var pi,
      p,
      dir,
      tmp;
    for (pi = 0; pi < paths.length; pi++) {
      p = paths[pi];
      try {
        dir = pathMod.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(map), 'utf8');
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e1) {}
        fs.renameSync(tmp, p);
        ok = true;
      } catch (e2) {
        try {
          if (fs.existsSync(p + '.tmp')) fs.unlinkSync(p + '.tmp');
        } catch (e3) {}
      }
    }
    if (!ok && typeof console !== 'undefined' && console.warn) {
      console.warn('[ContextStore] Не удалось записать кэш транскрипта ни в один путь:', paths.join(' | '));
    }
    return ok;
  }

  function readLegacyLocalStorageTranscript() {
    try {
      var raw = localStorage.getItem(LS_TRANSCRIPT_LEGACY);
      if (!raw) return {};
      var o = JSON.parse(raw);
      return typeof o === 'object' && o !== null ? o : {};
    } catch (e) {
      return {};
    }
  }

  /* Аудит 04.07.2026: единая точка «координаты транскрипта сдвинулись» (ripple/
     unknown shift) — UI (waveform-превью, proposal-карточки, LED) подписывается
     и сбрасывает своё состояние. Guard: в node-тестах document нет. */
  function notifyTranscriptShifted() {
    try {
      if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
        document.dispatchEvent(new CustomEvent('omc:transcript-rippled'));
      }
    } catch (e) {}
  }

  function normSeqKey(s) {
    return String(s || '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  /**
   * file:/// URL (CEP cs.getExtensionPath / getSystemPath) → нативный путь.
   * Снимает «file://», декодирует %xx (например %20→пробел), нормализует обратные слэши.
   * Windows: file:///C:/… после снятия «file://» оставляет лишний ведущий «/» перед буквой
   * диска (/C:/… → join даёт «\C:\…» — битый путь) — убираем его. POSIX (/Users/foo) — слэш сохраняем.
   */
  function fileUrlToNativePath(s) {
    s = String(s || '').replace(/^file:\/\//, '');
    try { s = decodeURIComponent(s); } catch (eD) {}
    s = s.replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1').trim();
    return s || null;
  }

  global.ContextStore = {
    setExtensionRoot: function (absPath) {
      _extensionRoot = fileUrlToNativePath(absPath);
    },

    /**
     * CEP: cs.getSystemPath('userData') — общий каталог; внутри создаётся com.extensionsllm.chatpr/_llm_transcript_cache.json
     */
    setTranscriptUserDataBase: function (userDataDirAbs) {
      _transcriptUserDataFile = null;
      if (!userDataDirAbs || typeof require === 'undefined') return;
      try {
        var path = require('path');
        var base = fileUrlToNativePath(userDataDirAbs);
        if (!base) return;
        _transcriptUserDataFile = path.join(base, 'com.extensionsllm.chatpr', '_llm_transcript_cache.json');
      } catch (eU) {}
    },

    getResolvedSettings: function () {
      var d = typeof FM_DEFAULTS !== 'undefined' ? FM_DEFAULTS : {};
      var sec = typeof FM_SECRETS !== 'undefined' ? FM_SECRETS : {};
      var baseUrl = String(d.baseUrl || '').replace(/\/+$/, '');
      var apiKey = String(sec.apiKey || '').trim();
      var chatModel = String(d.chatModel || '').trim();
      var codeModel = String(d.codeModel || '').trim();
      var whisperModel = String(d.whisperModel || '').trim();
      var analysisModel = String(d.analysisModel || '').trim();
      /* Phase 1 (май 2026): chapterModel и findMomentsModel — отдельные модели
         для long-context reasoning. См. fm-defaults.js + memory:reference_cloudru_models. */
      var chapterModel = String(d.chapterModel || '').trim();
      var findMomentsModel = String(d.findMomentsModel || '').trim();
      var enableThinking = (typeof d.enableThinking === 'boolean') ? d.enableThinking : false;
      /* Phase 1.5: per-role thinking override. По умолчанию все роли наследуют
         enableThinking. fm-defaults.thinkingPolicy.<role> переопределяет. */
      var defaultPolicy = { analyze: enableThinking, chapter: enableThinking, chat: enableThinking, report: enableThinking };
      var thinkingPolicy = (d.thinkingPolicy && typeof d.thinkingPolicy === 'object')
        ? Object.assign({}, defaultPolicy, d.thinkingPolicy)
        : defaultPolicy;
      /* Phase 1.5: параллельный chunking в analyze. Default 3 — реалистичный
         компромисс между latency и rate-limit от Cloud.ru. */
      var analyzeConcurrency = (typeof d.analyzeConcurrency === 'number' && d.analyzeConcurrency > 0)
        ? Math.min(8, Math.floor(d.analyzeConcurrency))
        : 1;
      var useCode = d.useCodeModelForAgent === true;
      var agentModel = useCode && codeModel ? codeModel : chatModel;
      var off = d.transcriptTimelineOffsetSec;
      var transcriptTimelineOffsetSec =
        typeof off === 'number' && !isNaN(off) ? off : 0;

      var maxMedia = d.maxDirectTranscribeMediaSec;
      var chunkSec = d.transcribeExportChunkSec;
      var maxUp = d.maxTranscribeUploadBytes;
      var chunkExt = String(d.exportChunkExtension || 'wav').replace(/^\./, '');
      return {
        baseUrl: baseUrl,
        apiKey: apiKey,
        chatModel: chatModel,
        codeModel: codeModel,
        whisperModel: whisperModel,
        useCodeModel: useCode,
        activeAgentModel: agentModel,
        analysisModel: analysisModel || agentModel,
        chapterModel: chapterModel || analysisModel || agentModel,
        findMomentsModel: findMomentsModel || analysisModel || agentModel,
        enableThinking: enableThinking,
        thinkingPolicy: thinkingPolicy,
        analyzeConcurrency: analyzeConcurrency,
        transcriptTimelineOffsetSec: transcriptTimelineOffsetSec,
        exportAudioPresetPath: String(d.exportAudioPresetPath || '').trim(),
        maxDirectTranscribeMediaSec:
          typeof maxMedia === 'number' && !isNaN(maxMedia) ? maxMedia : 3600,
        transcribeExportChunkSec:
          typeof chunkSec === 'number' && !isNaN(chunkSec) ? chunkSec : 90,
        maxTranscribeUploadBytes:
          typeof maxUp === 'number' && !isNaN(maxUp) ? maxUp : 20971520,
        exportChunkExtension: chunkExt,
        maxChatHistoryMessages:
          typeof d.maxChatHistoryMessages === 'number' && d.maxChatHistoryMessages > 0
            ? d.maxChatHistoryMessages
            : 60,
        maxAgentSteps:
          typeof d.maxAgentSteps === 'number' && d.maxAgentSteps > 0
            ? d.maxAgentSteps
            : 24,
        chatParams: shallowCopy(d.chatParams || {}),
        transcribeParams: shallowCopy(d.transcribeParams || {}),
        fastModel: String(d.fastModel || '').trim(),
        /* Волна 3 п.1 (11 июля 2026): vision-модель для describe_frames. */
        visionModel: String(d.visionModel || '').trim(),
        /* Фолбэк-модели по недоступности (21.07.2026). Карта primary→[запасные];
           cloudru-client переключается при 5xx/404/таймауте. См. fm-defaults. */
        modelFallbacks: (d.modelFallbacks && typeof d.modelFallbacks === 'object') ? d.modelFallbacks : {}
      };
    },

    getMessages: function (panelId) {
      try {
        var raw = localStorage.getItem(keyMessages(panelId));
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    },
    setMessages: function (panelId, messages) {
      /* Волна 1 п.8 (аудит §6): localStorage в CEF может бросать (SecurityError/
         QuotaExceeded). setMessages зовётся из середины агент-циклов panel.js —
         бросок ронял весь флоу. История чата — nicety: деградируем с warn. */
      try {
        localStorage.setItem(keyMessages(panelId), JSON.stringify(messages));
        return true;
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[context-store] save chat history failed (LS quota?):', e && e.message);
        }
        return false;
      }
    },
    appendMessage: function (panelId, msg) {
      var m = this.getMessages(panelId);
      m.push(msg);
      this.setMessages(panelId, m);
    },

    getTranscriptCache: function (panelId) {
      var fromFile = readTranscriptFileMerged();
      if (fromFile && typeof fromFile === 'object') {
        return fromFile;
      }
      var legacy = readLegacyLocalStorageTranscript();
      if (legacy && Object.keys(legacy).length > 0) {
        if (writeTranscriptFileToAll(legacy)) {
          try {
            localStorage.removeItem(LS_TRANSCRIPT_LEGACY);
          } catch (eR) {}
        }
        return legacy;
      }
      return {};
    },
    setTranscriptCache: function (panelId, map) {
      var m = map && typeof map === 'object' ? map : {};
      if (transcriptCacheFilePaths().length) {
        if (writeTranscriptFileToAll(m)) {
          try {
            localStorage.removeItem(LS_TRANSCRIPT_LEGACY);
          } catch (eR2) {}
          return true;
        }
      }
      try {
        localStorage.setItem(LS_TRANSCRIPT_LEGACY, JSON.stringify(m));
        return true;
      } catch (eLS) {
        return false;
      }
    },
    setTranscriptEntry: function (panelId, cacheKey, value) {
      var nk = normSeqKey(cacheKey);
      var map = this.getTranscriptCache(panelId);
      map[nk] = value;
      return this.setTranscriptCache(panelId, map);
    },

    /**
     * Применить ripple-удаления removeIntervals к кэшированному транскрипту.
     * Сегменты, полностью попавшие внутрь удаляемого интервала, выбрасываются;
     * частично пересекающиеся — обрезаются; сегменты правее сдвигаются влево на сумму вырезанных интервалов слева от них.
     * Добавляет метку editHistory со счётчиком правок и меткой editedAfterTranscribe: true.
     */
    applyRippleDeletionsToTranscript: function (panelId, sequenceKey, removeIntervals) {
      var found = this.findTranscriptEntry(panelId, sequenceKey);
      if (!found || !found.entry || !Array.isArray(found.entry.segments)) return false;
      var removes = (removeIntervals || [])
        .filter(function (iv) {
          return iv && typeof iv.startSec === 'number' && typeof iv.endSec === 'number' && iv.endSec > iv.startSec;
        })
        .map(function (iv) { return { s: iv.startSec, e: iv.endSec }; })
        .sort(function (a, b) { return a.s - b.s; });
      if (!removes.length) return false;
      /* merge overlapping removes */
      var merged = [];
      for (var mi = 0; mi < removes.length; mi++) {
        var cur = removes[mi];
        if (merged.length && cur.s <= merged[merged.length - 1].e + 0.001) {
          merged[merged.length - 1].e = Math.max(merged[merged.length - 1].e, cur.e);
        } else {
          merged.push({ s: cur.s, e: cur.e });
        }
      }
      function shiftBefore(t) {
        /* сколько секунд вырезано строго ДО момента t */
        var acc = 0;
        for (var i = 0; i < merged.length; i++) {
          if (merged[i].e <= t) acc += (merged[i].e - merged[i].s);
          else if (merged[i].s < t && merged[i].e > t) acc += (t - merged[i].s);
          else break;
        }
        return acc;
      }
      function insideRemove(t) {
        for (var i = 0; i < merged.length; i++) {
          if (merged[i].s <= t && t < merged[i].e) return i;
        }
        return -1;
      }
      var oldSegs = found.entry.segments;
      var newSegs = [];
      for (var si = 0; si < oldSegs.length; si++) {
        var seg = oldSegs[si];
        if (!seg || typeof seg.startSec !== 'number' || typeof seg.endSec !== 'number') continue;
        var s = seg.startSec;
        var e = seg.endSec;
        /* если сегмент полностью в удалённом — пропустить */
        var inStart = insideRemove(s);
        var inEnd = insideRemove(e - 0.001);
        if (inStart !== -1 && inStart === inEnd) continue;
        /* обрезать границы, если пересекает ремов */
        if (inStart !== -1) s = merged[inStart].e;
        if (inEnd !== -1) e = merged[inEnd].s;
        if (e - s < 0.05) continue;
        var ns = s - shiftBefore(s);
        var ne = e - shiftBefore(e);
        if (ne - ns < 0.05) continue;
        var copy = shallowCopy(seg);
        copy.startSec = Math.round(ns * 1000) / 1000;
        copy.endSec = Math.round(ne * 1000) / 1000;
        newSegs.push(copy);
      }
      var entry = shallowCopy(found.entry);
      entry.segments = newSegs;
      /* Аудит 04.07.2026: audioAnalysis (rmsTimeline/silences) НЕ ремапится —
         после ripple его координаты смещены, а карточки «Тишина»/«Jump cuts»
         оставались активными и следующий прогон резал бы по СТАРЫМ таймкодам.
         Честно инвалидируем: гейт попросит новый «Анализ аудио» (30 сек). */
      delete entry.audioAnalysis;
      /* analyzedRegion транскрипта сдвигаем той же математикой, что сегменты:
         In/Out в Premiere ripple тоже смещает, транскрипт остаётся валидным. */
      if (entry.analyzedRegion) {
        var arIn = entry.analyzedRegion.inSec, arOut = entry.analyzedRegion.outSec;
        entry.analyzedRegion = {
          inSec: (typeof arIn === 'number' && isFinite(arIn)) ? Math.round((arIn - shiftBefore(arIn)) * 1000) / 1000 : null,
          outSec: (typeof arOut === 'number' && isFinite(arOut)) ? Math.round((arOut - shiftBefore(arOut)) * 1000) / 1000 : null
        };
      }
      entry.editHistory = Array.isArray(found.entry.editHistory) ? found.entry.editHistory.slice() : [];
      entry.editHistory.push({
        at: Date.now(),
        kind: 'ripple_delete',
        intervals: merged.map(function (x) { return { startSec: x.s, endSec: x.e }; })
      });
      entry.editedAfterTranscribe = true;
      var map = this.getTranscriptCache(panelId);
      map[found.matchedKey] = entry;
      this.setTranscriptCache(panelId, map);
      notifyTranscriptShifted();
      return true;
    },

    /**
     * Помечает транскрипт как «возможно устаревший» после общих timecode-правок
     * (move_clip, set_timeline_bounds и т.п.), когда точная карта сдвигов неизвестна.
     */
    markTranscriptStale: function (panelId, sequenceKey, reason) {
      var found = this.findTranscriptEntry(panelId, sequenceKey);
      if (!found || !found.entry) return false;
      var entry = shallowCopy(found.entry);
      /* Аудит 04.07.2026: сдвиг неизвестен → координаты rmsTimeline/silences
         невалидны, честно требуем новый «Анализ аудио». */
      delete entry.audioAnalysis;
      entry.editHistory = Array.isArray(found.entry.editHistory) ? found.entry.editHistory.slice() : [];
      entry.editHistory.push({ at: Date.now(), kind: 'unknown_shift', reason: String(reason || '') });
      entry.editedAfterTranscribe = true;
      entry.possiblyStale = true;
      var map = this.getTranscriptCache(panelId);
      map[found.matchedKey] = entry;
      this.setTranscriptCache(panelId, map);
      notifyTranscriptShifted();
      return true;
    },

    getTranscriptEntry: function (panelId, cacheKey) {
      return this.findTranscriptEntry(panelId, cacheKey).entry;
    },

    /**
     * Точное совпадение ключа, затем trim, затем без учёта регистра.
     * @returns {{ entry: *, matchedKey: string|null }}
     */
    findTranscriptEntry: function (panelId, sequenceKey) {
      var map = this.getTranscriptCache(panelId);
      var want = normSeqKey(sequenceKey);
      if (!want) return { entry: null, matchedKey: null };
      if (map[want]) return { entry: map[want], matchedKey: want };
      var k,
        low = want.toLowerCase();
      for (k in map) {
        if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
        if (normSeqKey(k).toLowerCase() === low) return { entry: map[k], matchedKey: k };
      }
      return { entry: null, matchedKey: null };
    },

    listTranscriptCacheKeys: function (panelId) {
      return Object.keys(this.getTranscriptCache(panelId) || {});
    },

    hasTranscriptForSequence: function (panelId, sequenceName) {
      return !!this.findTranscriptEntry(panelId, sequenceName).entry;
    },

    clearChat: function (panelId) {
      try { localStorage.removeItem(keyMessages(panelId)); } catch (e) {}
    },
    clearTranscriptCache: function (panelId) {
      if (transcriptCacheFilePaths().length) {
        writeTranscriptFileToAll({});
      }
      try {
        localStorage.removeItem(LS_TRANSCRIPT_LEGACY);
      } catch (eC) {
        console.warn('[context-store] clear legacy LS failed:', eC && eC.message);
      }
    },
    clearAllPanelCache: function (panelId) {
      this.clearChat(panelId);
      this.clearTranscriptCache(panelId);
      this.clearUndoStack(panelId);
    },

    /* --- Стек undo-чекпоинтов панели (Волна 2 п.3: мультиоткат, как
       rewindPointsStack у PremiereGPT). LS-ключ прежний ('undo_'): старый
       формат (одиночный объект) мигрирует в массив при чтении. Порядок
       хранения: старые → новые. Вершина (последний) = getLastUndo —
       контракт для старых вызовов сохранён. --- */
    _undoKey: function (panelId) { return PREFIX + 'undo_' + panelId; },
    UNDO_STACK_MAX: 8,
    _readUndoStack: function (panelId) {
      try {
        var raw = localStorage.getItem(this._undoKey(panelId));
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        var arr = Array.isArray(parsed) ? parsed : [parsed]; /* миграция одиночного формата */
        var out = [];
        for (var i = 0; i < arr.length; i++) {
          var o = arr[i];
          if (o && typeof o.count === 'number' && o.count > 0) out.push(o);
        }
        return out;
      } catch (e) { return []; }
    },
    _writeUndoStack: function (panelId, stack) {
      try {
        if (!stack || !stack.length) {
          localStorage.removeItem(this._undoKey(panelId));
        } else {
          localStorage.setItem(this._undoKey(panelId), JSON.stringify(stack));
        }
      } catch (e) {
        console.warn('[context-store] save undo state failed (LS quota?):', e && e.message);
      }
    },
    /** Вершина стека (последний чекпоинт) или null — старый контракт. */
    getLastUndo: function (panelId) {
      var st = this._readUndoStack(panelId);
      return st.length ? st[st.length - 1] : null;
    },
    /** Весь стек, НОВЫЕ ПЕРВЫМИ (для списка в поповере). */
    getUndoStack: function (panelId) {
      return this._readUndoStack(panelId).slice().reverse();
    },
    /**
     * Push чекпоинта в стек (cap UNDO_STACK_MAX, старейшие вытесняются).
     * @returns {Array} вытесненные записи — panel.js чистит по ним свои
     *          транскрипт-снимки (_transcriptCheckpoints).
     */
    setLastUndo: function (panelId, count, label, sequenceName, opts) {
      if (typeof count !== 'number' || count <= 0) {
        this.clearLastUndoCount(panelId);
        return [];
      }
      var payload = {
        count: count,
        label: label || '',
        sequenceName: sequenceName || '',
        ts: Date.now()
      };
      if (opts && opts.mode) payload.mode = opts.mode;
      if (opts && opts.markerSeconds && opts.markerSeconds.length) payload.markerSeconds = opts.markerSeconds;
      /* B2-9: данные бэкап-секвенции для Revert */
      if (opts && opts.backupId) payload.backupId = String(opts.backupId);
      if (opts && opts.backupName) payload.backupName = String(opts.backupName);
      var st = this._readUndoStack(panelId);
      /* ts — идентификатор записи в стеке (removeUndoEntry); гарантируем уникальность */
      for (var i = 0; i < st.length; i++) {
        if (st[i].ts >= payload.ts) payload.ts = st[i].ts + 1;
      }
      st.push(payload);
      var evicted = [];
      while (st.length > this.UNDO_STACK_MAX) evicted.push(st.shift());
      this._writeUndoStack(panelId, st);
      return evicted;
    },
    /** Снять вершину стека (после успешного отката) — предыдущие точки снова доступны. */
    clearLastUndoCount: function (panelId) {
      var st = this._readUndoStack(panelId);
      if (!st.length) return;
      st.pop();
      this._writeUndoStack(panelId, st);
    },
    /** Удалить конкретный чекпоинт по ts (откат из середины списка). */
    removeUndoEntry: function (panelId, ts) {
      var st = this._readUndoStack(panelId);
      var out = [];
      for (var i = 0; i < st.length; i++) {
        if (st[i].ts !== ts) out.push(st[i]);
      }
      this._writeUndoStack(panelId, out);
    },
    /** Полная очистка стека («Сбросить всё»). */
    clearUndoStack: function (panelId) {
      try { localStorage.removeItem(this._undoKey(panelId)); } catch (e) {}
    }
  };
})(window);
