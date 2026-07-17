/**
 * Единая панель: все функции (таймкоды / текст / маркеры / аудио) в одном чате.
 *
 * Архитектура:
 *  - Один panelId 'unified', один набор инструментов TOOLS_UNIFIED, единый промпт.
 *  - Транскрибация ОБЩАЯ — одна кнопка, общий кэш-файл.
 *  - Стартеры группируются по категориям (таймлайн / текст / маркеры) через вкладки.
 *  - Кнопка undo для маркеров (точечное удаление), для таймкодов — Cmd+Z в Premiere.
 */
try { window.__PANEL_BUILD__ = '2026-07-06-montage-v2'; } catch (e) {}
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
    usageBadge: document.getElementById('usage-badge'),
    usageMenu: document.getElementById('usage-menu'),
    usagePopover: document.getElementById('usage-popover'),
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
  var _pendingPlanContext = null;
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
   * Волна 2 п.1 (10.07.2026): каталог вынесен в shared/error-humanizer.js
   * (сетевые коды, HTTP-статусы Cloud.ru, ffmpeg, Whisper). Здесь — делегат
   * с минимальным fallback на случай не загрузившегося модуля.
   * Возвращает {kind, hint}.
   */
  function _classifyError(err) {
    if (typeof ErrorHumanizer !== 'undefined' && ErrorHumanizer && typeof ErrorHumanizer.classify === 'function') {
      return ErrorHumanizer.classify(err);
    }
    var msg = String(err && err.message || err || '').toLowerCase();
    if (/abort|cancel/.test(msg)) {
      return { kind: 'cancel', hint: 'Операция отменена пользователем.' };
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

  /* ─── Бейдж расхода токенов/₽ за сессию (usage-meter) ───────────────
   * Формат: 'Σ 12.3K↑ 4.5K↓ · 4.82 ₽'. Скрыт до первого расхода. */
  function fmtTok(n) {
    var v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
    return String(v);
  }
  function updateUsageBadge(s) {
    if (!el.usageBadge || !s) return;
    if (s.totalTokens === 0 && s.rubles === 0) {
      el.usageBadge.hidden = true;
      if (el.usageMenu) el.usageMenu.classList.remove('open');
      return;
    }
    el.usageBadge.textContent =
      'Σ ' + fmtTok(s.inTokens) + '↑ ' + fmtTok(s.outTokens) + '↓ · ' +
      s.rubles.toFixed(2) + ' ₽';
    el.usageBadge.hidden = false;
    /* Если поповер открыт — обновляем на лету */
    if (el.usageMenu && el.usageMenu.classList.contains('open')) renderUsagePopover();
  }

  /* Поповер контекста (Волна 2 п.2): % окна контекста последнего запроса,
   * разбивка system+tools (baseline) vs диалог, подсказка «начните новый чат».
   * DOM строится через textContent — без innerHTML. */
  function _upRow(label, value) {
    var row = document.createElement('div');
    row.className = 'up-row';
    var l = document.createElement('span');
    l.className = 'up-label';
    l.textContent = label;
    var v = document.createElement('span');
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }
  function renderUsagePopover() {
    if (!el.usagePopover || !window.UsageMeter) return;
    var box = el.usagePopover;
    while (box.firstChild) box.removeChild(box.firstChild);
    var s = UsageMeter.getSummary();
    var ctx = UsageMeter.getContextInfo ? UsageMeter.getContextInfo() : null;

    if (ctx && ctx.ctxTokens > 0) {
      box.appendChild(_upRow('Контекст (' + ctx.model.replace(/^.*\//, '') + ')',
        fmtTok(ctx.promptTokens) + ' / ' + fmtTok(ctx.ctxTokens) + ' · ' + ctx.pct + '%'));
      var bar = document.createElement('div');
      bar.className = 'up-bar';
      var fill = document.createElement('i');
      fill.style.width = Math.max(1, ctx.pct) + '%';
      if (ctx.pct >= 80) fill.className = 'crit';
      else if (ctx.pct >= 50) fill.className = 'warn';
      bar.appendChild(fill);
      box.appendChild(bar);
      box.appendChild(_upRow('система + инструменты', '≈' + fmtTok(ctx.baseTokens)));
      box.appendChild(_upRow('диалог + результаты', '≈' + fmtTok(ctx.dialogTokens)));
    } else if (ctx) {
      box.appendChild(_upRow('Последний запрос', fmtTok(ctx.promptTokens) + '↑ ' +
        fmtTok(ctx.completionTokens) + '↓'));
    } else {
      var none = document.createElement('div');
      none.className = 'up-hint';
      none.textContent = 'Чат-запросов ещё не было (только Whisper).';
      box.appendChild(none);
    }

    var sep = document.createElement('hr');
    box.appendChild(sep);
    box.appendChild(_upRow('Сессия', fmtTok(s.inTokens) + '↑ ' + fmtTok(s.outTokens) + '↓'));
    if (s.whisperSec > 0) {
      box.appendChild(_upRow('Whisper', Math.round(s.whisperSec) + ' с'));
    }
    box.appendChild(_upRow('Стоимость', s.rubles.toFixed(2) + ' ₽'));

    if (ctx && ctx.pct !== null && ctx.pct >= 50) {
      var hint = document.createElement('div');
      hint.className = 'up-hint' + (ctx.pct >= 80 ? ' warn' : '');
      hint.textContent = ctx.pct >= 80
        ? 'Контекст почти полон: начните новый чат («Очистить чат»), иначе модель начнёт терять историю.'
        : 'Контекст заполняется: для длинной работы лучше начать новый чат.';
      box.appendChild(hint);
    }
  }
  if (window.UsageMeter && el.usageBadge) {
    updateUsageBadge(UsageMeter.getSummary());
    UsageMeter.onChange(function (s) { updateUsageBadge(s); });
    if (el.usageMenu && el.usagePopover) {
      el.usageBadge.onclick = function (e) {
        e.stopPropagation();
        var opening = !el.usageMenu.classList.contains('open');
        el.usageMenu.classList.toggle('open');
        if (opening) renderUsagePopover();
      };
      /* Закрытие по клику вне — install-once guard, как у more-menu */
      if (!window.__omcUsageMenuClickInstalled) {
        window.__omcUsageMenuClickInstalled = true;
        document.addEventListener('click', function (e) {
          if (el.usageMenu && !el.usageMenu.contains(e.target)) {
            el.usageMenu.classList.remove('open');
          }
        });
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
          'Предложить план вырезания интервалов пользователю на подтверждение (НЕ выполняет правку). Покажет карточку «Применить / Отмена». Обязателен хотя бы один из removeRefs / removeIntervals / keepIntervals. Передавай keepSummary и removeSummary с цитатами. ПРЕДПОЧИТАЙ removeRefs после get_transcript_structure — индексы абзацев надёжнее ручного копирования секунд. removeIntervals с ручными секундами — только когда режешь НЕ по границам структуры. ДЛЯ СБОРОЧНОГО МОНТАЖА («собери ролик про X», «сделай выжимку»): используй keepIntervals — список того, что ОСТАВИТЬ. Плагин сам вычислит removeIntervals как дополнение. keepIntervals и removeIntervals/removeRefs взаимоисключают друг друга.',
        parameters: {
          type: 'object',
          properties: {
            removeRefs: {
              type: 'array',
              description: 'ПРЕДПОЧТИТЕЛЬНЫЙ способ: ссылки на абзацы из get_transcript_structure. Плагин сам развернёт индексы в точные секунды из кэша. Надёжнее ручного копирования секунд. Можно комбинировать с removeIntervals (результаты сольются). Нельзя с keepIntervals.',
              items: {
                type: 'object',
                properties: {
                  paragraph: { type: 'integer', description: 'Индекс абзаца (поле i из get_transcript_structure).' },
                  reason: { type: 'string' }
                },
                required: ['paragraph']
              }
            },
            removeIntervals: {
              type: 'array',
              description: 'Интервалы для удаления (ручные секунды). Используй когда режешь НЕ по границам абзацев, или для результатов analyze_transcript_for_cuts.',
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
              description: 'Интервалы, которые ОСТАВИТЬ (сборочный монтаж). Плагин вычислит removeIntervals автоматически как дополнение к этим интервалам. Границы выровняются по сегментам транскрипта. Не передавай вместе с removeIntervals/removeRefs.',
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
        name: 'propose_montage_plan',
        description:
          'План монтажа по смыслам: сократить материал до целевого хронометража. ' +
          'Плагин САМ размечает смыслы транскрипта второй моделью (по чанкам), ' +
          'детерминированно собирает план keep/cut под цель ±10% и показывает карточку на подтверждение. ' +
          'НЕ передавай blocks — плагин строит их сам. Требуется транскрипт (сначала транскрибируй In–Out). ' +
          'Используй для «сожми до N минут», «сократи сохранив суть», «собери по смыслу». ' +
          'Вход должен быть сведён (nest/single-cam): несведённый мультикам плагин отклонит с рекомендацией.',
        parameters: {
          type: 'object',
          properties: {
            sequenceKey: { type: 'string', description: 'Имя секвенции (sequenceName из снимка)' },
            targetDurationSec: { type: 'number', description: 'Целевой хронометраж в секундах, > 0' },
            summary: { type: 'string', description: '1-2 предложения: что получится' },
            allowUnconsolidated: { type: 'boolean', description: 'Обойти гейт сведённого входа (мультикам). По умолчанию false — плагин блокирует несведённый вход. Ставь true только если пользователь явно согласился на лид-гэп/десинхрон.' }
          },
          required: ['sequenceKey', 'targetDurationSec', 'summary']
        }
      }
    },
    {
      type: 'function',
      'function': {
        name: 'apply_transcript_cuts',
        description:
          'Вырезать интервалы времени на таймлайне. Все дорожки. ВНИМАНИЕ: используй только если пользователь явно попросил «без подтверждения», иначе используй propose_transcript_cuts. ПРЕДПОЧИТАЙ removeRefs (индексы абзацев) — надёжнее ручного копирования секунд. Хотя бы один из removeRefs/removeIntervals обязателен.',
        parameters: {
          type: 'object',
          properties: {
            removeRefs: {
              type: 'array',
              description: 'ПРЕДПОЧТИТЕЛЬНЫЙ способ: ссылки на абзацы из get_transcript_structure. Можно комбинировать с removeIntervals.',
              items: {
                type: 'object',
                properties: {
                  paragraph: { type: 'integer', description: 'Индекс абзаца (поле i из get_transcript_structure).' },
                  reason: { type: 'string' }
                },
                required: ['paragraph']
              }
            },
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
          }
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
  /* Волна 3 п.1 (11 июля 2026): vision — «глаза» агента. Кадры извлекаются
     ffmpeg-ом из исходников клипов (host getFrameSources + DP.planFrameSources),
     описывает vision-модель Cloud.ru (visionModel, дефолт MiniMax-M3).
     BRAW ffmpeg не декодирует — для таких проектов агент передаёт sourceFile
     (черновой экспорт/прокси секвенции). */
  var TOOLS_VISION = [
    {
      type: 'function',
      'function': {
        name: 'describe_frames',
        description:
          'Посмотреть кадры таймлайна «глазами»: извлекает JPEG-кадры по секундам таймлайна (ffmpeg из исходников клипов) и описывает их vision-моделью. Используй когда нужно понять ЧТО В КАДРЕ: план (крупный/общий), кто/что в кадре, композиция, текст на экране. До 8 кадров за вызов. Если исходники BRAW (ffmpeg не декодирует) — инструмент вернёт ошибку с подсказкой; тогда попроси у пользователя путь к черновому экспорту/прокси и передай его в sourceFile.',
        parameters: {
          type: 'object',
          properties: {
            timelineSeconds: {
              type: 'array',
              items: { type: 'number' },
              description: 'Секунды таймлайна активной секвенции (до 8 за вызов).'
            },
            question: {
              type: 'string',
              description: 'Что именно узнать о кадрах (по умолчанию — общее описание каждого кадра).'
            },
            sourceFile: {
              type: 'string',
              description: 'Необязательный абсолютный путь к видеофайлу-источнику кадров (черновой экспорт секвенции / прокси). Если задан — кадры берутся из него по этим же таймлайн-секундам, минуя исходники клипов. Нужен для BRAW-проектов.'
            }
          },
          required: ['timelineSeconds']
        }
      }
    }
  ];

  var TOOLS_UNIFIED = (function () {
    var all = [].concat(TOOLS_TEXTMONTAGE, TOOLS_MARKERS, TOOLS_TIMECODE, UNIFIED_EDIT_PLAN_TOOLS, TOOLS_VISION);
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
      /* Кэш мгновенный — статус не показываем (нечего «крутить»). */
      return Promise.resolve(lastSnap);
    }
    /* Жизненный цикл статуса ЗДЕСЬ же: раньше show() был без парного hide() —
       вызовы не из чата (Tools-tab, MultiCam-маппинг) оставляли «Получение
       снимка таймлайна…» крутиться вечно (их finally прятал ДРУГОЙ статус-бар).
       evalJson гарантирует callback (таймаут 30с) → спиннер всегда снимется. */
    if (typeof statusUi !== 'undefined') statusUi.show('Получение снимка таймлайна…', true);
    return new Promise(function (resolve, reject) {
      PremiereBridge.getTimelineSnapshot(function (err, data) {
        if (typeof statusUi !== 'undefined') statusUi.hide();
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
    out2._hint = 'Для вырезки используй removeRefs:[{paragraph: i}] в propose_transcript_cuts — ' +
      'плагин сам развернёт индексы в секунды. Надёжнее ручного копирования таймкодов.';
    if (out2.editedAfterTranscribe) {
      out2._notice = 'Структура пересчитана под текущее состояние таймлайна.';
    }
    return Promise.resolve(out2);
  }

  /* ─── Хелпер: ожидаемая дельта длительности — делегирует в EditPlanSimulator ── */
  function _calcExpectedDelta(operations) {
    return EditPlanSimulator.calcExpectedDeltaSec(operations);
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
      /* Фиксируем состояние ДО мутации для дифф-отчёта */
      var beforeSnap = (lastSnap && lastSnap.ok) ? lastSnap : null;
      var expectedDeltaSec = _calcExpectedDelta(args.operations);
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
          /* Компактный дифф вместо тяжёлого полного снимка */
          data._timelineDiff = EditPlanSimulator.buildTimelineDiff(beforeSnap, snapData, expectedDeltaSec);
          data._autoSnapshot = EditPlanSimulator.compactSnapshotForLlm(snapData);
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
          /* P1-E: подсказка при частичном провале операций */
          if (data && typeof data.opsFailed === 'number' && data.opsFailed > 0) {
            data._partialFailureHint = 'Часть операций не применилась — см. results[]. ' +
              'Пересылай ТОЛЬКО упавшие (исправив причину), НЕ повторяй весь план: ' +
              'успешные уже применены, координаты сдвинулись → вызови get_timeline_snapshot и пересчитай.';
          }
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

    /* ── Task 4 (5 июля 2026): секция плана монтажа ──────────────── */
    var _hasPlan = Array.isArray(_pendingProposal.planBlocks) && _pendingProposal.planBlocks.length > 0;
    if (_hasPlan) {
      var pb = _pendingProposal.planBlocks;
      var ps = _pendingProposal.planStats || {};
      var ks = _pendingProposal.keepSummary || [];
      var rs = _pendingProposal.removeSummary || [];

      /* Заголовок */
      var planHdr = document.createElement('div');
      planHdr.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:6px;';
      planHdr.textContent = '\uD83D\uDCCB План монтажа (' + pb.length + ' блоков)';
      card.appendChild(planHdr);

      /* Строка итога с target-badge логикой */
      var planTotalSec = (ps.keepSec || 0) + (ps.cutSec || 0);
      var planKeepSec = ps.keepSec || 0;
      var planTargetSec = ps.targetSec || 0;
      var planSummaryEl = document.createElement('div');
      planSummaryEl.style.cssText = 'font-size:12px;margin-bottom:8px;';
      /* Пороги плана: ±10% ok / ±20% warn — совпадают с допуском валидатора
         MontagePlan (TOLERANCE=0.10), осознанно отличаются от верхнего
         target-badge (тот односторонний: ≤+5% ok / ≤+20% warn). Валидный
         план всегда в пределах ±10%, так что здесь почти всегда ok. */
      var planVariant = '';
      if (planTargetSec > 0 && planKeepSec > 0) {
        var planRatio = planKeepSec / planTargetSec;
        if (planRatio <= 1.10 && planRatio >= 0.90) {
          planVariant = 'ok';
        } else if (planRatio <= 1.20 && planRatio >= 0.80) {
          planVariant = 'warn';
        } else {
          planVariant = 'bad';
        }
        planSummaryEl.className = 'proposal-target-badge proposal-target-badge--' + planVariant;
      }
      var planStatusSym = planVariant === 'ok' ? ' \u2713' : ' \u2717';
      var planKeepLabel = document.createTextNode(
        'Хронометраж: ' + fmtSec(planTotalSec) + ' \u2192 ' + fmtSec(planKeepSec) +
        ' (цель ' + fmtSec(planTargetSec) + (planVariant ? planStatusSym : '') + ')'
      );
      planSummaryEl.appendChild(planKeepLabel);
      card.appendChild(planSummaryEl);

      /* Подготовка сопоставления planBlocks → keepSummary/removeSummary.
         buildSummaries сортирует каждый массив по startSec. Чтобы надёжно
         сопоставить, извлекаем keep/cut блоки, сортируем по paragraphs.from
         (= порядок startSec), и берём из ks/rs по порядку. */
      var keepBlocks = [];
      var cutBlocks = [];
      for (var pbi = 0; pbi < pb.length; pbi++) {
        var entry = { idx: pbi, block: pb[pbi] };
        if (pb[pbi].action === 'keep') {
          keepBlocks.push(entry);
        } else {
          cutBlocks.push(entry);
        }
      }
      keepBlocks.sort(function (a, b) { return a.block.paragraphs.from - b.block.paragraphs.from; });
      cutBlocks.sort(function (a, b) { return a.block.paragraphs.from - b.block.paragraphs.from; });

      /* Записать summaryRef в каждый entry */
      for (var ki2 = 0; ki2 < keepBlocks.length; ki2++) {
        keepBlocks[ki2].sum = ks[ki2] || null;
      }
      for (var ci2 = 0; ci2 < cutBlocks.length; ci2++) {
        cutBlocks[ci2].sum = rs[ci2] || null;
      }

      /* Собрать обратно в порядке planBlocks */
      var blockMap = {};
      for (var km = 0; km < keepBlocks.length; km++) {
        blockMap[keepBlocks[km].idx] = keepBlocks[km];
      }
      for (var cm = 0; cm < cutBlocks.length; cm++) {
        blockMap[cutBlocks[cm].idx] = cutBlocks[cm];
      }

      /* Список блоков */
      var planList = document.createElement('div');
      planList.className = 'plan-blocks-list';
      for (var bli = 0; bli < pb.length; bli++) {
        var blk = pb[bli];
        var mapped = blockMap[bli];
        var sum = mapped ? mapped.sum : null;
        var blRow = document.createElement('div');
        blRow.className = 'plan-block-row plan-block-row--' + blk.action;
        var blHead = document.createElement('span');

        if (blk.action === 'keep') {
          blHead.appendChild(document.createTextNode('\u2713 ['));
          if (sum) {
            blHead.appendChild(_tcJumpEl(sum.startSec));
            blHead.appendChild(document.createTextNode(' \u2013 '));
            blHead.appendChild(_tcJumpEl(sum.endSec));
            blHead.appendChild(document.createTextNode('] '));
            var durSec = sum.endSec - sum.startSec;
            var themeStr = blk.theme ? String(blk.theme).slice(0, 120) : '';
            var durStr = ' \u00B7 ' + fmtSec(durSec);
            var themeSp = document.createElement('span');
            themeSp.textContent = themeStr + durStr;
            blHead.appendChild(themeSp);
          } else {
            blHead.appendChild(document.createTextNode('] ' + (blk.theme || '')));
          }
        } else {
          blHead.appendChild(document.createTextNode('\u2717 ['));
          if (sum) {
            blHead.appendChild(_tcJumpEl(sum.startSec));
            blHead.appendChild(document.createTextNode(' \u2013 '));
            blHead.appendChild(_tcJumpEl(sum.endSec));
            blHead.appendChild(document.createTextNode('] '));
            var cutDur = sum.endSec - sum.startSec;
            var reasonStr = blk.reason ? String(blk.reason).slice(0, 120) : '';
            var cutInfo = '\u00B7 ' + fmtSec(cutDur);
            if (reasonStr) cutInfo += ' \u00B7 ' + reasonStr;
            var cutSp = document.createElement('span');
            cutSp.textContent = cutInfo;
            blHead.appendChild(cutSp);
          } else {
            blHead.appendChild(document.createTextNode('] ' + (blk.reason || '')));
          }
        }

        blRow.appendChild(blHead);
        planList.appendChild(blRow);
      }
      card.appendChild(planList);
    }

    /* Контейнер для keep/remove списков: при наличии плана — свёрнут в <details> */
    var ivContainer = _hasPlan ? document.createElement('details') : null;
    if (ivContainer) {
      ivContainer.className = 'proposal-details';
      var ivSummary = document.createElement('summary');
      ivSummary.textContent = 'Детализация интервалов';
      ivContainer.appendChild(ivSummary);
    }
    var ivTarget = ivContainer || card;

    if (Array.isArray(v.keepIntervals) && v.keepIntervals.length) {
      var keepHdr = document.createElement('div');
      keepHdr.textContent = '✓ Остаётся в ролике (' + v.keepIntervals.length + ')';
      keepHdr.style.cssText = 'font-size:11px;font-weight:600;color:#10b981;margin-bottom:4px;';
      ivTarget.appendChild(keepHdr);
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
      ivTarget.appendChild(keepList);
    }

    var removeList = _pendingProposal.removeIntervals || [];
    if (removeList.length) {
      var rmHdr = document.createElement('div');
      rmHdr.textContent = '✗ Убирается (' + removeList.length + ')';
      rmHdr.style.cssText = 'font-size:11px;font-weight:600;color:#f43f5e;margin-bottom:4px;';
      ivTarget.appendChild(rmHdr);
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
      ivTarget.appendChild(rmBox);
    }

    if (ivContainer) {
      card.appendChild(ivContainer);
    }

    card.appendChild(_buildButtons('Применить монтаж'));
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
      /* 10.07.2026 (Волна 1.5): фиксируем proposal НА МОМЕНТ КЛИКА. Пока
         assertSequenceMatch летает к host (~100мс), _pendingProposal мог быть
         заменён новым ответом/отменён — без проверки идентичности применился бы
         план, который пользователь не видел и не подтверждал. */
      var propAtClick = _pendingProposal;
      var pSnap = propAtClick && propAtClick.snapshot;
      assertSequenceMatch(pSnap, function (err, ok) {
        if (_pendingProposal !== propAtClick) {
          /* карточка устарела — кнопки НЕ оживляем */
          showErr('План изменился, пока шла проверка секвенции — эта карточка устарела. Проверьте актуальную карточку плана.');
          return;
        }
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
        { operations: normOpsE, summary: prop.summary || '',
          expectedSequenceName: (prop.snapshot && prop.snapshot.sequenceName) || '' },
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
        { operations: prop.operations, summary: prop.summary,
          expectedSequenceName: (prop.snapshot && prop.snapshot.sequenceName) || '' },
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
      /* Волна 1.5: host сверит секвенцию сам — закрывает окно между
         assertSequenceMatch и фактическим apply. */
      { removeIntervals: prop.removeIntervals, summary: prop.summary,
        expectedSequenceName: (prop.snapshot && prop.snapshot.sequenceName) || '' },
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
        /* Волна 2 п.3 (10.07.2026): setLastUndo теперь СТЕК (мультиоткат) —
           предыдущие чекпоинты остаются достижимыми, их снимки транскрипта
           НЕ удаляем. Чистим только по вытесненным из стека (cap 8). */
        var _evicted = ContextStore.setLastUndo(active.panelId, 1, label || 'монтаж', data.originalName || '', {
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
            if (_ent) _transcriptCheckpoints[data.backupId] = { key: _ck, entry: JSON.parse(JSON.stringify(_ent)), _ts: Date.now() };
          }
          if (_evicted && _evicted.length) {
            for (var _ei = 0; _ei < _evicted.length; _ei++) {
              if (_evicted[_ei] && _evicted[_ei].backupId) delete _transcriptCheckpoints[_evicted[_ei].backupId];
            }
          }
          /* Страховочный лимит (мульти-панель, clearAllPanelCache-сироты):
             держим не больше 8 снимков, вытесняем самый старый. */
          var _ckIds = Object.keys(_transcriptCheckpoints);
          while (_ckIds.length > 8) {
            var _oldestId = null, _oldestTs = Infinity;
            for (var _ci = 0; _ci < _ckIds.length; _ci++) {
              var _cts = _transcriptCheckpoints[_ckIds[_ci]]._ts || 0;
              if (_cts < _oldestTs) { _oldestTs = _cts; _oldestId = _ckIds[_ci]; }
            }
            if (!_oldestId) break;
            delete _transcriptCheckpoints[_oldestId];
            _ckIds = Object.keys(_transcriptCheckpoints);
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

  /* ─── P0-C: резолвер removeRefs → removeIntervals через кэш структуры ─── */

  /**
   * Разворачивает removeRefs (ссылки на абзацы) в removeIntervals и сливает
   * с уже переданными removeIntervals. Возвращает:
   *   { removeIntervals: [...], refErrors: [...], staleness: null|string }
   * Если refErrors непуст, но есть валидные интервалы — интервалы возвращаются,
   * а refErrors передаются в результат инструмента (_refErrors).
   */
  function _resolveRemoveRefs(args, sequenceKey) {
    var hasRefs = Array.isArray(args.removeRefs) && args.removeRefs.length > 0;
    var hasManual = Array.isArray(args.removeIntervals) && args.removeIntervals.length > 0;
    if (!hasRefs) return { removeIntervals: args.removeIntervals || [], refErrors: [], staleness: null };

    /* Ищем entry в кэше */
    var key = _cleanSeqKey(sequenceKey || args.sequenceKey || '');
    var found = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key);
    if (!found || !found.entry) {
      return {
        removeIntervals: hasManual ? args.removeIntervals : [],
        refErrors: ['Нет кэша транскрипта для «' + key + '» — removeRefs невозможно развернуть.'],
        staleness: null
      };
    }
    var entry = found.entry;

    /* P0-C stale-гейт: если entry.possiblyStale — координаты сегментов
       могут не соответствовать тому, что видела модель. Это жёсткий блок,
       потому что структура пересчитывается в get_transcript_structure,
       а possiblyStale снимается только при пересборке. Если possiblyStale
       стоит — значит модель не вызвала get_transcript_structure после правки.
       Ранний return: НЕ мутируем стор и НЕ резолвим refs при stale. */
    if (entry.possiblyStale) {
      return {
        removeIntervals: hasManual ? args.removeIntervals : [],
        refErrors: [],
        staleness: 'Структура транскрипта устарела (таймлайн менялся после последнего get_transcript_structure). ' +
          'Вызови get_transcript_structure заново и пересоставь removeRefs по свежим индексам.'
      };
    }

    /* Пересборка paragraphs если stale (аналогично execGetTranscriptStructure) */
    if (typeof TranscriptStructure !== 'undefined') {
      var needsRebuild = !entry.paragraphs || !entry.paragraphs.length ||
        (TranscriptStructure.isParagraphsStale && TranscriptStructure.isParagraphsStale(entry));
      if (needsRebuild) {
        try {
          TranscriptStructure.buildStructure(entry);
          ContextStore.setTranscriptEntry(TRANSCRIPT_PID, found.matchedKey, entry);
        } catch (eRB) {
          var rebuildMsg = 'не удалось пересобрать структуру: ' +
            (eRB && eRB.message ? eRB.message : String(eRB)) +
            ' — вызови get_transcript_structure';
          return {
            removeIntervals: hasManual ? args.removeIntervals : [],
            refErrors: [rebuildMsg],
            staleness: null
          };
        }
      }
    }

    var resolved = TranscriptStructure.resolveRefsToIntervals(entry.paragraphs || [], args.removeRefs);

    /* Сливаем с ручными removeIntervals */
    var merged = (hasManual ? args.removeIntervals : []).concat(resolved.intervals);
    return {
      removeIntervals: merged,
      refErrors: resolved.errors,
      staleness: null
    };
  }

  function execProposeTranscriptCuts(args) {
    args = args || {};
    var hasRefs = Array.isArray(args.removeRefs) && args.removeRefs.length > 0;
    var hasRemove = Array.isArray(args.removeIntervals) && args.removeIntervals.length > 0;
    var hasKeep = Array.isArray(args.keepIntervals) && args.keepIntervals.length > 0;

    /* US-004: mutual exclusion — keepIntervals несовместимы с removeRefs/removeIntervals */
    if ((hasRemove || hasRefs) && hasKeep) {
      return Promise.resolve({
        validationError: 'Передавай ЛИБО removeIntervals/removeRefs (для «убери X»), ЛИБО keepIntervals ' +
          '(для «собери ролик про X»). Одновременно нельзя — это неоднозначно.'
      });
    }
    if (!hasRemove && !hasKeep && !hasRefs) {
      return Promise.resolve({
        validationError: 'Нужен хотя бы один из: removeRefs, removeIntervals или keepIntervals.'
      });
    }

    /* P0-C: разворачиваем removeRefs в интервалы ДО всей остальной логики */
    var refResult = null;
    if (hasRefs) {
      refResult = _resolveRemoveRefs(args, args.sequenceKey);
      /* Жёсткий блок при устаревшей структуре */
      if (refResult.staleness) {
        return Promise.resolve({ validationError: refResult.staleness });
      }
      /* Если все ссылки невалидны и ручных интервалов нет — ошибка */
      if (!refResult.removeIntervals.length && refResult.refErrors.length) {
        return Promise.resolve({
          validationError: 'Все removeRefs невалидны: ' + refResult.refErrors.join('; ')
        });
      }
      /* Подменяем removeIntervals на развёрнутые */
      args = Object.assign({}, args, { removeIntervals: refResult.removeIntervals });
      hasRemove = refResult.removeIntervals.length > 0;
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

    /* P1-F: прокидываем analyzedRegion из кэша транскрипта для warn «интервал
       вне проанализированной области». Entry.analyzedRegion = {inSec, outSec}
       (In/Out секвенции на момент транскрибации). */
    var _arSeqKey = _cleanSeqKey(workingArgs.sequenceKey || args.sequenceKey || '');
    if (_arSeqKey && !workingArgs._analyzedRegion) {
      var _arFound = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, _arSeqKey);
      if (_arFound && _arFound.entry && _arFound.entry.analyzedRegion) {
        var _arR = _arFound.entry.analyzedRegion;
        if (typeof _arR.inSec === 'number' && typeof _arR.outSec === 'number') {
          workingArgs = Object.assign({}, workingArgs, {
            _analyzedRegion: { fromSec: _arR.inSec, toSec: _arR.outSec }
          });
        }
      }
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
    /* Проброс контекста плана монтажа (propose_montage_plan → карточка) */
    if (_pendingPlanContext) {
      _pendingProposal.planBlocks = _pendingPlanContext.blocks;
      _pendingProposal.planStats = _pendingPlanContext.stats;
      _pendingProposal.planWarnings = _pendingPlanContext.warnings;
      /* Конкатенация planWarnings в общий warnings для рендера карточки */
      if (_pendingPlanContext.warnings && _pendingPlanContext.warnings.length) {
        var existing = _pendingProposal.warnings || [];
        _pendingProposal.warnings = existing.concat(_pendingPlanContext.warnings);
      }
    }
    renderPendingProposalCard();
    var result = {
      ok: true,
      status: 'waiting_user_confirmation',
      message:
        (hasKeep ? 'keepIntervals инвертированы в ' + snappedIntervals.length + ' removeIntervals. ' : '') +
        (hasRefs ? 'removeRefs развёрнуты в ' + (refResult ? refResult.removeIntervals.length : 0) + ' интервалов. ' : '') +
        'План предложен пользователю. Жди, пока он нажмёт «Применить» или «Отмена». ' +
        'НЕ вызывай apply_transcript_cuts сам — это сделает UI по кнопке.',
      _verification: verification
    };
    /* P0-C: если часть removeRefs невалидна — сообщаем модели */
    if (refResult && refResult.refErrors && refResult.refErrors.length) {
      result._refErrors = refResult.refErrors;
    }
    return Promise.resolve(result);
  }

  /**
   * План монтажа по смыслам (спека 2026-07-05): валидация детерминированным
   * MontagePlan.validatePlan → removeRefs → делегирование в execProposeTranscriptCuts
   * (padding/snap/merge/карточка/apply переиспользуются целиком).
   */
  /**
   * Гейт геометрии входа (Layer-1). Монтаж по смыслам требует СВЕДЁННОГО входа:
   * несведённый мультикам (несколько видеодорожек, разные старты, перекрывающиеся
   * аудиодорожки, разная длина камер) — доказанный корень лид-гэпа и десинхрона
   * (эксперимент 06.07.2026). По умолчанию блокируем с рекомендацией свернуть в nest;
   * можно продолжить принудительно через allowUnconsolidated:true.
   */
  function execProposeMontagePlan(args) {
    args = args || {};
    var sequenceKey = String(args.sequenceKey || '').trim();
    if (!sequenceKey) return Promise.resolve({ error: 'propose_montage_plan: нужен sequenceKey (sequenceName из снимка)' });

    function _afterGate() { return _proposeMontagePlanInner(args); }
    return execGetSnapshot(true).then(function (snap) {
      var geo = (typeof EditPlanSimulator !== 'undefined' && EditPlanSimulator.analyzeInputGeometry)
        ? EditPlanSimulator.analyzeInputGeometry(snap) : null;
      if (geo && geo.consolidated === false && args.allowUnconsolidated !== true) {
        var msg = [];
        for (var gi = 0; gi < geo.reasons.length; gi++) msg.push(geo.reasons[gi].message);
        return {
          error: 'Вход НЕ сведён для монтажа по смыслам: ' + msg.join('; ') +
            '. Сверни мультикам в nest-секвенцию (выдели все клипы → Nest) или работай в single-cam ' +
            'секвенции без перекрытий — иначе будет лид-гэп и десинхрон. Чтобы всё равно продолжить, ' +
            'повтори вызов с allowUnconsolidated:true.',
          _inputGeometry: geo
        };
      }
      return _afterGate();
    }, function () {
      /* снимок не получить — не блокируем монтаж, идём как раньше */
      return _afterGate();
    });
  }

  function _proposeMontagePlanInner(args) {
    args = args || {};
    var sequenceKey = String(args.sequenceKey || '').trim();
    if (!sequenceKey) return Promise.resolve({ error: 'propose_montage_plan: нужен sequenceKey (sequenceName из снимка)' });

    /* Поиск entry в кэше транскрипта — паттерн из _resolveRemoveRefs */
    var key = _cleanSeqKey(sequenceKey);
    var found = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, key);
    if (!found || !found.entry) {
      return Promise.resolve({ error: 'Транскрипт для «' + key + '» не найден. Вызови get_transcript_structure.' });
    }
    var entry = found.entry;

    /* Staleness-гейт как в _resolveRemoveRefs */
    if (entry.possiblyStale) {
      return Promise.resolve({
        error: 'Транскрипт устарел (таймлайн менялся). Перестрой транскрипт (get_transcript_structure) перед планированием.'
      });
    }

    /* Пересборка paragraphs если нужно (паттерн из _resolveRemoveRefs) */
    if (typeof TranscriptStructure !== 'undefined') {
      var needsRebuild = !entry.paragraphs || !entry.paragraphs.length ||
        (TranscriptStructure.isParagraphsStale && TranscriptStructure.isParagraphsStale(entry));
      if (needsRebuild) {
        try {
          TranscriptStructure.buildStructure(entry);
          ContextStore.setTranscriptEntry(TRANSCRIPT_PID, found.matchedKey, entry);
        } catch (eRB) {
          return Promise.resolve({
            error: 'Не удалось пересобрать структуру: ' +
              (eRB && eRB.message ? eRB.message : String(eRB)) +
              ' — вызови get_transcript_structure'
          });
        }
      }
    }

    /* v2: план строит плагин через чанкированный воркер, НЕ модель.
       Гейт #1: функция ВСЕГДА завершается карточкой ЛИБО {error}. */
    var settings = ContextStore.getResolvedSettings ? ContextStore.getResolvedSettings() : {};
    var CC = typeof CloudRuClient !== 'undefined' ? CloudRuClient : null;
    var paras = entry.paragraphs || [];
    if (!paras.length) return Promise.resolve({ error: 'В транскрипте нет абзацев — транскрибируй материал заново.' });

    var wOpt = {
      settings: settings, CloudRuClient: CC,
      signal: runAbort ? runAbort.signal : null,
      abortCheck: runAbort ? function () { return runAbort.aborted; } : null,
      onProgress: function (ev) { if (ev && ev.message) statusUi.show(ev.message, true);
        if (ev && ev.totalChunks && typeof ev.chunkIndex === 'number') statusUi.progress((ev.chunkIndex / ev.totalChunks) * 100); }
    };

    statusUi.show('Разметка смыслов транскрипта…', true);
    return TranscriptStructure.labelMontageBlocks(paras, wOpt)
      .then(function (w) {
        if (!w || !w.labeled || !w.labeled.length) throw new Error('Воркер не вернул разметку');
        return TranscriptStructure.calibrateMontageBlocks(w.labeled, entry, wOpt);
      })
      .then(function (labeled) {
        var built = MontagePlan.buildPlanFromLabels(labeled, entry, args.targetDurationSec);
        if (!built.blocks.length) throw new Error('Не удалось собрать план из разметки');
        var v = MontagePlan.validatePlan(
          { targetDurationSec: args.targetDurationSec, blocks: built.blocks, summary: args.summary }, entry);
        if (!v.ok) {
          /* авто-план не прошёл — редкость; отдаём агенту явную ошибку */
          return { error: 'Авто-план не прошёл проверку: ' + v.errors.join('; '), _planStats: v.stats };
        }
        var refs = MontagePlan.buildRemoveRefs(built.blocks);
        var summaries = MontagePlan.buildSummaries(built.blocks, entry);
        _pendingPlanContext = { blocks: built.blocks, stats: v.stats, warnings: v.warnings };
        var res;
        try {
          res = execProposeTranscriptCuts({
            sequenceKey: sequenceKey, removeRefs: refs, targetDurationSec: args.targetDurationSec,
            keepSummary: summaries.keepSummary, removeSummary: summaries.removeSummary, summary: args.summary
          });
        } finally { _pendingPlanContext = null; }
        return Promise.resolve(res).then(function (r) {
          statusUi.hide();
          if (r && r.ok) { r._planStats = v.stats; if (v.warnings.length) r._planWarnings = v.warnings; }
          return r;
        });
      })
      .catch(function (err) {
        statusUi.hide();
        return { error: 'Монтаж по смыслам не удался: ' + (err && err.message ? err.message : String(err)) +
          '. Проверь, что транскрипт готов, и попробуй снова.' };
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
      /* Фиксируем состояние ДО мутации для дифф-отчёта */
      var beforeSnap = (lastSnap && lastSnap.ok) ? lastSnap : null;
      var expectedDeltaSec = _calcExpectedDelta(norm.operations);
      PremiereBridge.applyTimecodeEdits(
        { operations: norm.operations, summary: args.summary || '' },
        function (err, data) {
          if (err) {
            reject(err);
            return;
          }
          PremiereBridge.getTimelineSnapshot(function (snapErr, snapData) {
            if (!snapErr && snapData && snapData.ok) lastSnap = snapData;
            /* Компактный дифф вместо тяжёлого полного снимка */
            data._timelineDiff = EditPlanSimulator.buildTimelineDiff(beforeSnap, snapData, expectedDeltaSec);
            data._autoSnapshot = EditPlanSimulator.compactSnapshotForLlm(snapData);
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
    args = args || {};
    /* P0-C: разворачиваем removeRefs ДО любой другой логики */
    var hasRefsApply = Array.isArray(args.removeRefs) && args.removeRefs.length > 0;
    var applyRefResult = null;
    if (hasRefsApply) {
      applyRefResult = _resolveRemoveRefs(args, args.sequenceKey);
      if (applyRefResult.staleness) {
        return Promise.resolve({ validationError: applyRefResult.staleness });
      }
      if (!applyRefResult.removeIntervals.length && applyRefResult.refErrors.length) {
        return Promise.resolve({
          validationError: 'Все removeRefs невалидны: ' + applyRefResult.refErrors.join('; ')
        });
      }
      args = Object.assign({}, args, { removeIntervals: applyRefResult.removeIntervals });
      /* Убираем removeRefs из копии: execProposeTranscriptCuts иначе
         резолвит их повторно и удвоит интервалы (redirect-путь). */
      delete args.removeRefs;
    }
    /* Проверяем, что после резолва есть хотя бы один интервал */
    var hasRemoveApply = Array.isArray(args.removeIntervals) && args.removeIntervals.length > 0;
    if (!hasRemoveApply) {
      return Promise.resolve({
        validationError: 'Нужен хотя бы один из: removeRefs или removeIntervals.'
      });
    }
    /* Safety-guard: без явного «без подтверждения» — показываем карточку. */
    if (!_directApplyAuthorized) {
      return Promise.resolve(execProposeTranscriptCuts(args)).then(function (r) {
        return Object.assign({ _redirectedToPropose: true,
          message: 'Прямое применение без подтверждения запрещено. Показал карточку propose_transcript_cuts — пользователь нажмёт «Применить». Заверши ход.' },
          (r && typeof r === 'object') ? r : {});
      });
    }
    return new Promise(function (resolve, reject) {
      /* P1-F: прокидываем analyzedRegion (аналогично propose-пути) */
      var _arKey2 = _cleanSeqKey(args.sequenceKey || '');
      if (_arKey2 && !args._analyzedRegion) {
        var _arF2 = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, _arKey2);
        if (_arF2 && _arF2.entry && _arF2.entry.analyzedRegion) {
          var _arR2 = _arF2.entry.analyzedRegion;
          if (typeof _arR2.inSec === 'number' && typeof _arR2.outSec === 'number') {
            args = Object.assign({}, args, {
              _analyzedRegion: { fromSec: _arR2.inSec, toSec: _arR2.outSec }
            });
          }
        }
      }

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
      /* Фиксируем состояние ДО мутации для дифф-отчёта */
      var beforeSnap = (lastSnap && lastSnap.ok) ? lastSnap : null;
      /* expectedDelta = −сумма длительностей merged removeIntervals */
      var expectedDeltaSec = 0;
      (args.removeIntervals || []).forEach(function (iv) {
        if (typeof iv.startSec === 'number' && typeof iv.endSec === 'number') {
          expectedDeltaSec -= (iv.endSec - iv.startSec);
        }
      });
      expectedDeltaSec = Math.round(expectedDeltaSec * 100) / 100;
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
          /* Компактный дифф вместо тяжёлого полного снимка */
          data._timelineDiff = EditPlanSimulator.buildTimelineDiff(beforeSnap, snapData, expectedDeltaSec);
          data._autoSnapshot = EditPlanSimulator.compactSnapshotForLlm(snapData);
          try {
            var seqKey = (snapData && snapData.sequenceName) || (lastSnap && lastSnap.sequenceName) || '';
            if (seqKey) {
              ContextStore.applyRippleDeletionsToTranscript(TRANSCRIPT_PID, seqKey, args.removeIntervals || []);
              data._transcriptShifted = true;
            }
          } catch (eSh2) {}
          /* P0-C: если часть removeRefs невалидна — сообщаем модели */
          if (applyRefResult && applyRefResult.refErrors && applyRefResult.refErrors.length) {
            data._refErrors = applyRefResult.refErrors;
          }
          /* P1-E: подсказка при частичном провале интервалов */
          if (data && typeof data.ivFailed === 'number' && data.ivFailed > 0) {
            data._partialFailureHint = 'Часть интервалов не применилась — см. results[]. ' +
              'Пересылай ТОЛЬКО упавшие (исправив причину), НЕ повторяй весь план: ' +
              'успешные уже вырезаны, координаты сдвинулись → вызови get_timeline_snapshot и пересчитай.';
          }
          resolve(data);
        });
      });
      }); /* конец _makeSequenceCheckpoint */
    });
  }

  /* ─── Сборщики executors по пресету ─────────────────────────────── */

  /* ─── Vision: describe_frames (Волна 3 п.1, 11 июля 2026) ─────────────
     Таймлайн-секунды → host getFrameSources (клипы+nest) → DP.planFrameSources
     (верхний клип, source-секунда) → ffmpeg extractFrameJpeg (768px, data URL)
     → visionModel (MiniMax-M3, thinking=false) с OpenAI-style image_url.
     sourceFile — обход для BRAW: секунда таймлайна = секунда файла.
     ВАЖНО: dataUrl НЕ возвращаем агенту (base64 раздул бы контекст). */
  var VISION_MAX_FRAMES = 8;

  async function execDescribeFrames(args) {
    var times = (args && args.timelineSeconds) || [];
    if (!Array.isArray(times) || !times.length) {
      return { ok: false, error: 'timelineSeconds: нужен непустой массив секунд таймлайна.' };
    }
    if (times.length > VISION_MAX_FRAMES) {
      return { ok: false, error: 'Слишком много кадров: ' + times.length + ' (максимум ' + VISION_MAX_FRAMES + ' за вызов). Выбери ключевые моменты или разбей на несколько вызовов.' };
    }
    var settings = ContextStore.getResolvedSettings();
    if (!settings.apiKey) return { ok: false, error: 'Не задан API-ключ Cloud.ru (Настройки).' };
    var model = settings.visionModel || 'MiniMaxAI/MiniMax-M3';

    try {
      /* 1. Маппинг таймлайн-секунда → файл+секунда источника */
      var items = [];
      var skipped = [];
      if (args.sourceFile) {
        var sf = String(args.sourceFile).replace(/\\/g, '/');
        for (var i = 0; i < times.length; i++) {
          var t = Number(times[i]);
          if (!isFinite(t) || t < 0) { skipped.push({ timelineSec: times[i], reason: 'некорректное время' }); continue; }
          items.push({ timelineSec: t, mediaPath: sf, sourceSec: t, clipName: '' });
        }
      } else {
        statusUi.show('Кадры: перечисление видеоклипов…', true);
        var fsrc = await new Promise(function (resolve, reject) {
          PremiereBridge.getFrameSources(function (err, data) {
            if (err) reject(err); else resolve(data);
          });
        });
        if (!fsrc || !fsrc.ok) return { ok: false, error: (fsrc && fsrc.error) || 'getFrameSources: нет ответа хоста.' };
        var plan = DeterministicPipelines.planFrameSources(fsrc.clips, fsrc.nestClips, times);
        items = plan.items;
        skipped = plan.skipped;
      }
      if (!items.length) {
        return { ok: false, error: 'Ни для одной секунды не найден видеоклип.', skipped: skipped };
      }

      /* 2. ffmpeg: извлечение JPEG-кадров */
      var frames = [];
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        statusUi.show('Кадр ' + (k + 1) + '/' + items.length + ' (' + it.timelineSec + 'с)…', true);
        try {
          var dataUrl = await AudioPreprocess.extractFrameJpeg(it.mediaPath, it.sourceSec, {});
          frames.push({ timelineSec: it.timelineSec, clipName: it.clipName || '', dataUrl: dataUrl });
        } catch (fe) {
          skipped.push({ timelineSec: it.timelineSec, reason: String((fe && fe.message) || fe) });
        }
      }
      if (!frames.length) {
        return { ok: false, error: 'ffmpeg не извлёк ни одного кадра. Причины по кадрам — в skipped. Если исходники BRAW — нужен sourceFile (черновой экспорт/прокси).', skipped: skipped };
      }

      /* 3. Vision-модель: один вызов на все кадры */
      statusUi.show('Vision (' + model + '): описание ' + frames.length + ' кадров…', true);
      var q = String(args.question || '').trim();
      var content = [{
        type: 'text',
        text: 'Ниже ' + frames.length + ' кадров из видеомонтажа (Premiere Pro). Для КАЖДОГО кадра дай описание строкой:\n[N] таймлайн Xс: описание\n\nОписывай: план (крупный/средний/общий), кто/что в кадре, композиция, текст на экране если есть. Кратко, по-русски.' + (q ? '\n\nДополнительный вопрос пользователя (ответь после описаний): ' + q : '')
      }];
      for (var f = 0; f < frames.length; f++) {
        content.push({ type: 'text', text: '[' + (f + 1) + '] таймлайн ' + frames[f].timelineSec + 'с' + (frames[f].clipName ? ' (клип «' + frames[f].clipName + '»)' : '') + ':' });
        content.push({ type: 'image_url', image_url: { url: frames[f].dataUrl } });
      }
      var resp = await CloudRuClient.chatCompletions({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: model,
        temperature: 0.2,
        chatParams: { max_tokens: 2048 },
        enableThinking: false, /* MiniMax-M3: reasoning_optional — выключаем, описания не требуют CoT */
        messages: [{ role: 'user', content: content }]
      });
      var text = '';
      if (resp && resp.choices && resp.choices[0] && resp.choices[0].message) {
        text = String(resp.choices[0].message.content || '');
      }
      if (!text) return { ok: false, error: 'Vision-модель вернула пустой ответ.', skipped: skipped };
      var out = { ok: true, model: model, framesDescribed: frames.length, descriptions: text };
      if (skipped.length) out.skipped = skipped;
      return out;
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      statusUi.hide();
    }
  }

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
      propose_montage_plan: execProposeMontagePlan,
      apply_transcript_cuts: function (args) { return execApplyTranscriptCuts(pid, args); },
      /* маркеры */
      add_markers: function (args) { return execAddMarkers(pid, args); },
      propose_markers: execProposeMarkers,
      /* поиск + аудио */
      find_moments: execFindMoments,
      analyze_transcript_for_cuts: execAnalyzeTranscriptForCuts,
      propose_audio_ducking: execProposeAudioDucking,
      propose_loudness_normalization: execProposeLoudness,
      /* vision */
      describe_frames: execDescribeFrames
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
    '📐 Сжать ролик до нужной длины с сохранением сути — агент покажет план (что остаётся и почему режем) до применения. Пример: «сожми до 15 минут»',
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
  var _expandedCat = 'text'; /* id развёрнутой категории, null = все свёрнуты.
     Дефолт 'text' (📝 По тексту) — чтобы «Монтаж по смыслам» был виден без раскрытия
     (обнаруживаемость #3). Явный выбор пользователя из localStorage перекрывает дефолт. */
  try {
    var _storedCat = localStorage.getItem('extllmpr_v1_expanded_cat');
    if (_storedCat === null) _expandedCat = 'text';        /* никогда не выбирал → открыть «По тексту» */
    else if (_storedCat === 'null' || _storedCat === '') _expandedCat = null; /* явно свернул всё */
    else _expandedCat = _storedCat;                         /* явный выбор категории */
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
  var undoMenuEl = document.getElementById('undo-menu');
  var undoPopoverEl = document.getElementById('undo-popover');
  function refreshUndoButton() {
    if (!btnUndo) return;
    btnUndo.style.display = '';
    var stack = ContextStore.getUndoStack ? ContextStore.getUndoStack(active.panelId) : [];
    var u = stack.length ? stack[0] : null;
    /* Волна 2 п.3: >1 чекпоинта → кнопка открывает список точек отката */
    var multi = stack.length > 1 ? ' (' + stack.length + ') ▾' : '';
    if (u && u.count > 0 && u.mode === 'markers') {
      btnUndo.textContent =
        'Откатить ' + u.count + ' маркер' + (u.count === 1 ? '' : u.count >= 2 && u.count <= 4 ? 'а' : 'ов') + multi;
      btnUndo.title = 'Удалить добавленные маркеры через markers.deleteMarker' +
        (multi ? '. Клик — список из ' + stack.length + ' точек отката.' : '');
      btnUndo.disabled = false;
    } else if (u && u.count > 0 && u.mode === 'sequence_backup' && u.backupId) {
      /* B2-9: Revert на бэкап-секвенцию (checkpoint перед apply) */
      btnUndo.textContent = '⏪ Откатить: ' + (u.label || 'монтаж') + multi;
      btnUndo.title = 'Открыть бэкап-секвенцию «' + (u.backupName || '') +
        '» с состоянием ДО применения. Изменённая секвенция останется в проекте.' +
        (multi ? ' Клик — список из ' + stack.length + ' точек отката.' : '');
      btnUndo.disabled = false;
    } else {
      btnUndo.textContent = 'Откат маркеров';
      btnUndo.title = 'Нет маркеров для отката';
      btnUndo.disabled = true;
    }
    if (!stack.length && undoMenuEl) undoMenuEl.classList.remove('open');
  }

  /** Выполнить откат для конкретного чекпоинта стека (Волна 2 п.3). */
  function performUndoEntry(u) {
    if (!u || !u.count) return;
    /* B2-9: Revert — активировать бэкап-секвенцию */
    if (u.mode === 'sequence_backup' && u.backupId) {
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
        ContextStore.removeUndoEntry(active.panelId, u.ts);
        /* Аудит 04.07.2026: CEP-событие ActiveSequenceChanged ненадёжно —
           после отката вручную сбрасываем tools-состояние (waveform/proposal
           от ПРЕЖНЕЙ секвенции) тем же слушателем. */
        try { document.dispatchEvent(new CustomEvent('omc:active-sequence-changed')); } catch (eEvU) {}
        refreshUndoButton();
        setTimeout(function () { showErr(''); }, 5000);
      });
      return;
    }
    if (u.mode !== 'markers' || !u.markerSeconds || !u.markerSeconds.length) return;
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
        ContextStore.removeUndoEntry(active.panelId, u.ts);
        refreshUndoButton();
      } else {
        showErr((data && data.error) || 'Не удалось удалить маркеры.');
      }
      setTimeout(function () {
        showErr('');
      }, 3500);
    });
  }

  /** Список точек отката (новые первыми) в поповере. DOM через textContent. */
  function renderUndoPopover(stack) {
    if (!undoPopoverEl) return;
    while (undoPopoverEl.firstChild) undoPopoverEl.removeChild(undoPopoverEl.firstChild);
    var title = document.createElement('div');
    title.className = 'up-title';
    title.textContent = 'Точки отката (новые сверху):';
    undoPopoverEl.appendChild(title);
    for (var i = 0; i < stack.length; i++) {
      (function (u) {
        var b = document.createElement('button');
        b.type = 'button';
        var name = (u.mode === 'markers')
          ? (u.count + ' маркер' + (u.count === 1 ? '' : u.count >= 2 && u.count <= 4 ? 'а' : 'ов'))
          : '⏪ ' + (u.label || 'монтаж');
        b.textContent = name + (u.sequenceName ? ' — ' + u.sequenceName : '');
        var when = document.createElement('span');
        when.className = 'u-when';
        try {
          var d = new Date(u.ts);
          when.textContent = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        } catch (eW) {}
        b.appendChild(when);
        b.title = (u.mode === 'sequence_backup')
          ? 'Открыть бэкап-секвенцию «' + (u.backupName || '') + '» (состояние до этой правки)'
          : 'Удалить эти маркеры с таймлайна';
        b.onclick = function (ev) {
          ev.stopPropagation();
          if (undoMenuEl) undoMenuEl.classList.remove('open');
          performUndoEntry(u);
        };
        undoPopoverEl.appendChild(b);
      })(stack[i]);
    }
  }

  if (btnUndo) {
    btnUndo.onclick = function (e) {
      var stack = ContextStore.getUndoStack ? ContextStore.getUndoStack(active.panelId) : [];
      if (!stack.length) return;
      if (stack.length === 1 || !undoMenuEl || !undoPopoverEl) {
        performUndoEntry(stack[0]);
        return;
      }
      /* Волна 2 п.3: несколько чекпоинтов — показываем список */
      e.stopPropagation();
      var opening = !undoMenuEl.classList.contains('open');
      undoMenuEl.classList.toggle('open');
      if (opening) renderUndoPopover(stack);
    };
    if (undoMenuEl && !window.__omcUndoMenuClickInstalled) {
      window.__omcUndoMenuClickInstalled = true;
      document.addEventListener('click', function (e) {
        if (undoMenuEl && !undoMenuEl.contains(e.target)) undoMenuEl.classList.remove('open');
      });
    }
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
  /* ─── Читалка транскрипта ────────────────────────────────────────── */

  function _trModalEls() {
    return {
      overlay: document.getElementById('transcript-modal'),
      body: document.getElementById('tr-modal-body'),
      meta: document.getElementById('tr-modal-meta'),
      title: document.getElementById('tr-modal-title'),
      close: document.getElementById('tr-modal-close')
    };
  }

  function closeTranscriptViewer() {
    var m = _trModalEls();
    if (m.overlay) m.overlay.hidden = true;
  }

  function _renderTranscriptRows(entry, seq) {
    var m = _trModalEls();
    if (!m.body) return;
    /* Достроим параграфы, если их ещё нет (как в остальных путях панели). */
    if (entry && (!entry.paragraphs || !entry.paragraphs.length) &&
        typeof TranscriptStructure !== 'undefined') {
      try { TranscriptStructure.buildStructure(entry); } catch (eB) {}
    }
    var view = TranscriptView.buildTranscriptViewRows(entry);
    m.title.textContent = 'Транскрипт' + (seq ? ' — ' + seq : '');
    if (view.source === 'empty') {
      m.meta.textContent = '';
      m.body.innerHTML = '';
      var em = document.createElement('div');
      em.className = 'tr-empty';
      em.textContent = seq
        ? 'Для секвенции «' + seq + '» транскрипта нет. Выставьте In/Out и нажмите «Транскрибировать».'
        : 'Нет активной секвенции или транскрипта.';
      m.body.appendChild(em);
      return;
    }
    var metaBits = [];
    if (view.meta.paragraphCount) metaBits.push(view.meta.paragraphCount + ' абз.');
    else if (view.meta.segmentCount) metaBits.push(view.meta.segmentCount + ' сегм.');
    if (view.meta.durationSec) metaBits.push('~' + TranscriptView.formatTimecode(view.meta.durationSec));
    if (view.meta.speakers && view.meta.speakers.length) metaBits.push(view.meta.speakers.length + ' спик.');
    m.meta.textContent = metaBits.join(' · ');

    m.body.innerHTML = '';
    if (view.source === 'text') {
      var pl = document.createElement('div');
      pl.className = 'tr-plain';
      pl.textContent = view.rows[0].text;
      m.body.appendChild(pl);
      return;
    }
    for (var i = 0; i < view.rows.length; i++) {
      var r = view.rows[i];
      var row = document.createElement('div');
      row.className = 'tr-row';
      var t = document.createElement('span');
      t.className = 'tr-time';
      t.textContent = r.time;
      t.title = 'Перейти к ' + r.time + ' на таймлайне';
      (function (sec) {
        t.onclick = function () {
          try { PremiereBridge.setPlayhead(sec, function () {}); } catch (eS) {}
        };
      })(r.startSec);
      row.appendChild(t);
      if (r.speaker) {
        var sp = document.createElement('span');
        sp.className = 'tr-speaker';
        sp.textContent = r.speaker + ':';
        row.appendChild(sp);
      }
      var tx = document.createElement('span');
      tx.className = 'tr-text';
      tx.textContent = r.text;
      row.appendChild(tx);
      m.body.appendChild(row);
    }
    m.body.scrollTop = 0;
  }

  function openTranscriptViewer() {
    var m = _trModalEls();
    if (!m.overlay) return;
    if (el.moreMenu) el.moreMenu.classList.remove('open');
    m.overlay.hidden = false;
    m.title.textContent = 'Транскрипт';
    m.meta.textContent = '';
    m.body.innerHTML = '<div class="tr-empty">Загрузка…</div>';
    PremiereBridge.getTimelineSnapshot(function (err, snap) {
      var seq = !err && snap && snap.ok && snap.sequenceName ? snap.sequenceName : '';
      var entry = null;
      if (seq) {
        var found = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, seq);
        entry = found && found.entry ? found.entry : null;
      }
      _renderTranscriptRows(entry, seq);
    });
  }

  var btnViewTr = document.getElementById('btn-view-transcript');
  if (btnViewTr) btnViewTr.onclick = openTranscriptViewer;
  (function () {
    var m = _trModalEls();
    if (m.close) m.close.onclick = closeTranscriptViewer;
    if (m.overlay) {
      m.overlay.addEventListener('click', function (e) {
        if (e.target === m.overlay) closeTranscriptViewer();
      });
    }
    if (!window.__omcTrModalEscInstalled) {
      window.__omcTrModalEscInstalled = true;
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          var ov = document.getElementById('transcript-modal');
          if (ov && !ov.hidden) closeTranscriptViewer();
        }
      });
    }
  })();

  /* ── Версия плагина + самообновление из git (17.07.2026) ─────────────
     Расширение установлено как git-клон (или симлинк на него), поэтому
     `git pull` в корне расширения = обновление. Host перечитывается
     $.evalFile'ом при location.reload() панели — рестарт Premiere не нужен.
     Грациозная деградация: нет git / не клон → только показ версии. */
  (function () {
    var verRow = document.getElementById('version-row');
    var btnUpd = document.getElementById('btn-self-update');
    if (!verRow || !btnUpd || typeof SelfUpdate === 'undefined') return;

    var repoRoot = extensionRootForHost();
    var gitStatus = null;

    function renderVersion(hostVer) {
      var parts = ['v' + (hostVer || '?')];
      if (gitStatus && gitStatus.supported) {
        parts.push(gitStatus.commit + (gitStatus.dirty ? '*' : ''));
        if (gitStatus.branch && gitStatus.branch !== 'main') parts.push(gitStatus.branch);
      }
      verRow.textContent = parts.join(' · ');
    }

    var hostVersion = null;
    try {
      cs.evalScript('$._EXT_PRM_ && $._EXT_PRM_.version || "?"', function (v) {
        hostVersion = v;
        renderVersion(hostVersion);
      });
    } catch (eV) {}

    SelfUpdate.getStatus(repoRoot).then(function (st) {
      gitStatus = st;
      renderVersion(hostVersion);
      if (!st.supported) return; /* не git-клон / нет git — кнопку не показываем */
      return SelfUpdate.checkForUpdate(repoRoot).then(function (chk) {
        if (chk.available) {
          btnUpd.hidden = false;
          btnUpd.classList.add('update-available');
          btnUpd.textContent = 'Обновить с GitHub (+' + chk.behind + ')';
        } else if (chk.diverged) {
          btnUpd.hidden = false;
          btnUpd.disabled = true;
          btnUpd.textContent = 'Локальные коммиты расходятся с origin';
        }
      });
    }).catch(function () { /* тихо: версия останется без git-части */ });

    btnUpd.onclick = function () {
      if (btnUpd.disabled) return;
      btnUpd.disabled = true;
      btnUpd.textContent = 'Обновляю…';
      SelfUpdate.applyUpdate(repoRoot).then(function (r) {
        btnUpd.textContent = 'Обновлено → ' + r.commit + ', перезагрузка…';
        setTimeout(function () { location.reload(); }, 800);
      }).catch(function (e) {
        btnUpd.disabled = false;
        btnUpd.textContent = 'Обновить с GitHub';
        showErr('Обновление не удалось: ' + ((e && e.message) || e));
      });
    };
  })();

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
      if (window.UsageMeter) { try { UsageMeter.reset(); } catch (e) {} }
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
    /* Live-находка 05.07.2026: fast-path парсит ОДИН интервал; на «два интервала:
       300–302 сек и 400–401.5 сек» молча резал первый и отвечал «Готово».
       Несколько интервалов → отдаём LLM-агенту (apply_timecode_edits с полным планом). */
    var multi = t.match(/(?:(?:с|от|между)\s+\d+(?:[.,]\d+)?\s+(?:по|до|и)\s+|\d+(?:[.,]\d+)?\s*[-–—]\s*)\d+(?:[.,]\d+)?\s*сек/g);
    if (multi && multi.length > 1) return null;
    if (/(?:^|\s)(два|две|три|четыре|пять|нескольк\w*|оба|обе|все)\s+(?:\S+\s+)?интервал/i.test(t)) return null;
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
       11.07.2026: логика вынесена в EditPlanSimulator.buildAutoSnapshotText
       (чистая, под тестами) + кап на плотные таймлайны: 11 429 видеоклипов на
       пост-мультикам 6_SYNCED давали ~170K токенов → Cloud.ru 400
       «maximum context length» и чат был непригоден на такой секвенции. */
    /* Статус «Получение снимка таймлайна…» показывает сам execGetSnapshot (и сам прячет). */
    try {
      var autoSnap = await execGetSnapshot(true); /* ВСЕГДА свежий snap для каждого нового сообщения */
      var autoSnapText = EditPlanSimulator.buildAutoSnapshotText(autoSnap);
      if (autoSnapText) {
        apiMessages.push({ role: 'user', content: autoSnapText });
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
        /* M5: эти инструменты меняют таймлайн — agent-loop выполняет пачку
           tool_calls с любым из них строго последовательно (не Promise.all). */
        mutatingTools: ['apply_timecode_edits', 'apply_edit_plan', 'apply_transcript_cuts', 'add_markers'],
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
          if (m.role === 'system') return false;
          /* Аудит 17.07.2026: auto-snapshot валиден ОДИН ход. Раньше он
             персистился как user-сообщение → история копила N устаревших
             снимков (противоречат свежему, раздувают контекст, рисуются
             пузырями пользователя). Фильтр заодно вычищает legacy-снимки
             из историй, сохранённых до фикса. */
          if (m.role === 'user' && EditPlanSimulator.isAutoSnapshotText(m.content)) return false;
          return true;
        })
      );
      renderMessages(ContextStore.getMessages(panelId));
    } catch (e) {
      statusUi.hide();
      if (e && (e.name === 'AbortError' || String(e.message || '').indexOf('Остановлен') !== -1)) {
        showErr('Остановлено (запрос к API FM прерван).');
      } else {
        /* UI-аудит 04.07.2026: сырой «401 Unauthorized» без подсказки —
           поток поддержки. _classifyError даёт actionable-hint (ключ/сеть/лимиты). */
        var clsChat = _classifyError(e);
        showErr(String(e.message || e), clsChat.hint ? { hint: clsChat.hint } : undefined);
      }
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

  /* In/Out из снапшота: Premiere возвращает -400000 как сентинел «точка не
     задана» (getInPoint/getOutPoint), parseFloat его пропускает. Нормализуем
     в null, чтобы analyzedRegion и сравнение «область сменилась» не путали
     сентинел с реальным таймкодом. */
  function normInOutSec(v) {
    return (typeof v === 'number' && isFinite(v) && v >= 0) ? v : null;
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
      /* Аудит 04.07.2026: полная транскрибация тоже запоминает In/Out, для
         которого считалась — иначе детект «область сменилась» работал только
         после быстрого «⚡ Анализа аудио», а после полной транскрибации LED
         вечно показывал «анализ готов» для любой области. */
      try {
        var regionT = {
          inSec: normInOutSec(snap.sequenceInSec),
          outSec: normInOutSec(snap.sequenceOutSec)
        };
        if (norm.audioAnalysis) norm.audioAnalysis.analyzedRegion = regionT;
        norm.analyzedRegion = regionT;
      } catch (eAR) {}
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
        /* server (5xx) — временные, retry уместен; auth/quota/model — нет. */
        if (cls.kind === 'network' || cls.kind === 'server' || cls.kind === 'other') {
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
        try { if (window.__toolsSetProgress) window.__toolsSetProgress(msg); } catch (eP) {}
      });

      /* Запоминаем In/Out, для которого считали — чтобы Tools-LED показал «устарел»,
         если монтажёр сдвинул область и анализ больше не соответствует. */
      if (entry && entry.audioAnalysis) {
        entry.audioAnalysis.analyzedRegion = {
          inSec: normInOutSec(snap.sequenceInSec),
          outSec: normInOutSec(snap.sequenceOutSec)
        };
      }

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
        /* Аудит 04.07.2026: перцептивная шкала (γ=0.4) вместо чисто линейной.
           В линейной порог −40…−63 dB = 0.1–0.7% высоты → жёлтая линия прилипала
           к центру и НЕ двигалась за ползунком (визуально «не работает»).
           Степень 0.4 растягивает низ (порог на 4–14px от центра, ход ползунка
           виден), но структура сохраняется: тишина ~2px, дыхание ~7px,
           речь 20–36px — «монолит» чистой dB-шкалы не возвращается. */
        function amp(db) { var v = dbToLin(db) / maxLin; if (v < 0) v = 0; else if (v > 1) v = 1; return Math.pow(v, 0.4); }

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
        var thrSegs = (opts.thresholdSegments && opts.thresholdSegments.length)
          ? opts.thresholdSegments
          : (typeof opts.thresholdDb === 'number' && isFinite(opts.thresholdDb)
              ? [{ startSec: t0, endSec: t1, thresholdDb: opts.thresholdDb }] : null);
        if (thrSegs) {
          ctx.strokeStyle = 'rgba(245,200,60,0.85)';
          ctx.lineWidth = 1;
          if (ctx.setLineDash) ctx.setLineDash([4, 3]);
          ctx.beginPath();
          /* СТУПЕНЧАТАЯ линия порога: у каждого клипа свой уровень (пер-клиповый
             порог при нескольких клипах разной громкости). Один сегмент =
             прежняя сплошная горизонтальная линия. */
          for (var ti = 0; ti < thrSegs.length; ti++) {
            var sg = thrSegs[ti];
            if (typeof sg.thresholdDb !== 'number' || !isFinite(sg.thresholdDb)) continue;
            var x1 = Math.max(0, xOf(sg.startSec)), x2 = Math.min(W, xOf(sg.endSec));
            if (!(x2 > x1)) continue;
            var sty = amp(sg.thresholdDb) * maxHalf;
            ctx.moveTo(x1, mid - sty); ctx.lineTo(x2, mid - sty);
            ctx.moveTo(x1, mid + sty); ctx.lineTo(x2, mid + sty);
          }
          ctx.stroke();
          if (ctx.setLineDash) ctx.setLineDash([]);
          /* тонкие вертикальные границы между клипами */
          if (thrSegs.length > 1) {
            ctx.strokeStyle = 'rgba(245,200,60,0.22)';
            ctx.beginPath();
            for (var tv = 1; tv < thrSegs.length; tv++) {
              var bx = xOf(thrSegs[tv].startSec);
              if (bx > 0 && bx < W) { ctx.moveTo(bx, 0); ctx.lineTo(bx, H); }
            }
            ctx.stroke();
          }
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
      /* Линия порога — для «Тишины» И «Jump cuts»: оба теперь детектят по RMS с
         относительным порогом (на marginDb тише уровня речи), значит линия = реальный
         срез у обоих. «Тишины» дают margin ползунком, jumps — фикс. 22 dB. */
      if (DeterministicPipelines.rmsThresholdInfo && (st.toolName === 'silences' || st.toolName === 'jumps')) {
        var ud = params.silenceThresholdDelta;
        var marginDb = st.toolName === 'silences'
          ? ((typeof ud === 'number' && ud > 0) ? ud : 22)
          : 22;
        /* Пер-клиповый порог: ступенчатая линия + ридаут по клипам. clipRanges
           берутся из audioAnalysis (заполняются при «Анализ аудио» для >1 клипа). */
        var clipRanges = st.entry.audioAnalysis && st.entry.audioAnalysis.clipRanges;
        var segs = DeterministicPipelines.rmsThresholdSegments
          ? DeterministicPipelines.rmsThresholdSegments(st.rms, clipRanges, { marginDb: marginDb })
          : null;
        if (segs && segs.length) {
          drawOpts.thresholdSegments = segs;
          toolsUpdateWaveLegend(segs, st.toolName);
        } else {
          var info = DeterministicPipelines.rmsThresholdInfo(st.rms, { marginDb: marginDb });
          if (info) { drawOpts.thresholdDb = info.thresholdDb; toolsUpdateWaveLegend([info], st.toolName); }
          else toolsUpdateWaveLegend(null, st.toolName);
        }
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
    function toolsUpdateWaveLegend(segs, toolName) {
      var el = document.getElementById('wave-legend-' + toolName);
      if (!el) return;
      if (!segs || !segs.length) { el.hidden = true; return; }
      /* UI-аудит 04.07.2026: цветовой ключ — без него жёлтая линия и красные
         зоны на canvas оставались загадкой (title видно только по hover). */
      var COLOR_KEY = ' · ─ жёлтая: порог · ▮ красное: вырезается';
      if (segs.length === 1) {
        var info = segs[0];
        if (typeof info.thresholdDb !== 'number') { el.hidden = true; return; }
        var ref = info.speechRefDb != null ? ('речь ≈ ' + Math.round(info.speechRefDb) + ' dB · ') : '';
        el.textContent = ref + 'порог среза ' + Math.round(info.thresholdDb) + ' dB' + COLOR_KEY;
        el.hidden = false;
      } else {
        /* несколько клипов — показываем диапазон порогов + что он пер-клиповый */
        var lo = Infinity, hi = -Infinity;
        for (var i = 0; i < segs.length; i++) {
          var t = segs[i].thresholdDb;
          if (typeof t === 'number' && isFinite(t)) { if (t < lo) lo = t; if (t > hi) hi = t; }
        }
        el.textContent = segs.length + ' клипа: порог по каждому ' + Math.round(lo) + '…' + Math.round(hi) + ' dB' + COLOR_KEY;
        el.hidden = false;
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
      var msg = t || '';
      /* UI-аудит 04.07.2026: actionable-подсказка вместо сырого текста ошибки
         (тот же классификатор, что в чате: ключ / сеть / лимиты API). */
      if (msg) {
        try {
          var clsT = _classifyError(msg);
          if (clsT.hint && msg.indexOf(clsT.hint) === -1) msg += ' — ' + clsT.hint;
        } catch (eC) {}
      }
      toolsErr.textContent = msg;
      toolsErr.style.display = msg ? 'block' : 'none';
    }

    var toolsLedWrap = document.getElementById('tools-led-wrap');
    /* 3 ПОНЯТНЫХ СОСТОЯНИЯ аудио-анализа (цветовая плашка):
         красная  «нужен анализ»  — анализа нет (или устарел под текущий In/Out);
         жёлтая   «анализ идёт…»  — идёт «Анализ аудио»;
         зелёная  «анализ готов»  — есть audioAnalysis (или транскрипт).
       'audio' и 'ok' оба → зелёная (для инструментов важно одно: анализ есть).
       Разделение audio/транскрипт ушло на уровень карточек (гейт needs-transcript). */
    function toolsSetLed(state, text) {
      var color = (state === 'ok' || state === 'audio') ? 'green'
                : (state === 'busy') ? 'yellow' : 'red';
      if (toolsLed) toolsLed.className = 'transcript-led transcript-led--' + color;
      if (toolsLedWrap) toolsLedWrap.className = 'led-wrap tools-state tools-state--' + color;
      if (toolsLedText) {
        toolsLedText.textContent = text != null ? text :
          (color === 'green' ? 'анализ готов' : color === 'yellow' ? 'анализ идёт…' : 'нужен анализ');
      }
    }

    /* HIGH #18 (6 мая 2026): подписка через event listener (заменяет fragile
       window.toolsRefreshLed coupling). Сохраняем window.* для tab-switch + fallback. */
    document.addEventListener('omc:transcript-led-changed', function () {
      try { window.toolsRefreshLed(); } catch (e) {}
    });
    /* Аудит 04.07.2026: смена In/Out в таймлайне НЕ шлёт CEP-событий — пока
       вкладка «Инструменты» открыта, LED/гейты не пересчитывались вовсе
       (только tab-switch). Триггер «монтажёр вернулся в панель» = focus окна:
       подвинул In/Out → кликнул в панель → состояние честно пересчиталось. */
    window.addEventListener('focus', function () {
      try {
        var vt = document.getElementById('view-tools');
        if (vt && vt.classList.contains('active')) window.toolsRefreshLed();
      } catch (e) {}
    });
    /* 05.07.2026: focus в CEP срабатывает ненадёжно/редко — гейт «область
       изменилась» появлялся с большой задержкой и «залипал» после обновления
       анализа (нечему было пересчитать). Периодический опрос лёгким
       getSequenceRegionInfo (~4с), только пока вкладка «Инструменты» видима
       и панель свободна (не грузим однопоточный ExtendScript во время операций). */
    setInterval(function () {
      try {
        var vt2 = document.getElementById('view-tools');
        if (!vt2 || !vt2.classList.contains('active')) return;
        if (_toolsBusy) return;
        if (opQueue && opQueue.isBusy()) return;
        window.toolsRefreshLed();
      } catch (e) {}
    }, 4000);
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
    /* Аудит 04.07.2026: координаты транскрипта/анализа рипплнулись (apply тишин/
       филлеров/jump cuts из ЛЮБОЙ вкладки — ContextStore диспатчит). Waveform и
       proposal построены в СТАРЫХ координатах — прячем; LED пересчитает гейты
       (audioAnalysis при ripple сбрасывается — нужен новый «Анализ аудио»). */
    document.addEventListener('omc:transcript-rippled', function () {
      try {
        _waveState = null;
        var ws2 = document.getElementById('wave-silences'); if (ws2) ws2.hidden = true;
        var wj2 = document.getElementById('wave-jumps'); if (wj2) wj2.hidden = true;
        var ls2 = document.getElementById('wave-legend-silences'); if (ls2) ls2.hidden = true;
        var lj2 = document.getElementById('wave-legend-jumps'); if (lj2) lj2.hidden = true;
        toolsHideAllProposals();
        window.toolsRefreshLed();
      } catch (e) {}
    });
    /* Анализ устарел? — сравниваем In/Out, для которого считали анализ, с текущим
       In/Out секвенции. Если монтажёр сдвинул область — анализ нужно обновить.
       ar передаётся ЯВНО: у аудио-анализа и транскрипта СВОИ analyzedRegion
       (например «⚡ Обновить анализ» освежает только audioAnalysis — транскрипт
       остаётся от старой области и его карточки должны остаться под гейтом). */
    function _regionStale(ar, snap) {
      if (!ar || !snap || typeof snap !== 'object') return false;
      /* normInOutSec: -400000-сентинел «In/Out не задан» → null с обеих сторон */
      function near(a, b) { if (a === null && b === null) return true; if (a === null || b === null) return false; return Math.abs(a - b) <= 0.5; }
      return !(near(normInOutSec(snap.sequenceInSec), normInOutSec(ar.inSec)) && near(normInOutSec(snap.sequenceOutSec), normInOutSec(ar.outSec)));
    }
    /* Вычислить и показать LED/карточки. Принимает СНИМОК (объект) — чтобы показать
       имя секвенции и определить устаревание по In/Out. Строка = только имя (fallback). */
    function _applyToolsLedForSeq(snap) {
      var seqName = (snap && typeof snap === 'object') ? (snap.sequenceName || '') : (typeof snap === 'string' ? snap : '');
      var hasTranscript = false, hasAudio = false, staleAudio = false, staleTranscript = false;
      try {
        if (seqName) {
          var f = ContextStore.findTranscriptEntry(TRANSCRIPT_PID, seqName);
          if (f && f.entry) {
            hasTranscript = !!(f.entry.segments && f.entry.segments.length);
            /* P0-2: аудиоанализ (ffmpeg) без Whisper достаточен для «Тишины» */
            hasAudio = hasTranscript || !!f.entry.audioAnalysis;
            /* Раздельные stale-флаги: «⚡ Обновить анализ» освежает ТОЛЬКО
               audioAnalysis.analyzedRegion — раньше единый флаг разблокировал
               заодно и транскрипт-карточки (транскрипт от СТАРОЙ области!),
               и наоборот: старый top-level analyzedRegion удерживал гейт
               аудио-карточек после честного обновления анализа. */
            var arA = (f.entry.audioAnalysis && f.entry.audioAnalysis.analyzedRegion) || f.entry.analyzedRegion;
            var arT = f.entry.analyzedRegion || (f.entry.audioAnalysis && f.entry.audioAnalysis.analyzedRegion);
            if (hasAudio) staleAudio = _regionStale(arA, snap);
            if (hasTranscript) staleTranscript = _regionStale(arT, snap);
          }
        }
      } catch (e) { /* findTranscriptEntry не должен падать */ }
      var seqLabel = seqName ? ' · «' + seqName + '»' : '';
      if (!hasAudio && !hasTranscript) {
        toolsSetLed('red', 'нужен анализ' + seqLabel);
      } else if (staleAudio && (staleTranscript || !hasTranscript)) {
        /* ВСЁ устарело для текущего In/Out — нужен заново */
        toolsSetLed('red', 'нужен анализ' + seqLabel + ' (область сменилась)');
      } else if (staleAudio || staleTranscript) {
        /* часть данных актуальна — жёлтый: смотри гейты на карточках */
        toolsSetLed('busy', 'часть анализа устарела' + seqLabel);
      } else {
        toolsSetLed(hasTranscript ? 'ok' : 'audio', 'анализ готов' + seqLabel);
      }
      toolsUpdateCards(hasTranscript, hasAudio, staleTranscript, staleAudio);
      /* Статусы карточек следуют за активной секвенцией (как LED/гейты). */
      try { _renderAllCardStatuses(seqName); } catch (eS) {}
    }
    var _ledRefreshInFlight = false;
    window.toolsRefreshLed = function () {
      /* Во время «Анализ аудио» держим busy — не перетираем индикатор прогресса. */
      if (_toolsBusy) { toolsSetLed('busy'); return; }
      /* 19.06.2026 FIX: LED отражает АКТИВНУЮ секвенцию. ВСЕГДА запрашиваем свежее
         состояние — НЕ полагаемся на _snapDirty/lastSnap: CEP-событие
         ActiveSequenceChanged ненадёжно («могут не работать»), при его пропуске LED
         показывал состояние СТАРОЙ секвенции (или произвольной keys[0]). in-flight
         guard защищает от наложения частых вызовов (tab-switch/события).
         05.07.2026: лёгкий getSequenceRegionInfo вместо полного снимка — LED нужны
         ТОЛЬКО имя + In/Out. Полный снимок (сотни клипов) отвечал секундами и мог
         упасть по таймауту → fallback на lastSnap со СТАРЫМ In/Out держал гейт
         «область изменилась» даже после честного обновления анализа. */
      if (_ledRefreshInFlight) return;
      _ledRefreshInFlight = true;
      try {
        PremiereBridge.getSequenceRegionInfo(function (err, info) {
          _ledRefreshInFlight = false;
          if (!err && info && info.ok) _applyToolsLedForSeq(info);
          else _applyToolsLedForSeq(lastSnap || '');
        });
      } catch (e) { _ledRefreshInFlight = false; _applyToolsLedForSeq(lastSnap || ''); }
    };
    /* Прогресс «Анализ аудио» прямо в LED-тексте Tools-вкладки: счётчик клипов =
       честный индикатор (клип 2/3), иначе «идёт…». Зовётся из onAudioOnlyAnalyze. */
    window.__toolsSetProgress = function (msg) {
      if (!_toolsBusy || !toolsLedText) return;
      var m = String(msg || '').match(/клип\s+(\d+\/\d+)/);
      toolsLedText.textContent = m ? ('идёт… клип ' + m[1]) : 'идёт…';
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
    function toolsUpdateCards(hasTranscript, hasAudio, staleTranscript, staleAudio) {
      /* Аудит 04.07.2026: stale («область In–Out сменилась») теперь БЛОКИРУЕТ
         карточки, а не только красит LED — раньше LED говорил «нужен анализ»,
         но кнопки оставались живыми и резали по СТАРОЙ области.
         05.07.2026: stale раздельный — транскрипт и аудио-анализ обновляются
         независимо, у каждого свой analyzedRegion. */
      var i, gated;
      var cards = document.querySelectorAll('.tool-card.needs-transcript');
      for (i = 0; i < cards.length; i++) {
        gated = !hasTranscript || staleTranscript;
        if (gated) cards[i].classList.add('disabled');
        else cards[i].classList.remove('disabled');
        _setCardGate(cards[i], gated, 'transcript', hasTranscript && staleTranscript);
      }
      var audioCards = document.querySelectorAll('.tool-card.needs-audio');
      for (i = 0; i < audioCards.length; i++) {
        gated = !hasAudio || staleAudio;
        if (gated) audioCards[i].classList.add('disabled');
        else audioCards[i].classList.remove('disabled');
        _setCardGate(audioCards[i], gated, 'audio', hasAudio && staleAudio);
      }
    }

    /* Гейт-подсказка на карточке: вместо немой 45%-прозрачности — явное «что
       нужно» + кнопка действия. Блокируем «Найти и вырезать», пока гейт активен
       (раньше кнопка кликалась и выдавала сырую ошибку → «кнопки бесполезны»). */
    function _setCardGate(card, gated, kind, stale) {
      var runBtn = card.querySelector('.tool-run');
      if (runBtn) runBtn.disabled = gated;
      var gate = card.querySelector('.tool-gate');
      if (!gated) { if (gate) gate.hidden = true; return; }
      if (!gate) {
        gate = document.createElement('div');
        gate.className = 'tool-gate';
        var msg = document.createElement('span'); msg.className = 'tool-gate-msg';
        var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'tool-gate-btn';
        gate.appendChild(msg); gate.appendChild(btn);
        card.insertBefore(gate, runBtn || null);
      }
      gate.hidden = false;
      var msgEl = gate.querySelector('.tool-gate-msg');
      var btnEl = gate.querySelector('.tool-gate-btn');
      if (kind === 'audio') {
        /* stale: анализ есть, но для другого In/Out — просим обновить, не «нужен» */
        msgEl.textContent = stale
          ? 'Область In–Out изменилась — анализ был для другой области.'
          : 'Нужен аудио-анализ региона In–Out.';
        btnEl.textContent = stale ? '⚡ Обновить анализ' : '⚡ Анализировать';
        btnEl.onclick = function () { onAudioOnlyAnalyze(); };
      } else {
        msgEl.textContent = stale
          ? 'Область In–Out изменилась — транскрипт был для другой области.'
          : 'Нужна транскрипция (текстовый инструмент).';
        btnEl.textContent = 'Перейти в Чат';
        btnEl.onclick = function () { var t = document.querySelector('.view-tab[data-view="chat"]'); if (t) t.click(); };
      }
    }

    /* ── Персистентный статус карточек (11.07.2026, комплексный статус-UX).
       Раньше итог инструмента жил в toast toolsStatusUi (4с) или в .proposal-area
       (стирается toolsHideAllProposals при смене секвенции/риппле) — «спикеры
       размечены: плашка повисела и пропала», статус применения терялся.
       Теперь у каждой карточки строка «последний итог» ПО СЕКВЕНЦИЯМ:
       переключился на другую секвенцию — видишь её итоги, вернулся — прежние.
       Хранение in-memory (сессия панели): итог — журнал действий, не данные. */
    var _toolsCardStatus = {};   /* seqKey → { cardId: {text, kind, stamp} } */
    var _toolsStatusSeqKey = ''; /* секвенция, чьи статусы сейчас на экране */
    function toolsSetCardStatus(cardId, seqKey, text, kind) {
      if (!seqKey || !cardId) return;
      if (!_toolsCardStatus[seqKey]) _toolsCardStatus[seqKey] = {};
      var d = new Date();
      var stamp = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      _toolsCardStatus[seqKey][cardId] = { text: String(text || ''), kind: kind || 'info', stamp: stamp };
      if (seqKey === _toolsStatusSeqKey) _renderCardStatus(cardId, _toolsCardStatus[seqKey][cardId]);
    }
    function _renderCardStatus(cardId, st) {
      var card = document.getElementById(cardId);
      if (!card) return;
      var el = card.querySelector('.tool-card-status');
      if (!st) { if (el) el.hidden = true; return; }
      if (!el) {
        el = document.createElement('div');
        card.appendChild(el);
      }
      el.hidden = false;
      el.className = 'tool-card-status tool-card-status--' + st.kind;
      el.textContent = st.stamp + ' · ' + st.text;
    }
    /* Перерисовать статусы всех карточек под секвенцию (зовётся из
       _applyToolsLedForSeq — тот же жизненный цикл, что LED/гейты). */
    function _renderAllCardStatuses(seqKey) {
      _toolsStatusSeqKey = seqKey || '';
      var map = _toolsCardStatus[_toolsStatusSeqKey] || {};
      var cards = document.querySelectorAll('.tool-card[id]');
      for (var i = 0; i < cards.length; i++) {
        _renderCardStatus(cards[i].id, map[cards[i].id] || null);
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
    (function () {
      var s = document.getElementById('mc-smooth');
      var v = document.getElementById('mc-smooth-val');
      if (!s || !v) return;
      function upd() { v.textContent = s.value + ' кадр.'; }
      s.addEventListener('input', upd);
      upd();
    })();
    (function () {
      var s = document.getElementById('mc-overlap');
      var v = document.getElementById('mc-overlap-val');
      if (!s || !v) return;
      function upd() { v.textContent = s.value === '0' ? 'выкл' : s.value + 'с'; }
      s.addEventListener('input', upd);
      upd();
    })();
    bindSlider('mc-maxall', 'mc-maxall-val', 'с');
    (function () {
      /* Tier 1 (11.07.2026): «Шаг анализа» = frameSec, показываем в мс */
      var s = document.getElementById('mc-framesec');
      var v = document.getElementById('mc-framesec-val');
      if (!s || !v) return;
      function upd() { v.textContent = Math.round(parseFloat(s.value) * 1000) + 'мс'; }
      s.addEventListener('input', upd);
      upd();
    })();
    (function () {
      /* Tier 1: «Вариант» = variationsSeed, показываем как #N */
      var s = document.getElementById('mc-seed');
      var v = document.getElementById('mc-seed-val');
      if (!s || !v) return;
      function upd() { v.textContent = '#' + s.value; }
      s.addEventListener('input', upd);
      upd();
    })();
    (function () {
      /* Tier 3: «Привязка к паузам» = snapWindowSec, 0 = выкл */
      var s = document.getElementById('mc-snap');
      var v = document.getElementById('mc-snap-val');
      if (!s || !v) return;
      function upd() { v.textContent = s.value === '0' ? 'выкл' : s.value + 'с'; }
      s.addEventListener('input', upd);
      upd();
    })();
    (function () {
      /* Tier 3: «Сдвиг привязки» = frameOffsetSec, показываем в мс со знаком */
      var s = document.getElementById('mc-snapoff');
      var v = document.getElementById('mc-snapoff-val');
      if (!s || !v) return;
      function upd() {
        var ms = Math.round(parseFloat(s.value) * 1000);
        v.textContent = (ms > 0 ? '+' : '') + ms + 'мс';
      }
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

    /* ── Инвалидация предложения при смене параметров ─────────
       05.07.2026: план в proposal строится ОДИН РАЗ по параметрам на момент
       «Найти и вырезать». Ползунки после этого перерисовывали waveform-зоны
       live, но «Применить» вырезал бы СТАРЫЙ план (юзер видит «16 пауз >0.3с»,
       ставит 2.5с — apply резал бы старые 16). Любой input/change/toggle внутри
       карточки с видимым предложением сбрасывает его: честное правило
       «предложение всегда соответствует текущим ползункам». */
    (function () {
      function invalidateProposalOf(card) {
        var area = card.querySelector('.proposal-area');
        if (!area || area.className.indexOf('visible') === -1) return;
        toolsHideProposal(area);
        toolsStatusUi.show('Параметры изменились — предложение сброшено. Нажмите «Найти и вырезать» заново.', false);
        setTimeout(function () { toolsStatusUi.hide(); }, 4000);
      }
      var invCards = document.querySelectorAll('.tool-card');
      for (var ci = 0; ci < invCards.length; ci++) {
        (function (card) {
          function onParamChange(ev) {
            var t = ev.target;
            if (!t) return;
            /* Кнопки предложения (Применить/Отмена) и гейта — НЕ параметры. */
            if (t.tagName === 'INPUT' || t.tagName === 'SELECT') { invalidateProposalOf(card); return; }
            if (ev.type === 'click' && t.className && String(t.className).indexOf('toggle-btn') !== -1) invalidateProposalOf(card);
          }
          card.addEventListener('input', onParamChange);
          card.addEventListener('change', onParamChange);
          card.addEventListener('click', onParamChange);
        })(invCards[ci]);
      }
    })();

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
      /* UX 10.07.2026: многострочные сводки (мультикам: экранное время/батчи) */
      sum.style.whiteSpace = 'pre-line';
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
        /* 10.07.2026 (Волна 1.5): та же гонка, что в чате — _toolsProposal мог
           смениться, пока assertSequenceMatch летал к host. */
        var toolsPropAtClick = _toolsProposal;
        var pSnap = toolsPropAtClick && toolsPropAtClick.snapshot;
        assertSequenceMatch(pSnap, function (err, ok) {
          if (_toolsProposal !== toolsPropAtClick) {
            toolsShowErr('План изменился, пока шла проверка секвенции — карточка устарела.');
            return;
          }
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
        /* 11.07.2026: батчинг ripple-удалений (live-находка на 6_SYNCED):
           116 вырезок одним evalScript на плотном таймлайне (11.4K клипов после
           мультикам-razor) шли ~15 мин → 120с-watchdog моста «падал», хотя host
           продолжал резать. Итог: клиент в ошибке, транскрипт-ремап пропущен →
           десинхрон кэша. Бьём на батчи по 10 (справа-налево, батчи независимы —
           см. splitCutIntervalsIntoBatches), ремап транскрипта — после КАЖДОГО
           успешного батча: при сбое посередине кэш согласован с уже применённым. */
        var tcExpected = (prop.snapshot && prop.snapshot.sequenceName) || '';
        var tcBatches = DeterministicPipelines.splitCutIntervalsIntoBatches(prop.removeIntervals || []);
        var tcTotal = (prop.removeIntervals || []).length;
        var tcDone = 0;      /* применённых вырезок */
        var tcRemSec = 0;    /* суммарно вырезано, сек */

        var tcSeqKey = function () {
          return prop.seqKey || tcExpected ||
            (lastSnap && lastSnap.sequenceName ? lastSnap.sequenceName : '');
        };

        var tcFinish = function (failMsg) {
          toolsDisableRun(false);
          endOperation();
          toolsStatusUi.hide();
          _snapDirty = true;
          lastSnap = null; /* force chat to re-fetch snapshot */
          if (failMsg) {
            toolsShowErr(failMsg);
            /* Статус-UX 11.07.2026: ошибка остаётся на карточке */
            toolsSetCardStatus(prop.cardId, tcSeqKey(), String(failMsg).slice(0, 160), 'err');
            try { window.toolsRefreshLed(); } catch (eLF) {}
            return;
          }
          toolsHideProposal(area);
          toolsStatusUi.show('Готово! Откат: Cmd+Z / Ctrl+Z', false);
          /* Статус-UX 11.07.2026: итог остаётся на карточке + немедленный
             пересчёт гейтов (не ждать 4с-интервала — гейт-гонка после ripple). */
          toolsSetCardStatus(prop.cardId, tcSeqKey(),
            'Применено: ' + tcDone + ' вырезок (−' + tcRemSec.toFixed(1) + 'с). Откат: Cmd+Z', 'ok');
          try { window.toolsRefreshLed(); } catch (eL) {}
          /* Sync chat transcript LED */
          setTranscriptLed('ok');
          setTimeout(function () { toolsStatusUi.hide(); }, 2500);
        };

        var tcRunBatch = function (bi) {
          if (bi >= tcBatches.length) { tcFinish(null); return; }
          var ivs = tcBatches[bi];
          if (tcBatches.length > 1) {
            toolsStatusUi.show('Монтаж: батч ' + (bi + 1) + '/' + tcBatches.length +
              ' (вырезки ' + (tcDone + 1) + '–' + (tcDone + ivs.length) + ' из ' + tcTotal + ')…', true);
          }
          PremiereBridge.applyTranscriptCuts(
            { removeIntervals: ivs, summary: prop.summary, expectedSequenceName: tcExpected },
            function (err, dataTC) {
              if (err || (dataTC && dataTC.ok === false)) {
                var reason = err ? String(err.message || err) : ('НЕ применено: ' + describeHostFailure(dataTC));
                var partial = tcDone > 0
                  ? ' Применено ' + tcDone + ' из ' + tcTotal +
                    ' вырезок — откатите таймлайн кнопкой ⏪ и повторите.'
                  : ' Таймлайн не изменён.';
                tcFinish((tcBatches.length > 1
                  ? 'Ошибка (батч ' + (bi + 1) + '/' + tcBatches.length + '): ' : 'Ошибка: ') +
                  reason + partial);
                return;
              }
              /* Ремап транскрипта СРАЗУ после батча: батчи независимы (справа-
                 налево), при сбое следующего кэш останется согласованным. */
              try {
                var sk = tcSeqKey();
                if (sk) ContextStore.applyRippleDeletionsToTranscript(TRANSCRIPT_PID, sk, ivs);
              } catch (eR) {
                console.warn('[tools] applyRippleDeletionsToTranscript failed:', eR && eR.message);
              }
              tcDone += ivs.length;
              for (var rvi = 0; rvi < ivs.length; rvi++) {
                tcRemSec += Math.max(0, (ivs[rvi].endSec || 0) - (ivs[rvi].startSec || 0));
              }
              tcRunBatch(bi + 1);
            }
          );
        };

        /* B2-9: checkpoint перед ripple-удалениями */
        _makeSequenceCheckpoint('монтаж (tools)', function () {
          tcRunBatch(0);
        });
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
          toolsSetCardStatus(prop.cardId, prop.seqKey, 'Создано маркеров: ' + cnt, 'ok');
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
              toolsSetCardStatus(prop.cardId, prop.seqKey,
                ml + ': ' + data.applied + '/' + data.totalCuts + ' стыков', 'ok');
            } else {
              toolsShowErr('Ошибка: ' + ((data && data.error) || 'неизвестная'));
              toolsSetCardStatus(prop.cardId, prop.seqKey,
                'Ошибка: ' + String((data && data.error) || 'неизвестная').slice(0, 140), 'err');
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
        /* 10.07.2026: длинный план (1.2ч подкаст → сотни сегментов) в один
           evalScript упирался в 120с-watchdog моста. Бьём на батчи по ~40
           сегментов: каждый вызов host короткий, у каждого свой таймаут,
           между батчами — прогресс. Host сам сверяет expectedSequenceName
           перед КАЖДЫМ батчем (пользователь мог переключить секвенцию). */
        var mcPlan = Object.assign({}, prop.plan, {
          expectedSequenceName: (prop.snapshot && prop.snapshot.sequenceName) || ''
        });
        var mcBatches = MulticamPlan.splitPlanIntoBatches(mcPlan);
        var mcTotalSegs = mcPlan.segments.length;
        var mcTotals = { cutsApplied: 0, cutsFailed: 0, segmentsApplied: 0, disabledCount: 0, deletedCount: 0 };
        var mcDoneSegs = 0;

        var mcFinish = function (failMsg) {
          toolsDisableRun(false);
          endOperation();
          toolsStatusUi.hide();
          if (failMsg) {
            toolsShowErr(failMsg);
            toolsSetCardStatus(prop.cardId, prop.seqKey, String(failMsg).slice(0, 160), 'err');
            return;
          }
          toolsHideProposal(area);
          var msg = 'MultiCam: ' + mcTotals.cutsApplied + ' разрезов, ' +
            mcTotals.segmentsApplied + ' сегментов, ' +
            (mcTotals.deletedCount ? mcTotals.deletedCount + ' клипов удалено.' :
              mcTotals.disabledCount + ' клипов отключено.') + ' Откат: ⏪';
          toolsStatusUi.show(msg, false);
          toolsSetCardStatus(prop.cardId, prop.seqKey, msg, 'ok');
          try { window.toolsRefreshLed(); } catch (eL) {}
          setTimeout(function () { toolsStatusUi.hide(); }, 4000);
        };

        var mcRunBatch = function (bi) {
          if (bi >= mcBatches.length) { mcFinish(null); return; }
          var b = mcBatches[bi];
          if (mcBatches.length > 1) {
            toolsStatusUi.show('MultiCam: батч ' + (bi + 1) + '/' + mcBatches.length +
              ' (сегменты ' + (mcDoneSegs + 1) + '–' + (mcDoneSegs + b.segments.length) +
              ' из ' + mcTotalSegs + ')…', true);
          }
          PremiereBridge.applyMulticamCuts(b, function (err, data) {
            var failed = err || !data || !data.ok;
            if (!failed) {
              mcTotals.cutsApplied += data.cutsApplied || 0;
              mcTotals.cutsFailed += data.cutsFailed || 0;
              mcTotals.segmentsApplied += data.segmentsApplied || 0;
              mcTotals.disabledCount += data.disabledCount || 0;
              mcTotals.deletedCount += data.deletedCount || 0;
              mcDoneSegs += b.segments.length;
              mcRunBatch(bi + 1);
              return;
            }
            /* Fail-stop: НЕ продолжаем на следующем батче — таймлайн в
               частично применённом состоянии, пользователь откатывает ⏪. */
            var reason = err ? String(err.message || err) : ((data && data.error) || 'неизвестная');
            var applied = mcDoneSegs > 0
              ? ' Применено ' + mcDoneSegs + ' из ' + mcTotalSegs +
                ' сегментов — откатите таймлайн кнопкой ⏪ и повторите.'
              : ' Таймлайн не изменён.';
            mcFinish('Ошибка MultiCam (батч ' + (bi + 1) + '/' + mcBatches.length + '): ' +
              reason + applied);
          });
        };

        /* B2-9: checkpoint — razor режет клипы даже в режиме disable */
        _makeSequenceCheckpoint('MultiCam', function () {
          mcRunBatch(0);
        });
        return;
      }

      endOperation();
      toolsShowErr('Неизвестный тип: ' + prop.kind);
    }

    /* ── «🗣 Спикеры»: локальная диаризация транскрипта по RMS микрофонов
       (Волна 3 п.3, 10.07.2026). Whisper Cloud.ru спикеров не отдаёт —
       размечаем сами: host перечисляет мики (direct-дорожки И inner-треки
       nest), ffmpeg считает RMS каждого файла один раз, assignSpeakersByRms
       ставит segment.speaker, buildStructure подхватывает метки в
       entry.speakers → агент видит их в get_transcript_structure. ─────── */
    async function toolsRunDiarize() {
      if (!beginOperation('tools:speakers')) {
        toolsShowErr('Идёт обработка в чате — дождитесь завершения (кнопка «Стоп» на вкладке «Чат»).');
        return;
      }
      toolsDisableRun(true);
      toolsStatusUi.show('Ищу микрофоны…', true);
      var resEl = document.getElementById('dz-result');
      if (resEl) { resEl.textContent = ''; }
      var keepStatus = false;
      try {
        var snap = await execGetSnapshot(true);
        if (!snap || !snap.ok) {
          toolsShowErr(snap && snap.error ? snap.error : 'Не удалось получить снимок таймлайна.');
          return;
        }
        var seqKey = snap.sequenceName || '';
        var found = seqKey ? ContextStore.findTranscriptEntry(TRANSCRIPT_PID, seqKey) : { entry: null };
        var entry = found && found.entry;
        if (!entry || !entry.segments || !entry.segments.length) {
          toolsShowErr('Нет транскрипта для «' + seqKey + '» — сначала транскрибируйте In–Out (вкладка «Чат»).');
          return;
        }
        var src = await new Promise(function (resolve, reject) {
          PremiereBridge.getDiarizeMicSources(function (err, data) {
            if (err) reject(err); else resolve(data);
          });
        });
        if (!src || !src.ok) {
          toolsShowErr((src && src.error) || 'Не удалось перечислить микрофоны.');
          return;
        }
        /* Снимок и мики должны быть с ОДНОЙ секвенции — иначе метки уедут
           в чужой транскрипт. */
        if (String(src.sequenceName || '') !== seqKey) {
          toolsShowErr('Активная секвенция сменилась («' + src.sequenceName + '») — откройте «' + seqKey + '» и повторите.');
          return;
        }
        var mics = src.mics || [];
        var dzTracksEl = document.getElementById('dz-tracks');
        var filter = DeterministicPipelines.parseAudioTrackFilter(dzTracksEl ? dzTracksEl.value : '');
        if (filter) {
          mics = mics.filter(function (m) { return filter.indexOf(m.trackNumber) !== -1; });
        }
        if (mics.length < 2) {
          toolsShowErr('Нужно минимум 2 микрофона, найдено: ' +
            (mics.length ? mics.map(function (m) { return m.label; }).join(', ') : '0') +
            '. Проверьте фильтр дорожек и mute (камерный звук лучше исключить фильтром, напр. «4-6»).');
          return;
        }
        /* RMS на ФАЙЛ один раз: разрезанный nest даёт много частей одного файла. */
        var pathSet = {};
        for (var mi = 0; mi < mics.length; mi++) {
          for (var pj = 0; pj < mics[mi].parts.length; pj++) pathSet[mics[mi].parts[pj].mediaPath] = 1;
        }
        var paths = Object.keys(pathSet);
        var doneCount = 0;
        var showMicStatus = function () {
          toolsStatusUi.show('Анализ микрофонов: готово ' + doneCount + ' из ' + paths.length + '…', true);
        };
        showMicStatus();
        var rmsByPath = {};
        /* Live e2e 11.07 (6_SHORTS): на синхроне мик-дорожки содержат короткие
           скрэтч-хвосты BRAW (ffmpeg их не декодирует) — падение одного файла
           не должно валить диаризацию. Недекодируемый файл = тишина
           (micPartsToTimeline пропускает пути без RMS), предупреждаем. */
        var rmsFailed = [];
        await Promise.all(paths.map(function (p) {
          return AudioPreprocess.computeRmsTimeline(p, { windowSec: 0.05 })
            .then(function (tl) {
              doneCount++;
              showMicStatus();
              rmsByPath[p] = tl;
            }, function (e) {
              doneCount++;
              showMicStatus();
              var fname = String(p).split(/[\\\/]/).pop();
              rmsFailed.push(fname + ': ' + String((e && e.message) || e));
            });
        }));
        if (!Object.keys(rmsByPath).length) {
          toolsShowErr('Ни один аудиофайл не декодируется ffmpeg:\n' + rmsFailed.join('\n'));
          return;
        }
        var labels = [];
        var timelines = [];
        for (var li = 0; li < mics.length; li++) {
          labels.push('Спикер ' + (li + 1) + ' (' + mics[li].label + ')');
          timelines.push(DeterministicPipelines.micPartsToTimeline(mics[li].parts, rmsByPath));
        }
        var res = DeterministicPipelines.assignSpeakersByRms(entry.segments, timelines, { labels: labels });
        entry.segments = res.segments;
        try { TranscriptStructure.buildStructure(entry); } catch (eB) {}
        ContextStore.setTranscriptEntry(TRANSCRIPT_PID, found.matchedKey, entry);
        var lines = ['Размечено ' + res.labeled + ' из ' + res.total + ' сегментов.'];
        for (var si = 0; si < labels.length; si++) {
          lines.push(labels[si] + ' — ' + (res.perSpeaker[labels[si]] || 0));
        }
        var unlabeled = res.total - res.labeled;
        if (unlabeled > 0) lines.push('Без метки (перекрытие/тишина): ' + unlabeled);
        if (rmsFailed.length) {
          lines.push('⚠ Не декодируются (учтены как тишина): ' + rmsFailed.length + ' файл(а) — ' +
            rmsFailed.map(function (s) { return s.split(':')[0]; }).join(', '));
        }
        if (resEl) {
          resEl.style.whiteSpace = 'pre-line';
          resEl.textContent = lines.join('\n');
        }
        toolsSetCardStatus('card-speakers', seqKey,
          'Размечено ' + res.labeled + ' из ' + res.total + ' сегментов (' + labels.length + ' спикера)', 'ok');
        toolsStatusUi.show('Спикеры размечены ✓', false);
        keepStatus = true;
        setTimeout(function () { toolsStatusUi.hide(); }, 4000);
      } catch (e) {
        toolsShowErr(String(e.message || e));
      } finally {
        endOperation();
        toolsDisableRun(false);
        if (!keepStatus) toolsStatusUi.hide();
      }
    }

    /* ── «🎬 Рилс» (17.07.2026): объединяет «Вертикаль 9:16» и «Субтитры».
       Рефрейм: host clone() → setSettings 9:16/1:1 → Motion по плану
       planVerticalReframe; позицию кадрирования решает vision-модель по кадру
       из середины каждого уникального источника (ручные смещения побеждают,
       nest — центр). Субтитры: караоке-кьюи с пословным таймингом →
       LLM-корректура с guard (только орфография/пунктуация, слова неизменны) →
       правило точек → ASS (SB Sans, анимация нет/цвет/плашка) → ffmpeg+libass
       → прозрачный ProRes 4444 → importAndOverlayOnTop на новую верхнюю
       дорожку новой секвенции. Исходная секвенция не меняется. */

    /* Шрифт для libass берётся из системных; ищем файл SB Sans в шрифтовых
       папках (имена файлов без пробелов → нормализация). */
    function reelsFontInstalled(fontName) {
      try {
        var fs = require('fs');
        var os = require('os');
        var dirs = [
          'C:\\Windows\\Fonts',
          os.homedir() + '\\AppData\\Local\\Microsoft\\Windows\\Fonts',
          '/Library/Fonts', '/System/Library/Fonts',
          os.homedir() + '/Library/Fonts'
        ];
        var key = /display/i.test(fontName) ? 'sbsansdisplay' : 'sbsanstext';
        for (var d = 0; d < dirs.length; d++) {
          var files;
          try { files = fs.readdirSync(dirs[d]); } catch (eDir) { continue; }
          for (var f = 0; f < files.length; f++) {
            var nf = String(files[f]).toLowerCase().replace(/[\s_-]/g, '');
            if (nf.indexOf(key) !== -1 && nf.indexOf('semibold') !== -1) return true;
          }
        }
      } catch (e) {}
      return false;
    }

    /* ffmpeg промисом (паттерн audio-render.js), таймаут 10 мин. */
    function reelsRunFfmpeg(bin, args) {
      return new Promise(function (resolve, reject) {
        var execFile = require('child_process').execFile;
        execFile(bin, args, { timeout: 600000, maxBuffer: 8 * 1024 * 1024 }, function (err, stdout, stderr) {
          if (err) {
            reject(new Error('ffmpeg упал: ' + String(err.message || err) + '\n' + String(stderr || '').slice(0, 600)));
            return;
          }
          resolve(String(stderr || ''));
        });
      });
    }

    /* LLM-корректура кьюев батчами: только орфография/пунктуация, guard
       applyProofread отклоняет всё, что меняет слова. Фейл батча — исключение
       наверх (вызывающий продолжает с исходными кьюями). */
    var REELS_PROOFREAD_BATCH = 40;

    /* Рилс v2: кью персистятся через transcript-cache механизм ContextStore
       с отдельным PID — ключ = имя рилс-секвенции. Ноль изменений в сторе. */
    var REELS_PID = '_llm_reels_cache';
    function reelsActivateSequence(name) {
      return new Promise(function (resolve, reject) {
        PremiereBridge.activateSequenceByName({ name: name }, function (err, data) {
          if (err) reject(err);
          else if (!data || !data.ok) reject(new Error((data && data.error) || 'activateSequenceByName: нет ответа'));
          else resolve(data);
        });
      });
    }

    async function reelsProofread(cues, settings, onProgress) {
      if (!settings.apiKey || !settings.chatModel) throw new Error('нет chat-модели или API-ключа');
      var out = cues;
      var applied = 0, rejected = 0;
      for (var off = 0; off < cues.length; off += REELS_PROOFREAD_BATCH) {
        if (onProgress) onProgress(off, cues.length);
        var batch = [];
        var hi = Math.min(off + REELS_PROOFREAD_BATCH, cues.length);
        for (var i = off; i < hi; i++) {
          batch.push({ i: i, text: out[i].text.replace(/\n/g, ' ') });
        }
        var resp = await CloudRuClient.chatCompletions({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: settings.chatModel,
          temperature: 0,
          enableThinking: false,
          responseFormat: 'json_object',
          chatParams: { max_tokens: 4096 },
          messages: [
            {
              role: 'system',
              content: 'Ты корректор русских субтитров. Исправляй ТОЛЬКО орфографию и пунктуацию. ' +
                'ЗАПРЕЩЕНО добавлять, удалять или заменять слова, менять их порядок или смысл. ' +
                'Верни строго JSON {"cues":[{"i":<номер>,"text":"<исправленный текст>"}]} — ' +
                'ТОЛЬКО изменённые титры (если правок нет — {"cues":[]}).'
            },
            { role: 'user', content: JSON.stringify({ cues: batch }) }
          ]
        });
        var content = (resp && resp.choices && resp.choices[0] && resp.choices[0].message)
          ? String(resp.choices[0].message.content || '') : '';
        var parsed = null;
        try { parsed = JSON.parse(content); } catch (ePj) { throw new Error('модель вернула не-JSON'); }
        var results = (parsed && parsed.cues && parsed.cues.length) ? parsed.cues : [];
        if (results.length) {
          var r = ReelsPipeline.applyProofread(out, results);
          out = r.cues;
          applied += r.applied;
          rejected += r.rejected;
        }
      }
      return { cues: out, applied: applied, rejected: rejected };
    }

    async function toolsRunReels() {
      if (!beginOperation('tools:reels')) {
        toolsShowErr('Идёт обработка в чате — дождитесь завершения (кнопка «Стоп» на вкладке «Чат»).');
        return;
      }
      toolsDisableRun(true);
      toolsStatusUi.show('Рилс: проверяю условия…', true);
      var resEl = document.getElementById('rl-result');
      if (resEl) { resEl.textContent = ''; }
      var keepStatus = false;
      try {
        var fs = require('fs');
        var path = require('path');
        var os = require('os');
        var notes = [];

        /* 0. Preflight: ffmpeg, шрифт (только при анимации), транскрипт, настройки. */
        var anim = (document.getElementById('rl-anim') || {}).value || 'color';
        var ffBin = AudioPreprocess.findFfmpegPath();
        if (!ffBin) {
          toolsShowErr('Нужен ffmpeg (кадры для vision' + (anim !== 'none' ? ' и рендер субтитров' : '') + '). Установите ffmpeg и повторите.');
          return;
        }
        var fontName = (document.getElementById('rl-font') || {}).value || 'SB Sans Text SemiBold';
        if (anim !== 'none' && !reelsFontInstalled(fontName)) {
          toolsShowErr('Шрифт «' + fontName + '» не найден среди системных. Установите .otf (правый клик → «Установить для всех пользователей») и повторите.');
          return;
        }
        var snap = await execGetSnapshot(true);
        if (!snap || !snap.ok) {
          toolsShowErr(snap && snap.error ? snap.error : 'Не удалось получить снимок таймлайна.');
          return;
        }
        var seqName = String(snap.sequenceName || '');
        var found = seqName ? ContextStore.findTranscriptEntry(TRANSCRIPT_PID, seqName) : { entry: null };
        var entry = found && found.entry;
        if (!entry || !entry.segments || !entry.segments.length) {
          toolsShowErr('Нет транскрипта для «' + seqName + '» — сначала транскрибируйте In–Out (вкладка «Чат»).');
          return;
        }
        var settings = ContextStore.getResolvedSettings();
        var fmt = (document.getElementById('rl-format') || {}).value || '9x16';
        var targetW = 1080;
        var targetH = fmt === '1x1' ? 1080 : 1920;
        var textColor = (document.getElementById('rl-text-color') || {}).value || '#FFFFFF';
        var hlColor = (document.getElementById('rl-hl-color') || {}).value || '#21A038';

        /* Сборка ffmpeg должна содержать фильтр ass (libass) — только при анимации. */
        if (anim !== 'none') {
          var filtersOut = await new Promise(function (resolve) {
            require('child_process').execFile(ffBin, ['-hide_banner', '-filters'],
              { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
              function (err, stdout) { resolve(String(stdout || '')); });
          });
          if (filtersOut.indexOf(' ass ') === -1) {
            toolsShowErr('Сборка ffmpeg без libass (нет фильтра ass) — субтитры не отрендерить. Установите полную сборку (например, gyan.dev full).');
            return;
          }
        }

        /* 1. Источники рефрейма + размеры (nest — от host, файлы — ffprobe). */
        toolsStatusUi.show('Рилс: читаю видеоклипы секвенции…', true);
        var src = await new Promise(function (resolve, reject) {
          PremiereBridge.getVerticalReframeSources(function (err, data) {
            if (err) reject(err); else resolve(data);
          });
        });
        if (!src || !src.ok) {
          toolsShowErr((src && src.error) || 'Не удалось перечислить видеоклипы.');
          return;
        }
        if (String(src.sequenceName || '') !== seqName) {
          toolsShowErr('Активная секвенция сменилась («' + src.sequenceName + '» вместо «' + seqName + '») — повторите.');
          return;
        }
        var dims = {};
        var nd = src.nestDims || {};
        for (var nk in nd) {
          if (nd[nk] && nd[nk].width > 0 && nd[nk].height > 0) dims[nk] = nd[nk];
        }
        var pathSet = {};
        for (var ci = 0; ci < src.clips.length; ci++) {
          var mp = src.clips[ci].mediaPath || '';
          if (mp && mp.indexOf('nest:') !== 0) pathSet[mp] = 1;
        }
        var paths = Object.keys(pathSet);
        var doneCount = 0;
        var showProbeStatus = function () {
          toolsStatusUi.show('Рилс: размеры исходников ' + doneCount + ' из ' + paths.length + '…', true);
        };
        if (paths.length) showProbeStatus();
        await Promise.all(paths.map(function (p) {
          return AudioPreprocess.probeVideoDimensions(p).then(function (d) {
            doneCount++;
            showProbeStatus();
            if (d) dims[p] = d; /* null → планировщик пропустит клип с причиной */
          });
        }));

        /* 2. Смещения: ручные > vision > центр. Vision — кадр из середины
           каждого уникального источника, {"cx":0..1} → offsetPct. */
        var offsetsEl = document.getElementById('rl-offsets');
        var manual = DeterministicPipelines.parseVerticalOffsets(offsetsEl ? offsetsEl.value : '') || [];
        var vp = ReelsPipeline.visionPlan(src.clips);
        for (var vs = 0; vs < vp.skipped.length; vs++) {
          notes.push(vp.skipped[vs].name + ': ' + vp.skipped[vs].reason);
        }
        var visionOffsets = [];
        var visionModel = settings.visionModel || 'MiniMaxAI/MiniMax-M3';
        for (var vi = 0; vi < vp.paths.length; vi++) {
          var vPath = vp.paths[vi];
          var vBase = vPath.substring(Math.max(vPath.lastIndexOf('/'), vPath.lastIndexOf('\\')) + 1);
          /* Имена клипов этого источника; покрытые ручным смещением — пропуск. */
          var clipNames = [];
          for (var cn = 0; cn < src.clips.length; cn++) {
            if (src.clips[cn].mediaPath === vPath && clipNames.indexOf(src.clips[cn].name) === -1) {
              clipNames.push(src.clips[cn].name);
            }
          }
          var uncovered = clipNames.filter(function (nm2) {
            var low = String(nm2).toLowerCase();
            return !manual.some(function (o) { return low.indexOf(o.match) !== -1; });
          });
          if (!uncovered.length) {
            notes.push(vBase + ': ручное смещение (vision пропущен)');
            continue;
          }
          if (!settings.apiKey) {
            notes.push(vBase + ': нет API-ключа — vision пропущен, центр');
            continue;
          }
          toolsStatusUi.show('Рилс: vision-кадрирование ' + (vi + 1) + ' из ' + vp.paths.length + ' (' + vBase + ')…', true);
          try {
            var vDur = await AudioPreprocess.probeDurationSec(vPath);
            var vSec = (vDur && vDur > 0) ? vDur / 2 : 1;
            var vFrame = await AudioPreprocess.extractFrameJpeg(vPath, vSec, { maxWidth: 768 });
            var vResp = await CloudRuClient.chatCompletions({
              baseUrl: settings.baseUrl,
              apiKey: settings.apiKey,
              model: visionModel,
              temperature: 0,
              enableThinking: false,
              /* БЕЗ responseFormat: json_object — MiniMax-M3 на Cloud.ru с ним
               * возвращает ПУСТОЙ content (finish=stop), A/B-проверено live
               * 17.07.2026. Без него модель отвечает честным JSON. */
              chatParams: { max_tokens: 256 },
              messages: [{
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Найди главного человека (лицо) в кадре. Ответ строго JSON: {"cx": <число 0..1 — горизонтальный центр лица, 0 = левый край кадра, 1 = правый>}. Если людей нет: {"cx": 0.5}.'
                  },
                  { type: 'image_url', image_url: { url: vFrame } }
                ]
              }]
            });
            var vContent = (vResp && vResp.choices && vResp.choices[0] && vResp.choices[0].message)
              ? String(vResp.choices[0].message.content || '') : '';
            /* Модель может обернуть JSON в текст/маркдаун — берём первый {...} */
            var vJsonM = vContent.match(/\{[\s\S]*?\}/);
            if (!vJsonM) throw new Error('нет JSON в ответе vision: ' + vContent.slice(0, 120));
            var vCx = JSON.parse(vJsonM[0]).cx;
            var vPct = ReelsPipeline.offsetPctFromCx(vCx);
            if (vPct === null) throw new Error('невалидный cx: ' + vCx);
            for (var un = 0; un < uncovered.length; un++) {
              visionOffsets.push({ match: String(uncovered[un]).toLowerCase(), offsetPct: vPct });
            }
            notes.push(vBase + ': vision ' + (vPct > 0 ? '+' : '') + vPct + '%');
          } catch (eV) {
            notes.push(vBase + ': vision не сработал (' + String((eV && eV.message) || eV) + ') — центр');
          }
        }
        /* manual раньше в массиве → substring-матч планировщика найдёт его первым */
        var offsets = manual.concat(visionOffsets);

        /* 3. Рефрейм: clone → setSettings → Motion. */
        var plan = DeterministicPipelines.planVerticalReframe(src.clips, dims, {
          targetW: targetW,
          targetH: targetH,
          offsets: offsets.length ? offsets : null
        });
        if (!plan.items.length) {
          toolsShowErr('Не удалось спланировать ни один клип' +
            (plan.skipped.length ? ' (' + plan.skipped[0].name + ': ' + plan.skipped[0].reason + ')' : '') + '.');
          return;
        }
        var newName = seqName + ' — Рилс ' + (fmt === '1x1' ? '1x1' : '9x16');
        toolsStatusUi.show('Рилс: создаю секвенцию ' + targetW + '×' + targetH + ' (' + plan.items.length + ' клипов)…', true);
        var applied = await new Promise(function (resolve, reject) {
          PremiereBridge.applyVerticalReframe({
            expectedSequenceName: seqName,
            newName: newName,
            targetW: targetW,
            targetH: targetH,
            items: plan.items
          }, function (err, data) {
            if (err) reject(err); else resolve(data);
          });
        });
        if (!applied || !applied.ok) {
          toolsShowErr((applied && applied.error) || 'Не удалось создать секвенцию рилса.');
          return;
        }

        /* 4. Караоке-кьюи. */
        var cues = ReelsPipeline.buildKaraokeCues(entry.segments, {
          silences: (entry.audioAnalysis && entry.audioAnalysis.silences && entry.audioAnalysis.silences.length)
            ? entry.audioAnalysis.silences : null
        });
        if (!cues.length) {
          toolsShowErr('Секвенция «' + applied.sequenceName + '» создана, но из транскрипта не получилось ни одного титра (пустые сегменты?).');
          return;
        }

        /* 5. LLM-корректура (фейл — не фатален) + правило точек. */
        var proofApplied = 0, proofRejected = 0, proofOk = false;
        try {
          var pr = await reelsProofread(cues, settings, function (done, total) {
            toolsStatusUi.show('Рилс: корректура субтитров ' + done + ' из ' + total + '…', true);
          });
          cues = pr.cues;
          proofApplied = pr.applied;
          proofRejected = pr.rejected;
          proofOk = true;
        } catch (ePr) {
          notes.push('Корректура LLM не сработала (' + String((ePr && ePr.message) || ePr) + ') — титры без правок');
        }
        cues = cues.map(function (c) {
          var t2 = ReelsPipeline.stripCueFinalPeriod(c.text);
          if (t2 === c.text) return c;
          var w2 = c.words.slice();
          if (w2.length) {
            var lw = w2[w2.length - 1];
            w2[w2.length - 1] = { w: ReelsPipeline.stripCueFinalPeriod(lw.w), s: lw.s, e: lw.e };
          }
          return { startSec: c.startSec, endSec: c.endSec, text: t2, words: w2 };
        });

        /* 6. Файлы: SRT всегда; ASS+оверлей — только при анимации. */
        var fps = Number(snap.fps) > 0 ? Number(snap.fps) : 25;
        var durationSec = Math.ceil((cues[cues.length - 1].endSec + 0.5) * 100) / 100;
        var dir = path.join(os.homedir(), '.extensions_llm_chat_pr', 'reels');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        var safeName = seqName.replace(/[\\\/:*?"<>|]/g, '_');
        var srtPath = path.join(dir, safeName + '_' + ts + '.srt');
        fs.writeFileSync(srtPath, ReelsPipeline.buildSrt(cues), 'utf8');
        var assPath = null, outPath = null, ins = null, actErr = '';
        if (anim !== 'none') {
          var ass = ReelsPipeline.buildAss(cues, {
            w: targetW, h: targetH,
            fontName: fontName,
            textColor: textColor,
            hlColor: hlColor,
            anim: anim
          });
          assPath = path.join(dir, safeName + '_' + ts + '.ass');
          outPath = path.join(dir, safeName + '_' + ts + '.mov');
          fs.writeFileSync(assPath, ass, 'utf8'); /* UTF-8 БЕЗ BOM — libass */
          toolsStatusUi.show('Рилс: рендерю субтитры (' + cues.length + ' титров, ~' + Math.round(durationSec) + 'с)…', true);
          await reelsRunFfmpeg(ffBin, ReelsPipeline.buildOverlayFfmpegArgs({
            assPath: assPath, w: targetW, h: targetH, fps: fps,
            durationSec: durationSec, outPath: outPath
          }));
          if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 4096) {
            toolsShowErr('Секвенция «' + applied.sequenceName + '» создана, но ffmpeg отрендерил пустой оверлей: ' + outPath);
            return;
          }
          /* 7a. Оверлей на новую верхнюю дорожку (активирует рилс-секвенцию). */
          toolsStatusUi.show('Рилс: вставляю оверлей в «' + applied.sequenceName + '»…', true);
          ins = await new Promise(function (resolve, reject) {
            PremiereBridge.importAndOverlayOnTop({
              filePath: outPath.replace(/\\/g, '/'),
              expectedSequenceName: applied.sequenceName
            }, function (err, data) {
              if (err) reject(err); else resolve(data);
            });
          });
          if (!ins || !ins.ok) {
            toolsShowErr('Секвенция «' + applied.sequenceName + '» создана, но оверлей не вставлен: ' +
              ((ins && ins.error) || 'нет ответа хоста') + '\nФайл оверлея: ' + outPath);
            return;
          }
        } else {
          /* Анимация «нет»: рендера не будет — активируем рилс-секвенцию
             для captions явно (обычно её активирует importAndOverlayOnTop). */
          try {
            await reelsActivateSequence(applied.sequenceName);
          } catch (eAct) {
            actErr = String((eAct && eAct.message) || eAct);
            notes.push('Секвенция «' + applied.sequenceName + '» создана, но не активировалась (' + actErr + ') — captions не импортированы, SRT: ' + srtPath);
          }
        }

        /* 7b. Caption-дорожка — всегда (нативно редактируемый слой). */
        var capOk = false, capErr = '';
        if (!actErr) {
          toolsStatusUi.show('Рилс: импортирую captions в «' + applied.sequenceName + '»…', true);
          try {
            var cap = await new Promise(function (resolve, reject) {
              PremiereBridge.importSrtAsCaptions({
                srtPath: srtPath.replace(/\\/g, '/'),
                expectedSequenceName: applied.sequenceName
              }, function (err, data) {
                if (err) reject(err); else resolve(data);
              });
            });
            capOk = !!(cap && cap.ok);
            if (!capOk) capErr = (cap && cap.error) || 'нет ответа хоста';
          } catch (eCap) { capErr = String((eCap && eCap.message) || eCap); }
          if (!capOk) notes.push('Caption-дорожка не создана (' + capErr + ') — титры только в ' + (anim !== 'none' ? 'оверлее' : 'SRT: ' + srtPath));
        }

        /* 7c. Персист кью — источник правды для модалки «Править титры». */
        try {
          ContextStore.setTranscriptEntry(REELS_PID, applied.sequenceName, {
            cues: cues,
            settings: { format: fmt, anim: anim, fontName: fontName, textColor: textColor, hlColor: hlColor, fps: fps, w: targetW, h: targetH },
            paths: { srt: srtPath, ass: assPath, mov: outPath },
            silences: (entry.audioAnalysis && entry.audioAnalysis.silences) || null,
            sourceSequenceName: seqName,
            reelsSequenceName: applied.sequenceName,
            createdAt: Date.now()
          });
        } catch (eSt) { notes.push('Кью не сохранены для редактора (' + String((eSt && eSt.message) || eSt) + ')'); }

        /* 8. Отчёт. */
        var animLabel = anim === 'box' ? 'плашка под словом' : (anim === 'none' ? 'без анимации' : 'цвет слова');
        var lines = [
          'Создана секвенция «' + applied.sequenceName + '» (' + targetW + '×' + targetH + ').',
          'Отрефреймлено ' + applied.applied + ' из ' + plan.total + ' клипов.',
          anim !== 'none'
            ? ('Субтитры: ' + cues.length + ' титров, ' + animLabel + ', шрифт ' + fontName + ' — оверлей на V' + (ins.trackIndex + 1) + (capOk ? ' + caption-дорожка' : '') + '.')
            : (capOk
              ? ('Субтитры: ' + cues.length + ' титров — caption-дорожка (редактируемая, без анимации).')
              : ('Субтитры: ' + cues.length + ' титров — caption-дорожка НЕ создана, титры в SRT: ' + srtPath)),
          proofOk
            ? ('Корректура LLM: ' + proofApplied + ' правок' + (proofRejected ? ' (' + proofRejected + ' отклонено guard-ом)' : '') + '.')
            : 'Корректура LLM: пропущена.'
        ];
        if (anim !== 'none' && capOk) {
          lines.push('Внимание: включённый CC в мониторе задвоит текст — выключите CC или удалите caption-дорожку.');
        }
        for (var sk = 0; sk < plan.skipped.length && sk < 5; sk++) {
          lines.push('Пропущен ' + plan.skipped[sk].name + ': ' + plan.skipped[sk].reason);
        }
        var fl = applied.failed || [];
        for (var fi = 0; fi < fl.length; fi++) lines.push('Не применён ' + fl[fi]);
        var nm = src.noMedia || [];
        if (nm.length) lines.push('Без медиа (не тронуты): ' + nm.slice(0, 5).join(', ') + (nm.length > 5 ? '…' : ''));
        for (var nt = 0; nt < notes.length; nt++) lines.push(notes[nt]);
        if (resEl) {
          resEl.style.whiteSpace = 'pre-line';
          resEl.textContent = lines.join('\n');
        }
        toolsSetCardStatus('card-reels', seqName,
          'Создана «' + applied.sequenceName + '»: ' + applied.applied + ' клипов, ' + cues.length + ' титров', 'ok');
        toolsStatusUi.show('Рилс готов ✓', false);
        keepStatus = true;
        setTimeout(function () { toolsStatusUi.hide(); }, 4000);
      } catch (e) {
        toolsShowErr(String(e.message || e));
      } finally {
        endOperation();
        toolsDisableRun(false);
        if (!keepStatus) toolsStatusUi.hide();
      }
    }

    /* ═══ Рилс v2: модалка «Править титры» ═══
       Кью из ContextStore (REELS_PID, ключ = имя рилс-секвенции) — источник
       правды. Правка текста: rebuildCueText (без LLM-guard — монтажёр
       авторитетен), границы кью не двигаются, сохранение сразу.
       «Обновить captions»: новый .srt → новая caption-дорожка (старую
       удалить вручную — API удаления в ExtendScript нет).
       «Перерендерить караоке»: ASS → ffmpeg → replaceTopOverlay (замена
       на той же дорожке, число дорожек не растёт). */
    var _reelsEditEntry = null;

    function reelsFindSavedEntry(seqName) {
      /* Активная секвенция — сама рилс-секвенция или её исходник. */
      var cands = [seqName, seqName + ' — Рилс 9x16', seqName + ' — Рилс 1x1'];
      for (var i = 0; i < cands.length; i++) {
        var e = ContextStore.getTranscriptEntry(REELS_PID, cands[i]);
        if (e && e.cues && e.cues.length) return e;
      }
      return null;
    }

    function reelsEditStatus(msg) {
      var el = document.getElementById('re-modal-status');
      if (el) el.textContent = msg || '';
    }

    function reelsSaveEditEntry(e) {
      var entry = e || _reelsEditEntry;
      if (!entry) return false;
      return ContextStore.setTranscriptEntry(REELS_PID, entry.reelsSequenceName, entry);
    }

    function reelsRenderEditBody() {
      var body = document.getElementById('re-modal-body');
      if (!body || !_reelsEditEntry) return;
      body.textContent = '';
      var cues = _reelsEditEntry.cues;
      for (var i = 0; i < cues.length; i++) {
        (function (idx) {
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:flex-start;';
          var tc = document.createElement('span');
          tc.style.cssText = 'color:var(--muted);font-size:11px;white-space:nowrap;padding-top:4px;min-width:88px;';
          tc.textContent = cues[idx].startSec.toFixed(1) + '–' + cues[idx].endSec.toFixed(1) + 'с';
          var ta = document.createElement('textarea');
          ta.style.cssText = 'flex:1;min-height:34px;resize:vertical;font-size:12px;';
          ta.value = cues[idx].text;
          ta.addEventListener('change', function () {
            var upd = ReelsPipeline.rebuildCueText(cues[idx], ta.value, {
              silences: _reelsEditEntry.silences || null
            });
            if (!upd) { ta.value = cues[idx].text; reelsEditStatus('Пустой титр — правка отменена'); return; }
            cues[idx] = upd;
            ta.value = upd.text;
            var saved = reelsSaveEditEntry();
            if (saved === false) {
              reelsEditStatus('Не удалось сохранить титры — правка не persisted (проверьте место на диске).');
            } else {
              reelsEditStatus('Сохранено. Обновите captions/караоке, чтобы применить в Premiere.');
            }
          });
          row.appendChild(tc);
          row.appendChild(ta);
          body.appendChild(row);
        })(i);
      }
    }

    function reelsOpenEditModal() {
      toolsShowErr('');
      PremiereBridge.getSequenceRegionInfo(function (err, info) {
        if (err || !info || !info.ok) {
          toolsShowErr('Не удалось определить активную секвенцию: ' + String((err && err.message) || err || 'нет ответа от моста'));
          return;
        }
        var seqName = String(info.sequenceName || '');
        var entry = seqName ? reelsFindSavedEntry(seqName) : null;
        if (!entry) {
          toolsShowErr('Нет сохранённых титров рилса для «' + (seqName || '?') + '». Сначала соберите рилс.');
          return;
        }
        _reelsEditEntry = entry;
        var ov = document.getElementById('reels-edit-modal');
        var meta = document.getElementById('re-modal-meta');
        var rerenderBtn = document.getElementById('re-rerender-karaoke');
        if (meta) meta.textContent = entry.reelsSequenceName + ' · ' + entry.cues.length + ' титров · ' + (entry.settings.anim === 'none' ? 'без анимации' : entry.settings.anim === 'box' ? 'плашка' : 'цвет слова');
        if (rerenderBtn) rerenderBtn.hidden = entry.settings.anim === 'none';
        reelsEditStatus('');
        reelsRenderEditBody();
        if (ov) ov.hidden = false;
      });
    }

    async function reelsUpdateCaptions() {
      if (!_reelsEditEntry) return;
      if (!beginOperation('tools:reels-captions')) { reelsEditStatus('Идёт другая операция — подождите.'); return; }
      var entry = _reelsEditEntry; /* snapshot — защита от race при долгом рендере */
      try {
        reelsEditStatus('Обновляю captions…');
        var fs = require('fs');
        var path = require('path');
        var os = require('os');
        var dir = path.join(os.homedir(), '.extensions_llm_chat_pr', 'reels');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        var safeName = entry.reelsSequenceName.replace(/[\\\/:*?"<>|]/g, '_');
        var srtPath = path.join(dir, safeName + '_' + ts + '.srt');
        fs.writeFileSync(srtPath, ReelsPipeline.buildSrt(entry.cues), 'utf8');
        await reelsActivateSequence(entry.reelsSequenceName);
        var cap = await new Promise(function (resolve, reject) {
          PremiereBridge.importSrtAsCaptions({
            srtPath: srtPath.replace(/\\/g, '/'),
            expectedSequenceName: entry.reelsSequenceName
          }, function (err, data) { if (err) reject(err); else resolve(data); });
        });
        if (!cap || !cap.ok) throw new Error((cap && cap.error) || 'importSrtAsCaptions: нет ответа');
        entry.paths.srt = srtPath;
        reelsSaveEditEntry(entry);
        reelsEditStatus('Captions обновлены (новая дорожка). Старую caption-дорожку удалите вручную — API удаления нет.');
      } catch (e) {
        reelsEditStatus('Ошибка captions: ' + String((e && e.message) || e));
      } finally {
        endOperation();
      }
    }

    async function reelsRerenderKaraoke() {
      if (!_reelsEditEntry) return;
      if (_reelsEditEntry.settings.anim === 'none') return;
      if (!beginOperation('tools:reels-rerender')) { reelsEditStatus('Идёт другая операция — подождите.'); return; }
      var entry = _reelsEditEntry; /* snapshot — защита от race при долгом ffmpeg-рендере */
      try {
        var st = entry.settings;
        var ffBin = AudioPreprocess.findFfmpegPath();
        if (!ffBin) throw new Error('ffmpeg не найден');
        var fs = require('fs');
        var path = require('path');
        var os = require('os');
        var dir = path.join(os.homedir(), '.extensions_llm_chat_pr', 'reels');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        var safeName = entry.reelsSequenceName.replace(/[\\\/:*?"<>|]/g, '_');
        var cues = entry.cues;
        var ass = ReelsPipeline.buildAss(cues, {
          w: st.w, h: st.h, fontName: st.fontName,
          textColor: st.textColor, hlColor: st.hlColor, anim: st.anim
        });
        var assPath = path.join(dir, safeName + '_' + ts + '.ass');
        var outPath = path.join(dir, safeName + '_' + ts + '.mov');
        fs.writeFileSync(assPath, ass, 'utf8');
        var durationSec = Math.ceil((cues[cues.length - 1].endSec + 0.5) * 100) / 100;
        reelsEditStatus('Рендерю караоке (~' + Math.round(durationSec) + 'с видео)…');
        await reelsRunFfmpeg(ffBin, ReelsPipeline.buildOverlayFfmpegArgs({
          assPath: assPath, w: st.w, h: st.h, fps: st.fps,
          durationSec: durationSec, outPath: outPath
        }));
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 4096) {
          throw new Error('ffmpeg отрендерил пустой файл: ' + outPath);
        }
        reelsEditStatus('Заменяю оверлей на таймлайне…');
        var ins = await new Promise(function (resolve, reject) {
          PremiereBridge.importAndOverlayOnTop({
            filePath: outPath.replace(/\\/g, '/'),
            expectedSequenceName: entry.reelsSequenceName,
            replaceTopOverlay: true
          }, function (err, data) { if (err) reject(err); else resolve(data); });
        });
        if (!ins || !ins.ok) throw new Error((ins && ins.error) || 'importAndOverlayOnTop: нет ответа');
        entry.paths.ass = assPath;
        entry.paths.mov = outPath;
        reelsSaveEditEntry(entry);
        reelsEditStatus('Караоке перерендерено — оверлей заменён на V' + (ins.trackIndex + 1) + '.');
      } catch (e) {
        reelsEditStatus('Ошибка перерендера: ' + String((e && e.message) || e));
      } finally {
        endOperation();
      }
    }

    (function wireReelsEditModal() {
      var openBtn = document.getElementById('rl-edit-cues');
      var closeBtn = document.getElementById('re-modal-close');
      var ov = document.getElementById('reels-edit-modal');
      var capBtn = document.getElementById('re-update-captions');
      var rrBtn = document.getElementById('re-rerender-karaoke');
      if (openBtn) openBtn.addEventListener('click', reelsOpenEditModal);
      if (closeBtn) closeBtn.addEventListener('click', function () { if (ov) ov.hidden = true; });
      if (ov) ov.addEventListener('click', function (ev) { if (ev.target === ov) ov.hidden = true; });
      if (capBtn) capBtn.addEventListener('click', reelsUpdateCaptions);
      if (rrBtn) rrBtn.addEventListener('click', reelsRerenderKaraoke);
      if (!window.__omcReelsEditEscInstalled) {
        window.__omcReelsEditEscInstalled = true;
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            var reelsOv = document.getElementById('reels-edit-modal');
            if (reelsOv && !reelsOv.hidden) reelsOv.hidden = true;
          }
        });
      }
    })();

    /* ── Run tool ─────────────────────────────────────────── */
    async function toolsRunTool(toolName) {
      toolsShowErr('');
      toolsHideAllProposals();

      /* «🗣 Спикеры» — не proposal-пайплайн (ничего не режет): своя ветка
         с записью меток прямо в кэш транскрипта. */
      if (toolName === 'speakers') { await toolsRunDiarize(); return; }

      /* «🎬 Рилс» — тоже не proposal: исходник не трогается, результат —
         новая секвенция с оверлеем субтитров (откат = удалить её). */
      if (toolName === 'reels') { await toolsRunReels(); return; }

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
          /* Анти-дребезг: окно сглаживания (кадры) + порог кросс-тока (сек) */
          var mcSmoothEl = document.getElementById('mc-smooth');
          if (mcSmoothEl) params.smoothingWindow = parseInt(mcSmoothEl.value, 10);
          var mcOverlapEl = document.getElementById('mc-overlap');
          if (mcOverlapEl) params.overlapWideMinSec = parseFloat(mcOverlapEl.value);
          /* Tier 1 (11.07.2026): длина wide-вставки, шаг анализа, вариант разброса */
          var mcMaxAllEl = document.getElementById('mc-maxall');
          if (mcMaxAllEl) params.maxAllSpeakersSec = parseFloat(mcMaxAllEl.value);
          var mcFrameSecEl = document.getElementById('mc-framesec');
          if (mcFrameSecEl) params.frameSec = parseFloat(mcFrameSecEl.value);
          var mcSeedEl = document.getElementById('mc-seed');
          if (mcSeedEl) params.variationsSeed = parseInt(mcSeedEl.value, 10);
          /* Оживлённые тумблеры: держать последнего спикера на паузах/перебивках */
          var mcWideSilenceEl = document.getElementById('mc-wide-silence');
          if (mcWideSilenceEl) params.wideOnSilence = mcWideSilenceEl.checked;
          var mcWideOverlapEl = document.getElementById('mc-wide-overlap');
          if (mcWideOverlapEl) params.wideOnOverlap = mcWideOverlapEl.checked;
          /* Tier 3: привязка резов к паузам/onset + сдвиг */
          var mcSnapEl = document.getElementById('mc-snap');
          if (mcSnapEl) params.snapWindowSec = parseFloat(mcSnapEl.value);
          var mcSnapOffEl = document.getElementById('mc-snapoff');
          if (mcSnapOffEl) params.frameOffsetSec = parseFloat(mcSnapOffEl.value);
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
            /* 11.07.2026 (live-провал на 6_SYNCED): раньше брали ПЕРВЫЙ клип
               дорожки и RMS всего файла (remapRmsToSequenceTime по одному клипу).
               Это ломалось на порезанном таймлайне (177 клипов после чисток) и
               на BRAW-головах в начале mic-дорожек. Теперь паттерн диаризации:
               ВСЕ клипы дорожки → части {mediaPath, srcStartSec, outer*}, RMS
               на файл один раз, micPartsToTimeline собирает sequence-time. */
            var mics = [];
            for (var si = 0; si < mapping.speakers.length; si++) {
              var aIdx = mapping.speakers[si].audioTrack;
              var parts = [];
              for (var ci = 0; ci < allClips.length; ci++) {
                var c = allClips[ci];
                if (c.trackType === 'audio' && c.trackIndex === aIdx && c.mediaPath) {
                  parts.push({
                    mediaPath: c.mediaPath,
                    srcStartSec: typeof c.inPointSec === 'number' ? c.inPointSec : 0,
                    outerStartSec: c.startSec,
                    outerEndSec: c.endSec
                  });
                }
              }
              if (!parts.length) {
                throw new Error('Аудиодорожка A' + (aIdx + 1) + ': нет клипов с файлом на диске. Настройте соответствие дорожек вручную (⚙ выбор дорожек).');
              }
              mics.push({ aIdx: aIdx, parts: parts });
            }
            /* RMS на ФАЙЛ один раз (разрезанный таймлайн = много частей одного
               файла); недекодируемые (BRAW-головы) = тишина + варнинг, не падение. */
            var pathSet = {};
            for (var mi = 0; mi < mics.length; mi++) {
              for (var pj = 0; pj < mics[mi].parts.length; pj++) pathSet[mics[mi].parts[pj].mediaPath] = 1;
            }
            var paths = Object.keys(pathSet);
            var doneCount = 0;
            var showMicStatus = function () {
              toolsStatusUi.show('Анализ аудио: готово ' + doneCount + ' из ' + paths.length + ' файлов…', true);
            };
            showMicStatus();
            var rmsByPath = {};
            var rmsFailed = [];
            await Promise.all(paths.map(function (pth) {
              return AudioPreprocess.computeRmsTimeline(pth, { windowSec: windowSec })
                .then(function (tl) {
                  doneCount++; showMicStatus();
                  rmsByPath[pth] = tl;
                }, function (e) {
                  doneCount++; showMicStatus();
                  rmsFailed.push(String(pth).split(/[\\\/]/).pop() + ': ' + String((e && e.message) || e));
                });
            }));
            if (!Object.keys(rmsByPath).length) {
              throw new Error('Ни один аудиофайл не декодируется ffmpeg:\n' + rmsFailed.join('\n'));
            }
            var timelines = mics.map(function (m) {
              return DeterministicPipelines.micPartsToTimeline(m.parts, rmsByPath);
            });
            /* B1-7: mediaPaths для pre-flight детекта общего файла — доминирующий
               (по покрытой длительности) декодируемый путь каждой дорожки. */
            var mediaPaths = mics.map(function (m) {
              var durByPath = {};
              for (var di = 0; di < m.parts.length; di++) {
                var pt = m.parts[di];
                durByPath[pt.mediaPath] = (durByPath[pt.mediaPath] || 0) + (pt.outerEndSec - pt.outerStartSec);
              }
              var best = '', bestDur = -1;
              for (var k in durByPath) {
                if (durByPath.hasOwnProperty(k) && rmsByPath[k] && durByPath[k] > bestDur) {
                  best = k; bestDur = durByPath[k];
                }
              }
              return best;
            });
            var extraWarnings = [];
            if (rmsFailed.length) {
              extraWarnings.push('⚠ Не декодируются (учтены как тишина): ' + rmsFailed.length + ' файл(а) — ' +
                rmsFailed.map(function (s) { return s.split(':')[0]; }).join(', '));
            }
            return { timelines: timelines, mediaPaths: mediaPaths, warnings: extraWarnings };
          }
        };

        var result = await pipelineFn(ctx, params);

        if (!result.ok) {
          toolsShowErr(result.error || 'Ошибка.');
          /* Статус-UX 11.07.2026: ошибка остаётся на карточке (toast/общий
             блок ошибок перетирается следующим действием — «ошибка мелькнула
             и исчезла», live-находка на мультикаме). */
          toolsSetCardStatus('card-' + toolName, seqKey,
            'Ошибка: ' + String(result.error || 'неизвестная').slice(0, 140), 'err');
        } else if (result.noChanges) {
          toolsStatusUi.show(result.summary || 'Изменений нет.', false);
          toolsSetCardStatus('card-' + toolName, seqKey, result.summary || 'Изменений нет.', 'info');
          keepStatus = true;
          setTimeout(function () { toolsStatusUi.hide(); }, 4000);
        } else if (result.proposal) {
          /* 19.06.2026 БЕЗОПАСНОСТЬ: привязываем proposal к секвенции, на которой
             он построен. Без snapshot assertSequenceMatch (на Apply) пропускал
             guard → правки могли уйти в ДРУГУЮ секвенцию, если пользователь
             переключился между proposal и Apply. Теперь Apply сверит имя. */
          result.proposal.snapshot = snap;
          result.proposal.seqKey = seqKey;
          result.proposal.cardId = 'card-' + toolName; /* статус применения → на карточку */
          toolsShowProposal(proposalId, result.proposal);
          toolsStatusUi.hide();
        }
      } catch (e) {
        toolsShowErr(String(e.message || e));
        try {
          /* seqKey объявлен var'ом в try — при раннем падении он undefined */
          toolsSetCardStatus('card-' + toolName, seqKey || (lastSnap && lastSnap.sequenceName) || '',
            'Ошибка: ' + String(e.message || e).slice(0, 140), 'err');
        } catch (e2) {}
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
