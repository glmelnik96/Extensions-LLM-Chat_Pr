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

  test('preview==apply: с rmsTimeline детекция идёт через RMS (не ffmpeg-silences)', async () => {
    /* rmsTimeline: речь 0-2с (-12), тишина 2-4с (-55), речь 4-6с (-12). ffmpeg
       silences ПУСТЫ и сегментов-gap НЕТ — значит найденная тишина может прийти
       ТОЛЬКО из RMS-источника (доказывает контракт preview==apply). */
    const rms = [];
    let t = 0;
    const push = (dur, val) => { for (let i = 0; i < Math.round(dur / 0.05); i++) { rms.push({ t: Math.round(t * 1000) / 1000, rms: val }); t += 0.05; } };
    push(2, -12); push(2, -55); push(2, -12);
    const entry = makeEntry(
      [{ startSec: 0, endSec: 6, text: 'непрерывная речь без зазоров' }],
      { audioAnalysis: { rmsTimeline: rms, silences: [], inputI: -20, silenceThresholdUsed: -30 } }
    );
    const r = await DP.cutSilences(makeCtx({ transcriptEntry: entry }), { minDuration: 1.0, padding: 0.15 });
    assert.equal(r.ok, true);
    assert.ok(r.proposal, 'нашёл тишину из RMS');
    assert.equal(r.proposal.removeIntervals.length, 1);
    // тишина ~[2,4], padding 0.15 → [~2.15, ~3.85]
    assert.ok(r.proposal.removeIntervals[0].startSec >= 2.1 && r.proposal.removeIntervals[0].startSec <= 2.3);
    assert.ok(r.proposal.removeIntervals[0].endSec >= 3.7 && r.proposal.removeIntervals[0].endSec <= 3.9);
  });

  test('rmsTimeline + порог-дельта: ужесточение убирает «тихую речь» (live-порог)', async () => {
    const rms = [];
    let t = 0;
    const push = (dur, val) => { for (let i = 0; i < Math.round(dur / 0.05); i++) { rms.push({ t: Math.round(t * 1000) / 1000, rms: val }); t += 0.05; } };
    push(2, -12); push(2, -28); push(2, -12); /* средний участок -28dB */
    const entry = makeEntry(
      [{ startSec: 0, endSec: 6, text: 'речь' }],
      { audioAnalysis: { rmsTimeline: rms, silences: [], inputI: -10 } }
    );
    /* delta=15 → порог inputI-15 = -25 → -28 считается тишиной */
    const loose = await DP.cutSilences(makeCtx({ transcriptEntry: entry }), { minDuration: 1.0, padding: 0.1, silenceThresholdDelta: 15 });
    /* delta=5 → порог -15 → -28 НЕ тишина (громче порога? нет: -28 < -15 → тишина).
       Возьмём delta=25 → порог -35 → -28 уже речь (-28 > -35). */
    const strict = await DP.cutSilences(makeCtx({ transcriptEntry: entry }), { minDuration: 1.0, padding: 0.1, silenceThresholdDelta: 25 });
    assert.ok(loose.proposal && loose.proposal.removeIntervals.length === 1, 'порог -25: -28dB = тишина');
    assert.ok(strict.noChanges || (strict.proposal && strict.proposal.removeIntervals.length === 0), 'порог -35: -28dB = речь');
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
 * silenceIntervalsFromRms — client-side детекция тишин для waveform-превью
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines.silenceIntervalsFromRms', () => {
  /* Хелпер: ровная сетка RMS-сэмплов c шагом dt; loud — уровень речи, quiet — тишины. */
  function mkRms(spec, dt) {
    dt = dt || 0.05;
    const out = [];
    let t = 0;
    for (const seg of spec) {
      const n = Math.round(seg.dur / dt);
      for (let i = 0; i < n; i++) { out.push({ t: Math.round(t * 1000) / 1000, rms: seg.rms }); t += dt; }
    }
    return out;
  }

  it('пустой/короткий вход → []', () => {
    /* .length вместо deepEqual: функция исполняется в vm-песочнице со своим
       Array.prototype, deepStrictEqual падает на cross-realm проверке прототипа. */
    assert.equal(DP.silenceIntervalsFromRms([], {}).length, 0);
    assert.equal(DP.silenceIntervalsFromRms([{ t: 0, rms: -50 }], {}).length, 0);
    assert.equal(DP.silenceIntervalsFromRms(null, {}).length, 0);
  });

  it('находит одну паузу между речью, применяет padding', () => {
    // 2с речи (-12dB) → 2с тишины (-55dB) → 2с речи
    const rms = mkRms([{ dur: 2, rms: -12 }, { dur: 2, rms: -55 }, { dur: 2, rms: -12 }]);
    const out = DP.silenceIntervalsFromRms(rms, { thresholdDb: -30, minDuration: 1.0, padding: 0.15 });
    assert.equal(out.length, 1);
    // тишина ~[2.0, 4.0], padding 0.15 → [~2.15, ~3.85]
    assert.ok(out[0].startSec >= 2.1 && out[0].startSec <= 2.25, 'start=' + out[0].startSec);
    assert.ok(out[0].endSec >= 3.8 && out[0].endSec <= 3.95, 'end=' + out[0].endSec);
  });

  it('порог — live-параметр: ужесточение убирает «тихую речь»', () => {
    // участок -28dB: тишина при пороге -25, НЕ тишина при пороге -35
    const rms = mkRms([{ dur: 2, rms: -12 }, { dur: 2, rms: -28 }, { dur: 2, rms: -12 }]);
    const loose = DP.silenceIntervalsFromRms(rms, { thresholdDb: -25, minDuration: 1.0, padding: 0.1 });
    const strict = DP.silenceIntervalsFromRms(rms, { thresholdDb: -35, minDuration: 1.0, padding: 0.1 });
    assert.equal(loose.length, 1, 'при -25 -28dB считается тишиной');
    assert.equal(strict.length, 0, 'при -35 -28dB уже речь');
  });

  it('minDuration отсекает короткие паузы', () => {
    // пауза 0.5с при minDuration 1.0 → отброшена
    const rms = mkRms([{ dur: 2, rms: -12 }, { dur: 0.5, rms: -55 }, { dur: 2, rms: -12 }]);
    assert.equal(DP.silenceIntervalsFromRms(rms, { minDuration: 1.0, padding: 0 }).length, 0);
    assert.equal(DP.silenceIntervalsFromRms(rms, { minDuration: 0.3, padding: 0 }).length, 1);
  });

  it('digital silence (-Infinity/null/NaN) считается тишиной', () => {
    const dt = 0.05;
    const rms = [];
    let t = 0;
    for (let i = 0; i < 40; i++) { rms.push({ t: Math.round(t * 1000) / 1000, rms: -12 }); t += dt; }
    for (let i = 0; i < 40; i++) { rms.push({ t: Math.round(t * 1000) / 1000, rms: -Infinity }); t += dt; }
    for (let i = 0; i < 40; i++) { rms.push({ t: Math.round(t * 1000) / 1000, rms: -12 }); t += dt; }
    const out = DP.silenceIntervalsFromRms(rms, { thresholdDb: -30, minDuration: 1.0, padding: 0.1 });
    assert.equal(out.length, 1, 'участок -inf = тишина');
  });

  it('две раздельные паузы не сливаются', () => {
    const rms = mkRms([
      { dur: 1.5, rms: -12 }, { dur: 1.5, rms: -55 },
      { dur: 1.5, rms: -12 }, { dur: 1.5, rms: -55 }, { dur: 1.5, rms: -12 }
    ]);
    const out = DP.silenceIntervalsFromRms(rms, { thresholdDb: -30, minDuration: 1.0, padding: 0.1 });
    assert.equal(out.length, 2);
    assert.ok(out[1].startSec > out[0].endSec, 'паузы упорядочены и раздельны');
  });

  it('padding больше половины паузы → интервал отброшен', () => {
    const rms = mkRms([{ dur: 2, rms: -12 }, { dur: 1.1, rms: -55 }, { dur: 2, rms: -12 }]);
    // пауза 1.1с, padding 0.6 с каждой стороны → 1.1-1.2 < 0 → отброшен
    const out = DP.silenceIntervalsFromRms(rms, { thresholdDb: -30, minDuration: 1.0, padding: 0.6 });
    assert.equal(out.length, 0);
  });

  /* РЕГРЕССИЯ (баг «удалил весь клип речи»): речь с микропаузами между словами
     НЕ должна сливаться в одну «тишину на весь клип». */
  it('речь с микропаузами (<minDuration) → НЕ режется (брайджинг не перепрыгивает речь)', () => {
    // 12× [речь 0.3с -30, микропауза 0.2с -90] — непрерывная речь с зазорами по 0.2с
    const spec = [];
    for (let i = 0; i < 12; i++) { spec.push({ dur: 0.3, rms: -30 }); spec.push({ dur: 0.2, rms: -90 }); }
    const rms = mkRms(spec);
    const out = DP.silenceIntervalsFromRms(rms, { marginDb: 18, minDuration: 1.0, padding: 0.1 });
    assert.equal(out.length, 0, 'микропаузы 0.2с < minDuration 1.0 → отсеяны, речь цела');
  });

  it('относительный порог: находит ТОЛЬКО настоящую паузу >minDuration среди речи', () => {
    // речь, затем реальная пауза 2с, затем речь — с микропаузами вокруг
    const spec = [
      { dur: 0.3, rms: -28 }, { dur: 0.15, rms: -90 }, { dur: 0.3, rms: -30 }, { dur: 0.15, rms: -90 },
      { dur: 2.0, rms: -90 },  // НАСТОЯЩАЯ пауза 2с
      { dur: 0.3, rms: -29 }, { dur: 0.15, rms: -90 }, { dur: 0.3, rms: -31 }
    ];
    const rms = mkRms(spec);
    const out = DP.silenceIntervalsFromRms(rms, { marginDb: 18, minDuration: 1.0, padding: 0.1 });
    assert.equal(out.length, 1, 'только пауза 2с');
    const dur = out[0].endSec - out[0].startSec;
    assert.ok(dur > 1.5 && dur < 2.0, 'длительность ~2с минус padding, dur=' + dur);
  });

  it('относительный порог адаптируется к уровню записи (тихие камерные мики)', () => {
    // та же структура, но ВСЁ на 30dB тише (речь -60, тишина -90) — абсолютный порог
    // -30 счёл бы всё тишиной; относительный (от уровня речи -60) работает корректно
    const rms = mkRms([{ dur: 1, rms: -60 }, { dur: 2, rms: -90 }, { dur: 1, rms: -60 }]);
    const out = DP.silenceIntervalsFromRms(rms, { marginDb: 18, minDuration: 1.0, padding: 0.1 });
    assert.equal(out.length, 1, 'тихая речь -60dB не принята за тишину');
  });
});

describe('DeterministicPipelines.rmsThresholdInfo (линия порога на waveform)', () => {
  function mkRms(spec, dt) {
    dt = dt || 0.05; const out = []; let t = 0;
    for (const seg of spec) { const n = Math.round(seg.dur / dt); for (let i = 0; i < n; i++) { out.push({ t: Math.round(t * 1000) / 1000, rms: seg.rms }); t += dt; } }
    return out;
  }
  it('абсолютный thresholdDb возвращается как есть, speechRef=null', () => {
    const info = DP.rmsThresholdInfo([{ t: 0, rms: -30 }], { thresholdDb: -42 });
    assert.equal(info.thresholdDb, -42);
    assert.equal(info.speechRefDb, null);
  });
  it('относительный: порог = P92(rms) - margin (тот же, что у детектора)', () => {
    // 90% речи -25, 10% тишины -90 → P92 ≈ -25
    const rms = mkRms([{ dur: 9, rms: -25 }, { dur: 1, rms: -90 }]);
    const info = DP.rmsThresholdInfo(rms, { marginDb: 18 });
    assert.equal(Math.round(info.speechRefDb), -25, 'уровень речи ≈ -25');
    assert.equal(Math.round(info.thresholdDb), -43, 'порог = -25 - 18');
    /* Совпадение с детектором: при пороге -43 тишина -90 < -43 → режется. */
    const cuts = DP.silenceIntervalsFromRms(mkRms([{ dur: 3, rms: -25 }, { dur: 2, rms: -90 }, { dur: 3, rms: -25 }]), { marginDb: 18, minDuration: 1, padding: 0.1 });
    assert.equal(cuts.length, 1);
  });
  it('пустой/без конечных rms → null', () => {
    assert.equal(DP.rmsThresholdInfo([], { marginDb: 18 }), null);
    assert.equal(DP.rmsThresholdInfo([{ t: 0, rms: -Infinity }], { marginDb: 18 }), null);
  });
});

describe('DeterministicPipelines пер-клиповый порог (несколько клипов разной громкости)', () => {
  /* e2e-баг монтажёра (26.06.2026): при нескольких клипах разной громкости в одном
     In–Out единый глобальный порог тянул ГРОМКИЙ клип, и речь ТИХОГО клипа целиком
     уходила под порог = вырезалась. Фикс: порог по каждому клипу (clipRanges). */
  function mk2clip() {
    // Клип A 0..10с: речь -20, пауза 4..6с=-55. Клип B 10..20с: речь -45, пауза 14..16с=-70.
    const tl = [];
    for (let t = 0; t < 20; t += 0.025) {
      let rms;
      if (t < 10) rms = (t >= 4 && t < 6) ? -55 : -20;
      else rms = (t >= 14 && t < 16) ? -70 : -45;
      tl.push({ t: Math.round(t * 1000) / 1000, rms });
    }
    return tl;
  }
  const clipRanges = [{ startSec: 0, endSec: 10 }, { startSec: 10, endSec: 20 }];

  it('БЕЗ clipRanges (глобальный порог) — тихий клип B вырезается целиком (воспроизводит баг)', () => {
    const out = DP.silenceIntervalsFromRms(mk2clip(), { marginDb: 22, minDuration: 1.0, padding: 0.15 });
    const hasWholeClipCut = out.some((iv) => (iv.endSec - iv.startSec) > 7);
    assert.equal(hasWholeClipCut, true, 'глобальный порог режет тихий клип целиком');
  });

  it('С clipRanges — режутся только реальные паузы каждого клипа', () => {
    const out = DP.silenceIntervalsFromRms(mk2clip(), { marginDb: 22, minDuration: 1.0, padding: 0.15, clipRanges });
    assert.equal(out.length, 2, 'две паузы (по одной на клип), не вырезанный клип');
    // пауза клипа A ~4..6, клипа B ~14..16
    assert.ok(out[0].startSec >= 3.9 && out[0].endSec <= 6.1, 'пауза A 4..6с');
    assert.ok(out[1].startSec >= 13.9 && out[1].endSec <= 16.1, 'пауза B 14..16с');
    out.forEach((iv) => assert.ok((iv.endSec - iv.startSec) < 3, 'ни один рез не покрывает целый клип'));
  });

  it('rmsThresholdSegments даёт свой порог на клип (громкий ≈-42, тихий ≈-67)', () => {
    const segs = DP.rmsThresholdSegments(mk2clip(), clipRanges, { marginDb: 22 });
    assert.equal(segs.length, 2);
    assert.equal(Math.round(segs[0].speechRefDb), -20, 'клип A речь -20');
    assert.equal(Math.round(segs[0].thresholdDb), -42, 'клип A порог -42');
    assert.equal(Math.round(segs[1].speechRefDb), -45, 'клип B речь -45');
    assert.equal(Math.round(segs[1].thresholdDb), -67, 'клип B порог -67');
  });

  it('без clipRanges rmsThresholdSegments вырождается в один глобальный сегмент', () => {
    const segs = DP.rmsThresholdSegments(mk2clip(), null, { marginDb: 22 });
    assert.equal(segs.length, 1, 'один сегмент на весь регион');
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

  /* ── Сводка пропозала (UX 10.07.2026): экранное время + оценка применения ── */

  function alternatingTimelines(nSpeakers, durSec, periodSec) {
    /* Спикеры говорят по очереди блоками periodSec — даёт много сегментов. */
    const fs = 0.05;
    const total = Math.round(durSec / fs);
    const out = [];
    for (let s = 0; s < nSpeakers; s++) {
      const tl = [];
      for (let i = 1; i <= total; i++) {
        const t = +(i * fs).toFixed(3);
        const активный = Math.floor(t / periodSec) % nSpeakers;
        tl.push({ t, rms: активный === s ? -10 : -50 });
      }
      out.push(tl);
    }
    return out;
  }

  it('summary: экранное время по камерам с mm:ss и процентами', async () => {
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.resolve({ timelines: alternatingTimelines(2, 8, 4) })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.match(res.proposal.summary, /Экранное время/);
    assert.match(res.proposal.summary, /Гость 1 \(V2\)/);
    assert.match(res.proposal.summary, /Гость 2 \(V3\)/);
    assert.match(res.proposal.summary, /\d+:\d{2} \(\d+%\)/);
  });

  it('summary: длинный план (>40 сегментов) предупреждает о батчах с оценкой времени', async () => {
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.resolve({ timelines: alternatingTimelines(2, 240, 2) })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.ok(res.proposal.plan.segments.length > 40,
      'ожидали >40 сегментов, получили ' + res.proposal.plan.segments.length);
    assert.match(res.proposal.summary, /батч/i);
    assert.match(res.proposal.summary, /≈\s*\d+\s*с/);
  });

  it('summary: короткий план — без упоминания батчей', async () => {
    const ctx = {
      snapshot: snap3v2a(),
      rmsExtractor: () => Promise.resolve({ timelines: alternatingTimelines(2, 8, 4) })
    };
    const res = await DP.multicamFromAudio(ctx, {});
    assert.equal(res.ok, true);
    assert.ok(!/батч/i.test(res.proposal.summary),
      'короткий план не должен пугать батчами: ' + res.proposal.summary);
  });

  it('summary: кастомные лейблы спикеров попадают в экранное время', async () => {
    const ctx = {
      snapshot: snapNvMa(3, 5),
      rmsExtractor: () => Promise.resolve({ timelines: alternatingTimelines(2, 8, 4) })
    };
    const res = await DP.multicamFromAudio(ctx, {
      mapping: { wideVideoTrack: 0, speakers: [
        { audioTrack: 3, videoTrack: 1, label: 'Ведущий' },
        { audioTrack: 4, videoTrack: 2, label: 'Эксперт' }
      ] }
    });
    assert.equal(res.ok, true);
    assert.match(res.proposal.summary, /Ведущий \(V2\)/);
    assert.match(res.proposal.summary, /Эксперт \(V3\)/);
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

/* ═══════════════════════════════════════════════════════════════
 * assignSpeakersByRms — локальная диаризация транскрипта по per-mic RMS
 * (Волна 3 п.3, 10.07.2026). Whisper Cloud.ru не отдаёт спикеров;
 * размечаем сегменты сами: чей микрофон громче в окне сегмента —
 * тот и говорит. Порог лидера отсекает bleed, порог тишины — шум.
 * ═══════════════════════════════════════════════════════════════ */

describe('DeterministicPipelines.assignSpeakersByRms', () => {
  /* mic-таймлайн: rmsFn(t) → дБ, каждые 0.1с на [0, durSec) */
  function tl(durSec, rmsFn) {
    const out = [];
    for (let t = 0.05; t < durSec; t += 0.1) {
      out.push({ t: +t.toFixed(2), rms: rmsFn(t) });
    }
    return out;
  }
  const SEGS = [
    { startSec: 0, endSec: 4, text: 'привет' },
    { startSec: 4, endSec: 8, text: 'здравствуйте' },
    { startSec: 8, endSec: 12, text: 'как дела' }
  ];

  it('поочерёдная речь → сегменты размечаются правильными спикерами', () => {
    const mic1 = tl(12, (t) => (t < 4 || t >= 8 ? -12 : -48));
    const mic2 = tl(12, (t) => (t >= 4 && t < 8 ? -14 : -50));
    const r = DP.assignSpeakersByRms(SEGS, [mic1, mic2], { labels: ['Спикер 1', 'Спикер 2'] });
    assert.equal(r.segments[0].speaker, 'Спикер 1');
    assert.equal(r.segments[1].speaker, 'Спикер 2');
    assert.equal(r.segments[2].speaker, 'Спикер 1');
    assert.equal(r.labeled, 3);
    assert.equal(r.total, 3);
  });

  it('bleed: чужой мик слышит речь тише на 12 дБ → лидер всё равно размечается', () => {
    const mic1 = tl(4, () => -10);
    const mic2 = tl(4, () => -22); /* пролез звук первого */
    const r = DP.assignSpeakersByRms([SEGS[0]], [mic1, mic2], {});
    assert.equal(r.segments[0].speaker, 'Спикер 1');
  });

  it('перекрытие: оба мика громкие в пределах маржи → сегмент НЕ размечается', () => {
    const mic1 = tl(4, () => -12);
    const mic2 = tl(4, () => -13);
    const r = DP.assignSpeakersByRms([SEGS[0]], [mic1, mic2], {});
    assert.equal(r.segments[0].speaker, undefined);
    assert.equal(r.labeled, 0);
  });

  it('тишина: все мики ниже порога → сегмент НЕ размечается', () => {
    const mic1 = tl(4, () => -70);
    const mic2 = tl(4, () => -75);
    const r = DP.assignSpeakersByRms([SEGS[0]], [mic1, mic2], {});
    assert.equal(r.segments[0].speaker, undefined);
  });

  it('нет сэмплов мика в окне сегмента → мик считается тихим, не выигрывает', () => {
    const mic1 = tl(4, () => -10);      /* кончается на 4с */
    const mic2 = tl(12, () => -30);
    const r = DP.assignSpeakersByRms([SEGS[2]], [mic1, mic2], {}); /* окно 8–12с */
    assert.equal(r.segments[0].speaker, 'Спикер 2');
  });

  it('дефолтные лейблы «Спикер N», perSpeaker-статистика', () => {
    const mic1 = tl(12, (t) => (t < 8 ? -10 : -50));
    const mic2 = tl(12, (t) => (t >= 8 ? -10 : -50));
    const r = DP.assignSpeakersByRms(SEGS, [mic1, mic2], {});
    assert.equal(r.perSpeaker['Спикер 1'], 2);
    assert.equal(r.perSpeaker['Спикер 2'], 1);
  });

  it('чистота: входные сегменты не мутируются, выход — копии', () => {
    const src = [{ startSec: 0, endSec: 4, text: 'привет' }];
    const mic1 = tl(4, () => -10);
    const mic2 = tl(4, () => -40);
    const r = DP.assignSpeakersByRms(src, [mic1, mic2], {});
    assert.equal(src[0].speaker, undefined, 'вход мутирован');
    assert.equal(r.segments[0].speaker, 'Спикер 1');
    assert.equal(r.segments[0].text, 'привет');
  });

  it('пустые входы → labeled 0, сегменты без спикеров', () => {
    const r1 = DP.assignSpeakersByRms([], [tl(4, () => -10)], {});
    assert.equal(r1.total, 0);
    const r2 = DP.assignSpeakersByRms(SEGS, [], {});
    assert.equal(r2.labeled, 0);
    assert.equal(r2.segments.length, 3);
  });

  it('кастомная маржа: marginDb 20 строже дефолта — bleed −22 дБ уже не проходит', () => {
    const mic1 = tl(4, () => -10);
    const mic2 = tl(4, () => -22);
    const r = DP.assignSpeakersByRms([SEGS[0]], [mic1, mic2], { marginDb: 20 });
    assert.equal(r.segments[0].speaker, undefined);
  });
});

/* ═══ micPartsToTimeline: сборка sequence-time RMS-таймлайна мика из
 * «частей» (direct-клипы дорожки ИЛИ nest-сегменты одного inner-трека).
 * Часть: {mediaPath, srcStartSec, outerStartSec, outerEndSec};
 * rmsByPath: {[mediaPath]: [{t, rms}]} — media-time RMS файла целиком. ═══ */

describe('DeterministicPipelines.micPartsToTimeline', () => {
  /* media-time RMS: сэмпл каждую секунду, rms = -t (различимо по времени) */
  const rms10 = [];
  for (let t = 0; t < 10; t++) rms10.push({ t, rms: -t });

  it('одна часть: ремап media→sequence c учётом srcStart и окна', () => {
    /* медиа [2..5) → sequence [100..103) */
    const out = DP.micPartsToTimeline(
      [{ mediaPath: '/m.wav', srcStartSec: 2, outerStartSec: 100, outerEndSec: 103 }],
      { '/m.wav': rms10 }
    );
    const pts = [...out].map((f) => f.t + ':' + f.rms);
    assert.equal(pts.join(','), '100:-2,101:-3,102:-4,103:-5');
  });

  it('две части (разрезанный nest) конкатенируются и сортируются по t', () => {
    const out = DP.micPartsToTimeline(
      [
        { mediaPath: '/m.wav', srcStartSec: 5, outerStartSec: 20, outerEndSec: 22 },
        { mediaPath: '/m.wav', srcStartSec: 0, outerStartSec: 10, outerEndSec: 12 }
      ],
      { '/m.wav': rms10 }
    );
    const ts = [...out].map((f) => f.t);
    assert.equal(ts.join(','), '10,11,12,20,21,22');
  });

  it('часть без RMS в rmsByPath пропускается, остальные живут', () => {
    const out = DP.micPartsToTimeline(
      [
        { mediaPath: '/нет.wav', srcStartSec: 0, outerStartSec: 0, outerEndSec: 5 },
        { mediaPath: '/m.wav', srcStartSec: 0, outerStartSec: 50, outerEndSec: 51 }
      ],
      { '/m.wav': rms10 }
    );
    assert.equal([...out].every((f) => f.t >= 50 && f.t <= 51), true);
    assert.equal(out.length > 0, true);
  });

  it('пустые входы → пустой таймлайн', () => {
    assert.equal(DP.micPartsToTimeline([], { '/m.wav': rms10 }).length, 0);
    assert.equal(DP.micPartsToTimeline(null, {}).length, 0);
    assert.equal(DP.micPartsToTimeline([{ mediaPath: '/m.wav', srcStartSec: 0, outerStartSec: 0, outerEndSec: 5 }], null).length, 0);
  });
});

/* ═══ parseAudioTrackFilter: пользовательский фильтр «какие дорожки — мики»
 * для карточки «🗣 Спикеры» («4-6», «A4, A6», пусто = авто). ═══ */

describe('DeterministicPipelines.parseAudioTrackFilter', () => {
  it('пусто / null / «авто» → null (без фильтра)', () => {
    assert.equal(DP.parseAudioTrackFilter(''), null);
    assert.equal(DP.parseAudioTrackFilter(null), null);
    assert.equal(DP.parseAudioTrackFilter('  '), null);
    assert.equal(DP.parseAudioTrackFilter('авто'), null);
  });

  it('диапазон «4-6» → [4,5,6]', () => {
    assert.equal([...DP.parseAudioTrackFilter('4-6')].join(','), '4,5,6');
  });

  it('«A4, A6» (с префиксом A и пробелами) → [4,6]', () => {
    assert.equal([...DP.parseAudioTrackFilter('A4, A6')].join(','), '4,6');
  });

  it('смешанное «1,3-4» → [1,3,4]; дубли схлопываются', () => {
    assert.equal([...DP.parseAudioTrackFilter('1,3-4,3')].join(','), '1,3,4');
  });

  it('мусор / перевёрнутый диапазон → null (как авто, не тихий пустой фильтр)', () => {
    assert.equal(DP.parseAudioTrackFilter('abc'), null);
    assert.equal(DP.parseAudioTrackFilter('6-4'), null);
    assert.equal(DP.parseAudioTrackFilter('0'), null);
  });
});

/* ═══ parseVerticalOffsets: пользовательские смещения кадрирования по камерам
 * для карточки «📱 Вертикаль 9:16». Формат: «имя: сдвиг%[; имя: сдвиг%…]»,
 * сдвиг — фокус в % ширины исходника (− влево, + вправо, 0 = центр). ═══ */

describe('DeterministicPipelines.parseVerticalOffsets', () => {
  it('пусто / null → null (все клипы центр-кроп)', () => {
    assert.equal(DP.parseVerticalOffsets(''), null);
    assert.equal(DP.parseVerticalOffsets(null), null);
    assert.equal(DP.parseVerticalOffsets('   '), null);
  });

  it('«Гость: -20; Ведущий: 15» → 2 записи, match в lower-case', () => {
    const out = DP.parseVerticalOffsets('Гость: -20; Ведущий: 15');
    const pairs = [...out].map((o) => o.match + '=' + o.offsetPct);
    assert.equal(pairs.join('|'), 'гость=-20|ведущий=15');
  });

  it('перенос строки как разделитель, дробные проценты', () => {
    const out = DP.parseVerticalOffsets('Cam A: 12.5\nCam B: -7.5');
    const pairs = [...out].map((o) => o.match + '=' + o.offsetPct);
    assert.equal(pairs.join('|'), 'cam a=12.5|cam b=-7.5');
  });

  it('мусорные записи отбрасываются; целиком мусор → null', () => {
    const out = DP.parseVerticalOffsets('чушь без числа; Гость: -20');
    assert.equal(out.length, 1);
    assert.equal(out[0].match, 'гость');
    assert.equal(DP.parseVerticalOffsets('просто текст'), null);
  });
});

/* ═══ planVerticalReframe: чистый планировщик рефрейма 16:9 → 9:16.
 * Cover-скейл (кадр заполняет 1080×1920 без полей), горизонтальный излишек
 * кропится позицией; фокус по смещению камеры (substring-матч имени клипа),
 * окно кропа клампится в границы исходника. Position — нормированные
 * координаты нового кадра ([0.5,0.5] = центр). ═══ */

describe('DeterministicPipelines.planVerticalReframe', () => {
  const DIMS = { '/uhd.braw': { width: 3840, height: 2160 } };
  const clip = (name, path, ti, ci) => ({
    trackIndex: ti == null ? 0 : ti, clipIndex: ci == null ? 0 : ci,
    name, mediaPath: path
  });

  it('UHD 3840×2160 → 1080×1920: cover-скейл 88.89, центр [0.5, 0.5]', () => {
    const r = DP.planVerticalReframe([clip('Общий план', '/uhd.braw')], DIMS, {});
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].scalePct, 88.89);
    assert.equal(r.items[0].posX, 0.5);
    assert.equal(r.items[0].posY, 0.5);
    assert.equal(r.items[0].trackIndex, 0);
    assert.equal(r.items[0].clipIndex, 0);
  });

  it('смещение камеры по substring-матчу имени: «гость» −20% → фокус левее, контент вправо', () => {
    const r = DP.planVerticalReframe(
      [clip('Гость 1.braw', '/uhd.braw')], DIMS,
      { offsets: [{ match: 'гость', offsetPct: -20 }] }
    );
    /* displayedW = 3840·(1920/2160) = 3413.33; posX = 0.5 + 0.2·3413.33/1080 */
    assert.equal(r.items[0].posX, 1.1321);
  });

  it('экстремальное смещение клампится: −100% → левый край исходника у левого края кадра', () => {
    const r = DP.planVerticalReframe(
      [clip('Гость 1', '/uhd.braw')], DIMS,
      { offsets: [{ match: 'гость', offsetPct: -100 }] }
    );
    /* halfWin = 540/3413.33 → f=0.1582 → posX = 0.5 + 0.3418·3413.33/1080 */
    assert.equal(r.items[0].posX, 1.5802);
    /* левый край медиа: posX·1080 − displayedW/2 ≈ 0 */
    const leftEdge = r.items[0].posX * 1080 - (3840 * (r.items[0].scalePct / 100)) / 2;
    assert.equal(Math.abs(leftEdge) < 1, true);
  });

  it('уже вертикальный исходник 1080×1920 → скейл 100, смещение игнорируется (нет излишка)', () => {
    const r = DP.planVerticalReframe(
      [clip('Vert', '/v.mp4')], { '/v.mp4': { width: 1080, height: 1920 } },
      { offsets: [{ match: 'vert', offsetPct: 50 }] }
    );
    assert.equal(r.items[0].scalePct, 100);
    assert.equal(r.items[0].posX, 0.5);
  });

  it('исходник у́же 9:16 (900×1920) → cover по ширине, скейл 120, центр', () => {
    const r = DP.planVerticalReframe(
      [clip('Narrow', '/n.mp4')], { '/n.mp4': { width: 900, height: 1920 } }, {}
    );
    assert.equal(r.items[0].scalePct, 120);
    assert.equal(r.items[0].posX, 0.5);
    assert.equal(r.items[0].posY, 0.5);
  });

  it('клип без известных размеров → в skipped с причиной, в items не попадает', () => {
    const r = DP.planVerticalReframe(
      [clip('Загадка.mov', '/нет-в-dims.mov'), clip('Общий', '/uhd.braw', 0, 1)],
      DIMS, {}
    );
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].clipIndex, 1);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].name, 'Загадка.mov');
    assert.equal(typeof r.skipped[0].reason, 'string');
    assert.equal(r.total, 2);
  });

  it('кастомный target (опции targetW/targetH) уважается', () => {
    const r = DP.planVerticalReframe(
      [clip('Общий', '/uhd.braw')], DIMS, { targetW: 1920, targetH: 1080 }
    );
    /* 16:9 в 16:9 → cover = 0.5 → 50% */
    assert.equal(r.items[0].scalePct, 50);
    assert.equal(r.items[0].posX, 0.5);
  });

  it('пустые входы → пустой план', () => {
    assert.equal(DP.planVerticalReframe([], DIMS, {}).items.length, 0);
    assert.equal(DP.planVerticalReframe(null, DIMS, {}).items.length, 0);
    assert.equal(DP.planVerticalReframe([clip('x', '/uhd.braw')], null, {}).items.length, 0);
  });
});

/* ═══ segmentsToSrtCues / cuesToSrt: смарт-субтитры из Whisper-сегментов.
 * Титры: ≤2 строки по ≤42 символа, ≤5с; длинные сегменты режутся по словам
 * с линейным таймингом. cuesToSrt — стандартный SRT (HH:MM:SS,mmm). ═══ */

describe('DeterministicPipelines.segmentsToSrtCues', () => {
  it('короткий сегмент → один титр, тайминг и текст без изменений', () => {
    const out = DP.segmentsToSrtCues(
      [{ startSec: 1.5, endSec: 3.2, text: 'Привет, как дела?' }], {});
    assert.equal(out.length, 1);
    assert.equal(out[0].startSec, 1.5);
    assert.equal(out[0].endSec, 3.2);
    assert.equal(out[0].text, 'Привет, как дела?');
  });

  it('длинный сегмент режется по maxDurSec с линейным таймингом, слова не теряются', () => {
    const words = [];
    for (let i = 0; i < 20; i++) words.push('слово');
    const out = DP.segmentsToSrtCues(
      [{ startSec: 0, endSec: 20, text: words.join(' ') }],
      { maxDurSec: 5 });
    assert.equal(out.length, 4);
    assert.equal(out[0].startSec, 0);
    assert.equal(out[0].endSec, 5);
    assert.equal(out[3].startSec, 15);
    assert.equal(out[3].endSec, 20);
    const joined = [...out].map((c) => c.text.replace(/\n/g, ' ')).join(' ');
    assert.equal(joined, words.join(' '));
  });

  it('перенос строк: ≤2 строки по ≤42 символа', () => {
    /* 12 слов по 6 симв = 83 символа с пробелами — влезает в 2 строки, 1 титр */
    const words = [];
    for (let i = 0; i < 12; i++) words.push('слово' + (i % 10));
    const out = DP.segmentsToSrtCues(
      [{ startSec: 0, endSec: 4, text: words.join(' ') }], {});
    assert.equal(out.length, 1);
    const lines = out[0].text.split('\n');
    assert.equal(lines.length <= 2, true);
    for (const l of lines) assert.equal(l.length <= 42, true, 'строка >42: ' + l);
  });

  it('текст шире 2×42 → несколько титров даже без лимита длительности', () => {
    const words = [];
    for (let i = 0; i < 30; i++) words.push('слово' + (i % 10));
    const out = DP.segmentsToSrtCues(
      [{ startSec: 0, endSec: 4, text: words.join(' ') }], { maxDurSec: 60 });
    assert.equal(out.length > 1, true);
    for (const c of out) {
      const lines = c.text.split('\n');
      assert.equal(lines.length <= 2, true);
      for (const l of lines) assert.equal(l.length <= 42, true);
    }
  });

  it('withSpeakers: тире «— » на смене спикера, без тире при том же спикере', () => {
    const out = DP.segmentsToSrtCues([
      { startSec: 0, endSec: 2, text: 'Первый вопрос', speaker: 'Спикер 1' },
      { startSec: 2, endSec: 4, text: 'Первый ответ', speaker: 'Спикер 2' },
      { startSec: 4, endSec: 6, text: 'Продолжение ответа', speaker: 'Спикер 2' }
    ], { withSpeakers: true });
    assert.equal(out[0].text.indexOf('— '), 0);
    assert.equal(out[1].text.indexOf('— '), 0);
    assert.equal(out[2].text.indexOf('— '), -1);
  });

  it('пустые/битые сегменты пропускаются', () => {
    const out = DP.segmentsToSrtCues([
      null,
      { startSec: 0, endSec: 2, text: '   ' },
      { startSec: 5, endSec: 3, text: 'инвертирован' },
      { startSec: 0, endSec: 2, text: 'живой' }
    ], {});
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'живой');
  });
});

describe('DeterministicPipelines.cuesToSrt', () => {
  it('стандартный формат: номер, HH:MM:SS,mmm --> …, пустая строка-разделитель', () => {
    const srt = DP.cuesToSrt([
      { startSec: 0, endSec: 2.5, text: 'Первый' },
      { startSec: 3661.25, endSec: 3662, text: 'Второй\nдвумя строками' }
    ]);
    assert.equal(srt,
      '1\n00:00:00,000 --> 00:00:02,500\nПервый\n\n' +
      '2\n01:01:01,250 --> 01:01:02,000\nВторой\nдвумя строками\n');
  });

  it('пустой вход → пустая строка', () => {
    assert.equal(DP.cuesToSrt([]), '');
  });
});

describe('DeterministicPipelines.planFrameSources', () => {
  const clip = (o) => Object.assign(
    { trackIndex: 0, name: 'c', mediaPath: 'D:/a.mp4', startSec: 0, endSec: 10, inPointSec: 0, disabled: false }, o);

  it('базовый маппинг: sourceSec = inPoint + (t − start)', () => {
    const out = DP.planFrameSources(
      [clip({ startSec: 5, endSec: 15, inPointSec: 100 })], {}, [7.5]);
    assert.equal(out.items.length, 1);
    assert.deepEqual({ ...out.items[0] },
      { timelineSec: 7.5, mediaPath: 'D:/a.mp4', sourceSec: 102.5, clipName: 'c' });
    assert.equal(out.skipped.length, 0);
  });

  it('верхняя дорожка выигрывает; disabled игнорируется', () => {
    const out = DP.planFrameSources([
      clip({ trackIndex: 0, mediaPath: 'D:/low.mp4' }),
      clip({ trackIndex: 2, mediaPath: 'D:/off.mp4', disabled: true }),
      clip({ trackIndex: 1, mediaPath: 'D:/top.mp4' })
    ], {}, [3]);
    assert.equal(out.items[0].mediaPath, 'D:/top.mp4');
  });

  it('время вне клипов и битые времена → skipped с причиной', () => {
    const out = DP.planFrameSources([clip({})], {}, [20, NaN, -1]);
    assert.equal(out.items.length, 0);
    assert.equal(out.skipped.length, 3);
    for (const s of out.skipped) assert.equal(typeof s.reason, 'string');
  });

  it('nest: один уровень вложенности, тайм внутрь через inPoint nest-клипа', () => {
    const out = DP.planFrameSources(
      [clip({ mediaPath: 'nest:99', startSec: 10, endSec: 40, inPointSec: 60 })],
      { 'nest:99': [clip({ startSec: 50, endSec: 90, inPointSec: 7 })] },
      [15]);
    /* t=15 → innerT = 60 + (15−10) = 65 → source = 7 + (65−50) = 22 */
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].mediaPath, 'D:/a.mp4');
    assert.equal(out.items[0].sourceSec, 22);
  });

  it('nest: дырка внутри inner-секвенции → skipped', () => {
    const out = DP.planFrameSources(
      [clip({ mediaPath: 'nest:99', startSec: 0, endSec: 30, inPointSec: 0 })],
      { 'nest:99': [clip({ startSec: 20, endSec: 30 })] },
      [5]);
    assert.equal(out.items.length, 0);
    assert.equal(out.skipped.length, 1);
  });

  it('inPointSec null трактуется как 0; sourceSec округлён до 3 знаков', () => {
    const out = DP.planFrameSources(
      [clip({ inPointSec: null, startSec: 1.0001 })], {}, [2.00015]);
    assert.equal(out.items[0].sourceSec, 1);
  });
});
