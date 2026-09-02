/**
 * chat-router.js — детерминированный роутер «простых человеческих запросов»
 * чата ДО обращения к LLM (ревью агентского контура, сентябрь 2026).
 *
 * Зачем: анализ показал, что самые частые промахи агента — не «модель глупая»,
 * а то, что простые запросы уходили не тем путём:
 *   • «вырежи с 1:30 по 1:45» шёл через LLM в транскрипт-конвейер, где интервал
 *     молча падился/снапался/исключался (fast-path понимал только «N сек»);
 *   • «убери тишины / джампкаты / паразитов / главы / пробелы» LLM
 *     переизобретала вручную, хотя те же детерминированные пайплайны живут на
 *     вкладке «Инструменты» одним кликом.
 *
 * Модуль чистый (без DOM/host), ES5, тестируется в Node. Панель делает:
 *   1) parseIntervalDelete → мгновенный razor без LLM (exact: без padding/snap);
 *   2) matchPipelineIntent → запуск пайплайна DeterministicPipelines как по
 *      slash-команде, с параметрами из фразы;
 *   3) transcriptFreshness → предупреждение о ручных правках после транскрибации.
 *
 * Принцип: матчим только КОРОТКИЕ и ОДНОЗНАЧНЫЕ фразы. Любой намёк на смысл
 * («собери про…», «где говорят…», «уложи в…») → null → решает LLM-агент.
 */
(function (global) {
  'use strict';

  /* ── Нормализация текста ─────────────────────────────────────────── */
  function norm(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[–—−]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^\s|\s$/g, '');
  }

  /* ── Таймкоды ──────────────────────────────────────────────────────
   * '90' → 90; '1:30' → 90; '01:02:03' → 3723; '2,5' → 2.5; null при мусоре. */
  function parseTimecode(raw) {
    var s = String(raw == null ? '' : raw).replace(/\s+/g, '').replace(/,/g, '.');
    if (!s) return null;
    var m = s.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d+))?$/);
    if (m) {
      var h = m[3] !== undefined ? +m[1] : 0;
      var mm = m[3] !== undefined ? +m[2] : +m[1];
      var ss = m[3] !== undefined ? +m[3] : +m[2];
      if (mm > 59 && m[3] !== undefined) return null;
      if (ss > 59) return null;
      var frac = m[4] ? parseFloat('0.' + m[4]) : 0;
      return h * 3600 + mm * 60 + ss + frac;
    }
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    return null;
  }

  /* Длительность вида «1 мин 30 сек», «2 минуты», «45 секунд», «1.5 мин» → сек. */
  var DUR_RE = /(\d+(?:[.,]\d+)?)\s*(?:мин(?:ут[а-я]*)?|м(?![а-я]))(?:\s*(?:и\s*)?(\d+(?:[.,]\d+)?)\s*(?:с|сек[а-я]*))?|(\d+(?:[.,]\d+)?)\s*(?:с|сек[а-я]*)(?![а-я])/;
  function parseDuration(raw) {
    var t = norm(raw);
    var m = t.match(DUR_RE);
    if (!m) return null;
    if (m[1] !== undefined) {
      var mins = parseFloat(m[1].replace(',', '.'));
      var secs = m[2] !== undefined ? parseFloat(m[2].replace(',', '.')) : 0;
      return mins * 60 + secs;
    }
    return parseFloat(m[3].replace(',', '.'));
  }

  /* Явные таймкоды/длительности во фразе (для тира timeline и трейса). */
  var TC_TOKEN = /\d{1,3}:\d{2}(?::\d{2})?|\d+(?:[.,]\d+)?\s*(?:с|сек[а-я]*|мин[а-я]*)(?![а-я])/;
  function hasExplicitTimecodes(text) {
    return TC_TOKEN.test(norm(text));
  }

  /* ── «Удали с X по Y» ──────────────────────────────────────────────
   * Возвращает {startSec, endSec, ripple, exact:true} | {needsDuration:true, …}
   * | null (не команда / неоднозначно / несколько интервалов → LLM).
   * opts.durationSec — длина секвенции для «последние N секунд». */
  var VERB_RE = /(удал|убер|выреж|вырез|отреж|отрез|очист|cut|remove|промежут|интервал|дырк|пуст)/;
  var LIFT_RE = /не\s*смыка|без\s*смык|не\s+сомык|остав(ь|ить)\s+дыр|с\s+дыр|lift|без\s+ripple|не\s+сомкн/;
  /* Один таймкод-операнд: mm:ss(.f) | N(.f) с необязательной единицей/окончанием («3-й», «5-ю»). */
  var OPERAND = '(\\d{1,3}:\\d{2}(?::\\d{2})?(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?)(?:-?(?:й|я|ю|е|х|ой|ую|ей|ии))?\\s*(?:с(?![а-я])|сек[а-я]*|мин[а-я]*)?';
  var RANGE_RES = [
    new RegExp('(?:с|от|между|начиная\\s+с)\\s+' + OPERAND + '\\s*(?:по|до|и|-)\\s*' + OPERAND),
    new RegExp('(?:^|\\s|\\()' + OPERAND + '\\s*(?:-|до)\\s*' + OPERAND)
  ];
  var RANGE_COUNT_RE = /(?:(?:с|от|между)\s+\d[\d:.,]*(?:-?[а-я]{1,2})?\s*(?:с|сек[а-я]*|мин[а-я]*)?\s*(?:по|до|и|-)\s*|\d[\d:.,]*\s*(?:с|сек[а-я]*|мин[а-я]*)?\s*-\s*)\d[\d:.,]*/g;

  function operandSec(tok, unitCtx) {
    var v = parseTimecode(tok);
    if (v === null) return null;
    /* «2 мин» / «1.5 мин» без «:» — минуты */
    if (unitCtx && /мин/.test(unitCtx) && tok.indexOf(':') === -1) return v * 60;
    return v;
  }

  function parseIntervalDelete(text, opts) {
    var t = norm(text);
    if (!t || !VERB_RE.test(t)) return null;
    var ripple = !LIFT_RE.test(t);
    var o = opts || {};

    /* Несколько интервалов → LLM (apply_timecode_edits с полным планом). */
    var multi = t.match(RANGE_COUNT_RE);
    if (multi && multi.length > 1) return null;
    if (/(?:^|\s)(два|две|три|четыре|пять|нескольк\w*|оба|обе|все)\s+(?:\S+\s+)?интервал/.test(t)) return null;

    /* «первые N секунд/минут» → [0, N]; «последние N» → [dur−N, dur]. */
    var first = t.match(/(?:перв(?:ые|ую|ый|ое)|начальн[а-я]*)\s+(\d+(?:[.,]\d+)?\s*(?:с|сек[а-я]*|мин[а-я]*)|минут[ау]|секунд[ау])/);
    if (first) {
      var fd = /^(минут|секунд)/.test(first[1]) ? (/^мин/.test(first[1]) ? 60 : 1) : parseDuration(first[1]);
      if (fd && fd > 0) return { startSec: 0, endSec: fd, ripple: ripple, exact: true, form: 'first' };
    }
    var last = t.match(/(?:последн(?:ие|юю|ий|ее)|конечн[а-я]*|финальн[а-я]*)\s+(\d+(?:[.,]\d+)?\s*(?:с|сек[а-я]*|мин[а-я]*)|минут[ау]|секунд[ау])/);
    if (last) {
      var ld = /^(минут|секунд)/.test(last[1]) ? (/^мин/.test(last[1]) ? 60 : 1) : parseDuration(last[1]);
      if (ld && ld > 0) {
        if (typeof o.durationSec !== 'number' || !(o.durationSec > 0)) {
          return { needsDuration: true, lastSec: ld, ripple: ripple, exact: true, form: 'last' };
        }
        var s0 = Math.max(0, o.durationSec - ld);
        if (o.durationSec - s0 < 0.02) return null;
        return { startSec: s0, endSec: o.durationSec, ripple: ripple, exact: true, form: 'last' };
      }
    }

    for (var i = 0; i < RANGE_RES.length; i++) {
      var m = t.match(RANGE_RES[i]);
      if (!m) continue;
      var whole = m[0];
      /* Единицы у операндов: смотрим текст между/после операндов. */
      var aIdx = whole.indexOf(m[1]);
      var between = whole.slice(aIdx + m[1].length);
      var bIdx = between.indexOf(m[2]);
      var unitA = between.slice(0, bIdx);
      var unitB = between.slice(bIdx + m[2].length) + ' ' + t.slice(t.indexOf(whole) + whole.length, t.indexOf(whole) + whole.length + 12);
      /* Если единица только у второго операнда («с 1 по 2 мин») — общая. */
      var hasUnitA = /(мин|сек|(?:^|\s)с(?![а-я]))/.test(unitA);
      var a = operandSec(m[1], hasUnitA ? unitA : unitB);
      var b = operandSec(m[2], unitB);
      if (a === null || b === null) return null;
      if (Math.abs(a - b) < 0.02) return null;
      return { startSec: Math.min(a, b), endSec: Math.max(a, b), ripple: ripple, exact: true, form: 'range' };
    }
    return null;
  }

  /* ── Детерминированные пайплайны по фразе ──────────────────────────
   * Только короткие однозначные запросы. Возвращает {tool, params, label} | null. */
  var MAX_LEN = 90;
  /* \b в JS не работает с кириллицей — границы слов задаём явно */
  var SEMANTIC_RE = /(собер|уложи|сожм|сократ|(?:^|[^а-я])про\s|где\s|найди|найти|хайлайт|оставь\s+только|ролик|нарезк|динамич|смысл|скучн|интересн|лучш|цитат|расскаж|что\s+там|о\s+чем|(?:^|[^а-я])тем[аеуы](?=[^а-я]|$)|верси|шортс|рилс)/;
  var ACT_RE = /(убер|удал|выреж|вырез|почист|подчист|вычист|сотр|сними|зачист|уберите|удалите)/;

  function numAfter(t, re) {
    var m = t.match(re);
    if (!m) return null;
    var v = parseDuration(m[1]);
    if (v === null) v = parseFloat(String(m[1]).replace(',', '.'));
    return isFinite(v) && v > 0 ? v : null;
  }

  /* Категории задач: фраза с ДВУМЯ и более → составной запрос → LLM
     (live 02.09.2026: «почисти оговорки и повторы, потом убери тишины» уходила
     в пайплайн тишин, а оговорки/повторы молча терялись). */
  var TASK_RES = [
    /(тишин|пауз|молчан)/, /(джамп|jump)/, /(парази|эканье|мычан)/, /((?:^|[^а-я])мат[аеу]?(?=[^а-я]|$)|ругательств|нецензур|матерн)/,
    /(глав[ыуа]?(?=[^а-я]|$)|chapter|оглавлен)/, /(пробел|дыр[ыаку]|зазор)/,
    /(оговор|повтор|заик|фальстарт|вступлен|концовк|прощан|приветств|мусор|воду|вод[аы](?=[^а-я]|$))/,
    /(маркер|хайлайт|момент|резюме|кратко|перескаж)/
  ];
  var MULTI_STEP_RE = /(потом|затем|после\s+этого|а\s+также|и\s+ещ[её]|заодно|плюс\s)/;

  function matchPipelineIntent(text) {
    var t = norm(text);
    if (!t || t.length > MAX_LEN) return null;
    if (t[0] === '/') return null; /* slash-команды парсит DeterministicPipelines */
    if (SEMANTIC_RE.test(t)) return null;
    /* Явные таймкоды-диапазоны — это точечный рез, не пайплайн. */
    if (parseIntervalDelete(t)) return null;
    /* Составной запрос (несколько задач / «потом …») — решает агент. */
    var taskCount = 0;
    var isJump = /(джамп|jump)/.test(t);
    for (var ti = 0; ti < TASK_RES.length; ti++) {
      if (ti === 0 && isJump) continue; /* «джампкаты по паузам» — паузы часть той же задачи */
      if (TASK_RES[ti].test(t)) taskCount++;
    }
    if (taskCount > 1 || MULTI_STEP_RE.test(t)) return null;

    var params = {};
    var longer = numAfter(t, /(?:длинн|дольш|больш|свыш|от|более)[а-я]*\s+(\d+(?:[.,]\d+)?\s*(?:с|сек[а-я]*|мин[а-я]*)?)/);

    /* Тишины / паузы */
    if (/(тишин|пауз|молчан)/.test(t) && (ACT_RE.test(t) || /(сожми|сократи|подожми|заглуш|приглуш)/.test(t))) {
      if (longer) params.minDuration = longer;
      if (/(не\s*смыка|без\s*смык|остав(ь|ить)\s+дыр|с\s+дыр)/.test(t)) params.cutMode = 'keep_spaces';
      else if (/(заглуш|приглуш|замьют|mute)/.test(t)) params.cutMode = 'mute';
      if (/(кроссфейд|crossfade|плавн)/.test(t)) params.crossfade = true;
      return { tool: 'silences', params: params, label: 'Убрать тишины' };
    }
    /* Jump cuts */
    if (/(джамп|jump)[\s-]*(кат|cut)/.test(t) || /джампкат/.test(t)) {
      if (longer) params.maxPause = longer;
      if (/(кроссфейд|crossfade|плавн)/.test(t)) params.crossfade = true;
      return { tool: 'jumps', params: params, label: 'Jump cuts' };
    }
    /* Паразиты */
    if (/(парази|эканье|мычан|(?:^|[^а-я])(?:ээ+|мм+)(?=[^а-я]|$))/.test(t) && (ACT_RE.test(t) || /(почист|чист)/.test(t))) {
      params.sensitivity = /(все|всех|расширен|типа|вот|короче|значит|как\s+бы)/.test(t) ? 'normal' : 'strict';
      return { tool: 'fillers', params: params, label: 'Убрать паразиты' };
    }
    /* Мат */
    if (/((?:^|[^а-я])мат[аеу]?(?=[^а-я]|$)|ругательств|нецензур|матерн)/.test(t) && /(заглуш|запикай|убер|удал|выреж|вырез|почист|скрой|зацензур)/.test(t)) {
      params.cutMode = /(выреж|вырез|удал)/.test(t) ? 'remove' : 'mute';
      return { tool: 'profanity', params: params, label: 'Мат' };
    }
    /* Главы */
    if (/(глав[ыуа]?(?=[^а-я]|$)|chapter|оглавлен)/.test(t) && /(постав|расстав|сдела|добав|размет|раздел|создай|нужны|хочу)/.test(t)) {
      var cnt = t.match(/(\d+)\s*глав/);
      if (cnt && +cnt[1] > 0) params.maxChapters = +cnt[1];
      var minLen = numAfter(t, /(?:не\s+короче|минимум|от)\s+(\d+(?:[.,]\d+)?\s*(?:с|сек[а-я]*|мин[а-я]*))/);
      if (minLen) params.minChapterSec = minLen;
      return { tool: 'chapters', params: params, label: 'Авто-главы' };
    }
    /* Пробелы таймлайна */
    if (/(пробел|дыр[ыаку]|зазор|пуст(ые|ых|ое)\s+мест)/.test(t) && /(закр|убер|удал|сомкн|схлопн|сожм|подтян)/.test(t)) {
      if (longer) params.minGapSec = longer;
      return { tool: 'gaps', params: params, label: 'Убрать пробелы' };
    }
    return null;
  }

  /* ── Свежесть транскрипта относительно таймлайна ───────────────────
   * snap.audioFp — отпечаток аудио-дорожек из host; entry.timelineFp — отпечаток
   * на момент транскрибации (панель обновляет его после СВОИХ ripple-правок).
   * Расхождение = ручные правки в Premiere → тайминги транскрипта съехали. */
  function transcriptFreshness(snap, entry) {
    if (!entry) return { state: 'none', reason: 'нет транскрипта' };
    var cur = snap && snap.audioFp;
    var stored = entry.timelineFp && entry.timelineFp.hash;
    if (cur && stored && String(cur) !== String(stored)) {
      return { state: 'stale', reason: 'таймлайн менялся вручную после транскрибации' };
    }
    if (entry.possiblyStale) {
      /* Панель ставит после собственных move/trim-правок и никогда не снимает —
         поэтому это предупреждение («проверь на слух»), а не блокировка. */
      return { state: 'suspect', reason: 'после правок таймлайна структура могла сдвинуться — проверьте резы на слух' };
    }
    if (!cur || !stored) return { state: 'unknown', reason: 'нет отпечатка' };
    return { state: 'fresh', reason: '' };
  }

  function snapshotDurationSec(snap) {
    if (!snap || !snap.ok) return 0;
    var d = typeof snap.sequenceEndSec === 'number' ? snap.sequenceEndSec : 0;
    var clips = Array.isArray(snap.clips) ? snap.clips : [];
    for (var i = 0; i < clips.length; i++) {
      if (clips[i] && typeof clips[i].endSec === 'number' && clips[i].endSec > d) d = clips[i].endSec;
    }
    return d;
  }

  global.ChatRouter = {
    parseTimecode: parseTimecode,
    parseDuration: parseDuration,
    hasExplicitTimecodes: hasExplicitTimecodes,
    parseIntervalDelete: parseIntervalDelete,
    matchPipelineIntent: matchPipelineIntent,
    transcriptFreshness: transcriptFreshness,
    snapshotDurationSec: snapshotDurationSec
  };
})(window);
