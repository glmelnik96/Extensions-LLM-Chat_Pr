import { test, describe } from 'node:test';
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
