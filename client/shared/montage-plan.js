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

  global.MontagePlan = {
    validatePlan: validatePlan,
    buildRemoveRefs: buildRemoveRefs,
    buildSummaries: buildSummaries,
    _fmtSec: fmtSec
  };
})(typeof window !== 'undefined' ? window : this);
