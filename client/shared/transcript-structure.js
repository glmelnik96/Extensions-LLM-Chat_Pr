/**
 * Transcript Structure (1.3): второй слой анализа поверх Whisper-сегментов.
 *
 * Строится локально (без LLM) + опционально one-shot запросом в Cloud.ru FM для тем.
 *
 * Входные данные: entry = {segments:[{startSec,endSec,text}], audioAnalysis:{silences}}.
 * На выходе — тот же entry, дополненный полями:
 *   paragraphs: [{startSec, endSec, text, segmentIdxs:[...], pauseBeforeSec, pauseAfterSec}]
 *   speakers:   [] (если Whisper не выдал label — оставляем пустым)
 *   topics:     [{startSec, endSec, title, summary?}]  (из LLM one-shot)
 *   structureMeta: {builtAt, paragraphCount, topicsSource, …}
 *
 * Все три поля — идемпотентные: повторный вызов перезаписывает.
 */
(function (global) {
  'use strict';

  /** Границы параграфа определяются по одному из правил:
   *  - длинная пауза (>= PAUSE_THRESHOLD_SEC) между соседними сегментами
   *  - пересечение с silence-интервалом из audioAnalysis
   *  - конец сегмента заканчивается сильным знаком: . ! ? … (новый абзац начинается с заглавной)
   */
  var DEFAULT_PAUSE_THRESHOLD_SEC = 0.9;
  var MAX_PARAGRAPH_SEC = 60;

  function sentenceEnds(txt) {
    if (!txt) return false;
    var t = String(txt).trim().replace(/["'»)\]]$/, '');
    return /[.!?…]$/.test(t);
  }

  /* Перф (ревью 06.08.2026): бинпоиск по отсортированным паузам.
   * Паузы silencedetect не перекрываются ⇒ отсортированность по startSec
   * влечёт отсортированность по endSec — ищем первый индекс с endSec >= t.
   * Плотная карта (d=0.15) на длинном ролике — тысячи пауз; линейный скан
   * на каждую границу сегмента давал O(N×M). */
  function firstSilenceEndingAfter(sil, t) {
    var lo = 0, hi = sil.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      var s = sil[mid];
      var e = s ? Number(typeof s.endSec === 'number' ? s.endSec : s.end) : NaN;
      if (isFinite(e) && e < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /**
   * Строит paragraphs[] по segments + silences.
   * silences: [{startSec, endSec, durationSec}] в координатах ТАЙМЛАЙНА (совпадает с segments).
   */
  function buildParagraphs(segments, silences, opt) {
    opt = opt || {};
    var pauseTh = typeof opt.pauseThresholdSec === 'number' ? opt.pauseThresholdSec : DEFAULT_PAUSE_THRESHOLD_SEC;
    var maxLen = typeof opt.maxParagraphSec === 'number' ? opt.maxParagraphSec : MAX_PARAGRAPH_SEC;
    if (!Array.isArray(segments) || !segments.length) return [];

    /* Для быстрой проверки "был ли silence между A и B" — сортированный массив и линейный указатель. */
    var sil = (Array.isArray(silences) ? silences : []).slice()
      .sort(function (a, b) { return (a.startSec || 0) - (b.startSec || 0); });

    function silenceBetween(tA, tB) {
      if (tB <= tA) return 0;
      var acc = 0;
      for (var i = firstSilenceEndingAfter(sil, tA); i < sil.length; i++) {
        var s = sil[i].startSec, e = sil[i].endSec;
        if (e <= tA) continue;
        if (s >= tB) break;
        acc += Math.min(e, tB) - Math.max(s, tA);
      }
      return acc;
    }

    var paragraphs = [];
    var curIdxs = [];
    var curStart = null;
    var curEnd = null;
    var curTextParts = [];
    var prevSeg = null;

    function flush(nextSeg) {
      if (!curIdxs.length) return;
      var pauseAfter = 0;
      if (nextSeg) {
        pauseAfter = Math.max(0, nextSeg.startSec - curEnd);
      }
      paragraphs.push({
        startSec: Math.round(curStart * 1000) / 1000,
        endSec: Math.round(curEnd * 1000) / 1000,
        text: curTextParts.join(' ').replace(/\s+/g, ' ').trim(),
        segmentIdxs: curIdxs.slice(),
        pauseBeforeSec: null, /* заполним на втором проходе */
        pauseAfterSec: Math.round(pauseAfter * 100) / 100
      });
      curIdxs = [];
      curStart = null;
      curEnd = null;
      curTextParts = [];
    }

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (!seg || typeof seg.startSec !== 'number' || typeof seg.endSec !== 'number') continue;

      if (!curIdxs.length) {
        curStart = seg.startSec;
        curEnd = seg.endSec;
        curIdxs.push(i);
        curTextParts.push(seg.text || '');
        prevSeg = seg;
        continue;
      }

      var gap = seg.startSec - curEnd;
      var silInside = silenceBetween(curEnd, seg.startSec);
      var lenIfAdded = seg.endSec - curStart;
      var prevEndsSentence = sentenceEnds(prevSeg && prevSeg.text);

      var breakHere =
        gap >= pauseTh ||
        silInside >= pauseTh ||
        (prevEndsSentence && gap >= 0.35) ||
        lenIfAdded > maxLen;

      if (breakHere) {
        flush(seg);
        curStart = seg.startSec;
        curEnd = seg.endSec;
        curIdxs.push(i);
        curTextParts.push(seg.text || '');
      } else {
        curEnd = seg.endSec;
        curIdxs.push(i);
        curTextParts.push(seg.text || '');
      }
      prevSeg = seg;
    }
    flush(null);

    /* второй проход — pauseBeforeSec */
    for (var p = 0; p < paragraphs.length; p++) {
      paragraphs[p].pauseBeforeSec = p === 0
        ? null
        : Math.round((paragraphs[p].startSec - paragraphs[p - 1].endSec) * 100) / 100;
    }
    return paragraphs;
  }

  /**
   * Группировка по speaker label, если Whisper вернул их в segments[].speaker / segments[].speaker_id.
   * Возвращает массив {label, turns: [{startSec, endSec, paragraphIdxs:[]}]} либо пустой массив.
   */
  function buildSpeakers(segments, paragraphs) {
    if (!Array.isArray(segments) || !segments.length) return [];
    var hasLabels = false;
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (s && (s.speaker || s.speaker_id || s.speakerLabel)) { hasLabels = true; break; }
    }
    if (!hasLabels) return [];
    var getLabel = function (s) {
      return String((s && (s.speaker || s.speaker_id || s.speakerLabel)) || '').trim() || '?';
    };
    var map = {};
    paragraphs.forEach(function (p, pi) {
      /* для параграфа берём лейбл большинства его сегментов */
      var counts = {};
      p.segmentIdxs.forEach(function (si) {
        var l = getLabel(segments[si]);
        counts[l] = (counts[l] || 0) + 1;
      });
      var best = null, bestCount = -1;
      for (var k in counts) {
        if (counts[k] > bestCount) { best = k; bestCount = counts[k]; }
      }
      if (!map[best]) map[best] = { label: best, turns: [] };
      var turns = map[best].turns;
      var last = turns[turns.length - 1];
      if (last && last.endSec >= p.startSec - 0.5) {
        last.endSec = p.endSec;
        last.paragraphIdxs.push(pi);
      } else {
        turns.push({ startSec: p.startSec, endSec: p.endSec, paragraphIdxs: [pi] });
      }
    });
    var out = [];
    for (var key in map) out.push(map[key]);
    return out;
  }

  /**
   * Темы / главы через one-shot LLM.
   * opt: { settings, CloudRuClient, signal, abortCheck }
   * Возвращает Promise<Array<{startSec, endSec, title, summary?}>>.
   * При ошибке — resolve([]) (мягко).
   */
  function buildTopicsWithLLM(paragraphs, opt) {
    opt = opt || {};
    var settings = opt.settings || {};
    var CC = opt.CloudRuClient || global.CloudRuClient;
    if (!CC || !paragraphs || !paragraphs.length) return Promise.resolve([]);

    /* Компактный вход: только первые N параграфов и первые 40 слов каждого — экономим токены. */
    var compact = paragraphs.map(function (p, idx) {
      var words = String(p.text || '').split(/\s+/).slice(0, 40).join(' ');
      return {
        i: idx,
        t0: p.startSec,
        t1: p.endSec,
        text: words + (p.text && p.text.split(/\s+/).length > 40 ? '…' : '')
      };
    });

    var sysMsg =
      'Ты — монтажёр, размечающий видеоролик по смысловым главам. ' +
      'На входе — абзацы расшифровки с таймкодами (секунды на таймлайне). ' +
      'Сгруппируй их в 3–12 глав по СМЕНЕ ТЕМЫ. ' +
      'КАЖДАЯ ГЛАВА ДОЛЖНА ИМЕТЬ УНИКАЛЬНОЕ НАЗВАНИЕ — не повторяй одно и то же. ' +
      'Если несколько абзацев подряд про одно и то же — объедини их в ОДНУ главу. ' +
      'Если весь ролик на одну тему (короткое выступление, одна мысль) — верни 1-3 главы, не растягивай. ' +
      'Названия глав: 3-6 слов, отражают СУТЬ блока, на русском. Без слов «Часть N», «Продолжение», «Раздел N». ' +
      'Возвращай СТРОГО JSON {"topics":[{"startSec":N,"endSec":N,"title":"…","summary":"одно предложение"}]}. ' +
      'startSec первой главы = startSec первого абзаца; endSec последней = endSec последнего. ' +
      'Главы без дыр: endSec текущей = startSec следующей. Между главами не меньше 20 сек. Без markdown, только JSON.';

    /* C3 (27.07.2026, AutoCut-паритет): кастомные указания пользователя к
       разбиению на главы (язык названий, что выделить отдельно и т.п.).
       Формат ответа (JSON-схему) указаниям переопределять нельзя. */
    var customIx = String(opt.customInstructions || '').replace(/^\s+|\s+$/g, '');
    if (customIx) {
      sysMsg += ' Дополнительные указания монтажёра (следуй им, если не противоречат формату ответа): ' +
        customIx.slice(0, 500);
    }

    var userMsg = JSON.stringify({ paragraphs: compact });

    /* Phase 1 (Май 2026): chapterModel — отдельная модель для построения глав.
       Long-context reasoning task — рутим на GLM-4.7 если задано. Fallback на
       chatModel чтобы не сломать пользователей с кастомным fm-defaults. */
    return CC.chatCompletions({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.chapterModel || settings.analysisModel || settings.activeAgentModel || settings.chatModel,
      messages: [
        { role: 'system', content: sysMsg },
        { role: 'user', content: userMsg }
      ],
      /* Phase 1.5 (6 мая 2026): adaptive max_tokens.
         Production-eval показал зависимость:
         - 9 параграфов (smoke):    ~2.6K completion → 4000 хватало
         - 297 параграфов (1ч):     ~6-8K completion → 16000 OK
         - 900 параграфов (3ч):    ~18-25K оценка → 16000 МАЛО (regression risk)
         Формула: 16000 + (paragraphs * 30) с потолком 32000. На 1ч даёт 16K+9K=25K
         (clamped к 32K), на 3ч даёт 16K+27K=32K. Не-thinking модели лишнее не съедят. */
      chatParams: { max_tokens: Math.min(32000, 16000 + Math.floor(paragraphs.length * 30)), temperature: 0.2 },
      responseFormat: 'json_object',
      /* Phase 1.5: per-role thinking — для chapter обычно true (long-context reasoning). */
      enableThinking: (settings.thinkingPolicy && typeof settings.thinkingPolicy.chapter === 'boolean')
        ? settings.thinkingPolicy.chapter
        : settings.enableThinking,
      signal: opt.signal,
      abortCheck: opt.abortCheck
    }).then(function (resp) {
      try {
        var choice = resp && resp.choices && resp.choices[0];
        var content = choice && choice.message && choice.message.content;
        /* Phase 1.5 (6 мая): диагностика — логируем finish_reason/usage если empty.
           Помогает понять truncation vs API error vs genuine empty response. */
        if (!content) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[buildTopics] empty content. finish_reason=' + (choice && choice.finish_reason) +
              ' usage=' + JSON.stringify(resp.usage || {}));
          }
          return [];
        }
        var m = String(content).match(/\{[\s\S]*\}/);
        if (!m) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[buildTopics] no JSON match. content len=' + content.length +
              ' first200="' + content.slice(0, 200) + '"');
          }
          return [];
        }
        var j;
        try {
          j = JSON.parse(m[0]);
        } catch (eParse) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[buildTopics] JSON.parse fail: ' + eParse.message + ' content tail="' +
              content.slice(-200) + '"');
          }
          return [];
        }
        var topics = (j && j.topics) || [];
        if (!Array.isArray(topics)) return [];
        var normalized = topics.map(function (t) {
          return {
            startSec: Number(t.startSec) || 0,
            endSec: Number(t.endSec) || 0,
            title: String(t.title || '').slice(0, 80),
            summary: String(t.summary || '').slice(0, 200)
          };
        }).filter(function (t) { return t.endSec > t.startSec && t.title; });
        /* Phase 1.5 (6 мая): post-process dedup. LLM иногда (особенно на повторяющемся
           материале) выдаёт N глав с одинаковыми title — сливаем смежные одинаковые
           в одну. Сравниваем по нормализованному lowercased title. */
        if (normalized.length <= 1) return normalized;
        var deduped = [normalized[0]];
        for (var ti = 1; ti < normalized.length; ti++) {
          var prev = deduped[deduped.length - 1];
          var cur = normalized[ti];
          var sameTitle = prev.title.trim().toLowerCase() === cur.title.trim().toLowerCase();
          var adjacent = Math.abs(prev.endSec - cur.startSec) < 2;
          if (sameTitle && adjacent) {
            /* Сливаем: расширяем prev.endSec, оставляем prev.summary. */
            prev.endSec = cur.endSec;
          } else {
            deduped.push(cur);
          }
        }
        return deduped;
      } catch (e) {
        return [];
      }
    }, function () { return []; });
  }

  /**
   * HIGH (6 мая 2026): обнаружение устаревших paragraphs после edit'а таймлайна.
   *
   * После applyTranscriptCuts сегменты ремаплятся под новые координаты, но
   * paragraphs.segmentIdxs могут указывать на удалённые сегменты, или
   * paragraph.startSec/endSec не совпасть с реальным временем сегментов
   * (расходимость на >1с). В таком случае LLM получает «корректные» абзацы
   * с неверными timestamps → ножи режут не там.
   *
   * Возвращает true если структура требует пересборки.
   */
  function isParagraphsStale(entry) {
    if (!entry || !Array.isArray(entry.paragraphs) || !entry.paragraphs.length) return false;
    if (!Array.isArray(entry.segments) || !entry.segments.length) return false;
    var segLen = entry.segments.length;
    var DRIFT = 1.0; /* сек — допуск рассогласования (секунда — много для речи) */
    for (var i = 0; i < entry.paragraphs.length; i++) {
      var p = entry.paragraphs[i];
      var idxs = Array.isArray(p.segmentIdxs) ? p.segmentIdxs : [];
      if (!idxs.length) continue;
      if (idxs[idxs.length - 1] >= segLen) return true;     /* segIdx out of range */
      if (idxs[0] < 0) return true;                         /* отрицательный idx */
      var firstSeg = entry.segments[idxs[0]];
      var lastSeg = entry.segments[idxs[idxs.length - 1]];
      if (!firstSeg || !lastSeg) return true;
      var ss = typeof firstSeg.startSec === 'number' ? firstSeg.startSec : firstSeg.start;
      var se = typeof lastSeg.endSec === 'number' ? lastSeg.endSec : lastSeg.end;
      if (typeof ss === 'number' && Math.abs(ss - p.startSec) > DRIFT) return true;
      if (typeof se === 'number' && Math.abs(se - p.endSec) > DRIFT) return true;
    }
    return false;
  }

  /**
   * Главная функция: строит paragraphs + speakers для entry (синхронно).
   * Темы — отдельно через buildTopicsWithLLM (может быть async/expensive).
   */
  function buildStructure(entry, opt) {
    opt = opt || {};
    if (!entry || !Array.isArray(entry.segments)) return entry;
    var silences = entry.audioAnalysis && entry.audioAnalysis.silences ? entry.audioAnalysis.silences : [];
    var paragraphs = buildParagraphs(entry.segments, silences, opt);
    var speakers = buildSpeakers(entry.segments, paragraphs);
    entry.paragraphs = paragraphs;
    entry.speakers = speakers;
    entry.structureMeta = {
      builtAt: Date.now(),
      paragraphCount: paragraphs.length,
      speakerCount: speakers.length,
      pauseThresholdSec: typeof opt.pauseThresholdSec === 'number' ? opt.pauseThresholdSec : DEFAULT_PAUSE_THRESHOLD_SEC,
      topicsSource: entry.topics && entry.topics.length ? (entry.structureMeta && entry.structureMeta.topicsSource) || 'preserved' : null
    };
    return entry;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * LOCAL DETECTORS — мгновенная классификация без LLM (P0-2).
   *
   * Возвращают массив {i, label, reason, confidence} для сегментов,
   * которые можно уверенно разметить словарно/паттерно.
   * confidence: 'high' — уверенная метка (не отправляем в LLM).
   * ═══════════════════════════════════════════════════════════════════════ */

  /* Нормализация текста для сравнения */
  function normText(t) { return String(t || '').toLowerCase().replace(/[^\wа-яёА-ЯЁ\s]/g, '').trim(); }

  /**
   * detectFillers — словарные fillers (русский + универсальные).
   * Сегмент = filler если ≥80% слов — из словаря, ИЛИ весь текст ≤3 слова и все из словаря.
   */
  var FILLER_WORDS = [
    'ну', 'нуу', 'ээ', 'эээ', 'ммм', 'мм', 'ам', 'хм', 'ааа',
    'как бы', 'типа', 'вот', 'короче', 'допустим', 'ладно', 'значит',
    'блин', 'так', 'ну вот', 'это самое', 'в общем', 'то есть', 'слушай',
    'кстати', 'собственно', 'так сказать', 'грубо говоря', 'что ли'
  ];
  var FILLER_SET = {};
  FILLER_WORDS.forEach(function (w) { FILLER_SET[w] = 1; });

  function detectFillers(segments) {
    var results = [];
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var txt = normText(seg.text);
      if (!txt) continue;
      var words = txt.split(/\s+/);
      if (words.length === 0) continue;

      /* Проверяем полные фразы-паразиты (2-3 слова) */
      var fillerCount = 0;
      var j = 0;
      while (j < words.length) {
        /* Попробуем 3-граммы, 2-граммы, 1-граммы */
        var matched = false;
        if (j + 2 < words.length && FILLER_SET[words[j] + ' ' + words[j + 1] + ' ' + words[j + 2]]) {
          fillerCount += 3; j += 3; matched = true;
        }
        if (!matched && j + 1 < words.length && FILLER_SET[words[j] + ' ' + words[j + 1]]) {
          fillerCount += 2; j += 2; matched = true;
        }
        if (!matched && FILLER_SET[words[j]]) {
          fillerCount += 1; j += 1; matched = true;
        }
        if (!matched) j++;
      }

      var ratio = fillerCount / words.length;
      /* Целиком filler: все слова из словаря и сегмент короткий, ИЛИ ≥80% слов */
      if ((words.length <= 4 && ratio >= 0.9) || (words.length > 4 && ratio >= 0.8)) {
        results.push({ i: seg.i !== undefined ? seg.i : i, label: 'filler', reason: 'словарный filler (' + Math.round(ratio * 100) + '%)', confidence: 'high' });
      }
    }
    return results;
  }

  /**
   * detectIntroOutro — паттерны приветствий/прощаний.
   * Ищем только в первых/последних 10% сегментов (или первых/последних 5).
   */
  var INTRO_PATTERNS = [
    /всем\s+привет/, /привет\s+друзья/, /привет\s+ребят/, /здравствуйте/,
    /добро\s+пожаловать/, /с\s+вами\s+канал/, /меня\s+зовут/, /на\s+связи/,
    /сегодня\s+мы\s+поговор/, /в\s+этом\s+(видео|ролик|выпуск)/
  ];
  var OUTRO_PATTERNS = [
    /подписывайтесь/, /ставьте\s+лайк/, /до\s+встречи/, /до\s+свидания/,
    /с\s+вами\s+был/, /пока\s+пока/, /всем\s+пока/, /спасибо\s+за\s+просмотр/,
    /ссылк[аи]\s+в\s+описании/, /увидимся/, /до\s+новых\s+встреч/
  ];

  function detectIntroOutro(segments, totalDurationSec) {
    if (!segments || !segments.length) return [];
    var results = [];
    var introWindow = Math.max(5, Math.ceil(segments.length * 0.1));
    var outroWindow = Math.max(5, Math.ceil(segments.length * 0.1));

    /* Intro: первые N сегментов */
    for (var i = 0; i < Math.min(introWindow, segments.length); i++) {
      var seg = segments[i];
      var txt = normText(seg.text);
      if (!txt) continue;
      for (var p = 0; p < INTRO_PATTERNS.length; p++) {
        if (INTRO_PATTERNS[p].test(txt)) {
          /* Убеждаемся, что сегмент не содержит значимого контента (короткий текст ≤20 слов) */
          var wc = txt.split(/\s+/).length;
          if (wc <= 25) {
            results.push({
              i: seg.i !== undefined ? seg.i : i,
              label: 'intro',
              reason: 'паттерн приветствия',
              confidence: 'high'
            });
          }
          break;
        }
      }
    }

    /* Outro: последние N сегментов */
    var startOutro = Math.max(0, segments.length - outroWindow);
    for (var o = startOutro; o < segments.length; o++) {
      var segO = segments[o];
      var txtO = normText(segO.text);
      if (!txtO) continue;
      for (var q = 0; q < OUTRO_PATTERNS.length; q++) {
        if (OUTRO_PATTERNS[q].test(txtO)) {
          var wcO = txtO.split(/\s+/).length;
          if (wcO <= 25) {
            results.push({
              i: segO.i !== undefined ? segO.i : o,
              label: 'outro',
              reason: 'паттерн прощания',
              confidence: 'high'
            });
          }
          break;
        }
      }
    }
    return results;
  }

  /**
   * detectArtifacts — повторяющиеся фразы Whisper.
   * Если одна и та же фраза (после нормализации) встречается ≥3 раз подряд или ≥4 раз всего — artifact.
   */
  /**
   * detectArtifacts — повторяющиеся фразы Whisper.
   *
   * ОСТОРОЖНО: не помечаем сегменты как artifact если текст
   * содержит >5 уникальных слов — это может быть реальная речь.
   * Artifact = ТОЛЬКО короткая повторяющаяся фраза (≤5 слов),
   * встречающаяся ≥5 раз всего ИЛИ ≥3 раза ПОДРЯД.
   */
  function detectArtifacts(segments) {
    if (!segments || !segments.length) return [];
    var results = [];

    /* Подсчёт частоты нормализованных текстов */
    var freq = {};
    for (var i = 0; i < segments.length; i++) {
      var txt = normText(segments[i].text);
      var wordCount = txt ? txt.split(/\s+/).length : 0;
      /* Только короткие фразы (≤5 слов) — длинные = реальная речь */
      if (!txt || wordCount < 2 || wordCount > 5) continue;
      freq[txt] = (freq[txt] || 0) + 1;
    }

    /* Отмечаем тексты, повторяющиеся ≥5 раз (строгий порог) */
    var artifactTexts = {};
    for (var key in freq) {
      if (freq[key] >= 5) artifactTexts[key] = freq[key];
    }

    /* Также ищем 3+ подряд ИДЕНТИЧНЫХ (и коротких ≤5 слов) */
    for (var j = 0; j < segments.length - 2; j++) {
      var t1 = normText(segments[j].text);
      var wc1 = t1 ? t1.split(/\s+/).length : 0;
      if (!t1 || wc1 > 5) continue;
      var t2 = normText(segments[j + 1].text);
      var t3 = normText(segments[j + 2].text);
      if (t1 === t2 && t2 === t3) {
        if (!artifactTexts[t1]) artifactTexts[t1] = freq[t1] || 3;
      }
    }

    /* Размечаем: оставляем ПЕРВОЕ вхождение, остальные = artifact */
    var seen = {};
    for (var k = 0; k < segments.length; k++) {
      var nt = normText(segments[k].text);
      var ntWc = nt ? nt.split(/\s+/).length : 0;
      if (ntWc > 5) continue; /* длинные сегменты не трогаем */
      if (artifactTexts[nt] !== undefined) {
        if (!seen[nt]) {
          seen[nt] = true;
        } else {
          results.push({
            i: segments[k].i !== undefined ? segments[k].i : k,
            label: 'artifact',
            reason: 'повтор фразы (' + artifactTexts[nt] + 'x): «' + nt.slice(0, 40) + '»',
            confidence: 'high'
          });
        }
      }
    }
    return results;
  }

  /**
   * runLocalDetectors — запускает все локальные детекторы и возвращает объединённый результат.
   * Результат: { labels: [{i, label, reason, confidence}], stats: {...} }
   */
  function runLocalDetectors(segments, opt) {
    opt = opt || {};
    var totalDuration = opt.totalDurationSec || 0;
    if (!totalDuration && segments.length) {
      var last = segments[segments.length - 1];
      totalDuration = (typeof last.endSec === 'number' ? last.endSec : (last.end || 0));
    }

    var tasks = opt.tasks || null; /* null = все */
    var fillers = (!tasks || tasks.indexOf('filler') !== -1) ? detectFillers(segments) : [];
    var introOutro = [];
    if (!tasks || tasks.indexOf('intro') !== -1 || tasks.indexOf('outro') !== -1) {
      var io = detectIntroOutro(segments, totalDuration);
      introOutro = io.filter(function (r) {
        if (tasks && tasks.indexOf(r.label) === -1) return false;
        return true;
      });
    }
    var artifacts = (!tasks || tasks.indexOf('artifact') !== -1) ? detectArtifacts(segments) : [];

    /* Объединяем, без дубликатов по индексу (первая метка побеждает) */
    var byIndex = {};
    var all = [].concat(fillers, introOutro, artifacts);
    var labels = [];
    for (var a = 0; a < all.length; a++) {
      if (!byIndex[all[a].i]) {
        byIndex[all[a].i] = true;
        labels.push(all[a]);
      }
    }

    var stats = { filler: 0, intro: 0, outro: 0, artifact: 0 };
    for (var s = 0; s < labels.length; s++) {
      if (stats[labels[s].label] !== undefined) stats[labels[s].label]++;
    }

    return { labels: labels, stats: stats };
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * analyzeForCutsWithLLM — анализ транскрипта через вторую модель.
   *
   * Работает на уровне СЕГМЕНТОВ Whisper (3-10 с каждый), НЕ абзацев.
   * Это даёт точные границы для вырезки внутри длинных абзацев.
   *
   * Категории:
   *   content    — полезное содержание (оставить)
   *   filler     — целиком слова-паразиты / мычание (удалить)
   *   intro      — приветствие, представление (удалить)
   *   outro      — прощание, «подписывайтесь» (удалить)
   *   outtake    — оговорка, фальстарт, ругательство, «давай заново» (удалить)
   *   repeat     — дословный повтор (удалить первый дубль)
   *   artifact   — шум транскрибации, повтор имени/субтитров (удалить)
   *   digression — отвлечение от темы (пометить)
   *
   * opt: { settings, CloudRuClient, signal, abortCheck, tasks?, onProgress? }
   * Возвращает Promise<{labels:Array<{i,label,reason}>, stats:{...}, chunks:number}>
   * ═══════════════════════════════════════════════════════════════════════ */

  var ANALYSIS_CHUNK_SIZE = 50;        /* сегментов на чанк */
  var ANALYSIS_MAX_CHUNKS = 30;        /* лимит чанков — ~1500 сегментов (~5ч видео) */
  var ANALYSIS_MAX_WORDS_PER_SEG = 50; /* усекаем текст сегмента — для классификации хватает */

  function buildAnalysisSystemPrompt(tasks) {
    var taskList = (tasks && tasks.length)
      ? tasks.join(', ')
      : 'filler, intro, outro, outtake, repeat, artifact, digression';

    return [
      'Ты — ассистент видеомонтажёра. Тебе дан список СЕГМЕНТОВ (фрагментов) транскрипта видео.',
      'Каждый сегмент: {i: индекс, t0: начало (сек), t1: конец (сек), text: текст,',
      '  words?: [{w: слово, s: начало_сек, e: конец_сек}] (ТОЛЬКО для длинных сегментов >15 слов)}.',
      'Сегмент — это 3-30 секунд речи. В одном длинном абзаце может быть 5-15 сегментов.',
      'Поле words появляется только когда стоит думать о структуре фразы (длинная фраза — где',
      'начинается мысль, где конец, где filler в середине). Для коротких сегментов words нет — этого',
      'не нужно. Используй words чтобы понять, где ВНУТРИ сегмента кончается полезное и начинается',
      'мусор — это поможет LLM-планировщику в следующем шаге выбрать точные таймкоды резов.',
      '',
      'Задача: классифицируй КАЖДЫЙ сегмент ровно одной меткой:',
      '• content    — полезное содержание, факты, мысли по теме (ОСТАВИТЬ)',
      '• filler     — ЦЕЛИКОМ слова-паразиты, междометия, мычание: «ну», «ээ», «ммм», «как бы», «типа», «вот» (УДАЛИТЬ)',
      '• intro      — приветствие, представление: «всем привет», «меня зовут», «с вами канал» БЕЗ полезной информации (УДАЛИТЬ)',
      '• outro      — прощание: «подписывайтесь», «до встречи», «с вами был» (УДАЛИТЬ)',
      '• outtake    — оговорка, фальстарт, ругательство, «давай заново», «подожди, тормозни», «блин, это хрень» — спикер сбился и переначал (УДАЛИТЬ)',
      '• repeat     — содержательный повтор: спикер сказал ту же мысль/фразу ещё раз. Бывает любой длины — от 5 слов до целого абзаца. Если текст выглядит ОСМЫСЛЕННО и полно (не обрывок), и ты видишь его второй (третий, четвёртый…) раз — это repeat. Укажи «repeat of i=N». УДАЛИТЬ дубли, оставить ОДИН (последний обычно чище).',
      '• artifact   — НЕсодержательный шум транскрибации Whisper: вставленные обрывочные фрагменты имён ведущих, метаданных, субтитров. Признаки: 1-3 слова, вне контекста, нет грамматической связи с речью. Пример: «И Валерий Курас» вставленный посреди мысли — это artifact. ВАЖНО: если повторяется длинная осмысленная фраза целиком — это НЕ artifact, а repeat.',
      '• digression — уход от основной темы (ПОМЕТИТЬ, решение за пользователем)',
      '',
      'АКТИВНЫЕ ЗАДАЧИ (ищи эти категории, остальное = content): ' + taskList,
      '',
      'КРИТИЧЕСКИЕ ПРАВИЛА:',
      '1. Один сегмент = одна метка. Если в сегменте СМЕСЬ полезного и мусора — пометь основное.',
      '2. Если сегмент содержит хотя бы одну важную мысль или факт — label = content.',
      '3. outtake: спикер начал фразу, сбился, начал заново. Неудачная попытка = outtake, вторая (чистая) = content.',
      '4. artifact: одна и та же фраза (имя, субтитр) повторяется в разных сегментах как шум — удалять НЕЛЬЗЯ если фраза встречается 1-2 раза уместно.',
      '5. intro: ТОЛЬКО бесполезное приветствие. «Привет, сегодня разберём стратегию» — content (есть тема).',
      '6. repeat: пометь ПЕРВЫЙ экземпляр как repeat, ВТОРОЙ (чистый) — content.',
      '7. Если сомневаешься — ставь content.',
      '',
      'ФОРМАТ — строго JSON, без markdown, без комментариев:',
      '{"labels":[{"i":0,"label":"content","reason":""},{"i":1,"label":"outtake","reason":"фальстарт, начал заново"},...]}',
      'reason — 3-10 слов. Для content — пустая строка "".',
      'Верни ВСЕ сегменты из входа. Ни один не пропускай.'
    ].join('\n');
  }

  /**
   * Объединяет локальные pre-labels и LLM-labels в финальный результат.
   */
  function _buildFinalResult(segments, preByIndex, llmLabels, onProgress, chunksUsed, failedChunks) {
    var VALID_LABELS = { content: 1, filler: 1, intro: 1, outro: 1, outtake: 1, repeat: 1, artifact: 1, digression: 1 };
    var stats = { content: 0, filler: 0, intro: 0, outro: 0, outtake: 0, repeat: 0, artifact: 0, digression: 0 };
    var failedList = Array.isArray(failedChunks) ? failedChunks : [];

    /* Индексируем LLM-метки */
    var llmByIndex = {};
    for (var li = 0; li < llmLabels.length; li++) {
      var lbl = llmLabels[li].label;
      if (!VALID_LABELS[lbl]) llmLabels[li].label = 'content';
      llmByIndex[llmLabels[li].i] = llmLabels[li];
    }

    /* Строим полный массив: pre-label (local) > LLM > content (default) */
    var full = [];
    for (var si = 0; si < segments.length; si++) {
      var idx = segments[si].i !== undefined ? segments[si].i : si;
      var entry;
      if (preByIndex[idx] && preByIndex[idx].confidence === 'high') {
        entry = { i: idx, label: preByIndex[idx].label, reason: preByIndex[idx].reason + ' [local]' };
      } else if (llmByIndex[idx]) {
        entry = { i: idx, label: llmByIndex[idx].label, reason: llmByIndex[idx].reason };
      } else {
        entry = { i: idx, label: 'content', reason: '' };
      }
      stats[entry.label] = (stats[entry.label] || 0) + 1;
      full.push(entry);
    }

    /* Считаем сколько сегментов осталось без LLM-метки из-за сбойных чанков.
       Это точный «degradation footprint» — столько сегментов получили
       content по умолчанию вместо настоящей классификации. */
    var missedSegments = 0;
    for (var fi = 0; fi < failedList.length; fi++) {
      var fc = failedList[fi];
      if (fc && typeof fc.segStart === 'number' && typeof fc.segEnd === 'number') {
        missedSegments += (fc.segEnd - fc.segStart + 1);
      }
    }

    var doneMsg = 'Анализ завершён: ' + full.length + ' сегментов, удалить ' +
      (stats.filler + stats.intro + stats.outro + stats.outtake + stats.repeat + stats.artifact) +
      ', оставить ' + stats.content;
    if (failedList.length > 0) {
      doneMsg += ' ⚠ ' + failedList.length + ' чанк(ов) не разобрано (~' + missedSegments + ' сегм. как content)';
    }

    onProgress({
      phase: 'done',
      stats: stats,
      failedChunks: failedList,
      missedSegments: missedSegments,
      message: doneMsg
    });

    return {
      labels: full,
      stats: stats,
      chunks: chunksUsed || 0,
      totalSegments: segments.length,
      localDetected: Object.keys(preByIndex).length,
      /* Прозрачность: вернуть сбойные чанки в результате,
         чтобы panel.js мог показать warning-бадж. */
      failedChunks: failedList,
      missedSegments: missedSegments
    };
  }

  function analyzeForCutsWithLLM(segments, opt) {
    opt = opt || {};
    var settings = opt.settings || {};
    var CC = opt.CloudRuClient || global.CloudRuClient;
    var onProgress = typeof opt.onProgress === 'function' ? opt.onProgress : function () {};
    if (!segments || !segments.length) {
      return Promise.resolve({ labels: [], stats: {}, chunks: 0, error: 'Нет данных' });
    }

    var tasks = opt.tasks || null;
    var model = settings.analysisModel || settings.activeAgentModel || settings.chatModel;

    /* P0-2: Запускаем локальные детекторы первыми */
    var preLabels = opt.preLabels || null;
    if (!preLabels) {
      var localResult = runLocalDetectors(segments, { tasks: tasks });
      preLabels = localResult.labels;
    }
    var preByIndex = {};
    for (var pi = 0; pi < preLabels.length; pi++) {
      preByIndex[preLabels[pi].i] = preLabels[pi];
    }

    onProgress({
      phase: 'local_done',
      localLabels: preLabels.length,
      message: 'Локальный анализ: ' + preLabels.length + ' сегментов размечено мгновенно'
    });

    /* Если нет CloudRuClient — возвращаем только локальные результаты */
    if (!CC) {
      var localOnlyLabels = [];
      for (var lo = 0; lo < segments.length; lo++) {
        var loIdx = segments[lo].i !== undefined ? segments[lo].i : lo;
        localOnlyLabels.push(preByIndex[loIdx] || { i: loIdx, label: 'content', reason: '' });
      }
      return Promise.resolve({ labels: localOnlyLabels, stats: {}, chunks: 0, localOnly: true });
    }

    /* Фильтруем сегменты: в LLM отправляем только те, что не размечены локально с confidence='high' */
    var segmentsForLLM = [];
    /* 06.08.2026 (ревью): параллельный массив ОРИГИНАЛЬНЫХ индексов. Раньше
       fallback в чанке брал позицию в ОТФИЛЬТРОВАННОМ массиве (ci+idx) —
       при пропуске локально размеченных сегментов LLM-метки уезжали на
       чужие сегменты. */
    var llmOrigIdx = [];
    for (var fi = 0; fi < segments.length; fi++) {
      var fIdx = segments[fi].i !== undefined ? segments[fi].i : fi;
      if (preByIndex[fIdx] && preByIndex[fIdx].confidence === 'high') continue;
      segmentsForLLM.push(segments[fi]);
      llmOrigIdx.push(fIdx);
    }

    onProgress({
      phase: 'llm_start',
      llmSegments: segmentsForLLM.length,
      skipped: segments.length - segmentsForLLM.length,
      message: 'В LLM: ' + segmentsForLLM.length + ' сегментов (пропущено локально: ' + (segments.length - segmentsForLLM.length) + ')'
    });

    /* Если все размечены локально — пропускаем LLM */
    if (segmentsForLLM.length === 0) {
      return Promise.resolve(_buildFinalResult(segments, preByIndex, [], onProgress));
    }

    var sysPrompt = buildAnalysisSystemPrompt(tasks);

    /* Усекаем текст до ANALYSIS_MAX_WORDS_PER_SEG слов — для классификации больше не нужно */
    function truncText(txt) {
      var words = String(txt || '').split(/\s+/);
      if (words.length <= ANALYSIS_MAX_WORDS_PER_SEG) return words.join(' ');
      return words.slice(0, ANALYSIS_MAX_WORDS_PER_SEG).join(' ') + '…';
    }

    /* WORD_LEVEL_THRESHOLD: сегменты длиннее 15 слов получают синтезированный
       массив `words` с равномерно распределёнными таймкодами в пределах [t0, t1].
       Заимствовано из openshorts (main.py) — dual input «raw text + words JSON»
       помогает LLM рассуждать о структуре длинных фраз и точно ставить резы.
       На коротких сегментах (≤15 слов) word-level не нужен — экономим токены. */
    var WORD_LEVEL_THRESHOLD = 15;

    function synthesizeWords(seg) {
      if (!seg || typeof seg.text !== 'string') return null;
      /* Если whisper вернул words[] нативно — используем их. */
      if (Array.isArray(seg.words) && seg.words.length) {
        return seg.words.map(function (w) {
          return {
            w: String(w.w || w.word || '').trim(),
            s: typeof w.s === 'number' ? w.s : (typeof w.start === 'number' ? w.start : seg.startSec),
            e: typeof w.e === 'number' ? w.e : (typeof w.end === 'number' ? w.end : seg.endSec)
          };
        });
      }
      /* Fallback: равномерная интерполяция по всему сегменту.
         Точность ≈ ширина_сегмента / N_слов, обычно 0.2–0.4 с/слово.
         Это не идеально, но достаточно для семантической ориентации LLM. */
      var rawWords = String(seg.text).split(/\s+/).filter(Boolean);
      if (rawWords.length === 0) return null;
      var t0 = typeof seg.startSec === 'number' ? seg.startSec : 0;
      var t1 = typeof seg.endSec === 'number' ? seg.endSec : t0;
      var dur = Math.max(0, t1 - t0);
      if (dur === 0) return null;
      var per = dur / rawWords.length;
      var out = [];
      for (var wi = 0; wi < rawWords.length; wi++) {
        out.push({
          w: rawWords[wi],
          s: Math.round((t0 + wi * per) * 100) / 100,
          e: Math.round((t0 + (wi + 1) * per) * 100) / 100
        });
      }
      return out;
    }

    /* Разбиваем на чанки — только сегменты для LLM */
    var chunks = [];
    for (var ci = 0; ci < segmentsForLLM.length && chunks.length < ANALYSIS_MAX_CHUNKS; ci += ANALYSIS_CHUNK_SIZE) {
      var slice = segmentsForLLM.slice(ci, ci + ANALYSIS_CHUNK_SIZE);
      chunks.push(slice.map(function (s, idx) {
        var item = {
          i: llmOrigIdx[ci + idx],
          t0: s.startSec,
          t1: s.endSec,
          text: truncText(s.text)
        };
        /* Word-level grounding для длинных сегментов. */
        var wordCount = String(s.text || '').split(/\s+/).filter(Boolean).length;
        if (wordCount >= WORD_LEVEL_THRESHOLD) {
          var ws = synthesizeWords(s);
          if (ws && ws.length) item.words = ws;
        }
        return item;
      }));
    }

    var allLabels = [];
    /* failedChunks: список чанков, которые не удалось разобрать.
       Пробрасывается в _buildFinalResult и дальше в UI для видимого warning'а
       (раньше чанки молча игнорировались → пользователь получал неточное предложение). */
    var failedChunks = [];
    var totalChunks = chunks.length;

    onProgress({
      phase: 'start',
      totalSegments: segments.length,
      totalChunks: totalChunks,
      model: model,
      message: 'Анализ транскрипта: ' + segments.length + ' сегментов, ' + totalChunks + ' чанк(ов), модель ' + (model || '?')
    });

    /* Phase 1.5 (6 мая 2026): убран cross-chunk bridging — несовместим с
       параллельным chunking'ом (мы не знаем выход chunk N-1 при старте chunk N).
       На синтетических ×10 повторах bridging не дал улучшения качества (см.
       memory:feedback_glm47_real_call_findings); оставляем sticky-context простой —
       chunkIdx + segRange. */

    /* Phase 1.5 (6 мая 2026): per-role thinking + параллельный chunking.
       Per-chunk classification — простая задача, thinking тут overkill (3-5×
       latency, network transient'ы). Берём policy.analyze, fallback на
       enableThinking, default false. */
    var policyAnalyze = (settings.thinkingPolicy && typeof settings.thinkingPolicy.analyze === 'boolean')
      ? settings.thinkingPolicy.analyze
      : (typeof settings.enableThinking === 'boolean' ? settings.enableThinking : false);

    function processOneChunk(chunkObj) {
      var chunk = chunkObj.chunk;
      var thisChunkIdx = chunkObj.chunkIdx; /* 1-based для прогресса */

      onProgress({
        phase: 'chunk',
        chunkIndex: thisChunkIdx,
        totalChunks: totalChunks,
        segRange: chunk[0].i + '–' + chunk[chunk.length - 1].i,
        message: 'Анализ чанка ' + thisChunkIdx + '/' + totalChunks + ' (сегменты ' + chunk[0].i + '–' + chunk[chunk.length - 1].i + ')…'
      });

      /* Cross-chunk bridging при параллельном запуске не работает (мы не
         знаем выход chunk N-1 при старте chunk N). Оставляем "сухой"
         contextNote с информацией о позиции в последовательности. */
      var contextNote = '';
      if (thisChunkIdx > 1) {
        contextNote = '\n\n[Контекст: чанк ' + thisChunkIdx + ' из ' + totalChunks +
          '. Сегменты ' + chunk[0].i + '–' + chunk[chunk.length - 1].i + ' из ' + segments.length + '.]';
      }

      var userMsg = JSON.stringify({ segments: chunk }) + contextNote;

      var segStart = chunk[0].i;
      var segEnd = chunk[chunk.length - 1].i;

      return CC.chatCompletions({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: model,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userMsg }
        ],
        /* max_tokens 12000 — на случай если кто-то всё-таки включит thinking
           для analyze. На обычном (non-thinking) пути расходуется ~3-5K. */
        chatParams: {
          max_tokens: 12000,
          temperature: 0.1
        },
        responseFormat: 'json_object',
        enableThinking: policyAnalyze,
        signal: opt.signal,
        abortCheck: opt.abortCheck
      }).then(function (resp) {
        try {
          var content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
          if (!content) {
            failedChunks.push({
              chunkIndex: thisChunkIdx,
              segStart: segStart,
              segEnd: segEnd,
              reason: 'empty response'
            });
            /* Phase 1.6 (6 мая 2026): был dead reference `return processChunk()`
               после миграции на parallel pool — крашил Promise.all. Worker сам
               подхватит следующий chunk через worker().then(worker). */
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[analyzeForCutsWithLLM] empty content for chunk ' + thisChunkIdx);
            }
            return;
          }
          var m = String(content).match(/\{[\s\S]*\}/);
          if (!m) {
            failedChunks.push({
              chunkIndex: thisChunkIdx,
              segStart: segStart,
              segEnd: segEnd,
              reason: 'no JSON in response'
            });
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[analyzeForCutsWithLLM] no JSON match for chunk ' + thisChunkIdx +
                ' content_len=' + content.length);
            }
            return;
          }
          var j = JSON.parse(m[0]);
          var labels = (j && j.labels) || [];
          if (Array.isArray(labels)) {
            for (var li = 0; li < labels.length; li++) {
              var lb = labels[li];
              allLabels.push({
                i: typeof lb.i === 'number' ? lb.i : -1,
                label: String(lb.label || 'content').toLowerCase(),
                reason: String(lb.reason || '')
              });
            }
          }
          onProgress({
            phase: 'chunk_done',
            chunkIndex: thisChunkIdx,
            totalChunks: totalChunks,
            labelsInChunk: labels ? labels.length : 0,
            message: 'Чанк ' + thisChunkIdx + '/' + totalChunks + ' готов (' + (labels ? labels.length : 0) + ' меток)'
          });
        } catch (parseErr) {
          failedChunks.push({
            chunkIndex: thisChunkIdx,
            segStart: segStart,
            segEnd: segEnd,
            reason: 'parse error: ' + String(parseErr.message || parseErr)
          });
          onProgress({
            phase: 'chunk_error',
            chunkIndex: thisChunkIdx,
            error: String(parseErr.message || parseErr),
            message: 'Ошибка разбора чанка ' + thisChunkIdx + ': ' + String(parseErr.message || '')
          });
        }
      }, function (err) {
        failedChunks.push({
          chunkIndex: thisChunkIdx,
          segStart: segStart,
          segEnd: segEnd,
          reason: 'api error: ' + String(err && err.message || err)
        });
        onProgress({
          phase: 'chunk_error',
          chunkIndex: thisChunkIdx,
          error: String(err && err.message || err),
          message: 'Ошибка API чанка ' + thisChunkIdx + ': ' + String(err && err.message || '')
        });
      });
    }

    /* Phase 1.5: параллельный pool. concurrency = settings.analyzeConcurrency,
       default 1 (sequential). 3 — реалистичный компромисс. */
    var concurrency = (typeof settings.analyzeConcurrency === 'number' && settings.analyzeConcurrency > 0)
      ? Math.min(8, settings.analyzeConcurrency)
      : 1;

    var queue = chunks.map(function (chunk, i) {
      return { chunk: chunk, chunkIdx: i + 1 };
    });
    var nextIndex = 0;

    function worker() {
      if (nextIndex >= queue.length) return Promise.resolve();
      var item = queue[nextIndex++];
      return processOneChunk(item).then(worker);
    }

    var workers = [];
    for (var w = 0; w < Math.min(concurrency, queue.length); w++) {
      workers.push(worker());
    }

    return Promise.all(workers).then(function () {
      return _buildFinalResult(segments, preByIndex, allLabels, onProgress, chunks.length, failedChunks);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * resolveRefsToIntervals — P0-C: резолвер ссылок на абзацы/сегменты
   * в готовые {startSec, endSec} интервалы.
   *
   * refs: массив ссылок вида {paragraph: N} или
   *       {paragraph: N, sentenceFrom: a, sentenceTo: b} (зарезервировано).
   * paragraphs: массив абзацев из entry.paragraphs (каждый имеет startSec, endSec).
   *
   * Возвращает { intervals: [{startSec, endSec}], errors: [строки] }.
   * Невалидные ссылки (индекс вне диапазона, не число) попадают в errors,
   * валидные разворачиваются. Пустой refs → пустой intervals + без ошибок.
   *
   * Уровень предложений (sentenceFrom/sentenceTo) НЕ поддержан: абзацы не
   * разбиваются на предложения с собственными таймингами. Если передать
   * sentenceFrom/sentenceTo — вернётся весь абзац целиком + warning в errors.
   * ═══════════════════════════════════════════════════════════════════════ */
  function resolveRefsToIntervals(paragraphs, refs) {
    var intervals = [];
    var errors = [];
    if (!Array.isArray(refs) || !refs.length) return { intervals: intervals, errors: errors };
    if (!Array.isArray(paragraphs) || !paragraphs.length) {
      errors.push('paragraphs пуст — невозможно развернуть ссылки');
      return { intervals: intervals, errors: errors };
    }
    var pLen = paragraphs.length;
    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i];
      if (!ref || typeof ref !== 'object') {
        errors.push('refs[' + i + ']: не объект');
        continue;
      }
      var pIdx = ref.paragraph;
      if (typeof pIdx !== 'number' || isNaN(pIdx) || pIdx !== Math.floor(pIdx)) {
        errors.push('refs[' + i + ']: paragraph должен быть целым числом, получено ' + String(pIdx));
        continue;
      }
      if (pIdx < 0 || pIdx >= pLen) {
        errors.push('refs[' + i + ']: paragraph=' + pIdx + ' вне диапазона 0–' + (pLen - 1));
        continue;
      }
      var p = paragraphs[pIdx];
      if (!p || typeof p.startSec !== 'number' || typeof p.endSec !== 'number') {
        errors.push('refs[' + i + ']: абзац ' + pIdx + ' не имеет startSec/endSec');
        continue;
      }
      /* Уровень предложений: зарезервирован, не поддержан (абзацы не имеют sub-timing) */
      if (typeof ref.sentenceFrom === 'number' || typeof ref.sentenceTo === 'number') {
        errors.push('refs[' + i + ']: sentenceFrom/sentenceTo не поддержан — используется весь абзац ' + pIdx);
      }
      intervals.push({
        startSec: p.startSec,
        endSec: p.endSec,
        reason: typeof ref.reason === 'string' ? ref.reason : undefined
      });
    }
    /* Сортировка + merge перекрывающихся/смежных интервалов.
       На мультиспикерных (синхронизированных) секвенциях соседние абзацы
       перекрываются во времени, поэтому refs в исходном порядке дают
       перекрывающиеся интервалы. validateTranscriptCuts отклоняет такие
       ещё ДО padding/merge-шага, и монтаж не может выдать карточку.
       Сливаем в источнике: удаляемый регион = объединение абзацев. */
    if (intervals.length > 1) {
      var MERGE_EPS = 0.05; /* > EPS валидатора (0.01), чтобы гарантированно снять перекрытие */
      intervals.sort(function (a, b) { return a.startSec - b.startSec; });
      var mergedIntervals = [intervals[0]];
      for (var m = 1; m < intervals.length; m++) {
        var cur = intervals[m];
        var last = mergedIntervals[mergedIntervals.length - 1];
        if (cur.startSec <= last.endSec + MERGE_EPS) {
          if (cur.endSec > last.endSec) last.endSec = cur.endSec;
          if (last.reason === undefined && cur.reason !== undefined) last.reason = cur.reason;
        } else {
          mergedIntervals.push(cur);
        }
      }
      intervals = mergedIntervals;
    }
    return { intervals: intervals, errors: errors };
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * МОНТАЖ ПО СМЫСЛАМ v2 — воркер разметки абзацев (2-я модель, чанки).
   * Зеркалит analyzeForCutsWithLLM (чанкинг, CC.chatCompletions, abort/onProgress),
   * но вход — АБЗАЦЫ {i,startSec,endSec,text}, выход на абзац —
   * {i, importance(0-3), role(валидный или 'argument'), theme, blockId}.
   * ═══════════════════════════════════════════════════════════════════════ */
  var MONTAGE_ROLES = { hook: 1, argument: 1, example: 1, payoff: 1, repeat: 1, filler: 1, offtopic: 1 };

  function parseMontageChunk(content, segStart, segEnd) {
    if (!content) return [];
    var m = String(content).match(/\{[\s\S]*\}/);
    if (!m) return [];
    var j;
    try { j = JSON.parse(m[0]); } catch (e) { return []; }
    var arr = (j && j.blocks) || [];
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var k = 0; k < arr.length; k++) {
      var b = arr[k];
      if (!b || typeof b.i !== 'number') continue;
      var imp = Math.round(b.importance);
      if (!(imp >= 0)) imp = 1;
      if (imp > 3) imp = 3;
      if (imp < 0) imp = 0;
      var role = String(b.role || 'argument').toLowerCase();
      if (!MONTAGE_ROLES[role]) role = 'argument';
      out.push({
        i: b.i, importance: imp, role: role,
        theme: String(b.theme || ''),
        blockId: String(b.blockId || ('b' + b.i))
      });
    }
    return out;
  }

  /**
   * @param {string} [referenceScript] — C1 (28.07.2026, AutoCut-паритет «Reference Script»):
   *   эталонный сценарий/план ролика от пользователя. Если задан — importance
   *   ставится по СООТВЕТСТВИЮ сценарию, а не по общей «важности».
   */
  function buildMontageSystemPrompt(referenceScript) {
    var refBlock = [];
    var ref = String(referenceScript || '').replace(/^\s+|\s+$/g, '');
    if (ref) {
      refBlock = [
        '',
        'ЭТАЛОННЫЙ СЦЕНАРИЙ. Пользователь дал сценарий/план готового ролика. Оценивай абзацы',
        'ПО СООТВЕТСТВИЮ ЭТОМУ СЦЕНАРИЮ, а не по абстрактной важности:',
        '• importance 3 — абзац напрямую покрывает пункт сценария (та же мысль, пусть другими словами);',
        '• importance 2 — поддерживает пункт сценария (пример/деталь к нему);',
        '• importance 1 — нейтральное, в сценарии не упомянуто;',
        '• importance 0 — противоречит сценарию или явный офтоп относительно него (role: offtopic).',
        'Если мысль сценария встречается в материале НЕСКОЛЬКО раз (дубли) — importance 3 только',
        'лучшему заходу, остальным role: repeat и importance ниже.',
        'СЦЕНАРИЙ:',
        '«' + ref.slice(0, 4000) + '»'
      ];
    }
    return [
      'Ты — ассистент видеомонтажёра. Дан список АБЗАЦЕВ транскрипта.',
      'Каждый абзац: {i: индекс, t0: начало (сек), t1: конец (сек), text: текст}.',
      'Задача: оцени вклад КАЖДОГО абзаца в СУТЬ материала. НЕ считай секунды.',
      'Для каждого абзаца верни:',
      '• importance: 0=мусор/паразиты, 1=проходное, 2=важное, 3=ядро смысла (без него теряется суть).',
      '  ВАЖНО: если автор голосом ВЫДЕЛЯЕТ момент («смотрите», «обратите внимание», «вот тут», ',
      '  «представьте», «запомните», «самое главное», «а теперь») — подними importance на 1 (это ',
      '  ключевой момент, даже если сам по себе абзац звучит спокойно; интонационные акценты часто ',
      '  теряются при отборе по «энергии речи»).',
      '• role: hook (завязка) | argument (мысль/факт) | example (пример/история) | payoff (вывод/кульминация) | repeat (повтор сказанного) | filler (вода/паразиты) | offtopic (офтоп).',
      '• theme: роль абзаца в истории, 3-6 слов.',
      '• blockId: соседние абзацы ОДНОЙ мысли объединяй одним blockId (например "b3").',
      '  Новая мысль — новый blockId. Это нужно чтобы монтаж резал по смысловым границам.',
      '  Абзац, НАЧИНАЮЩИЙСЯ с союза-связки («но», «и», «а», «поэтому», «потому что», «то есть», ',
      '  «значит», «так вот») — это ПРОДОЛЖЕНИЕ предыдущей мысли: дай ему ТОТ ЖЕ blockId, что и у ',
      '  предыдущего абзаца, не открывай новый блок. Так рез не начнётся и не оборвётся на висячем ',
      '  союзе (сохраняем целые мысли, без хвоста).',
      '',
      'ФОРМАТ — строго JSON, без markdown:',
      '{"blocks":[{"i":0,"importance":3,"role":"hook","theme":"Завязка спора","blockId":"b0"},...]}',
      'Верни ВСЕ абзацы из входа. Ни один не пропускай.'
    ].concat(refBlock).join('\n');
  }

  /**
   * labelMontageBlocks(paragraphs, opt) → Promise<{labeled:Array, chunks, failedChunks}>
   * opt: { settings, CloudRuClient, signal, abortCheck, onProgress? }
   * Зеркалит чанкинг analyzeForCutsWithLLM, но на уровне абзацев.
   */
  function labelMontageBlocks(paragraphs, opt) {
    opt = opt || {};
    var settings = opt.settings || {};
    var CC = opt.CloudRuClient || global.CloudRuClient;
    var onProgress = typeof opt.onProgress === 'function' ? opt.onProgress : function () {};
    var model = settings.analysisModel || settings.activeAgentModel || settings.chatModel;

    if (!CC || !CC.chatCompletions) return Promise.reject(new Error('CloudRuClient недоступен'));
    if (!paragraphs || !paragraphs.length) return Promise.resolve({ labeled: [], chunks: 0, failedChunks: [] });

    var CHUNK = ANALYSIS_CHUNK_SIZE; /* переиспользуем константу */
    var chunks = [];
    for (var ci = 0; ci < paragraphs.length && chunks.length < ANALYSIS_MAX_CHUNKS; ci += CHUNK) {
      var slice = paragraphs.slice(ci, ci + CHUNK);
      chunks.push(slice.map(function (p, idx) {
        return { i: (typeof p.i === 'number' ? p.i : (ci + idx)), t0: p.startSec, t1: p.endSec,
                 text: String(p.text || '').slice(0, 600) };
      }));
    }

    var sysPrompt = buildMontageSystemPrompt(opt.referenceScript);
    var all = [];
    var failedChunks = [];
    var total = chunks.length;
    onProgress({ phase: 'start', totalChunks: total, message: 'Разметка смыслов: ' + paragraphs.length + ' абзацев, ' + total + ' чанк(ов)' });

    function processOne(idx) {
      if (idx >= chunks.length) return Promise.resolve();
      if (opt.abortCheck && opt.abortCheck()) return Promise.resolve();
      var chunk = chunks[idx];
      var segStart = chunk[0].i, segEnd = chunk[chunk.length - 1].i;
      onProgress({ phase: 'chunk', chunkIndex: idx + 1, totalChunks: total,
        message: 'Разметка чанка ' + (idx + 1) + '/' + total + ' (абзацы ' + segStart + '–' + segEnd + ')…' });
      return CC.chatCompletions({
        baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: model,
        messages: [ { role: 'system', content: sysPrompt }, { role: 'user', content: JSON.stringify({ paragraphs: chunk }) } ],
        chatParams: { max_tokens: 8000, temperature: 0.1 },
        responseFormat: 'json_object', enableThinking: false,
        signal: opt.signal, abortCheck: opt.abortCheck
      }).then(function (resp) {
        var content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
        var parsed = parseMontageChunk(content, segStart, segEnd);
        if (!parsed.length) failedChunks.push({ chunkIndex: idx + 1, segStart: segStart, segEnd: segEnd });
        for (var q = 0; q < parsed.length; q++) all.push(parsed[q]);
        onProgress({ phase: 'chunk_done', chunkIndex: idx + 1, totalChunks: total });
        return processOne(idx + 1);
      }, function (err) {
        failedChunks.push({ chunkIndex: idx + 1, segStart: segStart, segEnd: segEnd, reason: String(err && err.message || err) });
        return processOne(idx + 1);
      });
    }

    return processOne(0).then(function () {
      onProgress({ phase: 'done', totalChunks: total });
      return { labeled: all, chunks: total, failedChunks: failedChunks };
    });
  }

  // ──────────────────────────────────────────────────────────
  // Калибровка блоков: глобальный re-rank после локальной разметки.
  // applyCalibration / fallbackCalibration — чистые; calibrateMontageBlocks —
  // один LLM-вызов на СВОДКУ блоков, с fallback на эвристику.
  // ──────────────────────────────────────────────────────────
  function applyCalibration(labeled, calib) {
    var byBlock = {};
    for (var c = 0; c < (calib || []).length; c++) {
      var cc = calib[c];
      if (cc && cc.blockId) byBlock[cc.blockId] = cc;
    }
    for (var i = 0; i < labeled.length; i++) {
      var adj = byBlock[labeled[i].blockId];
      if (!adj) continue;
      if (typeof adj.importance === 'number') {
        var im = Math.round(adj.importance); if (im > 3) im = 3; if (im < 0) im = 0;
        labeled[i].importance = im;
      }
      if (adj.protect === 'start' || adj.protect === 'end') labeled[i].protect = adj.protect;
    }
    return labeled;
  }

  function fallbackCalibration(labeled) {
    /* Первый и последний блок с importance>=2 → protect start/end */
    var firstBlock = null, lastBlock = null;
    for (var i = 0; i < labeled.length; i++) {
      if (labeled[i].importance >= 2) { if (firstBlock === null) firstBlock = labeled[i].blockId; lastBlock = labeled[i].blockId; }
    }
    for (var j = 0; j < labeled.length; j++) {
      if (firstBlock && labeled[j].blockId === firstBlock && !labeled[j].protect) labeled[j].protect = 'start';
      if (lastBlock && labeled[j].blockId === lastBlock && !labeled[j].protect) labeled[j].protect = 'end';
    }
    return labeled;
  }

  /**
   * calibrateMontageBlocks(labeled, entry, opt) → Promise<labeled (с protect + скорр. importance)>
   * Один LLM-вызов на СВОДКУ блоков. Fallback на эвристику при сбое.
   * opt: { settings, CloudRuClient, signal, abortCheck }
   */
  function calibrateMontageBlocks(labeled, entry, opt) {
    opt = opt || {};
    var CC = opt.CloudRuClient || global.CloudRuClient;
    var settings = opt.settings || {};
    var model = settings.analysisModel || settings.activeAgentModel || settings.chatModel;
    if (!labeled || !labeled.length) return Promise.resolve(labeled || []);
    if (!CC || !CC.chatCompletions) return Promise.resolve(fallbackCalibration(labeled));

    /* Сводка по блокам: blockId → {theme, role(доминирующий), importance(max), durationSec, startSec} */
    var order = [], byId = {};
    var paras = (entry && entry.paragraphs) || [];
    for (var i = 0; i < labeled.length; i++) {
      var L = labeled[i]; var p = paras[L.i]; var d = p ? (p.endSec - p.startSec) : 0;
      if (!byId[L.blockId]) { byId[L.blockId] = { blockId: L.blockId, theme: L.theme, role: L.role, importance: L.importance, durationSec: 0, startSec: p ? p.startSec : 0 }; order.push(L.blockId); }
      var g = byId[L.blockId]; g.durationSec += d;
      if (L.importance > g.importance) g.importance = L.importance;
    }
    var summary = order.map(function (id) { return byId[id]; });

    var calibRef = String(opt.referenceScript || '').replace(/^\s+|\s+$/g, '');
    var sys = [
      'Тебе дана СВОДКА смысловых блоков видео (без полного текста).',
      'Каждый блок: {blockId, theme, role, importance (0-3), durationSec, startSec}.',
      'Задача: откалибруй importance ГЛОБАЛЬНО (баллы ставились по частям, теперь ты видишь целое).',
      'Подними ядро истории и опусти проходное. Пометь protect:"start" у завязки и protect:"end" у финала/вывода.'
    ].concat(calibRef ? [
      /* C1: баллы уже стоят ПО СЦЕНАРИЮ — калибровка не должна «возвращать» офтоп */
      'ВАЖНО: баллы ставились по соответствию эталонному сценарию пользователя. НЕ поднимай блоки,',
      'которых нет в сценарии, даже если сами по себе они яркие. СЦЕНАРИЙ (сокращённо):',
      '«' + calibRef.slice(0, 1500) + '»'
    ] : []).concat([
      'ФОРМАТ строго JSON: {"calib":[{"blockId":"b0","importance":3,"protect":"start"},...]}. Верни только изменённые/ключевые блоки.'
    ]).join('\n');

    return CC.chatCompletions({
      baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: model,
      messages: [ { role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ blocks: summary }) } ],
      chatParams: { max_tokens: 4000, temperature: 0.1 },
      responseFormat: 'json_object', enableThinking: false,
      signal: opt.signal, abortCheck: opt.abortCheck
    }).then(function (resp) {
      var content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
      var m = content && String(content).match(/\{[\s\S]*\}/);
      if (!m) return fallbackCalibration(labeled);
      var j; try { j = JSON.parse(m[0]); } catch (e) { return fallbackCalibration(labeled); }
      var calib = (j && j.calib) || [];
      if (!Array.isArray(calib) || !calib.length) return fallbackCalibration(labeled);
      return applyCalibration(labeled, calib);
    }, function () { return fallbackCalibration(labeled); });
  }

  /* ── C4 (2026-07-28, AutoCut-паритет): viral-скоринг кандидатов ────────
     Пресеты промпта (5, как у AutoViral) + кастом. Кандидаты — окна из
     соседних абзацев ~целевой длины; каждому — оценки Hook/Retention/Emotion
     и объяснение «почему». Никакого apply: результат только информирует
     (плейхед, In/Out, маркеры) — решение за монтажёром. */
  var VIRAL_PRESETS = [
    { id: 'universal', label: 'Универсальный', focus: 'Сбалансированно: сильный хук, самодостаточная мысль, эмоция.' },
    { id: 'hook', label: 'Хук (первые 3 сек)', focus: 'Главное — первые 1-2 фразы окна: интрига, провокация, неожиданный факт, вопрос. Окно без мгновенного хука — низкий балл.' },
    { id: 'emotions', label: 'Эмоции', focus: 'Главное — эмоциональный накал: смех, спор, восторг, возмущение, личные истории. Ровное изложение — низкий балл.' },
    { id: 'engagement', label: 'Вовлечение/споры', focus: 'Главное — потенциал комментариев и споров: спорные тезисы, «непопулярное мнение», вопросы к зрителю, советы с несогласием.' },
    { id: 'story', label: 'История/арка', focus: 'Главное — законченная мини-история: завязка → поворот → развязка внутри окна. Обрывки без развязки — низкий балл.' }
  ];

  /**
   * Чистая пост-обработка ответа LLM (тестируемая): валидация, клампы,
   * сортировка по total, обрезка до maxCandidates, отсев дублей-перекрытий.
   * @param {Array} raw — j.candidates из ответа модели
   * @param {{durationSec:number, maxCandidates:number}} o
   */
  function normalizeViralCandidates(raw, o) {
    o = o || {};
    var dur = typeof o.durationSec === 'number' && o.durationSec > 0 ? o.durationSec : null;
    var maxN = typeof o.maxCandidates === 'number' && o.maxCandidates > 0 ? o.maxCandidates : 5;
    if (!Array.isArray(raw)) return [];
    function clampScore(v) {
      var n = Number(v);
      if (isNaN(n)) return 0;
      return Math.max(0, Math.min(10, Math.round(n)));
    }
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (!c) continue;
      var s = Number(c.startSec), e = Number(c.endSec);
      if (isNaN(s) || isNaN(e)) continue;
      if (s < 0) s = 0;
      if (dur !== null && e > dur + 0.5) e = dur;
      if (e - s < 3) continue; /* короче 3с — не клип */
      var sc = c.scores || {};
      var hook = clampScore(sc.hook), ret = clampScore(sc.retention), emo = clampScore(sc.emotion);
      out.push({
        startSec: Math.round(s * 100) / 100,
        endSec: Math.round(e * 100) / 100,
        title: String(c.title || '').slice(0, 80),
        why: String(c.why || '').slice(0, 300),
        scores: { hook: hook, retention: ret, emotion: emo },
        total: hook + ret + emo
      });
    }
    out.sort(function (a, b) { return b.total - a.total; });
    /* Отсев сильных перекрытий (>50% меньшего окна) — оставляем сильнейший. */
    var kept = [];
    for (var k = 0; k < out.length && kept.length < maxN; k++) {
      var cand = out[k], overlapped = false;
      for (var j = 0; j < kept.length; j++) {
        var ov = Math.min(cand.endSec, kept[j].endSec) - Math.max(cand.startSec, kept[j].startSec);
        var minLen = Math.min(cand.endSec - cand.startSec, kept[j].endSec - kept[j].startSec);
        if (ov > 0 && minLen > 0 && ov / minLen > 0.5) { overlapped = true; break; }
      }
      if (!overlapped) kept.push(cand);
    }
    return kept;
  }

  /**
   * scoreViralMomentsWithLLM(paragraphs, opt) → Promise<[{startSec,endSec,title,why,scores,total}]>
   * opt: { settings, CloudRuClient, presetId, customPrompt, targetLenSec,
   *        maxCandidates, signal, abortCheck }
   */
  function scoreViralMomentsWithLLM(paragraphs, opt) {
    opt = opt || {};
    var settings = opt.settings || {};
    var CC = opt.CloudRuClient || global.CloudRuClient;
    if (!CC || !paragraphs || !paragraphs.length) return Promise.resolve([]);
    var targetLen = typeof opt.targetLenSec === 'number' && opt.targetLenSec >= 10 ? opt.targetLenSec : 45;
    var maxN = typeof opt.maxCandidates === 'number' && opt.maxCandidates > 0 ? opt.maxCandidates : 5;
    var preset = VIRAL_PRESETS[0];
    for (var pi = 0; pi < VIRAL_PRESETS.length; pi++) {
      if (VIRAL_PRESETS[pi].id === opt.presetId) { preset = VIRAL_PRESETS[pi]; break; }
    }
    var compact = paragraphs.map(function (p, idx) {
      var words = String(p.text || '').split(/\s+/).slice(0, 60).join(' ');
      return {
        i: idx,
        t0: Math.round((p.startSec || 0) * 10) / 10,
        t1: Math.round((p.endSec || 0) * 10) / 10,
        text: words + (p.text && p.text.split(/\s+/).length > 60 ? '…' : '')
      };
    });
    var durationSec = paragraphs[paragraphs.length - 1].endSec || 0;
    var sysMsg =
      'Ты — продюсер коротких вертикальных видео (Reels/Shorts). ' +
      'На входе — абзацы расшифровки ролика с таймкодами (секунды таймлайна). ' +
      'Найди до ' + maxN + ' лучших фрагментов-кандидатов длиной ~' + targetLen + ' сек ' +
      '(допустимо ' + Math.round(targetLen * 0.6) + '–' + Math.round(targetLen * 1.6) + ' сек). ' +
      'Границы фрагмента — СТРОГО по границам абзацев (t0 первого, t1 последнего), фрагмент должен быть самодостаточным (понятен без остального ролика). ' +
      'Критерий отбора: ' + preset.focus + ' ' +
      'Каждому кандидату поставь оценки 0–10: hook (цепляет ли первая фраза), retention (удержит ли до конца), emotion (эмоциональный заряд). ' +
      'Поле why — 1-2 предложения ПО-РУССКИ: почему фрагмент сработает и с чего он начинается. ' +
      'Возвращай СТРОГО JSON {"candidates":[{"startSec":N,"endSec":N,"title":"3-6 слов","why":"…","scores":{"hook":N,"retention":N,"emotion":N}}]}. Без markdown.';
    var customIx = String(opt.customPrompt || '').replace(/^\s+|\s+$/g, '');
    if (customIx) {
      sysMsg += ' Дополнительные указания монтажёра (следуй им, если не противоречат формату ответа): ' +
        customIx.slice(0, 500);
    }
    return CC.chatCompletions({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.findMomentsModel || settings.chapterModel || settings.analysisModel || settings.chatModel,
      messages: [
        { role: 'system', content: sysMsg },
        { role: 'user', content: JSON.stringify({ paragraphs: compact }) }
      ],
      chatParams: { max_tokens: Math.min(16000, 6000 + Math.floor(paragraphs.length * 20)), temperature: 0.3 },
      responseFormat: 'json_object',
      enableThinking: (settings.thinkingPolicy && typeof settings.thinkingPolicy.chapter === 'boolean')
        ? settings.thinkingPolicy.chapter
        : settings.enableThinking,
      signal: opt.signal,
      abortCheck: opt.abortCheck
    }).then(function (resp) {
      try {
        var choice = resp && resp.choices && resp.choices[0];
        var content = choice && choice.message && choice.message.content;
        if (!content) return [];
        var m = String(content).match(/\{[\s\S]*\}/);
        if (!m) return [];
        var j;
        try { j = JSON.parse(m[0]); } catch (ePv) { return []; }
        return normalizeViralCandidates(j && j.candidates, {
          durationSec: durationSec,
          maxCandidates: maxN
        });
      } catch (e) {
        return [];
      }
    }, function () { return []; });
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * СНЭППИНГ К РЕЧЕВЫМ ОНСЕТАМ (05.08.2026)
   *
   * Проблема, найденная живым замером на 4 секвенциях: таймкоды Whisper — НЕ
   * акустические. На невнятных участках модель квантует границы к целым
   * секундам (8–12% границ на часовых уроках, 62% на коротком клипе). Глава
   * садится на такую границу и попадает в середину фразы: замер «расстояние от
   * главы до ближайшей ИЗМЕРЕННОЙ паузы» дал медиану 1.4–5.0с и хвост до 34.9с.
   *
   * При этом точность ±10мс у нас уже есть — audioAnalysis.silences (ffmpeg
   * silencedetect, минимум 0.5с). Конец паузы = момент, когда речь возобновилась,
   * то есть настоящее начало фразы. Именно туда и должен встать маркер.
   *
   * Так же работают «Тишины» и «Jump cuts» — они режут по измеренному RMS.
   * Главы и виральные моменты были единственными, кто верил Whisper на слово.
   * ═══════════════════════════════════════════════════════════════════════ */

  var SNAP_MAX_BACK_SEC = 3.0;  /* назад — щедро: типичная ошибка квантования 1–3с */
  var SNAP_MAX_FWD_SEC = 0.5;   /* вперёд — скупо: лучше начать раньше, чем срезать фразу */

  function round3(v) { return Math.round(v * 1000) / 1000; }

  /**
   * snapToSpeechOnset(timeSec, silences, opts)
   *   → {timeSec, driftSec, inGap} | null (снэпить некуда — оставить как есть)
   *
   * silences: [{startSec, endSec}] в координатах ТАЙМЛАЙНА (как их кладёт
   * computeAudioPreprocess — оффсет там уже применён).
   */
  function snapToSpeechOnset(timeSec, silences, opts) {
    opts = opts || {};
    var maxBack = typeof opts.maxBackSec === 'number' ? opts.maxBackSec : SNAP_MAX_BACK_SEC;
    var maxFwd = typeof opts.maxFwdSec === 'number' ? opts.maxFwdSec : SNAP_MAX_FWD_SEC;
    if (typeof timeSec !== 'number') return null;
    var t = timeSec;
    if (!isFinite(t) || t < 0) return null;
    if (!silences || !silences.length) return null;
    /* Ноль не двигаем: почти любая запись начинается с комнатного тона, а
       первая глава обязана стоять на 0:00 (требование YouTube-глав). */
    if (t <= 0.05) return null;

    var best = null;
    for (var i = 0; i < silences.length; i++) {
      var s = silences[i];
      if (!s) continue;
      var a = Number(typeof s.startSec === 'number' ? s.startSec : s.start);
      var b = Number(typeof s.endSec === 'number' ? s.endSec : s.end);
      if (!isFinite(a) || !isFinite(b) || b < a) continue;
      /* Время попало ВНУТРЬ паузы — речь начинается в её конце. Это точный
         ответ, окна допуска здесь не применяем. */
      if (t >= a && t <= b) return { timeSec: round3(b), driftSec: round3(b - t), inGap: true };
      var d = b - t; /* >0 — онсет впереди, <0 — позади */
      if (d > maxFwd || -d > maxBack) continue;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { v: b, d: d };
    }
    if (!best) return null;
    return { timeSec: round3(best.v), driftSec: round3(best.d), inGap: false };
  }

  /**
   * snapMarkersToSpeech(markers, silences, opts) → {markers, snappedCount, maxDriftSec}
   *
   * Не мутирует вход. Сохраняет строгий порядок: если снэп поставил бы маркер
   * не позже предыдущего, откатываем его к исходному времени — лучше неточный
   * маркер, чем два в одной точке или перепутанный порядок глав.
   */
  function snapMarkersToSpeech(markers, silences, opts) {
    var list = Array.isArray(markers) ? markers : [];
    if (!list.length || !silences || !silences.length) {
      return { markers: list, snappedCount: 0, maxDriftSec: 0 };
    }
    var out = [];
    var snapped = 0;
    var maxDrift = 0;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || typeof m.timeSec !== 'number') { out.push(m); continue; }
      var hit = snapToSpeechOnset(m.timeSec, silences, opts);
      if (!hit) { out.push(m); continue; }
      var prev = out.length ? out[out.length - 1] : null;
      if (prev && typeof prev.timeSec === 'number' && hit.timeSec <= prev.timeSec) {
        out.push(m);
        continue;
      }
      var copy = {};
      for (var k in m) { if (Object.prototype.hasOwnProperty.call(m, k)) copy[k] = m[k]; }
      copy.timeSec = hit.timeSec;
      copy.snappedFromSec = m.timeSec;
      out.push(copy);
      snapped++;
      if (Math.abs(hit.driftSec) > maxDrift) maxDrift = Math.abs(hit.driftSec);
    }
    return { markers: out, snappedCount: snapped, maxDriftSec: round3(maxDrift) };
  }

  /* ═══ ВЕРИФИКАЦИЯ ГРАНИЦ СЕГМЕНТОВ В ИСТОЧНИКЕ (спека 06.08.2026) ═══
   * Таймкоды Whisper — не акустические (квантование к целым секундам).
   * Сверяем КАЖДУЮ границу сегмента с плотной картой пауз (silencedetect
   * d=0.15, ±10мс) один раз при создании транскрипта — все потребители
   * (paragraphs, topics, главы, резы, монтаж) наследуют исправленные времена.
   *
   * Правило асимметричное — «никогда не сжимать речь»:
   *   начало → к онсету (конец паузы): назад щедро (1.0с), вперёд скупо (0.25с);
   *   конец  → к оффсету (начало паузы): вперёд щедро (1.0с), назад скупо (0.25с).
   * Граница без измеримого края речи в окне не двигается и остаётся
   * verified=false — честно «проверить нечем» (политика «метить и защищать»). */

  var VERIFY_WIDE_SEC = 1.0;    /* окно в сторону расширения речи */
  var VERIFY_NARROW_SEC = 0.25; /* окно в сторону сжатия речи */
  var VERIFY_MIN_SEG_SEC = 0.05;

  /* Ближайший край речи для границы t.
   * kind='onset' — речь начинается (конец паузы), kind='offset' — речь
   * кончается (начало паузы). wide/narrow — допуски по направлениям:
   * для onset «назад» = wide, для offset «вперёд» = wide.
   * Возврат {timeSec, inGap} | null. */
  function _nearestSpeechEdge(t, silences, kind, wide, narrow) {
    var best = null;
    /* Перф: silences отсортированы вызывающим (verifySegmentBoundaries);
       релевантны лишь паузы в окне ±win вокруг t — бинпоиск + ранний выход. */
    var win = wide > narrow ? wide : narrow;
    for (var i = firstSilenceEndingAfter(silences, t - win); i < silences.length; i++) {
      var s = silences[i];
      if (!s) continue;
      var a = Number(typeof s.startSec === 'number' ? s.startSec : s.start);
      var b = Number(typeof s.endSec === 'number' ? s.endSec : s.end);
      if (!isFinite(a) || !isFinite(b) || b < a) continue;
      if (a > t + win) break; /* дальше паузы только позже — не релевантны */
      /* Граница внутри паузы — точный ответ без окон: речь возобновляется
         в её конце (onset) / закончилась в её начале (offset). */
      if (t >= a && t <= b) return { timeSec: kind === 'onset' ? b : a, inGap: true };
      var edge = kind === 'onset' ? b : a;
      var d = edge - t; /* >0 — край впереди */
      var limFwd = kind === 'onset' ? narrow : wide;
      var limBack = kind === 'onset' ? wide : narrow;
      if (d > limFwd || -d > limBack) continue;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { v: edge, d: d };
    }
    return best ? { timeSec: best.v, inGap: false } : null;
  }

  /**
   * Верифицирует границы всех сегментов по плотной карте пауз.
   * Не мутирует вход. Инварианты (порядок, непересечение, min-длительность)
   * охраняются: ломающий их снэп откатывается, граница остаётся unverified.
   * @returns {{segments: Array, stats: {total, startsVerified, endsVerified,
   *            verifiedPct, adjustedCount, maxDriftSec}}}
   */
  function verifySegmentBoundaries(segments, silencesDense, opts) {
    opts = opts || {};
    var wide = typeof opts.wideSec === 'number' ? opts.wideSec : VERIFY_WIDE_SEC;
    var narrow = typeof opts.narrowSec === 'number' ? opts.narrowSec : VERIFY_NARROW_SEC;
    var list = Array.isArray(segments) ? segments : [];
    /* Сортированная копия — контракт бинпоиска в _nearestSpeechEdge. */
    var sil = (Array.isArray(silencesDense) ? silencesDense : []).slice()
      .sort(function (x, y) {
        var xa = x ? Number(typeof x.startSec === 'number' ? x.startSec : x.start) : 0;
        var ya = y ? Number(typeof y.startSec === 'number' ? y.startSec : y.start) : 0;
        return (isFinite(xa) ? xa : 0) - (isFinite(ya) ? ya : 0);
      });
    if (!list.length || !sil.length) {
      return {
        segments: list,
        stats: { total: list.length, startsVerified: 0, endsVerified: 0, verifiedPct: 0, adjustedCount: 0, maxDriftSec: 0 }
      };
    }
    var out = [];
    var sVer = 0, eVer = 0, adjusted = 0, maxDrift = 0;
    var prevEnd = -Infinity; /* скорректированный конец предыдущего сегмента */
    for (var i = 0; i < list.length; i++) {
      var seg = list[i];
      var copy = {};
      for (var k in seg) { if (Object.prototype.hasOwnProperty.call(seg, k)) copy[k] = seg[k]; }
      var s0 = Number(typeof seg.startSec === 'number' ? seg.startSec : seg.start);
      var e0 = Number(typeof seg.endSec === 'number' ? seg.endSec : seg.end);
      if (!isFinite(s0) || !isFinite(e0) || e0 <= s0) { out.push(copy); prevEnd = isFinite(e0) ? e0 : prevEnd; continue; }
      var nextStart = null;
      for (var j = i + 1; j < list.length; j++) {
        var ns = Number(typeof list[j].startSec === 'number' ? list[j].startSec : list[j].start);
        if (isFinite(ns)) { nextStart = ns; break; }
      }

      var newS = s0, newE = e0, sOk = false, eOk = false;

      /* Начало: ноль не трогаем (запись начинается с комнатного тона). */
      if (s0 > 0.05) {
        var hitS = _nearestSpeechEdge(s0, sil, 'onset', wide, narrow);
        if (hitS && hitS.timeSec >= prevEnd && hitS.timeSec < e0 - VERIFY_MIN_SEG_SEC) {
          newS = round3(hitS.timeSec);
          sOk = true;
        }
      }

      /* Конец: вперёд — не дальше начала следующего сегмента (lookahead —
         иначе рез уедет в чужую речь и сломает порядок). */
      var hitE = _nearestSpeechEdge(e0, sil, 'offset', wide, narrow);
      if (hitE && hitE.timeSec > newS + VERIFY_MIN_SEG_SEC &&
          (nextStart == null || hitE.timeSec <= nextStart)) {
        newE = round3(hitE.timeSec);
        eOk = true;
      }

      if (sOk || eOk) {
        var dS = Math.abs(newS - s0), dE = Math.abs(newE - e0);
        if (dS > maxDrift) maxDrift = dS;
        if (dE > maxDrift) maxDrift = dE;
        if (dS > 0.0005 || dE > 0.0005) adjusted++;
      }
      copy.startSec = newS;
      copy.endSec = newE;
      copy.startVerified = sOk;
      copy.endVerified = eOk;
      if (sOk) sVer++;
      if (eOk) eVer++;
      out.push(copy);
      prevEnd = newE;
    }
    return {
      segments: out,
      stats: {
        total: list.length,
        startsVerified: sVer,
        endsVerified: eVer,
        verifiedPct: Math.round(((sVer + eVer) / (2 * list.length)) * 100),
        adjustedCount: adjusted,
        maxDriftSec: round3(maxDrift)
      }
    };
  }

  global.TranscriptStructure = {
    verifySegmentBoundaries: verifySegmentBoundaries,
    snapToSpeechOnset: snapToSpeechOnset,
    snapMarkersToSpeech: snapMarkersToSpeech,
    buildParagraphs: buildParagraphs,
    buildSpeakers: buildSpeakers,
    buildTopicsWithLLM: buildTopicsWithLLM,
    VIRAL_PRESETS: VIRAL_PRESETS,
    normalizeViralCandidates: normalizeViralCandidates,
    scoreViralMomentsWithLLM: scoreViralMomentsWithLLM,
    analyzeForCutsWithLLM: analyzeForCutsWithLLM,
    parseMontageChunk: parseMontageChunk,
    buildMontageSystemPrompt: buildMontageSystemPrompt,
    labelMontageBlocks: labelMontageBlocks,
    applyCalibration: applyCalibration,
    fallbackCalibration: fallbackCalibration,
    calibrateMontageBlocks: calibrateMontageBlocks,
    buildStructure: buildStructure,
    isParagraphsStale: isParagraphsStale,
    resolveRefsToIntervals: resolveRefsToIntervals,
    /* P0-2: локальные детекторы */
    detectFillers: detectFillers,
    detectIntroOutro: detectIntroOutro,
    detectArtifacts: detectArtifacts,
    runLocalDetectors: runLocalDetectors
  };
})(typeof window !== 'undefined' ? window : this);
