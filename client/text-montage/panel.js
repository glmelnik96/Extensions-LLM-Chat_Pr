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
  var _activeSystemAddon = null;
  /* Отложенное предложение от propose_transcript_cuts (Story Cutter и пр.):
     { removeIntervals, keepSummary, verification } — применяется кнопкой «Применить» в чате. */
  var _pendingProposal = null;

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
        name: 'propose_transcript_cuts',
        description:
          'Предложить план вырезания интервалов пользователю на подтверждение (НЕ выполняет правку). Вернёт verification с keepIntervals; план будет показан пользователю с кнопками «Применить / Отмена». Используй для Story Cutter и других операций, где оператор должен увидеть план до применения. ОБЯЗАТЕЛЬНО передавай keepSummary (что оставляем, с цитатами) и removeSummary (что убираем, с цитатами и причинами) — пользователь должен видеть не только таймкоды, но и текст.',
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
            keepSummary: {
              type: 'array',
              description: 'Краткие цитаты/описания сохраняемых фрагментов (keep), в хронологическом порядке. Для каждого keep-интервала: startSec, endSec, quote (первые 15-30 слов из транскрипта).',
              items: {
                type: 'object',
                properties: {
                  startSec: { type: 'number' },
                  endSec: { type: 'number' },
                  quote: { type: 'string' }
                }
              }
            },
            removeSummary: {
              type: 'array',
              description: 'Цитаты/описания УДАЛЯЕМЫХ фрагментов, параллельно removeIntervals. Для каждого remove-интервала: startSec, endSec, quote (что именно в этом куске говорится), reason (почему убираем).',
              items: {
                type: 'object',
                properties: {
                  startSec: { type: 'number' },
                  endSec: { type: 'number' },
                  quote: { type: 'string' },
                  reason: { type: 'string' }
                }
              }
            },
            summary: {
              type: 'string',
              description: 'Текстовое пояснение плана: 2-4 предложения о том, какой получится ролик и по какому принципу выбраны куски. Показывается пользователю на карточке подтверждения.'
            }
          },
          required: ['removeIntervals', 'summary']
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
    /* Если есть отложенное предложение — перерисовать карточку подтверждения. */
    if (_pendingProposal) renderPendingProposalCard();
    el.chat.scrollTop = el.chat.scrollHeight;
  }

  /* Вычисляет keepIntervals как инверсию removeIntervals по длине секвенции. */
  function computeVerification(removeList) {
    var seqEnd = lastSnap && lastSnap.sequenceEndSec ? lastSnap.sequenceEndSec : 0;
    var removes = (removeList || []).slice().sort(function (a, b) { return a.startSec - b.startSec; });
    var totalRemoveSec = 0;
    removes.forEach(function (iv) { totalRemoveSec += (iv.endSec - iv.startSec); });
    var keepIntervals = [];
    var cursor = 0;
    removes.forEach(function (iv) {
      if (iv.startSec > cursor + 0.05) {
        keepIntervals.push({ startSec: Math.round(cursor * 100) / 100, endSec: Math.round(iv.startSec * 100) / 100 });
      }
      cursor = Math.max(cursor, iv.endSec);
    });
    if (seqEnd > 0 && cursor < seqEnd - 0.05) {
      keepIntervals.push({ startSec: Math.round(cursor * 100) / 100, endSec: Math.round(seqEnd * 100) / 100 });
    }
    var totalKeepSec = 0;
    keepIntervals.forEach(function (iv) { totalKeepSec += (iv.endSec - iv.startSec); });
    return {
      removeCount: removes.length,
      totalRemoveSec: Math.round(totalRemoveSec * 100) / 100,
      keepIntervals: keepIntervals,
      keepCount: keepIntervals.length,
      totalKeepSec: Math.round(totalKeepSec * 100) / 100,
      originalDurationSec: seqEnd > 0 ? Math.round(seqEnd * 100) / 100 : null
    };
  }

  function fmtSec(s) {
    if (typeof s !== 'number' || isNaN(s)) return '?';
    var sign = s < 0 ? '-' : '';
    s = Math.abs(s);
    var m = Math.floor(s / 60);
    var ss = s - m * 60;
    return sign + m + ':' + (ss < 10 ? '0' : '') + ss.toFixed(1);
  }

  /* Отрисовка карточки подтверждения Story Cutter / propose_transcript_cuts. */
  function renderPendingProposalCard() {
    var existing = document.getElementById('pending-proposal-card');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (!_pendingProposal) return;
    var v = _pendingProposal.verification || {};
    var card = document.createElement('div');
    card.id = 'pending-proposal-card';
    card.className = 'bubble tool';
    card.style.border = '1px solid #d97706';
    card.style.background = 'rgba(217,119,6,0.08)';
    card.style.padding = '10px';
    card.style.margin = '8px 0';
    card.style.borderRadius = '6px';

    var title = document.createElement('div');
    title.style.fontWeight = '600';
    title.style.marginBottom = '6px';
    title.textContent = '⚠️ Требуется подтверждение: план монтажа';
    card.appendChild(title);

    /* Текстовое пояснение от агента (если есть) */
    if (_pendingProposal.summary) {
      var sumBlock = document.createElement('div');
      sumBlock.style.fontSize = '12px';
      sumBlock.style.lineHeight = '1.4';
      sumBlock.style.marginBottom = '8px';
      sumBlock.style.padding = '6px 8px';
      sumBlock.style.borderLeft = '3px solid #d97706';
      sumBlock.style.background = 'rgba(217,119,6,0.06)';
      sumBlock.textContent = String(_pendingProposal.summary);
      card.appendChild(sumBlock);
    }

    var stats = document.createElement('div');
    stats.style.fontSize = '12px';
    stats.style.opacity = '0.85';
    stats.style.marginBottom = '8px';
    var orig = v.originalDurationSec || 0;
    var keepS = v.totalKeepSec || 0;
    var pct = orig > 0 ? Math.round((keepS / orig) * 100) : 0;
    stats.textContent =
      'Останется: ' + fmtSec(keepS) + ' из ' + fmtSec(orig) + ' (' + pct + '%) · ' +
      'фрагментов keep: ' + (v.keepCount || 0) + ' · вырезов remove: ' + (v.removeCount || 0);
    card.appendChild(stats);

    /* Вспом.: найти цитату в массиве summary по близости startSec. */
    function _findQuote(arr, startSec) {
      if (!Array.isArray(arr)) return null;
      for (var qi = 0; qi < arr.length; qi++) {
        var qq = arr[qi];
        if (qq && typeof qq.startSec === 'number' && Math.abs(qq.startSec - startSec) < 1.5) {
          return qq;
        }
      }
      return null;
    }

    /* Секция KEEP: что остаётся */
    if (Array.isArray(v.keepIntervals) && v.keepIntervals.length) {
      var keepHdr = document.createElement('div');
      keepHdr.textContent = '✓ Остаётся в ролике (' + v.keepIntervals.length + ')';
      keepHdr.style.fontSize = '11px';
      keepHdr.style.fontWeight = '600';
      keepHdr.style.color = '#10b981';
      keepHdr.style.marginBottom = '4px';
      card.appendChild(keepHdr);

      var keepList = document.createElement('div');
      keepList.style.maxHeight = '160px';
      keepList.style.overflowY = 'auto';
      keepList.style.fontSize = '11px';
      keepList.style.background = 'rgba(16,185,129,0.08)';
      keepList.style.padding = '6px 8px';
      keepList.style.borderRadius = '4px';
      keepList.style.marginBottom = '8px';

      var keepQuotes = _pendingProposal.keepSummary || [];
      v.keepIntervals.forEach(function (iv, idx) {
        var row = document.createElement('div');
        row.style.marginBottom = '4px';
        var head = document.createElement('div');
        head.style.fontFamily = 'monospace';
        head.style.opacity = '0.8';
        head.textContent =
          (idx + 1) + '. [' + fmtSec(iv.startSec) + '–' + fmtSec(iv.endSec) + '] · ' +
          (iv.endSec - iv.startSec).toFixed(1) + 'с';
        row.appendChild(head);
        var qq = _findQuote(keepQuotes, iv.startSec);
        if (qq && qq.quote) {
          var qt = document.createElement('div');
          qt.style.fontStyle = 'italic';
          qt.style.paddingLeft = '14px';
          qt.textContent = '«' + String(qq.quote).slice(0, 200) + '»';
          row.appendChild(qt);
        }
        keepList.appendChild(row);
      });
      card.appendChild(keepList);
    }

    /* Секция REMOVE: что убирается */
    var removeList = _pendingProposal.removeIntervals || [];
    if (removeList.length) {
      var rmHdr = document.createElement('div');
      rmHdr.textContent = '✗ Убирается (' + removeList.length + ')';
      rmHdr.style.fontSize = '11px';
      rmHdr.style.fontWeight = '600';
      rmHdr.style.color = '#f43f5e';
      rmHdr.style.marginBottom = '4px';
      card.appendChild(rmHdr);

      var rmBox = document.createElement('div');
      rmBox.style.maxHeight = '160px';
      rmBox.style.overflowY = 'auto';
      rmBox.style.fontSize = '11px';
      rmBox.style.background = 'rgba(244,63,94,0.08)';
      rmBox.style.padding = '6px 8px';
      rmBox.style.borderRadius = '4px';
      rmBox.style.marginBottom = '8px';

      var rmQuotes = _pendingProposal.removeSummary || [];
      removeList.forEach(function (iv, idx) {
        var row = document.createElement('div');
        row.style.marginBottom = '4px';
        var head = document.createElement('div');
        head.style.fontFamily = 'monospace';
        head.style.opacity = '0.8';
        head.textContent =
          (idx + 1) + '. [' + fmtSec(iv.startSec) + '–' + fmtSec(iv.endSec) + '] · ' +
          (iv.endSec - iv.startSec).toFixed(1) + 'с';
        row.appendChild(head);
        var rq = _findQuote(rmQuotes, iv.startSec);
        var quoteText = rq && rq.quote ? String(rq.quote) : '';
        var reasonText = (rq && rq.reason) || iv.reason || '';
        if (quoteText) {
          var qt2 = document.createElement('div');
          qt2.style.fontStyle = 'italic';
          qt2.style.paddingLeft = '14px';
          qt2.style.textDecoration = 'line-through';
          qt2.style.opacity = '0.85';
          qt2.textContent = '«' + quoteText.slice(0, 200) + '»';
          row.appendChild(qt2);
        }
        if (reasonText) {
          var rt = document.createElement('div');
          rt.style.paddingLeft = '14px';
          rt.style.opacity = '0.7';
          rt.textContent = '— ' + reasonText;
          row.appendChild(rt);
        }
        rmBox.appendChild(row);
      });
      card.appendChild(rmBox);
    }

    /* Кнопки */
    var btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';

    var applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.textContent = '✓ Применить монтаж';
    applyBtn.className = 'btn-primary';
    applyBtn.style.flex = '1';
    applyBtn.onclick = function () { applyPendingProposal(); };

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Отмена';
    cancelBtn.style.flex = '0 0 auto';
    cancelBtn.onclick = function () { cancelPendingProposal(); };

    btnRow.appendChild(applyBtn);
    btnRow.appendChild(cancelBtn);
    card.appendChild(btnRow);

    el.chat.appendChild(card);
    el.chat.scrollTop = el.chat.scrollHeight;
  }

  function applyPendingProposal() {
    if (!_pendingProposal) return;
    var prop = _pendingProposal;
    _pendingProposal = null;
    var card = document.getElementById('pending-proposal-card');
    if (card && card.parentNode) card.parentNode.removeChild(card);
    statusUi.show('Применяю монтаж…', true);
    PremiereBridge.applyTranscriptCuts(
      { removeIntervals: prop.removeIntervals, summary: prop.summary },
      function (err, data) {
        if (err) {
          statusUi.hide();
          showErr('Ошибка применения монтажа: ' + String(err.message || err));
          return;
        }
        PremiereBridge.getTimelineSnapshot(function (snapErr, snapData) {
          if (!snapErr && snapData && snapData.ok) lastSnap = snapData;
          /* Сдвинуть кэшированный транскрипт по ripple-удалениям, чтобы следующий запрос
             не работал по устаревшим таймкодам. */
          try {
            var seqKey = (snapData && snapData.sequenceName) || (lastSnap && lastSnap.sequenceName) || '';
            if (seqKey) {
              ContextStore.applyRippleDeletionsToTranscript(PANEL_ID, seqKey, prop.removeIntervals || []);
            }
          } catch (eShift) {}
          statusUi.show('Готово', false);
          setTimeout(function () { statusUi.hide(); }, 1200);
          /* Записываем в историю как tool-сообщение, чтобы LLM в следующем ходе видела результат. */
          var msgs = ContextStore.getMessages(PANEL_ID);
          msgs.push({
            role: 'assistant',
            content:
              'Монтаж применён по подтверждённому плану. Вырезано ' +
              (prop.verification ? prop.verification.removeCount : '?') + ' интервал(ов), ' +
              'осталось ' + (prop.verification ? fmtSec(prop.verification.totalKeepSec) : '?') + '. ' +
              'Кэш транскрипта пересчитан под новый таймлайн.'
          });
          ContextStore.setMessages(PANEL_ID, msgs);
          renderMessages(msgs);
        });
      }
    );
  }

  function cancelPendingProposal() {
    _pendingProposal = null;
    var card = document.getElementById('pending-proposal-card');
    if (card && card.parentNode) card.parentNode.removeChild(card);
    var msgs = ContextStore.getMessages(PANEL_ID);
    msgs.push({ role: 'assistant', content: 'План монтажа отменён пользователем. Ничего не изменено на таймлайне.' });
    ContextStore.setMessages(PANEL_ID, msgs);
    renderMessages(msgs);
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
        /* Явно пробросим метки editedAfterTranscribe/possiblyStale, чтобы агент видел,
           что таймлайн менялся после транскрибации и кэш уже пересчитан под новые границы. */
        var out = {};
        for (var kk in found.entry) {
          if (Object.prototype.hasOwnProperty.call(found.entry, kk)) out[kk] = found.entry[kk];
        }
        if (out.editedAfterTranscribe) {
          out._notice =
            'Транскрипт был автоматически сдвинут по применённым ripple-удалениям — ' +
            'секундные тайминги соответствуют ТЕКУЩЕМУ состоянию таймлайна. ' +
            (out.possiblyStale
              ? 'Внимание: были также операции с неизвестной картой сдвига (move_clip / set_timeline_*), ' +
                'тайминги могут расходиться — сверяйся с get_timeline_snapshot.'
              : 'Можно работать как с актуальным.');
        }
        return Promise.resolve(out);
      },
      propose_transcript_cuts: function (args) {
        var vr = ToolValidators.validateTranscriptCuts(lastSnap, args);
        if (vr && vr.error) return Promise.resolve({ validationError: vr.error });
        var verification = computeVerification(args.removeIntervals || []);
        _pendingProposal = {
          removeIntervals: args.removeIntervals || [],
          keepSummary: args.keepSummary || [],
          removeSummary: args.removeSummary || [],
          summary: args.summary || '',
          verification: verification,
          createdAt: Date.now()
        };
        /* Показать карточку подтверждения в чате. */
        renderPendingProposalCard();
        return Promise.resolve({
          ok: true,
          status: 'waiting_user_confirmation',
          message:
            'План предложен пользователю. Жди, пока он нажмёт «Применить» или «Отмена». ' +
            'НЕ вызывай apply_transcript_cuts сам — это сделает UI по кнопке.',
          _verification: verification
        });
      },
      apply_transcript_cuts: function (args) {
        return new Promise(function (resolve, reject) {
          var vr = ToolValidators.validateTranscriptCuts(lastSnap, args);
          if (vr.error) {
            resolve({ validationError: vr.error });
            return;
          }

          var verification = computeVerification(args.removeIntervals || []);

          PremiereBridge.applyTranscriptCuts(args, function (err, data) {
            if (err) { reject(err); return; }
            if (vr.warn) {
              if (data && typeof data === 'object') data.validatorWarn = vr.warn;
              else data = { raw: data, validatorWarn: vr.warn };
            }
            /* Добавляем верификацию в ответ */
            if (data && typeof data === 'object') {
              data._verification = verification;
            }
            /* Авто-снимок после правки + сдвиг кэша транскрипта по ripple-удалениям */
            PremiereBridge.getTimelineSnapshot(function (snapErr, snapData) {
              if (!snapErr && snapData && snapData.ok) lastSnap = snapData;
              data._autoSnapshot = snapData || null;
              try {
                var seqKey = (snapData && snapData.sequenceName) || (lastSnap && lastSnap.sequenceName) || '';
                if (seqKey) {
                  ContextStore.applyRippleDeletionsToTranscript(PANEL_ID, seqKey, args.removeIntervals || []);
                  data._transcriptShifted = true;
                }
              } catch (eSh2) {}
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
              /* Для ripple_delete_range* мы знаем интервалы — сдвигаем транскрипт точно.
                 Для move_clip/set_timeline_* — помечаем транскрипт как возможно устаревший. */
              try {
                var seqKey = (snapData && snapData.sequenceName) || (lastSnap && lastSnap.sequenceName) || '';
                if (seqKey && Array.isArray(args.operations)) {
                  var rippleIvs = [];
                  var hasUnknownShift = false;
                  args.operations.forEach(function (op) {
                    if (!op || !op.action) return;
                    if (op.action === 'ripple_delete_range' || op.action === 'ripple_delete_range_all_tracks') {
                      if (typeof op.startSec === 'number' && typeof op.endSec === 'number') {
                        rippleIvs.push({ startSec: op.startSec, endSec: op.endSec });
                      }
                    } else if (
                      op.action === 'move_clip' ||
                      op.action === 'shift_timeline_ripple' ||
                      op.action === 'set_timeline_in' ||
                      op.action === 'set_timeline_out' ||
                      op.action === 'set_timeline_bounds' ||
                      op.action === 'remove_clip' ||
                      op.action === 'set_clip_speed'
                    ) {
                      hasUnknownShift = true;
                    }
                  });
                  if (rippleIvs.length) {
                    ContextStore.applyRippleDeletionsToTranscript(PANEL_ID, seqKey, rippleIvs);
                    data._transcriptShifted = true;
                  }
                  if (hasUnknownShift) {
                    ContextStore.markTranscriptStale(PANEL_ID, seqKey, 'apply_timecode_edits: ' +
                      args.operations.map(function (o) { return o.action; }).join(','));
                    data._transcriptPossiblyStale = true;
                  }
                }
              } catch (eSh3) {}
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

    var sysContent = AgentPrompts.textmontage;
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
