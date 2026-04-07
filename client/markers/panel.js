PanelBoot.run('ИИ: маркеры по структуре', function () {
  var PANEL_ID = window.__PANEL_ID__;
  var lastSnap = null;
  var cs = new CSInterface();
  try {
    ContextStore.setExtensionRoot((cs.getExtensionPath() || '').replace(/\\/g, '/'));
    var udMk = cs.getSystemPath('userData');
    if (udMk) ContextStore.setTranscriptUserDataBase(udMk.replace(/\\/g, '/'));
  } catch (eRoot) {}

  var el = {
    chat: document.getElementById('chat'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    stop: document.getElementById('stop'),
    err: document.getElementById('err'),
    transcribe: document.getElementById('btn-transcribe')
  };

  if (!el.chat || !el.input || !el.send || !el.stop || !el.err || !el.transcribe) {
    throw new Error('Не найдены узлы UI (chat, input, send, stop, err, btn-transcribe).');
  }

  var runAbort = null;
  var _activeSystemAddon = null;

  var statusUi = PanelUIStatus.create('statusBar');

  function extensionRootForHost() {
    return (cs.getExtensionPath() || '').replace(/\\/g, '/');
  }

  function setTranscriptLed(state) {
    var led = document.getElementById('transcript-led');
    if (!led) return;
    var s = state === 'busy' ? 'yellow' : state === 'ok' ? 'green' : 'red';
    led.className = 'transcript-led transcript-led--' + s;
    led.setAttribute(
      'aria-label',
      state === 'ok' ? 'Транскрипт в кэше' : state === 'busy' ? 'Идёт транскрибация' : 'Нет транскрипта'
    );
  }

  var tools = [
    {
      type: 'function',
      'function': {
        name: 'get_timeline_snapshot',
        description: 'Снимок активной секвенции.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      'function': {
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
      'function': {
        name: 'add_markers',
        description:
          'Создать маркеры на активной секвенции (секунды таймлайна). ' +
          'Маркер может быть точечным (только timeSec) или span-маркером с длительностью (timeSec + endSec) — ' +
          'тогда он рисуется на линейке как полоса от start до end. ' +
          'Для «отмеченных фрагментов» (хайлайт, цитата, эпизод, глава) предпочитай span-маркер.',
        parameters: {
          type: 'object',
          properties: {
            markers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  timeSec: { type: 'number', description: 'Начало маркера (сек таймлайна)' },
                  endSec: { type: 'number', description: 'Конец span-маркера (сек таймлайна), > timeSec. Опционально.' },
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
        var found = ContextStore.findTranscriptEntry(PANEL_ID, key);
        if (!found.entry) {
          var keys = ContextStore.listTranscriptCacheKeys(PANEL_ID);
          return Promise.resolve({
            error:
              'Нет кэша для «' +
              key +
              '». Проверьте имя секвенции (как в снимке). Кэш общий: ~/.extensions_llm_chat_pr/_llm_transcript_cache.json. Или транскрибируйте In–Out в любой из панелей.',
            requestedKey: key,
            availableKeysInCache: keys.slice(0, 32)
          });
        }
        return Promise.resolve(found.entry);
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

    var sysContent = AgentPrompts.markers;
    if (_activeSystemAddon) {
      sysContent += '\n\n' + _activeSystemAddon;
      _activeSystemAddon = null;
    }
    var apiMessages = [{ role: 'system', content: sysContent }].concat(stored);

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
        maxSteps: settings.maxAgentSteps || 24,
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
    setTranscriptLed('busy');
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
      var again = ContextStore.findTranscriptEntry(PANEL_ID, key);
      if (!again.entry) {
        showErr('Не удалось сохранить или прочитать кэш. Проверьте Node.js в манифесте и права на папку расширения.');
        setTranscriptLed('red');
      } else {
        setTranscriptLed('ok');
      }
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
      setTranscriptLed('red');
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

  var btnUndoMk = document.getElementById('btn-undo');
  if (btnUndoMk) {
    btnUndoMk.onclick = function () {
      PremiereBridge.undoLast(function (err, data) {
        if (err) showErr(String(err.message || err));
        else if (data && data.ok) showErr('Откат в Premiere (один шаг).');
        else showErr((data && data.error) || 'Откат недоступен — Cmd+Z / Ctrl+Z в таймлайне.');
        setTimeout(function () {
          showErr('');
        }, 3500);
      });
    };
  }

  var btnClrChatMk = document.getElementById('btn-clear-chat');
  if (btnClrChatMk) {
    btnClrChatMk.onclick = function () {
      ContextStore.clearChat(PANEL_ID);
      renderMessages([]);
    };
  }
  var btnClrCacheMk = document.getElementById('btn-clear-cache');
  if (btnClrCacheMk) {
    btnClrCacheMk.onclick = function () {
      ContextStore.clearTranscriptCache(PANEL_ID);
      setTranscriptLed('red');
      showErr('Кэш транскриптов очищен (общий для панелей маркеров и монтажа по тексту).');
      setTimeout(function () {
        showErr('');
      }, 2000);
    };
  }
  var btnClrAllMk = document.getElementById('btn-clear-all');
  if (btnClrAllMk) {
    btnClrAllMk.onclick = function () {
      ContextStore.clearAllPanelCache(PANEL_ID);
      renderMessages([]);
    };
  }

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

  /* ── Conversation Starters ────────────────────────────────────── */
  (function setupStarters() {
    var sc = document.getElementById('starters-container');
    if (!sc || typeof StartersUI === 'undefined') return;
    StartersUI.init(PANEL_ID, {
      container: sc,
      onUse: function (starter) {
        el.input.value = starter.userPrompt || '';
        el.input.focus();
      },
      onSystemAddon: function (addon) {
        _activeSystemAddon = addon;
      },
      onError: function (msg) {
        showErr(msg);
        setTimeout(function () { showErr(''); }, 4000);
      }
    });
  })();

  /* Статус кэша для активной секвенции при загрузке */
  (function refreshTranscriptBannerOnLoad() {
    PremiereBridge.getTimelineSnapshot(function (err, snap) {
      var seq = !err && snap && snap.ok && snap.sequenceName ? snap.sequenceName : '';
      if (seq) {
        if (ContextStore.hasTranscriptForSequence(PANEL_ID, seq)) {
          var ent = ContextStore.getTranscriptEntry(PANEL_ID, seq);
          var sc = ent && ent.segments ? ent.segments.length : 0;
          setTranscriptLed('ok');
          showErr('Секвенция «' + seq + '»: транскрипт в кэше (' + sc + ' сегм.). Можно писать в чат.');
        } else {
          setTranscriptLed('red');
          showErr(
            'Секвенция «' +
              seq +
              '»: транскрипта нет — выставьте In/Out и нажмите «Транскрибировать In–Out в кэш».'
          );
        }
      } else {
        var keys = Object.keys(ContextStore.getTranscriptCache(PANEL_ID) || {});
        if (keys.length) {
          setTranscriptLed('red');
          showErr('В кэше ' + keys.length + ' ключ(ей). Откройте секвенцию — покажу статус по имени.');
        } else {
          setTranscriptLed('red');
        }
      }
      setTimeout(function () {
        showErr('');
      }, 9000);
    });
  })();
});
