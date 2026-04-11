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
      for (var i = 0; i < sil.length; i++) {
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
      'Сгруппируй их в 3–12 глав по смене темы. ' +
      'Возвращай СТРОГО JSON {"topics":[{"startSec":N,"endSec":N,"title":"…","summary":"одно предложение"}]}. ' +
      'startSec первой главы = startSec первого абзаца; endSec последней = endSec последнего. ' +
      'Главы без дыр: endSec текущей = startSec следующей. Между главами не меньше 20 сек. Без markdown, только JSON.';

    var userMsg = JSON.stringify({ paragraphs: compact });

    return CC.chatCompletions({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.analysisModel || settings.activeAgentModel || settings.chatModel,
      messages: [
        { role: 'system', content: sysMsg },
        { role: 'user', content: userMsg }
      ],
      chatParams: { max_tokens: 2000, temperature: 0.2 },
      signal: opt.signal,
      abortCheck: opt.abortCheck
    }).then(function (resp) {
      try {
        var content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
        if (!content) return [];
        var m = String(content).match(/\{[\s\S]*\}/);
        if (!m) return [];
        var j = JSON.parse(m[0]);
        var topics = (j && j.topics) || [];
        if (!Array.isArray(topics)) return [];
        return topics.map(function (t) {
          return {
            startSec: Number(t.startSec) || 0,
            endSec: Number(t.endSec) || 0,
            title: String(t.title || '').slice(0, 80),
            summary: String(t.summary || '').slice(0, 200)
          };
        }).filter(function (t) { return t.endSec > t.startSec && t.title; });
      } catch (e) {
        return [];
      }
    }, function () { return []; });
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
  function detectArtifacts(segments) {
    if (!segments || !segments.length) return [];
    var results = [];

    /* Подсчёт частоты нормализованных текстов */
    var freq = {};
    for (var i = 0; i < segments.length; i++) {
      var txt = normText(segments[i].text);
      if (!txt || txt.split(/\s+/).length < 2) continue; /* слишком короткие не считаем */
      freq[txt] = (freq[txt] || 0) + 1;
    }

    /* Отмечаем сегменты с текстом, повторяющимся ≥4 раз */
    var artifactTexts = {};
    for (var key in freq) {
      if (freq[key] >= 4) artifactTexts[key] = freq[key];
    }

    /* Также ищем 3+ подряд */
    for (var j = 0; j < segments.length - 2; j++) {
      var t1 = normText(segments[j].text);
      var t2 = normText(segments[j + 1].text);
      var t3 = normText(segments[j + 2].text);
      if (t1 && t1 === t2 && t2 === t3) {
        artifactTexts[t1] = (artifactTexts[t1] || 0);
      }
    }

    /* Размечаем сегменты как artifact, оставляя первое вхождение */
    var seen = {};
    for (var k = 0; k < segments.length; k++) {
      var nt = normText(segments[k].text);
      if (artifactTexts[nt] !== undefined) {
        if (!seen[nt]) {
          seen[nt] = true; /* первое вхождение оставляем */
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
      'Каждый сегмент: {i: индекс, t0: начало (сек), t1: конец (сек), text: текст}.',
      'Сегмент — это 3-30 секунд речи. В одном длинном абзаце может быть 5-15 сегментов.',
      '',
      'Задача: классифицируй КАЖДЫЙ сегмент ровно одной меткой:',
      '• content    — полезное содержание, факты, мысли по теме (ОСТАВИТЬ)',
      '• filler     — ЦЕЛИКОМ слова-паразиты, междометия, мычание: «ну», «ээ», «ммм», «как бы», «типа», «вот» (УДАЛИТЬ)',
      '• intro      — приветствие, представление: «всем привет», «меня зовут», «с вами канал» БЕЗ полезной информации (УДАЛИТЬ)',
      '• outro      — прощание: «подписывайтесь», «до встречи», «с вами был» (УДАЛИТЬ)',
      '• outtake    — оговорка, фальстарт, ругательство, «давай заново», «подожди, тормозни», «блин, это хрень» — спикер сбился и переначал (УДАЛИТЬ)',
      '• repeat     — почти дословный повтор другого сегмента — спикер сказал то же самое второй раз. Укажи «repeat of i=N» (УДАЛИТЬ первый дубль, оставь второй)',
      '• artifact   — шум транскрибации: повторяющиеся фрагменты имён/субтитров, вставленные Whisper. Пример: «И Валерий Курас» повторяется в каждом сегменте — это артефакт (УДАЛИТЬ)',
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
  function _buildFinalResult(segments, preByIndex, llmLabels, onProgress, chunksUsed) {
    var VALID_LABELS = { content: 1, filler: 1, intro: 1, outro: 1, outtake: 1, repeat: 1, artifact: 1, digression: 1 };
    var stats = { content: 0, filler: 0, intro: 0, outro: 0, outtake: 0, repeat: 0, artifact: 0, digression: 0 };

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

    onProgress({
      phase: 'done',
      stats: stats,
      message: 'Анализ завершён: ' + full.length + ' сегментов, удалить ' +
        (stats.filler + stats.intro + stats.outro + stats.outtake + stats.repeat + stats.artifact) +
        ', оставить ' + stats.content
    });

    return {
      labels: full,
      stats: stats,
      chunks: chunksUsed || 0,
      totalSegments: segments.length,
      localDetected: Object.keys(preByIndex).length
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
    for (var fi = 0; fi < segments.length; fi++) {
      var fIdx = segments[fi].i !== undefined ? segments[fi].i : fi;
      if (preByIndex[fIdx] && preByIndex[fIdx].confidence === 'high') continue;
      segmentsForLLM.push(segments[fi]);
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

    /* Разбиваем на чанки — только сегменты для LLM */
    var chunks = [];
    for (var ci = 0; ci < segmentsForLLM.length && chunks.length < ANALYSIS_MAX_CHUNKS; ci += ANALYSIS_CHUNK_SIZE) {
      var slice = segmentsForLLM.slice(ci, ci + ANALYSIS_CHUNK_SIZE);
      chunks.push(slice.map(function (s, idx) {
        return { i: s.i !== undefined ? s.i : (ci + idx), t0: s.startSec, t1: s.endSec, text: truncText(s.text) };
      }));
    }

    var allLabels = [];
    var chunkIdx = 0;
    var totalChunks = chunks.length;

    onProgress({
      phase: 'start',
      totalSegments: segments.length,
      totalChunks: totalChunks,
      model: model,
      message: 'Анализ транскрипта: ' + segments.length + ' сегментов, ' + totalChunks + ' чанк(ов), модель ' + (model || '?')
    });

    function processChunk() {
      if (chunkIdx >= chunks.length) return Promise.resolve();
      var chunk = chunks[chunkIdx];
      chunkIdx++;

      onProgress({
        phase: 'chunk',
        chunkIndex: chunkIdx,
        totalChunks: totalChunks,
        segRange: chunk[0].i + '–' + chunk[chunk.length - 1].i,
        message: 'Анализ чанка ' + chunkIdx + '/' + totalChunks + ' (сегменты ' + chunk[0].i + '–' + chunk[chunk.length - 1].i + ')…'
      });

      var contextNote = '';
      if (chunkIdx > 1) {
        contextNote = '\n\n[Контекст: сегменты ' + chunk[0].i + '–' + chunk[chunk.length - 1].i +
          ' из ' + segments.length + '. Предыдущие уже проанализированы.]';
      }

      var userMsg = JSON.stringify({ segments: chunk }) + contextNote;

      return CC.chatCompletions({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: model,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userMsg }
        ],
        chatParams: { max_tokens: 6000, temperature: 0.1 },
        signal: opt.signal,
        abortCheck: opt.abortCheck
      }).then(function (resp) {
        try {
          var content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
          if (!content) return processChunk();
          var m = String(content).match(/\{[\s\S]*\}/);
          if (!m) return processChunk();
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
            chunkIndex: chunkIdx,
            totalChunks: totalChunks,
            labelsInChunk: labels ? labels.length : 0,
            message: 'Чанк ' + chunkIdx + '/' + totalChunks + ' готов (' + (labels ? labels.length : 0) + ' меток)'
          });
        } catch (parseErr) {
          onProgress({
            phase: 'chunk_error',
            chunkIndex: chunkIdx,
            error: String(parseErr.message || parseErr),
            message: 'Ошибка разбора чанка ' + chunkIdx + ': ' + String(parseErr.message || '')
          });
        }
        return processChunk();
      }, function (err) {
        onProgress({
          phase: 'chunk_error',
          chunkIndex: chunkIdx,
          error: String(err && err.message || err),
          message: 'Ошибка API чанка ' + chunkIdx + ': ' + String(err && err.message || '')
        });
        return processChunk();
      });
    }

    return processChunk().then(function () {
      return _buildFinalResult(segments, preByIndex, allLabels, onProgress, chunks.length);
    });
  }

  global.TranscriptStructure = {
    buildParagraphs: buildParagraphs,
    buildSpeakers: buildSpeakers,
    buildTopicsWithLLM: buildTopicsWithLLM,
    analyzeForCutsWithLLM: analyzeForCutsWithLLM,
    buildStructure: buildStructure,
    /* P0-2: локальные детекторы */
    detectFillers: detectFillers,
    detectIntroOutro: detectIntroOutro,
    detectArtifacts: detectArtifacts,
    runLocalDetectors: runLocalDetectors
  };
})(typeof window !== 'undefined' ? window : this);
