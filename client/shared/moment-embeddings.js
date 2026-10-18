/**
 * Семантический слой find_moments (18.10.2026): эмбеддинги абзацев Cloud.ru
 * + гибрид FindMoments.rankHybrid; без сети/ключа/модели — тихий фолбэк на
 * лексический FindMoments.find.
 *
 * Замер (tests/integration/benchmark-find-moments.mjs, 4 транскрипта кэша,
 * 62 главы × запросы title/summary/short/ask = 248): лексика top-1 37%,
 * top-3 50%; ai-sage/Giga-Embeddings-instruct-3B + 0.1·стемы top-1 67%,
 * top-3 81%. Модель 480M дешевле в 10 раз, но слабее (58% / 77%).
 *
 * Векторы абзацев живут в entry.momentEmbeddings = { v, model, dim, vecs }:
 * vecs[textKey(текст абзаца)] = int8 в base64 (2048 изм. → 2.7 КБ на абзац;
 * на замере int8 не изменил ни одного попадания). Ключ по тексту, а не по
 * индексу: пересборка абзацев и ripple-сдвиги таймкодов не требуют
 * переэмбеддинга неизменившихся текстов.
 *
 * Запрос — с инструкцией (карточка модели: «Instruct: …\nQuery: …»), абзацы —
 * без неё. Русская инструкция на замере точнее английской из карточки.
 */
(function (global) {
  var QUERY_INSTRUCT = 'Instruct: Найди фрагменты расшифровки видео, где обсуждается тема запроса\nQuery: ';
  var STORE_V = 1;
  var BATCH_SIZE = 64;
  var BATCH_CHARS = 48000;   /* ≈12K токенов на запрос — с запасом к лимитам API */
  var CONCURRENCY = 4;       /* 4-часовой ролик (1018 абз.): 2.4 с вместо 6.4 с подряд */
  var MAX_TEXT_CHARS = 4000; /* смысл абзаца есть и в начале; контекст модели 8192 ток. */
  /* Свои запросы: top-1 cos < 0.25 у 1 из 248; «чужие» темы: медиана 0.22. */
  var WEAK_COS = 0.25;
  var DISABLE_MS = 30 * 60 * 1000; /* 401/403/404 — модель не в проекте/нет доступа */
  /* Таймаут (API висит): иначе каждый find_moments агента ждал бы таймаут × ретраи. */
  var HANG_PAUSE_MS = 5 * 60 * 1000;
  var QUERY_CACHE_MAX = 32;

  var _disabledUntil = {};
  var _disabledWhy = {};
  var _qCache = {};
  var _qOrder = [];
  /* Декодированные векторы последнего хранилища: повторный поиск по той же
     секвенции не распаковывает заново (4-часовой ролик — 8 МБ float32). */
  var _decVecs = null;
  var _decMap = {};

  /** FNV-1a 32-bit (как _extFnv1a в host/premiere.jsx) + длина текста. */
  function textKey(text) {
    var s = String(text || '');
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h = h ^ s.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    var hex = h.toString(16);
    while (hex.length < 8) hex = '0' + hex;
    return hex + '-' + s.length.toString(36);
  }

  /** int8 (масштаб по max|x|) → base64. */
  function encodeVector(vec) {
    var max = 0;
    for (var i = 0; i < vec.length; i++) {
      var a = Math.abs(vec[i]);
      if (a > max) max = a;
    }
    var sc = max > 0 ? 127 / max : 0;
    var bin = '';
    for (var j = 0; j < vec.length; j++) bin += String.fromCharCode(Math.round(vec[j] * sc) & 255);
    return btoa(bin);
  }

  /** base64 int8 → Float32Array единичной длины (масштаб не нужен: нормируем). */
  function decodeVector(str) {
    var bin = atob(str);
    var out = new Float32Array(bin.length);
    var n = 0;
    for (var i = 0; i < bin.length; i++) {
      var b = bin.charCodeAt(i);
      var q = b > 127 ? b - 256 : b;
      out[i] = q;
      n += q * q;
    }
    n = Math.sqrt(n) || 1;
    for (var j = 0; j < out.length; j++) out[j] /= n;
    return out;
  }

  function toUnit(v) {
    if (!v || !v.length) return null;
    var out = new Float32Array(v.length);
    var n = 0;
    for (var i = 0; i < v.length; i++) {
      out[i] = v[i];
      n += v[i] * v[i];
    }
    n = Math.sqrt(n) || 1;
    for (var j = 0; j < out.length; j++) out[j] /= n;
    return out;
  }

  function dot(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function clipText(t) {
    var s = String(t || ' ');
    return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s;
  }

  /* Батчи по числу текстов и по суммарной длине. */
  function makeBatches(texts, batchSize) {
    var out = [];
    var cur = [];
    var chars = 0;
    for (var i = 0; i < texts.length; i++) {
      if (cur.length && (cur.length >= batchSize || chars + texts[i].length > BATCH_CHARS)) {
        out.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(texts[i]);
      chars += texts[i].length;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /* Не больше concurrency запросов одновременно; первый сбой — reject всего. */
  function runBatches(batches, worker, concurrency) {
    return new Promise(function (resolve, reject) {
      var results = new Array(batches.length);
      var next = 0;
      var done = 0;
      var failed = false;
      var active = 0;
      if (!batches.length) {
        resolve(results);
        return;
      }
      function launch() {
        while (!failed && active < concurrency && next < batches.length) {
          (function (bi) {
            active++;
            Promise.resolve().then(function () { return worker(batches[bi]); }).then(function (r) {
              active--;
              if (failed) return;
              if (!r || r.length !== batches[bi].length) {
                failed = true;
                reject(new Error('Эмбеддинги: векторов ' + (r ? r.length : 0) + ' на ' + batches[bi].length + ' текстов'));
                return;
              }
              results[bi] = r;
              done++;
              if (done === batches.length) resolve(results);
              else launch();
            }, function (err) {
              active--;
              if (!failed) {
                failed = true;
                reject(err);
              }
            });
          })(next++);
        }
      }
      launch();
    });
  }

  /**
   * Векторы абзацев entry: недостающие — через opt.embedTexts, всё — в entry.
   * Атомарно: при сбое любого батча entry не меняется.
   * @param {object} opt { model, embedTexts(texts) → Promise<vectors[]>, batchSize?, concurrency? }
   * @returns {Promise<{vectors: Float32Array[], added: number, changed: boolean}>}
   */
  function ensureParagraphVectors(entry, opt) {
    var model = String(opt.model || '');
    var paras = (entry && entry.paragraphs) || [];
    var old = entry.momentEmbeddings;
    var valid = !!(old && old.v === STORE_V && old.model === model && old.vecs && typeof old.vecs === 'object');
    var oldVecs = valid ? old.vecs : {};
    var keys = [];
    var missing = [];
    var missingTexts = [];
    var want = {};
    for (var i = 0; i < paras.length; i++) {
      var key = textKey(paras[i].text || '');
      keys.push(key);
      if (!oldVecs[key] && !want[key]) {
        missing.push(key);
        missingTexts.push(clipText(paras[i].text));
      }
      want[key] = 1;
    }
    var stale = 0;
    for (var ok in oldVecs) {
      if (Object.prototype.hasOwnProperty.call(oldVecs, ok) && !want[ok]) stale++;
    }
    var batches = makeBatches(missingTexts, opt.batchSize || BATCH_SIZE);
    return runBatches(batches, opt.embedTexts, opt.concurrency || CONCURRENCY).then(function (res) {
      var fresh = {};
      var m = 0;
      var dim = valid ? old.dim : 0;
      for (var b = 0; b < res.length; b++) {
        for (var j = 0; j < res[b].length; j++) {
          var unit = toUnit(res[b][j]);
          if (!unit) throw new Error('Эмбеддинги: пустой вектор');
          dim = unit.length;
          fresh[missing[m++]] = encodeVector(unit);
        }
      }
      var changed = !valid || missing.length > 0 || stale > 0;
      var vecs = oldVecs;
      if (changed) {
        vecs = {};
        for (var k2 = 0; k2 < keys.length; k2++) vecs[keys[k2]] = oldVecs[keys[k2]] || fresh[keys[k2]];
        entry.momentEmbeddings = { v: STORE_V, model: model, dim: dim, vecs: vecs };
      }
      var prev = _decVecs === oldVecs || _decVecs === vecs ? _decMap : {};
      var dec = {};
      var vectors = [];
      for (var k3 = 0; k3 < keys.length; k3++) {
        var kk = keys[k3];
        if (!dec[kk]) dec[kk] = (prev[kk] && vecs[kk] === oldVecs[kk]) ? prev[kk] : decodeVector(vecs[kk]);
        vectors.push(dec[kk]);
      }
      _decVecs = vecs;
      _decMap = dec;
      return { vectors: vectors, added: missing.length, changed: changed };
    });
  }

  function embedQuery(query, opt) {
    var key = opt.model + '\n' + query;
    if (_qCache[key]) return Promise.resolve(_qCache[key]);
    return Promise.resolve(opt.embedTexts([QUERY_INSTRUCT + clipText(query)])).then(function (vs) {
      var v = toUnit(vs && vs[0]);
      if (!v) throw new Error('Эмбеддинги: пустой вектор запроса');
      _qCache[key] = v;
      _qOrder.push(key);
      if (_qOrder.length > QUERY_CACHE_MAX) delete _qCache[_qOrder.shift()];
      return v;
    });
  }

  /**
   * find_moments с эмбеддингами. Не бросает, кроме AbortError (Стоп).
   * @param {object} opt { k?:20, model, embedTexts, lexWeight? (0 — чистый косинус), now? }
   * @returns {Promise<{moments, mode:'semantic'|'lexical', weak, persist, added, topCos?, fallbackReason?}>}
   *   persist — векторы добавлены в entry, вызывающему стоит сохранить кэш.
   */
  function search(entry, query, opt) {
    opt = opt || {};
    var k = opt.k || 20;
    var model = String(opt.model || '');
    var now = typeof opt.now === 'number' ? opt.now : Date.now();
    var docs = null;
    function lexical(reason) {
      return {
        moments: global.FindMoments.find(entry, query, { k: k }),
        mode: 'lexical',
        weak: false,
        persist: !!(docs && docs.changed),
        added: docs ? docs.added : 0,
        fallbackReason: reason
      };
    }
    if (!model || typeof opt.embedTexts !== 'function') return Promise.resolve(lexical('эмбеддинги не настроены'));
    if (!entry || !entry.paragraphs || !entry.paragraphs.length) return Promise.resolve(lexical('в транскрипте нет абзацев'));
    if (_disabledUntil[model] && now < _disabledUntil[model]) {
      return Promise.resolve(lexical('семантический поиск недоступен: ' + _disabledWhy[model]));
    }
    return ensureParagraphVectors(entry, opt).then(function (d) {
      docs = d;
      return embedQuery(query, opt);
    }).then(function (qv) {
      if (docs.vectors[0] && docs.vectors[0].length !== qv.length) {
        throw new Error('Эмбеддинги: размерность запроса ' + qv.length + ' ≠ ' + docs.vectors[0].length);
      }
      var cos = [];
      var top = -Infinity;
      for (var i = 0; i < docs.vectors.length; i++) {
        cos.push(dot(qv, docs.vectors[i]));
        if (cos[i] > top) top = cos[i];
      }
      return {
        moments: global.FindMoments.rankHybrid(entry, query, cos, { k: k, lexWeight: opt.lexWeight }),
        mode: 'semantic',
        weak: top < WEAK_COS,
        persist: docs.changed,
        added: docs.added,
        topCos: Math.round(top * 1000) / 1000
      };
    }).catch(function (err) {
      if (err && err.name === 'AbortError') throw err;
      var msg = String((err && err.message) || err);
      var st = err && err.httpStatus;
      var pause = (st === 401 || st === 403 || st === 404) ? DISABLE_MS
        : /Таймаут запроса/.test(msg) ? HANG_PAUSE_MS : 0;
      if (pause) {
        _disabledUntil[model] = now + pause;
        _disabledWhy[model] = msg;
      }
      return lexical(/^Эмбеддинги/.test(msg) ? msg : 'Эмбеддинги: ' + msg);
    });
  }

  global.MomentEmbeddings = {
    QUERY_INSTRUCT: QUERY_INSTRUCT,
    search: search,
    ensureParagraphVectors: ensureParagraphVectors,
    textKey: textKey,
    encodeVector: encodeVector,
    decodeVector: decodeVector,
    _resetForTests: function () {
      _disabledUntil = {};
      _disabledWhy = {};
      _qCache = {};
      _qOrder = [];
      _decVecs = null;
      _decMap = {};
    }
  };
})(typeof window !== 'undefined' ? window : this);
