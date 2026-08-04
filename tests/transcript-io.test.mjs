import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../client/shared/transcript-io.js');

function loadTranscriptIO() {
  const code = readFileSync(SRC, 'utf8');
  const ctx = {
    Array, Object, Math, String, Number, JSON, Error, RegExp, Date, isFinite, NaN,
    console, undefined,
    module: { exports: {} },
    exports: {}
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.TranscriptIO || ctx.module.exports;
}

const IO = loadTranscriptIO();

const SAMPLE = {
  seqId: 'seq-1',
  seqName: 'Интервью',
  segments: [
    { startSec: 0, endSec: 2.5, text: 'Привет' },
    { startSec: 2.5, endSec: 5, text: 'Как дела?', speaker: 'Гость' }
  ],
  text: 'Привет Как дела?',
  timelineFp: { hash: 'aabbccdd', at: 1000 },
  audioAnalysis: { silences: [], analyzedFp: 'aabbccdd' }
};

describe('TranscriptIO.safeFileName / defaultFileName', () => {
  test('убирает разделители пути и запрещённые символы', () => {
    assert.equal(IO.safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  });

  test('пустое имя → transcript', () => {
    assert.equal(IO.safeFileName(''), 'transcript');
    assert.equal(IO.safeFileName('   '), 'transcript');
    assert.equal(IO.safeFileName(null), 'transcript');
  });

  test('кириллица сохраняется, длина ограничена', () => {
    assert.equal(IO.safeFileName('Мельников Глеб, Цибрий Егор'), 'Мельников Глеб, Цибрий Егор');
    assert.equal(IO.safeFileName('я'.repeat(200)).length, 80);
  });

  test('имя файла содержит секвенцию, метку времени и расширение', () => {
    const name = IO.defaultFileName('Интервью', 'json', '2026-08-04T10:11:12.345Z');
    assert.equal(name, 'Интервью_2026-08-04T10-11-12-345.json');
  });
});

describe('TranscriptIO.buildExportPayload', () => {
  test('оборачивает entry с метаданными формата', () => {
    const p = IO.buildExportPayload(SAMPLE, { panelVersion: '2.16.0' });
    assert.equal(p.format, 'omc-transcript');
    assert.equal(p.formatVersion, 1);
    assert.equal(p.seqId, 'seq-1');
    assert.equal(p.seqName, 'Интервью');
    assert.equal(p.panelVersion, '2.16.0');
    assert.equal(p.entry.segments.length, 2);
    assert.ok(p.exportedAt);
  });

  test('seqId/seqName берутся из meta, если в entry их нет', () => {
    const p = IO.buildExportPayload({ segments: [] }, { seqId: 'x', seqName: 'y' });
    assert.equal(p.seqId, 'x');
    assert.equal(p.seqName, 'y');
  });
});

describe('TranscriptIO.parseImportPayload', () => {
  test('round-trip: экспорт → импорт даёт те же сегменты', () => {
    const json = JSON.stringify(IO.buildExportPayload(SAMPLE, {}));
    const r = IO.parseImportPayload(json);
    assert.equal(r.ok, true);
    assert.equal(r.entry.segments.length, 2);
    assert.equal(r.entry.segments[1].speaker, 'Гость');
    assert.equal(r.meta.seqId, 'seq-1');
    assert.equal(r.warnings.length, 0);
    assert.equal(r.entry.timelineFp.hash, 'aabbccdd');
  });

  test('битый JSON → ok:false с понятной ошибкой', () => {
    const r = IO.parseImportPayload('{не json');
    assert.equal(r.ok, false);
    assert.match(r.error, /корректным JSON/);
  });

  test('объект без segments → ok:false', () => {
    const r = IO.parseImportPayload('{"foo":1}');
    assert.equal(r.ok, false);
    assert.match(r.error, /нет транскрипта/);
  });

  test('массив вместо объекта → ok:false', () => {
    const r = IO.parseImportPayload('[1,2,3]');
    assert.equal(r.ok, false);
  });

  test('голый entry без обёртки принимается с предупреждением', () => {
    const r = IO.parseImportPayload(JSON.stringify(SAMPLE));
    assert.equal(r.ok, true);
    assert.equal(r.entry.segments.length, 2);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /без метаданных/);
  });

  test('битые сегменты отбрасываются, остальные остаются', () => {
    const r = IO.parseImportPayload(JSON.stringify({
      segments: [
        { startSec: 0, endSec: 1, text: 'ок' },
        { startSec: 'нет', text: 'мусор' },
        null,
        { startSec: -5, text: 'отрицательный' }
      ]
    }));
    assert.equal(r.ok, true);
    assert.equal(r.entry.segments.length, 1);
    assert.ok(r.warnings.some((w) => /Пропущено сегментов/.test(w)));
  });

  test('все сегменты битые → ok:false', () => {
    const r = IO.parseImportPayload(JSON.stringify({ segments: [{ startSec: 'x' }] }));
    assert.equal(r.ok, false);
    assert.match(r.error, /валидного сегмента/);
  });

  test('endSec меньше startSec → null (не ломает SRT)', () => {
    const r = IO.parseImportPayload(JSON.stringify({ segments: [{ startSec: 10, endSec: 3, text: 'а' }] }));
    assert.equal(r.ok, true);
    assert.equal(r.entry.segments[0].endSec, null);
  });

  test('text восстанавливается из сегментов, если его нет', () => {
    const r = IO.parseImportPayload(JSON.stringify({
      segments: [{ startSec: 0, text: 'раз' }, { startSec: 1, text: 'два' }]
    }));
    assert.equal(r.entry.text, 'раз два');
  });

  test('более новая версия формата → предупреждение, но импорт идёт', () => {
    const r = IO.parseImportPayload(JSON.stringify({
      format: 'omc-transcript', formatVersion: 99, entry: { segments: [{ startSec: 0, text: 'а' }] }
    }));
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /более новой версией/.test(w)));
  });
});

describe('TranscriptIO.rebindEntry', () => {
  test('привязка к той же секвенции сохраняет отпечатки', () => {
    const e = IO.rebindEntry(SAMPLE, 'seq-1', 'Интервью');
    assert.equal(e.seqId, 'seq-1');
    assert.equal(e.timelineFp.hash, 'aabbccdd');
    assert.equal(e.audioAnalysis.analyzedFp, 'aabbccdd');
    assert.equal(e.importedFromSeqId, 'seq-1');
    assert.ok(e.importedAt > 0);
  });

  test('чужая секвенция: отпечаток не подделывается (останется чужим)', () => {
    const e = IO.rebindEntry(SAMPLE, 'seq-2', 'Другая');
    assert.equal(e.seqId, 'seq-2');
    assert.equal(e.seqName, 'Другая');
    assert.equal(e.importedFromSeqId, 'seq-1');
    assert.equal(e.timelineFp.hash, 'aabbccdd');
  });

  test('не мутирует исходный entry', () => {
    const src = JSON.parse(JSON.stringify(SAMPLE));
    IO.rebindEntry(src, 'seq-9', 'Z');
    assert.equal(src.seqId, 'seq-1');
    assert.equal(src.importedAt, undefined);
  });
});
