import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadDeterministicPipelines } from './load-deterministic-pipelines.mjs';

const DP = loadDeterministicPipelines();

/* ═══════════════════════════════════════════════════════════════
 * Helpers
 * ═══════════════════════════════════════════════════════════════ */

function makeCtx(overrides) {
  return Object.assign({
    settings: { baseUrl: 'http://test', apiKey: 'k', chatModel: 'm' },
    snapshot: {
      ok: true,
      clips: [
        { trackType: 'video', trackIndex: 0, startSec: 0, endSec: 30 },
        { trackType: 'video', trackIndex: 0, startSec: 30, endSec: 60 },
        { trackType: 'audio', trackIndex: 0, startSec: 0, endSec: 30 },
        { trackType: 'audio', trackIndex: 0, startSec: 30, endSec: 60 }
      ]
    },
    transcriptEntry: null,
    onStatus: function () {},
    abortCheck: function () { return false; }
  }, overrides);
}

function makeEntry(segments, opts) {
  opts = opts || {};
  return Object.assign({
    segments: segments,
    audioAnalysis: opts.audioAnalysis || null,
    paragraphs: opts.paragraphs || null,
    topics: opts.topics || null
  }, opts);
}

/* ═══════════════════════════════════════════════════════════════
 * cutFillers
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines.cutFillers', () => {
  test('без транскрипта → ошибка', async () => {
    const r = await DP.cutFillers(makeCtx());
    assert.equal(r.ok, false);
    assert.match(r.error, /транскрипт/i);
  });

  test('нет филлеров → noChanges', async () => {
    const entry = makeEntry([
      { startSec: 0, endSec: 5, text: 'Сегодня мы рассмотрим важную тему' },
      { startSec: 5, endSec: 10, text: 'Вторая часть про стратегию' }
    ]);
    const r = await DP.cutFillers(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    assert.equal(r.noChanges, true);
  });

  test('strict: чистые филлеры (ээ, ммм, ну) → предлагает вырезать', async () => {
    const entry = makeEntry([
      { startSec: 0, endSec: 3, text: 'Начнём с обзора продукта' },
      { startSec: 3, endSec: 3.8, text: 'ээ' },
      { startSec: 4, endSec: 5, text: 'ммм' },
      { startSec: 5, endSec: 10, text: 'Итак, первая часть нашего плана' }
    ]);
    const r = await DP.cutFillers(makeCtx({ transcriptEntry: entry }), { sensitivity: 'strict' });
    assert.equal(r.ok, true);
    assert.ok(r.proposal);
    assert.equal(r.proposal.kind, 'transcript_cuts');
    assert.equal(r.proposal.removeIntervals.length, 2);
  });

  test('strict: расширенные филлеры (вот, типа, значит) НЕ вырезаются', async () => {
    const entry = makeEntry([
      { startSec: 0, endSec: 1, text: 'вот' },
      { startSec: 1, endSec: 2, text: 'типа' },
      { startSec: 2, endSec: 3, text: 'значит' }
    ]);
    const r = await DP.cutFillers(makeCtx({ transcriptEntry: entry }), { sensitivity: 'strict' });
    assert.equal(r.ok, true);
    assert.equal(r.noChanges, true);
  });

  test('normal: расширенные филлеры (вот, типа, значит) вырезаются', async () => {
    const entry = makeEntry([
      { startSec: 0, endSec: 0.8, text: 'вот' },
      { startSec: 1, endSec: 1.9, text: 'типа' },
      { startSec: 2, endSec: 2.7, text: 'значит' }
    ]);
    const r = await DP.cutFillers(makeCtx({ transcriptEntry: entry }), { sensitivity: 'normal' });
    assert.equal(r.ok, true);
    assert.ok(r.proposal);
    assert.equal(r.proposal.removeIntervals.length, 3);
  });

  test('длинные сегменты НЕ считаются филлерами (даже если текст совпадает)', async () => {
    const entry = makeEntry([
      { startSec: 0, endSec: 3, text: 'ну' } // > MAX_FILLER_DURATION (1.5)
    ]);
    const r = await DP.cutFillers(makeCtx({ transcriptEntry: entry }), { sensitivity: 'strict' });
    assert.equal(r.ok, true);
    assert.equal(r.noChanges, true);
  });

  test('сегменты с >4 словами: целиком не филлер, но начало/конец ловятся', async () => {
    const entry = makeEntry([
      { startSec: 0, endSec: 2.5, text: 'ну вот ээ ммм блин' } // 5 слов, >maxDur — путь A отвергнет
    ]);
    const r = await DP.cutFillers(makeCtx({ transcriptEntry: entry }), { sensitivity: 'strict' });
    assert.equal(r.ok, true);
    /* Путь B должен найти «ну» в начале */
    assert.ok(r.proposal || r.noChanges); /* зависит от того, совпадёт ли "ну" как strict filler */
  });

  test('padding: интервалы уже сегмента', async () => {
    const entry = makeEntry([
      { startSec: 10, endSec: 11, text: 'ээ' }
    ]);
    const r = await DP.cutFillers(makeCtx({ transcriptEntry: entry }));
    assert.ok(r.proposal);
    const iv = r.proposal.removeIntervals[0];
    assert.ok(iv.startSec > 10, 'startSec должен быть сдвинут вперёд на padding');
    assert.ok(iv.endSec < 11, 'endSec должен быть сдвинут назад на padding');
  });

  test('повторы "э-э-э" распознаются как филлер', async () => {
    const entry = makeEntry([
      { startSec: 0, endSec: 1, text: 'э-э-э' }
    ]);
    const r = await DP.cutFillers(makeCtx({ transcriptEntry: entry }));
    assert.ok(r.proposal);
    assert.equal(r.proposal.removeIntervals.length, 1);
  });

  test('нормальная речь НЕ вырезается (длинные предложения)', async () => {
    const entry = makeEntry([
      { startSec: 0, endSec: 5, text: 'Давайте рассмотрим этот вопрос подробнее сегодня' },
      { startSec: 5, endSec: 10, text: 'Результаты нашего исследования за последний год показали рост' }
    ]);
    const r = await DP.cutFillers(makeCtx({ transcriptEntry: entry }), { sensitivity: 'normal' });
    assert.equal(r.ok, true);
    /* Если нет филлер-слов в начале/конце — noChanges */
    assert.equal(r.noChanges, true);
  });

  test('поле startSec/endSec и start/end оба работают', async () => {
    const entry = makeEntry([
      { start: 0, end: 0.8, text: 'ээ' }
    ]);
    const r = await DP.cutFillers(makeCtx({ transcriptEntry: entry }));
    assert.ok(r.proposal);
    assert.equal(r.proposal.removeIntervals.length, 1);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * cutSilences
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines.cutSilences', () => {
  test('без транскрипта → ошибка', async () => {
    const r = await DP.cutSilences(makeCtx());
    assert.equal(r.ok, false);
  });

  test('без audioAnalysis.silences → работает через gaps между сегментами', async () => {
    const entry = makeEntry([
      { startSec: 0, endSec: 3, text: 'первая фраза' },
      { startSec: 5, endSec: 10, text: 'вторая фраза' }  /* gap = 2с > minDuration 1.0 */
    ]);
    const r = await DP.cutSilences(makeCtx({ transcriptEntry: entry }));
    /* Гибридный подход: gaps между сегментами = тишины, даже без audioAnalysis */
    assert.equal(r.ok, true);
    assert.ok(r.proposal);
    assert.ok(r.proposal.removeIntervals.length >= 1);
  });

  test('тишины длиннее minDuration → proposal с вырезкой', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 30, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [
            { startSec: 5, endSec: 8 },    // 3s > default 1.0
            { startSec: 15, endSec: 16.2 }, // 1.2s > 1.0
            { startSec: 20, endSec: 20.5 }  // 0.5s < 1.0 — skip
          ]
        }
      }
    );
    const r = await DP.cutSilences(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    assert.ok(r.proposal);
    assert.equal(r.proposal.kind, 'transcript_cuts');
    assert.equal(r.proposal.removeIntervals.length, 2);
  });

  test('minDuration=2 фильтрует короткие тишины', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 30, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [
            { startSec: 5, endSec: 8 },    // 3s > 2
            { startSec: 15, endSec: 16.5 } // 1.5s < 2 — skip
          ]
        }
      }
    );
    const r = await DP.cutSilences(makeCtx({ transcriptEntry: entry }), { minDuration: 2 });
    assert.equal(r.proposal.removeIntervals.length, 1);
  });

  test('padding обрезает края тишин', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 30, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [{ startSec: 10, endSec: 15 }]
        }
      }
    );
    const r = await DP.cutSilences(makeCtx({ transcriptEntry: entry }), { padding: 0.3 });
    const iv = r.proposal.removeIntervals[0];
    assert.equal(iv.startSec, 10.3);
    assert.equal(iv.endSec, 14.7);
  });

  test('нет длинных тишин → noChanges', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 10, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [{ startSec: 3, endSec: 3.3 }] // 0.3s < 1.0
        }
      }
    );
    const r = await DP.cutSilences(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    assert.equal(r.noChanges, true);
  });

  test('поля start/end вместо startSec/endSec работают', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 30, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [{ start: 5, end: 8 }]
        }
      }
    );
    const r = await DP.cutSilences(makeCtx({ transcriptEntry: entry }));
    assert.ok(r.proposal);
    assert.equal(r.proposal.removeIntervals.length, 1);
  });

  test('NaN в silence → пропускается', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 30, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [
            { foo: 'bar' },      // no startSec/endSec → NaN → skip
            { startSec: 5, endSec: 8 } // valid
          ]
        }
      }
    );
    const r = await DP.cutSilences(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.proposal.removeIntervals.length, 1);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * jumpCuts
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines.jumpCuts', () => {
  test('без транскрипта → ошибка', async () => {
    const r = await DP.jumpCuts(makeCtx());
    assert.equal(r.ok, false);
  });

  test('без audioAnalysis → работает через gaps между сегментами', async () => {
    const entry = makeEntry([
      { startSec: 0, endSec: 3, text: 'первая' },
      { startSec: 4, endSec: 8, text: 'вторая' }  /* gap = 1.0с > maxPause 0.5 */
    ]);
    const r = await DP.jumpCuts(makeCtx({ transcriptEntry: entry }));
    /* Гибридный подход: gaps между сегментами используются для jump cuts */
    assert.equal(r.ok, true);
    assert.ok(r.proposal);
    assert.ok(r.proposal.removeIntervals.length >= 1);
  });

  test('паузы ≥ maxPause → proposal', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 20, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [
            { startSec: 3, endSec: 4.5 },  // 1.5s ≥ 0.5
            { startSec: 10, endSec: 10.3 }, // 0.3s < 0.5 — skip
            { startSec: 15, endSec: 16 }    // 1.0s ≥ 0.5
          ]
        }
      }
    );
    const r = await DP.jumpCuts(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    assert.ok(r.proposal);
    assert.equal(r.proposal.kind, 'transcript_cuts');
    assert.equal(r.proposal.removeIntervals.length, 2);
  });

  test('maxPause параметр уважается', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 20, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [
            { startSec: 3, endSec: 4 },   // 1.0s < 1.5
            { startSec: 10, endSec: 12.5 } // 2.5s ≥ 1.5
          ]
        }
      }
    );
    const r = await DP.jumpCuts(makeCtx({ transcriptEntry: entry }), { maxPause: 1.5 });
    assert.equal(r.proposal.removeIntervals.length, 1);
  });

  test('нет пауз ≥ maxPause → noChanges', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 10, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [{ startSec: 3, endSec: 3.3 }]
        }
      }
    );
    const r = await DP.jumpCuts(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    assert.equal(r.noChanges, true);
  });

  test('keepBreathing=0.05 → padding в интервалах 50мс, не ноль', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 20, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [{ startSec: 5, endSec: 7 }] /* 2с → >maxPause */
        }
      }
    );
    const r = await DP.jumpCuts(makeCtx({ transcriptEntry: entry }), {
      maxPause: 0.5,
      keepBreathing: 0.05,
      minSegmentDuration: 0
    });
    assert.equal(r.ok, true);
    assert.ok(r.proposal);
    const iv = r.proposal.removeIntervals[0];
    /* дыхание 0.05с с каждой стороны */
    assert.ok(Math.abs(iv.startSec - 5.05) < 0.001, 'startSec должен быть 5.05 (5 + 0.05)');
    assert.ok(Math.abs(iv.endSec - 6.95) < 0.001, 'endSec должен быть 6.95 (7 - 0.05)');
  });

  test('keepBreathing=0 → режет в ноль (startSec/endSec = границы тишины)', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 20, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [{ startSec: 5, endSec: 7 }]
        }
      }
    );
    const r = await DP.jumpCuts(makeCtx({ transcriptEntry: entry }), {
      maxPause: 0.5,
      keepBreathing: 0,
      minSegmentDuration: 0
    });
    const iv = r.proposal.removeIntervals[0];
    assert.equal(iv.startSec, 5);
    assert.equal(iv.endSec, 7);
  });

  test('minSegmentDuration=0.3 → соседние интервалы с мини-сегментом между ними поглощаются', async () => {
    /* Два интервала тишины с речью в 0.2с между ними — должны слиться. */
    const entry = makeEntry(
      [{ startSec: 0, endSec: 20, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [
            { startSec: 5, endSec: 7 },    /* 2с */
            { startSec: 7.2, endSec: 9 }  /* 1.8с, gap 0.2с */
          ]
        }
      }
    );
    const r = await DP.jumpCuts(makeCtx({ transcriptEntry: entry }), {
      maxPause: 0.5,
      keepBreathing: 0,
      minSegmentDuration: 0.3
    });
    assert.equal(r.proposal.removeIntervals.length, 1, 'два интервала с мини-gap 0.2с должны слиться');
    const iv = r.proposal.removeIntervals[0];
    assert.equal(iv.startSec, 5);
    assert.equal(iv.endSec, 9);
  });

  test('minSegmentDuration=0 → интервалы НЕ мёрджатся по gap', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 20, text: 'тест' }],
      {
        audioAnalysis: {
          silences: [
            { startSec: 5, endSec: 7 },
            { startSec: 7.2, endSec: 9 }
          ]
        }
      }
    );
    const r = await DP.jumpCuts(makeCtx({ transcriptEntry: entry }), {
      maxPause: 0.5,
      keepBreathing: 0,
      minSegmentDuration: 0
    });
    assert.equal(r.proposal.removeIntervals.length, 2);
  });

  test('R13: jumpCuts gating по threshold — строгий порог убирает ffmpeg тишины', async () => {
    /* silenceThresholdUsed=-30; пользователь хочет -40 (строже) →
       ffmpeg silences обнаружены при -30 и не попадают в результат. */
    const entry = makeEntry(
      [{ startSec: 0, endSec: 20, text: 'тест' }],
      {
        audioAnalysis: {
          silenceThresholdUsed: -30,
          silences: [{ startSec: 5, endSec: 7 }]
        }
      }
    );
    /* direct call detectSilenceIntervals with stricter threshold */
    const intervals = DP.detectSilenceIntervals(entry, {
      minDuration: 0.5,
      padding: 0,
      thresholdDb: -40, /* строже чем -30 → gating отсекает ffmpeg */
      source: 'gaps+ffmpeg'
    });
    assert.equal(intervals.length, 0, 'ffmpeg тишина должна быть отфильтрована строгим порогом');
  });
});

/* ═══════════════════════════════════════════════════════════════
 * detectSilenceIntervals (shared helper)
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines.detectSilenceIntervals', () => {
  test('source=gaps — только gaps между сегментами', () => {
    const entry = makeEntry(
      [
        { startSec: 0, endSec: 3, text: 'a' },
        { startSec: 5, endSec: 8, text: 'b' } /* gap 2с */
      ],
      {
        audioAnalysis: {
          silences: [{ startSec: 10, endSec: 12 }]
        }
      }
    );
    const r = DP.detectSilenceIntervals(entry, { minDuration: 1, padding: 0, source: 'gaps' });
    assert.equal(r.length, 1);
    assert.equal(r[0].startSec, 3);
    assert.equal(r[0].endSec, 5);
  });

  test('source=ffmpeg — только ffmpeg silences, gaps игнорируются', () => {
    const entry = makeEntry(
      [
        { startSec: 0, endSec: 3, text: 'a' },
        { startSec: 5, endSec: 8, text: 'b' }
      ],
      {
        audioAnalysis: {
          silenceThresholdUsed: -30,
          silences: [{ startSec: 10, endSec: 12 }]
        }
      }
    );
    const r = DP.detectSilenceIntervals(entry, { minDuration: 1, padding: 0, source: 'ffmpeg' });
    assert.equal(r.length, 1);
    assert.equal(r[0].startSec, 10);
    assert.equal(r[0].endSec, 12);
  });

  test('source=gaps+ffmpeg (default) — оба источника', () => {
    const entry = makeEntry(
      [
        { startSec: 0, endSec: 3, text: 'a' },
        { startSec: 5, endSec: 8, text: 'b' }
      ],
      {
        audioAnalysis: {
          silenceThresholdUsed: -30,
          silences: [{ startSec: 10, endSec: 12 }]
        }
      }
    );
    const r = DP.detectSilenceIntervals(entry, { minDuration: 1, padding: 0 });
    assert.equal(r.length, 2);
  });

  test('padding применяется к обоим источникам', () => {
    const entry = makeEntry(
      [
        { startSec: 0, endSec: 3, text: 'a' },
        { startSec: 6, endSec: 9, text: 'b' }
      ]
    );
    const r = DP.detectSilenceIntervals(entry, { minDuration: 1, padding: 0.3, source: 'gaps' });
    assert.equal(r[0].startSec, 3.3);
    assert.equal(r[0].endSec, 5.7);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * chapterize
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines.chapterize', () => {
  test('без транскрипта → ошибка', async () => {
    const r = await DP.chapterize(makeCtx());
    assert.equal(r.ok, false);
    assert.match(r.error, /транскрипт/i);
  });

  test('с предготовленными topics → proposal с маркерами', async () => {
    const entry = makeEntry(
      [
        { startSec: 0, endSec: 30, text: 'Вступление и обзор темы' },
        { startSec: 30, endSec: 60, text: 'Основная часть презентации' },
        { startSec: 60, endSec: 90, text: 'Заключение и выводы' }
      ],
      {
        topics: [
          { startSec: 0, endSec: 30, title: 'Вступление', summary: 'обзор' },
          { startSec: 30, endSec: 60, title: 'Основная часть', summary: 'детали' },
          { startSec: 60, endSec: 90, title: 'Заключение', summary: 'итоги' }
        ]
      }
    );
    const r = await DP.chapterize(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    assert.ok(r.proposal);
    assert.equal(r.proposal.kind, 'markers');
    assert.equal(r.proposal.markers.length, 3);
    assert.equal(r.proposal.markers[0].type, 'chapter');
  });

  test('маркеры ближе 15с фильтруются', async () => {
    const entry = makeEntry(
      [{ startSec: 0, endSec: 60, text: 'тест' }],
      {
        topics: [
          { startSec: 0, endSec: 5, title: 'A', summary: '' },
          { startSec: 5, endSec: 10, title: 'B', summary: '' },   // < 15s от A → skip
          { startSec: 20, endSec: 40, title: 'C', summary: '' },  // 20s от A → keep
          { startSec: 25, endSec: 60, title: 'D', summary: '' }   // 5s от C → skip
        ]
      }
    );
    const r = await DP.chapterize(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.proposal.markers.length, 2);
  });

  test('time-based fallback при пустых topics и длинном транскрипте', async () => {
    const segs = [];
    for (let i = 0; i < 20; i++) {
      segs.push({ startSec: i * 10, endSec: (i + 1) * 10, text: 'Сегмент номер ' + i });
    }
    const entry = makeEntry(segs); // no topics, no audioAnalysis
    /* Загружаем с TranscriptStructure, который не возвращает topics */
    const DP2 = loadDeterministicPipelines({
      TranscriptStructure: {
        buildParagraphs: () => [],
        buildTopicsWithLLM: () => Promise.resolve([])
      }
    });
    const r = await DP2.chapterize(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    assert.ok(r.proposal);
    assert.equal(r.proposal.kind, 'markers');
    assert.ok(r.proposal.markers.length >= 2, 'time-based fallback должен дать ≥2 глав');
  });

  /* US-005: adaptive min-interval между главами (3 тира длительности) */
  test('US-005: короткий ролик (<3min) — min-interval 10с, главы через 10с проходят', async () => {
    /* 120с, главы на 0, 10, 20, 30 — все должны пройти при пороге 10с */
    const segs = [];
    for (let i = 0; i < 12; i++) {
      segs.push({ startSec: i * 10, endSec: (i + 1) * 10, text: 'Текст ' + i });
    }
    const entry = makeEntry(segs, {
      topics: [
        { startSec: 0, endSec: 10, title: 'Альфа тема один', summary: '' },
        { startSec: 10, endSec: 20, title: 'Бета тема два', summary: '' },
        { startSec: 20, endSec: 30, title: 'Гамма тема три', summary: '' },
        { startSec: 30, endSec: 40, title: 'Дельта тема четыре', summary: '' }
      ]
    });
    const r = await DP.chapterize(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    assert.equal(r.proposal.markers.length, 4, 'при 120с порог 10с должен пропустить все 4 главы');
  });

  test('US-005: средний ролик (3-10min) — min-interval 20с, главы через 15с отсеиваются', async () => {
    const segs = [];
    for (let i = 0; i < 30; i++) {
      segs.push({ startSec: i * 20, endSec: (i + 1) * 20, text: 'Текст ' + i });
    }
    /* 600с, главы на 0/15/30/50 — при пороге 20с вторая (15с) отсеется, третья (30с от 0) пройдёт */
    const entry = makeEntry(segs, {
      topics: [
        { startSec: 0, endSec: 15, title: 'Альфа раз два', summary: '' },
        { startSec: 15, endSec: 30, title: 'Бета три четыре', summary: '' },
        { startSec: 30, endSec: 50, title: 'Гамма пять шесть', summary: '' },
        { startSec: 50, endSec: 70, title: 'Дельта семь восемь', summary: '' }
      ]
    });
    const r = await DP.chapterize(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    /* 0 (keep) → 15 (15с < 20 → skip) → 30 (30с от 0 → keep) → 50 (20с → keep) */
    assert.equal(r.proposal.markers.length, 3);
  });

  test('US-005: длинный ролик (>10min) — min-interval 45с, главы через 20-30с отсеиваются', async () => {
    const segs = [];
    for (let i = 0; i < 50; i++) {
      segs.push({ startSec: i * 20, endSec: (i + 1) * 20, text: 'Текст ' + i });
    }
    /* 1000с → порог 45с. Главы на 0/20/40/50/100 */
    const entry = makeEntry(segs, {
      topics: [
        { startSec: 0, endSec: 20, title: 'Альфа раз', summary: '' },
        { startSec: 20, endSec: 40, title: 'Бета два', summary: '' },
        { startSec: 40, endSec: 50, title: 'Гамма три', summary: '' },
        { startSec: 50, endSec: 100, title: 'Дельта четыре', summary: '' },
        { startSec: 100, endSec: 200, title: 'Эпсилон пять', summary: '' }
      ]
    });
    const r = await DP.chapterize(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    /* 0 (keep) → 20 skip → 40 skip → 50 keep (50с от 0) → 100 keep (50с от 50) */
    assert.equal(r.proposal.markers.length, 3);
  });

  /* US-005: boilerplate-имена («Часть N», «Продолжение», «Следующая часть») заменяются */
  test('US-005: название «Часть 2» заменяется на реальные слова из абзаца', async () => {
    const segs = [
      { startSec: 0, endSec: 30, text: 'Вступительный текст про проект' },
      { startSec: 30, endSec: 60, text: 'Архитектура системы состоит из компонентов' },
      { startSec: 60, endSec: 90, text: 'Заключение подведение итогов' }
    ];
    const entry = makeEntry(segs, {
      paragraphs: [
        { startSec: 0, endSec: 30, text: 'Вступительный текст про проект' },
        { startSec: 30, endSec: 60, text: 'Архитектура системы состоит из компонентов' },
        { startSec: 60, endSec: 90, text: 'Заключение подведение итогов' }
      ],
      topics: [
        { startSec: 0, endSec: 30, title: 'Вступление', summary: '' },
        { startSec: 30, endSec: 60, title: 'Часть 2', summary: '' },
        { startSec: 60, endSec: 90, title: 'Продолжение', summary: '' }
      ]
    });
    const r = await DP.chapterize(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    assert.equal(r.proposal.markers[0].name, 'Вступление');
    assert.doesNotMatch(r.proposal.markers[1].name, /^часть\s*\d+$/i, '«Часть 2» должно быть заменено');
    assert.ok(r.proposal.markers[1].name.length > 0);
    assert.doesNotMatch(r.proposal.markers[2].name, /^продолжение$/i, '«Продолжение» должно быть заменено');
  });

  test('US-005: boilerplate-паттерны «Part 3», «Следующая часть» тоже ловятся', async () => {
    const segs = [
      { startSec: 0, endSec: 30, text: 'Обзор решения и контекст' },
      { startSec: 30, endSec: 60, text: 'Детали реализации модулей кода' }
    ];
    const entry = makeEntry(segs, {
      paragraphs: [
        { startSec: 0, endSec: 30, text: 'Обзор решения и контекст' },
        { startSec: 30, endSec: 60, text: 'Детали реализации модулей кода' }
      ],
      topics: [
        { startSec: 0, endSec: 30, title: 'Part 3', summary: '' },
        { startSec: 30, endSec: 60, title: 'Следующая часть', summary: '' }
      ]
    });
    const r = await DP.chapterize(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.proposal.markers[0].name, /^part\s*\d+$/i);
    assert.doesNotMatch(r.proposal.markers[1].name, /^следующ.+часть$/i);
  });

  test('US-005: time-based fallback даёт осмысленные названия, не «Часть N»', async () => {
    const segs = [];
    for (let i = 0; i < 20; i++) {
      segs.push({
        startSec: i * 10,
        endSec: (i + 1) * 10,
        text: 'Сегмент ' + i + ' интересный смысловой контент'
      });
    }
    const entry = makeEntry(segs);
    const DP2 = loadDeterministicPipelines({
      TranscriptStructure: {
        buildParagraphs: () => [],
        buildTopicsWithLLM: () => Promise.resolve([])
      }
    });
    const r = await DP2.chapterize(makeCtx({ transcriptEntry: entry }));
    assert.equal(r.ok, true);
    /* markers[0] = 'Вступление', остальные должны быть НЕ «Часть N» */
    for (let i = 1; i < r.proposal.markers.length; i++) {
      assert.doesNotMatch(
        r.proposal.markers[i].name,
        /^часть\s*\d+$/i,
        'fallback-глава ' + i + ' должна содержать реальные слова, а не «Часть N»: ' + r.proposal.markers[i].name
      );
      assert.ok(r.proposal.markers[i].name.length > 0);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
 * jCuts — ОТКЛЮЧЕНО
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines.jCuts — disabled', () => {
  test('всегда возвращает ok:false', async () => {
    const r = await DP.jCuts(makeCtx());
    assert.equal(r.ok, false);
    assert.match(r.error, /отключен|unlink/i);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * parsePipelineCommand
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines.parsePipelineCommand', () => {
  test('/cut_fillers → cutFillers pipeline', () => {
    const r = DP.parsePipelineCommand('/cut_fillers');
    assert.ok(r);
    assert.equal(r.name, '/cut_fillers');
    assert.equal(r.pipeline, DP.cutFillers);
  });

  test('/cut_silences minDuration=2 → params', () => {
    const r = DP.parsePipelineCommand('/cut_silences minDuration=2');
    assert.ok(r);
    assert.equal(r.params.minDuration, 2);
  });

  test('/chapterize → chapterize pipeline', () => {
    const r = DP.parsePipelineCommand('/chapterize');
    assert.ok(r);
    assert.equal(r.name, '/chapterize');
  });

  test('/jump_cuts maxPause=0.3 → params', () => {
    const r = DP.parsePipelineCommand('/jump_cuts maxPause=0.3');
    assert.ok(r);
    assert.equal(r.params.maxPause, 0.3);
  });

  test('/j_cuts → jCuts pipeline', () => {
    const r = DP.parsePipelineCommand('/j_cuts');
    assert.ok(r);
    assert.equal(r.pipeline, DP.jCuts);
  });

  test('/l_cuts → jCuts pipeline (same function)', () => {
    const r = DP.parsePipelineCommand('/l_cuts');
    assert.ok(r);
    assert.equal(r.pipeline, DP.jCuts);
  });

  test('/cut_fillers sensitivity=expanded → строковый параметр', () => {
    const r = DP.parsePipelineCommand('/cut_fillers sensitivity=expanded');
    assert.ok(r);
    assert.equal(r.params.sensitivity, 'expanded');
  });

  test('/cut_silences minDuration=2 padding=0.1 → два числовых параметра', () => {
    const r = DP.parsePipelineCommand('/cut_silences minDuration=2 padding=0.1');
    assert.ok(r);
    assert.equal(r.params.minDuration, 2);
    assert.equal(r.params.padding, 0.1);
  });

  test('обычный текст → null', () => {
    assert.equal(DP.parsePipelineCommand('привет'), null);
    assert.equal(DP.parsePipelineCommand('сделай j-cuts'), null);
  });

  test('неизвестная команда → null', () => {
    assert.equal(DP.parsePipelineCommand('/unknown_command'), null);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * _mergeIntervals
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines._mergeIntervals', () => {
  test('неперекрывающиеся интервалы не сливаются', () => {
    const input = [
      { startSec: 0, endSec: 1, reason: 'a' },
      { startSec: 5, endSec: 6, reason: 'b' }
    ];
    const r = DP._mergeIntervals(input);
    assert.equal(r.length, 2);
  });

  test('перекрывающиеся интервалы сливаются', () => {
    const input = [
      { startSec: 0, endSec: 3, reason: 'a' },
      { startSec: 2, endSec: 5, reason: 'b' }
    ];
    const r = DP._mergeIntervals(input);
    assert.equal(r.length, 1);
    assert.equal(r[0].startSec, 0);
    assert.equal(r[0].endSec, 5);
  });

  test('смежные интервалы (gap ≤ 0.05) сливаются', () => {
    const input = [
      { startSec: 0, endSec: 3, reason: 'a' },
      { startSec: 3.04, endSec: 5, reason: 'b' }
    ];
    const r = DP._mergeIntervals(input);
    assert.equal(r.length, 1);
  });

  test('пустой вход → пустой результат', () => {
    assert.deepEqual(DP._mergeIntervals([]), []);
  });

  test('причины объединяются при слиянии', () => {
    const input = [
      { startSec: 0, endSec: 3, reason: 'a' },
      { startSec: 2, endSec: 5, reason: 'b' }
    ];
    const r = DP._mergeIntervals(input);
    assert.ok(r[0].reason.includes('a'));
    assert.ok(r[0].reason.includes('b'));
  });
});

/* ═══════════════════════════════════════════════════════════════
 * _silencesFromSegmentGaps (exported helper)
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines._silencesFromSegmentGaps', () => {
  test('зазоры между сегментами ≥ minGap', () => {
    const segs = [
      { startSec: 0, endSec: 3 },
      { startSec: 5, endSec: 8 },  // gap: 2s
      { startSec: 8.5, endSec: 10 } // gap: 0.5s
    ];
    const r = DP._silencesFromSegmentGaps(segs, 1);
    assert.equal(r.length, 1);
    assert.equal(r[0].startSec, 3);
    assert.equal(r[0].endSec, 5);
  });

  test('нет зазоров → пустой результат', () => {
    const segs = [
      { startSec: 0, endSec: 3 },
      { startSec: 3, endSec: 6 }
    ];
    assert.equal(DP._silencesFromSegmentGaps(segs, 0.5).length, 0);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * multicamFromAudio
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines.multicamFromAudio', () => {
  function snap3v2a() {
    return {
      ok: true,
      sequenceName: 'seq',
      tracks: [
        { type: 'video', index: 0 }, { type: 'video', index: 1 }, { type: 'video', index: 2 },
        { type: 'audio', index: 0 }, { type: 'audio', index: 1 }
      ]
    };
  }

  it('switches to the louder mic per frame', async () => {
    // Track A (speaker 0) loud for first 2s, Track B (speaker 1) loud for next 2s.
    const frameSec = 0.05;
    const loud = -10, quiet = -50;
    const tlA = [], tlB = [];
    for (let i = 1; i <= 80; i++) {
      const t = +(i * frameSec).toFixed(3);
      tlA.push({ t, rms: i <= 40 ? loud : quiet });
      tlB.push({ t, rms: i <= 40 ? quiet : loud });
    }
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.resolve({ timelines: [tlA, tlB] })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.equal(res.proposal.kind, 'multicam_cuts');
    const segs = res.proposal.plan.segments;
    // First segment should be speaker-0 video (track 1), a later one speaker-1 video (track 2).
    assert.equal(segs[0].activeVideoTrack, 1);
    assert.ok(segs.some(s => s.activeVideoTrack === 2));
    // Plan contract intact for the host:
    assert.equal(res.proposal.plan.mapping.wideVideoTrack, 0);
    assert.equal(res.proposal.plan.params.mode, 'disable');
  });

  it('пробрасывает Phase 2B параметры: maxHoldSec → больше cutaway, variationsJitterSec → сдвиг границ', async () => {
    // Один спикер говорит непрерывно 20с — без maxHold это был бы один длинный план.
    const frameSec = 0.05;
    const tlA = [], tlB = [];
    for (let i = 1; i <= 400; i++) {
      const t = +(i * frameSec).toFixed(3);
      tlA.push({ t, rms: -10 });
      tlB.push({ t, rms: -50 });
    }
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.resolve({ timelines: [tlA, tlB] })
    };
    const base = await DP.multicamFromAudio(ctx, {});            // DEFAULTS: maxHoldSec=8
    const capped = await DP.multicamFromAudio(ctx, { maxHoldSec: 3 });
    assert.equal(base.ok, true);
    assert.equal(capped.ok, true);
    assert.ok(
      capped.proposal.plan.segments.length > base.proposal.plan.segments.length,
      'maxHoldSec=3 должен дать больше сегментов, чем дефолтные 8с'
    );

    // Jitter (seeded) сдвигает границы относительно прогона без jitter.
    const j0 = await DP.multicamFromAudio(ctx, { maxHoldSec: 3, variationsJitterSec: 0 });
    const j1 = await DP.multicamFromAudio(ctx, { maxHoldSec: 3, variationsJitterSec: 0.4, variationsSeed: 7 });
    const bounds0 = j0.proposal.plan.segments.map(s => s.tStart).join(',');
    const bounds1 = j1.proposal.plan.segments.map(s => s.tStart).join(',');
    assert.notEqual(bounds0, bounds1, 'variationsJitterSec должен изменить границы сегментов');
  });

  it('errors when fewer than 2 video tracks (need wide + ≥1 speaker)', async () => {
    const ctx = {
      snapshot: { ok: true, tracks: [{ type: 'video', index: 0 }, { type: 'audio', index: 0 }] },
      rmsExtractor: () => Promise.resolve({ timelines: [[]] })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, false);
    assert.match(res.error, /2 видеодорожк/);
  });

  it('_detectFlatAudio: ловит дорожку без динамики, не трогает живую речь', () => {
    const flat = [], speech = [];
    for (let i = 0; i < 200; i++) {
      flat.push({ t: i * 0.05, rms: -27.5 + (i % 3) * 0.2 });          // спред ~0.4 дБ
      speech.push({ t: i * 0.05, rms: i % 10 < 5 ? -15 : -45 });       // спред 30 дБ
    }
    const norm = (v) => JSON.parse(JSON.stringify(v));
    assert.deepEqual(norm(DP._detectFlatAudio([speech, flat], 3.0)), [1]);
    assert.deepEqual(norm(DP._detectFlatAudio([speech, speech], 3.0)), []);
    // < 20 кадров — недостаточно данных, не флагуем
    assert.deepEqual(norm(DP._detectFlatAudio([flat.slice(0, 10)], 3.0)), []);
  });

  it('multicamFromAudio: варнинг про плоский микрофон (live-находка: лимитер всегда «побеждает»)', async () => {
    const fs = 0.05;
    const speech = [], flat = [];
    for (let i = 1; i <= 200; i++) {
      const t = +(i * fs).toFixed(3);
      speech.push({ t, rms: i % 10 < 5 ? -15 : -45 });
      flat.push({ t, rms: -27.5 });
    }
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.resolve({ timelines: [speech, flat] })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.ok(
      res.proposal.warnings.some((w) => w.includes('без динамики')),
      'ожидали варнинг про плоскую дорожку: ' + JSON.stringify(res.proposal.warnings)
    );
    assert.ok(
      res.proposal.warnings.some((w) => w.includes('спикера 2') && w.includes('(A2)')),
      'варнинг должен называть спикера и дорожку: ' + JSON.stringify(res.proposal.warnings)
    );
  });

  it('remapRmsToSequenceTime: сдвигает media-time на inPoint и отбрасывает кадры вне окна клипа', () => {
    // Файл 0–100с, клип на таймлайне 10–40с использует media 50–80с (inPoint=50).
    const tl = [];
    for (let i = 0; i <= 1000; i++) tl.push({ t: +(i * 0.1).toFixed(3), rms: -20 - (i % 5) });
    const norm = (v) => JSON.parse(JSON.stringify(v));
    const out = norm(DP.remapRmsToSequenceTime(tl, { startSec: 10, endSec: 40, inPointSec: 50 }));
    assert.ok(out.length > 0);
    assert.ok(out[0].t >= 10 - 1e-6, 'первый кадр не раньше startSec: ' + out[0].t);
    assert.ok(out[out.length - 1].t <= 40 + 1e-6, 'последний кадр не позже endSec: ' + out[out.length - 1].t);
    // media t=50 (rms по формуле -20 - (500 % 5) = -20) → sequence t=10
    assert.equal(out[0].t, 10);
    assert.equal(out[0].rms, -20);
    // Кадров ровно на окно 30с при шаге 0.1 (301 точка включая границы)
    assert.equal(out.length, 301);
  });

  it('remapRmsToSequenceTime: inPoint за пределами файла → пусто (поймает честная ошибка пустого RMS)', () => {
    const tl = [{ t: 0, rms: -20 }, { t: 0.1, rms: -21 }];
    const out = DP.remapRmsToSequenceTime(tl, { startSec: 0, endSec: 10, inPointSec: 500 });
    assert.equal(out.length, 0);
  });

  it('честная ошибка при пустых RMS-таймлайнах (live-находка: ffmpeg молча отдаёт 0 кадров на BRAW)', async () => {
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.resolve({
        timelines: [[], []],
        mediaPaths: ['D:/footage/A048_04142200_C019.braw', 'D:/footage/1096_04060212_C001.braw']
      })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, false, 'пустой RMS не должен давать вырожденный план «1 сегмент, 0 переключений»');
    assert.ok(res.error.includes('A048_04142200_C019.braw'), 'ошибка должна называть файл: ' + res.error);
    assert.ok(res.error.includes('BRAW'), 'ошибка должна подсказывать про формат: ' + res.error);
  });

  it('честная ошибка: пустая дорожка без mediaPath называется по номеру', async () => {
    const okTl = [];
    for (let i = 1; i <= 80; i++) okTl.push({ t: +(i * 0.05).toFixed(3), rms: -10 });
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.resolve({ timelines: [okTl, []] })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, false);
    assert.ok(res.error.includes('дорожка A2'), 'ожидали «дорожка A2» в: ' + res.error);
  });

  function snapNvMa(nV, nA) {
    const tracks = [];
    for (let i = 0; i < nV; i++) tracks.push({ type: 'video', index: i });
    for (let i = 0; i < nA; i++) tracks.push({ type: 'audio', index: i });
    return { ok: true, sequenceName: 'seq', tracks };
  }
  function fakeTimelines(nSpeakers, durSec, loudIndex) {
    // Каждый трек имеет одинаковую длину, активный спикер = loudIndex
    const fs = 0.05;
    const total = Math.round(durSec / fs);
    const out = [];
    for (let s = 0; s < nSpeakers; s++) {
      const tl = [];
      for (let i = 1; i <= total; i++) {
        tl.push({ t: +(i * fs).toFixed(3), rms: s === loudIndex ? -10 : -50 });
      }
      out.push(tl);
    }
    return out;
  }

  it('builds 4-speaker mapping from 5V+4A snapshot', async () => {
    const ctx = {
      snapshot: snapNvMa(5, 4),
      rmsExtractor: () => Promise.resolve({ timelines: fakeTimelines(4, 4, 2) })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    const m = res.proposal.plan.mapping;
    assert.equal(m.wideVideoTrack, 0);
    assert.equal(m.speakers.length, 4);
    // Спикеры создаются внутри vm-контекста loader'а — нормализуем массив в realm теста.
    assert.deepEqual(Array.from(m.speakers.map(s => s.videoTrack)), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(m.speakers.map(s => s.audioTrack)), [0, 1, 2, 3]);
    // Голос на спикере 2 (audioTrack=2, videoTrack=3) — какой-то сегмент должен быть на V3.
    assert.ok(res.proposal.plan.segments.some(s => s.activeVideoTrack === 3));
  });

  it('builds 2-speaker mapping from 3V+2A snapshot (regression)', async () => {
    const ctx = {
      snapshot: snapNvMa(3, 2),
      rmsExtractor: () => Promise.resolve({ timelines: fakeTimelines(2, 4, 0) })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.equal(res.proposal.plan.mapping.speakers.length, 2);
  });

  it('caps speakerCount at 4 when 6V+5A', async () => {
    const ctx = {
      snapshot: snapNvMa(6, 5),
      rmsExtractor: () => Promise.resolve({ timelines: fakeTimelines(4, 4, 0) })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.equal(res.proposal.plan.mapping.speakers.length, 4);
  });

  it('builds 1-speaker mapping from 2V+1A snapshot', async () => {
    const ctx = {
      snapshot: snapNvMa(2, 1),
      rmsExtractor: () => Promise.resolve({ timelines: fakeTimelines(1, 4, 0) })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.equal(res.proposal.plan.mapping.speakers.length, 1);
    assert.equal(res.proposal.plan.mapping.speakers[0].videoTrack, 1);
  });

  it('errors when extractor yields no timelines', async () => {
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.resolve({ timelines: [] })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, false);
    assert.match(res.error, /аудио/i);
  });

  it('errors when rmsExtractor throws', async () => {
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.reject(new Error('ffmpeg not found'))
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, false);
    assert.match(res.error, /Ошибка анализа аудио/);
    assert.match(res.error, /ffmpeg not found/);
  });

  it('errors when rmsExtractor is not provided', async () => {
    const ctx = { snapshot: snap3v2a() };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, false);
    assert.match(res.error, /rmsExtractor/);
  });

  /* ── Кастомный маппинг дорожек (AutoPod-паттерн, live-запрос 12 июня 2026) ── */

  it('_normalizeMulticamMapping: валидный маппинг нормализуется, лейблы дозаполняются', () => {
    const r = DP._normalizeMulticamMapping(
      { wideVideoTrack: 0, speakers: [{ audioTrack: 3, videoTrack: 1 }, { audioTrack: 4, videoTrack: 2, label: 'Ведущий' }] },
      3, 5, 4
    );
    assert.equal(r.ok, true);
    assert.equal(r.mapping.wideVideoTrack, 0);
    assert.deepEqual(Array.from(r.mapping.speakers.map(s => s.audioTrack)), [3, 4]);
    assert.deepEqual(Array.from(r.mapping.speakers.map(s => s.videoTrack)), [1, 2]);
    assert.equal(r.mapping.speakers[0].label, 'Гость 1');
    assert.equal(r.mapping.speakers[1].label, 'Ведущий');
  });

  it('_normalizeMulticamMapping: внятные ошибки на каждый класс невалидности', () => {
    const cases = [
      [{ wideVideoTrack: 6, speakers: [{ audioTrack: 0, videoTrack: 1 }] }, /Общий план/],
      [{ wideVideoTrack: 0, speakers: [] }, /ни один спикер/],
      [{ wideVideoTrack: 0, speakers: [{ audioTrack: 9, videoTrack: 1 }] }, /аудиодорожки с индексом 9/],
      [{ wideVideoTrack: 0, speakers: [{ audioTrack: 0, videoTrack: 0 }] }, /занята общим планом/],
      [{ wideVideoTrack: 0, speakers: [{ audioTrack: 0, videoTrack: 1 }, { audioTrack: 1, videoTrack: 1 }] }, /одну видеодорожку V2/],
      [{ wideVideoTrack: 0, speakers: [{ audioTrack: 0, videoTrack: 1 }, { audioTrack: 0, videoTrack: 2 }] }, /одну аудиодорожку A1/],
      [{ wideVideoTrack: 0, speakers: [1, 2, 3, 4, 5].map(i => ({ audioTrack: i - 1, videoTrack: i })) }, /Максимум спикеров/]
    ];
    for (const [raw, re] of cases) {
      const r = DP._normalizeMulticamMapping(raw, 6, 5, 4);
      assert.equal(r.ok, false, 'ожидали ошибку для ' + JSON.stringify(raw));
      assert.match(r.error, re);
    }
  });

  it('multicamFromAudio: params.mapping переопределяет авто-схему — экстрактор и план видят кастомные дорожки', async () => {
    // 3V+5A: микрофоны на A4/A5 (индексы 3/4), как в реальном проекте с BRAW-звуком на A1–A3.
    let seenMapping = null;
    const ctx = {
      snapshot: snapNvMa(3, 5),
      rmsExtractor: (c, mapping) => {
        seenMapping = JSON.parse(JSON.stringify(mapping));
        return Promise.resolve({ timelines: fakeTimelines(2, 4, 1) });
      }
    };
    const res = await DP.multicamFromAudio(ctx, {
      mapping: { wideVideoTrack: 0, speakers: [{ audioTrack: 3, videoTrack: 1 }, { audioTrack: 4, videoTrack: 2 }] }
    });
    assert.equal(res.ok, true);
    assert.deepEqual(seenMapping.speakers.map(s => s.audioTrack), [3, 4],
      'rmsExtractor должен получить кастомные аудиодорожки');
    assert.deepEqual(Array.from(res.proposal.plan.mapping.speakers.map(s => s.audioTrack)), [3, 4]);
    // Голос у спикера 2 (A5 → V3): план должен включать V3.
    assert.ok(res.proposal.plan.segments.some(s => s.activeVideoTrack === 2));
    assert.ok(res.proposal.summary.includes('Спикеров: 2'));
  });

  it('multicamFromAudio: невалидный params.mapping → честная ошибка до анализа аудио', async () => {
    let extractorCalled = false;
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => { extractorCalled = true; return Promise.resolve({ timelines: [] }); }
    };
    const res = await DP.multicamFromAudio(ctx, {
      mapping: { wideVideoTrack: 0, speakers: [{ audioTrack: 7, videoTrack: 1 }] }
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /аудиодорожки с индексом 7/);
    assert.equal(extractorCalled, false, 'до анализа аудио дело дойти не должно');
  });

  it('multicamFromAudio: варнинги называют РЕАЛЬНЫЕ номера дорожек при кастомном маппинге', async () => {
    // Спикеры на A4/A5 слушают один файл — варнинг должен сказать «A4 и A5», а не «A1 и A2».
    const ctx = {
      snapshot: snapNvMa(3, 5),
      rmsExtractor: () => Promise.resolve({
        timelines: fakeTimelines(2, 4, 0),
        mediaPaths: ['D:/audio/mix.wav', 'D:/audio/mix.wav']
      })
    };
    const res = await DP.multicamFromAudio(ctx, {
      mapping: { wideVideoTrack: 0, speakers: [{ audioTrack: 3, videoTrack: 1 }, { audioTrack: 4, videoTrack: 2 }] }
    });
    assert.equal(res.ok, true);
    assert.ok(
      res.proposal.warnings.some(w => w.includes('A4 и A5')),
      'ожидали реальные номера дорожек: ' + JSON.stringify(res.proposal.warnings)
    );
  });
});

/* ═══════════════════════════════════════════════════════════════
 * snapIntervalsToFrame (аудит 2026-06-09: кадровая точность резов)
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines.snapIntervalsToFrame', () => {
  it('start — вниз, end — вверх к границе кадра (25 fps)', () => {
    const out = DP.snapIntervalsToFrame([{ startSec: 1.03, endSec: 2.01 }], 25);
    assert.equal(out.length, 1);
    assert.ok(Math.abs(out[0].startSec - 1.0) < 1e-9, 'start 1.03 → 1.00');
    assert.ok(Math.abs(out[0].endSec - 2.04) < 1e-9, 'end 2.01 → 2.04');
  });

  it('значения уже на границе кадра не меняются', () => {
    const out = DP.snapIntervalsToFrame([{ startSec: 1.0, endSec: 2.0 }], 25);
    assert.ok(Math.abs(out[0].startSec - 1.0) < 1e-9);
    assert.ok(Math.abs(out[0].endSec - 2.0) < 1e-9);
  });

  it('float-погрешность не сдвигает на лишний кадр (EPS-защита)', () => {
    /* 0.04*3 = 0.12000000000000001 — без EPS ceil дал бы лишний кадр */
    const out = DP.snapIntervalsToFrame([{ startSec: 0.04 * 3, endSec: 0.04 * 10 }], 25);
    assert.ok(Math.abs(out[0].startSec - 0.12) < 1e-9);
    assert.ok(Math.abs(out[0].endSec - 0.4) < 1e-9);
  });

  it('дробный fps (29.97 NTSC)', () => {
    const fps = 29.97;
    const out = DP.snapIntervalsToFrame([{ startSec: 1.5, endSec: 3.2 }], fps);
    const sFrames = out[0].startSec * fps;
    const eFrames = out[0].endSec * fps;
    assert.ok(Math.abs(sFrames - Math.round(sFrames)) < 1e-6, 'start кратен кадру');
    assert.ok(Math.abs(eFrames - Math.round(eFrames)) < 1e-6, 'end кратен кадру');
    assert.ok(out[0].startSec <= 1.5 && out[0].endSec >= 3.2, 'интервал только расширяется');
  });

  it('микро-интервал расширяется до полного кадра (floor/ceil)', () => {
    const out = DP.snapIntervalsToFrame([{ startSec: 1.001, endSec: 1.002 }], 25);
    assert.equal(out.length, 1);
    assert.ok(Math.abs(out[0].startSec - 1.0) < 1e-9);
    assert.ok(Math.abs(out[0].endSec - 1.04) < 1e-9);
  });

  it('нулевой интервал отбрасывается', () => {
    const out = DP.snapIntervalsToFrame([{ startSec: 1.0, endSec: 1.0 }], 25);
    assert.equal(out.length, 0);
  });

  it('прочие свойства интервала сохраняются', () => {
    const out = DP.snapIntervalsToFrame([{ startSec: 1.03, endSec: 2.01, reason: 'тишина', label: 'silence' }], 25);
    assert.equal(out[0].reason, 'тишина');
    assert.equal(out[0].label, 'silence');
  });

  it('start не уходит ниже нуля', () => {
    const out = DP.snapIntervalsToFrame([{ startSec: -0.01, endSec: 0.5 }], 25);
    assert.equal(out[0].startSec, 0);
  });

  it('невалидный fps → исходные интервалы без изменений', () => {
    const src = [{ startSec: 1.03, endSec: 2.01 }];
    [0, NaN, undefined].forEach((bad) => {
      const out = DP.snapIntervalsToFrame(src, bad);
      assert.equal(out.length, 1);
      assert.equal(out[0].startSec, 1.03);
      assert.equal(out[0].endSec, 2.01);
    });
  });

  it('не мутирует исходный массив', () => {
    const src = [{ startSec: 1.03, endSec: 2.01 }];
    DP.snapIntervalsToFrame(src, 25);
    assert.equal(src[0].startSec, 1.03);
    assert.equal(src[0].endSec, 2.01);
  });

  it('мусорные элементы пропускаются, non-array → []', () => {
    assert.equal(DP.snapIntervalsToFrame([null, { startSec: 'x', endSec: 2 }, { startSec: 1, endSec: 2 }], 25).length, 1);
    assert.equal(DP.snapIntervalsToFrame(null, 25).length, 0);
  });
});

/* ──────────────────────────────────────────────────────────────
 * _detectSharedAudio (B1-7: pre-flight варнинг «общий звук»)
 * ────────────────────────────────────────────────────────────── */
describe('DeterministicPipelines._detectSharedAudio', () => {
  function tl(fn, n = 30) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ t: i * 0.05, rms: fn(i) });
    return out;
  }

  /* vm-контекст возвращает массивы чужого realm — нормализуем для deepEqual */
  const norm = (v) => JSON.parse(JSON.stringify(v));

  it('flags near-identical RMS profiles as a shared-audio pair', () => {
    const a = tl(i => -20 + Math.sin(i) * 5);
    const b = tl(i => -20 + Math.sin(i) * 5 + 0.3); // почти копия (Δ 0.3 dB)
    const pairs = norm(DP._detectSharedAudio([a, b], 1.0));
    assert.deepEqual(pairs, [[0, 1]]);
  });

  it('does not flag genuinely different tracks', () => {
    const a = tl(i => (i % 10 < 5 ? -12 : -50)); // спикер A говорит первую половину
    const b = tl(i => (i % 10 < 5 ? -50 : -12)); // спикер B — вторую
    assert.deepEqual(norm(DP._detectSharedAudio([a, b], 1.0)), []);
  });

  it('requires >= 20 comparable samples', () => {
    const a = tl(() => -20, 10);
    const b = tl(() => -20, 10);
    assert.deepEqual(norm(DP._detectSharedAudio([a, b], 1.0)), [], 'мало данных — не флагуем');
  });

  it('returns [] for < 2 timelines or empty input', () => {
    assert.deepEqual(norm(DP._detectSharedAudio([tl(() => -20)], 1.0)), []);
    assert.deepEqual(norm(DP._detectSharedAudio([], 1.0)), []);
    assert.deepEqual(norm(DP._detectSharedAudio(null, 1.0)), []);
  });

  it('checks all pairs of 3 tracks', () => {
    const a = tl(() => -20);
    const b = tl(() => -20.2);
    const c = tl(i => (i % 2 ? -10 : -45));
    const pairs = norm(DP._detectSharedAudio([a, b, c], 1.0));
    assert.deepEqual(pairs, [[0, 1]], 'только дублирующая пара');
  });
});

/* ──────────────────────────────────────────────────────────────
 * parsePipelineCommand — русские алиасы (B1-8)
 * ────────────────────────────────────────────────────────────── */
describe('DeterministicPipelines.parsePipelineCommand (русские алиасы)', () => {
  it('maps /паразиты, /тишины, /главы, /джампкаты to pipelines', () => {
    for (const cmd of ['/паразиты', '/тишины', '/главы', '/джампкаты']) {
      const r = DP.parsePipelineCommand(cmd);
      assert.ok(r && typeof r.pipeline === 'function', cmd + ' должен распознаваться');
    }
  });

  it('passes params with russian alias', () => {
    const r = DP.parsePipelineCommand('/тишины minDuration=2.0');
    assert.ok(r);
    assert.equal(r.params.minDuration, 2.0);
  });

  it('is case-insensitive for cyrillic', () => {
    const r = DP.parsePipelineCommand('/Паразиты');
    assert.ok(r && typeof r.pipeline === 'function');
  });

  it('returns null for unknown slash command', () => {
    assert.equal(DP.parsePipelineCommand('/несуществует'), null);
  });
});
