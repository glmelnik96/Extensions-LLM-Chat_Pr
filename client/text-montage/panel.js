PanelBoot.run('ИИ: монтаж по тексту', function () {
  var PANEL_ID = window.__PANEL_ID__;
  var lastSnap = null;
  var cs = new CSInterface();
  try {
    ContextStore.setExtensionRoot((cs.getExtensionPath() || '').replace(/\\/g, '/'));
    var udTm = cs.getSystemPath('userData');
    if (udTm) ContextStore.setTranscriptUserDataBase(udTm.replace(/\\/g, '/'));
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
    throw new Error('Не найдены узлы UI (проверьте index.html: chat, input, send, stop, err, btn-transcribe).');
  }

  var runAbort = null;

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
        description: 'Снимок активной секвенции (имена клипов, nodeId, время на таймлайне).',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'get_transcript_from_cache',
        description: 'Получить сохранённый транскрипт по ключу (имя секвенции). Сегменты с startSec/endSec/text.',
        parameters: {
          type: 'object',
          properties: {
            sequenceKey: { type: 'string', description: 'Имя секвенции из снимка' }
          },
          required: ['sequenceKey']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'apply_transcript_cuts',
        description:
          'Вырезать интервалы времени на таймлайне (секунды секвенции). Обрабатываются все видео- и аудиодорожки; связка A/V может разъехаться — при необходимости правьте вручную.',
        parameters: {
          type: 'object',
          properties: {
            removeIntervals: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  startSec: { type: 'number' },
                  endSec: { type: 'number' },
                  reason: { type: 'string' }
                },
                required: ['startSec', 'endSec']
              }
            },
            summary: { type: 'string' }
          },
          required: ['removeIntervals']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'apply_timecode_edits',
        description:
          'Трим, перенос блоков, сдвиг дорожки: те же операции, что в панели «монтаж по таймкодам». move_clip — по умолчанию с автосдвигом всех клипов правее цели; shift_timeline_ripple — явный сдвиг. Для «перенеси вступление после фразы X» — найди в транскрипте startSec фразы и nodeId сегмента в снимке, затем move_clip.',
        parameters: {
          type: 'object',
          properties: {
            operations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  nodeId: { type: 'string' },
                  action: {
                    type: 'string',
                    enum: [
                      'set_timeline_in',
                      'set_timeline_out',
                      'set_timeline_bounds',
                      'remove_clip',
                      'ripple_delete_range',
                      'ripple_delete_range_all_tracks',
                      'lift_delete_range',
                      'lift_delete_range_all_tracks',
                      'set_clip_enabled',
                      'set_clips_enabled_by_name',
                      'move_clip',
                      'shift_timeline_ripple',
                      'set_playhead',
                      'set_clip_speed',
                      'mute_track',
                      'note'
                    ]
                  },
                  timeSec: { type: 'number' },
                  startSec: { type: 'number' },
                  endSec: { type: 'number' },
                  newStartSec: { type: 'number' },
                  shiftBlockingClips: { type: 'boolean' },
                  makeRoom: { type: 'boolean' },
                  fromSec: { type: 'number' },
                  deltaSec: { type: 'number' },
                  excludeNodeIds: { type: 'array', items: { type: 'string' } },
                  enabled: { type: 'boolean' },
                  speed: { type: 'number' },
                  trackType: { type: 'string' },
                  trackIndex: { type: 'number' },
                  muted: { type: 'boolean' },
                  clipName: { type: 'string' },
                  note: { type: 'string' }
                }
              }
            },
            summary: { type: 'string' }
          },
          required: ['operations']
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
      apply_transcript_cuts: function (args) {
        return new Promise(function (resolve, reject) {
          var vr = ToolValidators.validateTranscriptCuts(lastSnap, args);
          if (vr.error) {
            resolve({ validationError: vr.error });
            return;
          }
          PremiereBridge.applyTranscriptCuts(args, function (err, data) {
            if (err) { reject(err); return; }
            if (vr.warn) {
              if (data && typeof data === 'object') data.validatorWarn = vr.warn;
              else data = { raw: data, validatorWarn: vr.warn };
            }
            /* Авто-снимок после правки */
            PremiereBridge.getTimelineSnapshot(function (snapErr, snapData) {
              if (!snapErr && snapData && snapData.ok) lastSnap = snapData;
              data._autoSnapshot = snapData || null;
              resolve(data);
            });
          });
        });
      },
      apply_timecode_edits: function (args) {
        return new Promise(function (resolve, reject) {
          var v = ToolValidators.validateTimecodePlan(lastSnap, args);
          if (v) {
            resolve({
              validationError: v,
              hint: 'Сделайте get_timeline_snapshot и исправьте nodeId или интервал.'
            });
            return;
          }
          PremiereBridge.applyTimecodeEdits(args, function (err, data) {
            if (err) {
              reject(err);
              return;
            }
            PremiereBridge.getTimelineSnapshot(function (snapErr, snapData) {
              if (!snapErr && snapData && snapData.ok) lastSnap = snapData;
              data._autoSnapshot = snapData || null;
              resolve(data);
            });
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

    var apiMessages = [{ role: 'system', content: AgentPrompts.textmontage }].concat(stored);

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
      showErr('Сохранено «' + key + '», сегментов: ' + norm.segments.length + ' (' + norm.mode + ').');
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

  var btnUndo = document.getElementById('btn-undo');
  if (btnUndo) {
    btnUndo.onclick = function () {
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

  var btnClrChat = document.getElementById('btn-clear-chat');
  if (btnClrChat) {
    btnClrChat.onclick = function () {
      ContextStore.clearChat(PANEL_ID);
      renderMessages([]);
    };
  }
  var btnClrCache = document.getElementById('btn-clear-cache');
  if (btnClrCache) {
    btnClrCache.onclick = function () {
      ContextStore.clearTranscriptCache(PANEL_ID);
      setTranscriptLed('red');
      showErr('Кэш транскриптов очищен (общий для панелей маркеров и монтажа по тексту).');
      setTimeout(function () {
        showErr('');
      }, 2000);
    };
  }
  var btnClrAll = document.getElementById('btn-clear-all');
  if (btnClrAll) {
    btnClrAll.onclick = function () {
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
