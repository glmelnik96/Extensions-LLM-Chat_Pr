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

  function normSeqKey(s) {
    return String(s || '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  global.ContextStore = {
    setExtensionRoot: function (absPath) {
      _extensionRoot = String(absPath || '').replace(/\\/g, '/').trim() || null;
    },

    /**
     * CEP: cs.getSystemPath('userData') — общий каталог; внутри создаётся com.extensionsllm.chatpr/_llm_transcript_cache.json
     */
    setTranscriptUserDataBase: function (userDataDirAbs) {
      _transcriptUserDataFile = null;
      if (!userDataDirAbs || typeof require === 'undefined') return;
      try {
        var path = require('path');
        var base = String(userDataDirAbs || '').replace(/\\/g, '/').trim();
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
        transcriptTimelineOffsetSec: transcriptTimelineOffsetSec,
        exportAudioPresetPath: String(d.exportAudioPresetPath || '').trim(),
        maxDirectTranscribeMediaSec:
          typeof maxMedia === 'number' && !isNaN(maxMedia) ? maxMedia : 3600,
        transcribeExportChunkSec:
          typeof chunkSec === 'number' && !isNaN(chunkSec) ? chunkSec : 90,
        maxTranscribeUploadBytes:
          typeof maxUp === 'number' && !isNaN(maxUp) ? maxUp : 20971520,
        exportChunkExtension: chunkExt,
        chatParams: shallowCopy(d.chatParams || {}),
        transcribeParams: shallowCopy(d.transcribeParams || {})
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
      localStorage.setItem(keyMessages(panelId), JSON.stringify(messages));
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
      localStorage.removeItem(keyMessages(panelId));
    },
    clearTranscriptCache: function (panelId) {
      if (transcriptCacheFilePaths().length) {
        writeTranscriptFileToAll({});
      }
      try {
        localStorage.removeItem(LS_TRANSCRIPT_LEGACY);
      } catch (eC) {}
    },
    clearAllPanelCache: function (panelId) {
      this.clearChat(panelId);
      this.clearTranscriptCache(panelId);
    }
  };
})(window);
