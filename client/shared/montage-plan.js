/**
 * MontagePlan — детерминированная валидация «плана монтажа по смыслам»
 * (инструмент propose_montage_plan). Вся арифметика хронометража — здесь,
 * НЕ у LLM. Чистые функции без DOM/ContextStore — юнит-тестируемо в Node.
 * Спека: docs/superpowers/specs/2026-07-05-montage-plan-design.md
 */
(function (global) {
  'use strict';

  var TOLERANCE = 0.10; // ±10% допуск попадания в целевой хронометраж

  /** Форматирует секунды в «m:ss» */
  function fmtSec(s) {
    var m = Math.floor(s / 60);
    var ss = Math.round(s - m * 60);
    if (ss === 60) { m += 1; ss = 0; }
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  /** Обрезает строку до ~maxLen символов, добавляя ' …' при обрезке */
  function truncate(str, maxLen) {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + ' \u2026';
  }

  /** trim-полифилл (ExtendScript ES3 не имеет String.prototype.trim) */
  function trim(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/^\s+|\s+$/g, '');
  }

  /** Целое число? */
  function isInt(v) {
    return typeof v === 'number' && isFinite(v) && v === Math.floor(v);
  }

  // ──────────────────────────────────────────────────────────
  // validatePlan(plan, entry) → {ok, errors[], warnings[], stats}
  // ──────────────────────────────────────────────────────────
  function validatePlan(plan, entry) {
    var errors = [];
    var warnings = [];
    var stats = {
      keepSec: 0,
      cutSec: 0,
      targetSec: 0,
      keepBlocks: 0,
      cutBlocks: 0,
      sacrificedTopics: []
    };

    // ── Правило 1: entry без непустого paragraphs ──
    if (!entry || !entry.paragraphs || !Array.isArray(entry.paragraphs) || entry.paragraphs.length === 0) {
      return { ok: false, errors: ['нет структуры транскрипта — вызови get_transcript_structure'], warnings: warnings, stats: stats };
    }
    var P = entry.paragraphs.length;

    // ── Правило 2: targetDurationSec ──
    if (!plan || typeof plan.targetDurationSec !== 'number' || !isFinite(plan.targetDurationSec) || plan.targetDurationSec <= 0) {
      return { ok: false, errors: ['нужен targetDurationSec > 0 (секунды)'], warnings: warnings, stats: stats };
    }
    var target = plan.targetDurationSec;
    stats.targetSec = target;

    // ── Правило 3: blocks не непустой массив ──
    if (!plan.blocks || !Array.isArray(plan.blocks) || plan.blocks.length === 0) {
      return { ok: false, errors: ['blocks должен быть непустым массивом блоков keep/cut'], warnings: warnings, stats: stats };
    }

    var blocks = plan.blocks;

    // ── Правило 4: валидация каждого блока ──
    // Параллельно собираем assigned[] для правила 5
    var assigned = []; // assigned[p] = индекс блока или undefined
    var hasStructuralError = false;
    var validBlocks = []; // индексы блоков с валидными диапазонами

    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];

      // action
      if (!b || (b.action !== 'keep' && b.action !== 'cut')) {
        errors.push('блок ' + bi + ': action должен быть keep|cut' + (b && b.action ? ' (получено «' + b.action + '»)' : ''));
        hasStructuralError = true;
        continue;
      }

      // paragraphs.from / to
      var pg = b.paragraphs;
      if (!pg || !isInt(pg.from) || !isInt(pg.to)) {
        errors.push('блок ' + bi + ': paragraphs.from и paragraphs.to должны быть целыми числами');
        hasStructuralError = true;
        continue;
      }
      if (pg.from < 0) {
        errors.push('блок ' + bi + ': paragraphs.from=' + pg.from + ' < 0');
        hasStructuralError = true;
      }
      if (pg.to >= P) {
        errors.push('блок ' + bi + ': paragraphs.to=' + pg.to + ' >= количества абзацев (' + P + ')');
        hasStructuralError = true;
      }
      if (pg.from > pg.to) {
        errors.push('блок ' + bi + ': paragraphs.from=' + pg.from + ' > to=' + pg.to);
        hasStructuralError = true;
      }

      // keep без theme
      if (b.action === 'keep' && !trim(b.theme)) {
        errors.push('блок ' + bi + ' (keep): нужен theme');
        hasStructuralError = true;
      }

      // cut без reason
      if (b.action === 'cut' && !trim(b.reason)) {
        errors.push('блок ' + bi + ' (cut): нужен reason — почему вырезаем');
        hasStructuralError = true;
      }

      // Помечаем как валидный для покрытия только если from/to в диапазоне
      if (pg.from >= 0 && pg.to < P && pg.from <= pg.to) {
        validBlocks.push(bi);
      }
    }

    // ── Правило 5: покрытие (только по блокам с валидными диапазонами) ──
    for (var vi = 0; vi < validBlocks.length; vi++) {
      var idx = validBlocks[vi];
      var blk = blocks[idx];
      for (var p = blk.paragraphs.from; p <= blk.paragraphs.to; p++) {
        if (assigned[p] !== undefined) {
          errors.push('абзац ' + p + ' в двух блоках (' + assigned[p] + ' и ' + idx + ')');
          hasStructuralError = true;
        } else {
          assigned[p] = idx;
        }
      }
    }

    // Непокрытые абзацы
    var uncovered = [];
    for (var u = 0; u < P; u++) {
      if (assigned[u] === undefined) uncovered.push(u);
    }
    if (uncovered.length > 0) {
      var show = uncovered.length <= 10 ? uncovered.join(', ') : uncovered.slice(0, 10).join(', ') + ' и ещё ' + (uncovered.length - 10);
      errors.push('абзацы ' + show + ' не попали ни в один блок — план должен покрывать весь транскрипт');
      hasStructuralError = true;
    }

    // Если есть структурные ошибки или ошибки покрытия — не считаем хронометраж
    if (hasStructuralError) {
      return { ok: false, errors: errors, warnings: warnings, stats: stats };
    }

    // ── Правило 6: хронометраж ──
    var keepSec = 0;
    var cutSec = 0;
    var keepBlocks = 0;
    var cutBlocks = 0;

    for (var ki = 0; ki < blocks.length; ki++) {
      var kb = blocks[ki];
      var dur = 0;
      for (var kp = kb.paragraphs.from; kp <= kb.paragraphs.to; kp++) {
        dur += entry.paragraphs[kp].endSec - entry.paragraphs[kp].startSec;
      }
      if (kb.action === 'keep') {
        keepSec += dur;
        keepBlocks++;
      } else {
        cutSec += dur;
        cutBlocks++;
      }
    }

    stats.keepSec = keepSec;
    stats.cutSec = cutSec;
    stats.keepBlocks = keepBlocks;
    stats.cutBlocks = cutBlocks;

    var ratio = keepSec / target;

    if (ratio > 1 + TOLERANCE) {
      var overPct = Math.round((ratio - 1) * 100);
      errors.push('хронометраж: получилось ' + fmtSec(keepSec) + ' при цели ' + fmtSec(target) + ' (+' + overPct + '%) — убери из keep (переведи в cut) ещё ~' + fmtSec(keepSec - target));
    } else if (ratio < 1 - TOLERANCE) {
      var underPct = Math.round((1 - ratio) * 100);
      errors.push('хронометраж: недобор — ' + fmtSec(keepSec) + ' при цели ' + fmtSec(target) + ' (-' + underPct + '%). Верни в keep ~' + fmtSec(target - keepSec) + ' или предложи пользователю меньшую цель');
    }

    // ── Правило 7: пожертвованные темы ──
    var topics = (entry.topics && Array.isArray(entry.topics)) ? entry.topics : [];
    var sacrificed = [];

    for (var ti = 0; ti < topics.length; ti++) {
      var topic = topics[ti];
      // Найти все абзацы, пересекающиеся с темой
      var intersecting = [];
      for (var pi = 0; pi < P; pi++) {
        var par = entry.paragraphs[pi];
        if (par.startSec < topic.endSec && topic.startSec < par.endSec) {
          intersecting.push(pi);
        }
      }
      // Если нет пересекающихся абзацев — пропускаем
      if (intersecting.length === 0) continue;

      // Все пересекающиеся абзацы в cut?
      var allCut = true;
      for (var ii = 0; ii < intersecting.length; ii++) {
        var bi2 = assigned[intersecting[ii]];
        if (bi2 !== undefined && blocks[bi2].action !== 'cut') {
          allCut = false;
          break;
        }
      }
      if (allCut) {
        warnings.push('тема \u00AB' + topic.title + '\u00BB пожертвована целиком');
        sacrificed.push(topic.title);
      }
    }

    stats.sacrificedTopics = sacrificed;

    return { ok: errors.length === 0, errors: errors, warnings: warnings, stats: stats };
  }

  // ──────────────────────────────────────────────────────────
  // buildRemoveRefs(blocks) → [{paragraph, reason}]
  // ──────────────────────────────────────────────────────────
  function buildRemoveRefs(blocks) {
    var refs = [];
    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];
      if (b.action !== 'cut') continue;
      for (var p = b.paragraphs.from; p <= b.paragraphs.to; p++) {
        refs.push({ paragraph: p, reason: b.reason || '' });
      }
    }
    refs.sort(function (a, b) { return a.paragraph - b.paragraph; });
    return refs;
  }

  // ──────────────────────────────────────────────────────────
  // buildSummaries(blocks, entry) → {keepSummary[], removeSummary[]}
  // ──────────────────────────────────────────────────────────
  function buildSummaries(blocks, entry) {
    var keepSummary = [];
    var removeSummary = [];
    var paras = entry.paragraphs;

    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];
      var fromP = paras[b.paragraphs.from];
      var toP = paras[b.paragraphs.to];

      if (b.action === 'keep') {
        keepSummary.push({
          startSec: fromP.startSec,
          endSec: toP.endSec,
          quote: b.theme || ''
        });
      } else {
        // quote = первые ~60 символов текста первого абзаца
        var firstText = fromP.text || '';
        removeSummary.push({
          startSec: fromP.startSec,
          endSec: toP.endSec,
          reason: b.reason || '',
          quote: truncate(firstText, 60)
        });
      }
    }

    keepSummary.sort(function (a, b) { return a.startSec - b.startSec; });
    removeSummary.sort(function (a, b) { return a.startSec - b.startSec; });
    return { keepSummary: keepSummary, removeSummary: removeSummary };
  }

  // ──────────────────────────────────────────────────────────
  // buildPlanFromLabels(labeled, entry, targetSec) → {blocks, stats}
  // Детерминированный knapsack: свернуть в блоки → отобрать под бюджет →
  // собрать keep/cut blocks в формате validatePlan (соседние сливаются).
  // ──────────────────────────────────────────────────────────
  function _roleToReason(role) {
    if (role === 'repeat') return 'повтор';
    if (role === 'filler') return 'вода';
    if (role === 'offtopic') return 'офтоп';
    return 'слабый кусок';
  }

  /* Добавляет причину в список, если её там ещё нет (уникальность + порядок) */
  function _addReason(list, reason) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === reason) return;
    }
    list.push(reason);
  }

  function buildPlanFromLabels(labeled, entry, targetSec) {
    var paras = (entry && entry.paragraphs) || [];
    var P = paras.length;
    var stats = { keptBlocks: 0, cutBlocks: 0, keepSec: 0, cutSec: 0 };
    if (!P || !labeled || !labeled.length) {
      return { blocks: [], stats: stats };
    }

    /* 1. Индексируем метку по абзацу; недостающим — importance 1, role argument */
    var byIdx = [];
    for (var li = 0; li < labeled.length; li++) {
      var L = labeled[li];
      if (typeof L.i === 'number' && L.i >= 0 && L.i < P) byIdx[L.i] = L;
    }
    for (var pi = 0; pi < P; pi++) {
      if (!byIdx[pi]) byIdx[pi] = { i: pi, blockId: 'auto' + pi, importance: 1, role: 'argument', theme: '', protect: null };
    }

    /* 2. Сворачиваем по смежным одинаковым blockId в группы */
    var groups = [];
    var cur = null;
    for (var g = 0; g < P; g++) {
      var lab = byIdx[g];
      var dur = paras[g].endSec - paras[g].startSec;
      if (cur && cur.blockId === lab.blockId) {
        cur.to = g; cur.dur += dur;
        if (lab.importance > cur.importance) cur.importance = lab.importance;
        if (lab.protect) cur.protect = lab.protect;
      } else {
        cur = { blockId: lab.blockId, from: g, to: g, dur: dur,
                importance: lab.importance || 0, role: lab.role || 'argument',
                theme: lab.theme || '', protect: lab.protect || null };
        groups.push(cur);
      }
    }

    /* 3. Отбор: protect start/end → keep всегда; затем по importance убыв.,
       tie-break по from (стабильно). Добираем пока keepSec+dur ≤ target. */
    var order = groups.slice().sort(function (a, b) {
      var pa = a.protect ? 1 : 0, pb = b.protect ? 1 : 0;
      if (pa !== pb) return pb - pa;
      if (b.importance !== a.importance) return b.importance - a.importance;
      return a.from - b.from;
    });
    var keepSec = 0;
    for (var oi = 0; oi < order.length; oi++) {
      var grp = order[oi];
      if (grp.protect || keepSec + grp.dur <= targetSec) {
        grp._keep = true; keepSec += grp.dur;
      } else {
        grp._keep = false;
      }
    }

    /* 4. Собираем blocks в хронологическом порядке, сливая соседние одинаковые action */
    var blocks = [];
    var pending = null;
    for (var gi = 0; gi < groups.length; gi++) {
      var gg = groups[gi];
      var action = gg._keep ? 'keep' : 'cut';
      if (pending && pending.action === action) {
        pending.paragraphs.to = gg.to;
        if (action === 'keep' && gg.theme && !pending.theme) pending.theme = gg.theme;
        if (action === 'cut') _addReason(pending._reasons, _roleToReason(gg.role));
      } else {
        pending = { action: action, paragraphs: { from: gg.from, to: gg.to } };
        if (action === 'keep') {
          pending.theme = gg.theme || 'Ключевой фрагмент';
        } else {
          pending._reasons = [];
          _addReason(pending._reasons, _roleToReason(gg.role));
        }
        blocks.push(pending);
      }
    }

    /* 4b. Собираем reason из накопленных причин (уникальные, в хрон. порядке) */
    for (var ri = 0; ri < blocks.length; ri++) {
      if (blocks[ri].action === 'cut') {
        blocks[ri].reason = blocks[ri]._reasons.join(', ');
        delete blocks[ri]._reasons;
      }
    }

    /* 5. stats */
    for (var bi = 0; bi < blocks.length; bi++) {
      var blk = blocks[bi], d = 0;
      for (var p2 = blk.paragraphs.from; p2 <= blk.paragraphs.to; p2++) d += paras[p2].endSec - paras[p2].startSec;
      if (blk.action === 'keep') { stats.keepSec += d; stats.keptBlocks++; }
      else { stats.cutSec += d; stats.cutBlocks++; }
    }
    return { blocks: blocks, stats: stats };
  }

  global.MontagePlan = {
    validatePlan: validatePlan,
    buildRemoveRefs: buildRemoveRefs,
    buildSummaries: buildSummaries,
    buildPlanFromLabels: buildPlanFromLabels,
    _fmtSec: fmtSec
  };
})(typeof window !== 'undefined' ? window : this);
