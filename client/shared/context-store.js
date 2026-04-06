/**
 * История чата и кэш транскриптов по панели (localStorage).
 * panelId: timecode | textmontage | markers
 * Настройки FM только из fm-defaults.js + fm-secrets.js (не из UI и не из localStorage).
 */
(function (global) {
  var PREFIX = 'extllmpr_v1_';

  try {
    localStorage.removeItem(PREFIX + 'settings');
  } catch (e) {}

  function keyMessages(panelId) {
    return PREFIX + 'msg_' + panelId;
  }
  function keyTranscripts(panelId) {
    /* Кэш транскриптов ОБЩИЙ для textmontage и markers —
       чтобы не делать двойную транскрибацию одного таймлайна. */
    return PREFIX + 'tr_shared';
  }

  function shallowCopy(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    }
    return out;
  }

  global.ContextStore = {
    /**
     * Только FM_DEFAULTS + FM_SECRETS.
     */
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
      try {
        var raw = localStorage.getItem(keyTranscripts(panelId));
        return raw ? JSON.parse(raw) : {};
      } catch (e) {
        return {};
      }
    },
    setTranscriptCache: function (panelId, map) {
      localStorage.setItem(keyTranscripts(panelId), JSON.stringify(map));
    },
    setTranscriptEntry: function (panelId, cacheKey, value) {
      var map = this.getTranscriptCache(panelId);
      map[cacheKey] = value;
      this.setTranscriptCache(panelId, map);
    },
    getTranscriptEntry: function (panelId, cacheKey) {
      var map = this.getTranscriptCache(panelId);
      return map[cacheKey];
    },

    clearChat: function (panelId) {
      localStorage.removeItem(keyMessages(panelId));
    },
    clearTranscriptCache: function (panelId) {
      localStorage.removeItem(keyTranscripts(panelId));
    },
    clearAllPanelCache: function (panelId) {
      this.clearChat(panelId);
      this.clearTranscriptCache(panelId);
    }
  };
})(window);
