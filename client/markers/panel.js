(function () {
  var PANEL_ID = window.__PANEL_ID__;
  var lastSnap = null;
  var cs = new CSInterface();

  var el = {
    chat: document.getElementById('chat'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    stop: document.getElementById('stop'),
    err: document.getElementById('err'),
    transcribe: document.getElementById('btn-transcribe')
  };

  var runAbort = null;

  var statusUi = PanelUIStatus.create('statusBar');

  function extensionRootForHost() {
    return (cs.getExtensionPath() || '').replace(/\\/g, '/');
  }

  var tools = [
    {
      type: 'function',
      function: {
        name: 'get_timeline_snapshot',
        description: 'Снимок активной секвенции.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_transcript_from_cache',
        description: 'Транскрипт из кэша панели по имени секвенции.',
        parameters: {
          type: 'object',
          properties: {
            sequenceKey: { type: 'string' }
          },
          required: ['sequenceKey']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'add_markers',
        description: 'Создать маркеры на активной секвенции (секунды таймлайна).',
        parameters: {
          type: 'object',
          properties: {
            markers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  timeSec: { type: 'number' },
                  name: { type: 'string' },
                  comment: { type: 'string' },
                  type: { type: 'string', description: 'highlight | intro | topic | chapter | question | other' }
                },
                required: ['timeSec', 'name']
              }
            },
            summary: { type: 'string' }
          },
          required: ['markers']
        }
      }
    }
  ];

  function showErr(t) {
    el.err.textContent = t || '';
  }

  function renderMessages(msgs) {
    el.chat.innerHTML = '';
    msgs.forEach(function (m) {
      if (m.role === 'system') return;
      var div = document.createElement('div');
      div.className = 'bubble ' + (m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'tool');
      var role = document.createElement('div');
      role.className = 'role';
      role.textContent = m.role + (m.tool_calls ? ' · tools' : '');
      div.appendChild(role);
      var body = document.createElement('div');
      body.textContent =
        m.content || (m.tool_calls ? JSON.stringify(m.tool_calls.map(function (t) { return t.function.name; })) : '');
      div.appendChild(body);
      el.chat.appendChild(div);
    });
    el.chat.scrollTop = el.chat.scrollHeight;
  }

  function buildExecutors() {
    return {
      get_timeline_snapshot: function () {
        return new Promise(function (resolve, reject) {
          PremiereBridge.getTimelineSnapshot(function (err, data) {
            if (err) reject(err);
            else {
              lastSnap = data;
              resolve(data);
            }
          });
        });
      },
      get_transcript_from_cache: function (args) {
        var key = args.sequenceKey || '';
        var entry = ContextStore.getTranscriptEntry(PANEL_ID, key);
        if (!entry) {
          return Promise.resolve({
            error:
              'Нет кэша. Выставьте In/Out и нажмите «Транскрибировать In–Out в кэш».'
          });
        }
        return Promise.resolve(entry);
      },
      add_markers: function (args) {
        return new Promise(function (resolve, reject) {
          var list = args.markers || [];
          var v = ToolValidators.validateMarkersList(lastSnap, list);
          if (v) {
            resolve({ validationError: v, hint: 'Обновите снимок или поправьте timeSec.' });
            return;
          }
          PremiereBridge.addSequenceMarkers(list, function (err, data) {
            if (err) reject(err);
            else resolve(data);
          });
        });
      }
    };
  }

  async function onSend() {
    var text = el.input.value.trim();
    if (!text) return;
    showErr('');
    el.input.value = '';
    var settings = ContextStore.getResolvedSettings();
    var stored = ContextStore.getMessages(PANEL_ID);
    stored.push({ role: 'user', content: text });
    ContextStore.setMessages(PANEL_ID, stored);
    renderMessages(stored);

    var apiMessages = [{ role: 'system', content: AgentPrompts.markers }].concat(stored);

    el.send.disabled = true;
    el.stop.disabled = false;
    runAbort = createAbortPair();
    var ac = runAbort;
    statusUi.show('Запрос к Cloud.ru FM…', true);
    try {
      var result = await runAgentLoop({
        settings: settings,
        messages: apiMessages,
        tools: tools,
        toolExecutors: buildExecutors(),
        maxSteps: 10,
        abortSignal: ac.signal,
        abortCheck: function () {
          return ac.aborted;
        },
        onStatus: function (ev) {
          statusUi.show(ev.message || ev.name || '…', true);
        }
      });
      statusUi.show('Готово', false);
      setTimeout(function () {
        statusUi.hide();
      }, 1200);
      ContextStore.setMessages(
        PANEL_ID,
        result.messages.filter(function (m) {
          return m.role !== 'system';
        })
      );
      renderMessages(ContextStore.getMessages(PANEL_ID));
    } catch (e) {
      statusUi.hide();
      if (e && (e.name === 'AbortError' || String(e.message || '').indexOf('Остановлен') !== -1)) {
        showErr('Остановлено (запрос к API FM прерван).');
      } else {
        showErr(String(e.message || e));
      }
    } finally {
      if (runAbort === ac) runAbort = null;
      el.send.disabled = false;
      el.stop.disabled = true;
    }
  }

  async function onTranscribeTimeline() {
    showErr('');
    var settings = ContextStore.getResolvedSettings();
    el.transcribe.disabled = true;
    el.stop.disabled = false;
    runAbort = createAbortPair();
    var ac = runAbort;
    var prep = null;
    statusUi.show('Подготовка аудио с таймлайна (In–Out)…', true);
    try {
      prep = await new Promise(function (resolve, reject) {
        PremiereBridge.prepareTranscribeFromTimeline(
          {
            extensionRoot: extensionRootForHost(),
            exportPresetPath: settings.exportAudioPresetPath || '',
            maxDirectTranscribeMediaSec: settings.maxDirectTranscribeMediaSec,
            transcribeExportChunkSec: settings.transcribeExportChunkSec,
            exportChunkExtension: settings.exportChunkExtension || 'wav'
          },
          function (err, data) {
            if (err) reject(err);
            else resolve(data);
          }
        );
      });
      if (!prep || !prep.ok) {
        throw new Error((prep && prep.error) || 'Не удалось подготовить аудио');
      }

      var snap = await new Promise(function (resolve, reject) {
        PremiereBridge.getTimelineSnapshot(function (err, data) {
          if (err) reject(err);
          else resolve(data);
        });
      });
      if (!snap || !snap.ok) {
        throw new Error((snap && snap.error) || 'Нет активной секвенции');
      }
      var key = snap.sequenceName || 'sequence';

      var norm = await TimelineTranscribe.runFromPrep(prep, {
        settings: settings,
        signal: ac.signal,
        abortCheck: function () {
          return ac.aborted;
        },
        onProgress: function (msg) {
          statusUi.show(msg, true);
        },
        CloudRuClient: CloudRuClient
      });

      ContextStore.setTranscriptEntry(PANEL_ID, key, norm);
      statusUi.show('Транскрипт в кэше: «' + key + '»', false);
      setTimeout(function () {
        statusUi.hide();
      }, 2500);
      showErr('Кэш транскрипта: «' + key + '», сегментов: ' + norm.segments.length + ' (' + norm.mode + ').');
      setTimeout(function () {
        showErr('');
      }, 5000);
    } catch (e) {
      statusUi.hide();
      if (e && (e.name === 'AbortError' || String(e.message || '').indexOf('Остановлен') !== -1)) {
        showErr('Транскрибация остановлена.');
      } else {
        showErr(String(e.message || e));
      }
    } finally {
      TimelineTranscribe.unlinkWorkFiles(prep);
      if (runAbort === ac) runAbort = null;
      el.transcribe.disabled = false;
      el.stop.disabled = true;
    }
  }

  el.stop.onclick = function () {
    if (runAbort) runAbort.abort();
  };

  document.getElementById('btn-undo').onclick = function () {
    PremiereBridge.undoLast(function (err, data) {
      if (err) showErr(String(err.message || err));
      else if (data && data.ok) showErr('Откат в Premiere (один шаг).');
      else showErr((data && data.error) || 'Откат недоступен — Cmd+Z / Ctrl+Z в таймлайне.');
      setTimeout(function () {
        showErr('');
      }, 3500);
    });
  };

  document.getElementById('btn-clear-chat').onclick = function () {
    ContextStore.clearChat(PANEL_ID);
    renderMessages([]);
  };
  document.getElementById('btn-clear-cache').onclick = function () {
    ContextStore.clearTranscriptCache(PANEL_ID);
    showErr('Кэш транскриптов очищен.');
    setTimeout(function () {
      showErr('');
    }, 2000);
  };
  document.getElementById('btn-clear-all').onclick = function () {
    ContextStore.clearAllPanelCache(PANEL_ID);
    renderMessages([]);
  };

  el.send.onclick = onSend;
  el.transcribe.onclick = onTranscribeTimeline;
  el.input.onkeydown = function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSend();
  };

  (function setupHints() {
    var list = typeof UiHints !== 'undefined' ? UiHints[PANEL_ID] : null;
    var box = document.getElementById('hint-chips');
    if (!list || !box) return;
    list.forEach(function (h) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'hint-chip';
      b.textContent = h.label;
      b.title = h.text;
      b.onclick = function () {
        el.input.value = h.text;
        el.input.focus();
      };
      box.appendChild(b);
    });
  })();

  renderMessages(ContextStore.getMessages(PANEL_ID));

  /* Показать статус кэша при загрузке панели */
  (function showCacheStatus() {
    var cache = ContextStore.getTranscriptCache(PANEL_ID);
    var keys = Object.keys(cache || {});
    if (keys.length > 0) {
      var last = keys[keys.length - 1];
      var entry = cache[last];
      var segCount = entry && entry.segments ? entry.segments.length : '?';
      showErr('Транскрипт в кэше: «' + last + '», сегментов: ' + segCount);
    }
  })();
})();
