/**
 * Единая панель: все функции (таймкоды / текст / маркеры / аудио) в одном чате.
 *
 * Архитектура:
 *  - Один panelId 'unified', один набор инструментов TOOLS_UNIFIED, единый промпт.
 *  - Транскрибация ОБЩАЯ — одна кнопка, общий кэш-файл.
 *  - Стартеры группируются по категориям (таймлайн / текст / маркеры) через вкладки.
 *  - Кнопка undo для маркеров (точечное удаление), для таймкодов — Cmd+Z в Premiere.
 */
try { window.__PANEL_BUILD__ = '2026-06-19-waveform-filled-v25'; } catch (e) {}
PanelBoot.run('ИИ: монтаж', function () {
  var cs = new CSInterface();
  try {
    ContextStore.setExtensionRoot((cs.getExtensionPath() || '').replace(/\\/g, '/'));
    var udU = cs.getSystemPath('userData');
    if (udU) ContextStore.setTranscriptUserDataBase(udU.replace(/\\/g, '/'));
  } catch (eRoot) {}

  /* Все обращения к транскриптам идут под одним panelId — на самом деле кэш всё равно
     общий через файл, panelId сейчас служит ключом группы в localStorage-fallback и не
     ограничивает чтения между пресетами. Используем единый ключ для прозрачности. */
  var TRANSCRIPT_PID = 'unified';

  var el = {
    chat: document.getElementById('chat'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    stop: document.getElementById('stop'),
    err: document.getElementById('err'),
    transcribe: document.getElementById('btn-transcribe'),
    hintBox: document.getElementById('hint-chips'),
    startersBox: document.getElementById('starters-container'),
    ledText: document.getElementById('transcript-led-text'),
    moreMenu: document.getElementById('more-menu'),
    moreBtn: document.getElementById('more-btn')
  };
  if (!el.chat || !el.input || !el.send || !el.stop || !el.err) {
    throw new Error('Не найдены узлы UI единой панели.');
  }

  var statusUi = PanelUIStatus.create('statusBar');

  /* Состояние, общее на единую панель: */
  var lastSnap = null;
  var _snapDirty = true; /* Dirty flag: true = нужно перезапросить snapshot */
  var runAbort = null;
  /* Единая очередь операций: одна async-операция (чат/транскрибация/анализ) за раз.
     Защита от гонок — раньше параллельный запуск перетирал runAbort и пускал две
     цепочки против общего состояния (ExtendScript-мост, ContextStore). */
  var opQueue = (typeof OperationQueue !== 'undefined') ? OperationQueue.create() : null;
  function beginOperation(label) {
    if (!opQueue) return true; /* модуль не загружен — деградируем к старому поведению */
    if (!opQueue.tryBegin(label)) {
      showErr('Идёт обработка — дождитесь завершения или нажмите «Стоп».');
      return false;
    }
    return true;
  }
  function endOperation() {
    if (opQueue) opQueue.end();
  }
  var _activeSystemAddon = null;
  var _pendingProposal = null;
  var _keepInvertWarning = null;
  var _transcriptCheckpoints = {}; /* backupId → {key, entry} снимок транскрипта до apply (для отката) */
  /* Safety-guard (18.06.2026): прямой apply_* без карточки разрешён ТОЛЬКО если
     пользователь явно попросил. Иначе apply_* перенаправляется на propose_*.
     Причина: LLM стохастически нарушал «ВСЕГДА propose_*» и применял ripple-delete
     без подтверждения (live-баг на seq1: «вырежи с 10 по 20» → молча применил). */
  var _directApplyAuthorized = false;
  function _detectDirectApply(text) {
    return /без\s+подтвержд|не\s+спрашив|не\s+подтвержд|сразу\s+примен|примен\w*\s+сразу|делай\s+сразу|без\s+предпросмотр|without\s+confirm/i.test(String(text || ''));
  }

  /* Snapshot caching: слушаем событие изменения секвенции от Premiere.
     Если пользователь или внешний скрипт изменил таймлайн — помечаем snapshot dirty. */
  try {
    cs.addEventListener('com.adobe.csxs.events.SequenceChanged', function () { _snapDirty = true; });
    cs.addEventListener('com.adobe.csxs.events.ActiveSequenceChanged', function () {
      _snapDirty = true;
      /* Смена активной секвенции: уведомляем вкладку Инструментов сбросить stale
         waveform/proposal и пересчитать LED под новую секвенцию. */
      try { document.dispatchEvent(new CustomEvent('omc:active-sequence-changed')); } catch (eAS) {}
    });
  } catch (eEvt) { /* CEP events могут не работать в некоторых версиях — fallback: всегда dirty */ }
  /* { kind: 'transcript_cuts'|'timecode_edits'|'markers'|'audio_ducking'|'loudness',
       payload: ..., summary, createdAt, simulation? (для timecode), verification? (для transcript_cuts) } */

  function extensionRootForHost() {
    return (cs.getExtensionPath() || '').replace(/\\/g, '/');
  }

  /**
   * MEDIUM #20 (6 мая 2026): расширенный showErr с опциональным retry/hint.
   * Старая сигнатура showErr(text) — без изменений.
   * Новая: showErr(text, { retry: fn, hint: 'string' }).
   */
  function showErr(t, opts) {
    if (!el.err) return;
    while (el.err.firstChild) el.err.removeChild(el.err.firstChild);
    if (!t) return;
    var span = document.createElement('span');
    span.textContent = t;
    el.err.appendChild(span);
    opts = opts || {};
    if (typeof opts.retry === 'function') {
      el.err.appendChild(document.createTextNode(' '));
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.style.cssText = 'font-size:11px;padding:2px 8px;margin-left:4px;';
      btn.textContent = '↻ Повторить';
      btn.onclick = function () {
        showErr(''); /* очистить */
        try { opts.retry(); } catch (eR) {}
      };
      el.err.appendChild(btn);
    }
    if (opts.hint) {
      var hintEl = document.createElement('div');
      hintEl.style.cssText = 'font-size:11px;color:var(--muted);margin-top:4px;';
      hintEl.textContent = opts.hint;
      el.err.appendChild(hintEl);
    }
  }

  /**
   * MEDIUM #20: классификация ошибок для адаптивных подсказок.
   * Возвращает {kind, hint} — kind: 'network' | 'auth' | 'quota' | 'cancel' | 'other'.
   */
  function _classifyError(err) {
    var msg = String(err && err.message || err || '').toLowerCase();
    if (/abort|cancel/.test(msg)) {
      return { kind: 'cancel', hint: 'Операция отменена пользователем.' };
    }
    if (/401|unauthorized|invalid api|api[ -]?key/.test(msg)) {
      return { kind: 'auth', hint: 'Похоже, неверный API-ключ. Проверьте Settings → API key.' };
    }
    if (/429|rate limit|quota|exceed/.test(msg)) {
      return { kind: 'quota', hint: 'Превышены лимиты API. Подождите минуту перед повтором.' };
    }
    if (/fetch|network|timeout|econnreset|enotfound|net::|socket/.test(msg)) {
      return { kind: 'network', hint: 'Похоже, проблема с сетью. Проверь VPN/интернет и нажми «Повторить».' };
    }
    return { kind: 'other', hint: '' };
  }

  /**
   * states: 'busy' (yellow), 'ok' (green) — full transcript, 'audio' (blue) —
   * audio-only analysis, 'red' / undefined — no data.
   * Phase 1.6 (6 мая 2026): добавлен 'audio' для UX различия audio-only от full.
   */
  function setTranscriptLed(state) {
    var led = document.getElementById('transcript-led');
    if (!led) return;
    var s, t, label;
    if (state === 'busy') { s = 'yellow'; t = 'идёт'; label = 'Идёт обработка'; }
    else if (state === 'ok') { s = 'green'; t = 'есть'; label = 'Транскрипт в кэше'; }
    else if (state === 'audio') { s = 'blue'; t = 'аудио'; label = 'Анализ аудио (без транскрипта)'; }
    else { s = 'red'; t = 'нет'; label = 'Нет данных'; }
    led.className = 'transcript-led transcript-led--' + s;
    if (el.ledText) el.ledText.textContent = t;
    led.setAttribute('aria-label', label);
    /* HIGH #18 (6 мая 2026): event-based view sync вместо fragile coupling
       через window.toolsRefreshLed. Любая view может subscribe'нуться. */
    try {
      document.dispatchEvent(new CustomEvent('omc:transcript-led-changed', {
        detail: { state: s, label: label }
      }));
    } catch (eEv) {
      /* Fallback для очень старых движков (CEP Chromium < 51 без CustomEvent constructor) */
      if (typeof window.toolsRefreshLed === 'function') {
        try { window.toolsRefreshLed(); } catch (e) {}
      }
    }
  }

  /* ─── Health-check при старте (Install hardening, май 2026) ────────
   * Проверяем критичные предусловия и показываем жёлтую плашку с
   * подсказками, если что-то не настроено. Не блокирует работу панели —
   * просто информирует. См. INSTALL.md для полного Troubleshooting.
   */
  function _panelHealthRender(issues) {
    if (!issues || !issues.length) return;
    /* Если плашка уже отрисована — не дублируем (повторный запуск). */
    if (document.getElementById('panel-health-banner')) return;
    var bn = document.createElement('div');
    bn.id = 'panel-health-banner';
    bn.style.cssText =
      'background:rgba(217,119,6,0.14);border:1px solid rgba(217,119,6,0.5);' +
      'border-radius:4px;padding:8px 10px;margin:6px 6px 8px;font-size:11px;' +
      'line-height:1.45;color:#fbbf24;';
    var hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;font-weight:600;';
    hdr.innerHTML = '⚠ Установка не завершена · ' + issues.length + ' проблема(ы)';
    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = '×';
    dismiss.title = 'Скрыть';
    dismiss.style.cssText =
      'margin-left:auto;background:none;border:none;color:#fbbf24;cursor:pointer;' +
      'font-size:14px;padding:0 4px;';
    dismiss.onclick = function () { bn.remove(); };
    hdr.appendChild(dismiss);
    bn.appendChild(hdr);
    issues.forEach(function (it) {
      var row = document.createElement('div');
      row.style.cssText = 'margin:4px 0 4px 0;';
      var t = document.createElement('div');
      t.style.cssText = 'font-weight:600;color:#fde68a;';
      t.textContent = '• ' + (it.title || 'Проблема');
      row.appendChild(t);
      if (it.fix) {
        var f = document.createElement('div');
        f.style.cssText = 'padding-left:10px;color:#fcd34d;';
        f.textContent = it.fix;
        row.appendChild(f);
      }
      if (it.code) {
        var c = document.createElement('code');
        c.style.cssText =
          'display:block;margin:3px 0 3px 10px;padding:3px 6px;background:rgba(0,0,0,0.3);' +
          'border-radius:3px;color:#fef3c7;font-family:monospace;font-size:10px;' +
          'white-space:pre-wrap;word-break:break-all;';
        c.textContent = it.code;
        row.appendChild(c);
      }
      bn.appendChild(row);
    });
    var doc = document.createElement('div');
    doc.style.cssText = 'margin-top:6px;font-size:10px;color:#fcd34d;';
    doc.innerHTML = 'Полный гайд: <code style="background:rgba(0,0,0,0.3);padding:1px 4px;border-radius:2px;">INSTALL.md</code> · Troubleshooting: <code style="background:rgba(0,0,0,0.3);padding:1px 4px;border-radius:2px;">INSTALL.md#troubleshooting</code>';
    bn.appendChild(doc);
    /* Вставляем перед чатом, если возможно. */
    if (el.chat && el.chat.parentNode) {
      el.chat.parentNode.insertBefore(bn, el.chat);
    } else {
      document.body.insertBefore(bn, document.body.firstChild);
    }
  }

  function panelHealthCheck() {
    var issues = [];

    /* 1. fm-secrets.js → FM_SECRETS.apiKey */
    var sec = (typeof FM_SECRETS !== 'undefined') ? FM_SECRETS : null;
    var apiKey = sec && typeof sec.apiKey === 'string' ? sec.apiKey.trim() : '';
    var isDefaultKey =
      !apiKey ||
      apiKey === 'YOUR-KEY' ||
      apiKey === 'ваш-ключ-cloud-ru' ||
      apiKey.length < 8;
    if (!sec) {
      issues.push({
        title: 'fm-secrets.js не загружен',
        fix: 'Создай файл из примера и впиши API-ключ Cloud.ru:',
        code: 'cp client/shared/fm-secrets.example.js client/shared/fm-secrets.js'
      });
    } else if (isDefaultKey) {
      issues.push({
        title: 'API-ключ Cloud.ru не настроен (apiKey пустой или дефолтный)',
        fix: 'Открой client/shared/fm-secrets.js и впиши реальный ключ. Получить — на cloud.ru → Foundation Models → API keys.',
        code: 'var FM_SECRETS = { apiKey: \'тут-твой-реальный-ключ\' };'
      });
    }

    /* 2. ffmpeg через Node spawn — только если Node доступен (CEP с --enable-nodejs) */
    var hasNode = (typeof require === 'function');
    if (hasNode) {
      try {
        var cp = require('child_process');
        var isWin = (typeof process !== 'undefined' && process.platform === 'win32');
        var checkPaths = isWin
          ? [
              'C:\\ffmpeg\\bin\\ffmpeg.exe',
              'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
            ]
          : [
              '/opt/homebrew/bin/ffmpeg',
              '/usr/local/bin/ffmpeg',
              '/usr/bin/ffmpeg'
            ];
        var fs = require('fs');
        var ffmpegFound = null;
        for (var i = 0; i < checkPaths.length; i++) {
          try {
            if (fs.existsSync(checkPaths[i])) { ffmpegFound = checkPaths[i]; break; }
          } catch (eFs) {}
        }
        if (!ffmpegFound) {
          /* Попробуем через which/where (зависит от платформы) */
          try {
            var w = cp.execSync(isWin ? 'where ffmpeg' : 'which ffmpeg 2>/dev/null', { timeout: 1500, encoding: 'utf8' }).trim().split('\n')[0].trim();
            if (w) ffmpegFound = w;
          } catch (eW) {}
        }
        if (!ffmpegFound) {
          issues.push({
            title: 'ffmpeg не найден в PATH',
            fix: 'Транскрибация и audio analysis работать не будут. Установи и проверь:',
            code: isWin ? 'where ffmpeg' : 'brew install ffmpeg && which ffmpeg'
          });
        }
      } catch (eR) {
        /* Node может быть недоступен или sandboxed — не пишем ошибку. */
      }
    }

    /* 3. Premiere version через bridge (асинхронно). Issues по версии добавим после ответа. */
    var renderNow = function () { _panelHealthRender(issues); };
    try {
      if (typeof PremiereBridge !== 'undefined' && PremiereBridge.evalJson) {
        PremiereBridge.evalJson('JSON.stringify({v: app.version || ""})', function (err, data) {
          try {
            if (!err && data && typeof data.v === 'string' && data.v.length) {
              var major = parseInt(data.v.split('.')[0], 10);
              if (!isNaN(major) && major < 24) {
                issues.push({
                  title: 'Premiere Pro ' + data.v + ' — слишком старая версия',
                  fix: 'Manifest требует [24.0,99.9]. Обнови Premiere через Adobe Creative Cloud до 2024+.',
                  code: 'Help → About — должно быть 24.x, 25.x или 26.x'
                });
              }
            }
          } catch (eP) {}
          renderNow();
        });
      } else {
        renderNow();
      }
    } catch (eB) {
      renderNow();
    }
  }

  /* Запускаем после DOM-render, с задержкой чтобы bridge успел загрузить host. */
  setTimeout(panelHealthCheck, 1500);

  /* ─── Tools schemas (по пресетам) ────────────────────────────────── */

  /* Унифицированный EditPlan (§2.1): один контракт для всех правок.
     Добавляется в TOOLS_TIMECODE и TOOLS_TEXTMONTAGE как приоритетный путь.
     Старые propose_transcript_cuts / propose_timecode_edits остаются для
     обратной совместимости, но prompts.js теперь рекомендует propose_edit_plan. */
  var UNIFIED_EDIT_PLAN_TOOLS = [
    {
      type: 'function',
      'function': {
        name: 'propose_edit_plan',
        description:
          'Единый контракт для правок таймлайна. Показывает карточку подтверждения. После вызова — ЗАВЕРШИ ход. kind: ripple_delete_interval, lift_delete_interval, remove_clip, trim_in, trim_out, trim_bounds, move_clip, set_clip_enabled, shift_ripple, mute_track, note.',
        parameters: {
          type: 'object',
          properties: {
            ops: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: [
                      'ripple_delete_interval',
                      'lift_delete_interval',
                      'remove_clip',
                      'trim_in',
                      'trim_out',
                      'trim_bounds',
                      'move_clip',
                      'set_clip_enabled',
                      'shift_ripple',
                      'mute_track',
                      'note'
                    ]
                  },
                  startSec: { type: 'number' },
                  endSec: { type: 'number' },
                  timeSec: { type: 'number' },
                  nodeId: { type: 'string' },
                  newStartSec: { type: 'number' },
                  fromSec: { type: 'number' },
                  deltaSec: { type: 'number' },
                  enabled: { type: 'boolean' },
                  trackType: { type: 'string' },
                  trackIndex: { type: 'number' },
                  muted: { type: 'boolean' },
                  reason: { type: 'string', description: 'Короткое объяснение (показывается пользователю рядом с операцией).' },
                  quote: { type: 'string', description: 'Для ripple/lift — цитата 10-25 слов из транскрипта (что именно вырезаем).' },
                  note: { type: 'string' }
                },
                required: ['kind']
              }
            },
            summary: { type: 'string' },
            rationale: { type: 'string' }
          },
          required: ['ops', 'summary']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'apply_edit_plan',
        description:
          'Прямое применение EditPlan БЕЗ подтверждения. Только если пользователь сказал «делай сразу».',
        parameters: {
          type: 'object',
          properties: {
            ops: { type: 'array', items: { type: 'object' } },
            summary: { type: 'string' }
          },
          required: ['ops']
        }
      }
    }
  ];

  var TOOLS_TIMECODE = [
    {
      type: 'function',
      'function': {
        name: 'get_timeline_snapshot',
        description: 'Список клипов активной секвенции: имена, nodeId, startSec/endSec на таймлайне.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'apply_timecode_edits',
        description:
          'Правки на активной секвенции: ripple_delete_range, lift_delete_range, remove_clip, trim, move_clip, shift_timeline_ripple, set_clip_enabled, set_clips_enabled_by_name, set_playhead, mute_track, note.',
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
    },
    {
      type: 'function',
      'function': {
        name: 'propose_timecode_edits',
        description:
          'Предложить план правок таймлайна пользователю на подтверждение (НЕ выполняет правку). Покажет карточку «было/станет» с diff-полосой и кнопками «Применить / Отмена». ВСЕГДА предпочитай этот инструмент перед apply_timecode_edits, кроме случаев, когда пользователь явно сказал «без подтверждения».',
        parameters: {
          type: 'object',
          properties: {
            operations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  action: {
                    type: 'string',
                    description: 'Тип операции',
                    enum: [
                      'ripple_delete_range',
                      'ripple_delete_range_all_tracks',
                      'lift_delete_range',
                      'remove_clip',
                      'set_timeline_in',
                      'set_timeline_out',
                      'set_timeline_bounds',
                      'move_clip',
                      'set_clip_enabled',
                      'set_clips_enabled_by_name',
                      'note'
                    ]
                  },
                  nodeId: { type: 'string', description: 'ID клипа из get_timeline_snapshot' },
                  startSec: { type: 'number', description: 'Начало интервала (для ripple/lift/bounds)' },
                  endSec: { type: 'number', description: 'Конец интервала (для ripple/lift/bounds)' },
                  timeSec: { type: 'number', description: 'Новое время (для set_timeline_in/out)' },
                  newStartSec: { type: 'number', description: 'Новая позиция (для move_clip)' },
                  enabled: { type: 'boolean', description: 'Вкл/выкл (для set_clip_enabled)' },
                  clipName: { type: 'string', description: 'Имя клипа (для set_clips_enabled_by_name)' }
                },
                required: ['action']
              }
            },
            summary: { type: 'string', description: 'Краткое описание плана правок' }
          },
          required: ['operations', 'summary']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'dry_run_edit_plan',
        description:
          'Симулирует план правок на текущем снимке БЕЗ обращения к Premiere. Принимает либо унифицированный формат {ops:[...]}, либо legacy {operations:[...]}. Возвращает предсказанное состояние клипов (что удалится, что обрежется, итоговая длительность). Используй перед propose_edit_plan / propose_timecode_edits.',
        parameters: {
          type: 'object',
          properties: {
            ops: { type: 'array', items: { type: 'object' } },
            operations: { type: 'array', items: { type: 'object' } }
          }
        }
      }
    }
  ];

  var TOOLS_TEXTMONTAGE = [
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
        description:
          'Получить сохранённый транскрипт по ключу (имя секвенции). Сегменты с startSec/endSec/text. Для обзора материала используй get_transcript_structure.',
        parameters: {
          type: 'object',
          properties: { sequenceKey: { type: 'string' } },
          required: ['sequenceKey']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'get_transcript_structure',
        description:
          'Структурное представление транскрипта: paragraphs (с полным текстом), topics, speakers, silences. ' +
          'Для коротких видео (<80 абзацев) отдаёт всё сразу. Для длинных — используй fromParagraph/toParagraph для постраничного доступа.',
        parameters: {
          type: 'object',
          properties: {
            sequenceKey: { type: 'string' },
            fromParagraph: { type: 'number', description: 'Начальный индекс абзаца (включительно). По умолчанию 0.' },
            toParagraph: { type: 'number', description: 'Конечный индекс абзаца (не включительно). По умолчанию — все.' }
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
          'Предложить план вырезания интервалов пользователю на подтверждение (НЕ выполняет правку). Покажет карточку «Применить / Отмена». Передавай keepSummary и removeSummary с цитатами. ДЛЯ СБОРОЧНОГО МОНТАЖА («собери ролик про X», «сделай выжимку»): используй keepIntervals — список того, что ОСТАВИТЬ. Плагин сам вычислит removeIntervals как дополнение. keepIntervals и removeIntervals взаимоисключают друг друга.',
        parameters: {
          type: 'object',
          properties: {
            removeIntervals: {
              type: 'array',
              description: 'Интервалы для удаления. Используй для обычной чистки («убери паузы»).',
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
            keepIntervals: {
              type: 'array',
              description: 'Интервалы, которые ОСТАВИТЬ (сборочный монтаж). Плагин вычислит removeIntervals автоматически как дополнение к этим интервалам. Границы выровняются по сегментам транскрипта. Не передавай вместе с removeIntervals.',
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
            sequenceKey: { type: 'string', description: 'Имя секвенции. Нужно для keepIntervals-инверсии (чтобы знать границы транскрипта).' },
            paddingSec: {
              type: 'number',
              description: 'Дыхание в секундах вокруг каждого removeInterval (по умолчанию 0.3). Каждый интервал ужимается на padding с обеих сторон, чтобы оставить запас перед/после фразы — речь не будет звучать обрезанной. 0 = резать впритык. Применяется ДО привязки к границам сегментов. Хорошие значения: 0.2 для агрессивного монтажа, 0.3 default, 0.5 для медитативной речи.'
            },
            keepSummary: {
              type: 'array',
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
            targetDurationSec: {
              type: 'number',
              description: 'ОБЯЗАТЕЛЬНО при запросе вида «уложи в N секунд», «сделай N-секундную версию», «сократи до N сек». Целевой хронометраж результата. Плагин ПРОВЕРИТ что сумма keepIntervals ≤ target * 1.20 и вернёт ошибку с подсказкой если LLM выбрал лишнего. Без этого поля проверки нет — будь честен и передавай.'
            },
            summary: { type: 'string' }
          },
          required: ['summary']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'apply_transcript_cuts',
        description:
          'Вырезать интервалы времени на таймлайне. Все дорожки. ВНИМАНИЕ: используй только если пользователь явно попросил «без подтверждения», иначе используй propose_transcript_cuts.',
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
        description: 'Те же операции, что в пресете «Таймкоды».',
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
    },
    {
      type: 'function',
      'function': {
        name: 'find_moments',
        description:
          'Семантический поиск моментов в транскрипте по запросу. Возвращает топ-K параграфов или сегментов с интервалами времени и оценкой совпадения. Используй вместо чтения всего транскрипта, если ищешь конкретное место.',
        parameters: {
          type: 'object',
          properties: {
            sequenceKey: { type: 'string', description: 'Имя секвенции (ключ кэша).' },
            query: { type: 'string', description: 'Запрос на естественном языке. Сначала literal-поиск по словоформам (стратегия → стратегии/стратегиям), потом TF-IDF fallback.' },
            k: { type: 'number', description: 'Сколько результатов вернуть (по умолчанию 20). Возвращаются ВСЕ literal-совпадения до этого лимита.' }
          },
          required: ['sequenceKey', 'query']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'analyze_transcript_for_cuts',
        description:
          'Анализ транскрипта: локальные детекторы + LLM. Классифицирует сегменты (content/filler/intro/outro/outtake/repeat/artifact/digression). Возвращает removeIntervals. Кэш 30 мин. Параметр aggressiveness регулирует, насколько много попадает в toRemove (по умолчанию normal).',
        parameters: {
          type: 'object',
          properties: {
            sequenceKey: { type: 'string', description: 'Имя секвенции (ключ кэша).' },
            tasks: {
              type: 'array',
              items: { type: 'string', enum: ['filler', 'intro', 'outro', 'outtake', 'repeat', 'artifact', 'digression'] },
              description: 'Какие категории искать. По умолчанию все. Примеры: ["filler","intro"] для «убери паразиты и вступление»; ["outtake","repeat"] для «убери оговорки и повторы».'
            },
            aggressiveness: {
              type: 'string',
              enum: ['gentle', 'normal', 'aggressive'],
              description: 'Агрессивность роутинга меток в toRemove. gentle: только filler+artifact режем; intro/outro/outtake/repeat/digression остаются в toKeep. normal (по умолчанию): filler+artifact+intro+outro+outtake+repeat режем, digression остаётся. aggressive: всё не-content режем (включая digression — для «убери всю воду»).'
            },
            forceRefresh: { type: 'boolean', description: 'true — игнорировать кэш и запустить анализ заново.' }
          },
          required: ['sequenceKey']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'propose_audio_ducking',
        description:
          'Рассчитать ducking для МУЗЫКАЛЬНОГО клипа на основе речевых параграфов и предложить РЕАЛЬНЫЙ рендер через ffmpeg. По «Применить» в карточке плагин рендерит новый WAV (музыка с приглушением на интервалах речи) и импортирует его в проект Premiere в bin "AI Renders". targetNodeId — nodeId музыкального клипа из get_timeline_snapshot (обычно на дорожке A2/A3, не A1).',
        parameters: {
          type: 'object',
          properties: {
            sequenceKey: { type: 'string' },
            targetNodeId: { type: 'string', description: 'nodeId музыкального клипа из снимка (audio-клип на A2/A3 с длинным mediaPath).' },
            duckDb: { type: 'number', description: 'Глубина приглушения в дБ (по умолчанию -12).' },
            fadeInSec: { type: 'number', description: 'Длительность fade-in перед речью (по умолчанию 0.15).' },
            fadeOutSec: { type: 'number', description: 'Длительность fade-out после речи (по умолчанию 0.3).' }
          },
          required: ['sequenceKey', 'targetNodeId']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'propose_loudness_normalization',
        description:
          'Нормализация громкости РЕЧЕВОГО клипа под целевой LUFS через ffmpeg loudnorm. По «Применить» рендерит новый WAV и импортирует в проект. targetNodeId — речевой клип (обычно на A1).',
        parameters: {
          type: 'object',
          properties: {
            sequenceKey: { type: 'string' },
            targetNodeId: { type: 'string', description: 'nodeId речевого клипа из снимка (обычно A1).' },
            targetLufs: { type: 'number', description: 'Целевой LUFS (по умолчанию -16 для YouTube).' }
          },
          required: ['sequenceKey', 'targetNodeId']
        }
      }
    }
  ];

  var TOOLS_MARKERS = [
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
        description: 'Транскрипт из кэша по имени секвенции.',
        parameters: {
          type: 'object',
          properties: { sequenceKey: { type: 'string' } },
          required: ['sequenceKey']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'get_transcript_structure',
        description: 'Структурное представление транскрипта с пагинацией (fromParagraph/toParagraph).',
        parameters: {
          type: 'object',
          properties: {
            sequenceKey: { type: 'string' },
            fromParagraph: { type: 'number' },
            toParagraph: { type: 'number' }
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
          'Создать маркеры на активной секвенции. Маркер может быть точечным (только timeSec) или span (timeSec+endSec).',
        parameters: {
          type: 'object',
          properties: {
            markers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  timeSec: { type: 'number' },
                  endSec: { type: 'number' },
                  name: { type: 'string' },
                  comment: { type: 'string' },
                  type: { type: 'string' }
                },
                required: ['timeSec', 'name']
              }
            },
            summary: { type: 'string' }
          },
          required: ['markers']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'propose_markers',
        description:
          'Предложить набор маркеров пользователю на подтверждение (НЕ создаёт). Покажет карточку с превью маркеров на полосе таймлайна и кнопками «Применить / Отмена». ВСЕГДА предпочитай этот инструмент перед add_markers, если не сказано «без подтверждения».',
        parameters: {
          type: 'object',
          properties: {
            markers: { type: 'array', items: { type: 'object' } },
            summary: { type: 'string' }
          },
          required: ['markers', 'summary']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'find_moments',
        description:
          'Семантический поиск моментов в транскрипте по запросу. Возвращает топ-K параграфов с временными интервалами. Удобно для расстановки маркеров на конкретные темы.',
        parameters: {
          type: 'object',
          properties: {
            sequenceKey: { type: 'string' },
            query: { type: 'string' },
            k: { type: 'number' }
          },
          required: ['sequenceKey', 'query']
        }
      }
    }
  ];

  /* §2.1: пробрасываем унифицированный EditPlan в timecode и textmontage */
  TOOLS_TIMECODE = TOOLS_TIMECODE.concat(UNIFIED_EDIT_PLAN_TOOLS);
  TOOLS_TEXTMONTAGE = TOOLS_TEXTMONTAGE.concat(UNIFIED_EDIT_PLAN_TOOLS);

  /* ═══ Единый набор инструментов: дедупликация по имени ═══ */
  var TOOLS_UNIFIED = (function () {
    var all = [].concat(TOOLS_TEXTMONTAGE, TOOLS_MARKERS, TOOLS_TIMECODE, UNIFIED_EDIT_PLAN_TOOLS);
    var seen = {};
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var nm = all[i] && all[i]['function'] && all[i]['function'].name;
      if (nm && !seen[nm]) { seen[nm] = 1; out.push(all[i]); }
    }
    return out;
  })();

  /* ─── Executors (общие функции) ──────────────────────────────────── */

  function execGetSnapshot(argsOrBool) {
    /* Snapshot caching: если snapshot не dirty и мы его уже получали — возвращаем кэш.
       argsOrBool: boolean (прямой вызов) или object (от агента — {forceRefresh?}).
       forceRefresh=true обходит кэш (после apply-операций). */
    var forceRefresh = argsOrBool === true || (argsOrBool && argsOrBool.forceRefresh === true);
    if (!forceRefresh && !_snapDirty && lastSnap && lastSnap.ok) {
      if (typeof statusUi !== 'undefined') statusUi.show('Snapshot: из кэша', true);
      return Promise.resolve(lastSnap);
    }
    if (typeof statusUi !== 'undefined') statusUi.show('Получение снимка таймлайна…', true);
    return new Promise(function (resolve, reject) {
      PremiereBridge.getTimelineSnapshot(function (err, data) {
        if (err) reject(err);
        else {
          lastSnap = data;
          _snapDirty = false;
          resolve(data);
        }
      });
    });
  }

  /* LLM часто передаёт sequenceKey с лишними артефактами из auto-snapshot:
     "seq=MySeq", "«MySeq»", "seq=My Seq dur=10s" и т.п. Нормализуем.
     ВАЖНО: имя секвенции МОЖЕТ содержать пробелы! Нельзя резать по пробелу. */
  function _cleanSeqKey(raw) {
    var s = String(raw || '').trim();
    s = s.replace(/^seq\s*=\s*/i, '');      /* seq=My Seq → My Seq */
    s = s.replace(/[«»""]/g, '');           /* убрать кавычки */
    /* Убрать известные суффиксы из auto-snapshot, НЕ трогая пробелы в имени */
    s = s.replace(/\s+dur\s*=\s*[\d.]+s?.*$/i, '');   /* " dur=130.5s" */
    s = s.replace(/\s+clips\s*=\s*\d+.*$/i, '');       /* " clips=5" */
    s = s.replace(/\s+in\s*=\s*[\d.]+.*$/i, '');       /* " in=0.0" */
    s = s.replace(/\s+out\s*=\s*[\d.]+.*$/i, '');      /* " out=130.5" */
    return s.trim();
  }

  function execGetTranscriptFromCache(args) {
    var key = _cleanSeqKey(args.sequenceKey);
    var found = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key);
    if (!found.entry) {
      var keys = ContextStore.listTranscriptCacheKeys(TRANSCRIPT_PID);
      return Promise.resolve({
        error:
          'Нет кэша для «' + key + '». Проверьте имя секвенции. Кэш общий: ~/.extensions_llm_chat_pr/_llm_transcript_cache.json.',
        requestedKey: key,
        availableKeysInCache: keys.slice(0, 32)
      });
    }
    var out = {};
    for (var kk in found.entry) {
      if (Object.prototype.hasOwnProperty.call(found.entry, kk)) out[kk] = found.entry[kk];
    }
    if (out.editedAfterTranscribe) {
      out._notice =
        'Транскрипт автоматически сдвинут по применённым ripple-удалениям — тайминги соответствуют ТЕКУЩЕМУ таймлайну. ' +
        (out.possiblyStale
          ? 'Внимание: были также неизвестные сдвиги — сверяйся с get_timeline_snapshot.'
          : 'Можно работать как с актуальным.');
    }
    return Promise.resolve(out);
  }

  /* ─── Бюджет символов для get_transcript_structure ─── */
  var TRANSCRIPT_TEXT_BUDGET = 12000; /* символов — если суммарный текст меньше, отдаём полностью */
  var TRANSCRIPT_PAGE_SIZE  = 60;    /* абзацев на страницу по умолчанию */

  function execGetTranscriptStructure(args) {
    var key2 = _cleanSeqKey(args.sequenceKey);
    var found2 = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key2);
    if (!found2.entry) {
      var keys2 = ContextStore.listTranscriptCacheKeys(TRANSCRIPT_PID);
      return Promise.resolve({
        error: 'Нет кэша для «' + key2 + '». Сначала транскрибируйте In–Out.',
        requestedKey: key2,
        availableKeysInCache: keys2.slice(0, 32)
      });
    }
    var e = found2.entry;
    /* HIGH (6 мая 2026): Пересборка paragraphs если их нет ИЛИ они протухли
       (segIdxs указывают на удалённые сегменты или timestamps разъехались
       с segments после applyTranscriptCuts). Без этого LLM получает абзацы
       с неверным временем → ножи режут не там. */
    if (typeof TranscriptStructure !== 'undefined') {
      var needsRebuildGS = !e.paragraphs || !e.paragraphs.length ||
        (TranscriptStructure.isParagraphsStale && TranscriptStructure.isParagraphsStale(e));
      if (needsRebuildGS) {
        try {
          TranscriptStructure.buildStructure(e);
          ContextStore.setTranscriptEntry(TRANSCRIPT_PID, found2.matchedKey, e);
        } catch (eRB) {}
      }
    }

    var allParagraphs = (e.paragraphs || []);
    var totalCount = allParagraphs.length;

    /* Считаем суммарный размер текста */
    var totalChars = 0;
    for (var ti = 0; ti < allParagraphs.length; ti++) {
      totalChars += String(allParagraphs[ti].text || '').length;
    }
    var fitsInBudget = totalChars <= TRANSCRIPT_TEXT_BUDGET;

    /* Пагинация: если указаны fromParagraph/toParagraph — уважаем их.
       Если не указаны и текст не влезает в бюджет — отдаём первую страницу + подсказку. */
    var from = typeof args.fromParagraph === 'number' ? Math.max(0, Math.floor(args.fromParagraph)) : 0;
    var to;
    if (typeof args.toParagraph === 'number') {
      to = Math.min(totalCount, Math.floor(args.toParagraph));
    } else if (fitsInBudget) {
      to = totalCount;
    } else {
      to = Math.min(totalCount, from + TRANSCRIPT_PAGE_SIZE);
    }

    var sliced = allParagraphs.slice(from, to);
    var paragraphsCompact = sliced.map(function (p, idx) {
      var globalIdx = from + idx;
      /* Если весь текст влезает или это запрошенная страница — полный текст.
         Иначе (авто-первая страница длинного транскрипта) — тоже полный, но ограниченная порция. */
      return {
        i: globalIdx,
        startSec: p.startSec,
        endSec: p.endSec,
        durationSec: Math.round((p.endSec - p.startSec) * 100) / 100,
        pauseBeforeSec: p.pauseBeforeSec,
        pauseAfterSec: p.pauseAfterSec,
        text: String(p.text || '')
      };
    });

    var silencesCompact = ((e.audioAnalysis && e.audioAnalysis.silences) || []).slice(0, 200);
    var out2 = {
      sequenceKey: found2.matchedKey,
      totalParagraphs: totalCount,
      totalTextChars: totalChars,
      returnedRange: { from: from, to: to },
      hasMore: to < totalCount,
      paragraphCount: paragraphsCompact.length,
      paragraphs: paragraphsCompact,
      topics: e.topics || null,
      speakers: e.speakers || null,
      silences: silencesCompact,
      silenceCount: silencesCompact.length,
      loudness: e.audioAnalysis && e.audioAnalysis.loudness ? e.audioAnalysis.loudness : null,
      editedAfterTranscribe: !!e.editedAfterTranscribe,
      possiblyStale: !!e.possiblyStale,
      structureMeta: e.structureMeta || null
    };
    if (out2.hasMore) {
      out2._pagination = 'Показано ' + from + '–' + to + ' из ' + totalCount + ' абзацев. ' +
        'Для следующей страницы: get_transcript_structure(sequenceKey, fromParagraph=' + to + '). ' +
        'Для полного анализа длинного транскрипта используй analyze_transcript_for_cuts.';
    }
    if (out2.editedAfterTranscribe) {
      out2._notice = 'Структура пересчитана под текущее состояние таймлайна.';
    }
    return Promise.resolve(out2);
  }

  function execApplyTimecodeEdits(panelId, args) {
    /* Safety-guard: без явного «без подтверждения» — показываем карточку. */
    if (!_directApplyAuthorized) {
      return Promise.resolve(execProposeTimecodeEdits(args)).then(function (r) {
        return Object.assign({ _redirectedToPropose: true,
          message: 'Прямое применение без подтверждения запрещено. Показал карточку propose_timecode_edits — пользователь нажмёт «Применить». Заверши ход.' },
          (r && typeof r === 'object') ? r : {});
      });
    }
    /* Нормализуем: kind → action */
    if (args && Array.isArray(args.operations)) {
      args.operations = args.operations.map(function (op) {
        if (!op.action && op.kind) {
          op = Object.assign({}, op);
          op.action = op.kind;
        }
        return op;
      });
    }
    return new Promise(function (resolve, reject) {
      var v = ToolValidators.validateTimecodePlan(lastSnap, args);
      if (v) {
        resolve({
          validationError: v,
          hint: 'Сделайте get_timeline_snapshot и исправьте nodeId или интервал.'
        });
        return;
      }
      _snapDirty = true; /* Мутирующая операция — сбрасываем кэш snapshot */
      PremiereBridge.applyTimecodeEdits(args, function (err, data) {
        if (err) {
          reject(err);
          return;
        }
        /* Откат таймкодов средствами плагина не реализован — Cmd+Z в таймлайне Premiere вручную. */
        _snapDirty = true;
        PremiereBridge.getTimelineSnapshot(function (snapErr, snapData) {
          if (!snapErr && snapData && snapData.ok) { lastSnap = snapData; _snapDirty = false; }
          data._autoSnapshot = snapData || null;
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
                  op.action === 'remove_clip'
                ) {
                  hasUnknownShift = true;
                }
              });
              if (rippleIvs.length) {
                ContextStore.applyRippleDeletionsToTranscript(TRANSCRIPT_PID, seqKey, rippleIvs);
                data._transcriptShifted = true;
              }
              if (hasUnknownShift) {
                ContextStore.markTranscriptStale(
                  TRANSCRIPT_PID,
                  seqKey,
                  'apply_timecode_edits: ' +
                    args.operations
                      .map(function (o) {
                        return o.action;
                      })
                      .join(',')
                );
                data._transcriptPossiblyStale = true;
              }
            }
          } catch (eSh3) {}
          resolve(data);
        });
      });
    });
  }

  function execAddMarkers(panelId, args) {
    return new Promise(function (resolve, reject) {
      var list = args.markers || [];
      var v = ToolValidators.validateMarkersList(lastSnap, list);
      if (v) {
        resolve({ validationError: v, hint: 'Обновите снимок или поправьте timeSec.' });
        return;
      }
      PremiereBridge.addSequenceMarkers(list, function (err, data) {
        if (err) {
          reject(err);
          return;
        }
        if (data && data.createdSeconds && data.createdSeconds.length) {
          var seqNm = lastSnap && lastSnap.sequenceName ? lastSnap.sequenceName : '';
          ContextStore.setLastUndo(panelId, data.createdSeconds.length, 'маркеры', seqNm, {
            mode: 'markers',
            markerSeconds: data.createdSeconds
          });
          refreshUndoButton();
        }
        resolve(data);
      });
    });
  }

  /* ─── Verification + propose/apply (textmontage) ─────────────────── */

  function fmtSec(s) {
    if (typeof s !== 'number' || isNaN(s)) return '?';
    var sign = s < 0 ? '-' : '';
    s = Math.abs(s);
    var m = Math.floor(s / 60);
    var ss = s - m * 60;
    return sign + m + ':' + (ss < 10 ? '0' : '') + ss.toFixed(1);
  }

  /**
   * Привязка границ removeIntervals к ближайшим границам сегментов транскрипта.
   * Предотвращает обрезку слов на полуслове: startSec привязывается к ближайшему
   * segment.startSec/endSec, endSec — аналогично, с приоритетом на ближайший endSec.
   */
  /**
   * «Дыхание» вокруг семантических резов: ужимает каждый removeInterval
   * на padding с обеих сторон. Если интервал становится слишком коротким
   * (< 0.05с) — отбрасывается.
   *
   * Заимствовано из openshorts (main.py): «start 0.2–0.4s ДО hook, end 0.2–0.4s ПОСЛЕ payoff».
   * Применяется ДО snapIntervalsToSegmentBoundaries.
   */
  function _padRemoveIntervals(removeIntervals, paddingSec) {
    if (!Array.isArray(removeIntervals) || !removeIntervals.length) return removeIntervals;
    if (!paddingSec || paddingSec <= 0) return removeIntervals;
    var MIN_DURATION = 0.05;
    var out = [];
    for (var i = 0; i < removeIntervals.length; i++) {
      var iv = removeIntervals[i];
      if (typeof iv.startSec !== 'number' || typeof iv.endSec !== 'number') continue;
      var s = iv.startSec + paddingSec;
      var e = iv.endSec - paddingSec;
      if (e - s < MIN_DURATION) continue; /* интервал короче 2*padding — пропустить полностью */
      out.push({ startSec: s, endSec: e, reason: iv.reason });
    }
    return out;
  }

  /**
   * Форматирует маркеры-главы в YouTube-описание.
   * Делегирует в YouTubeExport (../shared/youtube-export.js) — чистая функция,
   * покрытая unit-тестами в tests/youtube-export.test.mjs.
   * Локальный fallback нужен если глобал не загрузился (бутстрап-баг).
   */
  function _formatChaptersForYouTube(markers) {
    if (typeof YouTubeExport !== 'undefined' && YouTubeExport.formatChaptersForYouTube) {
      return YouTubeExport.formatChaptersForYouTube(markers);
    }
    /* Минимальный fallback. */
    if (!Array.isArray(markers) || !markers.length) return '';
    return markers.map(function (m) {
      var t = Math.max(0, Math.floor(m.timeSec || 0));
      var mm = Math.floor(t / 60), ss = t % 60;
      var pad = function (n) { return n < 10 ? '0' + n : String(n); };
      return mm + ':' + pad(ss) + ' ' + (m.name || 'Глава');
    }).join('\n');
  }

  /**
   * Fallback-копирование через временный textarea (CEP < Chromium 92).
   */
  function _fallbackCopy(text, statusEl) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-100px;left:-100px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (statusEl) statusEl.textContent = ok ? 'Скопировано' : 'Ошибка копирования';
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Ошибка: ' + (e.message || e);
    }
  }

  function snapIntervalsToSegmentBoundaries(removeIntervals) {
    if (!removeIntervals || !removeIntervals.length) return removeIntervals;
    /* Собираем сегменты + paragraphs из transcript кэша */
    var segments = null;
    var paragraphs = null;
    try {
      var seqKey = lastSnap && lastSnap.sequenceName ? lastSnap.sequenceName : '';
      if (seqKey) {
        var found = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, seqKey);
        if (found && found.entry) {
          if (found.entry.segments) segments = found.entry.segments;
          if (found.entry.paragraphs) paragraphs = found.entry.paragraphs;
        }
      }
    } catch (e) {
      console.warn('[panel] snapIntervals: cache read failed:', e && e.message);
    }
    if (!segments || !segments.length) return removeIntervals;

    /* HIGH (6 мая 2026): два уровня boundaries.
       Paragraph boundaries — НАСТОЯЩИЕ паузы между мыслями (>0.5с тишины).
       Segment boundaries — Whisper-utterances (3-30с), могут оказаться внутри
       продолжительной фразы. Сначала пытаемся snap к paragraph (большой drift),
       если не получилось — snap к segment (короткий drift). */
    var paragraphBoundaries = [];
    if (paragraphs && paragraphs.length) {
      for (var pi = 0; pi < paragraphs.length; pi++) {
        var pa = paragraphs[pi];
        if (typeof pa.startSec === 'number') paragraphBoundaries.push(pa.startSec);
        if (typeof pa.endSec === 'number') paragraphBoundaries.push(pa.endSec);
      }
      paragraphBoundaries.sort(function (a, b) { return a - b; });
    }

    var segmentBoundaries = [];
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (typeof seg.startSec === 'number') segmentBoundaries.push(seg.startSec);
      else if (typeof seg.start === 'number') segmentBoundaries.push(seg.start);
      if (typeof seg.endSec === 'number') segmentBoundaries.push(seg.endSec);
      else if (typeof seg.end === 'number') segmentBoundaries.push(seg.end);
    }
    segmentBoundaries.sort(function (a, b) { return a - b; });

    function snapTo(val, boundaries, maxDrift) {
      var best = val;
      var bestD = maxDrift + 1;
      for (var j = 0; j < boundaries.length; j++) {
        var d = Math.abs(boundaries[j] - val);
        if (d < bestD) { bestD = d; best = boundaries[j]; }
        if (boundaries[j] > val + maxDrift) break;
      }
      return bestD <= maxDrift ? best : null;
    }

    /* paragraph drift до 1.5с — паузы реальные, разрешаем больший сдвиг.
       segment drift 0.5с — fallback, не уезжаем глубоко в фразу. */
    var PARA_DRIFT = 1.5;
    var SEG_DRIFT = 0.5;
    return removeIntervals.map(function (iv) {
      var s = paragraphBoundaries.length ? snapTo(iv.startSec, paragraphBoundaries, PARA_DRIFT) : null;
      if (s === null) s = snapTo(iv.startSec, segmentBoundaries, SEG_DRIFT);
      if (s === null) s = iv.startSec;

      var e = paragraphBoundaries.length ? snapTo(iv.endSec, paragraphBoundaries, PARA_DRIFT) : null;
      if (e === null) e = snapTo(iv.endSec, segmentBoundaries, SEG_DRIFT);
      if (e === null) e = iv.endSec;

      if (e <= s) { e = iv.endSec; s = iv.startSec; } /* откат если snap сломал */
      return { startSec: s, endSec: e, reason: iv.reason };
    });
  }

  /**
   * P1-2 (10 июня 2026): merge перекрывающихся removeIntervals.
   * Host (premiere.jsx:1590) применяет интервалы справа-налево БЕЗ merge —
   * перекрытие приводит к двойному вырезанию уже сдвинутого материала и
   * расхождению с transcript-кэшем (ContextStore merge'ит перекрытия).
   * Snap к границам сегментов сам может СОЗДАТЬ перекрытия из соседних
   * интервалов, поэтому merge обязателен ПОСЛЕ snap'а.
   * Epsilon 0.05с — как в DeterministicPipelines._mergeIntervals.
   */
  function mergeRemoveIntervals(intervals) {
    if (!intervals || intervals.length < 2) return intervals;
    var sorted = intervals.slice().sort(function (a, b) { return a.startSec - b.startSec; });
    var EPS = 0.05;
    var out = [sorted[0]];
    for (var i = 1; i < sorted.length; i++) {
      var cur = sorted[i];
      var last = out[out.length - 1];
      if (cur.startSec <= last.endSec + EPS) {
        var reason = last.reason || '';
        if (cur.reason && cur.reason !== last.reason) {
          reason = reason ? reason + '; ' + cur.reason : cur.reason;
        }
        out[out.length - 1] = {
          startSec: last.startSec,
          endSec: Math.max(last.endSec, cur.endSec),
          reason: reason
        };
      } else {
        out.push(cur);
      }
    }
    return out;
  }

  function computeVerification(removeList) {
    /* sequenceEndSec может быть 0 — вычисляем реальную длительность из клипов */
    var seqEnd = lastSnap && lastSnap.sequenceEndSec ? lastSnap.sequenceEndSec : 0;
    if (!seqEnd && lastSnap && lastSnap.clips) {
      lastSnap.clips.forEach(function (c) { if (c.endSec > seqEnd) seqEnd = c.endSec; });
    }
    /* 19.06.2026: клампим removeIntervals к [0, seqEnd]. Если транскрипт длиннее
       секвенции (рассинхрон после правок/повторной транскрибации), интервалы за
       концом секвенции раздували keep → «Останется 60:04 из 55:02 (109%)».
       Зазоры за пределами секвенции — не реальный контент. */
    var removes = (removeList || []).slice()
      .map(function (iv) {
        var s = Math.max(0, iv.startSec);
        var e = seqEnd > 0 ? Math.min(iv.endSec, seqEnd) : iv.endSec;
        return { startSec: s, endSec: e };
      })
      .filter(function (iv) { return iv.endSec > iv.startSec + 0.01; })
      .sort(function (a, b) {
        return a.startSec - b.startSec;
      });
    var totalRemoveSec = 0;
    removes.forEach(function (iv) {
      totalRemoveSec += iv.endSec - iv.startSec;
    });
    var keepIntervals = [];
    var cursor = 0;
    removes.forEach(function (iv) {
      if (iv.startSec > cursor + 0.05) {
        keepIntervals.push({
          startSec: Math.round(cursor * 100) / 100,
          endSec: Math.round(iv.startSec * 100) / 100
        });
      }
      cursor = Math.max(cursor, iv.endSec);
    });
    if (seqEnd > 0 && cursor < seqEnd - 0.05) {
      keepIntervals.push({
        startSec: Math.round(cursor * 100) / 100,
        endSec: Math.round(seqEnd * 100) / 100
      });
    }
    var totalKeepSec = 0;
    keepIntervals.forEach(function (iv) {
      totalKeepSec += iv.endSec - iv.startSec;
    });
    return {
      removeCount: removes.length,
      totalRemoveSec: Math.round(totalRemoveSec * 100) / 100,
      keepIntervals: keepIntervals,
      keepCount: keepIntervals.length,
      totalKeepSec: Math.round(totalKeepSec * 100) / 100,
      originalDurationSec: seqEnd > 0 ? Math.round(seqEnd * 100) / 100 : null
    };
  }

  /* ─── Diff-полоса (общий рендер для timecode и transcript_cuts) ──── */

  function renderTimelineStrip(clips, opt) {
    opt = opt || {};
    var totalSec = opt.totalSec || 0;
    if (!totalSec) {
      clips.forEach(function (c) {
        if (c.endSec > totalSec) totalSec = c.endSec;
      });
    }
    if (totalSec <= 0) totalSec = 1;
    var wrap = document.createElement('div');
    wrap.className = 'diff-strip';
    wrap.style.cssText =
      'position:relative;height:18px;background:#1a1a1a;border:1px solid #333;border-radius:3px;margin:2px 0;overflow:hidden;';
    clips.forEach(function (c) {
      var rect = document.createElement('div');
      var left = (c.startSec / totalSec) * 100;
      var width = ((c.endSec - c.startSec) / totalSec) * 100;
      var bg = '#3a6';
      if (c._removed) bg = '#a33';
      else if (c._trimmed) bg = '#c80';
      else if (c._moved) bg = '#06a';
      else if (c.disabled) bg = '#444';
      rect.style.cssText =
        'position:absolute;top:1px;bottom:1px;left:' + left + '%;width:' + Math.max(0.5, width) + '%;' +
        'background:' + bg + ';border-radius:1px;';
      rect.title = (c.name || c.nodeId || '') + ' [' + c.startSec.toFixed(2) + '–' + c.endSec.toFixed(2) + ']';
      wrap.appendChild(rect);
    });
    /* красные полосы для removeIntervals */
    if (opt.removeIntervals) {
      opt.removeIntervals.forEach(function (iv) {
        var bar = document.createElement('div');
        var left = (iv.startSec / totalSec) * 100;
        var width = ((iv.endSec - iv.startSec) / totalSec) * 100;
        bar.style.cssText =
          'position:absolute;top:0;bottom:0;left:' + left + '%;width:' + Math.max(0.5, width) + '%;' +
          'background:rgba(244,63,94,0.5);border-left:1px solid #f43f5e;border-right:1px solid #f43f5e;';
        bar.title = '✗ remove ' + iv.startSec.toFixed(1) + '–' + iv.endSec.toFixed(1);
        wrap.appendChild(bar);
      });
    }
    /* жёлтые точки маркеров */
    if (opt.markers) {
      opt.markers.forEach(function (m) {
        var dot = document.createElement('div');
        var left = (m.timeSec / totalSec) * 100;
        dot.style.cssText =
          'position:absolute;top:0;bottom:0;left:' + left + '%;width:2px;background:#fbbf24;';
        dot.title = m.name + ' @ ' + m.timeSec.toFixed(2);
        wrap.appendChild(dot);
      });
    }
    return wrap;
  }

  function renderDiffSection(card, snapshot, simulation) {
    if (!snapshot || !snapshot.clips) return;
    var totalSec = snapshot.sequenceEndSec || 0;
    snapshot.clips.forEach(function (c) {
      if (c.endSec > totalSec) totalSec = c.endSec;
    });
    if (simulation && simulation.clips) {
      simulation.clips.forEach(function (c) {
        if (c.endSec > totalSec) totalSec = c.endSec;
      });
    }

    var labelB = document.createElement('div');
    labelB.style.cssText = 'font-size:10px;color:#888;margin-top:6px;';
    labelB.textContent = 'было — ' + snapshot.clips.length + ' клип(ов), ' + fmtSec(totalSec);
    card.appendChild(labelB);
    card.appendChild(renderTimelineStrip(snapshot.clips.slice(), { totalSec: totalSec }));

    if (simulation && simulation.clips) {
      var removedSet = {};
      (simulation.removed || []).forEach(function (id) { removedSet[id] = 1; });
      var trimmedSet = {};
      (simulation.trimmed || []).forEach(function (id) { trimmedSet[id] = 1; });
      var movedSet = {};
      (simulation.moved || []).forEach(function (id) { movedSet[id] = 1; });
      var afterClips = simulation.clips.map(function (c) {
        return {
          nodeId: c.nodeId,
          name: c.name,
          startSec: c.startSec,
          endSec: c.endSec,
          disabled: c.disabled,
          _trimmed: !!trimmedSet[String(c.nodeId)],
          _moved: !!movedSet[String(c.nodeId)]
        };
      });
      var labelA = document.createElement('div');
      labelA.style.cssText = 'font-size:10px;color:#888;margin-top:4px;';
      var s = simulation.summary || {};
      /* Live-находка 11 июня 2026: s.durationAfterSec — это СУММА длительностей
         клипов по всем дорожкам (на 8-дорожечной секвенции карточка показывала
         «было 9:58 → станет 57:14»). Для «станет» считаем длину таймлайна —
         max endSec включённых клипов, в тех же единицах, что и «было». */
      var beforeEndSec = snapshot.sequenceEndSec || 0;
      snapshot.clips.forEach(function (c) {
        if (c.endSec > beforeEndSec) beforeEndSec = c.endSec;
      });
      var afterEndSec = 0;
      simulation.clips.forEach(function (c) {
        if (!c.disabled && c.endSec > afterEndSec) afterEndSec = c.endSec;
      });
      var deltaTimeline = Math.round((afterEndSec - beforeEndSec) * 100) / 100;
      labelA.textContent =
        'станет — ' + s.clipsAfter + ' клип(ов), ' + fmtSec(afterEndSec) +
        ' (Δ ' + (deltaTimeline >= 0 ? '+' : '') + deltaTimeline + 'с) · ' +
        'remove ' + s.removedCount + ' · trim ' + s.trimmedCount + ' · move ' + s.movedCount;
      card.appendChild(labelA);
      card.appendChild(renderTimelineStrip(afterClips, { totalSec: totalSec }));
    }
  }

  /**
   * HIGH #10 (6 мая 2026): summary block helper — заменяет 7 inline-style копий.
   * Возвращает элемент или null (если summary пуст).
   */
  function _proposalSummaryEl(text, variantInfo) {
    if (!text) return null;
    var el2 = document.createElement('div');
    el2.className = 'proposal-summary' + (variantInfo ? ' proposal-summary--info' : '');
    el2.textContent = String(text);
    return el2;
  }

  /**
   * B1-1 (заимствовано из Chat Video Pro): кликабельный таймкод.
   * Клик → плейхед Premiere прыгает на timeSec (host setPlayheadSec).
   * Пользователь проверяет КАЖДЫЙ вырез на месте, не листая таймлайн вручную.
   */
  function _tcJumpEl(timeSec, labelText) {
    var sp = document.createElement('span');
    sp.textContent = labelText || fmtSec(timeSec);
    sp.style.cssText = 'cursor:pointer;text-decoration:underline dotted;color:#60a5fa;';
    sp.title = 'Перейти к ' + fmtSec(timeSec) + ' на таймлайне';
    sp.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!window.PremiereBridge || !PremiereBridge.setPlayhead) return;
      PremiereBridge.setPlayhead(timeSec, function (err, data) {
        if (err || (data && data.ok === false)) {
          console.warn('[tc-jump] setPlayhead failed:', err || (data && data.error));
        }
      });
    });
    return sp;
  }

  function renderPendingProposalCard() {
    var existing = document.getElementById('pending-proposal-card');
    /* MEDIUM #23 (6 мая 2026): no-op guard — не пересобираем DOM если ничего не изменилось */
    if (!_pendingProposal && !existing) return;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (!_pendingProposal) return;
    var kind = _pendingProposal.kind || 'transcript_cuts';
    var v = _pendingProposal.verification || {};
    var card = document.createElement('div');
    card.id = 'pending-proposal-card';
    card.className = 'bubble tool proposal-card';
    /* HIGH #7 (6 мая 2026): a11y — карточка как dialog для скрин-ридеров */
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'План правок ожидает подтверждения');

    var title = document.createElement('div');
    title.className = 'proposal-card-title';
    var titleByKind = {
      transcript_cuts: '⚠ Требуется подтверждение: план монтажа по тексту',
      timecode_edits: '⚠ Требуется подтверждение: правки таймлайна',
      edit_plan: '⚠ Требуется подтверждение: единый EditPlan',
      markers: '⚠ Требуется подтверждение: маркеры',
      audio_ducking: '⚠ Требуется подтверждение: ducking музыки',
      loudness: '⚠ Требуется подтверждение: LUFS-нормализация',
      j_cuts: '⚠ Требуется подтверждение: J/L-cuts аудио'
    };
    title.textContent = titleByKind[kind] || titleByKind.transcript_cuts;
    card.appendChild(title);

    /* ── kind: timecode_edits ─────────────────────────────────────── */
    if (kind === 'timecode_edits') {
      var sumTEl = _proposalSummaryEl(_pendingProposal.summary);
      if (sumTEl) card.appendChild(sumTEl);
      renderDiffSection(card, _pendingProposal.snapshot, _pendingProposal.simulation);
      var opsList = document.createElement('div');
      opsList.className = 'proposal-ops-list';
      (_pendingProposal.operations || []).forEach(function (op, i) {
        var line = document.createElement('div');
        line.textContent = (i + 1) + '. ' + op.action + ' ' + JSON.stringify(_compactOp(op));
        opsList.appendChild(line);
      });
      card.appendChild(opsList);
      card.appendChild(_buildButtons('Применить правки'));
      el.chat.appendChild(card);
      el.chat.scrollTop = el.chat.scrollHeight;
      return;
    }

    /* ── kind: edit_plan (§2.1 unified) ───────────────────────────── */
    if (kind === 'edit_plan') {
      var sumEEl = _proposalSummaryEl(_pendingProposal.summary);
      if (sumEEl) card.appendChild(sumEEl);
      if (_pendingProposal.rationale) {
        var ratE = document.createElement('div');
        ratE.className = 'proposal-rationale';
        ratE.textContent = String(_pendingProposal.rationale);
        card.appendChild(ratE);
      }
      renderDiffSection(card, _pendingProposal.snapshot, _pendingProposal.simulation);
      var normOps = _pendingProposal.normalizedOperations || [];
      var origOps = _pendingProposal.ops || [];
      var rej = _pendingProposal.rejectedOpIdxs || [];
      if (rej.length) {
        var rejBox = document.createElement('div');
        rejBox.className = 'proposal-rejected';
        rejBox.textContent = 'Отклонено нормализацией: ' + rej.length + ' ops (idx ' + rej.join(', ') + ')';
        card.appendChild(rejBox);
      }
      var opsEList = document.createElement('div');
      opsEList.className = 'proposal-ops-list';
      normOps.forEach(function (op, i) {
        var row = document.createElement('div');
        row.style.marginBottom = '3px';
        var head = document.createElement('div');
        head.textContent = (i + 1) + '. ' + op.action + ' ' + JSON.stringify(_compactOp(op));
        row.appendChild(head);
        if (op._reason) {
          var rr = document.createElement('div');
          rr.style.cssText = 'padding-left:14px;opacity:0.7;font-style:italic;';
          rr.textContent = '— ' + String(op._reason);
          row.appendChild(rr);
        }
        if (op._quote) {
          var qq = document.createElement('div');
          qq.style.cssText = 'padding-left:14px;opacity:0.75;text-decoration:line-through;';
          qq.textContent = '«' + String(op._quote).slice(0, 160) + '»';
          row.appendChild(qq);
        }
        opsEList.appendChild(row);
      });
      card.appendChild(opsEList);
      card.appendChild(_buildButtons('Применить EditPlan'));
      el.chat.appendChild(card);
      el.chat.scrollTop = el.chat.scrollHeight;
      return;
    }

    /* ── kind: markers ────────────────────────────────────────────── */
    if (kind === 'markers') {
      var sumMEl = _proposalSummaryEl(_pendingProposal.summary);
      if (sumMEl) card.appendChild(sumMEl);
      var snap = _pendingProposal.snapshot || lastSnap;
      if (snap && snap.clips) {
        var totalSec = snap.sequenceEndSec || 0;
        snap.clips.forEach(function (c) { if (c.endSec > totalSec) totalSec = c.endSec; });
        var lblM = document.createElement('div');
        lblM.style.cssText = 'font-size:10px;color:#888;margin-top:4px;';
        lblM.textContent = 'таймлайн ' + fmtSec(totalSec) + ' · маркеров: ' + (_pendingProposal.markers || []).length;
        card.appendChild(lblM);
        card.appendChild(renderTimelineStrip(snap.clips.slice(), { totalSec: totalSec, markers: _pendingProposal.markers }));
      }
      var mList = document.createElement('div');
      mList.style.cssText = 'font-size:11px;max-height:160px;overflow-y:auto;margin-top:6px;';
      (_pendingProposal.markers || []).forEach(function (m, i) {
        var row = document.createElement('div');
        row.style.cssText = 'padding:2px 0;';
        /* B1-1: клик по таймкоду маркера → плейхед */
        row.appendChild(document.createTextNode((i + 1) + '. ['));
        row.appendChild(_tcJumpEl(m.timeSec));
        row.appendChild(document.createTextNode('] ' + (m.name || '')));
        if (m.comment) {
          var c2 = document.createElement('div');
          c2.style.cssText = 'padding-left:14px;opacity:0.7;font-style:italic;';
          c2.textContent = m.comment;
          row.appendChild(c2);
        }
        mList.appendChild(row);
      });
      card.appendChild(mList);

      /* YouTube chapter export — заимствовано из openshorts (thumbnail.py:276).
         Формат описания YouTube: «M:SS Название\n…», первый маркер ОБЯЗАН быть 0:00. */
      var ytRow = document.createElement('div');
      ytRow.style.cssText = 'margin-top:6px;display:flex;gap:6px;align-items:center;';
      var ytBtn = document.createElement('button');
      ytBtn.type = 'button';
      ytBtn.textContent = '📋 Описание для YouTube';
      ytBtn.style.cssText =
        'font-size:11px;padding:4px 8px;background:rgba(255,0,0,0.08);' +
        'border:1px solid rgba(255,0,0,0.35);color:#f88;border-radius:3px;cursor:pointer;';
      ytBtn.title = 'Скопировать главы в формате YouTube-описания (0:00 Название…)';
      var ytStatus = document.createElement('span');
      ytStatus.style.cssText = 'font-size:10px;color:#888;';
      ytBtn.addEventListener('click', function () {
        var markers = _pendingProposal.markers || [];
        var text = _formatChaptersForYouTube(markers);
        if (!text) {
          ytStatus.textContent = '— нет маркеров';
          return;
        }
        /* MEDIUM (6 мая 2026): полная валидация YouTube-требований. Не блокируем
           копирование — просто предупреждаем заранее, чтобы пользователь не удивлялся
           «почему YouTube не показал главы». См. youtube-export.js:validateForYouTube. */
        if (typeof YouTubeExport !== 'undefined' && YouTubeExport.validateForYouTube) {
          var warns = YouTubeExport.validateForYouTube(markers);
          if (warns.length > 0) {
            ytStatus.textContent = '⚠ ' + warns[0] + ' Копирую как есть.';
          }
        } else if (markers.length < 3) {
          ytStatus.textContent = '⚠ YouTube нужно ≥3 глав, у тебя ' + markers.length + ' — копирую как есть';
        }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
              ytStatus.textContent = 'Скопировано (' + text.split('\n').length + ' глав)';
            }, function () {
              _fallbackCopy(text, ytStatus);
            });
          } else {
            _fallbackCopy(text, ytStatus);
          }
        } catch (e) {
          _fallbackCopy(text, ytStatus);
        }
      });
      ytRow.appendChild(ytBtn);
      ytRow.appendChild(ytStatus);
      card.appendChild(ytRow);

      card.appendChild(_buildButtons('Создать маркеры'));
      el.chat.appendChild(card);
      el.chat.scrollTop = el.chat.scrollHeight;
      return;
    }

    /* ── kind: audio_ducking ──────────────────────────────────────── */
    if (kind === 'audio_ducking') {
      var dp = _pendingProposal.duckingPlan || {};
      var dsum = document.createElement('div');
      dsum.style.cssText = 'font-size:12px;line-height:1.4;margin-bottom:8px;';
      dsum.textContent = _pendingProposal.summary || '';
      card.appendChild(dsum);
      var stt = document.createElement('div');
      stt.style.cssText = 'font-size:11px;color:#aaa;margin-bottom:6px;';
      stt.textContent =
        'Интервалов речи: ' + (dp.summary && dp.summary.intervalCount) + ' · ' +
        'duck: ' + (dp.summary && dp.summary.duckDb) + ' dB · ' +
        'fade-in: ' + (dp.summary && dp.summary.fadeInSec) + 'с · ' +
        'fade-out: ' + (dp.summary && dp.summary.fadeOutSec) + 'с · ' +
        'всего ducked: ' + (dp.summary && dp.summary.totalDuckSec) + 'с';
      card.appendChild(stt);
      var note = document.createElement('div');
      note.style.cssText =
        'font-size:11px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.4);' +
        'padding:6px 8px;border-radius:4px;margin-bottom:8px;';
      note.textContent =
        'По «Применить» будет выполнен офлайн-рендер ffmpeg (volume filter с between()), ' +
        'результат импортируется в bin «AI Renders». Перетащите новый клип поверх оригинала на A2/A3. ' +
        'Оригинал и тайминги таймлайна не затрагиваются.';
      card.appendChild(note);
      /* diff-strip: целевой клип подсвечиваем через renderDiffSection */
      try {
        var dTgt = _pendingProposal.target;
        var dSnap = _pendingProposal.snapshot || lastSnap;
        if (dSnap && dSnap.ok && dTgt && dTgt.nodeId && window.EditPlanSimulator) {
          /* используем simulateUnified с note-операцией — clipsAfter не меняется */
          var dSim = window.EditPlanSimulator.simulateUnified(dSnap, { ops: [] });
          if (dSim && dSim.ok) {
            dSim.trimmed = [String(dTgt.nodeId)]; /* подсветим как изменённый */
            renderDiffSection(card, dSnap, dSim);
          }
        }
      } catch (eDiffDk) {}
      var ivList = document.createElement('div');
      ivList.className = 'proposal-ops-list';
      (dp.intervals || []).forEach(function (iv, i) {
        var row = document.createElement('div');
        /* B1-1: клик по таймкоду интервала речи → плейхед */
        row.appendChild(document.createTextNode((i + 1) + '. '));
        row.appendChild(_tcJumpEl(iv.startSec));
        row.appendChild(document.createTextNode(' → '));
        row.appendChild(_tcJumpEl(iv.endSec));
        row.appendChild(document.createTextNode(' (' + (iv.endSec - iv.startSec).toFixed(2) + 'с)'));
        ivList.appendChild(row);
      });
      card.appendChild(ivList);
      card.appendChild(_buildButtons('Запустить рендер ducking'));
      el.chat.appendChild(card);
      el.chat.scrollTop = el.chat.scrollHeight;
      return;
    }

    /* ── kind: loudness ───────────────────────────────────────────── */
    if (kind === 'loudness') {
      var lr = _pendingProposal.loudness || {};
      var lsum = document.createElement('div');
      lsum.style.cssText = 'font-size:12px;line-height:1.5;';
      lsum.innerHTML =
        '<div><b>Input:</b> ' + lr.inputLufs + ' LUFS' +
        (lr.inputTpDb !== null ? ' · True Peak ' + lr.inputTpDb + ' dBTP' : '') + '</div>' +
        '<div><b>Target:</b> ' + lr.targetLufs + ' LUFS</div>' +
        '<div><b>Рекомендуемый gain:</b> <span style="color:#10b981;font-size:14px;font-weight:600;">' +
        (lr.gainDb >= 0 ? '+' : '') + lr.gainDb + ' dB</span>' +
        (lr.clipped ? ' <span style="color:#f43f5e;">(ограничен headroom)</span>' : '') + '</div>' +
        (lr.tpHeadroomDb !== null ? '<div style="font-size:11px;color:#888;">TP headroom до -1 dBTP: ' + lr.tpHeadroomDb + ' dB</div>' : '');
      card.appendChild(lsum);
      var note2 = document.createElement('div');
      note2.style.cssText =
        'font-size:11px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.4);' +
        'padding:6px 8px;border-radius:4px;margin:8px 0;';
      note2.textContent =
        'По «Применить» будет выполнен офлайн-рендер ffmpeg loudnorm (двухпроходный), ' +
        'результат импортируется в bin «AI Renders». Перетащите новый клип поверх оригинала. ' +
        'Оригинал и таймлайн не изменятся.';
      card.appendChild(note2);
      card.appendChild(_buildButtons('Запустить рендер loudnorm'));
      el.chat.appendChild(card);
      el.chat.scrollTop = el.chat.scrollHeight;
      return;
    }

    /* ── kind: j_cuts ──────────────────────────────────────────────── */
    if (kind === 'j_cuts') {
      var jSummary = _proposalSummaryEl(_pendingProposal.summary || 'J-cuts', /*info=*/true);
      if (jSummary) card.appendChild(jSummary);
      var jNote = document.createElement('div');
      jNote.style.cssText = 'font-size:11px;color:var(--muted);margin-bottom:8px;';
      jNote.textContent = 'Сдвинет inPoint/outPoint аудио-клипов на A1 относительно видео на V1. ' +
        'Требуется запас source-медиа (handle) у клипов. Откат: Cmd+Z.';
      card.appendChild(jNote);
      card.appendChild(_buildButtons('Применить ' + (_pendingProposal.mode === 'l' ? 'L-cuts' : 'J-cuts')));
      el.chat.appendChild(card);
      el.chat.scrollTop = el.chat.scrollHeight;
      return;
    }

    /* ── kind: transcript_cuts (исходный путь) ────────────────────── */
    if (_pendingProposal.summary) {
      var sumBlock = _proposalSummaryEl(_pendingProposal.summary);
      if (sumBlock) card.appendChild(sumBlock);
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

    /* 18.06.2026: предупреждение о неполном покрытии транскрипта при сборке «на N мин». */
    if (_pendingProposal.warnings && _pendingProposal.warnings.length) {
      for (var pwi = 0; pwi < _pendingProposal.warnings.length; pwi++) {
        var pwEl = document.createElement('div');
        pwEl.style.cssText = 'color:#f59e0b;font-size:11px;margin:2px 0 8px;';
        pwEl.textContent = '⚠ ' + _pendingProposal.warnings[pwi];
        card.appendChild(pwEl);
      }
    }

    /* HIGH (6 мая 2026): Target vs Actual badge.
       Без этого «попросил 40 секунд, получил 70» неотличимо от обычного результата.
       Колор-код: ≤target*1.05 зелёный, ≤target*1.20 жёлтый, >target*1.20 красный. */
    var targetSec = _pendingProposal.targetDurationSec;
    if (typeof targetSec === 'number' && targetSec > 0 && keepS > 0) {
      var ratio = keepS / targetSec;
      var variant, label;
      if (ratio <= 1.05) {
        variant = 'ok'; label = '✓ В целевой длине';
      } else if (ratio <= 1.20) {
        variant = 'warn'; label = '⚠ Небольшое превышение';
      } else {
        variant = 'bad'; label = '✗ Превышение хронометража';
      }
      var badge = document.createElement('div');
      badge.className = 'proposal-target-badge proposal-target-badge--' + variant;
      var overPct = Math.round((ratio - 1) * 100);
      var diffStr = overPct === 0 ? 'ровно в цель'
        : (overPct > 0 ? '+' + overPct + '%' : overPct + '%');
      badge.textContent =
        '🎯 Цель: ' + fmtSec(targetSec) + ' · Получилось: ' + fmtSec(keepS) +
        ' (' + diffStr + ') · ' + label;
      /* Вставляем ПЕРЕД stats для приоритетной видимости */
      card.insertBefore(badge, stats);
    }

    /* §2.2: diff-strip для transcript_cuts — симулируем через EditPlanSimulator */
    try {
      var tcSnap = _pendingProposal.snapshot || lastSnap;
      var tcRemove = _pendingProposal.removeIntervals || [];
      if (tcSnap && tcSnap.ok && tcSnap.clips && tcRemove.length && window.EditPlanSimulator) {
        var tcSim = window.EditPlanSimulator.simulateUnified(tcSnap, {
          ops: tcRemove.map(function (iv) {
            return { kind: 'ripple_delete_interval', startSec: iv.startSec, endSec: iv.endSec };
          })
        });
        if (tcSim && tcSim.ok) {
          renderDiffSection(card, tcSnap, tcSim);
        }
      }
    } catch (eDiffTc) { /* не критично */ }

    function _findQuote(arr, startSec) {
      if (!Array.isArray(arr)) return null;
      for (var qi = 0; qi < arr.length; qi++) {
        var qq = arr[qi];
        if (qq && typeof qq.startSec === 'number' && Math.abs(qq.startSec - startSec) < 1.5) return qq;
      }
      return null;
    }

    if (Array.isArray(v.keepIntervals) && v.keepIntervals.length) {
      var keepHdr = document.createElement('div');
      keepHdr.textContent = '✓ Остаётся в ролике (' + v.keepIntervals.length + ')';
      keepHdr.style.cssText = 'font-size:11px;font-weight:600;color:#10b981;margin-bottom:4px;';
      card.appendChild(keepHdr);
      var keepList = document.createElement('div');
      keepList.style.cssText =
        'max-height:160px;overflow-y:auto;font-size:11px;background:rgba(16,185,129,0.08);padding:6px 8px;border-radius:4px;margin-bottom:8px;';
      var keepQuotes = _pendingProposal.keepSummary || [];
      v.keepIntervals.forEach(function (iv, idx) {
        var row = document.createElement('div');
        row.style.marginBottom = '4px';
        var head = document.createElement('div');
        head.style.fontFamily = 'monospace';
        head.style.opacity = '0.8';
        /* B1-1: таймкоды кликабельны — прыжок плейхеда к началу/концу фрагмента */
        head.appendChild(document.createTextNode((idx + 1) + '. ['));
        head.appendChild(_tcJumpEl(iv.startSec));
        head.appendChild(document.createTextNode('–'));
        head.appendChild(_tcJumpEl(iv.endSec));
        head.appendChild(document.createTextNode('] · ' + (iv.endSec - iv.startSec).toFixed(1) + 'с'));
        row.appendChild(head);
        var qq = _findQuote(keepQuotes, iv.startSec);
        if (qq && qq.quote) {
          var qt = document.createElement('div');
          qt.style.cssText = 'font-style:italic;padding-left:14px;';
          qt.textContent = '«' + String(qq.quote).slice(0, 200) + '»';
          row.appendChild(qt);
        }
        keepList.appendChild(row);
      });
      card.appendChild(keepList);
    }

    var removeList = _pendingProposal.removeIntervals || [];
    if (removeList.length) {
      var rmHdr = document.createElement('div');
      rmHdr.textContent = '✗ Убирается (' + removeList.length + ')';
      rmHdr.style.cssText = 'font-size:11px;font-weight:600;color:#f43f5e;margin-bottom:4px;';
      card.appendChild(rmHdr);
      var rmBox = document.createElement('div');
      rmBox.style.cssText =
        'max-height:160px;overflow-y:auto;font-size:11px;background:rgba(244,63,94,0.08);padding:6px 8px;border-radius:4px;margin-bottom:8px;';
      var rmQuotes = _pendingProposal.removeSummary || [];
      removeList.forEach(function (iv, idx) {
        var row = document.createElement('div');
        row.style.marginBottom = '4px';
        var head = document.createElement('div');
        head.style.fontFamily = 'monospace';
        head.style.opacity = '0.8';
        /* B1-1: таймкоды кликабельны — прыжок плейхеда к началу/концу выреза */
        head.appendChild(document.createTextNode((idx + 1) + '. ['));
        head.appendChild(_tcJumpEl(iv.startSec));
        head.appendChild(document.createTextNode('–'));
        head.appendChild(_tcJumpEl(iv.endSec));
        head.appendChild(document.createTextNode('] · ' + (iv.endSec - iv.startSec).toFixed(1) + 'с'));
        row.appendChild(head);
        var rq = _findQuote(rmQuotes, iv.startSec);
        var quoteText = rq && rq.quote ? String(rq.quote) : '';
        var reasonText = (rq && rq.reason) || iv.reason || '';
        if (quoteText) {
          var qt2 = document.createElement('div');
          qt2.style.cssText = 'font-style:italic;padding-left:14px;text-decoration:line-through;opacity:0.85;';
          qt2.textContent = '«' + quoteText.slice(0, 200) + '»';
          row.appendChild(qt2);
        }
        if (reasonText) {
          var rt = document.createElement('div');
          rt.style.cssText = 'padding-left:14px;opacity:0.7;';
          rt.textContent = '— ' + reasonText;
          row.appendChild(rt);
        }
        rmBox.appendChild(row);
      });
      card.appendChild(rmBox);
    }

    card.appendChild(_buildButtons('✓ Применить монтаж'));
    el.chat.appendChild(card);
    el.chat.scrollTop = el.chat.scrollHeight;
  }

  function _buildButtons(applyLabel) {
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
    var applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    /* HIGH #10 (6 мая 2026): primary class — зелёный accent, выделяет primary action.
       До этого Apply и Cancel визуально равноценны → юзер не понимает какая основная. */
    applyBtn.className = 'primary';
    applyBtn.textContent = '✓ ' + (applyLabel || 'Применить');
    applyBtn.style.flex = '1';
    /* HIGH #7 (6 мая 2026): debounce double-clicks через flag, не только disabled.
       Если apply async — между click'ом и assertSequenceMatch userможет успеть кликнуть второй раз. */
    var clicked = false;
    applyBtn.onclick = function () {
      if (clicked) return;
      clicked = true;
      /* HIGH #1 (6 мая 2026): sequence-switch guard. Если активная секвенция
         в Premiere была переключена между proposal и apply — блокируем,
         иначе apply разрушит чужой таймлайн. */
      applyBtn.disabled = true;
      cancelBtn.disabled = true;
      var pSnap = _pendingProposal && _pendingProposal.snapshot;
      assertSequenceMatch(pSnap, function (err, ok) {
        if (!ok) {
          applyBtn.disabled = false;
          cancelBtn.disabled = false;
          clicked = false;
          showErr(err && err.message ? err.message : 'Sequence mismatch');
          return;
        }
        applyPendingProposal();
      });
    };
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Отмена (Esc)';
    cancelBtn.className = 'secondary';
    cancelBtn.style.flex = '0 0 auto';
    cancelBtn.onclick = function () { cancelPendingProposal(); };
    btnRow.appendChild(applyBtn);
    btnRow.appendChild(cancelBtn);
    /* HIGH #7 (6 мая 2026): autofocus на Apply при появлении карточки.
       requestAnimationFrame чтобы DOM успел встать (карточка уже в chat'е к этому моменту,
       но element ещё может быть detached если вызывают до append). */
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        if (applyBtn.isConnected && !applyBtn.disabled) {
          try { applyBtn.focus({ preventScroll: false }); } catch (e) { applyBtn.focus(); }
        }
      });
    }
    return btnRow;
  }

  /**
   * HIGH #7 (6 мая 2026): глобальный Escape-handler для отмены pending proposal.
   * Один listener на document — снимать не нужно (живёт всё время существования панели).
   * Заменяет необходимость для каждой карточки слушать Escape отдельно.
   * Уважаем фокус: если юзер в input/textarea/contenteditable — не перехватываем
   * (там Escape может иметь другой смысл).
   */
  function _initGlobalEscapeHandler() {
    if (window.__omcEscapeHandlerInstalled) return;
    window.__omcEscapeHandlerInstalled = true;
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!_pendingProposal) return;
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' ||
                t.isContentEditable)) return;
      e.preventDefault();
      cancelPendingProposal();
    });
  }
  _initGlobalEscapeHandler();

  function _compactOp(op) {
    var keys = ['nodeId', 'startSec', 'endSec', 'timeSec', 'newStartSec', 'fromSec', 'deltaSec', 'enabled', 'clipName', 'trackType', 'trackIndex', 'muted'];
    var out = {};
    for (var k = 0; k < keys.length; k++) {
      if (op[keys[k]] !== undefined) out[keys[k]] = op[keys[k]];
    }
    return out;
  }

  function applyPendingProposal() {
    if (!_pendingProposal) return;
    var prop = _pendingProposal;
    var kind = prop.kind || 'transcript_cuts';
    _pendingProposal = null;
    var card = document.getElementById('pending-proposal-card');
    if (card && card.parentNode) card.parentNode.removeChild(card);
    var panelId = active.panelId;

    if (kind === 'j_cuts') {
      statusUi.show('Применяю ' + (prop.mode === 'l' ? 'L-cuts' : 'J-cuts') + '…', true);
      _snapDirty = true;
      PremiereBridge.applyJCuts(
        { offsetFrames: prop.offsetFrames || 4, mode: prop.mode || 'j' },
        function (err, data) {
          statusUi.hide();
          if (err) {
            showErr('Ошибка J-cuts: ' + String(err.message || err));
            return;
          }
          var msgs = ContextStore.getMessages(panelId);
          if (data && data.ok) {
            msgs.push({
              role: 'assistant',
              content: (prop.mode === 'l' ? 'L-cuts' : 'J-cuts') + ' применены: ' +
                data.applied + ' из ' + data.totalCuts + ' стыков. Откат: Cmd+Z / Ctrl+Z.' +
                (data.errors && data.errors.length ? '\nОшибки: ' + data.errors.join('; ') : '')
            });
          } else {
            msgs.push({ role: 'assistant', content: 'Ошибка: ' + ((data && data.error) || 'неизвестная') });
          }
          ContextStore.setMessages(panelId, msgs);
          renderMessages(msgs);
        }
      );
      return;
    }

    if (kind === 'edit_plan') {
      statusUi.show('Применяю EditPlan…', true);
      var normOpsE = prop.normalizedOperations || [];
      if (!normOpsE.length) {
        statusUi.hide();
        showErr('EditPlan пуст после нормализации.');
        return;
      }
      /* B2-9: checkpoint перед атомарным apply */
      _makeSequenceCheckpoint('EditPlan', function () {
      PremiereBridge.applyTimecodeEdits(
        { operations: normOpsE, summary: prop.summary || '' },
        function (errE, dataE) {
          if (errE) {
            statusUi.hide();
            showErr('Ошибка применения EditPlan: ' + String(errE.message || errE));
            return;
          }
          if (dataE && dataE.ok === false) {
            statusUi.hide();
            showErr('EditPlan НЕ применён: ' + describeHostFailure(dataE));
            return;
          }
          PremiereBridge.getTimelineSnapshot(function (snapErrE, snapDataE) {
            if (!snapErrE && snapDataE && snapDataE.ok) lastSnap = snapDataE;
            try {
              var seqKeyE = (snapDataE && snapDataE.sequenceName) || (lastSnap && lastSnap.sequenceName) || '';
              if (seqKeyE) {
                var rippleIvsE = EditPlanSimulator.extractRippleIntervals(normOpsE);
                if (rippleIvsE.length) {
                  ContextStore.applyRippleDeletionsToTranscript(TRANSCRIPT_PID, seqKeyE, rippleIvsE);
                }
                var hasShiftE = normOpsE.some(function (o) {
                  return (
                    o.action === 'move_clip' ||
                    o.action === 'shift_timeline_ripple' ||
                    o.action === 'set_timeline_in' ||
                    o.action === 'set_timeline_out' ||
                    o.action === 'set_timeline_bounds' ||
                    o.action === 'remove_clip'
                  );
                });
                if (hasShiftE) {
                  ContextStore.markTranscriptStale(
                    TRANSCRIPT_PID,
                    seqKeyE,
                    'edit_plan apply: ' + normOpsE.map(function (o) { return o.action; }).join(',')
                  );
                }
              }
            } catch (eShE) {}
            statusUi.show('Готово', false);
            setTimeout(function () { statusUi.hide(); }, 1200);
            var sE = prop.simulation && prop.simulation.summary;
            var msgsE = ContextStore.getMessages(panelId);
            msgsE.push({
              role: 'assistant',
              content:
                'EditPlan применён атомарно (' + normOpsE.length + ' ops). ' +
                (sE ? ('Удалено: ' + sE.removedCount + ', обрезано: ' + sE.trimmedCount + ', перемещено: ' + sE.movedCount + '. Длительность: ' + sE.durationBeforeSec + ' → ' + sE.durationAfterSec + 'с.') : '') +
                ' Откат: Cmd+Z / Ctrl+Z в таймлайне.'
            });
            ContextStore.setMessages(panelId, msgsE);
            renderMessages(msgsE);
          });
        }
      );
      }); /* конец _makeSequenceCheckpoint */
      return;
    }

    if (kind === 'timecode_edits') {
      statusUi.show('Применяю правки таймлайна…', true);
      /* B2-9: checkpoint перед правками таймлайна */
      _makeSequenceCheckpoint('правки таймлайна', function () {
      PremiereBridge.applyTimecodeEdits(
        { operations: prop.operations, summary: prop.summary },
        function (err, data) {
          if (err) {
            statusUi.hide();
            showErr('Ошибка применения правок: ' + String(err.message || err));
            return;
          }
          if (data && data.ok === false) {
            statusUi.hide();
            showErr('Правки НЕ применены: ' + describeHostFailure(data));
            return;
          }
          PremiereBridge.getTimelineSnapshot(function (snapErr, snapData) {
            if (!snapErr && snapData && snapData.ok) lastSnap = snapData;
            statusUi.show('Готово', false);
            setTimeout(function () { statusUi.hide(); }, 1200);
            var s = prop.simulation && prop.simulation.summary;
            var msgs = ContextStore.getMessages(panelId);
            msgs.push({
              role: 'assistant',
              content:
                'Правки применены. ' +
                (s ? ('Удалено: ' + s.removedCount + ', обрезано: ' + s.trimmedCount + ', перемещено: ' + s.movedCount + '. Длительность: ' + s.durationBeforeSec + ' → ' + s.durationAfterSec + 'с.') : '') +
                describeHostWarnings(data)
            });
            ContextStore.setMessages(panelId, msgs);
            renderMessages(msgs);
          });
        }
      );
      }); /* конец _makeSequenceCheckpoint */
      return;
    }

    if (kind === 'markers') {
      statusUi.show('Создаю маркеры…', true);
      PremiereBridge.addSequenceMarkers(prop.markers || [], function (err, data) {
        if (err) {
          statusUi.hide();
          showErr('Ошибка создания маркеров: ' + String(err.message || err));
          return;
        }
        if (data && data.createdSeconds && data.createdSeconds.length) {
          var seqNm = lastSnap && lastSnap.sequenceName ? lastSnap.sequenceName : '';
          ContextStore.setLastUndo(panelId, data.createdSeconds.length, 'маркеры', seqNm, {
            mode: 'markers',
            markerSeconds: data.createdSeconds
          });
          refreshUndoButton();
        }
        statusUi.show('Готово', false);
        setTimeout(function () { statusUi.hide(); }, 1200);
        var msgs = ContextStore.getMessages(panelId);
        msgs.push({
          role: 'assistant',
          content: 'Маркеры созданы: ' + ((data && data.created && data.created.length) || 0) + '.' +
            describeHostWarnings(data)
        });
        ContextStore.setMessages(panelId, msgs);
        renderMessages(msgs);
      });
      return;
    }

    if (kind === 'audio_ducking') {
      var dp = prop.duckingPlan || {};
      var tgt = prop.target || {};
      if (!tgt.mediaPath) {
        showErr('Нет mediaPath у целевого клипа — рендер невозможен.');
        return;
      }
      statusUi.show('ffmpeg: рендер ducking…', true);
      AudioRender.renderDucking({
        inputPath: tgt.mediaPath,
        speechIntervalsTimeline: (dp.intervals || []),
        clipStartSec: tgt.startSec || 0,
        clipInPointSec: tgt.inPointSec || 0,
        duckDb: prop.duckDb || -12,
        fadeSec: prop.fadeSec || 0.2,
        onProgress: function (msg) { statusUi.show(msg, true); statusUi.progress(null); }
      }).then(function (rRes) {
        statusUi.show('Импорт в проект…', true);
        PremiereBridge.importMediaFile({ path: rRes.outputPath, binName: 'AI Renders' }, function (impErr, impData) {
          statusUi.show('Готово', false);
          setTimeout(function () { statusUi.hide(); }, 1500);
          var msgs = ContextStore.getMessages(panelId);
          var importNote = (impErr || !impData || !impData.ok)
            ? 'Импорт в проект не удался: ' + String((impErr && impErr.message) || (impData && impData.error) || 'неизв. ошибка') + '. Файл лежит на диске — перетащите вручную.'
            : 'Импортировано в bin "' + (impData.binName || 'AI Renders') + '" как «' + (impData.projectItemName || '') + '». Перетащите этот клип на дорожку A2/A3 поверх оригинала «' + (tgt.name || '') + '».';
          msgs.push({
            role: 'assistant',
            content:
              'Готово: ducking ' + (prop.duckDb || -12) + ' dB на ' + ((dp.intervals && dp.intervals.length) || 0) + ' речевых интервалах применён к «' + (tgt.name || '') + '».\n' +
              'Файл: ' + rRes.outputPath + '\n' +
              importNote
          });
          ContextStore.setMessages(panelId, msgs);
          renderMessages(msgs);
        });
      }).catch(function (err) {
        statusUi.hide();
        showErr('ffmpeg ducking упал: ' + String(err && err.message || err));
      });
      return;
    }

    if (kind === 'loudness') {
      var ltgt = prop.target || {};
      var lufs = prop.targetLufs || -16;
      if (!ltgt.mediaPath) {
        showErr('Нет mediaPath у целевого клипа.');
        return;
      }
      statusUi.show('ffmpeg: loudnorm I=' + lufs + '…', true);
      AudioRender.renderLoudnorm({
        inputPath: ltgt.mediaPath,
        targetLufs: lufs,
        onProgress: function (msg) { statusUi.show(msg, true); statusUi.progress(null); }
      }).then(function (rR) {
        statusUi.show('Импорт в проект…', true);
        PremiereBridge.importMediaFile({ path: rR.outputPath, binName: 'AI Renders' }, function (impErr2, impData2) {
          statusUi.show('Готово', false);
          setTimeout(function () { statusUi.hide(); }, 1500);
          var msgs2 = ContextStore.getMessages(panelId);
          var note2 = (impErr2 || !impData2 || !impData2.ok)
            ? 'Импорт не удался: ' + String((impErr2 && impErr2.message) || (impData2 && impData2.error) || 'неизв.') + '. Перетащите файл вручную.'
            : 'Импортировано в bin "' + (impData2.binName || 'AI Renders') + '" как «' + (impData2.projectItemName || '') + '». Перетащите на дорожку поверх оригинала «' + (ltgt.name || '') + '».';
          var measured = rR.summary && rR.summary.measuredOutputLufs;
          msgs2.push({
            role: 'assistant',
            content:
              'Готово: loudnorm на «' + (ltgt.name || '') + '» → ' + lufs + ' LUFS' +
              (measured !== null && measured !== undefined ? ' (фактически ' + measured + ' LUFS)' : '') + '.\n' +
              'Файл: ' + rR.outputPath + '\n' +
              note2
          });
          ContextStore.setMessages(panelId, msgs2);
          renderMessages(msgs2);
        });
      }).catch(function (errL) {
        statusUi.hide();
        showErr('ffmpeg loudnorm упал: ' + String(errL && errL.message || errL));
      });
      return;
    }

    /* default: transcript_cuts (исходный путь) */
    statusUi.show('Применяю монтаж…', true);
    /* B2-9: checkpoint — клон секвенции перед ripple-удалениями */
    _makeSequenceCheckpoint('монтаж по тексту', function () {
    PremiereBridge.applyTranscriptCuts(
      { removeIntervals: prop.removeIntervals, summary: prop.summary },
      function (err, data) {
        if (err) {
          statusUi.hide();
          showErr('Ошибка применения монтажа: ' + String(err.message || err));
          return;
        }
        /* Host-контракт (10 июня 2026): ok:false приходит как data, не err —
           locked-дорожки или полный отказ razor. НЕ пишем «применено». */
        if (data && data.ok === false) {
          statusUi.hide();
          showErr('Монтаж НЕ применён: ' + describeHostFailure(data));
          return;
        }
        PremiereBridge.getTimelineSnapshot(function (snapErr, snapData) {
          if (!snapErr && snapData && snapData.ok) lastSnap = snapData;
          try {
            var seqKey = (snapData && snapData.sequenceName) || (lastSnap && lastSnap.sequenceName) || '';
            if (seqKey) {
              ContextStore.applyRippleDeletionsToTranscript(TRANSCRIPT_PID, seqKey, prop.removeIntervals || []);
            }
          } catch (eShift) {}
          statusUi.show('Готово', false);
          setTimeout(function () { statusUi.hide(); }, 1200);
          var msgs = ContextStore.getMessages(panelId);
          msgs.push({
            role: 'assistant',
            content: _buildApplySummary(prop, data, snapData)
          });
          ContextStore.setMessages(panelId, msgs);
          renderMessages(msgs);
        });
      }
    );
    }); /* конец _makeSequenceCheckpoint */
  }

  /**
   * B1-5 (заимствовано из Descript agent_response): структурированное резюме
   * после apply — план vs факт. Сверяем предсказанную длительность (verification)
   * с фактическим снапшотом ПОСЛЕ применения. Расхождение >2с — явный варнинг,
   * иначе пользователь не узнает что host применил не всё.
   */
  function _buildApplySummary(prop, data, snapData) {
    var v = prop.verification || {};
    var lines = ['✂ Монтаж применён.'];
    if (typeof v.removeCount === 'number') {
      var cutSec = (v.originalDurationSec || 0) - (v.totalKeepSec || 0);
      lines.push('• Вырезано: ' + v.removeCount + ' интервал(ов), −' + fmtSec(cutSec > 0 ? cutSec : 0));
    }
    /* Факт: длительность из свежего снапшота */
    var actualSec = null;
    if (snapData && snapData.ok && snapData.clips) {
      actualSec = snapData.sequenceEndSec || 0;
      for (var ci = 0; ci < snapData.clips.length; ci++) {
        if (snapData.clips[ci].endSec > actualSec) actualSec = snapData.clips[ci].endSec;
      }
    }
    if (typeof v.originalDurationSec === 'number' && actualSec !== null) {
      lines.push('• Длительность: ' + fmtSec(v.originalDurationSec) + ' → ' + fmtSec(actualSec));
      if (typeof v.totalKeepSec === 'number' && Math.abs(actualSec - v.totalKeepSec) > 2) {
        lines.push('⚠ Факт (' + fmtSec(actualSec) + ') расходится с планом (' +
          fmtSec(v.totalKeepSec) + ') — проверьте таймлайн визуально');
      }
    } else if (typeof v.totalKeepSec === 'number') {
      lines.push('• Осталось по плану: ' + fmtSec(v.totalKeepSec));
    }
    lines.push('• Кэш транскрипта пересчитан под новый таймлайн');
    /* Live-находка 11 июня 2026: если B2-9 checkpoint создал бэкап-секвенцию,
       советуем кнопку отката, а не только Cmd+Z (надёжнее на ripple-cuts). */
    var undoMode = null;
    try {
      var lu = ContextStore.getLastUndo && ContextStore.getLastUndo(TRANSCRIPT_PID);
      undoMode = lu && lu.mode;
    } catch (eU) {}
    if (undoMode === 'sequence_backup') {
      lines.push('• Откат: кнопка «⏪ Откатить» (бэкап-секвенция) или Cmd+Z / Ctrl+Z');
    } else {
      lines.push('• Откат: Cmd+Z / Ctrl+Z в таймлайне Premiere');
    }
    var hw = describeHostWarnings(data);
    return lines.join('\n') + hw;
  }

  /* ── Host-контракт (10 июня 2026): человекочитаемые ошибки/предупреждения ──
     Хост теперь возвращает appliedCount/failedCount/failedReasons/lockedTracks/
     maxDriftMs/driftWarnings. Раньше частичные сбои терялись молча. */
  function describeHostFailure(data) {
    if (!data) return 'неизвестная ошибка хоста';
    var parts = [String(data.error || 'операция не применилась')];
    if (data.lockedTracks && data.lockedTracks.length) {
      parts.push('Заблокированы: ' + data.lockedTracks.join(', '));
    }
    if (data.failedReasons && data.failedReasons.length) {
      parts.push('Причины: ' + data.failedReasons.join('; '));
    }
    return parts.join('. ');
  }

  function describeHostWarnings(data) {
    if (!data) return '';
    var warns = [];
    if (typeof data.failedCount === 'number' && data.failedCount > 0) {
      warns.push('⚠ ' + data.failedCount + ' операци(й) не применились' +
        (data.failedReasons && data.failedReasons.length ? ': ' + data.failedReasons.join('; ') : '') +
        ' — проверьте таймлайн визуально');
    }
    if (typeof data.driftWarnings === 'number' && data.driftWarnings > 0) {
      warns.push('⚠ ' + data.driftWarnings + ' маркер(ов) сместились (макс. ' +
        (data.maxDriftMs || '?') + ' мс)');
    }
    return warns.length ? '\n' + warns.join('\n') : '';
  }

  /**
   * B2-9 (заимствовано из Descript Underlord v2): checkpoint перед разрушительным
   * apply. Клонирует активную секвенцию (host backupActiveSequence), сохраняет
   * backupId в lastUndo → кнопка отката переключается в режим «Откатить монтаж».
   * Не блокирует apply: бэкап не удался → продолжаем (Cmd+Z остаётся).
   * cb(backupInfo|null) вызывается ВСЕГДА.
   */
  function _makeSequenceCheckpoint(label, cb) {
    if (!window.PremiereBridge || !PremiereBridge.backupActiveSequence) { cb(null); return; }
    PremiereBridge.backupActiveSequence(function (err, data) {
      if (err || !data || !data.ok) {
        console.warn('[checkpoint] бэкап секвенции не создан:', (err && err.message) || (data && data.error));
        cb(null);
        return;
      }
      try {
        ContextStore.setLastUndo(active.panelId, 1, label || 'монтаж', data.originalName || '', {
          mode: 'sequence_backup',
          backupId: data.backupId,
          backupName: data.backupName
        });
        /* 19.06.2026: сохраняем КОПИЮ транскрипта до ripple-правок. apply_* сдвигает
           кэш транскрипта (applyRippleDeletionsToTranscript), а откат восстанавливал
           только секвенцию → транскрипт оставался rippled и не совпадал с восстановленным
           таймлайном (live-баг: после отката чат «видел» 0-122с вместо 300-1500с). */
        try {
          var _ck = data.originalName || '';
          if (_ck && ContextStore.getTranscriptEntry) {
            var _ent = ContextStore.getTranscriptEntry(TRANSCRIPT_PID, _ck);
            if (_ent) _transcriptCheckpoints[data.backupId] = { key: _ck, entry: JSON.parse(JSON.stringify(_ent)) };
          }
        } catch (eTc) {}
        refreshUndoButton();
      } catch (eSB) {}
      cb(data);
    });
  }

  function cancelPendingProposal() {
    _pendingProposal = null;
    var card = document.getElementById('pending-proposal-card');
    if (card && card.parentNode) card.parentNode.removeChild(card);
    var panelId = active.panelId;
    var msgs = ContextStore.getMessages(panelId);
    msgs.push({
      role: 'assistant',
      content: 'План монтажа отменён пользователем. Ничего не изменено на таймлайне.'
    });
    ContextStore.setMessages(panelId, msgs);
    renderMessages(msgs);
  }

  function execProposeTranscriptCuts(args) {
    args = args || {};
    var hasRemove = Array.isArray(args.removeIntervals) && args.removeIntervals.length > 0;
    var hasKeep = Array.isArray(args.keepIntervals) && args.keepIntervals.length > 0;

    /* US-004: mutual exclusion */
    if (hasRemove && hasKeep) {
      return Promise.resolve({
        validationError: 'Передавай ЛИБО removeIntervals (для «убери X»), ЛИБО keepIntervals ' +
          '(для «собери ролик про X»). Одновременно нельзя — это неоднозначно.'
      });
    }
    if (!hasRemove && !hasKeep) {
      return Promise.resolve({
        validationError: 'Нужен хотя бы один из: removeIntervals или keepIntervals.'
      });
    }

    /* US-004: если keepIntervals — инвертируем в removeIntervals. */
    var workingArgs = args;
    if (hasKeep) {
      /* HIGH (6 мая 2026): проверка хронометража ДО инверсии. LLM на сборочном
         монтаже часто игнорирует «уложи в N секунд» — сейчас проверим сумму keep
         и вернём fix-it message чтобы LLM пересобрал план. Допустим overshoot 20%
         (разумный буфер на снап и удлинение фраз). Делегируется в pure-функцию
         AnalysisRouting.validateKeepDuration для testability. */
      if (typeof AnalysisRouting !== 'undefined' && AnalysisRouting.validateKeepDuration &&
          typeof args.targetDurationSec === 'number' && args.targetDurationSec > 0) {
        var dRes = AnalysisRouting.validateKeepDuration(args.keepIntervals, args.targetDurationSec);
        if (dRes && dRes.error) {
          return Promise.resolve({ validationError: dRes.error });
        }
      }
      /* Сборка «на N минут» (targetDurationSec) → инвертируем в границах ВСЕЙ
         секвенции, иначе нетранскрибированный хвост остаётся (live-баг: 3 мин → 47 мин). */
      var assembleFull = typeof args.targetDurationSec === 'number' && args.targetDurationSec > 0;
      var invRes = _invertKeepToRemove(args.keepIntervals, args.sequenceKey, assembleFull);
      if (invRes.error) {
        return Promise.resolve({ validationError: invRes.error });
      }
      _keepInvertWarning = invRes.warning || null;
      workingArgs = Object.assign({}, args, { removeIntervals: invRes.removeIntervals });
    }

    var vr = ToolValidators.validateTranscriptCuts(lastSnap, workingArgs);
    if (vr && vr.error) return Promise.resolve({ validationError: vr.error });

    /* «Дыхание» (padding 0.2–0.4с): ужимаем removeIntervals на padding с обеих сторон.
       Идея заимствована из openshorts FFmpeg time contract: «start 0.2–0.4s ДО hook,
       end 0.2–0.4s ПОСЛЕ payoff» — речь не звучит обрезанной.
       Делаем ДО snap'а, иначе snap сначала зацепит границу слова, а потом padding
       уведёт интервал внутрь следующего слова. */
    var paddingSec = typeof args.paddingSec === 'number' ? Math.max(0, args.paddingSec) : 0.3;
    var paddedIntervals = _padRemoveIntervals(workingArgs.removeIntervals || [], paddingSec);

    /* Snap к границам сегментов для предотвращения обрезки слов + merge перекрытий */
    var snappedIntervals = mergeRemoveIntervals(snapIntervalsToSegmentBoundaries(paddedIntervals));
    var verification = computeVerification(snappedIntervals);

    /* 19.06.2026: ре-валидация хронометража ПОСЛЕ снапа к границам абзацев.
       validateKeepDuration проверяет сумму keep ДО снапа, но на длинных абзацах
       снап раздувает результат (live-баг seq3: запрос 2 мин → итог 2:59 +50%, но
       карточка показывалась с активным Apply). Если финал >target*1.20 — возвращаем
       ошибку, чтобы LLM выбрал меньше/короче фрагментов. */
    if (typeof args.targetDurationSec === 'number' && args.targetDurationSec > 0 &&
        verification && typeof verification.totalKeepSec === 'number') {
      var finalRatio = verification.totalKeepSec / args.targetDurationSec;
      if (finalRatio > 1.20) {
        return Promise.resolve({
          validationError: 'После выравнивания по границам абзацев итог ' +
            Math.round(verification.totalKeepSec) + 'с превышает цель ' + args.targetDurationSec +
            'с на ' + Math.round((finalRatio - 1) * 100) + '% (>20%). ' +
            'Выбери МЕНЬШЕ фрагментов или более короткие абзацы и пришли план заново. ' +
            'Учитывай, что границы расширяются до краёв абзаца.'
        });
      }
    }

    _pendingProposal = {
      kind: 'transcript_cuts',
      removeIntervals: snappedIntervals,
      keepSummary: args.keepSummary || [],
      removeSummary: args.removeSummary || [],
      summary: args.summary || '',
      verification: verification,
      snapshot: lastSnap,
      createdAt: Date.now(),
      invertedFromKeep: hasKeep,
      /* HIGH (6 мая 2026): сохраняем target для UI-индикации в карточке.
         Без этого пользователь не видит «попросил 40, получил 70». */
      targetDurationSec: typeof args.targetDurationSec === 'number' ? args.targetDurationSec : null,
      warnings: _keepInvertWarning ? [_keepInvertWarning] : null
    };
    renderPendingProposalCard();
    return Promise.resolve({
      ok: true,
      status: 'waiting_user_confirmation',
      message:
        (hasKeep ? 'keepIntervals инвертированы в ' + snappedIntervals.length + ' removeIntervals. ' : '') +
        'План предложен пользователю. Жди, пока он нажмёт «Применить» или «Отмена». ' +
        'НЕ вызывай apply_transcript_cuts сам — это сделает UI по кнопке.',
      _verification: verification
    });
  }

  /**
   * US-004: инверсия keepIntervals → removeIntervals.
   * Определяет границы транскрипта, делегирует пуре-инверсию в AnalysisRouting.
   *
   * @param {boolean} fullSequence — если true, complement считается в границах
   *   ВСЕЙ секвенции [0, sequenceEndSec], а не транскрипта. Нужно для сборки
   *   «на N минут»: иначе нетранскрибированный хвост остаётся и финал ≫ target
   *   (live-баг 18.06.2026: «нарезка 3 мин» → 47 мин из-за хвоста вне транскрипта).
   */
  function _invertKeepToRemove(keepIntervals, sequenceKey, fullSequence) {
    /* Определяем [minSec, maxSec] — границы транскрипта. */
    var minSec = 0;
    var maxSec = 0;
    var trMin = null, trMax = null;
    var segments = null;
    var seqKey = sequenceKey ? _cleanSeqKey(sequenceKey) : '';
    if (seqKey) {
      var found = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, seqKey);
      if (found && found.entry && found.entry.segments && found.entry.segments.length) {
        segments = found.entry.segments;
        var first = segments[0];
        var last = segments[segments.length - 1];
        var fs = typeof first.startSec === 'number' ? first.startSec : first.start;
        var le = typeof last.endSec === 'number' ? last.endSec : last.end;
        if (typeof fs === 'number') { minSec = fs; trMin = fs; }
        if (typeof le === 'number') { maxSec = le; trMax = le; }
      }
    }
    /* Fallback: по снапшоту */
    if (maxSec <= minSec && lastSnap && lastSnap.ok) {
      minSec = typeof lastSnap.inPointSec === 'number' ? lastSnap.inPointSec : 0;
      maxSec = typeof lastSnap.outPointSec === 'number' ? lastSnap.outPointSec : (lastSnap.durationSec || 0);
    }
    if (maxSec <= minSec) {
      return { error: 'Не удалось определить границы транскрипта. Передай sequenceKey или сначала транскрибируй In-Out.' };
    }

    /* Сборка «на N минут»: финал должен быть ≈N, поэтому удаляем ВСЁ вне keep,
       включая нетранскрибированные участки. Расширяем границы до всей секвенции. */
    var warning = null;
    if (fullSequence && lastSnap && lastSnap.ok) {
      var seqEnd = typeof lastSnap.sequenceEndSec === 'number' && lastSnap.sequenceEndSec > 0
        ? lastSnap.sequenceEndSec : maxSec;
      var uncovered = (trMin !== null ? (trMin - 0) : 0) + (trMax !== null ? (seqEnd - trMax) : 0);
      if (uncovered > 5) {
        warning = 'Транскрипт покрывает не всю секвенцию (' +
          fmtSec(trMin || 0) + '–' + fmtSec(trMax || maxSec) + ' из 0–' + fmtSec(seqEnd) +
          '). Нетранскрибированные участки будут вырезаны как не вошедшие в нарезку.';
      }
      minSec = 0;
      maxSec = seqEnd;
    }

    if (typeof AnalysisRouting === 'undefined' || !AnalysisRouting.invertKeepToRemove) {
      return { error: 'AnalysisRouting.invertKeepToRemove не загружен (клиентский баг).' };
    }
    var res = AnalysisRouting.invertKeepToRemove(keepIntervals, {
      minSec: minSec,
      maxSec: maxSec,
      segments: segments
    });
    if (res && !res.error && warning) res.warning = warning;
    return res;
  }

  /* ─── Новые executors: propose_timecode_edits / propose_markers / find_moments / ducking / loudness ── */

  function execProposeTimecodeEdits(args) {
    if (!lastSnap || !lastSnap.ok) {
      return Promise.resolve({
        validationError: 'Сначала вызовите get_timeline_snapshot.',
        hint: 'propose_timecode_edits требует свежий снимок для симуляции.'
      });
    }
    /* Нормализуем: если LLM прислал kind вместо action, конвертируем */
    if (args && Array.isArray(args.operations)) {
      args.operations = args.operations.map(function (op) {
        if (!op.action && op.kind) {
          op = Object.assign({}, op);
          op.action = op.kind;
        }
        return op;
      });
    }
    var v = ToolValidators.validateTimecodePlan(lastSnap, args);
    if (v) return Promise.resolve({ validationError: v });
    var sim = EditPlanSimulator.simulate(lastSnap, args);
    if (!sim.ok) return Promise.resolve({ validationError: sim.error || 'Симуляция не удалась' });
    _pendingProposal = {
      kind: 'timecode_edits',
      operations: args.operations || [],
      summary: args.summary || '',
      simulation: sim,
      snapshot: lastSnap,
      createdAt: Date.now()
    };
    renderPendingProposalCard();
    return Promise.resolve({
      ok: true,
      status: 'waiting_user_confirmation',
      message: 'План правок таймлайна предложен пользователю. НЕ вызывай apply_timecode_edits сам — это сделает UI.',
      simulation: sim.summary
    });
  }

  function execDryRunEditPlan(args) {
    if (!lastSnap || !lastSnap.ok) {
      return Promise.resolve({ error: 'Сначала вызовите get_timeline_snapshot.' });
    }
    /* §2.1: принимаем и {ops:[...]} (unified), и {operations:[...]} (legacy). */
    var sim;
    if (args && Array.isArray(args.ops)) {
      var vu = ToolValidators.validateEditPlan(lastSnap, args);
      if (vu) return Promise.resolve({ validationError: vu });
      sim = EditPlanSimulator.simulateUnified(lastSnap, args);
    } else {
      var v = ToolValidators.validateTimecodePlan(lastSnap, args || {});
      if (v) return Promise.resolve({ validationError: v });
      sim = EditPlanSimulator.simulate(lastSnap, args || {});
    }
    if (!sim.ok) return Promise.resolve({ error: sim.error });
    return Promise.resolve({
      ok: true,
      summary: sim.summary,
      removedNodeIds: sim.removed,
      trimmedNodeIds: sim.trimmed,
      movedNodeIds: sim.moved,
      rejectedOpIdxs: sim.rejectedOpIdxs || [],
      errors: sim.errors,
      clipsAfter: sim.clips.map(function (c) {
        return {
          nodeId: c.nodeId,
          name: c.name,
          startSec: Math.round(c.startSec * 100) / 100,
          endSec: Math.round(c.endSec * 100) / 100,
          disabled: c.disabled
        };
      })
    });
  }

  /* §2.1: propose_edit_plan — единый пропоз на смешанные ops.
     Симулирует через EditPlanSimulator.simulateUnified, показывает карточку edit_plan. */
  function execProposeEditPlan(args) {
    if (!lastSnap || !lastSnap.ok) {
      return Promise.resolve({
        validationError: 'Сначала вызовите get_timeline_snapshot.',
        hint: 'propose_edit_plan требует свежий снимок для симуляции.'
      });
    }
    var vErr = ToolValidators.validateEditPlan(lastSnap, args || {});
    if (vErr) return Promise.resolve({ validationError: vErr });
    var sim = EditPlanSimulator.simulateUnified(lastSnap, args);
    if (!sim.ok) return Promise.resolve({ validationError: sim.error || 'Симуляция не удалась' });
    _pendingProposal = {
      kind: 'edit_plan',
      ops: args.ops || [],
      normalizedOperations: sim.normalizedOperations || [],
      rejectedOpIdxs: sim.rejectedOpIdxs || [],
      summary: args.summary || '',
      rationale: args.rationale || '',
      simulation: sim,
      snapshot: lastSnap,
      createdAt: Date.now()
    };
    renderPendingProposalCard();
    return Promise.resolve({
      ok: true,
      status: 'waiting_user_confirmation',
      message:
        'EditPlan предложен пользователю. Жди кнопки «Применить» / «Отмена». ' +
        'НЕ вызывай apply_edit_plan сам — это сделает UI.',
      simulation: sim.summary,
      rejectedOpIdxs: sim.rejectedOpIdxs || []
    });
  }

  /* §2.1: apply_edit_plan без подтверждения — нормализует ops и дёргает
     applyTimecodeEdits одним вызовом (один undo-group в Premiere). */
  function execApplyEditPlan(panelId, args) {
    /* Safety-guard: без явного «без подтверждения» — показываем карточку. */
    if (!_directApplyAuthorized) {
      return Promise.resolve(execProposeEditPlan(args)).then(function (r) {
        return Object.assign({ _redirectedToPropose: true,
          message: 'Прямое применение без подтверждения запрещено. Показал карточку propose_edit_plan — пользователь нажмёт «Применить». Заверши ход.' },
          (r && typeof r === 'object') ? r : {});
      });
    }
    return new Promise(function (resolve, reject) {
      var vErr = ToolValidators.validateEditPlan(lastSnap, args || {});
      if (vErr) {
        resolve({ validationError: vErr, hint: 'Обновите снимок или поправьте ops.' });
        return;
      }
      var norm = EditPlanSimulator.normalizeUnifiedPlan(args);
      if (!norm.operations.length) {
        resolve({ error: 'После нормализации не осталось валидных ops.' });
        return;
      }
      PremiereBridge.applyTimecodeEdits(
        { operations: norm.operations, summary: args.summary || '' },
        function (err, data) {
          if (err) {
            reject(err);
            return;
          }
          PremiereBridge.getTimelineSnapshot(function (snapErr, snapData) {
            if (!snapErr && snapData && snapData.ok) lastSnap = snapData;
            data._autoSnapshot = snapData || null;
            /* Пересчёт кэша транскрипта — как в execApplyTimecodeEdits */
            try {
              var seqKey = (snapData && snapData.sequenceName) || (lastSnap && lastSnap.sequenceName) || '';
              if (seqKey) {
                var rippleIvs = EditPlanSimulator.extractRippleIntervals(norm.operations);
                if (rippleIvs.length) {
                  ContextStore.applyRippleDeletionsToTranscript(TRANSCRIPT_PID, seqKey, rippleIvs);
                  data._transcriptShifted = true;
                }
                var hasShift = norm.operations.some(function (o) {
                  return (
                    o.action === 'move_clip' ||
                    o.action === 'shift_timeline_ripple' ||
                    o.action === 'set_timeline_in' ||
                    o.action === 'set_timeline_out' ||
                    o.action === 'set_timeline_bounds' ||
                    o.action === 'remove_clip'
                  );
                });
                if (hasShift) {
                  ContextStore.markTranscriptStale(
                    TRANSCRIPT_PID,
                    seqKey,
                    'apply_edit_plan: ' + norm.operations.map(function (o) { return o.action; }).join(',')
                  );
                  data._transcriptPossiblyStale = true;
                }
              }
            } catch (eSh) {}
            resolve(data);
          });
        }
      );
    });
  }

  function execProposeMarkers(args) {
    var list = args.markers || [];
    var v = ToolValidators.validateMarkersList(lastSnap, list);
    if (v) return Promise.resolve({ validationError: v });
    _pendingProposal = {
      kind: 'markers',
      markers: list,
      summary: args.summary || '',
      snapshot: lastSnap,
      createdAt: Date.now()
    };
    renderPendingProposalCard();
    return Promise.resolve({
      ok: true,
      status: 'waiting_user_confirmation',
      message: 'Маркеры предложены пользователю. НЕ вызывай add_markers сам — это сделает UI.',
      markerCount: list.length
    });
  }

  function execFindMoments(args) {
    var key = _cleanSeqKey(args.sequenceKey);
    var q = args.query || '';
    var k = typeof args.k === 'number' ? args.k : 20;
    if (!key || !q) return Promise.resolve({ error: 'Нужны sequenceKey и query' });
    var found = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key);
    if (!found.entry) {
      return Promise.resolve({
        error: 'Нет кэша для «' + key + '». Сначала транскрибируйте.',
        availableKeysInCache: ContextStore.listTranscriptCacheKeys(TRANSCRIPT_PID).slice(0, 32)
      });
    }
    var e = found.entry;
    if (typeof TranscriptStructure !== 'undefined') {
      var needsRebuildFM = !e.paragraphs || !e.paragraphs.length ||
        (TranscriptStructure.isParagraphsStale && TranscriptStructure.isParagraphsStale(e));
      if (needsRebuildFM) {
        try {
          TranscriptStructure.buildStructure(e);
          ContextStore.setTranscriptEntry(TRANSCRIPT_PID, found.matchedKey, e);
        } catch (eR) {}
      }
    }
    var moments = FindMoments.find(e, q, { k: k });
    return Promise.resolve({
      ok: true,
      query: q,
      sequenceKey: found.matchedKey,
      count: moments.length,
      matchType: moments.length ? moments[0].matchType : null,
      moments: moments.map(function (m) {
        return {
          startSec: Math.round(m.startSec * 100) / 100,
          endSec: Math.round(m.endSec * 100) / 100,
          source: m.source,
          matchType: m.matchType,
          quote: String(m.text || '').slice(0, 240)
        };
      })
    });
  }

  /* ─── analyze_transcript_for_cuts: глубокий анализ через вторую модель ── */

  /* Локальный кэш анализа: { [sequenceKey + '|' + tasksKey]: {result, timestamp} } */
  var _analysisCache = {};
  var ANALYSIS_CACHE_TTL = 1800000; /* 30 мин */

  /* UI-2 (10 июня 2026, аудит 4.4): двухуровневый кэш. LLM-метки от
     aggressiveness НЕ зависят — кэшируем сырой результат analyzeForCutsWithLLM
     отдельно (ключ БЕЗ aggressiveness), фильтрация _shouldRemoveLabel дешёвая
     и выполняется на каждый запрос. Раньше normal→gentle = cache miss =
     повторный 3-5-минутный LLM-анализ. */
  var _labelsCache = {}; /* { [seqKey|tasksKey]: {raw, timestamp} } */
  /* Дедупликация параллельных LLM-анализов: если фоновый прекомпьют уже идёт,
     клик пользователя ждёт его promise, а не запускает второй анализ. */
  var _analysisInFlight = {}; /* { [seqKey|tasksKey]: Promise<rawResult> } */

  /* P0-1 (10 июня 2026): версия правок транскрипта в ключе кэша.
     applyRippleDeletionsToTranscript и markTranscriptStale пушат editHistory —
     после любого сдвига таймкодов editVer растёт, и старые метки/результаты
     (со старыми таймкодами) никогда не читаются. Также закрывает гонку:
     in-flight анализ, завершившийся ПОСЛЕ ripple, запишет результат под
     старым ключом и не будет отдан. TTL 30 мин чистит память. */
  function transcriptEditVersion(entry) {
    return (entry && entry.editHistory && entry.editHistory.length) || 0;
  }

  function labelsCacheKey(seqKey, tasks, editVer) {
    var tk = tasks ? tasks.slice().sort().join(',') : '*';
    return seqKey + '|v' + (editVer || 0) + '|' + tk;
  }

  function analysisCacheKey(seqKey, tasks, aggressiveness, editVer) {
    var tk = tasks ? tasks.slice().sort().join(',') : '*';
    var ag = aggressiveness || 'normal';
    return seqKey + '|v' + (editVer || 0) + '|' + tk + '|' + ag;
  }

  /**
   * Роутинг меток в toRemove по уровню агрессивности (US-003).
   * Делегирует в AnalysisRouting (../shared/analysis-routing.js) для testability;
   * inline-fallback на случай если модуль не подгрузился.
   */
  function _shouldRemoveLabel(label, aggressiveness) {
    if (typeof AnalysisRouting !== 'undefined' && AnalysisRouting.shouldRemoveLabel) {
      return AnalysisRouting.shouldRemoveLabel(label, aggressiveness);
    }
    if (label === 'content') return false;
    var mode = aggressiveness || 'normal';
    if (mode === 'gentle') return label === 'filler' || label === 'artifact';
    if (mode === 'aggressive') return label !== 'content';
    return label !== 'content' && label !== 'digression';
  }

  function execAnalyzeTranscriptForCuts(args) {
    var key = _cleanSeqKey(args.sequenceKey);
    var found = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key);
    if (!found.entry) {
      return Promise.resolve({
        error: 'Нет кэша для «' + key + '». Сначала транскрибируйте In–Out.',
        availableKeysInCache: ContextStore.listTranscriptCacheKeys(TRANSCRIPT_PID).slice(0, 32)
      });
    }
    var e = found.entry;

    /* Обеспечиваем наличие segments */
    if (!e.segments || !e.segments.length) {
      return Promise.resolve({ error: 'У транскрипта нет сегментов. Возможно, пустая транскрибация.' });
    }

    /* Строим paragraphs если нет ИЛИ если протухли (после edit'а) */
    if (typeof TranscriptStructure !== 'undefined') {
      var needsRebuildAT = !e.paragraphs || !e.paragraphs.length ||
        (TranscriptStructure.isParagraphsStale && TranscriptStructure.isParagraphsStale(e));
      if (needsRebuildAT) {
        try {
          TranscriptStructure.buildStructure(e);
          ContextStore.setTranscriptEntry(TRANSCRIPT_PID, found.matchedKey, e);
        } catch (eB) {}
      }
    }

    var tasks = Array.isArray(args.tasks) ? args.tasks : null;
    var forceRefresh = args.forceRefresh === true;
    /* UI-2 (аудит 4.1): фоновый прекомпьют не трогает статус-бар пользователя */
    var quiet = args._background === true;
    var aggressiveness = args.aggressiveness === 'gentle' || args.aggressiveness === 'aggressive'
      ? args.aggressiveness : 'normal';

    /* Проверяем кэш анализа (editVer — см. P0-1 выше) */
    var editVer = transcriptEditVersion(e);
    var cKey = analysisCacheKey(found.matchedKey, tasks, aggressiveness, editVer);
    if (!forceRefresh && _analysisCache[cKey] && (Date.now() - _analysisCache[cKey].timestamp < ANALYSIS_CACHE_TTL)) {
      if (!quiet) {
        statusUi.show('Анализ из кэша (повторный запрос)', false);
        setTimeout(function () { statusUi.hide(); }, 800);
      }
      return Promise.resolve(_analysisCache[cKey].result);
    }

    var settings = ContextStore.getResolvedSettings ? ContextStore.getResolvedSettings() : {};
    var segments = e.segments;

    /* UI-2: уровень 2 — сырые LLM-метки (без aggressiveness в ключе).
       Смена слайдера gentle↔normal↔aggressive = мгновенный re-filter,
       НЕ повторный LLM-анализ. */
    var lKey = labelsCacheKey(found.matchedKey, tasks, editVer);
    if (!forceRefresh && _labelsCache[lKey] && (Date.now() - _labelsCache[lKey].timestamp < ANALYSIS_CACHE_TTL)) {
      if (!quiet) {
        statusUi.show('Метки из кэша → фильтрация «' + aggressiveness + '» без повторного анализа', false);
        setTimeout(function () { statusUi.hide(); }, 1200);
      }
      var refiltered = _buildAnalysisResponse(_labelsCache[lKey].raw, segments, aggressiveness, found.matchedKey, settings, quiet);
      _analysisCache[cKey] = { result: refiltered, timestamp: Date.now() };
      return Promise.resolve(refiltered);
    }

    /* Дедуп: анализ с этим же ключом уже идёт (например, фоновый прекомпьют) —
       не запускаем второй LLM-проход, ждём общий promise сырых меток. */
    if (!forceRefresh && _analysisInFlight[lKey]) {
      if (!quiet) statusUi.show('Анализ уже идёт (фоновый прекомпьют) — подключаемся к нему…', true);
      return _analysisInFlight[lKey].then(function (raw) {
        var re = _buildAnalysisResponse(raw, segments, aggressiveness, found.matchedKey, settings, quiet);
        _analysisCache[cKey] = { result: re, timestamp: Date.now() };
        if (!quiet) {
          statusUi.show('Анализ завершён: удалить ' + re.toRemove.length + ' из ' + raw.totalSegments + ' сегментов', false);
          setTimeout(function () { statusUi.hide(); }, 2000);
        }
        return re;
      });
    }

    /* Подготавливаем сегменты для анализа */
    var segmentsForAnalysis = segments.map(function (s, i) {
      return {
        i: i,
        startSec: typeof s.startSec === 'number' ? s.startSec : (s.start || 0),
        endSec: typeof s.endSec === 'number' ? s.endSec : (s.end || 0),
        text: String(s.text || '')
      };
    });

    /* P0-3: Используем pre-computed labels если есть */
    var preLabels = null;
    if (e.preAnalysis && e.preAnalysis.labels && e.preAnalysis.labels.length) {
      preLabels = e.preAnalysis.labels;
      if (!quiet) statusUi.show('Используем ' + preLabels.length + ' pre-computed меток + LLM для остальных (' + segmentsForAnalysis.length + ' сегментов)…', true);
    } else {
      if (!quiet) statusUi.show('Запуск анализа транскрипта (' + segmentsForAnalysis.length + ' сегментов)…', true);
    }

    var rawPromise = TranscriptStructure.analyzeForCutsWithLLM(
      segmentsForAnalysis,
      {
        settings: settings,
        CloudRuClient: typeof CloudRuClient !== 'undefined' ? CloudRuClient : null,
        signal: runAbort ? runAbort.signal : null,
        abortCheck: runAbort ? function () { return runAbort.aborted; } : null,
        tasks: tasks,
        preLabels: preLabels,
        onProgress: function (ev) {
          /* MEDIUM #12 (6 мая 2026): прогресс-бар по чанкам анализа.
             chunkIndex/totalChunks → точный %, иначе indeterminate. */
          if (quiet) return;
          statusUi.show(ev.message || 'Анализ…', true);
          if (ev && typeof ev.totalChunks === 'number' && ev.totalChunks > 0 &&
              typeof ev.chunkIndex === 'number') {
            var frac = ev.phase === 'chunk_done'
              ? ev.chunkIndex / ev.totalChunks
              : Math.max(0, (ev.chunkIndex - 1)) / ev.totalChunks;
            statusUi.progress(frac * 100);
          } else if (ev && (ev.phase === 'local_done' || ev.phase === 'done')) {
            statusUi.progress(100);
          } else {
            statusUi.progress(null);
          }
        }
      }
    ).then(function (result) {
      /* UI-2: сырые метки → кэш уровня 2 (re-filter слайдером без LLM) */
      _labelsCache[lKey] = { raw: result, timestamp: Date.now() };
      return result;
    });

    _analysisInFlight[lKey] = rawPromise;
    rawPromise.then(
      function () { delete _analysisInFlight[lKey]; },
      function () { delete _analysisInFlight[lKey]; }
    );

    return rawPromise.then(function (result) {
      var finalResult = _buildAnalysisResponse(result, segments, aggressiveness, found.matchedKey, settings, quiet);

      /* Сохраняем в кэш уровня 1 (готовый ответ для конкретного aggressiveness) */
      _analysisCache[cKey] = { result: finalResult, timestamp: Date.now() };

      if (!quiet) {
        statusUi.show('Анализ завершён: удалить ' + finalResult.toRemove.length + ' из ' + result.totalSegments + ' сегментов', false);
        setTimeout(function () { statusUi.hide(); }, 2000);
      }

      return finalResult;
    });
  }

  /**
   * Пост-обработка сырого результата analyzeForCutsWithLLM → ответ для агента.
   * Вынесено из execAnalyzeTranscriptForCuts (UI-2), чтобы повторная фильтрация
   * по другому aggressiveness шла из _labelsCache без LLM-вызова.
   */
  function _buildAnalysisResponse(result, segments, aggressiveness, sequenceKey, settings, quiet) {
    /* Формируем удобный ответ для агента — на уровне сегментов */
    var toRemove = [];
    var toKeep = [];
    for (var ri = 0; ri < result.labels.length; ri++) {
      var lb = result.labels[ri];
        var seg = segments[lb.i];
        if (!seg) continue;
        var startSec = typeof seg.startSec === 'number' ? seg.startSec : (seg.start || 0);
        var endSec = typeof seg.endSec === 'number' ? seg.endSec : (seg.end || 0);
        var entry = {
          i: lb.i,
          label: lb.label,
          reason: lb.reason,
          startSec: startSec,
          endSec: endSec,
          textPreview: String(seg.text || '').split(/\s+/).slice(0, 15).join(' ')
        };
        if (_shouldRemoveLabel(lb.label, aggressiveness)) {
          toRemove.push(entry);
        } else {
          toKeep.push(entry);
        }
      }

      /* Группируем смежные toRemove сегменты в интервалы для удобства */
      var removeIntervals = [];
      if (toRemove.length) {
        toRemove.sort(function (a, b) { return a.startSec - b.startSec; });
        var cur = { startSec: toRemove[0].startSec, endSec: toRemove[0].endSec,
                    segments: [toRemove[0]], reasons: [toRemove[0].label + ': ' + (toRemove[0].reason || '')] };
        for (var gi = 1; gi < toRemove.length; gi++) {
          var gap = toRemove[gi].startSec - cur.endSec;
          if (gap <= 0.3) {
            /* Смежные или перекрывающиеся — объединяем */
            cur.endSec = Math.max(cur.endSec, toRemove[gi].endSec);
            cur.segments.push(toRemove[gi]);
            cur.reasons.push(toRemove[gi].label + ': ' + (toRemove[gi].reason || ''));
          } else {
            removeIntervals.push({
              startSec: cur.startSec,
              endSec: cur.endSec,
              reason: cur.reasons.slice(0, 3).join('; ') + (cur.reasons.length > 3 ? ' +' + (cur.reasons.length - 3) : ''),
              segmentCount: cur.segments.length
            });
            cur = { startSec: toRemove[gi].startSec, endSec: toRemove[gi].endSec,
                    segments: [toRemove[gi]], reasons: [toRemove[gi].label + ': ' + (toRemove[gi].reason || '')] };
          }
        }
        removeIntervals.push({
          startSec: cur.startSec,
          endSec: cur.endSec,
          reason: cur.reasons.slice(0, 3).join('; ') + (cur.reasons.length > 3 ? ' +' + (cur.reasons.length - 3) : ''),
          segmentCount: cur.segments.length
        });
      }

      /* Прозрачность для агента и пользователя: сбойные чанки не должны быть
         «невидимой грязью». Если хотя бы один чанк упал — LLM должен знать,
         что для missedSegments получил content по умолчанию (не настоящую метку). */
      var failedChunks = Array.isArray(result.failedChunks) ? result.failedChunks : [];
      var missedSegments = typeof result.missedSegments === 'number' ? result.missedSegments : 0;
      if (failedChunks.length > 0 && !quiet && typeof statusUi !== 'undefined') {
        statusUi.show(
          '⚠ Анализ: ' + failedChunks.length + ' чанк(ов) не разобрано (~' + missedSegments +
          ' сегм. помечены как content по умолчанию). Предложение может быть неточным.',
          false
        );
      }

      var finalResult = {
        ok: true,
        sequenceKey: sequenceKey,
        totalSegments: result.totalSegments,
        chunksUsed: result.chunks,
        analysisModel: settings.analysisModel || settings.activeAgentModel || settings.chatModel,
        aggressiveness: aggressiveness,
        stats: result.stats,
        removeIntervals: removeIntervals,
        toRemove: toRemove,
        toKeep: toKeep,
        /* Проброс в UI и в LLM-ответ tool-result'ом, чтобы агент
           мог в ответе пользователю упомянуть снижение точности. */
        failedChunks: failedChunks,
        missedSegments: missedSegments,
        _hint: removeIntervals.length
          ? 'removeIntervals уже готовы для propose_transcript_cuts. ' +
            'Используй их напрямую: startSec/endSec выровнены по границам сегментов Whisper. ' +
            'Сформируй keepSummary и removeSummary из toKeep/toRemove.'
          : 'Анализ не нашёл сегментов для удаления. Транскрипт чистый.'
      };

      return finalResult;
  }

  function _findClipInSnap(nodeId) {
    if (!lastSnap || !lastSnap.clips || !nodeId) return null;
    for (var i = 0; i < lastSnap.clips.length; i++) {
      if (String(lastSnap.clips[i].nodeId) === String(nodeId)) return lastSnap.clips[i];
    }
    return null;
  }

  function execProposeAudioDucking(args) {
    var key = _cleanSeqKey(args.sequenceKey);
    var targetNodeId = args.targetNodeId || '';
    if (!targetNodeId) {
      return Promise.resolve({
        validationError: 'Нужен targetNodeId — nodeId музыкального клипа из get_timeline_snapshot.'
      });
    }
    if (!lastSnap || !lastSnap.ok) {
      return Promise.resolve({ error: 'Сначала вызовите get_timeline_snapshot.' });
    }
    var clip = _findClipInSnap(targetNodeId);
    if (!clip) {
      return Promise.resolve({ error: 'Клип ' + targetNodeId + ' не найден в текущем снимке.' });
    }
    if (clip.trackType !== 'audio') {
      return Promise.resolve({ error: 'Клип ' + targetNodeId + ' не аудио-клип (' + clip.trackType + ').' });
    }
    if (!clip.mediaPath) {
      return Promise.resolve({ error: 'У клипа нет mediaPath — рендер невозможен. Возможно вложенная секвенция или генератор.' });
    }
    var found = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key);
    if (!found.entry) {
      return Promise.resolve({ error: 'Нет кэша транскрипта для «' + key + '». Сначала транскрибируйте.' });
    }
    var e = found.entry;
    if ((!e.paragraphs || !e.paragraphs.length) && typeof TranscriptStructure !== 'undefined') {
      try { TranscriptStructure.buildStructure(e); } catch (eR) {}
    }
    if (!e.paragraphs || !e.paragraphs.length) {
      return Promise.resolve({ error: 'Не удалось построить параграфы из транскрипта.' });
    }
    /* Берём только параграфы, попадающие в диапазон клипа на таймлайне. */
    var ivs = [];
    for (var pi = 0; pi < e.paragraphs.length; pi++) {
      var p = e.paragraphs[pi];
      var s = Math.max(p.startSec, clip.startSec);
      var en = Math.min(p.endSec, clip.endSec);
      if (en > s + 0.05) ivs.push({ startSec: s, endSec: en });
    }
    if (!ivs.length) {
      return Promise.resolve({ error: 'Речевые интервалы не пересекаются с клипом «' + (clip.name || targetNodeId) + '».' });
    }
    var plan = AudioDucking.computeDucking(ivs, {
      duckDb: typeof args.duckDb === 'number' ? args.duckDb : -12,
      fadeInSec: typeof args.fadeInSec === 'number' ? args.fadeInSec : 0.15,
      fadeOutSec: typeof args.fadeOutSec === 'number' ? args.fadeOutSec : 0.3
    });
    _pendingProposal = {
      kind: 'audio_ducking',
      duckingPlan: plan,
      sequenceKey: found.matchedKey,
      target: {
        nodeId: clip.nodeId,
        name: clip.name,
        mediaPath: clip.mediaPath,
        startSec: clip.startSec,
        endSec: clip.endSec,
        inPointSec: clip.inPointSec || 0,
        trackIndex: clip.trackIndex
      },
      duckDb: typeof args.duckDb === 'number' ? args.duckDb : -12,
      fadeSec: Math.max(args.fadeInSec || 0.15, args.fadeOutSec || 0.3),
      summary: args.summary || ('Ducking ' + plan.summary.duckDb + ' dB на «' + (clip.name || targetNodeId) + '» (' + plan.summary.intervalCount + ' речевых интервалов)'),
      snapshot: lastSnap,
      createdAt: Date.now()
    };
    renderPendingProposalCard();
    return Promise.resolve({
      ok: true,
      status: 'waiting_user_confirmation',
      summary: plan.summary,
      target: { nodeId: clip.nodeId, name: clip.name, mediaPath: clip.mediaPath },
      message: 'План ducking показан пользователю. По «Применить» плагин рендерит новый WAV через ffmpeg и импортирует в bin "AI Renders".'
    });
  }

  function execProposeLoudness(args) {
    var key = _cleanSeqKey(args.sequenceKey);
    var targetNodeId = args.targetNodeId || '';
    if (!targetNodeId) {
      return Promise.resolve({ validationError: 'Нужен targetNodeId — nodeId речевого клипа.' });
    }
    if (!lastSnap || !lastSnap.ok) {
      return Promise.resolve({ error: 'Сначала вызовите get_timeline_snapshot.' });
    }
    var clip = _findClipInSnap(targetNodeId);
    if (!clip) {
      return Promise.resolve({ error: 'Клип ' + targetNodeId + ' не найден.' });
    }
    if (clip.trackType !== 'audio') {
      return Promise.resolve({ error: 'Клип ' + targetNodeId + ' не аудио (' + clip.trackType + ').' });
    }
    if (!clip.mediaPath) {
      return Promise.resolve({ error: 'У клипа нет mediaPath — рендер невозможен.' });
    }
    var found = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key);
    var loud = found.entry && found.entry.audioAnalysis && found.entry.audioAnalysis.loudness;
    var targetLufs = typeof args.targetLufs === 'number' ? args.targetLufs : -16;
    /* Расчёт через AudioDucking — справочный, для карточки. ffmpeg loudnorm всё равно
       измерит и применит сам. */
    var res = loud ? AudioDucking.computeLoudnessGain(loud, { targetLufs: targetLufs }) : null;
    _pendingProposal = {
      kind: 'loudness',
      loudness: res || { ok: false, targetLufs: targetLufs, inputLufs: null, gainDb: null },
      sequenceKey: (found && found.matchedKey) || key,
      target: {
        nodeId: clip.nodeId,
        name: clip.name,
        mediaPath: clip.mediaPath,
        startSec: clip.startSec,
        endSec: clip.endSec
      },
      targetLufs: targetLufs,
      summary:
        'LUFS-нормализация «' + (clip.name || targetNodeId) + '» → ' + targetLufs + ' LUFS' +
        (res && res.ok ? ' (расчётный gain ' + (res.gainDb >= 0 ? '+' : '') + res.gainDb + ' dB)' : ' — ffmpeg loudnorm измерит и применит'),
      createdAt: Date.now()
    };
    renderPendingProposalCard();
    return Promise.resolve({
      ok: true,
      status: 'waiting_user_confirmation',
      result: res,
      target: { nodeId: clip.nodeId, name: clip.name },
      message: 'Карточка LUFS показана. По «Применить» ffmpeg loudnorm рендерит новый WAV и импортирует в bin "AI Renders".'
    });
  }

  function execApplyTranscriptCuts(panelId, args) {
    /* Safety-guard: без явного «без подтверждения» — показываем карточку. */
    if (!_directApplyAuthorized) {
      return Promise.resolve(execProposeTranscriptCuts(args)).then(function (r) {
        return Object.assign({ _redirectedToPropose: true,
          message: 'Прямое применение без подтверждения запрещено. Показал карточку propose_transcript_cuts — пользователь нажмёт «Применить». Заверши ход.' },
          (r && typeof r === 'object') ? r : {});
      });
    }
    return new Promise(function (resolve, reject) {
      var vr = ToolValidators.validateTranscriptCuts(lastSnap, args);
      if (vr.error) {
        resolve({ validationError: vr.error });
        return;
      }
      /* Snap к границам сегментов + merge перекрытий (host не merge'ит) */
      args = Object.assign({}, args, {
        removeIntervals: mergeRemoveIntervals(snapIntervalsToSegmentBoundaries(args.removeIntervals || []))
      });
      var verification = computeVerification(args.removeIntervals);
      /* B2-9: checkpoint и на агентском пути apply */
      _makeSequenceCheckpoint('монтаж по тексту (агент)', function () {
      PremiereBridge.applyTranscriptCuts(args, function (err, data) {
        if (err) {
          reject(err);
          return;
        }
        /* Откат монтажа по тексту средствами плагина не реализован — Cmd+Z в таймлайне Premiere вручную. */
        if (vr.warn) {
          if (data && typeof data === 'object') data.validatorWarn = vr.warn;
          else data = { raw: data, validatorWarn: vr.warn };
        }
        if (data && typeof data === 'object') data._verification = verification;
        PremiereBridge.getTimelineSnapshot(function (snapErr, snapData) {
          if (!snapErr && snapData && snapData.ok) lastSnap = snapData;
          data._autoSnapshot = snapData || null;
          try {
            var seqKey = (snapData && snapData.sequenceName) || (lastSnap && lastSnap.sequenceName) || '';
            if (seqKey) {
              ContextStore.applyRippleDeletionsToTranscript(TRANSCRIPT_PID, seqKey, args.removeIntervals || []);
              data._transcriptShifted = true;
            }
          } catch (eSh2) {}
          resolve(data);
        });
      });
      }); /* конец _makeSequenceCheckpoint */
    });
  }

  /* ─── Сборщики executors по пресету ─────────────────────────────── */

  function buildExecutorsForPreset(preset) {
    var pid = preset.panelId;
    /* Единый набор: все экзекуторы доступны всегда */
    return {
      get_timeline_snapshot: execGetSnapshot,
      get_transcript_from_cache: execGetTranscriptFromCache,
      get_transcript_structure: execGetTranscriptStructure,
      /* таймкоды */
      apply_timecode_edits: function (args) { return execApplyTimecodeEdits(pid, args); },
      propose_timecode_edits: execProposeTimecodeEdits,
      dry_run_edit_plan: execDryRunEditPlan,
      /* EditPlan (§2.1) */
      propose_edit_plan: execProposeEditPlan,
      apply_edit_plan: function (args) { return execApplyEditPlan(pid, args); },
      /* текст */
      propose_transcript_cuts: execProposeTranscriptCuts,
      apply_transcript_cuts: function (args) { return execApplyTranscriptCuts(pid, args); },
      /* маркеры */
      add_markers: function (args) { return execAddMarkers(pid, args); },
      propose_markers: execProposeMarkers,
      /* поиск + аудио */
      find_moments: execFindMoments,
      analyze_transcript_for_cuts: execAnalyzeTranscriptForCuts,
      propose_audio_ducking: execProposeAudioDucking,
      propose_loudness_normalization: execProposeLoudness
    };
  }

  /* ─── Единый пресет (все функции в одном чате) ────────────────────── */

  var UNIFIED_PRESET = {
    id: 'unified',
    panelId: 'unified',
    label: 'ИИ: монтаж',
    sub: 'Таймкоды · Текст · Маркеры · Аудио — один чат. Откат правок таймлайна: Cmd+Z / Ctrl+Z в Premiere.',
    sysprompt: function () {
      return AgentPrompts.unified;
    },
    tools: TOOLS_UNIFIED,
    hintsKey: 'unified',
    placeholder: 'Опишите задачу обычными словами…'
  };

  /* Legacy aliases для совместимости */
  var PRESETS = {
    unified: UNIFIED_PRESET,
    timecode: UNIFIED_PRESET,
    textmontage: UNIFIED_PRESET,
    markers: UNIFIED_PRESET
  };

  var active = UNIFIED_PRESET;

  /* ─── Render history ────────────────────────────────────────────── */

  /* UI-волна (10 июня 2026): smart scroll — не дёргаем чат вниз, если
     пользователь прокрутил вверх читать историю (аудит: «forced scroll»). */
  function chatNearBottom() {
    return (el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight) < 60;
  }

  /* Безопасный markdown для пузырей ассистента; для остальных — textContent. */
  function setBubbleBody(bodyEl, role, text) {
    if (role === 'assistant' && window.MarkdownLite && text) {
      bodyEl.innerHTML = MarkdownLite.render(text);
      _linkifyTimecodes(bodyEl);
    } else {
      bodyEl.textContent = text || '';
    }
  }

  /* B1-1b (12 июня 2026): кликабельные таймкоды в свободном тексте ответов
   * ассистента. LLM пишет «763 – 778 сек», «12 мин 43 сек», «21:54», «1304с» —
   * превращаем в те же _tcJumpEl-спаны (прыжок плейхеда), что и в
   * proposal-картах. Live-валидация 12 июня: ответы чата содержат точные
   * таймкоды, но пользователю приходилось листать таймлайн вручную.
   * ВАЖНО: \b в JS-regex не работает с кириллицей (с/сек — не \w),
   * границы — через (?![а-яёa-z0-9]). */
  var TC_TEXT_RE = new RegExp(
    /* 1,2: диапазон «763 – 778 сек» (обе границы кликабельны) */
    '(\\d+(?:[.,]\\d+)?)\\s*[\u2013\u2014-]\\s*(\\d+(?:[.,]\\d+)?)\\s*\u0441(?:\u0435\u043a)?(?![\u0430-\u044f\u0451a-z0-9])' +
    /* 3,4: «12 мин 43 сек» */
    '|(\\d+)\\s*\u043c\u0438\u043d(?:\u0443\u0442[\u0430-\u044f\u0451]*)?\\.?\\s*(\\d+)\\s*\u0441(?:\u0435\u043a)?(?![\u0430-\u044f\u0451a-z0-9])' +
    /* 5,6,7: «1:02:33» */
    '|(\\d{1,2}):(\\d{2}):(\\d{2})(?!\\d)' +
    /* 8,9: «21:54» */
    '|(\\d{1,3}):(\\d{2})(?![\\d:])' +
    /* 10: «1304с» / «39.2 сек» */
    '|(\\d+(?:[.,]\\d+)?)\\s*\u0441(?:\u0435\u043a)?(?![\u0430-\u044f\u0451a-z0-9])',
    'gi'
  );
  function _tcNum(s) {
    return parseFloat(String(s).replace(',', '.'));
  }
  function _tcSpan(sec, label) {
    var sp = _tcJumpEl(sec, label);
    sp.setAttribute('data-tc', '1');
    return sp;
  }
  function _linkifyTextNode(node) {
    var text = node.nodeValue;
    TC_TEXT_RE.lastIndex = 0;
    var m, last = 0, frag = null;
    while ((m = TC_TEXT_RE.exec(text))) {
      /* нет lookbehind в ES5: «2021:30» не должен дать «021:30» */
      if (m.index > 0 && /[\d:.,]/.test(text.charAt(m.index - 1))) continue;
      var parts;
      if (m[1] !== undefined) {
        var sepIdx = text.indexOf(m[2], m.index + m[1].length) - m.index;
        parts = [
          { sec: _tcNum(m[1]), label: m[0].slice(0, m[1].length) },
          m[0].slice(m[1].length, sepIdx),
          { sec: _tcNum(m[2]), label: m[0].slice(sepIdx) }
        ];
      } else if (m[3] !== undefined) {
        parts = [{ sec: parseInt(m[3], 10) * 60 + parseInt(m[4], 10), label: m[0] }];
      } else if (m[5] !== undefined) {
        parts = [{ sec: (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]), label: m[0] }];
      } else if (m[8] !== undefined) {
        parts = [{ sec: (+m[8]) * 60 + (+m[9]), label: m[0] }];
      } else {
        parts = [{ sec: _tcNum(m[10]), label: m[0] }];
      }
      /* бессмыслица (NaN, >12 часов) — не кликаем */
      var bad = false;
      for (var pi = 0; pi < parts.length; pi++) {
        var pp = parts[pi];
        if (typeof pp === 'object' && (!isFinite(pp.sec) || pp.sec < 0 || pp.sec > 43200)) bad = true;
      }
      if (bad) continue;
      if (!frag) frag = document.createDocumentFragment();
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      for (var pj = 0; pj < parts.length; pj++) {
        var pt = parts[pj];
        frag.appendChild(typeof pt === 'string' ? document.createTextNode(pt) : _tcSpan(pt.sec, pt.label));
      }
      last = m.index + m[0].length;
    }
    if (!frag) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  function _linkifyTimecodes(rootEl) {
    if (!rootEl || !document.createTreeWalker) return;
    var SKIP = { A: 1, CODE: 1, PRE: 1, BUTTON: 1, SELECT: 1, TEXTAREA: 1 };
    var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    while (walker.nextNode()) {
      var n = walker.currentNode;
      var p = n.parentNode;
      var skip = false;
      while (p && p !== rootEl) {
        if (SKIP[p.tagName] || (p.getAttribute && p.getAttribute('data-tc'))) { skip = true; break; }
        p = p.parentNode;
      }
      if (!skip && /\d/.test(n.nodeValue)) nodes.push(n);
    }
    /* replaceChild ломает живой обход — собираем список заранее */
    for (var i = 0; i < nodes.length; i++) _linkifyTextNode(nodes[i]);
  }

  /* Живой пузырь стриминга: создаётся на первом chunk'е, обновляется
     накопленным текстом, удаляется при финальном renderMessages. */
  var _streamBubble = null;
  function ensureStreamBubble() {
    if (!_streamBubble || !_streamBubble.parentNode) {
      _streamBubble = document.createElement('div');
      _streamBubble.className = 'bubble assistant streaming';
      var sRole = document.createElement('div');
      sRole.className = 'role';
      sRole.textContent = 'assistant · печатает…';
      _streamBubble.appendChild(sRole);
      var sBody = document.createElement('div');
      sBody.className = 'bubble-body';
      _streamBubble.appendChild(sBody);
      el.chat.appendChild(_streamBubble);
      if (chatNearBottom()) el.chat.scrollTop = el.chat.scrollHeight;
    }
    return _streamBubble;
  }
  function updateStreamBubble(accumulated) {
    ensureStreamBubble();
    var wasNear = chatNearBottom();
    setBubbleBody(_streamBubble.querySelector('.bubble-body'), 'assistant', accumulated);
    if (wasNear) el.chat.scrollTop = el.chat.scrollHeight;
  }
  function removeStreamBubble() {
    stopWaitIndicator();
    if (_streamBubble && _streamBubble.parentNode) _streamBubble.parentNode.removeChild(_streamBubble);
    _streamBubble = null;
  }

  /* ETA-индикатор (10 июня 2026): GLM-5.1 с thinking может «молчать» 30+ сек.
     Показываем в пузыре live-таймер «думает… Nс» + ожидаемое время из
     AgentLoopStats (EMA прошлых ответов модели), чтобы пользователь не думал,
     что панель зависла. */
  var _waitTicker = null;
  function startWaitIndicator(model, etaMs) {
    stopWaitIndicator();
    ensureStreamBubble();
    var roleEl = _streamBubble.querySelector('.role');
    var startTs = Date.now();
    var etaTxt = etaMs ? ' · обычно ~' + Math.max(1, Math.round(etaMs / 1000)) + 'с' : '';
    function tick() {
      if (!_streamBubble || !roleEl) return;
      var sec = Math.round((Date.now() - startTs) / 1000);
      roleEl.textContent = 'assistant · модель думает… ' + sec + 'с' + etaTxt;
    }
    tick();
    _waitTicker = setInterval(tick, 1000);
  }
  function stopWaitIndicator(roleText) {
    if (_waitTicker) { clearInterval(_waitTicker); _waitTicker = null; }
    if (roleText && _streamBubble) {
      var r = _streamBubble.querySelector('.role');
      if (r) r.textContent = roleText;
    }
  }

  function renderMessages(msgs) {
    var wasNearBottom = chatNearBottom();
    removeStreamBubble();
    el.chat.innerHTML = '';
    msgs.forEach(function (m) {
      if (m.role === 'system') return;

      var isToolRole = m.role === 'tool';
      var isAssistantToolCalls = m.role === 'assistant' && m.tool_calls && !m.content;
      var collapsible = isToolRole || isAssistantToolCalls;

      var div = document.createElement('div');
      div.className =
        'bubble ' +
        (m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'tool') +
        (collapsible ? ' collapsible collapsed' : '');

      var role = document.createElement('div');
      role.className = 'role';

      if (collapsible) {
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'bubble-toggle';
        toggle.textContent = '▸';
        var label = isAssistantToolCalls
          ? 'assistant · tools (' +
            m.tool_calls
              .map(function (t) {
                return t.function.name;
              })
              .join(', ') +
            ')'
          : 'tool result';
        var roleText = document.createElement('span');
        roleText.textContent = label;
        toggle.onclick = function () {
          var isCollapsed = div.classList.toggle('collapsed');
          toggle.textContent = isCollapsed ? '▸' : '▾';
        };
        role.appendChild(toggle);
        role.appendChild(roleText);
      } else {
        role.textContent = m.role + (m.tool_calls ? ' · tools' : '');
      }
      div.appendChild(role);

      var body = document.createElement('div');
      body.className = 'bubble-body';
      var bodyText =
        m.content ||
        (m.tool_calls
          ? JSON.stringify(
              m.tool_calls.map(function (t) {
                return t.function.name;
              })
            )
          : '');
      /* Markdown — только для развёрнутых ответов ассистента (не tool-результатов) */
      setBubbleBody(body, collapsible ? 'tool' : m.role, bodyText);
      div.appendChild(body);
      el.chat.appendChild(div);
    });
    /* Пустой чат → welcome-карточка «что умеет плагин» (12 июня 2026).
       Исчезает с первым сообщением, возвращается после «Очистить чат». */
    if (!el.chat.children.length && !_pendingProposal) renderWelcomeCard();
    if (_pendingProposal) renderPendingProposalCard();
    /* Скроллим вниз только если пользователь и так был внизу,
       либо последнее сообщение — его собственное (только что отправил). */
    var lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
    if (wasNearBottom || (lastMsg && lastMsg.role === 'user')) {
      el.chat.scrollTop = el.chat.scrollHeight;
    }
  }

  /* ── Welcome-карточка пустого чата: что умеет плагин (12 июня 2026) ──
     Рендерится в #chat когда нет ни одного видимого сообщения и нет proposal.
     Клик по примеру вставляет текст в input (паттерн стартеров). */
  var WELCOME_ITEMS = [
    '🎙 Транскрибация In–Out — кнопка сверху; после неё доступны команды по тексту',
    '✂️ Монтаж по тексту: «убери паразитов», «уложи в 60 секунд», «вырежи вступление»',
    '🏷️ Маркеры и главы: «поставь YouTube-главы», «отметь хайлайты»',
    '🔍 Поиск моментов: «найди, где говорят про…» — таймкоды в ответах кликабельны, клик двигает плейхед',
    '🛠 Тишины · Паразиты · Jump cuts · Авто-главы · Авто-MultiCam — вкладка «Инструменты»',
    '⏪ Перед каждым применением создаётся чекпоинт-секвенция — можно откатить'
  ];
  var WELCOME_EXAMPLES = [
    'Что на таймлайне?',
    'Убери паразитов и тишины',
    'Поставь маркеры на главы',
    'Найди момент, где говорят про '
  ];
  function renderWelcomeCard() {
    var card = document.createElement('div');
    card.className = 'welcome-card';

    var title = document.createElement('div');
    title.className = 'welcome-title';
    title.textContent = '👋 ИИ-ассистент монтажа — что умеет панель';
    card.appendChild(title);

    var ul = document.createElement('ul');
    ul.className = 'welcome-list';
    for (var i = 0; i < WELCOME_ITEMS.length; i++) {
      var li = document.createElement('li');
      li.textContent = WELCOME_ITEMS[i];
      ul.appendChild(li);
    }
    card.appendChild(ul);

    var exTitle = document.createElement('div');
    exTitle.className = 'welcome-examples-title';
    exTitle.textContent = 'Попробуй:';
    card.appendChild(exTitle);

    var row = document.createElement('div');
    row.className = 'welcome-examples';
    WELCOME_EXAMPLES.forEach(function (txt) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'welcome-example';
      b.textContent = txt.replace(/\s+$/, '') + (/\s$/.test(txt) ? '…' : '');
      b.onclick = function () {
        el.input.value = txt;
        el.input.focus();
      };
      row.appendChild(b);
    });
    card.appendChild(row);

    el.chat.appendChild(card);
  }

  /* ─── Hint chips / starters / transcribe LED ─────────────────────── */

  /* ── Активная категория стартеров (collapsible UI, 7 мая 2026 evening) ─
     Свёрнуты по умолчанию: только chips-заголовки видны. Клик разворачивает.
     Состояние храним в localStorage чтобы между сессиями помнило. */
  var STARTER_CATS = [
    { id: 'text',    label: '📝 По тексту',  panelId: 'textmontage', hintGroup: 'text' },
    { id: 'markers', label: '🏷️ Маркеры',    panelId: 'markers',     hintGroup: 'markers' },
    { id: 'search',  label: '🔍 Поиск',      panelId: 'search',      hintGroup: null /* нет hints */ }
  ];
  var _expandedCat = null; /* id развёрнутой категории, null = все свёрнуты */
  try {
    _expandedCat = localStorage.getItem('extllmpr_v1_expanded_cat');
    if (_expandedCat === 'null' || _expandedCat === '') _expandedCat = null;
  } catch (e) {
    console.warn('[panel] localStorage read for expanded_cat failed:', e && e.message);
  }

  /* Hint-chips теперь рендерятся ВНУТРИ развёрнутой категории, не отдельно */
  function rebuildHintChips() {
    if (!el.hintBox) return;
    el.hintBox.innerHTML = ''; /* hint-box больше не используется как отдельная строка */
  }

  /**
   * UI compact v3 (7 мая 2026 evening): collapsible-карточки категорий.
   *
   * Свёрнутый вид: одна строка из 3 кнопок-категорий (📝 По тексту / 🏷️ Маркеры / 🔍 Поиск).
   * Развёрнутый вид (после клика): под выбранной категорией — её стартеры + UiHints
   * группы. Клик по любому chip заполняет input. Клик на ту же категорию свёрнёт.
   *
   * Преимущества: ~28px по высоте в свёрнутом виде, hint-chips живут внутри
   * группы (не дублируются как отдельная строка).
   */
  function _selectStarter(s, panelId) {
    el.input.value = s.userPrompt || '';
    el.input.focus();
    if (s.systemPromptAddon) _activeSystemAddon = s.systemPromptAddon;
  }

  function _selectHint(h) {
    el.input.value = h.text || '';
    el.input.focus();
  }

  function _setExpandedCat(catId) {
    _expandedCat = catId;
    try { localStorage.setItem('extllmpr_v1_expanded_cat', catId == null ? '' : String(catId)); } catch (e) {}
    rebuildStarters();
  }

  function rebuildStarters() {
    if (!el.startersBox) return;
    el.startersBox.innerHTML = '';
    if (typeof ConversationStarters === 'undefined') return;

    var headerRow = document.createElement('div');
    headerRow.className = 'starters-cats-row';
    el.startersBox.appendChild(headerRow);

    STARTER_CATS.forEach(function (cat) {
      var catBtn = document.createElement('button');
      catBtn.type = 'button';
      catBtn.className = 'starters-cat' + (_expandedCat === cat.id ? ' starters-cat--open' : '');
      catBtn.setAttribute('aria-expanded', _expandedCat === cat.id ? 'true' : 'false');
      catBtn.setAttribute('data-cat', cat.id);
      var arrow = _expandedCat === cat.id ? '▾' : '▸';
      catBtn.textContent = arrow + ' ' + cat.label;
      catBtn.onclick = function () {
        _setExpandedCat(_expandedCat === cat.id ? null : cat.id);
      };
      headerRow.appendChild(catBtn);
    });

    /* Развёрнутая панель */
    if (!_expandedCat) return;
    var expandedCat = STARTER_CATS.filter(function (c) { return c.id === _expandedCat; })[0];
    if (!expandedCat) return;

    var panel = document.createElement('div');
    panel.className = 'starters-cat-panel';
    el.startersBox.appendChild(panel);

    var inner = document.createElement('div');
    inner.className = 'starters-row starters-row--flat';
    panel.appendChild(inner);

    /* «+» кнопка — добавить свой стартер в эту категорию */
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'starter-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Создать свой стартер';
    addBtn.onclick = function () {
      var tmp = document.createElement('div');
      document.body.appendChild(tmp);
      StartersUI.init(expandedCat.panelId, {
        container: tmp,
        onUse: function () {},
        onError: function (msg) { showErr(msg); setTimeout(function () { showErr(''); }, 4000); }
      });
      var realAdd = tmp.querySelector('.starter-add-btn');
      if (realAdd) realAdd.click();
      setTimeout(function () { tmp.remove(); rebuildStarters(); }, 100);
    };
    inner.appendChild(addBtn);

    /* Стартеры из этой категории */
    var starters;
    try { starters = ConversationStarters.getAll(expandedCat.panelId) || []; } catch (e) { starters = []; }
    starters.forEach(function (s) {
      var card = document.createElement('div');
      card.className = 'starter-card';
      card.title = s.description ? (s.name + ' — ' + s.description) : (s.userPrompt || '');
      var nameSpan = document.createElement('span');
      nameSpan.className = 'starter-card-name';
      nameSpan.textContent = s.name;
      card.appendChild(nameSpan);
      card.onclick = function (e) {
        if (e.target.classList && (e.target.classList.contains('starter-edit-btn') || e.target.classList.contains('starter-del-btn'))) return;
        _selectStarter(s, expandedCat.panelId);
      };
      if (!s.builtin) {
        var acts = document.createElement('span');
        acts.className = 'starter-card-actions';
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'starter-del-btn';
        delBtn.innerHTML = '&times;';
        delBtn.title = 'Удалить';
        delBtn.onclick = function (ev) {
          ev.stopPropagation();
          ConversationStarters.remove(expandedCat.panelId, s.id);
          rebuildStarters();
        };
        acts.appendChild(delBtn);
        card.appendChild(acts);
      }
      inner.appendChild(card);
    });

    /* UiHints (chips) той же группы — встраиваем сюда же одной row */
    if (expandedCat.hintGroup && typeof UiHints !== 'undefined' && UiHints.unified) {
      var hints = UiHints.unified.filter(function (h) { return h.group === expandedCat.hintGroup; });
      hints.forEach(function (h) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'hint-chip starters-hint-chip';
        chip.textContent = h.label;
        chip.title = h.text;
        chip.onclick = function () { _selectHint(h); };
        inner.appendChild(chip);
      });
    }
  }

  function refreshTranscriptBanner() {
    PremiereBridge.getTimelineSnapshot(function (err, snap) {
      var seq = !err && snap && snap.ok && snap.sequenceName ? snap.sequenceName : '';
      if (seq) {
        if (ContextStore.hasTranscriptForSequence(TRANSCRIPT_PID, seq)) {
          var ent = ContextStore.getTranscriptEntry(TRANSCRIPT_PID, seq);
          var sc = ent && ent.segments ? ent.segments.length : 0;
          setTranscriptLed('ok');
          showErr('Секвенция «' + seq + '»: транскрипт в кэше (' + sc + ' сегм.).');
        } else {
          setTranscriptLed('red');
          showErr('Секвенция «' + seq + '»: транскрипта нет — выставьте In/Out и нажмите «Транскрибировать».');
        }
      } else {
        setTranscriptLed('red');
      }
      setTimeout(function () {
        showErr('');
      }, 6000);
    });
  }

  /* ─── Undo button (только для пресета «Маркеры») ──────────────────
   *
   * Откат таймкодов и монтажа по тексту средствами плагина не реализован
   * (PP 2025 Edit→Undo нестабилен на ripple-cuts, накапливать N шагов и
   * откатывать их пачкой в больших монтажах — нерабочее решение).
   * Для этих пресетов кнопка скрыта; пользователь использует штатный
   * Cmd+Z / Ctrl+Z в таймлайне Premiere. Для «Маркеров» откат остаётся,
   * т.к. реализован через markers.deleteMarker по списку секунд.
   */

  var btnUndo = document.getElementById('btn-undo');
  function refreshUndoButton() {
    if (!btnUndo) return;
    btnUndo.style.display = '';
    var u = ContextStore.getLastUndo(active.panelId);
    if (u && u.count > 0 && u.mode === 'markers') {
      btnUndo.textContent =
        'Откатить ' + u.count + ' маркер' + (u.count === 1 ? '' : u.count >= 2 && u.count <= 4 ? 'а' : 'ов');
      btnUndo.title = 'Удалить добавленные маркеры через markers.deleteMarker';
      btnUndo.disabled = false;
    } else if (u && u.count > 0 && u.mode === 'sequence_backup' && u.backupId) {
      /* B2-9: Revert на бэкап-секвенцию (checkpoint перед apply) */
      btnUndo.textContent = '⏪ Откатить: ' + (u.label || 'монтаж');
      btnUndo.title = 'Открыть бэкап-секвенцию «' + (u.backupName || '') +
        '» с состоянием ДО применения. Изменённая секвенция останется в проекте.';
      btnUndo.disabled = false;
    } else {
      btnUndo.textContent = 'Откат маркеров';
      btnUndo.title = 'Нет маркеров для отката';
      btnUndo.disabled = true;
    }
  }
  if (btnUndo) {
    btnUndo.onclick = function () {
      var u = ContextStore.getLastUndo(active.panelId);
      /* B2-9: Revert — активировать бэкап-секвенцию */
      if (u && u.count > 0 && u.mode === 'sequence_backup' && u.backupId) {
        PremiereBridge.activateSequenceById(u.backupId, function (errB, dataB) {
          if (errB || !dataB || !dataB.ok) {
            showErr('Откат не удался: ' + String((errB && errB.message) || (dataB && dataB.error) || 'бэкап не найден'));
            setTimeout(function () { showErr(''); }, 3500);
            return;
          }
          _snapDirty = true;
          lastSnap = null;
          /* 19.06.2026: восстанавливаем транскрипт-кэш до состояния перед apply,
             иначе чат «видит» rippled-транскрипт, не совпадающий с восстановленным
             таймлайном. Кладём и под ключ оригинала, и под имя бэкап-секвенции. */
          try {
            var _tc = _transcriptCheckpoints[u.backupId];
            if (_tc && _tc.entry && ContextStore.setTranscriptEntry) {
              ContextStore.setTranscriptEntry(TRANSCRIPT_PID, _tc.key, JSON.parse(JSON.stringify(_tc.entry)));
              var _bn = dataB.name || u.backupName || '';
              if (_bn && _bn !== _tc.key) ContextStore.setTranscriptEntry(TRANSCRIPT_PID, _bn, JSON.parse(JSON.stringify(_tc.entry)));
              delete _transcriptCheckpoints[u.backupId];
            }
          } catch (eRt) {}
          showErr('Открыта бэкап-секвенция «' + (dataB.name || u.backupName || '') +
            '» — состояние до монтажа. Изменённая версия осталась в проекте.');
          ContextStore.clearLastUndoCount(active.panelId);
          refreshUndoButton();
          setTimeout(function () { showErr(''); }, 5000);
        });
        return;
      }
      if (!u || !u.count || u.mode !== 'markers' || !u.markerSeconds || !u.markerSeconds.length) return;
      PremiereBridge.removeMarkersBySeconds(u.markerSeconds, function (err, data) {
        if (err) {
          showErr(String(err.message || err));
          return;
        }
        if (data && data.ok) {
          showErr(
            'Удалено маркеров: ' +
              (data.removed || 0) +
              ' из ' +
              (data.requested || u.markerSeconds.length) +
              '.'
          );
          ContextStore.clearLastUndoCount(active.panelId);
          refreshUndoButton();
        } else {
          showErr((data && data.error) || 'Не удалось удалить маркеры.');
        }
        setTimeout(function () {
          showErr('');
        }, 3500);
      });
    };
  }

  /* ─── Меню «Ещё» ─────────────────────────────────────────────────── */

  if (el.moreBtn && el.moreMenu) {
    el.moreBtn.onclick = function (e) {
      e.stopPropagation();
      el.moreMenu.classList.toggle('open');
    };
    /* MEDIUM #5 (6 мая 2026): install-once guard. CEP-панели обычно живут ровно
       одну сессию, но на reload (Cmd+R) старый listener остаётся → дубль.
       Аналогично нашему _initGlobalEscapeHandler. */
    if (!window.__omcMoreMenuClickInstalled) {
      window.__omcMoreMenuClickInstalled = true;
      document.addEventListener('click', function (e) {
        if (el.moreMenu && !el.moreMenu.contains(e.target)) el.moreMenu.classList.remove('open');
      });
    }
  }

  var btnClrChat = document.getElementById('btn-clear-chat');
  if (btnClrChat) {
    btnClrChat.onclick = function () {
      ContextStore.clearChat(active.panelId);
      renderMessages([]);
      el.moreMenu.classList.remove('open');
    };
  }
  var btnClrCache = document.getElementById('btn-clear-cache');
  if (btnClrCache) {
    btnClrCache.onclick = function () {
      ContextStore.clearTranscriptCache(TRANSCRIPT_PID);
      setTranscriptLed('red');
      showErr('Общий кэш транскриптов очищен.');
      setTimeout(function () {
        showErr('');
      }, 2000);
      el.moreMenu.classList.remove('open');
    };
  }
  var btnExport = document.getElementById('btn-export-session');
  if (btnExport) {
    btnExport.onclick = function () {
      try {
        var fs = require('fs');
        var path = require('path');
        var os = require('os');
        var dir = path.join(os.homedir(), '.extensions_llm_chat_pr', 'sessions');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        var messages = ContextStore.getMessages(active.panelId);
        var snap = lastSnap || null;
        var settings = ContextStore.getResolvedSettings();
        var ts = new Date().toISOString().replace(/[:.]/g, '-');

        var session = {
          exportedAt: new Date().toISOString(),
          panelId: active.panelId,
          sequenceName: snap && snap.sequenceName ? snap.sequenceName : null,
          messagesCount: messages.length,
          messages: messages,
          snapshot: snap,
          settings: {
            chatModel: settings.chatModel || null,
            fastModel: settings.fastModel || null,
            maxAgentSteps: settings.maxAgentSteps || null
          }
        };

        var filePath = path.join(dir, 'session_' + ts + '.json');
        fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
        showErr('Сессия сохранена: ' + filePath);
        setTimeout(function () { showErr(''); }, 4000);
      } catch (e) {
        showErr('Ошибка сохранения: ' + String(e.message || e));
      }
      el.moreMenu.classList.remove('open');
    };
  }

  /* ── AI-отчёт о сессии ───────────────────────────────── */

  /**
   * Подготовить лог сессии: сжать tool_call results, убрать шум.
   * Возвращает массив строк-чанков, каждый ≤ maxChars.
   */
  function _prepareSessionChunks(messages, maxChars) {
    maxChars = maxChars || 12000;
    var lines = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var role = m.role || '?';
      var content = String(m.content || '').trim();

      /* Сжимаем tool results — оставляем первые 400 символов */
      if (role === 'tool' || role === 'function') {
        if (content.length > 400) content = content.slice(0, 400) + '…[обрезано]';
      }
      /* Сжимаем assistant tool_call JSON */
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        var tcSummary = m.tool_calls.map(function (tc) {
          var fn = (tc['function'] && tc['function'].name) || tc.name || '?';
          var args = (tc['function'] && tc['function'].arguments) || '';
          if (typeof args === 'string' && args.length > 300) args = args.slice(0, 300) + '…';
          return fn + '(' + args + ')';
        }).join('; ');
        content = (content ? content + '\n' : '') + '[tool_calls: ' + tcSummary + ']';
      }
      if (!content) continue;
      lines.push('[' + role + '] ' + content);
    }

    /* Разбиваем на чанки по maxChars */
    var chunks = [];
    var cur = '';
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (cur.length + line.length + 1 > maxChars && cur.length > 0) {
        chunks.push(cur);
        cur = '';
      }
      cur += (cur ? '\n' : '') + line;
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  var REPORT_SYSTEM_PROMPT = [
    'Ты — QA-аналитик плагина видеомонтажа для Adobe Premiere Pro (CEP-расширение).',
    'Тебе дан лог сессии пользователя (сообщения чата между пользователем и AI-агентом монтажа).',
    '',
    'Проанализируй лог и выдай СТРУКТУРИРОВАННЫЙ отчёт в JSON:',
    '{',
    '  "summary": "Краткое описание сессии: что делал пользователь, сколько операций, общий результат",',
    '  "errors": [{"message": "...", "context": "цитата из лога", "severity": "high|medium|low", "possibleCause": "..."}],',
    '  "bugs": [{"description": "...", "reproSteps": "что привело к багу", "expected": "что должно было быть", "actual": "что произошло", "component": "имя модуля/функции"}],',
    '  "quality_issues": [{"description": "...", "example": "цитата", "suggestion": "как улучшить"}],',
    '  "successes": [{"tool": "имя инструмента", "result": "что получилось"}],',
    '  "user_requests": [{"request": "что просил пользователь", "fulfilled": true/false, "notes": "..."}],',
    '  "recommendations": ["что починить в первую очередь", "..."]',
    '}',
    '',
    'ПРАВИЛА:',
    '• severity: high = крэш/потеря данных/полная неработоспособность, medium = неправильный результат, low = косметика/UX.',
    '• Если в логе есть ошибки API, validationError, «не удалось» — это errors.',
    '• Если результат монтажа не соответствует запросу (вырезано не то, не тот хронометраж) — это quality_issues.',
    '• Если инструмент вернул ok:false — это bug.',
    '• Если логов несколько чанков — ты получишь их последовательно. Анализируй кумулятивно.',
    '• Отвечай ТОЛЬКО валидным JSON без markdown-обёртки.'
  ].join('\n');

  async function _generateReport(messages, settings) {
    var chunks = _prepareSessionChunks(messages, 12000);
    if (!chunks.length) throw new Error('Нет сообщений для анализа.');

    var apiOpts = {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.analysisModel || settings.chatModel,
      temperature: 0.2,
      chatParams: { max_tokens: 4096 },
      /* Phase 1.5 (6 мая 2026): per-role thinking — report policy. */
      responseFormat: 'json_object',
      enableThinking: (settings.thinkingPolicy && typeof settings.thinkingPolicy.report === 'boolean')
        ? settings.thinkingPolicy.report
        : settings.enableThinking
    };

    /* Если один чанк — один вызов */
    if (chunks.length === 1) {
      apiOpts.messages = [
        { role: 'system', content: REPORT_SYSTEM_PROMPT },
        { role: 'user', content: 'Лог сессии:\n\n' + chunks[0] }
      ];
      var resp = await CloudRuClient.chatCompletions(apiOpts);
      return _extractReportJson(resp);
    }

    /* Несколько чанков: отправляем по очереди, финальный запрос — объединение */
    var partialReports = [];
    for (var ci = 0; ci < chunks.length; ci++) {
      apiOpts.messages = [
        { role: 'system', content: REPORT_SYSTEM_PROMPT },
        { role: 'user', content: 'Часть ' + (ci + 1) + ' из ' + chunks.length + ' лога сессии:\n\n' + chunks[ci] + '\n\nПроанализируй эту часть. Выдай частичный отчёт JSON.' }
      ];
      var partResp = await CloudRuClient.chatCompletions(apiOpts);
      partialReports.push(_extractContentText(partResp));
    }

    /* Объединяющий вызов */
    apiOpts.messages = [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: 'Ниже частичные отчёты по чанкам одной сессии. Объедини их в ОДИН финальный отчёт JSON. Удали дубли, объедини ошибки, пересчитай summary.\n\n' + partialReports.join('\n\n---\n\n') }
    ];
    apiOpts.chatParams = { max_tokens: 8192 };
    var finalResp = await CloudRuClient.chatCompletions(apiOpts);
    return _extractReportJson(finalResp);
  }

  function _extractContentText(resp) {
    if (resp && resp.choices && resp.choices[0] && resp.choices[0].message) {
      return String(resp.choices[0].message.content || '');
    }
    return JSON.stringify(resp);
  }

  function _extractReportJson(resp) {
    var text = _extractContentText(resp);
    /* Убираем markdown code fences если есть */
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try {
      return JSON.parse(text);
    } catch (e) {
      /* Если не парсится — возвращаем как raw text в обёртке */
      return { summary: 'Не удалось распарсить JSON ответ', raw: text };
    }
  }

  var btnReport = document.getElementById('btn-export-report');
  if (btnReport) {
    btnReport.onclick = async function () {
      el.moreMenu.classList.remove('open');
      var messages = ContextStore.getMessages(active.panelId);
      if (!messages.length) {
        showErr('Нет сообщений для анализа.');
        return;
      }
      var settings = ContextStore.getResolvedSettings();
      if (!settings.apiKey || !settings.baseUrl) {
        showErr('Не настроен API (fm-secrets.js / fm-defaults.js).');
        return;
      }

      statusUi.show('Генерация AI-отчёта…', true);
      btnReport.disabled = true;
      try {
        var report = await _generateReport(messages, settings);

        /* Сохраняем на диск */
        var fs = require('fs');
        var path = require('path');
        var os = require('os');
        var dir = path.join(os.homedir(), '.extensions_llm_chat_pr', 'reports');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        var ts = new Date().toISOString().replace(/[:.]/g, '-');

        var envelope = {
          reportDate: new Date().toISOString(),
          sequenceName: lastSnap && lastSnap.sequenceName ? lastSnap.sequenceName : null,
          model: settings.analysisModel || settings.chatModel,
          messagesAnalyzed: messages.length,
          chunksProcessed: _prepareSessionChunks(messages, 12000).length,
          report: report
        };

        var filePath = path.join(dir, 'report_' + ts + '.json');
        fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), 'utf8');
        statusUi.hide();
        showErr('Отчёт сохранён: ' + filePath);
        setTimeout(function () { showErr(''); }, 6000);
      } catch (e) {
        statusUi.hide();
        showErr('Ошибка генерации отчёта: ' + String(e.message || e));
      } finally {
        btnReport.disabled = false;
      }
    };
  }

  var btnClrAll = document.getElementById('btn-clear-all');
  if (btnClrAll) {
    btnClrAll.onclick = function () {
      ContextStore.clearAllPanelCache(active.panelId);
      renderMessages([]);
      refreshUndoButton();
      el.moreMenu.classList.remove('open');
    };
  }

  /* ─── Send / Stop ────────────────────────────────────────────────── */

  el.stop.onclick = function () {
    if (runAbort && typeof runAbort.abort === 'function') runAbort.abort();
  };

  /** Быстрый путь для timecode: «удали с 3 по 5 сек» без LLM. */
  function parseTimelineIntervalDeleteSec(text) {
    var raw = String(text || '');
    var t = raw.toLowerCase().replace(/ё/g, 'е');
    var ripple = true;
    if (
      /не\s*смыка|без\s*смык|не\s+сомык|остав(ь|ить)\s+дыр|с\s+дыр|lift|без\s+ripple|не\s+сомкн/i.test(raw)
    )
      ripple = false;
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

  /* B1-8 (заимствовано из CVP): слэш-команды-промпты. Детерминированные
     пайплайны (/паразиты, /тишины, /главы…) парсит DeterministicPipelines;
     эти команды — шорткаты к LLM-запросам, разворачиваются в полный промпт. */
  var SLASH_PROMPTS = {
    '/top5': 'Найди топ-5 самых сильных моментов на таймлайне по транскрипту. ' +
      'Для каждого: таймкоды, цитата, почему цепляет. Ничего не применяй — только список.',
    '/клип': 'Собери из таймлайна короткий клип-хайлайт до 60 секунд: выбери самые сильные ' +
      'моменты по транскрипту и предложи план вырезов через propose_transcript_cuts.'
  };

  function expandSlashPrompt(text) {
    if (text[0] !== '/') return text;
    var sp = text.indexOf(' ');
    var cmd = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();
    var rest = sp === -1 ? '' : text.slice(sp + 1).trim();
    if (!SLASH_PROMPTS[cmd]) return text;
    return SLASH_PROMPTS[cmd] + (rest ? ' Доп. пожелание: ' + rest : '');
  }

  async function onSend() {
    var text = el.input.value.trim();
    if (!text) return;
    text = expandSlashPrompt(text);
    if (!beginOperation('send')) return;
    showErr('');
    el.input.value = '';
    /* 19.06.2026: новый запрос замещает прежний НЕприменённый план — снимаем
       зависшую proposal-карточку, чтобы пользователь случайно не применил
       устаревший план после несвязанного сообщения (live-находка edge-теста). */
    if (_pendingProposal) {
      _pendingProposal = null;
      var staleCard = document.getElementById('pending-proposal-card');
      if (staleCard && staleCard.parentNode) staleCard.parentNode.removeChild(staleCard);
    }
    var settings = ContextStore.getResolvedSettings();
    var panelId = active.panelId;
    var stored = ContextStore.getMessages(panelId);
    stored.push({ role: 'user', content: text });
    ContextStore.setMessages(panelId, stored);
    renderMessages(stored);

    /* Fast-path для простых команд «удали с X по Y секунду» */
    {
      var direct = parseTimelineIntervalDeleteSec(text);
      if (direct && direct.endSec > direct.startSec + 0.02) {
        el.send.disabled = true;
        el.stop.disabled = false;
        runAbort = createAbortPair();
        var acFast = runAbort;
        statusUi.show('Вырезание интервала на таймлайне…', true);
        try {
          if (acFast.aborted) throw new Error('Остановлено');
          var delAction = direct.ripple ? 'ripple_delete_range' : 'lift_delete_range';
          var plan = {
            operations: [{ action: delAction, startSec: direct.startSec, endSec: direct.endSec }],
            summary: 'Удалён участок ' + direct.startSec + '–' + direct.endSec + ' с (' + delAction + ')'
          };
          /* Чекпоинт перед деструктивным fast-path — чтобы работала «⏪ Откатить»
             (18.06.2026: раньше fast-path применял без бэкапа, откат только Ctrl+Z). */
          await new Promise(function (resolve) {
            _makeSequenceCheckpoint('вырезание интервала', function () { resolve(); });
          });
          var fastRes = await new Promise(function (resolve, reject) {
            PremiereBridge.applyTimecodeEdits(plan, function (err, data) {
              if (err) reject(err);
              else resolve(data);
            });
          });
          /* Откат таймкодов средствами плагина не реализован — Cmd+Z в таймлайне Premiere вручную. */
          if (fastRes && !fastRes.ok) throw new Error(fastRes.error || 'Ошибка применения правки');
          /* 19.06.2026: fast-path синхронизирует кэш транскрипта так же, как
             канонический apply_timecode_edits (panel.js:1142-1168). Раньше fast-path
             применял ripple к таймлайну, но НЕ сдвигал кэш транскрипта → после
             «удали с 10 по 20 сек» все сегменты после выреза оставались съехавшими
             на длину выреза, и последующие чат-запросы видели неверные таймкоды
             (подтверждено live: вырез 5-6с не сдвинул last-сегмент 1877.574).
             lift_delete оставляет дыру (контент не сдвигается) — канонический путь
             его не синхронит, fast-path тоже только для ripple. */
          _snapDirty = true;
          try {
            var fastSnap = await new Promise(function (resolve) {
              PremiereBridge.getTimelineSnapshot(function (e2, d2) { resolve((!e2 && d2 && d2.ok) ? d2 : null); });
            });
            if (fastSnap) { lastSnap = fastSnap; _snapDirty = false; }
            var fastSeqKey = (fastSnap && fastSnap.sequenceName) || (lastSnap && lastSnap.sequenceName) || '';
            if (fastSeqKey && direct.ripple) {
              ContextStore.applyRippleDeletionsToTranscript(
                TRANSCRIPT_PID, fastSeqKey,
                [{ startSec: direct.startSec, endSec: direct.endSec }]
              );
            }
          } catch (eFastSync) { /* sync best-effort — таймлайн уже изменён */ }
          stored = ContextStore.getMessages(panelId);
          stored.push({
            role: 'assistant',
            content:
              'Готово: вырезан интервал с ' + direct.startSec + ' по ' + direct.endSec + ' с (' + delAction + ').'
          });
          ContextStore.setMessages(panelId, stored);
          renderMessages(stored);
          statusUi.show('Готово', false);
          setTimeout(function () {
            statusUi.hide();
          }, 1200);
        } catch (e) {
          statusUi.hide();
          if (e && (e.name === 'AbortError' || String(e.message || '').indexOf('Остановлен') !== -1))
            showErr('Остановлено.');
          else showErr(String(e.message || e));
        } finally {
          if (runAbort === acFast) runAbort = null;
          endOperation();
          el.send.disabled = false;
          el.stop.disabled = true;
        }
        return;
      }
    }

    /* ── Deterministic pipelines: /cut_fillers, /cut_silences, /chapterize, /jump_cuts ── */
    if (typeof DeterministicPipelines !== 'undefined') {
      var pipeCmd = DeterministicPipelines.parsePipelineCommand(text);
      if (pipeCmd) {
        el.send.disabled = true;
        el.stop.disabled = false;
        runAbort = createAbortPair();
        var acPipe = runAbort;
        statusUi.show('Пайплайн ' + pipeCmd.name + '…', true);
        try {
          /* Получаем snapshot и транскрипт */
          var pipeSnap = await execGetSnapshot(true);
          var pipeSeqKey = (pipeSnap && pipeSnap.sequenceName) || '';
          var pipeFound = pipeSeqKey ? ContextStore.findTranscriptEntry(TRANSCRIPT_PID, pipeSeqKey) : null;
          var pipeEntry = pipeFound && pipeFound.entry ? pipeFound.entry : null;

          var pipeResult = await pipeCmd.pipeline({
            settings: settings,
            snapshot: pipeSnap,
            transcriptEntry: pipeEntry,
            onStatus: function (msg) { statusUi.show(msg, true); },
            abortCheck: function () { return acPipe.aborted; }
          }, pipeCmd.params);

          if (!pipeResult.ok) {
            stored = ContextStore.getMessages(panelId);
            stored.push({ role: 'assistant', content: pipeResult.error || 'Ошибка пайплайна.' });
            ContextStore.setMessages(panelId, stored);
            renderMessages(stored);
          } else if (pipeResult.noChanges) {
            stored = ContextStore.getMessages(panelId);
            stored.push({ role: 'assistant', content: pipeResult.summary });
            ContextStore.setMessages(panelId, stored);
            renderMessages(stored);
          } else if (pipeResult.proposal) {
            /* Показываем карточку подтверждения */
            _pendingProposal = pipeResult.proposal;
            _pendingProposal.snapshot = pipeSnap;
            if (pipeResult.proposal.kind === 'transcript_cuts') {
              _pendingProposal.verification = computeVerification(pipeResult.proposal.removeIntervals);
            }
            if (pipeResult.proposal.kind === 'j_cuts') {
              /* J-cuts не используют стандартную карточку — специальная обработка */
              _pendingProposal.kind = 'j_cuts';
            }
            stored = ContextStore.getMessages(panelId);
            stored.push({ role: 'assistant', content: pipeResult.proposal.summary || pipeResult.summary || '' });
            ContextStore.setMessages(panelId, stored);
            renderMessages(stored);
            renderPendingProposalCard();
          }

          statusUi.show('Готово', false);
          setTimeout(function () { statusUi.hide(); }, 1200);
        } catch (ePipe) {
          statusUi.hide();
          if (ePipe && (ePipe.name === 'AbortError' || String(ePipe.message || '').indexOf('Остановлен') !== -1))
            showErr('Остановлено.');
          else showErr(String(ePipe.message || ePipe));
        } finally {
          if (runAbort === acPipe) runAbort = null;
          endOperation();
          el.send.disabled = false;
          el.stop.disabled = true;
        }
        return;
      }
    }

    /* Safety-guard: разрешаем прямой apply_* только при явной просьбе пользователя. */
    _directApplyAuthorized = _detectDirectApply(text);

    /* P1-1: Tiered prompt — подключаем только релевантные секции */
    var sysContent = (typeof AgentPrompts !== 'undefined' && AgentPrompts.buildPrompt)
      ? AgentPrompts.buildPrompt(text)
      : active.sysprompt();
    if (_activeSystemAddon) {
      sysContent += '\n\n' + _activeSystemAddon;
      _activeSystemAddon = null;
    }
    var apiMessages = [{ role: 'system', content: sysContent }].concat(stored);

    el.send.disabled = true;
    el.stop.disabled = false;
    runAbort = createAbortPair();
    var ac = runAbort;

    /* P0-1: Auto-inject timeline snapshot — убираем 1 обязательный round-trip.
       Максимально компактный формат: только sequenceName + видео-клипы.
       Audio-клипы дублируют видео и добавляют шум. */
    statusUi.show('Получение снимка таймлайна…', true);
    try {
      var autoSnap = await execGetSnapshot(true); /* ВСЕГДА свежий snap для каждого нового сообщения */
      if (autoSnap && autoSnap.ok) {
        var videoClips = (autoSnap.clips || []).filter(function (c) { return c.trackType === 'video'; });
        var audioClipsAll = (autoSnap.clips || []).filter(function (c) { return c.trackType === 'audio'; });
        /* 19.06.2026: линкованное аудио НЕ прячем полностью — иначе агент «не видит»
           аудиоклип и не может выполнить loudness/ducking (live-баг: BRAW-аудио
           линковано с видео → пропадало из снапшота → «нет аудиоклипа»). Вместо этого
           привязываем audio nodeId к видео-строке маркером a=<nodeId>, а несвязанное
           аудио показываем отдельной строкой. */
        var linkedAudioBy = {};
        var audioOnlyClips = [];
        audioClipsAll.forEach(function (c) {
          var v = null;
          for (var vi3 = 0; vi3 < videoClips.length; vi3++) {
            if (videoClips[vi3].name === c.name && Math.abs(videoClips[vi3].startSec - c.startSec) < 0.1) { v = videoClips[vi3]; break; }
          }
          if (v) { if (!linkedAudioBy[v.nodeId]) linkedAudioBy[v.nodeId] = c; }
          else audioOnlyClips.push(c);
        });
        /* Вычисляем реальную длительность — sequenceEndSec бывает 0 */
        var effectiveEndSec = autoSnap.sequenceEndSec || 0;
        (autoSnap.clips || []).forEach(function (c) { if (c.endSec > effectiveEndSec) effectiveEndSec = c.endSec; });
        var compactClips = videoClips.map(function (c) {
          var la = linkedAudioBy[c.nodeId];
          return c.nodeId + '|' + c.name + '|' + c.trackType[0] + c.trackIndex + '|' + c.startSec + '-' + c.endSec +
            (c.disabled ? '|off' : '') + (la ? '|a=' + la.nodeId + '@' + la.trackType[0] + la.trackIndex : '');
        }).concat(audioOnlyClips.map(function (c) {
          return c.nodeId + '|' + c.name + '|' + c.trackType[0] + c.trackIndex + '|' + c.startSec + '-' + c.endSec + (c.disabled ? '|off' : '');
        }));
        apiMessages.push({
          role: 'user',
          content: '[auto-snapshot] seq=' + autoSnap.sequenceName + ' dur=' + effectiveEndSec.toFixed(1) + 's fps=' + autoSnap.fps +
            '\nclips(' + compactClips.length + '):\n' + compactClips.join('\n')
        });
      }
    } catch (eSnap) { /* не критично — агент сам вызовет get_timeline_snapshot */ }

    statusUi.show('Запрос к Cloud.ru FM…', true);
    try {
      /* Streaming (optional, off by default) + two-model routing */
      var streamSettings = Object.assign({}, settings);
      streamSettings.stream = !!settings.enableStreaming;
      /* Two-model routing: простые задачи → fastModel (дешевле, быстрее) */
      if (streamSettings.fastModel && typeof AgentPrompts.classifyComplexity === 'function') {
        var complexity = AgentPrompts.classifyComplexity(text);
        if (complexity === 'simple') {
          streamSettings.activeAgentModel = streamSettings.fastModel;
        }
      }
      var result = await runAgentLoop({
        settings: streamSettings,
        messages: apiMessages,
        tools: active.tools,
        toolExecutors: buildExecutorsForPreset(active),
        maxSteps: settings.maxAgentSteps || 24,
        abortSignal: ac.signal,
        abortCheck: function () {
          return ac.aborted;
        },
        onStatus: function (ev) {
          statusUi.show(ev.message || ev.name || '…', true);
          /* ETA: запрос к модели ушёл — таймер «думает… Nс (обычно ~Mс)» */
          if (ev.phase === 'llm') startWaitIndicator(ev.model, ev.etaMs);
          /* UI-волна: стриминг-чанки → живой пузырь (раньше выбрасывались) */
          if (ev.phase === 'streaming' && ev.accumulated) {
            stopWaitIndicator('assistant · печатает…');
            updateStreamBubble(ev.accumulated);
          }
          if (ev.phase === 'tool') stopWaitIndicator('assistant · инструмент: ' + (ev.name || '…'));
        }
      });
      statusUi.show('Готово', false);
      setTimeout(function () {
        statusUi.hide();
      }, 1200);
      ContextStore.setMessages(
        panelId,
        result.messages.filter(function (m) {
          return m.role !== 'system';
        })
      );
      renderMessages(ContextStore.getMessages(panelId));
    } catch (e) {
      statusUi.hide();
      if (e && (e.name === 'AbortError' || String(e.message || '').indexOf('Остановлен') !== -1))
        showErr('Остановлено (запрос к API FM прерван).');
      else showErr(String(e.message || e));
    } finally {
      removeStreamBubble(); /* успех → renderMessages уже всё показал; ошибка → не оставляем «печатает…» */
      if (runAbort === ac) runAbort = null;
      endOperation();
      el.send.disabled = false;
      el.stop.disabled = true;
    }
  }

  el.send.onclick = onSend;
  el.input.onkeydown = function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSend();
  };

  /* B1-8: подсказка по слэш-командам при вводе «/» в начале поля */
  (function initSlashHint() {
    if (!el.input || !el.input.parentNode) return;
    var hint = document.createElement('div');
    hint.id = 'slash-hint';
    hint.style.cssText =
      'display:none;font-size:10px;color:#888;line-height:1.5;padding:4px 6px;' +
      'background:rgba(99,102,241,0.08);border-radius:4px;margin-bottom:4px;';
    hint.textContent =
      'Команды: /паразиты · /тишины · /главы · /джампкаты · /j_cuts · /l_cuts · /top5 · /клип';
    el.input.parentNode.insertBefore(hint, el.input);
    el.input.addEventListener('input', function () {
      var v = el.input.value;
      hint.style.display = (v && v[0] === '/' && v.indexOf(' ') === -1) ? 'block' : 'none';
    });
    el.input.addEventListener('blur', function () {
      setTimeout(function () { hint.style.display = 'none'; }, 200);
    });
  })();

  /* ─── Транскрибация (общая, единственная кнопка) ─────────────────── */

  /* HIGH #1 (6 мая 2026): защита от sequence switch между proposal и apply.
     Если пользователь переключил активную секвенцию в Premiere после получения
     proposal'а — apply бы выполнился на ДРУГОЙ секвенции, разрушая её таймлайн.
     Делаем fresh snapshot и сверяем sequenceName. Возвращаем Promise<true|false>.
     При false — caller должен показать ошибку и НЕ применять. */
  function assertSequenceMatch(proposalSnapshot, callback) {
    if (!proposalSnapshot || !proposalSnapshot.sequenceName) {
      callback(null, true); /* нет данных для сверки — пропускаем guard */
      return;
    }
    var expectedName = proposalSnapshot.sequenceName;
    PremiereBridge.getTimelineSnapshot(function (err, fresh) {
      if (err) {
        callback(err, false);
        return;
      }
      if (!fresh || !fresh.ok) {
        callback(new Error('Не удалось получить актуальный снимок таймлайна'), false);
        return;
      }
      var freshName = fresh.sequenceName || '';
      if (freshName !== expectedName) {
        callback(new Error(
          'Активная секвенция изменилась с «' + expectedName + '» на «' + freshName +
          '». Apply отменён для безопасности. Откройте секвенцию «' + expectedName +
          '» и попросите план заново.'
        ), false);
        return;
      }
      /* Освежаем lastSnap фактом успешной проверки. */
      lastSnap = fresh;
      _snapDirty = false;
      callback(null, true);
    });
  }

  /* P1 #4 (6 мая 2026): single source of truth для disable/enable обеих кнопок
     транскрибации (полная + ⚡ Анализ аудио). Защита от collision двойных запусков. */
  function setTranscribeButtonsDisabled(disabled) {
    if (el.transcribe) el.transcribe.disabled = !!disabled;
    var auBtns = document.querySelectorAll('[data-action="audio-only-analyze"]');
    for (var i = 0; i < auBtns.length; i++) {
      auBtns[i].disabled = !!disabled;
    }
  }

  async function onTranscribeTimeline() {
    if (!beginOperation('transcribe')) return;
    showErr('');
    var settings = ContextStore.getResolvedSettings();
    setTranscribeButtonsDisabled(true);
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
      if (!prep || !prep.ok) throw new Error((prep && prep.error) || 'Не удалось подготовить аудио');

      var snap = await new Promise(function (resolve, reject) {
        PremiereBridge.getTimelineSnapshot(function (err, data) {
          if (err) reject(err);
          else resolve(data);
        });
      });
      if (!snap || !snap.ok) throw new Error((snap && snap.error) || 'Нет активной секвенции');
      var key = snap.sequenceName || 'sequence';

      var norm = await TimelineTranscribe.runFromPrep(prep, {
        settings: settings,
        signal: ac.signal,
        abortCheck: function () {
          return ac.aborted;
        },
        onProgress: function (msg) {
          statusUi.show(msg, true);
          /* UI-2 (аудит 4.2): сообщения transcribe уже содержат «N/M»
             («Транскрибация: 3/8 готово…», «Извлечение аудио 2/6…») —
             парсим и показываем реальный %, а не вечный спиннер. */
          var mNM = /(\d+)\s*\/\s*(\d+)/.exec(String(msg || ''));
          if (mNM && Number(mNM[2]) > 0) {
            statusUi.progress(Math.min(100, (Number(mNM[1]) / Number(mNM[2])) * 100));
          } else {
            statusUi.progress(null);
          }
        },
        CloudRuClient: CloudRuClient
      });

      try {
        if (typeof TranscriptStructure !== 'undefined') {
          TranscriptStructure.buildStructure(norm, { pauseThresholdSec: 0.9, maxParagraphSec: 60 });
        }
      } catch (eStr) {}
      ContextStore.setTranscriptEntry(TRANSCRIPT_PID, key, norm);

      try {
        if (typeof TranscriptStructure !== 'undefined' && norm.paragraphs && norm.paragraphs.length) {
          statusUi.show('Построение глав (LLM)…', true);
          TranscriptStructure.buildTopicsWithLLM(norm.paragraphs, {
            settings: settings,
            CloudRuClient: CloudRuClient,
            signal: ac.signal,
            abortCheck: function () {
              return ac.aborted;
            }
          }).then(function (topics) {
            if (topics && topics.length) {
              norm.topics = topics;
              if (!norm.structureMeta) norm.structureMeta = {};
              norm.structureMeta.topicsSource = 'llm';
              ContextStore.setTranscriptEntry(TRANSCRIPT_PID, key, norm);
            }
          }, function () {});
        }
      } catch (eT) {}

      /* P0-3: Pre-compute local analysis при транскрибации */
      try {
        if (typeof TranscriptStructure !== 'undefined' && norm.segments && norm.segments.length) {
          statusUi.show('Локальный анализ сегментов…', true);
          var segsForLocal = norm.segments.map(function (s, idx) {
            return {
              i: idx,
              startSec: typeof s.startSec === 'number' ? s.startSec : (s.start || 0),
              endSec: typeof s.endSec === 'number' ? s.endSec : (s.end || 0),
              text: String(s.text || '')
            };
          });
          var localResult = TranscriptStructure.runLocalDetectors(segsForLocal);
          norm.preAnalysis = {
            labels: localResult.labels,
            stats: localResult.stats,
            builtAt: Date.now()
          };
          ContextStore.setTranscriptEntry(TRANSCRIPT_PID, key, norm);
          statusUi.show('Локальный анализ: ' + localResult.labels.length + ' меток', false);
        }
      } catch (eLA) {}

      /* UI-2 (аудит 4.1): фоновый прекомпьют полного LLM-анализа.
         setTimeout — чтобы выйти из finally этой операции (runAbort уже null,
         фоновый анализ не привязан к остановленному abort-контроллеру).
         Дедуп через _analysisInFlight: клик «Убрать паразиты» во время
         прекомпьюта подключится к нему, а не запустит второй анализ. */
      try {
        if (settings.backgroundPrecompute !== false && norm.segments && norm.segments.length) {
          setTimeout(function () {
            execAnalyzeTranscriptForCuts({ sequenceKey: key, _background: true }).then(function (r) {
              if (r && r.ok && opQueue && !opQueue.isBusy()) {
                statusUi.show('Фоновый анализ готов: ' + (r.removeIntervals ? r.removeIntervals.length : 0) +
                  ' интервалов-кандидатов (кэш 30 мин, кнопки Tools ответят мгновенно)', false);
                setTimeout(function () { statusUi.hide(); }, 4000);
              }
            }, function () { /* фоновый — молча */ });
          }, 3000);
        }
      } catch (ePre) {}

      var again = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key);
      if (!again.entry) {
        showErr('Не удалось сохранить или прочитать кэш.');
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
        /* MEDIUM #20 (6 мая 2026): классифицируем ошибку и предлагаем retry для
           сетевых ошибок. Для auth/quota retry бесполезен, показываем hint без кнопки. */
        var cls = _classifyError(e);
        var opts = { hint: cls.hint };
        if (cls.kind === 'network' || cls.kind === 'other') {
          opts.retry = function () { onTranscribeTimeline(); };
        }
        showErr('Транскрибация: ' + String(e.message || e), opts);
      }
    } finally {
      if (TimelineTranscribe && TimelineTranscribe.unlinkWorkFiles) TimelineTranscribe.unlinkWorkFiles(prep);
      if (runAbort === ac) runAbort = null;
      endOperation();
      setTranscribeButtonsDisabled(false);
      el.stop.disabled = true;
    }
  }

  if (el.transcribe) el.transcribe.onclick = onTranscribeTimeline;

  /* ─── Phase 1.6 (6 мая 2026): Аудио-анализ без транскрибации ────────
   * Быстрый путь для cutSilences/jumpCuts: 30 сек вместо 10-15 мин Whisper.
   * Записывает entry с {segments:[], audioAnalysis:{...}, mode:'audio-only'}.
   * Match AutoPod/FireCut UX. */
  async function onAudioOnlyAnalyze() {
    if (!beginOperation('audio-only')) return;
    showErr('');
    var settings = ContextStore.getResolvedSettings();
    setTranscribeButtonsDisabled(true);
    el.stop.disabled = false;
    runAbort = createAbortPair();
    var ac = runAbort;
    var prep = null;
    statusUi.show('Подготовка аудио (быстрый режим)…', true);
    setTranscriptLed('busy');
    try { if (window.__toolsSetBusy) window.__toolsSetBusy(true); } catch (eTB) {}
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
          function (err, data) { if (err) reject(err); else resolve(data); }
        );
      });
      if (!prep || !prep.ok) throw new Error((prep && prep.error) || 'Не удалось подготовить аудио');

      var snap = await new Promise(function (resolve, reject) {
        PremiereBridge.getTimelineSnapshot(function (err, data) {
          if (err) reject(err); else resolve(data);
        });
      });
      if (!snap || !snap.ok) throw new Error((snap && snap.error) || 'Нет активной секвенции');
      var key = snap.sequenceName || 'sequence';

      var entry = await TimelineTranscribe.runAudioOnlyAnalysis(prep, function (msg) {
        statusUi.show(msg, true);
      });

      /* Phase 1.6 (6 мая 2026, P0 #2): MERGE not REPLACE.
         Если уже есть полный транскрипт в кеше — НЕ затираем segments/paragraphs/text.
         Просто обновляем audioAnalysis (новые тишины с актуальным порогом). */
      var existing = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key);
      var preservedSegments = 0;
      if (existing && existing.entry && Array.isArray(existing.entry.segments) && existing.entry.segments.length > 0) {
        /* Сохраняем существующие данные, обновляем только audioAnalysis. */
        var merged = Object.assign({}, existing.entry, {
          audioAnalysis: entry.audioAnalysis,
          builtAt: entry.builtAt,
          /* mode НЕ перезаписываем — сохраняем 'transcribe' / 'whisper' и т.д. */
          analysisOnly: false
        });
        ContextStore.setTranscriptEntry(TRANSCRIPT_PID, key, merged);
        preservedSegments = existing.entry.segments.length;
      } else {
        /* Чистый кеш или предыдущий тоже audio-only — пишем как есть. */
        ContextStore.setTranscriptEntry(TRANSCRIPT_PID, key, entry);
      }

      var sCount = entry.audioAnalysis && entry.audioAnalysis.silences ? entry.audioAnalysis.silences.length : 0;
      /* P1 #3 LED state: если транскрипт сохранён → 'ok' (зелёный), иначе 'audio' (синий). */
      setTranscriptLed(preservedSegments > 0 ? 'ok' : 'audio');
      var msg = 'Аудио-анализ готов (' + sCount + ' тишин). Доступны: Убрать тишины / Jump cuts.';
      if (preservedSegments > 0) {
        msg += ' Транскрипт (' + preservedSegments + ' сегм.) сохранён.';
      }
      statusUi.show(msg, false);
      setTimeout(function () { statusUi.hide(); }, 4500);
      var errMsg = 'Аудио-анализ «' + key + '»: ' + sCount + ' тишин.';
      if (preservedSegments > 0) {
        errMsg += ' Транскрипт сохранён (' + preservedSegments + ' сегм.).';
      } else {
        errMsg += ' Для филлеров/глав нужна полная транскрибация.';
      }
      showErr(errMsg);
      setTimeout(function () { showErr(''); }, 6000);
    } catch (e) {
      statusUi.hide();
      setTranscriptLed('red');
      if (e && (e.name === 'AbortError' || String(e.message || '').indexOf('Остановлен') !== -1))
        showErr('Анализ остановлен.');
      else showErr(String(e.message || e));
    } finally {
      if (TimelineTranscribe && TimelineTranscribe.unlinkWorkFiles) TimelineTranscribe.unlinkWorkFiles(prep);
      if (runAbort === ac) runAbort = null;
      endOperation();
      setTranscribeButtonsDisabled(false);
      el.stop.disabled = true;
      /* Снимаем busy: __toolsSetBusy(false) пересчитает Tools-LED под фактическое
         состояние (ok/audio/red) свежей секвенции. */
      try { if (window.__toolsSetBusy) window.__toolsSetBusy(false); } catch (eTB2) {}
    }
  }
  /* Кнопка подключается через querySelector — может быть в нескольких местах. */
  var audioOnlyBtns = document.querySelectorAll('[data-action="audio-only-analyze"]');
  for (var aoi = 0; aoi < audioOnlyBtns.length; aoi++) {
    audioOnlyBtns[aoi].onclick = onAudioOnlyAnalyze;
  }

  /* ─── Инициализация единой панели ─────────────────────────────────── */

  function initUnifiedPanel() {
    active = UNIFIED_PRESET;
    if (el.input) el.input.placeholder = active.placeholder || '';
    renderMessages(ContextStore.getMessages(active.panelId));
    rebuildHintChips();
    rebuildStarters();
    refreshUndoButton();
    refreshTranscriptBanner();
  }

  /* Legacy-совместимость: если где-то вызывается activatePreset — просто noop */
  function activatePreset() { /* единая панель, переключения нет */ }

  initUnifiedPanel();

  /* ═══════════════════════════════════════════════════════════════════
   *  VIEW TAB SWITCHING: Чат ↔ Инструменты
   * ═══════════════════════════════════════════════════════════════════ */
  (function initViewTabs() {
    var tabs = document.querySelectorAll('.view-tab');
    var panels = document.querySelectorAll('.view-panel');
    for (var ti = 0; ti < tabs.length; ti++) {
      (function (tab) {
        tab.addEventListener('click', function () {
          var viewId = 'view-' + tab.getAttribute('data-view');
          for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
          for (var k = 0; k < panels.length; k++) panels[k].classList.remove('active');
          tab.classList.add('active');
          var target = document.getElementById(viewId);
          if (target) target.classList.add('active');
          /* Refresh tools LED when switching to tools view */
          if (viewId === 'view-tools') toolsRefreshLed();
        });
      })(tabs[ti]);
    }
  })();

  /* ═══════════════════════════════════════════════════════════════════
   *  TOOLS VIEW LOGIC
   * ═══════════════════════════════════════════════════════════════════ */
  (function initToolsView() {
    var toolsStatusUi = PanelUIStatus.create('tools-statusBar');
    var toolsErr = document.getElementById('tools-err');
    var toolsLed = document.getElementById('tools-led');
    var toolsLedText = document.getElementById('tools-led-text');
    var toolsTranscribe = document.getElementById('tools-btn-transcribe');
    var _toolsProposal = null;
    var _toolsProposalArea = null;
    var _toolsBusy = false; /* идёт «Анализ аудио» — держим LED busy, не перетираем */

    /* ── Waveform-превью (Phase 2) ─────────────────────────────
       Рисует RMS-огибающую региона In–Out и поверх — красные зоны вырезания.
       Зоны пересчитываются на лету при движении ползунков через ТОТ ЖЕ пайплайн
       (cutSilences/jumpCuts), что и реальный вырез → preview==apply. Дорогой RMS
       (ffmpeg) считается один раз в «Анализ аудио»; здесь — только перерисовка. */
    var WaveformPreview = (function () {
      var ABS_FLOOR = -90; /* dB для пропусков/-inf (digital silence) */
      function draw(canvas, rms, regions, opts) {
        if (!canvas || !canvas.getContext) return;
        opts = opts || {};
        var ctx = canvas.getContext('2d');
        var W = canvas.width, H = canvas.height;
        var mid = H / 2;
        var maxHalf = mid - 2;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#11151b'; ctx.fillRect(0, 0, W, H);
        if (!rms || rms.length < 2 || W < 2) { return; }
        var t0 = opts.tStart != null ? opts.tStart : rms[0].t;
        var t1 = opts.tEnd != null ? opts.tEnd : rms[rms.length - 1].t;
        var span = t1 - t0;
        if (!(span > 0)) return;
        function xOf(t) { return ((t - t0) / span) * W; }

        /* max peak и max rms по колонке пикселей (даунсэмплинг к ширине canvas) */
        var colPeak = new Array(W), colRms = new Array(W);
        for (var c = 0; c < W; c++) { colPeak[c] = -Infinity; colRms[c] = -Infinity; }
        for (var k = 0; k < rms.length; k++) {
          var x = Math.floor(xOf(rms[k].t));
          if (x < 0 || x >= W) continue;
          var pk = (typeof rms[k].peak === 'number' && isFinite(rms[k].peak)) ? rms[k].peak : ABS_FLOOR;
          var rm = (typeof rms[k].rms === 'number' && isFinite(rms[k].rms)) ? rms[k].rms : ABS_FLOOR;
          if (pk > colPeak[x]) colPeak[x] = pk;
          if (rm > colRms[x]) colRms[x] = rm;
        }
        var lp = ABS_FLOOR, lr = ABS_FLOOR;
        for (var f = 0; f < W; f++) {
          if (colPeak[f] === -Infinity) colPeak[f] = lp; else lp = colPeak[f];
          if (colRms[f] === -Infinity) colRms[f] = lr; else lr = colRms[f];
        }

        /* ЛИНЕЙНАЯ амплитуда (как waveform в Premiere/Audition), НЕ dB. В dB-шкале
           -14 и -40 оба «высокие» (логарифм сжимает) → непрерывная речь сливается
           в монолит («3 острова»). В линейной амплитуде тишина (-80dB → lin≈0.0001)
           реально плоская, а речь даёт пики — чёткая структура как на таймлайне.
           Нормируем на макс. линейную амплитуду пика региона (адаптив под уровень). */
        function dbToLin(db) { return (!isFinite(db) || db <= ABS_FLOOR) ? 0 : Math.pow(10, db / 20); }
        var maxLin = 0;
        for (var mm = 0; mm < W; mm++) { var lpk = dbToLin(colPeak[mm]); if (lpk > maxLin) maxLin = lpk; }
        if (!(maxLin > 0)) return;
        function amp(db) { var v = dbToLin(db) / maxLin; if (v < 0) v = 0; else if (v > 1) v = 1; return v; }

        /* центральная линия */
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(W, mid + 0.5); ctx.stroke();

        /* ЗАЛИВНОЙ двухтоновый waveform (как на таймлайне Premiere): peak-огибающая
           заполняется сплошным контуром (светлее) + ядро по RMS (ярче) поверх.
           Заливка убирает «расчёску» из дискретных полосок — форма читается цельно. */
        function fillEnvelope(col, color, minPx) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(0, mid - Math.max(minPx, amp(col[0]) * maxHalf));
          var ci;
          for (ci = 1; ci < W; ci++) ctx.lineTo(ci, mid - Math.max(minPx, amp(col[ci]) * maxHalf));
          for (ci = W - 1; ci >= 0; ci--) ctx.lineTo(ci, mid + Math.max(minPx, amp(col[ci]) * maxHalf));
          ctx.closePath();
          ctx.fill();
        }
        fillEnvelope(colPeak, 'rgba(120,170,255,0.50)', 0.5); /* гало по пику */
        fillEnvelope(colRms, '#3d8bff', 0.4);                /* ядро по RMS */

        /* ЛИНИЯ ПОРОГА: уровень громкости, ниже которого аудио = тишина (срез).
           Симметрично от центра. Жёлтая пунктирная — двигается живьём за ползунком
           «Тише речи на». Где RMS-ядро ныряет под линию = красная зона. */
        if (typeof opts.thresholdDb === 'number' && isFinite(opts.thresholdDb)) {
          var ty = amp(opts.thresholdDb) * maxHalf;
          ctx.strokeStyle = 'rgba(245,200,60,0.85)';
          ctx.lineWidth = 1;
          if (ctx.setLineDash) ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(0, mid - ty); ctx.lineTo(W, mid - ty);
          ctx.moveTo(0, mid + ty); ctx.lineTo(W, mid + ty);
          ctx.stroke();
          if (ctx.setLineDash) ctx.setLineDash([]);
        }

        /* зоны выреза ПОВЕРХ — полупрозрачная заливка + чёткие красные края */
        if (regions && regions.length) {
          for (var i = 0; i < regions.length; i++) {
            var rx1 = xOf(regions[i].startSec), rx2 = xOf(regions[i].endSec);
            var rw = Math.max(1, rx2 - rx1);
            ctx.fillStyle = 'rgba(239,68,68,0.28)';
            ctx.fillRect(rx1, 0, rw, H);
            ctx.fillStyle = 'rgba(239,68,68,0.95)';
            ctx.fillRect(rx1, 0, 1.5, H);
            ctx.fillRect(rx2 - 1.5, 0, 1.5, H);
          }
        }
      }
      return { draw: draw };
    })();
    /* Состояние для live-перерисовки без host-вызова. */
    var _waveState = null; /* { toolName, canvas, entry, rms, tStart, tEnd } */

    /* Единый сбор параметров с ползунков — ОБЩИЙ для toolsRunTool (apply) и
       waveform-превью, чтобы зоны на канве совпадали с реальным вырезом. */
    function toolsCollectParams(toolName) {
      var params = {};
      function num(id, fn) { var el = document.getElementById(id); if (el) { var v = (fn || parseFloat)(el.value, 10); if (!isNaN(v)) return v; } return undefined; }
      if (toolName === 'silences') {
        var sMin = num('sil-min'); if (sMin !== undefined) params.minDuration = sMin;
        var sPad = num('sil-pad'); if (sPad !== undefined) params.padding = sPad;
        var sThr = num('sil-thresh', parseInt); if (sThr !== undefined) params.silenceThresholdDelta = sThr;
      } else if (toolName === 'jumps') {
        var jPause = num('jmp-pause'); if (jPause !== undefined) params.maxPause = jPause;
        var jBreath = num('jmp-breath'); if (jBreath !== undefined) params.keepBreathing = jBreath;
        var jMin = num('jmp-minseg'); if (jMin !== undefined) params.minSegmentDuration = jMin;
      }
      return params;
    }

    function toolsRenderWaveform() {
      var st = _waveState;
      if (!st || !st.canvas || !st.entry) return;
      var params = toolsCollectParams(st.toolName);
      var pipelineFn = st.toolName === 'jumps' ? DeterministicPipelines.jumpCuts : DeterministicPipelines.cutSilences;
      /* Линия порога — только для «Тишины» (для Jump cuts «порог» = пауза во
         времени, не уровень dB). Тот же marginDb, что детектор → линия = реальный
         срез. */
      var drawOpts = { tStart: st.tStart, tEnd: st.tEnd };
      if (st.toolName === 'silences' && DeterministicPipelines.rmsThresholdInfo) {
        var ud = params.silenceThresholdDelta;
        var info = DeterministicPipelines.rmsThresholdInfo(st.rms, { marginDb: (typeof ud === 'number' && ud > 0) ? ud : 22 });
        if (info) { drawOpts.thresholdDb = info.thresholdDb; toolsUpdateWaveLegend(info, st.toolName); }
      } else {
        toolsUpdateWaveLegend(null, st.toolName);
      }
      var ctx = { transcriptEntry: st.entry, settings: {}, snapshot: null, onStatus: function () {}, abortCheck: function () { return false; } };
      Promise.resolve(pipelineFn(ctx, params)).then(function (r) {
        var regions = (r && r.proposal && r.proposal.removeIntervals) || [];
        WaveformPreview.draw(st.canvas, st.rms, regions, drawOpts);
      }).catch(function () {
        WaveformPreview.draw(st.canvas, st.rms, [], drawOpts);
      });
    }

    /* Числовой ридаут под waveform: уровень речи и порог среза (чтобы пользователь
       видел КОНКРЕТНЫЕ dB, а не только линию). */
    function toolsUpdateWaveLegend(info, toolName) {
      var el = document.getElementById('wave-legend-' + toolName);
      if (!el) return;
      if (info && typeof info.thresholdDb === 'number') {
        var ref = info.speechRefDb != null ? ('речь ≈ ' + Math.round(info.speechRefDb) + ' dB · ') : '';
        el.textContent = ref + 'порог среза ' + Math.round(info.thresholdDb) + ' dB';
        el.hidden = false;
      } else {
        el.hidden = true;
      }
    }

    /* Показывает waveform для инструмента, если в entry есть rmsTimeline. */
    function toolsShowWaveform(toolName, entry) {
      var canvas = document.getElementById('wave-' + toolName);
      if (!canvas) return;
      var rms = entry && entry.audioAnalysis && entry.audioAnalysis.rmsTimeline;
      if (!Array.isArray(rms) || rms.length < 2) { canvas.hidden = true; _waveState = null; return; }
      /* Подгоняем пиксельную ширину canvas под фактическую (CSS width:100%). */
      canvas.hidden = false;
      var cssW = canvas.clientWidth || canvas.parentNode.clientWidth || 300;
      canvas.width = Math.max(2, Math.floor(cssW));
      if (!canvas.height) canvas.height = 72;
      _waveState = {
        toolName: toolName, canvas: canvas, entry: entry, rms: rms,
        tStart: rms[0].t, tEnd: rms[rms.length - 1].t
      };
      toolsRenderWaveform();
    }

    function toolsShowErr(t) {
      if (!toolsErr) return;
      toolsErr.textContent = t || '';
      toolsErr.style.display = t ? 'block' : 'none';
    }

    function toolsSetLed(state) {
      if (!toolsLed) return;
      /* P0-2 (10 июня 2026): третье состояние 'audio' (синий) — есть аудиоанализ
         без транскрипта: «Тишина» и «MultiCam» уже доступны. */
      toolsLed.className = 'transcript-led transcript-led--' +
        (state === 'ok' ? 'green' : state === 'busy' ? 'yellow' : state === 'audio' ? 'blue' : 'red');
      if (toolsLedText) {
        toolsLedText.textContent =
          state === 'ok' ? 'готов' : state === 'busy' ? 'идёт…' : state === 'audio' ? 'только аудио' : 'нет';
      }
    }

    /* HIGH #18 (6 мая 2026): подписка через event listener (заменяет fragile
       window.toolsRefreshLed coupling). Сохраняем window.* для tab-switch + fallback. */
    document.addEventListener('omc:transcript-led-changed', function () {
      try { window.toolsRefreshLed(); } catch (e) {}
    });
    /* 19.06.2026: активная секвенция сменилась — состояние инструментов (waveform-
       превью, proposal) относится к ПРЕЖНЕЙ секвенции. Сбрасываем, чтобы ползунки
       не рисовали чужой waveform, а зависшая карточка не применилась к новой
       секвенции. LED пересчитываем под новую активную. Диспатчится из внешнего
       обработчика ActiveSequenceChanged. */
    document.addEventListener('omc:active-sequence-changed', function () {
      try {
        _waveState = null;
        var ws = document.getElementById('wave-silences'); if (ws) ws.hidden = true;
        var wj = document.getElementById('wave-jumps'); if (wj) wj.hidden = true;
        toolsHideAllProposals();
        window.toolsRefreshLed();
      } catch (e) {}
    });
    /* Вычислить и показать LED/карточки для КОНКРЕТНОЙ секвенции. */
    function _applyToolsLedForSeq(seqName) {
      var hasTranscript = false, hasAudio = false;
      try {
        if (seqName) {
          var f = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, seqName);
          if (f && f.entry) {
            hasTranscript = !!(f.entry.segments && f.entry.segments.length);
            /* P0-2: аудиоанализ (ffmpeg) без Whisper достаточен для «Тишины» */
            hasAudio = hasTranscript || !!f.entry.audioAnalysis;
          }
        }
      } catch (e) { /* findTranscriptEntry не должен падать */ }
      toolsSetLed(hasTranscript ? 'ok' : hasAudio ? 'audio' : 'red');
      toolsUpdateCards(hasTranscript, hasAudio);
    }
    var _ledRefreshInFlight = false;
    window.toolsRefreshLed = function () {
      /* Во время «Анализ аудио» держим busy — не перетираем индикатор прогресса. */
      if (_toolsBusy) { toolsSetLed('busy'); return; }
      /* 19.06.2026 FIX: LED отражает АКТИВНУЮ секвенцию. ВСЕГДА запрашиваем свежий
         снапшот — НЕ полагаемся на _snapDirty/lastSnap: CEP-событие
         ActiveSequenceChanged ненадёжно («могут не работать»), при его пропуске LED
         показывал состояние СТАРОЙ секвенции (или произвольной keys[0]). in-flight
         guard защищает от наложения частых вызовов (tab-switch/события). */
      if (_ledRefreshInFlight) return;
      _ledRefreshInFlight = true;
      try {
        PremiereBridge.getTimelineSnapshot(function (err, snap) {
          _ledRefreshInFlight = false;
          if (!err && snap && snap.ok) { lastSnap = snap; _snapDirty = false; _applyToolsLedForSeq(snap.sequenceName || ''); }
          else _applyToolsLedForSeq((lastSnap && lastSnap.sequenceName) || '');
        });
      } catch (e) { _ledRefreshInFlight = false; _applyToolsLedForSeq((lastSnap && lastSnap.sequenceName) || ''); }
    };
    /* Busy-индикатор «Анализ аудио» именно на вкладке Инструменты (кнопка тут же).
       Раньше busy шёл только на Chat-LED — на Tools-вкладке было непонятно, идёт
       анализ или нет. Вызывается из onAudioOnlyAnalyze (start/finally). */
    window.__toolsSetBusy = function (on) {
      _toolsBusy = !!on;
      if (on) toolsSetLed('busy');
      else window.toolsRefreshLed();
    };

    /* P0-2 (10 июня 2026): карточки по реальным требованиям пайплайнов.
       .needs-transcript — нужны Whisper-сегменты (паразиты, jump cuts, главы);
       .needs-audio — достаточно audioAnalysis ИЛИ транскрипта («Тишина»);
       MultiCam без класса — ему нужен только снимок таймлайна + ffmpeg. */
    function toolsUpdateCards(hasTranscript, hasAudio) {
      var i;
      var cards = document.querySelectorAll('.tool-card.needs-transcript');
      for (i = 0; i < cards.length; i++) {
        if (hasTranscript) cards[i].classList.remove('disabled');
        else cards[i].classList.add('disabled');
      }
      var audioCards = document.querySelectorAll('.tool-card.needs-audio');
      for (i = 0; i < audioCards.length; i++) {
        if (hasAudio) audioCards[i].classList.remove('disabled');
        else audioCards[i].classList.add('disabled');
      }
    }

    function toolsDisableRun(disabled) {
      var btns = document.querySelectorAll('.tool-run');
      for (var i = 0; i < btns.length; i++) btns[i].disabled = disabled;
    }

    /* ── Slider bindings ──────────────────────────────────── */
    function bindSlider(sliderId, valId, suffix) {
      var s = document.getElementById(sliderId);
      var v = document.getElementById(valId);
      if (!s || !v) return;
      function upd() { v.textContent = s.value + (suffix || ''); }
      s.addEventListener('input', upd);
      upd();
    }
    /* Live-перерисовка waveform-зон при движении ползунков инструмента. Через тот
       же пайплайн (preview==apply), без host-вызова. rAF-троттлинг отрисовки. */
    function bindWaveformRedraw(ids, toolName) {
      var timer = null;
      function onInput() {
        if (!_waveState || _waveState.toolName !== toolName) return;
        /* setTimeout-дебаунс (не requestAnimationFrame: rAF не вызывается, когда
           панель в фоне/не перерисовывается, и live-обновление зависало). */
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { timer = null; toolsRenderWaveform(); }, 40);
      }
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) el.addEventListener('input', onInput);
      }
    }
    bindWaveformRedraw(['sil-min', 'sil-pad', 'sil-thresh'], 'silences');
    bindWaveformRedraw(['jmp-pause', 'jmp-breath', 'jmp-minseg'], 'jumps');
    bindSlider('sil-min', 'sil-min-val', 'с');
    bindSlider('sil-pad', 'sil-pad-val', 'с');
    bindSlider('jmp-pause', 'jmp-pause-val', 'с');
    bindSlider('jmp-minseg', 'jmp-minseg-val', 'с');
    bindSlider('jcut-offset', 'jcut-offset-val', '');
    bindSlider('mc-minhold', 'mc-minhold-val', 'с');
    bindSlider('mc-maxhold', 'mc-maxhold-val', 'с');

    /* MultiCam: «X dB», «-X dB», вариативность 0 = «выкл» */
    (function () {
      var s = document.getElementById('mc-margin');
      var v = document.getElementById('mc-margin-val');
      if (!s || !v) return;
      function upd() { v.textContent = s.value + ' dB'; }
      s.addEventListener('input', upd);
      upd();
    })();
    (function () {
      var s = document.getElementById('mc-silence');
      var v = document.getElementById('mc-silence-val');
      if (!s || !v) return;
      function upd() { v.textContent = '-' + s.value + ' dB'; }
      s.addEventListener('input', upd);
      upd();
    })();
    (function () {
      var s = document.getElementById('mc-jitter');
      var v = document.getElementById('mc-jitter-val');
      if (!s || !v) return;
      function upd() { v.textContent = s.value === '0' ? 'выкл' : s.value + 'с'; }
      s.addEventListener('input', upd);
      upd();
    })();

    /* Кастомный выбор дорожек по спикерам (AutoPod-паттерн «теги дорожек»,
       12 июня 2026): авто-схема «V1 wide, A1→V2…» включает молчащего спикера,
       когда микрофоны не на первых аудиодорожках (камерный звук BRAW) или
       аудио не засинхронено с порядком видео. Режим «Вручную» читает снимок
       таймлайна и даёт выбрать wide-дорожку и пары «микрофон → камера»
       с именами файлов, чтобы дорожки были отличимы. */
    function toolsMcReadMapping() {
      var mode = document.getElementById('mc-map-mode');
      if (!mode || mode.value !== 'custom') return null;
      var wideSel = document.getElementById('mc-wide');
      if (!wideSel) return null; /* селекты ещё не отрендерены — авто */
      var speakers = [];
      var rows = document.querySelectorAll('#mc-mapping .mc-speaker-row');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].style.display === 'none') continue; /* свёрнуто счётчиком «Спикеров» */
        var aSel = rows[i].querySelector('.mc-sp-audio');
        var vSel = rows[i].querySelector('.mc-sp-video');
        if (!aSel || !vSel) continue;
        speakers.push({
          audioTrack: parseInt(aSel.value, 10),
          videoTrack: parseInt(vSel.value, 10),
          label: 'Гость ' + (i + 1)
        });
      }
      return { wideVideoTrack: parseInt(wideSel.value, 10), speakers: speakers };
    }

    (function () {
      var mode = document.getElementById('mc-map-mode');
      var box = document.getElementById('mc-mapping');
      if (!mode || !box) return;

      function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }
      /* Подпись дорожки: «A4 · ZOOM0002_Tr2.wav» — имя первого клипа/файла,
         чтобы отличать микрофонные WAV от камерного звука. */
      function trackOption(prefix, t, clips, selected) {
        var name = '';
        for (var i = 0; i < clips.length; i++) {
          var c = clips[i];
          if (c.trackType !== t.type || c.trackIndex !== t.index) continue;
          name = (c.mediaPath ? String(c.mediaPath).split(/[\\\/]/).pop() : '') || c.name || '';
          break;
        }
        var label = prefix + (t.index + 1) + (name ? ' · ' + name : ' · (пусто)');
        return '<option value="' + t.index + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>';
      }

      function render(snap) {
        var tracks = snap.tracks || [];
        var clips = snap.clips || [];
        var vTracks = tracks.filter(function (t) { return t.type === 'video'; });
        var aTracks = tracks.filter(function (t) { return t.type === 'audio'; });
        if (vTracks.length < 2 || aTracks.length < 1) {
          box.innerHTML = '<div style="color:#f59e0b;">Нужно ≥2 видеодорожки и ≥1 аудио. Найдено: ' +
            vTracks.length + ' видео, ' + aTracks.length + ' аудио.</div>';
          return;
        }
        var maxSpeakers = Math.min(aTracks.length, vTracks.length - 1, 4);
        var html = '<div class="param-row"><span class="param-label">Общий план</span>' +
          '<select id="mc-wide" style="flex:1;min-width:0;">';
        for (var wv = 0; wv < vTracks.length; wv++) {
          html += trackOption('V', vTracks[wv], clips, wv === 0);
        }
        html += '</select></div>';
        html += '<div class="param-row"><span class="param-label">Спикеров</span>' +
          '<select id="mc-spcount" style="flex:1;min-width:0;">';
        for (var sc = 1; sc <= maxSpeakers; sc++) {
          html += '<option value="' + sc + '"' + (sc === maxSpeakers ? ' selected' : '') + '>' + sc + '</option>';
        }
        html += '</select></div>';
        for (var sp = 0; sp < maxSpeakers; sp++) {
          html += '<div class="param-row mc-speaker-row" data-speaker="' + sp + '">' +
            '<span class="param-label">Спикер ' + (sp + 1) + '</span>' +
            '<select class="mc-sp-audio" title="Микрофон спикера" style="flex:1;min-width:0;">';
          for (var sa = 0; sa < aTracks.length; sa++) {
            html += trackOption('A', aTracks[sa], clips, sa === sp);
          }
          html += '</select><span style="opacity:.6;">→</span>' +
            '<select class="mc-sp-video" title="Камера спикера" style="flex:1;min-width:0;">';
          for (var sv = 0; sv < vTracks.length; sv++) {
            html += trackOption('V', vTracks[sv], clips, sv === sp + 1);
          }
          html += '</select></div>';
        }
        box.innerHTML = html;
        var cnt = document.getElementById('mc-spcount');
        function updRows() {
          var n = parseInt(cnt.value, 10);
          var rows = box.querySelectorAll('.mc-speaker-row');
          for (var i = 0; i < rows.length; i++) {
            rows[i].style.display = i < n ? '' : 'none';
          }
        }
        cnt.addEventListener('change', updRows);
        updRows();
      }

      mode.addEventListener('change', function () {
        if (mode.value !== 'custom') {
          box.style.display = 'none';
          box.innerHTML = '';
          return;
        }
        box.style.display = '';
        box.innerHTML = '<div style="opacity:.7;">Читаю дорожки таймлайна…</div>';
        execGetSnapshot(true).then(function (snap) {
          if (!snap || !snap.ok) {
            box.innerHTML = '<div style="color:#f59e0b;">Не удалось получить снимок таймлайна.</div>';
            return;
          }
          render(snap);
        }, function (err) {
          box.innerHTML = '<div style="color:#f59e0b;">' + String(err && err.message || err) + '</div>';
        });
      });
    })();

    /* B1-4/B1-6 (10 июня 2026): пресеты шоу для MultiCam (AutoPod-паттерн
       «конфигурации»). Встроенные «спокойный/динамичный» + один пользовательский
       слот в localStorage. Выбор пресета двигает слайдеры (и триггерит input,
       чтобы обновились подписи значений). */
    (function () {
      var sel = document.getElementById('mc-preset');
      var saveBtn = document.getElementById('mc-preset-save');
      if (!sel) return;
      var MC_SLIDERS = ['mc-minhold', 'mc-maxhold', 'mc-margin', 'mc-silence', 'mc-jitter'];
      var BUILTIN = {
        /* Спокойный: интервью/лекция — длинные планы, реже переключения */
        calm: { 'mc-minhold': 2.5, 'mc-maxhold': 12, 'mc-margin': 6, 'mc-silence': 35, 'mc-jitter': 0 },
        /* Динамичный: подкаст/шоу — короткие планы, лёгкая вариативность */
        dynamic: { 'mc-minhold': 1.0, 'mc-maxhold': 6, 'mc-margin': 5, 'mc-silence': 35, 'mc-jitter': 0.2 }
      };
      var LS_KEY = 'mcShowPreset';
      function applyValues(vals) {
        for (var i = 0; i < MC_SLIDERS.length; i++) {
          var id = MC_SLIDERS[i];
          var s = document.getElementById(id);
          if (!s || typeof vals[id] === 'undefined') continue;
          s.value = String(vals[id]);
          s.dispatchEvent(new Event('input'));
        }
      }
      sel.addEventListener('change', function () {
        if (sel.value === 'calm' || sel.value === 'dynamic') {
          applyValues(BUILTIN[sel.value]);
        } else if (sel.value === 'saved') {
          try {
            var raw = localStorage.getItem(LS_KEY);
            if (raw) applyValues(JSON.parse(raw));
            else toolsShowErr('«Мой пресет» пуст — настройте слайдеры и нажмите 💾.');
          } catch (e) {
            console.warn('[tools] mc preset load failed:', e && e.message);
          }
        }
      });
      if (saveBtn) {
        saveBtn.addEventListener('click', function () {
          var vals = {};
          for (var i = 0; i < MC_SLIDERS.length; i++) {
            var s = document.getElementById(MC_SLIDERS[i]);
            if (s) vals[MC_SLIDERS[i]] = parseFloat(s.value);
          }
          try {
            localStorage.setItem(LS_KEY, JSON.stringify(vals));
            sel.value = 'saved';
            toolsStatusUi.show('Пресет сохранён.', false);
            setTimeout(function () { toolsStatusUi.hide(); }, 1500);
          } catch (e2) {
            toolsShowErr('Не удалось сохранить пресет: ' + (e2.message || e2));
          }
        });
      }
      /* Ручное движение любого слайдера = пресет «свой» */
      for (var mi = 0; mi < MC_SLIDERS.length; mi++) {
        var ms = document.getElementById(MC_SLIDERS[mi]);
        if (!ms) continue;
        ms.addEventListener('change', function () { sel.value = ''; });
      }
    })();

    /* jmp-breath: показываем миллисекунды для читаемости (0.05с → «50мс») */
    (function () {
      var s = document.getElementById('jmp-breath');
      var v = document.getElementById('jmp-breath-val');
      if (!s || !v) return;
      function upd() {
        var ms = Math.round(parseFloat(s.value) * 1000);
        v.textContent = ms + 'мс';
      }
      s.addEventListener('input', upd);
      upd();
    })();

    /* «Тише речи на»: дельта от средней громкости речи, показываем «X dB» */
    (function () {
      var s = document.getElementById('sil-thresh');
      var v = document.getElementById('sil-thresh-val');
      if (!s || !v) return;
      function upd() { v.textContent = s.value + ' dB'; }
      s.addEventListener('input', upd);
      upd();
    })();

    /* Кол-во глав: 0 = «авто» */
    (function () {
      var s = document.getElementById('ch-count');
      var v = document.getElementById('ch-count-val');
      if (!s || !v) return;
      function upd() { v.textContent = s.value === '0' ? 'авто' : s.value; }
      s.addEventListener('input', upd);
      upd();
    })();

    /* ── Toggle buttons ───────────────────────────────────── */
    function bindToggle(groupId) {
      var g = document.getElementById(groupId);
      if (!g) return;
      var btns = g.querySelectorAll('.toggle-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('click', function () {
          var sibs = this.parentElement.querySelectorAll('.toggle-btn');
          for (var j = 0; j < sibs.length; j++) sibs[j].classList.remove('active');
          this.classList.add('active');
        });
      }
    }
    function getToggle(groupId) {
      var g = document.getElementById(groupId);
      if (!g) return '';
      var a = g.querySelector('.toggle-btn.active');
      return a ? a.getAttribute('data-val') : '';
    }
    bindToggle('filler-mode');
    bindToggle('jcut-mode');

    /* ── Proposal card ────────────────────────────────────── */
    function toolsShowProposal(areaId, proposal) {
      var area = document.getElementById(areaId);
      if (!area) return;
      _toolsProposal = proposal;
      _toolsProposalArea = area;
      area.innerHTML = '';
      area.className = 'proposal-area visible';
      var sum = document.createElement('div');
      sum.className = 'proposal-summary';
      sum.textContent = proposal.summary || 'Готово.';
      area.appendChild(sum);
      /* B1-7: pre-flight варнинги пайплайна (общий звук, дубль файла и т.п.) */
      if (proposal.warnings && proposal.warnings.length) {
        for (var wi = 0; wi < proposal.warnings.length; wi++) {
          var wEl = document.createElement('div');
          wEl.style.cssText = 'color:#f59e0b;font-size:11px;margin:4px 0;';
          wEl.textContent = '⚠ ' + proposal.warnings[wi];
          area.appendChild(wEl);
        }
      }
      var btns = document.createElement('div');
      btns.className = 'proposal-btns';
      var applyB = document.createElement('button');
      applyB.className = 'btn-apply';
      applyB.textContent = 'Применить';
      applyB.onclick = function () {
        /* HIGH #1: sequence-switch guard. Пользователь мог переключиться на
           другую секвенцию между proposal и apply — apply убил бы её таймлайн. */
        applyB.disabled = true;
        var pSnap = _toolsProposal && _toolsProposal.snapshot;
        assertSequenceMatch(pSnap, function (err, ok) {
          applyB.disabled = false;
          if (!ok) {
            toolsShowErr(err && err.message ? err.message : 'Sequence mismatch');
            return;
          }
          toolsApply();
        });
      };
      btns.appendChild(applyB);
      var cancelB = document.createElement('button');
      cancelB.className = 'btn-cancel';
      cancelB.textContent = 'Отмена';
      cancelB.onclick = function () { toolsHideProposal(area); };
      btns.appendChild(cancelB);
      area.appendChild(btns);
    }

    function toolsHideProposal(area) {
      if (area) { area.innerHTML = ''; area.className = 'proposal-area'; }
      _toolsProposal = null;
      _toolsProposalArea = null;
    }

    function toolsHideAllProposals() {
      var areas = document.querySelectorAll('.proposal-area');
      for (var i = 0; i < areas.length; i++) { areas[i].innerHTML = ''; areas[i].className = 'proposal-area'; }
      _toolsProposal = null;
      _toolsProposalArea = null;
    }

    /* ── Apply ────────────────────────────────────────────── */
    function toolsApply() {
      if (!_toolsProposal) return;
      var prop = _toolsProposal;
      var area = _toolsProposalArea;

      /* 19.06.2026: деструктивный apply входит в общий operation-queue —
         взаимоисключение с чатом (race на ripple/razor таймлайна). endOperation
         вызывается в каждом host-колбэке после toolsDisableRun(false). */
      if (!beginOperation('tools-apply:' + prop.kind)) {
        toolsShowErr('Идёт обработка в чате — дождитесь завершения (кнопка «Стоп» на вкладке «Чат»).');
        return;
      }

      if (prop.kind === 'transcript_cuts') {
        toolsStatusUi.show('Применяю монтаж…', true);
        toolsDisableRun(true);
        /* B2-9: checkpoint перед ripple-удалениями */
        _makeSequenceCheckpoint('монтаж (tools)', function () {
        PremiereBridge.applyTranscriptCuts(
          { removeIntervals: prop.removeIntervals, summary: prop.summary },
          function (err, dataTC) {
            toolsDisableRun(false);
            endOperation();
            toolsStatusUi.hide();
            if (err) { toolsShowErr('Ошибка: ' + String(err.message || err)); return; }
            /* Host-контракт: ok:false (locked-дорожки и т.п.) приходит как data */
            if (dataTC && dataTC.ok === false) {
              toolsShowErr('НЕ применено: ' + describeHostFailure(dataTC));
              return;
            }
            try {
              var sk = lastSnap && lastSnap.sequenceName ? lastSnap.sequenceName : '';
              if (sk) ContextStore.applyRippleDeletionsToTranscript(TRANSCRIPT_PID, sk, prop.removeIntervals || []);
            } catch (e) {
              console.warn('[tools] applyRippleDeletionsToTranscript failed:', e && e.message);
            }
            _snapDirty = true;
            lastSnap = null; /* force chat to re-fetch snapshot */
            toolsHideProposal(area);
            toolsStatusUi.show('Готово! Откат: Cmd+Z / Ctrl+Z', false);
            /* Sync chat transcript LED */
            setTranscriptLed('ok');
            setTimeout(function () { toolsStatusUi.hide(); }, 2500);
          }
        );
        }); /* конец _makeSequenceCheckpoint */
        return;
      }

      if (prop.kind === 'markers') {
        toolsStatusUi.show('Создаю маркеры…', true);
        toolsDisableRun(true);
        PremiereBridge.addSequenceMarkers(prop.markers || [], function (err, data) {
          toolsDisableRun(false);
          endOperation();
          toolsStatusUi.hide();
          if (err) { toolsShowErr('Ошибка: ' + String(err.message || err)); return; }
          toolsHideProposal(area);
          var cnt = (data && data.createdSeconds) ? data.createdSeconds.length : 0;
          toolsStatusUi.show('Создано маркеров: ' + cnt + '. Откат: Cmd+Z', false);
          setTimeout(function () { toolsStatusUi.hide(); }, 2500);
        });
        return;
      }

      if (prop.kind === 'j_cuts') {
        var ml = prop.mode === 'l' ? 'L-cuts' : prop.mode === 'both' ? 'J+L-cuts' : 'J-cuts';
        toolsStatusUi.show('Применяю ' + ml + '…', true);
        toolsDisableRun(true);
        _snapDirty = true;
        lastSnap = null; /* force chat to re-fetch snapshot */
        PremiereBridge.applyJCuts(
          { offsetFrames: prop.offsetFrames || 4, mode: prop.mode || 'j' },
          function (err, data) {
            toolsDisableRun(false);
            endOperation();
            toolsStatusUi.hide();
            if (err) { toolsShowErr('Ошибка: ' + String(err.message || err)); return; }
            toolsHideProposal(area);
            if (data && data.ok) {
              toolsStatusUi.show(ml + ': ' + data.applied + '/' + data.totalCuts + ' стыков. Откат: Cmd+Z', false);
            } else {
              toolsShowErr('Ошибка: ' + ((data && data.error) || 'неизвестная'));
            }
            setTimeout(function () { toolsStatusUi.hide(); }, 2500);
          }
        );
        return;
      }

      if (prop.kind === 'multicam_cuts') {
        toolsStatusUi.show('Применяю авто-MultiCam…', true);
        toolsDisableRun(true);
        _snapDirty = true;
        lastSnap = null;
        /* B2-9: checkpoint — razor режет клипы даже в режиме disable */
        _makeSequenceCheckpoint('MultiCam', function () {
        PremiereBridge.applyMulticamCuts(prop.plan, function (err, data) {
          toolsDisableRun(false);
          endOperation();
          toolsStatusUi.hide();
          if (err) { toolsShowErr('Ошибка: ' + String(err.message || err)); return; }
          toolsHideProposal(area);
          if (data && data.ok) {
            var msg = 'MultiCam: ' + (data.cutsApplied || 0) + ' разрезов, ' +
              (data.segmentsApplied || 0) + ' сегментов, ' +
              (data.disabledCount || 0) + ' клипов отключено. Откат: Cmd+Z';
            toolsStatusUi.show(msg, false);
          } else {
            toolsShowErr('Ошибка: ' + ((data && data.error) || 'неизвестная'));
          }
          setTimeout(function () { toolsStatusUi.hide(); }, 4000);
        });
        }); /* конец _makeSequenceCheckpoint */
        return;
      }

      endOperation();
      toolsShowErr('Неизвестный тип: ' + prop.kind);
    }

    /* ── Run tool ─────────────────────────────────────────── */
    async function toolsRunTool(toolName) {
      toolsShowErr('');
      toolsHideAllProposals();

      var pipelineFn, params = {}, proposalId;

      switch (toolName) {
        case 'silences':
          pipelineFn = DeterministicPipelines.cutSilences;
          params.minDuration = parseFloat(document.getElementById('sil-min').value);
          params.padding = parseFloat(document.getElementById('sil-pad').value);
          var silThreshEl = document.getElementById('sil-thresh');
          if (silThreshEl) params.silenceThresholdDelta = parseInt(silThreshEl.value, 10);
          proposalId = 'proposal-silences';
          break;
        case 'fillers':
          pipelineFn = DeterministicPipelines.cutFillers;
          params.sensitivity = getToggle('filler-mode') || 'strict';
          proposalId = 'proposal-fillers';
          break;
        case 'jumps':
          pipelineFn = DeterministicPipelines.jumpCuts;
          params.maxPause = parseFloat(document.getElementById('jmp-pause').value);
          var jmpBreathEl = document.getElementById('jmp-breath');
          if (jmpBreathEl) params.keepBreathing = parseFloat(jmpBreathEl.value);
          var jmpMinSegEl = document.getElementById('jmp-minseg');
          if (jmpMinSegEl) params.minSegmentDuration = parseFloat(jmpMinSegEl.value);
          proposalId = 'proposal-jumps';
          break;
        case 'chapters':
          pipelineFn = DeterministicPipelines.chapterize;
          var chCountEl = document.getElementById('ch-count');
          if (chCountEl) {
            var chVal = parseInt(chCountEl.value, 10);
            if (chVal > 0) params.maxChapters = chVal;
          }
          proposalId = 'proposal-chapters';
          break;
        case 'jcuts':
          pipelineFn = DeterministicPipelines.jCuts;
          params.offsetFrames = parseInt(document.getElementById('jcut-offset').value, 10);
          params.mode = getToggle('jcut-mode') || 'j';
          proposalId = 'proposal-jcuts';
          break;
        case 'multicam':
          pipelineFn = DeterministicPipelines.multicamFromAudio;
          /* UI-2 / Phase 2B: слайдеры параметров плана переключений */
          var mcMinHoldEl = document.getElementById('mc-minhold');
          if (mcMinHoldEl) params.minHoldSec = parseFloat(mcMinHoldEl.value);
          var mcMaxHoldEl = document.getElementById('mc-maxhold');
          if (mcMaxHoldEl) params.maxHoldSec = parseFloat(mcMaxHoldEl.value);
          var mcMarginEl = document.getElementById('mc-margin');
          if (mcMarginEl) params.bleedMarginDb = parseInt(mcMarginEl.value, 10);
          var mcSilenceEl = document.getElementById('mc-silence');
          if (mcSilenceEl) params.silenceThresholdDb = -parseInt(mcSilenceEl.value, 10);
          var mcJitterEl = document.getElementById('mc-jitter');
          if (mcJitterEl) params.variationsJitterSec = parseFloat(mcJitterEl.value);
          /* Кастомный выбор дорожек: null = авто-схема пайплайна */
          var mcMapping = toolsMcReadMapping();
          if (mcMapping) params.mapping = mcMapping;
          proposalId = 'proposal-multicam';
          break;
        default:
          toolsShowErr('Неизвестный инструмент.');
          return;
      }

      /* 19.06.2026: Tools-tab входит в ОБЩИЙ operation-queue. Раньше toolsRunTool
         не вызывал beginOperation — только локальный toolsDisableRun. Это давало
         re-entrancy: чат-операция и Tools-tab пайплайн могли бежать КОНКУРЕНТНО
         (оба бьют в host/ffmpeg/снапшот, оба строят proposal → гонка на apply).
         Подтверждено вживую: при активном чате кнопка silences не блокировалась
         и стартовала параллельно. Теперь два пути взаимоисключающие. */
      if (!beginOperation('tools:' + toolName)) {
        toolsShowErr('Идёт обработка в чате — дождитесь завершения (кнопка «Стоп» на вкладке «Чат»).');
        return;
      }
      toolsDisableRun(true);
      toolsStatusUi.show('Выполняю…', true);
      /* keepStatus: noChanges-сообщение должно ОСТАТЬСЯ видимым. Иначе finally
         ниже (toolsStatusUi.hide при отсутствии proposal) скрывал его синхронно
         сразу после show → инструмент без находок выглядел как «кнопка не работает»
         (юзер не видел «Длинных пауз не обнаружено»). */
      var keepStatus = false;

      try {
        var snap = await execGetSnapshot(true);
        if (!snap || !snap.ok) {
          toolsShowErr(snap && snap.error ? snap.error : 'Не удалось получить снимок таймлайна.');
          return;
        }
        var seqKey = snap.sequenceName || '';
        var entry = seqKey ? (ContextStore.findTranscriptEntry(TRANSCRIPT_PID, seqKey) || {}).entry : null;
        /* Waveform-превью: если в entry есть RMS-таймлайн — показываем огибающую +
           зоны. Дальше движение ползунков перерисовывает зоны без host-вызова. */
        if (toolName === 'silences' || toolName === 'jumps') toolsShowWaveform(toolName, entry);
        var settings = ContextStore.getResolvedSettings();

        var ctx = {
          settings: settings,
          snapshot: snap,
          transcriptEntry: entry,
          onStatus: function (msg) { toolsStatusUi.show(msg, true); },
          abortCheck: function () { return false; },
          rmsExtractor: async function (innerCtx, mapping, p) {
            var windowSec = typeof p.frameSec === 'number' ? p.frameSec : 0.05;
            var allClips = snap.clips || [];
            var timelines = [];
            var mediaPaths = [];
            for (var si = 0; si < mapping.speakers.length; si++) {
              var aIdx = mapping.speakers[si].audioTrack;
              var clip = null;
              for (var ci = 0; ci < allClips.length; ci++) {
                // Берём первый клип на дорожке: ожидается один синхронизированный мик-клип на дорожку.
                // Дорожки с несколькими клипами (перезапуск микрофона) не поддерживаются — берётся первый.
                if (allClips[ci].trackType === 'audio' && allClips[ci].trackIndex === aIdx) { clip = allClips[ci]; break; }
              }
              var mediaPath = clip && clip.mediaPath;
              if (!mediaPath) {
                throw new Error('Аудиодорожка ' + (aIdx + 1) + ': нет файла на диске (нужен один синхронизированный клип на дорожку).');
              }
              var tl = await AudioPreprocess.computeRmsTimeline(mediaPath, { windowSec: windowSec });
              /* media-time → sequence-time: клип на таймлайне подрезан (inPoint),
                 а RMS считается по всему файлу — без ремапа план уезжает
                 на величину inPoint и выходит за конец секвенции. */
              tl = DeterministicPipelines.remapRmsToSequenceTime(tl, clip);
              timelines.push(tl);
              mediaPaths.push(mediaPath);
            }
            /* B1-7: mediaPaths нужны пайплайну для pre-flight детекта общего файла */
            return { timelines: timelines, mediaPaths: mediaPaths };
          }
        };

        var result = await pipelineFn(ctx, params);

        if (!result.ok) {
          toolsShowErr(result.error || 'Ошибка.');
        } else if (result.noChanges) {
          toolsStatusUi.show(result.summary || 'Изменений нет.', false);
          keepStatus = true;
          setTimeout(function () { toolsStatusUi.hide(); }, 4000);
        } else if (result.proposal) {
          /* 19.06.2026 БЕЗОПАСНОСТЬ: привязываем proposal к секвенции, на которой
             он построен. Без snapshot assertSequenceMatch (на Apply) пропускал
             guard → правки могли уйти в ДРУГУЮ секвенцию, если пользователь
             переключился между proposal и Apply. Теперь Apply сверит имя. */
          result.proposal.snapshot = snap;
          result.proposal.seqKey = seqKey;
          toolsShowProposal(proposalId, result.proposal);
          toolsStatusUi.hide();
        }
      } catch (e) {
        toolsShowErr(String(e.message || e));
      } finally {
        endOperation();
        toolsDisableRun(false);
        if (!_toolsProposal && !keepStatus) toolsStatusUi.hide();
      }
    }

    /* ── Wire run buttons ─────────────────────────────────── */
    var runBtns = document.querySelectorAll('.tool-run');
    for (var ri = 0; ri < runBtns.length; ri++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var tool = btn.getAttribute('data-tool');
          if (tool) toolsRunTool(tool);
        });
      })(runBtns[ri]);
    }

    /* ── Tools transcribe button → same as chat's ─────────── */
    if (toolsTranscribe) {
      toolsTranscribe.onclick = function () {
        /* Switch to chat view and trigger transcribe there */
        var chatTab = document.querySelector('.view-tab[data-view="chat"]');
        if (chatTab) chatTab.click();
        setTimeout(function () {
          if (el.transcribe) el.transcribe.click();
        }, 100);
      };
    }

    /* ── Init LED ─────────────────────────────────────────── */
    toolsRefreshLed();
  })();
});
