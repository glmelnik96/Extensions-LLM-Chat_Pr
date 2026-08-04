/**
 * Model health — доступность LLM-моделей аккаунта.
 *
 * Зачем: каталог Cloud.ru отдаёт десятки моделей, но часть из них закрыта
 * RBAC (403) или снята (404) — узнать об этом можно было только поймав
 * ошибку в середине длинной операции. Здесь статус собирается из двух
 * источников:
 *   • активная проба — микро-запрос по кнопке «Проверить»;
 *   • пассивные наблюдения — реальные ошибки и фолбэки во время работы.
 *
 * Статусы живут с TTL: доступность на стороне провайдера меняется, и
 * протухший «недоступна» хуже, чем честное «неизвестно».
 *
 * Чистая логика — никакого DOM и fetch, тестируется в node.
 */
(function (global) {
  var TTL_MS = 30 * 60 * 1000;      /* как ANALYSIS_CACHE_TTL — статус живёт полчаса */
  var STORAGE_KEY = 'omc_model_health_v1';

  var OK = 'ok';
  var UNAVAILABLE = 'unavailable';
  var UNKNOWN = 'unknown';

  /**
   * Ошибка запроса → статус модели.
   * Разделяем «модель недоступна» и «сломан запрос/ключ»: неверный ключ
   * валит все модели одинаково, и метить их красным бессмысленно.
   */
  function classifyError(err) {
    if (!err) return { state: OK, reason: '' };
    if (err.name === 'AbortError') return { state: UNKNOWN, reason: 'проверка прервана' };
    var s = (typeof err.httpStatus === 'number') ? err.httpStatus : 0;
    if (s === 403) return { state: UNAVAILABLE, reason: 'нет доступа (403 RBAC)' };
    if (s === 404) return { state: UNAVAILABLE, reason: 'модель снята (404)' };
    if (s >= 500) return { state: UNAVAILABLE, reason: 'сервер не отвечает (' + s + ')' };
    if (s === 429) return { state: UNKNOWN, reason: 'лимит запросов (429)' };
    if (s === 401 || s === 400 || s === 422) return { state: UNKNOWN, reason: 'проблема запроса или ключа (' + s + ')' };
    var m = String((err && err.message) || '');
    if (/Таймаут запроса/i.test(m)) return { state: UNAVAILABLE, reason: 'таймаут' };
    if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(m)) return { state: UNKNOWN, reason: 'сеть недоступна' };
    if (/HTTP\s*5\d\d/i.test(m)) return { state: UNAVAILABLE, reason: 'сервер не отвечает' };
    return { state: UNKNOWN, reason: m ? m.slice(0, 60) : 'неизвестная ошибка' };
  }

  /** Маркер перед названием модели в селекте. */
  function marker(state) {
    if (state === OK) return '✓';
    if (state === UNAVAILABLE) return '✗';
    return '·';
  }

  function ageText(ms) {
    if (!isFinite(ms) || ms < 0) return '';
    var min = Math.round(ms / 60000);
    if (min < 1) return 'только что';
    if (min < 60) return min + ' мин назад';
    return Math.round(min / 60) + ' ч назад';
  }

  /**
   * Хранилище статусов. storage — объект с getItem/setItem (localStorage
   * или заглушка), now — функция времени (для тестов).
   */
  function createStore(opts) {
    var o = opts || {};
    var storage = o.storage || null;
    var now = o.now || function () { return Date.now(); };
    var ttl = typeof o.ttlMs === 'number' ? o.ttlMs : TTL_MS;
    var map = {};

    function load() {
      if (!storage) return;
      try {
        var raw = storage.getItem(STORAGE_KEY);
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
      } catch (e) { map = {}; }
    }

    function persist() {
      if (!storage) return;
      try { storage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (e) {}
    }

    load();

    function set(modelId, state, reason, source) {
      if (!modelId) return;
      map[String(modelId)] = {
        state: state,
        reason: String(reason || ''),
        source: source || 'probe',
        at: now()
      };
      persist();
    }

    /** Статус с учётом TTL: протухший становится unknown, но причину помним. */
    function get(modelId) {
      var rec = map[String(modelId)];
      if (!rec) return { state: UNKNOWN, reason: '', at: 0, stale: false, source: '' };
      var age = now() - (rec.at || 0);
      if (age > ttl) {
        return { state: UNKNOWN, reason: rec.reason || '', at: rec.at || 0, stale: true, source: rec.source || '' };
      }
      return { state: rec.state, reason: rec.reason || '', at: rec.at || 0, stale: false, source: rec.source || '' };
    }

    /** Пассивное наблюдение: ошибка реального запроса. unknown не записываем. */
    function noteError(modelId, err) {
      var c = classifyError(err);
      if (c.state === UNKNOWN) return c;
      set(modelId, c.state, c.reason, 'наблюдение');
      return c;
    }

    /** Пассивное наблюдение: запрос к модели прошёл. */
    function noteSuccess(modelId) {
      set(modelId, OK, '', 'наблюдение');
    }

    /** Фолбэк клиента: from — сломалась, to — сработала. */
    function noteFallback(info) {
      if (!info) return;
      if (info.from) set(info.from, UNAVAILABLE, String(info.reason || 'фолбэк'), 'наблюдение');
      if (info.to) set(info.to, OK, '', 'наблюдение');
    }

    function clear() {
      map = {};
      persist();
    }

    function all() {
      var out = {};
      for (var k in map) { if (Object.prototype.hasOwnProperty.call(map, k)) out[k] = get(k); }
      return out;
    }

    return {
      set: set, get: get, all: all, clear: clear,
      noteError: noteError, noteSuccess: noteSuccess, noteFallback: noteFallback
    };
  }

  /** Текст опции селекта: «✓ GLM-5.1 · по умолчанию». */
  function decorateLabel(label, status) {
    var st = status || { state: UNKNOWN };
    return marker(st.state) + ' ' + String(label == null ? '' : label);
  }

  /** Подсказка (title) для опции. */
  function statusTitle(modelId, status, nowMs) {
    var st = status || { state: UNKNOWN };
    var head = String(modelId || '');
    if (st.state === OK) head += ' — доступна';
    else if (st.state === UNAVAILABLE) head += ' — недоступна' + (st.reason ? ': ' + st.reason : '');
    else head += ' — статус неизвестен' + (st.stale ? ' (проверка устарела)' : '');
    if (st.at) {
      var age = ageText((typeof nowMs === 'number' ? nowMs : Date.now()) - st.at);
      if (age) head += ' · ' + (st.source ? st.source + ', ' : '') + age;
    }
    return head;
  }

  /** Сводка для статус-строки после проверки. */
  function summarize(results) {
    var ok = 0, bad = 0, unk = 0;
    for (var i = 0; i < (results || []).length; i++) {
      var s = results[i] && results[i].state;
      if (s === OK) ok++;
      else if (s === UNAVAILABLE) bad++;
      else unk++;
    }
    var bits = ['доступно ' + ok];
    if (bad) bits.push('недоступно ' + bad);
    if (unk) bits.push('неясно ' + unk);
    return bits.join(' · ');
  }

  global.ModelHealth = {
    OK: OK,
    UNAVAILABLE: UNAVAILABLE,
    UNKNOWN: UNKNOWN,
    TTL_MS: TTL_MS,
    STORAGE_KEY: STORAGE_KEY,
    classifyError: classifyError,
    marker: marker,
    ageText: ageText,
    createStore: createStore,
    decorateLabel: decorateLabel,
    statusTitle: statusTitle,
    summarize: summarize
  };
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
