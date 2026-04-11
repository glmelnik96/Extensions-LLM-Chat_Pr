/**
 * find_moments: семантический (token-IDF) поиск по транскрипту.
 *
 * MVP без эмбеддингов: токенизация по словам, нормализация (lowercase + удаление пунктуации),
 * стоп-слова (RU/EN), TF×IDF + бонус за совпадение фразы целиком.
 *
 * Используется как client-side executor: получает paragraphs или segments из кэша
 * (TranscriptStructure.buildStructure / get_transcript_from_cache) и возвращает топ-K совпадений.
 *
 * Не зависит от Node.js, работает в обычном CEP/браузерном окружении.
 */
(function (global) {
  var STOP = {
    'и': 1, 'в': 1, 'на': 1, 'с': 1, 'по': 1, 'к': 1, 'у': 1, 'из': 1, 'от': 1, 'до': 1,
    'за': 1, 'о': 1, 'об': 1, 'для': 1, 'но': 1, 'а': 1, 'или': 1, 'же': 1, 'ли': 1,
    'не': 1, 'ни': 1, 'это': 1, 'этот': 1, 'эта': 1, 'эти': 1, 'тот': 1, 'та': 1, 'те': 1,
    'я': 1, 'ты': 1, 'он': 1, 'она': 1, 'оно': 1, 'мы': 1, 'вы': 1, 'они': 1,
    'мой': 1, 'твой': 1, 'наш': 1, 'ваш': 1, 'свой': 1, 'его': 1, 'её': 1, 'их': 1,
    'что': 1, 'как': 1, 'где': 1, 'когда': 1, 'почему': 1, 'зачем': 1, 'кто': 1,
    'был': 1, 'была': 1, 'было': 1, 'были': 1, 'есть': 1, 'быть': 1, 'будет': 1,
    'the': 1, 'a': 1, 'an': 1, 'is': 1, 'are': 1, 'was': 1, 'were': 1, 'be': 1,
    'and': 1, 'or': 1, 'but': 1, 'if': 1, 'of': 1, 'in': 1, 'on': 1, 'at': 1,
    'to': 1, 'for': 1, 'with': 1, 'by': 1, 'from': 1, 'as': 1, 'this': 1, 'that': 1,
    'it': 1, 'i': 1, 'you': 1, 'he': 1, 'she': 1, 'we': 1, 'they': 1
  };

  function tokenize(s) {
    if (!s) return [];
    var t = String(s).toLowerCase().replace(/ё/g, 'е');
    var raw = t.split(/[^a-zа-я0-9]+/);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var w = raw[i];
      if (w && w.length >= 2 && !STOP[w]) out.push(w);
    }
    return out;
  }

  function buildIdf(docs) {
    var df = {};
    var N = docs.length;
    for (var i = 0; i < N; i++) {
      var seen = {};
      var toks = docs[i];
      for (var j = 0; j < toks.length; j++) {
        if (!seen[toks[j]]) {
          seen[toks[j]] = 1;
          df[toks[j]] = (df[toks[j]] || 0) + 1;
        }
      }
    }
    var idf = {};
    for (var w in df) {
      if (Object.prototype.hasOwnProperty.call(df, w)) {
        idf[w] = Math.log((N + 1) / (df[w] + 1)) + 1;
      }
    }
    return idf;
  }

  function scoreDoc(qTokens, dTokens, idf, rawText, rawQuery) {
    if (!qTokens.length || !dTokens.length) return 0;
    var dCount = {};
    for (var i = 0; i < dTokens.length; i++) {
      dCount[dTokens[i]] = (dCount[dTokens[i]] || 0) + 1;
    }
    var s = 0;
    var matched = 0;
    for (var k = 0; k < qTokens.length; k++) {
      var q = qTokens[k];
      var tf = dCount[q] || 0;
      if (tf > 0) {
        s += (idf[q] || 1) * (1 + Math.log(tf));
        matched++;
      }
    }
    /* бонус за полную фразу */
    if (rawQuery && rawText) {
      var rq = String(rawQuery).toLowerCase().replace(/ё/g, 'е').trim();
      var rt = String(rawText).toLowerCase().replace(/ё/g, 'е');
      if (rq.length >= 4 && rt.indexOf(rq) >= 0) s *= 1.6;
    }
    /* штраф если совпало мало уникальных токенов запроса */
    if (qTokens.length > 1) {
      var coverage = matched / qTokens.length;
      s *= 0.4 + 0.6 * coverage;
    }
    return s;
  }

  function norm(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е');
  }

  /**
   * Извлечь «корни» (без 1-2 последних букв) для нечёткого совпадения по словоформам.
   * Простой стеммер: для слов длиной >=5 убираем 2 последних символа, >=4 — 1.
   */
  function stemBase(word) {
    var w = norm(word).replace(/[^a-zа-я0-9]+/g, '');
    if (w.length >= 6) return w.slice(0, w.length - 2);
    if (w.length >= 4) return w.slice(0, w.length - 1);
    return w;
  }

  function queryStems(query) {
    var qs = norm(query).split(/[^a-zа-я0-9]+/).filter(function (w) {
      return w && w.length >= 3 && !STOP[w];
    });
    return qs.map(stemBase).filter(function (s) { return s.length >= 3; });
  }

  /**
   * @param {object} entry  кэш транскрипта (см. transcript-structure.js)
   * @param {string} query
   * @param {object} opt    { k?:20, minScore?:0.0, scope?:'segments'|'paragraphs'|'auto', mergeGapSec?:1.5 }
   * @returns {Array<{startSec, endSec, score, text, source, idx, matchType}>}
   *
   * Стратегия (новая): сначала literal substring match по СТЕММАМ запроса —
   * возвращает ВСЕ места, где встречается любая словоформа (стратегия/стратегии/стратегиям).
   * Работает на уровне сегментов (точнее параграфов). Если literal-совпадений нет,
   * fallback на TF-IDF по параграфам как раньше.
   */
  function findMoments(entry, query, opt) {
    opt = opt || {};
    var k = opt.k || 20;
    var scope = opt.scope || 'auto';
    var mergeGap = typeof opt.mergeGapSec === 'number' ? opt.mergeGapSec : 1.5;

    if (!entry || !query || !String(query).trim()) return [];

    /* Сначала идём по сегментам — у них тайминг точнее, чем у параграфов. */
    var segs = (entry.segments && entry.segments.length) ? entry.segments : [];
    var paras = (entry.paragraphs && entry.paragraphs.length) ? entry.paragraphs : [];

    var stems = queryStems(query);
    var hits = [];

    if (scope !== 'paragraphs' && segs.length) {
      for (var si = 0; si < segs.length; si++) {
        var s = segs[si];
        var t = norm(s.text);
        if (!t) continue;
        var matched = false;
        for (var qi = 0; qi < stems.length; qi++) {
          if (t.indexOf(stems[qi]) >= 0) { matched = true; break; }
        }
        if (matched) {
          hits.push({
            startSec: s.startSec,
            endSec: s.endSec,
            score: 1,
            text: s.text || '',
            source: 'segments',
            idx: si,
            matchType: 'literal'
          });
        }
      }
    }

    if (!hits.length && paras.length) {
      /* Fallback 1: literal по параграфам */
      for (var pi = 0; pi < paras.length; pi++) {
        var p = paras[pi];
        var pt = norm(p.text);
        var pmatched = false;
        for (var pqi = 0; pqi < stems.length; pqi++) {
          if (pt.indexOf(stems[pqi]) >= 0) { pmatched = true; break; }
        }
        if (pmatched) {
          hits.push({
            startSec: p.startSec,
            endSec: p.endSec,
            score: 1,
            text: p.text || '',
            source: 'paragraphs',
            idx: pi,
            matchType: 'literal'
          });
        }
      }
    }

    if (!hits.length) {
      /* Fallback 2: TF-IDF — для семантических запросов («где про мотивацию команды») */
      var units = paras.length ? paras : segs;
      var src = paras.length ? 'paragraphs' : 'segments';
      if (!units.length) return [];
      var docTokens = units.map(function (u) { return tokenize(u.text); });
      var idf = buildIdf(docTokens);
      var qTok = tokenize(query);
      var scored = units.map(function (u, i) {
        var sc = scoreDoc(qTok, docTokens[i], idf, u.text, query);
        return {
          startSec: u.startSec,
          endSec: u.endSec,
          score: Math.round(sc * 1000) / 1000,
          text: u.text || '',
          source: src,
          idx: i,
          matchType: 'semantic'
        };
      });
      scored.sort(function (a, b) { return b.score - a.score; });
      hits = scored.filter(function (h) { return h.score > 0.2; }).slice(0, k);
      return hits;
    }

    /* Сортируем literal-хиты по времени и склеиваем соседние (в том же абзаце) */
    hits.sort(function (a, b) { return a.startSec - b.startSec; });
    var merged = [];
    for (var hi = 0; hi < hits.length; hi++) {
      var h = hits[hi];
      var last = merged[merged.length - 1];
      if (last && h.startSec - last.endSec <= mergeGap) {
        last.endSec = Math.max(last.endSec, h.endSec);
        last.text = (last.text + ' ' + h.text).trim();
      } else {
        merged.push({
          startSec: h.startSec,
          endSec: h.endSec,
          score: h.score,
          text: h.text,
          source: h.source,
          idx: h.idx,
          matchType: h.matchType
        });
      }
    }
    return merged.slice(0, k);
  }

  global.FindMoments = {
    find: findMoments,
    _tokenize: tokenize,
    _buildIdf: buildIdf
  };
})(typeof window !== 'undefined' ? window : this);
