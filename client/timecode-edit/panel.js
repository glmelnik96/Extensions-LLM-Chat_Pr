PanelBoot.run('ИИ: монтаж по таймкодам', function () {
  var PANEL_ID = window.__PANEL_ID__;
  var cs = new CSInterface();
  try {
    ContextStore.setExtensionRoot((cs.getExtensionPath() || '').replace(/\\/g, '/'));
    var udTc = cs.getSystemPath('userData');
    if (udTc) ContextStore.setTranscriptUserDataBase(udTc.replace(/\\/g, '/'));
  } catch (eRoot) {}

  var el = {
    chat: document.getElementById('chat'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    stop: document.getElementById('stop'),
    err: document.getElementById('err')
  };

  if (!el.chat || !el.input || !el.send || !el.stop || !el.err) {
    throw new Error('Не найдены узлы UI (chat, input, send, stop, err).');
  }

  var runAbort = null;
  var _activeSystemAddon = null;

  var statusUi = PanelUIStatus.create('statusBar');

  var lastSnap = null;

  var tools = [
    {
      type: 'function',
      'function': {
        name: 'get_timeline_snapshot',
        description:
          'Список клипов активной секвенции: имена, nodeId, startSec/endSec на таймлайне. Вызывай, когда пользователь просит «показать», «что на таймлайне», «найди клип».',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'apply_timecode_edits',
        description:
          'Правки на активной секвенции. ripple_delete_range — вырезать и сомкнуть; lift_delete_range — вырезать с дырой; remove_clip; trim; move_clip (по умолчанию автосдвиг всех клипов правее newStartSec); shift_timeline_ripple — явный сдвиг вправо от fromSec; set_clip_enabled; set_clips_enabled_by_name; set_clip_speed; set_playhead; mute_track; note.',
        parameters: {
          type: 'object',
          properties: {
            operations: {
              type: 'array',
              description: 'Порядок операций сверху вниз',
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
                  timeSec: { type: 'number', description: 'АБСОЛЮТНАЯ позиция на таймлайне (сек). Для set_timeline_in: строго между startSec и endSec клипа.' },
                  startSec: { type: 'number' },
                  endSec: { type: 'number' },
                  newStartSec: { type: 'number', description: 'Новая позиция начала клипа (move_clip)' },
                  shiftBlockingClips: {
                    type: 'boolean',
                    description:
                      'По умолчанию true (или не передавать): ripple-сдвиг всех клипов с start >= newStartSec на длительность переносимого, затем установка клипа. false + makeRoom:false — только попытка move без сдвига.'
                  },
                  makeRoom: { type: 'boolean', description: 'Синоним автосдвига; false вместе с shiftBlockingClips:false отключает сдвиг.' },
                  fromSec: { type: 'number', description: 'Начало сдвига на таймлайне (shift_timeline_ripple)' },
                  deltaSec: { type: 'number', description: 'На сколько секунд сдвинуть вправо (shift_timeline_ripple)' },
                  excludeNodeIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'nodeId, которые не сдвигать (shift_timeline_ripple)'
                  },
                  enabled: { type: 'boolean', description: 'true=включить, false=выключить клип (set_clip_enabled)' },
                  speed: { type: 'number', description: '1.0=нормальная, 2.0=2x, 0.5=замедление (set_clip_speed)' },
                  trackType: { type: 'string', description: 'video или audio (mute_track)' },
                  trackIndex: { type: 'number', description: 'Индекс дорожки (mute_track)' },
                  muted: { type: 'boolean', description: 'true=заглушить, false=включить (mute_track)' },
                  clipName: { type: 'string', description: 'Имя клипа как в снимке (set_clips_enabled_by_name)' },
                  note: { type: 'string' }
                }
              }
            },
            summary: { type: 'string', description: 'Краткое описание для пользователя' }
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
      body.textContent = m.content || (m.tool_calls ? JSON.stringify(m.tool_calls.map(function (t) { return t.function.name; })) : '');
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
            if (err) { reject(err); return; }
            /* Авто-снимок после правки — чтобы у следующего шага был свежий таймлайн */
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

  function mergeToolMessagesForStorage(apiMessages) {
    return apiMessages.filter(function (m) {
      return m.role !== 'system';
    });
  }

  /** Быстрый путь: «удали между 3 и 5 сек» без LLM. ripple=false → lift (дыра остаётся). */
  function parseTimelineIntervalDeleteSec(text) {
    var raw = String(text || '');
    var t = raw.toLowerCase().replace(/ё/g, 'е');
    var ripple = true;
    if (
      /не\s*смыка|без\s*смык|не\s+сомык|остав(ь|ить)\s+дыр|с\s+дыр|lift|без\s+ripple|не\s+сомкн/i.test(
        raw
      )
    ) {
      ripple = false;
    }
    if (!/(удал|убер|выреж|вырез|очист|cut|remove|промежут|интервал|дырк|пуст)/i.test(t)) return null;
    var m =
      t.match(/между\s+(\d+)\s*[-]?\s*[йиюяех]?\s+и\s+(\d+)\s*[-]?\s*[йиюяех]?\s*(?:сек|секунд)/i) ||
      t.match(
        /между\s+(\d+(?:[.,]\d+)?)(?:-?[ийюеях]+)?\s+(?:и|до)\s+(\d+(?:[.,]\d+)?)(?:-?[ийюеях]+)?\s*(?:сек|секунд)/i
      ) ||
      t.match(/(?:с|от)\s+(\d+(?:[.,]\d+)?)\s+(?:по|до)\s+(\d+(?:[.,]\d+)?)\s*(?:сек|секунд)/i) ||
      t.match(/(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)\s*(?:сек|секунд)/i);
    if (!m) return null;
    var a = parseFloat(String(m[1]).replace(',', '.'));
    var b = parseFloat(String(m[2]).replace(',', '.'));
    if (isNaN(a) || isNaN(b)) return null;
    return { startSec: Math.min(a, b), endSec: Math.max(a, b), ripple: ripple };
  }

  async function onSendFixed() {
    var text = el.input.value.trim();
    if (!text) return;
    showErr('');
    el.input.value = '';
    var settings = ContextStore.getResolvedSettings();
    var stored = ContextStore.getMessages(PANEL_ID);
    stored.push({ role: 'user', content: text });
    ContextStore.setMessages(PANEL_ID, stored);
    renderMessages(stored);

    var direct = parseTimelineIntervalDeleteSec(text);
    if (direct && direct.endSec > direct.startSec + 0.02) {
      el.send.disabled = true;
      el.stop.disabled = false;
      runAbort = createAbortPair();
      var ac = runAbort;
      statusUi.show('Вырезание интервала на таймлайне…', true);
      try {
        if (ac.aborted) {
          throw new Error('Остановлено');
        }
        var delAction = direct.ripple ? 'ripple_delete_range' : 'lift_delete_range';
        var plan = {
          operations: [{ action: delAction, startSec: direct.startSec, endSec: direct.endSec }],
          summary: 'Удалён участок ' + direct.startSec + '–' + direct.endSec + ' с (' + delAction + ')'
        };
        var fastRes = await new Promise(function (resolve, reject) {
          PremiereBridge.applyTimecodeEdits(plan, function (err, data) {
            if (err) reject(err);
            else resolve(data);
          });
        });
        if (fastRes && !fastRes.ok) {
          throw new Error(fastRes.error || 'Ошибка применения правки на таймлайне');
        }
        stored = ContextStore.getMessages(PANEL_ID);
        stored.push({
          role: 'assistant',
          content:
            'Готово: вырезан интервал с ' +
            direct.startSec +
            ' по ' +
            direct.endSec +
            ' с (' +
            delAction +
            ').'
        });
        ContextStore.setMessages(PANEL_ID, stored);
        renderMessages(stored);
        statusUi.show('Готово', false);
        setTimeout(function () {
          statusUi.hide();
        }, 1200);
      } catch (e) {
        statusUi.hide();
        if (e && (e.name === 'AbortError' || String(e.message || '').indexOf('Остановлен') !== -1)) {
          showErr('Остановлено.');
        } else {
          showErr(String(e.message || e));
        }
      } finally {
        if (runAbort === ac) runAbort = null;
        el.send.disabled = false;
        el.stop.disabled = true;
      }
      return;
    }

    var sysContent = AgentPrompts.timecode;
    if (_activeSystemAddon) {
      sysContent += '\n\n' + _activeSystemAddon;
      _activeSystemAddon = null;
    }
    var apiMessages = [{ role: 'system', content: sysContent }].concat(stored);

    el.send.disabled = true;
    el.stop.disabled = false;
    runAbort = createAbortPair();
    var ac = runAbort;
    statusUi.show('Подключение к Cloud.ru FM…', true);
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
      ContextStore.setMessages(PANEL_ID, mergeToolMessagesForStorage(result.messages));
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

  var btnUndoTc = document.getElementById('btn-undo');
  if (btnUndoTc) {
    btnUndoTc.onclick = function () {
      PremiereBridge.undoLast(function (err, data) {
        if (err) showErr(String(err.message || err));
        else if (data && data.ok) showErr('Откат в Premiere (один шаг).');
        else showErr((data && data.error) || 'Откат недоступен — сфокусируйте таймлайн и Cmd+Z / Ctrl+Z.');
        setTimeout(function () {
          showErr('');
        }, 3500);
      });
    };
  }

  var btnClrChatTc = document.getElementById('btn-clear-chat');
  if (btnClrChatTc) {
    btnClrChatTc.onclick = function () {
      ContextStore.clearChat(PANEL_ID);
      renderMessages([]);
    };
  }
  var btnClrCacheTc = document.getElementById('btn-clear-cache');
  if (btnClrCacheTc) {
    btnClrCacheTc.onclick = function () {
      ContextStore.clearTranscriptCache(PANEL_ID);
      showErr('Кэш транскриптов очищен (общий файл для всех панелей).');
      setTimeout(function () {
        showErr('');
      }, 2000);
    };
  }
  var btnClrAllTc = document.getElementById('btn-clear-all');
  if (btnClrAllTc) {
    btnClrAllTc.onclick = function () {
      ContextStore.clearAllPanelCache(PANEL_ID);
      renderMessages([]);
    };
  }

  el.stop.onclick = function () {
    if (runAbort && typeof runAbort.abort === 'function') runAbort.abort();
  };
  el.send.onclick = onSendFixed;
  el.input.onkeydown = function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSendFixed();
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
});
