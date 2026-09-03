import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTimelineTranscribe } from './load-timeline-transcribe.mjs';

/* ═══════════════════════════════════════════════════════════════
 * computeAudioPreprocess — wantRms-проводка для waveform-превью
 * Стабим AudioPreprocess.analyzeAll, проверяем offset-маппинг RMS в
 * sequence-time и opt-in поведение (без wantRms — rmsTimeline отсутствует).
 * ═══════════════════════════════════════════════════════════════ */

function makeStub(captured) {
  return {
    analyzeAll(inputPath, opt) {
      captured.opt = opt;
      return Promise.resolve({
        /* media-time (от 0): тишина 1..2с */
        silences: [{ startSec: 1.0, endSec: 2.0, durationSec: 1.0 }],
        loudness: { inputI: -23.5 },
        /* RMS-сэмплы в media-time */
        rms: [
          { t: 0.0, rms: -12 },
          { t: 0.5, rms: -40 },
          { t: 1.0, rms: -55 }
        ],
        silenceThresholdUsed: -30
      });
    }
  };
}

describe('TimelineTranscribe.computeAudioPreprocess — wantRms', () => {
  it('wantRms:true → rmsTimeline сдвинут в sequence-time на offset', async () => {
    const captured = {};
    const TT = loadTimelineTranscribe({ AudioPreprocess: makeStub(captured) });
    const off = 100; // workInSec
    const aa = await TT.computeAudioPreprocess('/tmp/a.wav', off, null, { wantRms: true, rmsWindowSec: 0.05 });

    // analyzeAll получил rms-опцию
    assert.ok(captured.opt && captured.opt.rms, 'analyzeAll вызван с rms-опцией');
    assert.equal(captured.opt.rms.windowSec, 0.05);

    // rmsTimeline присутствует и сдвинут на offset
    assert.ok(Array.isArray(aa.rmsTimeline), 'rmsTimeline массив');
    assert.equal(aa.rmsTimeline.length, 3);
    assert.equal(aa.rmsTimeline[0].t, 100.0);
    assert.equal(aa.rmsTimeline[1].t, 100.5);
    assert.equal(aa.rmsTimeline[2].t, 101.0);
    // rms-значения не трогаются
    assert.equal(aa.rmsTimeline[1].rms, -40);
    // inputI проброшен (нужен для адаптивного порога слайдера)
    assert.equal(aa.inputI, -23.5);

    // silences тоже в sequence-time (регресс существующего поведения)
    assert.equal(aa.silences[0].startSec, 101.0);
    assert.equal(aa.silences[0].endSec, 102.0);
  });

  it('без wantRms → rmsTimeline отсутствует (opt-in), rms-опция не запрашивается', async () => {
    const captured = {};
    const TT = loadTimelineTranscribe({ AudioPreprocess: makeStub(captured) });
    const aa = await TT.computeAudioPreprocess('/tmp/a.wav', 0, null);

    assert.ok(!captured.opt.rms, 'rms-опция НЕ передана в analyzeAll');
    assert.equal(aa.rmsTimeline, undefined, 'rmsTimeline отсутствует');
    // базовый анализ работает
    assert.equal(aa.silences[0].startSec, 1.0);
    assert.equal(aa.silenceThresholdUsed, -30);
  });

  it('wantRms:true но analyzeAll без rms → rmsTimeline отсутствует (graceful)', async () => {
    const captured = {};
    const stub = {
      analyzeAll(p, opt) {
        captured.opt = opt;
        return Promise.resolve({ silences: [], loudness: { inputI: -20 }, silenceThresholdUsed: -30 });
      }
    };
    const TT = loadTimelineTranscribe({ AudioPreprocess: stub });
    const aa = await TT.computeAudioPreprocess('/tmp/a.wav', 50, null, { wantRms: true });
    assert.equal(aa.rmsTimeline, undefined, 'нет res.rms → нет rmsTimeline');
  });
});

/* ═══════════════════════════════════════════════════════════════
 * mergeRmsTimelines — слияние перекрытых мик-дорожек (MAX по бакету)
 * ═══════════════════════════════════════════════════════════════ */

describe('TimelineTranscribe.mergeRmsTimelines', () => {
  const TT = loadTimelineTranscribe({});

  it('пустой/невалидный вход → []', () => {
    assert.equal(TT.mergeRmsTimelines([], 0.05).length, 0);
    assert.equal(TT.mergeRmsTimelines(null, 0.05).length, 0);
    assert.equal(TT.mergeRmsTimelines([null, []], 0.05).length, 0);
  });

  it('одна серия → плотная версия (бакеты по сетке)', () => {
    const s = [{ t: 0.0, rms: -12 }, { t: 0.05, rms: -14 }, { t: 0.1, rms: -13 }];
    const out = TT.mergeRmsTimelines([s], 0.05);
    assert.equal(out.length, 3);
    assert.equal(out[0].rms, -12);
    assert.equal(out[2].rms, -13);
  });

  it('перекрытые микрофоны → MAX (громчайший) в каждом бакете', () => {
    // mic A громкий в начале, mic B громкий в конце; один и тот же диапазон t
    const micA = [{ t: 0.0, rms: -10 }, { t: 0.05, rms: -12 }, { t: 0.1, rms: -50 }];
    const micB = [{ t: 0.0, rms: -55 }, { t: 0.05, rms: -52 }, { t: 0.1, rms: -11 }];
    const out = TT.mergeRmsTimelines([micA, micB], 0.05);
    assert.equal(out.length, 3);
    assert.equal(out[0].rms, -10, 'бакет0: max(-10,-55)');
    assert.equal(out[1].rms, -12, 'бакет1: max(-12,-52)');
    assert.equal(out[2].rms, -11, 'бакет2: max(-50,-11)');
  });

  it('пробел между сэмплами (все молчат) → заполнен SILENCE_FLOOR (-90)', () => {
    // сэмплы на 0.0 и 0.3 (между ними дыра — все микрофоны молчали/-inf)
    const s = [{ t: 0.0, rms: -12 }, { t: 0.3, rms: -12 }];
    const out = TT.mergeRmsTimelines([s], 0.05);
    // бакеты 0..6, заполнены: края -12, середина -90
    assert.ok(out.length >= 6, 'плотная сетка между 0 и 0.3');
    const mid = out.find((p) => p.t > 0.1 && p.t < 0.25);
    assert.ok(mid && mid.rms === -90, 'дыра = тишина -90');
    assert.equal(out[0].rms, -12);
    assert.equal(out[out.length - 1].rms, -12);
  });

  it('-Infinity-сэмплы пропускаются (как тишина-пробел)', () => {
    const s = [{ t: 0.0, rms: -12 }, { t: 0.05, rms: -Infinity }, { t: 0.1, rms: -12 }];
    const out = TT.mergeRmsTimelines([s], 0.05);
    assert.equal(out.length, 3);
    assert.equal(out[1].rms, -90, 'бакет с -inf → floor -90');
  });
});

/* ═══════════════════════════════════════════════════════════════
 * Волна 1.3 (10.07.2026): assertNonEmptyTranscript — пустой Whisper-результат
 * (тишина/шум) не должен уходить дальше в LLM-пайплайн.
 * ═══════════════════════════════════════════════════════════════ */

describe('TimelineTranscribe.assertNonEmptyTranscript', () => {
  const TT = loadTimelineTranscribe({});

  it('пустые segments + пустой text → бросает честную ошибку', () => {
    assert.throws(
      () => TT.assertNonEmptyTranscript({ segments: [], text: '', mode: 'export_wav' }),
      /не распознал речь/
    );
  });

  it('segments только с whitespace-текстами → бросает', () => {
    assert.throws(
      () => TT.assertNonEmptyTranscript({
        segments: [
          { startSec: 0, endSec: 1, text: '' },
          { startSec: 1, endSec: 2, text: '   ' }
        ],
        text: ' \n ',
        mode: 'export_chunks'
      }),
      /не распознал речь/
    );
  });

  it('хотя бы один сегмент с текстом → результат проходит как есть', () => {
    const res = {
      segments: [
        { startSec: 0, endSec: 1, text: '' },
        { startSec: 1, endSec: 2, text: 'привет' }
      ],
      text: 'привет',
      mode: 'export_wav'
    };
    assert.equal(TT.assertNonEmptyTranscript(res), res);
  });

  it('segments пусты, но есть общий text → проходит (fallback-режим)', () => {
    const res = { segments: [], text: 'сплошной текст без сегментов', mode: 'media_file' };
    assert.equal(TT.assertNonEmptyTranscript(res), res);
  });

  it('analysisOnly (аудиоанализ без транскрипции) → пустые segments — норма', () => {
    const res = { segments: [], text: '', analysisOnly: true, mode: 'audio-only' };
    assert.equal(TT.assertNonEmptyTranscript(res), res);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * Волна 1.4 (10.07.2026): cleanup temp-чанков при ошибке/abort
 * extractAudioChunksWithFfmpeg. Фейковый require: fs — Set «существующих»
 * файлов, execFile — контролируемые исходы по индексу чанка.
 * ═══════════════════════════════════════════════════════════════ */

function makeFakeFfmpegEnv(chunkBehavior) {
  const files = new Set();
  const unlinked = [];
  const fakeFs = {
    existsSync: (p) => p === '/opt/homebrew/bin/ffmpeg' || files.has(p),
    statSync: (p) => ({ size: files.has(p) ? 999999 : 0 }),
    unlinkSync: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      files.delete(p);
      unlinked.push(p);
    }
  };
  const fakeExecFile = (bin, args, o, cb) => {
    const outPath = args[args.length - 1];
    const m = /_(\d+)\.(wav|mp3)$/.exec(outPath);
    const idx = m ? Number(m[1]) : -1;
    chunkBehavior(idx, outPath, files, cb);
  };
  const modules = {
    fs: fakeFs,
    os: { tmpdir: () => '/tmp' },
    path: {
      join: (...a) => a.join('/'),
      extname: (p) => { const i = p.lastIndexOf('.'); return i >= 0 ? p.slice(i) : ''; },
      basename: (p, ext) => {
        let b = p.replace(/^.*[\/]/, '');
        if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
        return b;
      }
    },
    child_process: { execFile: fakeExecFile, execSync: () => { throw new Error('нет ffmpeg в PATH'); } }
  };
  return { require: (name) => modules[name], files, unlinked };
}

describe('TimelineTranscribe.extractAudioChunksWithFfmpeg — cleanup при сбое (Волна 1.4)', () => {
  it('успех: чанки созданы и НЕ удалены', async () => {
    const env = makeFakeFfmpegEnv((idx, outPath, files, cb) => {
      setTimeout(() => { files.add(outPath); cb(null); }, 1);
    });
    const TT = loadTimelineTranscribe({ require: env.require });
    /* span 200с, chunk 90с → 3 чанка */
    const chunks = await TT.extractAudioChunksWithFfmpeg('/media/in.mov', 0, 200, 90, null, 'wav');
    assert.equal(chunks.length, 3);
    assert.equal(env.files.size, 3);
    assert.equal(env.unlinked.length, 0);
  });

  it('ошибка одного чанка → уже созданные удалены, промис отклонён', async () => {
    const env = makeFakeFfmpegEnv((idx, outPath, files, cb) => {
      if (idx === 1) { setTimeout(() => cb(new Error('boom')), 5); return; }
      setTimeout(() => { files.add(outPath); cb(null); }, 1); /* 0 и 2 успевают раньше */
    });
    const TT = loadTimelineTranscribe({ require: env.require });
    await assert.rejects(
      TT.extractAudioChunksWithFfmpeg('/media/in.mov', 0, 200, 90, null, 'wav'),
      /ffmpeg error \(chunk 1\)/
    );
    assert.equal(env.files.size, 0, 'все созданные чанки должны быть удалены');
    assert.equal(env.unlinked.length, 2);
  });

  it('in-flight чанк доезжает ПОСЛЕ падения пула → сам удаляет свой файл', async () => {
    const env = makeFakeFfmpegEnv((idx, outPath, files, cb) => {
      if (idx === 0) { setTimeout(() => cb(new Error('boom')), 1); return; }  /* падает первым */
      setTimeout(() => { files.add(outPath); cb(null); }, 15);                /* доезжают позже */
    });
    const TT = loadTimelineTranscribe({ require: env.require });
    await assert.rejects(
      TT.extractAudioChunksWithFfmpeg('/media/in.mov', 0, 200, 90, null, 'wav'),
      /ffmpeg error \(chunk 0\)/
    );
    /* даём in-flight callback'ам доехать */
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(env.files.size, 0, 'поздние чанки должны самоудалиться');
  });

  it('пустой выход ffmpeg (файл не создан) → reject без мусора', async () => {
    const env = makeFakeFfmpegEnv((idx, outPath, files, cb) => {
      setTimeout(() => cb(null), 1); /* «успех» ffmpeg, но файла нет */
    });
    const TT = loadTimelineTranscribe({ require: env.require });
    await assert.rejects(
      TT.extractAudioChunksWithFfmpeg('/media/in.mov', 0, 100, 90, null, 'wav'),
      /пустой чанк/
    );
    assert.equal(env.files.size, 0);
  });
});

/* ═══ Word-level тайминги Whisper (ревью 09.2026) ═══ */
/* vm-лоадер → другой realm: сравниваем через JSON-копию, иначе strict deepEqual падает на прототипе */
const plain = (x) => JSON.parse(JSON.stringify(x));
describe('TimelineTranscribe.attachWordsToSegments', () => {
  const TT = loadTimelineTranscribe();
  it('верхнеуровневые words раскладываются по сегментам по середине слова', () => {
    const segs = [{ start: 0, end: 2, text: 'а б' }, { start: 2.5, end: 4, text: 'в' }];
    const words = [
      { word: 'а', start: 0.1, end: 0.5 }, { word: 'б', start: 1.0, end: 1.9 },
      { word: 'в', start: 2.6, end: 3.2 }, { word: 'x', start: 9, end: 9.5 }
    ];
    const out = TT.attachWordsToSegments(segs, words);
    assert.deepEqual(plain(out[0]), [{ w: 'а', s: 0.1, e: 0.5 }, { w: 'б', s: 1.0, e: 1.9 }]);
    assert.deepEqual(plain(out[1]), [{ w: 'в', s: 2.6, e: 3.2 }]);
  });
  it('words внутри сегмента имеют приоритет над верхнеуровневыми', () => {
    const segs = [{ start: 0, end: 2, text: 'а', words: [{ word: 'а', start: 0.2, end: 0.4 }] }];
    const out = TT.attachWordsToSegments(segs, [{ word: 'а', start: 0.1, end: 0.5 }]);
    assert.deepEqual(plain(out[0]), [{ w: 'а', s: 0.2, e: 0.4 }]);
  });
  it('без words → пустые списки', () => {
    assert.deepEqual(plain(TT.attachWordsToSegments([{ start: 0, end: 1 }], null)), [[]]);
  });
});

describe('normalizeWhisper* переносит words в сегменты', () => {
  const TT = loadTimelineTranscribe();
  it('export: слова со смещением таймлайна', () => {
    const r = TT.normalizeWhisperExport(
      { segments: [{ start: 0, end: 2, text: 'а б' }], words: [{ word: 'а', start: 0.1, end: 0.5 }] }, 10);
    assert.deepEqual(plain(r.segments[0].words), [{ w: 'а', s: 10.1, e: 10.5 }]);
  });
  it('media_file: формула clipStart + (t − inPoint), слова вне окна отбрасываются', () => {
    const r = TT.normalizeWhisperMediaFile(
      { segments: [{ start: 30, end: 40, text: 'а б' }],
        words: [{ word: 'а', start: 31, end: 32 }, { word: 'б', start: 38, end: 39 }] },
      100, 30, 100, 105);
    assert.equal(r.segments.length, 1);
    assert.deepEqual(plain(r.segments[0].words), [{ w: 'а', s: 101, e: 102 }]);
  });
  it('без words у сегментов нет поля words', () => {
    const r = TT.normalizeWhisperExport({ segments: [{ start: 0, end: 2, text: 'а' }] }, 0);
    assert.equal(r.segments[0].words, undefined);
  });
});

/* ═══ clampSegmentsToWindow (ревью 09.2026): хвост Whisper за концом окна ═══ */
describe('TimelineTranscribe.clampSegmentsToWindow', () => {
  const TT = loadTimelineTranscribe();
  it('media_file: workIn/workOut — хвост клэмпится, сегмент за окном выбрасывается', () => {
    const res = TT.clampSegmentsToWindow({ segments: [
      { startSec: 599.5, endSec: 602, text: 'a' }, { startSec: 700, endSec: 783.9, text: 'b' }, { startSec: 790, endSec: 795, text: 'c' }
    ] }, { workInSec: 600, workOutSec: 780 });
    assert.equal(res.segments.length, 2);
    assert.deepEqual([res.segments[0].startSec, res.segments[0].endSec], [600, 602]);
    assert.deepEqual([res.segments[1].startSec, res.segments[1].endSec], [700, 780]);
    assert.equal(res.clampedToWindow, 3);
  });
  it('nest/export: offset+windowDur; слова за окном отбрасываются', () => {
    const res = TT.clampSegmentsToWindow({ segments: [
      { startSec: 770, endSec: 785, text: 'x', words: [{ w: 'a', s: 771, e: 772 }, { w: 'b', s: 781, e: 782 }] }
    ] }, { timelineOffsetSec: 600, windowDurSec: 180 });
    assert.equal(res.segments[0].endSec, 780);
    assert.equal(JSON.parse(JSON.stringify(res.segments[0].words)).length, 1);
  });
  it('без окна в prep — без изменений', () => {
    const r = { segments: [{ startSec: 1, endSec: 2 }] };
    assert.equal(TT.clampSegmentsToWindow(r, {}), r);
    assert.equal(r.clampedToWindow, undefined);
  });
});

/* ═══ detectSimultaneousMics (ревью 09.2026): мультимик → микс ═══ */
describe('TimelineTranscribe.detectSimultaneousMics', () => {
  const TT = loadTimelineTranscribe();
  it('два микрофона на одном интервале → mix с сегментами в формате nest', () => {
    const r = TT.detectSimultaneousMics([
      { path: '/m1.wav', clipStartSec: 0, clipInPointSec: 100, workInSec: 10, workOutSec: 70 },
      { path: '/m2.wav', clipStartSec: 0, clipInPointSec: 50, workInSec: 10, workOutSec: 70 }
    ], 10);
    assert.equal(r.mix, true);
    assert.equal(r.segments.length, 2);
    const s = JSON.parse(JSON.stringify(r.segments[0]));
    assert.equal(s.srcStart, 110);      /* inPoint + (workIn − clipStart) */
    assert.equal(s.segDur, 60);
    assert.equal(s.localOffset, 0);
    assert.equal(s.outerStart, 10);
  });
  it('последовательные клипы (без пересечения) → не микс', () => {
    const r = TT.detectSimultaneousMics([
      { path: '/a.wav', clipStartSec: 0, clipInPointSec: 0, workInSec: 0, workOutSec: 30 },
      { path: '/b.wav', clipStartSec: 30, clipInPointSec: 0, workInSec: 30, workOutSec: 60 }
    ], 0);
    assert.equal(r.mix, false);
  });
  it('один клип → не микс', () => {
    assert.equal(TT.detectSimultaneousMics([{ path: '/a.wav', workInSec: 0, workOutSec: 10 }], 0).mix, false);
  });
});

/* ═══ fixChunkBoundarySegments (ревью 09.2026): дубли на швах чанков ═══ */
describe('TimelineTranscribe.fixChunkBoundarySegments', () => {
  const TT = loadTimelineTranscribe();
  const plain = (x) => JSON.parse(JSON.stringify(x));
  it('сегмент на границе, перекрытый хвостом предыдущего чанка, подрезается; полностью покрытый — выбрасывается', () => {
    const r = TT.fixChunkBoundarySegments([
      { startSec: 176, endSec: 181.5, text: 'доклад чувака, как они обучают' },
      { startSec: 180, endSec: 181.4, text: 'обучают.' },              /* целиком внутри хвоста → drop */
      { startSec: 180, endSec: 183.4, text: 'обучают нейросеть. Нет' }, /* подрезать до 181.5 */
      { startSec: 183.4, endSec: 185, text: 'там совершенно' }
    ], [180, 360]);
    const s = plain(r.segments);
    assert.equal(r.dropped, 1);
    assert.equal(r.fixed, 1);
    assert.equal(s.length, 3);
    assert.equal(s[1].startSec, 181.5);
    assert.equal(s[1].text, 'обучают нейросеть. Нет');
  });
  it('граница без перекрытия — без изменений; не-граничные сегменты не трогаются', () => {
    const r = TT.fixChunkBoundarySegments([
      { startSec: 178, endSec: 179.5, text: 'a' }, { startSec: 180, endSec: 182, text: 'b' }, { startSec: 182, endSec: 184, text: 'c' }
    ], [180]);
    assert.equal(r.fixed + r.dropped, 0);
    assert.equal(plain(r.segments).length, 3);
    const r2 = TT.fixChunkBoundarySegments([{ startSec: 1, endSec: 5, text: 'a' }, { startSec: 4, endSec: 6, text: 'b' }], [180]);
    assert.equal(r2.fixed + r2.dropped, 0);
  });
});
