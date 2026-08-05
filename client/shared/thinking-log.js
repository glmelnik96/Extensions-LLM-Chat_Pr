/**
 * Журнал «хода мыслей» агента (5 августа 2026).
 *
 * Задача: при долгом шаге (GLM-5.1 с thinking молчит 30-45с) пользователь видел
 * только «модель думает… 37с» и не понимал, работа идёт или панель зависла.
 * Модуль превращает поток событий runAgentLoop.onStatus в две вещи:
 *   1) ленту шагов — запрос к модели, вызовы инструментов с длительностью,
 *      фолбэки моделей;
 *   2) накопленный текст размышлений модели (reasoning_content из стрима).
 *
 * Чистая структура данных без DOM — рендерит панель, тестируется в Node.
 */
(function (global) {
  var DEFAULT_MAX_ENTRIES = 200;
  var DEFAULT_MAX_REASONING = 40000;

  /** Человеческая длительность: 340мс / 1.4с / 2м 05с. */
  function fmtMs(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return Math.round(ms) + 'мс';
    if (ms < 60000) return String(Math.round(ms / 100) / 10) + 'с';
    var m = Math.floor(ms / 60000);
    var s = Math.round((ms - m * 60000) / 1000);
    if (s === 60) { m += 1; s = 0; }
    return m + 'м ' + (s < 10 ? '0' : '') + s + 'с';
  }

  /** 'zai-org/GLM-4.7' → 'GLM-4.7' (в ленте важна модель, не вендор). */
  function shortModel(id) {
    if (!id) return '';
    var s = String(id);
    var slash = s.lastIndexOf('/');
    return slash >= 0 ? s.slice(slash + 1) : s;
  }

  /**
   * Короткая сводка аргументов инструмента: 'edits: 12, dryRun: true'.
   * Планы правок бывают на десятки килобайт — в ленту их лить нельзя,
   * поэтому массивы схлопываем в длину, строки режем, объекты — в '{…}'.
   */
  function argsSummary(args, maxKeys) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
    var keys = Object.keys(args);
    if (!keys.length) return '';
    var lim = typeof maxKeys === 'number' && maxKeys > 0 ? maxKeys : 3;
    var parts = [];
    var meaningful = 0;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = args[k];
      if (v === null || v === undefined || v === '' || typeof v === 'function') continue;
      meaningful++;
      if (parts.length >= lim) continue;
      if (Array.isArray(v)) parts.push(k + ': ' + v.length);
      else if (typeof v === 'string') parts.push(k + ': ' + (v.length > 40 ? v.slice(0, 40) + '…' : v));
      else if (typeof v === 'object') parts.push(k + ': {…}');
      else parts.push(k + ': ' + v);
    }
    if (!parts.length) return '';
    var more = meaningful - parts.length;
    return parts.join(', ') + (more > 0 ? ', +' + more : '');
  }

  /** Значок строки ленты — чтобы взгляд цеплялся за тип события. */
  function markerFor(kind) {
    if (kind === 'step') return '→';
    if (kind === 'reasoning') return '💭';
    if (kind === 'tool') return '⚙';
    if (kind === 'answer') return '✍';
    if (kind === 'warn') return '⚠';
    if (kind === 'done') return '✓';
    return '·';
  }

  function createLog(opts) {
    opts = opts || {};
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var maxEntries = opts.maxEntries > 0 ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
    var maxReasoning = opts.maxReasoning > 0 ? opts.maxReasoning : DEFAULT_MAX_REASONING;

    var entries = [];
    /* Размышления накапливаются ПО ШАГАМ: accumulated в событии сбрасывается
       на каждом новом запросе к модели, склеивать их в одну строку нельзя. */
    var reasonParts = [];
    var reasonNoted = {};
    var pendingTools = {};
    var answerStep = null;
    var startedAt = 0;

    function add(kind, text, extra) {
      var e = { kind: kind, text: text, at: now() };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
        }
      }
      entries.push(e);
      if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
      return e;
    }

    function push(ev) {
      if (!ev || typeof ev !== 'object') return null;
      if (!startedAt) startedAt = now();
      var phase = ev.phase;

      if (phase === 'llm') {
        answerStep = null;
        return add('step', 'Шаг ' + ev.step + '/' + ev.maxSteps + ' · запрос к ' + shortModel(ev.model), {
          step: ev.step,
          model: ev.model
        });
      }

      if (phase === 'reasoning') {
        var acc = typeof ev.accumulated === 'string' ? ev.accumulated : '';
        var st = ev.step || 0;
        var last = reasonParts.length ? reasonParts[reasonParts.length - 1] : null;
        if (last && last.step === st) last.text = acc;
        else reasonParts.push({ step: st, text: acc });
        if (!reasonNoted[st]) {
          reasonNoted[st] = true;
          return add('reasoning', 'Шаг ' + st + ' · модель рассуждает…', { step: st });
        }
        return null;
      }

      if (phase === 'streaming') {
        /* Стрим-события летят каждые 150мс — в ленте нужна одна отметка на шаг. */
        if (answerStep === ev.step) return null;
        answerStep = ev.step;
        return add('answer', 'Шаг ' + ev.step + ' · пишет ответ…', { step: ev.step });
      }

      if (phase === 'tool') {
        var sum = argsSummary(ev.args);
        var te = add('tool', 'инструмент: ' + ev.name + (sum ? ' (' + sum + ')' : ''), {
          step: ev.step,
          name: ev.name,
          pending: true
        });
        pendingTools[ev.name] = te;
        return te;
      }

      if (phase === 'tool-done') {
        var pe = pendingTools[ev.name];
        if (pe) {
          delete pendingTools[ev.name];
          pe.pending = false;
          pe.ms = ev.ms;
          pe.ok = ev.ok !== false;
          return pe;
        }
        return add('tool', 'инструмент: ' + ev.name, { name: ev.name, ms: ev.ms, ok: ev.ok !== false });
      }

      if (phase === 'model-fallback') {
        return add('warn', ev.message || ('переключение на ' + shortModel(ev.model)), { model: ev.model });
      }

      if (ev.message) return add('info', ev.message);
      return null;
    }

    function finish(text) {
      var ms = startedAt ? now() - startedAt : 0;
      /* Незакрытые инструменты (прерывание, ошибка) — снимаем «крутилку»,
         иначе строка ленты навсегда останется в состоянии «выполняется». */
      for (var n in pendingTools) {
        if (Object.prototype.hasOwnProperty.call(pendingTools, n)) pendingTools[n].pending = false;
      }
      pendingTools = {};
      /* Длительность живёт только в ms — рендер сам её показывает. В текст её
         не клеим, иначе в строке дублируется: «Готово · 3.7с  3.7с». */
      return add('done', text || 'Готово', { ms: ms });
    }

    function reasoning() {
      var out = [];
      for (var i = 0; i < reasonParts.length; i++) {
        if (reasonParts[i].text) out.push(reasonParts[i].text);
      }
      var joined = out.join('\n\n');
      /* Режем начало, а не конец: свежая мысль важнее давно прочитанной. */
      if (joined.length > maxReasoning) joined = '…' + joined.slice(joined.length - maxReasoning);
      return joined;
    }

    function clear() {
      entries = [];
      reasonParts = [];
      reasonNoted = {};
      pendingTools = {};
      answerStep = null;
      startedAt = 0;
    }

    return {
      push: push,
      finish: finish,
      entries: function () { return entries.slice(); },
      reasoning: reasoning,
      hasReasoning: function () { return reasoning().length > 0; },
      isEmpty: function () { return entries.length === 0 && reasonParts.length === 0; },
      elapsedMs: function () { return startedAt ? now() - startedAt : 0; },
      clear: clear
    };
  }

  var api = {
    createLog: createLog,
    fmtMs: fmtMs,
    shortModel: shortModel,
    argsSummary: argsSummary,
    markerFor: markerFor
  };

  /* Только global: в CEP есть Node-интеграция, поэтому `module` определён и
     UMD-ветка увела бы экспорт мимо window (см. transcript-io.js). */
  global.ThinkingLog = api;
})(typeof window !== 'undefined' ? window : globalThis);
