/**
 * Transcript I/O — сериализация транскрипта в файл и обратно.
 *
 * Зачем: кэш транскрипта живёт в служебных папках панели и привязан к
 * sequenceID проекта. Чтобы перенести транскрипт на другую машину, отдать
 * коллеге или откатиться к прошлой версии, нужен явный файл.
 *
 * Формат .json содержит полный entry (сегменты + отпечатки + аудио-анализ),
 * поэтому загрузка восстанавливает состояние целиком. Читаемые .txt/.srt
 * выгружаются из читалки транскрипта (см. wireTranscriptViewerExtras).
 *
 * Чистые функции — никакого DOM и fs, тестируется в node.
 */
(function (global) {
  var FORMAT = 'omc-transcript';
  var FORMAT_VERSION = 1;

  /** Безопасное имя файла из имени секвенции (без разделителей пути). */
  function safeFileName(name) {
    var s = String(name == null ? '' : name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    s = s.replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
    if (!s) s = 'transcript';
    if (s.length > 80) s = s.slice(0, 80);
    return s;
  }

  /** Имя по умолчанию для диалога сохранения: «Имя секвенции_2026-08-04T10-11-12.json». */
  function defaultFileName(seqName, ext, nowIso) {
    var ts = String(nowIso || new Date().toISOString()).replace(/[:.]/g, '-').replace(/Z$/, '');
    return safeFileName(seqName) + '_' + ts + '.' + String(ext || 'json');
  }

  /**
   * Обёртка для записи: сам entry + метаданные формата.
   * Никаких срезаний — сохраняем entry целиком, чтобы импорт был полным.
   */
  function buildExportPayload(entry, meta) {
    var m = meta || {};
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      panelVersion: m.panelVersion || null,
      seqId: (entry && entry.seqId) || m.seqId || '',
      seqName: (entry && entry.seqName) || m.seqName || '',
      entry: entry || null
    };
  }

  /**
   * Разбор загруженного файла.
   * Принимает как «обёртку» buildExportPayload, так и голый entry
   * (на случай, если пользователь подсунул кусок кэша).
   * Возвращает { ok, entry, meta, warnings[], error }.
   */
  function parseImportPayload(text) {
    var warnings = [];
    var data;
    try {
      data = JSON.parse(String(text));
    } catch (e) {
      return { ok: false, error: 'Файл не является корректным JSON: ' + String(e.message || e), warnings: warnings };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'Ожидался JSON-объект транскрипта.', warnings: warnings };
    }

    var meta = null;
    var entry = null;
    if (data.format === FORMAT) {
      if (Number(data.formatVersion) > FORMAT_VERSION) {
        warnings.push('Файл сохранён более новой версией панели (v' + data.formatVersion + ') — часть полей может не примениться.');
      }
      entry = data.entry;
      meta = { seqId: data.seqId || '', seqName: data.seqName || '', exportedAt: data.exportedAt || '' };
    } else if (Array.isArray(data.segments)) {
      entry = data;
      meta = { seqId: data.seqId || '', seqName: data.seqName || '', exportedAt: '' };
      warnings.push('Файл без метаданных формата — принят как «голый» транскрипт.');
    } else {
      return { ok: false, error: 'В файле нет транскрипта (поле segments не найдено).', warnings: warnings };
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'В файле нет транскрипта (поле entry пустое).', warnings: warnings };
    }
    if (!Array.isArray(entry.segments)) {
      return { ok: false, error: 'В файле нет сегментов транскрипта.', warnings: warnings };
    }

    var clean = [];
    var dropped = 0;
    for (var i = 0; i < entry.segments.length; i++) {
      var s = entry.segments[i];
      if (!s || typeof s !== 'object') { dropped++; continue; }
      var st = Number(s.startSec);
      if (!isFinite(st) || st < 0) { dropped++; continue; }
      var en = Number(s.endSec);
      var seg = {
        startSec: st,
        endSec: (isFinite(en) && en >= st) ? en : null,
        text: String(s.text == null ? '' : s.text)
      };
      if (s.speaker != null && String(s.speaker) !== '') seg.speaker = String(s.speaker);
      if (Array.isArray(s.words)) seg.words = s.words;
      clean.push(seg);
    }
    if (dropped) warnings.push('Пропущено сегментов с некорректным таймкодом: ' + dropped + '.');
    if (!clean.length) {
      return { ok: false, error: 'После проверки не осталось ни одного валидного сегмента.', warnings: warnings };
    }

    var out = {};
    for (var k in entry) { if (Object.prototype.hasOwnProperty.call(entry, k)) out[k] = entry[k]; }
    out.segments = clean;
    if (!out.text) {
      var parts = [];
      for (var j = 0; j < clean.length; j++) { if (clean[j].text) parts.push(clean[j].text); }
      out.text = parts.join(' ');
    }
    return { ok: true, entry: out, meta: meta, warnings: warnings };
  }

  /**
   * Перепривязка импортированного entry к активной секвенции.
   * Отпечаток НЕ подделываем: если файл из другой секвенции, timelineFp
   * останется чужим и мягкий гейт честно скажет «транскрипт устарел».
   * Если файл принадлежит той же секвенции — всё сходится само.
   */
  function rebindEntry(entry, seqId, seqName) {
    var out = {};
    for (var k in entry) { if (Object.prototype.hasOwnProperty.call(entry, k)) out[k] = entry[k]; }
    var sameSeq = String(entry.seqId || '') && String(entry.seqId || '') === String(seqId || '');
    out.seqId = String(seqId || '');
    out.seqName = String(seqName || entry.seqName || '');
    out.importedAt = Date.now();
    out.importedFromSeqId = String(entry.seqId || '');
    if (!sameSeq) {
      /* Чужая секвенция: отпечатки и региональный анализ к ней не относятся. */
      if (out.timelineFp) out.timelineFp = { hash: String(out.timelineFp.hash || ''), at: out.timelineFp.at || 0 };
      if (out.audioAnalysis && out.audioAnalysis.analyzedFp) {
        var aa = {};
        for (var k2 in out.audioAnalysis) { if (Object.prototype.hasOwnProperty.call(out.audioAnalysis, k2)) aa[k2] = out.audioAnalysis[k2]; }
        out.audioAnalysis = aa;
      }
    }
    /* Переверификация границ по плотной карте пауз (спека 06.08.2026): файл
       мог быть создан до появления верификации или отредактирован руками.
       Карта есть — честно пересчитываем времена и флаги (идемпотентно:
       уже снэпнутые границы стоят на краях пауз и подтвердятся заново).
       Карты нет — флаги не выдумываем, границы остаются как в файле. */
    try {
      var dense = out.audioAnalysis && Array.isArray(out.audioAnalysis.silencesDense)
        ? out.audioAnalysis.silencesDense : null;
      if (dense && dense.length && typeof global.TranscriptStructure !== 'undefined' &&
          typeof global.TranscriptStructure.verifySegmentBoundaries === 'function') {
        var v = global.TranscriptStructure.verifySegmentBoundaries(out.segments, dense);
        out.segments = v.segments;
        out.timingVerification = {
          verifiedPct: v.stats.verifiedPct,
          startsVerified: v.stats.startsVerified,
          endsVerified: v.stats.endsVerified,
          total: v.stats.total,
          adjustedCount: v.stats.adjustedCount,
          maxDriftSec: v.stats.maxDriftSec,
          at: Date.now()
        };
      }
    } catch (eV) { /* верификация — уточнение, не обязательный шаг импорта */ }
    return out;
  }

  var api = {
    FORMAT: FORMAT,
    FORMAT_VERSION: FORMAT_VERSION,
    safeFileName: safeFileName,
    defaultFileName: defaultFileName,
    buildExportPayload: buildExportPayload,
    parseImportPayload: parseImportPayload,
    rebindEntry: rebindEntry
  };

  /* Только global: в CEP включена Node-интеграция, поэтому `module` определён
     и UMD-ветка увела бы API в module.exports мимо window (так уже потерялся
     YouTubeExport). Тесты берут global из vm-контекста. */
  global.TranscriptIO = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
