/**
 * run-trace.js — трейс хода агента (ревью агентского контура, сентябрь 2026).
 *
 * Зачем: до этого ни один неудачный ход чата нигде не оставался — «агент
 * ошибается» нельзя было сузить до конкретной причины. Теперь каждый ход
 * (запрос → маршрут → модель → вызовы инструментов с ошибками валидации →
 * финал) складывается одной JSON-строкой в ~/.extensions_llm_chat_pr/traces/
 * <день>.jsonl, а кнопки 👍/👎 под ответом дописывают запись feedback с тем же
 * traceId. Через неделю это golden-set из НАСТОЯЩИХ формулировок пользователя.
 *
 * Модуль чистый (без fs/DOM): панель пишет файл сама. ES5.
 */
(function (global) {
  'use strict';

  function nowMs() { return Date.now(); }

  function newId() {
    return Date.now().toString(36) + '-' + Math.floor(Math.random() * 0x7fffffff).toString(36);
  }

  /* Компактное представление произвольных данных: планы правок бывают на
     десятки КБ, в трейс идёт срез (строки до 120 символов, массивы до 5
     элементов, объекты до 12 ключей). Глубина: args → ops[] → op{kind,startSec}
     видны, всё глубже схлопывается ('[n]' / '{…}'). */
  function compact(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return v.length > 120 ? v.slice(0, 120) + '…' : v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) {
      if (depth >= 2) return '[' + v.length + ']';
      var outA = [];
      for (var i = 0; i < v.length && i < 5; i++) outA.push(compact(v[i], depth + 1));
      if (v.length > 5) outA.push('…+' + (v.length - 5));
      return outA;
    }
    if (typeof v === 'object') {
      if (depth >= 3) return '{…}';
      var outO = {};
      var n = 0;
      for (var k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        if (typeof v[k] === 'function') continue;
        if (n++ >= 12) { outO['…'] = 'ещё поля'; break; }
        outO[k] = compact(v[k], depth + 1);
      }
      return outO;
    }
    return String(v);
  }

  /**
   * create(meta) → { id, event(kind, data), finish(status, extra), record() }
   * meta: { panelId, text, route ('llm'|'exact-interval'|'slash'|'pipeline-intent'),
   *         model, intents, complexity, stale, extra }
   */
  function create(meta) {
    meta = meta || {};
    var t0 = nowMs();
    var rec = {
      kind: 'turn',
      id: meta.id || newId(),
      at: new Date(t0).toISOString(),
      panelId: meta.panelId || null,
      text: String(meta.text || '').slice(0, 500),
      route: meta.route || 'llm',
      model: meta.model || null,
      intents: meta.intents || null,
      complexity: meta.complexity || null,
      stale: meta.stale || null,
      extra: meta.extra ? compact(meta.extra) : null,
      events: [],
      status: null,
      ms: 0
    };
    var MAX_EVENTS = 400;
    return {
      id: rec.id,
      event: function (kind, data) {
        var e = { t: nowMs() - t0, kind: kind };
        if (data && typeof data === 'object') {
          for (var k in data) {
            if (Object.prototype.hasOwnProperty.call(data, k) && k !== 'kind') e[k] = compact(data[k]);
          }
        }
        rec.events.push(e);
        if (rec.events.length > MAX_EVENTS) rec.events.splice(0, rec.events.length - MAX_EVENTS);
        return e;
      },
      finish: function (status, extra) {
        rec.status = status || 'done';
        rec.ms = nowMs() - t0;
        if (extra && typeof extra === 'object') {
          for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) rec[k] = compact(extra[k]);
          }
        }
        return rec;
      },
      record: function () { return rec; }
    };
  }

  /* Событие runAgentLoop.onStatus → событие трейса. Стрим и размышления —
     шум для трейса (их видно в «ходе мыслей»), пишем только вехи. */
  function fromStatusEvent(ev) {
    if (!ev || !ev.phase) return null;
    switch (ev.phase) {
      case 'llm':
        return { kind: 'llm', step: ev.step, model: ev.model || null, etaMs: ev.etaMs || null };
      case 'tool':
        return { kind: 'tool', step: ev.step, name: ev.name, args: ev.args ? compact(ev.args) : null };
      case 'tool-done':
        return { kind: 'tool-done', step: ev.step, name: ev.name, ok: ev.ok !== false, ms: ev.ms || null };
      case 'model-fallback':
        return { kind: 'fallback', step: ev.step, model: ev.model || null, message: ev.message || null };
      default:
        return null;
    }
  }

  function feedbackRecord(traceId, vote, note) {
    return {
      kind: 'feedback',
      at: new Date().toISOString(),
      traceId: traceId || null,
      vote: vote === 'good' ? 'good' : 'bad',
      note: String(note || '').slice(0, 300)
    };
  }

  global.RunTrace = {
    newId: newId,
    create: create,
    compact: compact,
    fromStatusEvent: fromStatusEvent,
    feedbackRecord: feedbackRecord
  };
})(typeof window !== 'undefined' ? window : globalThis);
