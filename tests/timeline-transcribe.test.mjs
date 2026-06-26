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
