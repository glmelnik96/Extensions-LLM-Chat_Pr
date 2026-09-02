/**
 * ChatRouter — детерминированный роутер простых запросов чата (сентябрь 2026).
 * Golden-set формулировок: таймкодные резы, пайплайны по фразе, свежесть транскрипта.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadIife } from './helpers.mjs';

const CR = loadIife('client/shared/chat-router.js', 'ChatRouter');

describe('ChatRouter.parseTimecode', () => {
  const cases = [
    ['90', 90], ['1:30', 90], ['01:30', 90], ['1:02:03', 3723], ['2,5', 2.5],
    ['0:05.5', 5.5], ['12:43', 763], ['', null], ['abc', null], ['1:75', null]
  ];
  for (const [inp, exp] of cases) {
    it(JSON.stringify(inp) + ' → ' + exp, () => assert.equal(CR.parseTimecode(inp), exp));
  }
});

describe('ChatRouter.parseDuration', () => {
  const cases = [
    ['10 секунд', 10], ['10 сек', 10], ['10с', 10], ['2 минуты', 120], ['1 мин 30 сек', 90],
    ['1.5 мин', 90], ['полторы минуты', null], ['45', null]
  ];
  for (const [inp, exp] of cases) {
    it(JSON.stringify(inp) + ' → ' + exp, () => assert.equal(CR.parseDuration(inp), exp));
  }
});

describe('ChatRouter.parseIntervalDelete — диапазоны', () => {
  const ok = [
    ['удали с 3 по 5 секунду', 3, 5, true],
    ['Удали с 10 по 20 сек', 10, 20, true],
    ['вырежи с 1:30 по 1:45', 90, 105, true],
    ['вырежи кусок 2:10-2:40', 130, 160, true],
    ['убери с 2:10 до 2:40', 130, 160, true],
    ['удали между 3-й и 5-й секундой', 3, 5, true],
    ['удали интервал 12:43 – 12:50', 763, 770, true],
    ['вырежи с 1 по 2 мин', 60, 120, true],
    ['удали с 0:05.5 по 0:07', 5.5, 7, true],
    ['удали с 5 по 3 секунду', 3, 5, true],
    ['вырежи с 10 по 20 сек, не смыкая', 10, 20, false],
    ['удали с 10 по 20 сек и оставь дыру', 10, 20, false],
    ['отрежь от 1:00 до 1:10', 60, 70, true]
  ];
  for (const [text, s, e, ripple] of ok) {
    it(JSON.stringify(text), () => {
      const r = CR.parseIntervalDelete(text);
      assert.ok(r, 'ожидался интервал');
      assert.ok(Math.abs(r.startSec - s) < 1e-9, 'start ' + r.startSec);
      assert.ok(Math.abs(r.endSec - e) < 1e-9, 'end ' + r.endSec);
      assert.equal(r.ripple, ripple);
      assert.equal(r.exact, true);
    });
  }
  const none = [
    'удали паузу на 1:30',                      /* одиночная точка */
    'удали два интервала: 3-5 сек и 10-12 сек', /* несколько → LLM */
    'вырежи с 3 по 5 сек и с 10 по 12 сек',
    'найди где говорят про стратегию с 1:30 по 2:00', /* нет глагола реза */
    'что на таймлайне',
    'удали клип A001',
    'удали с 5 по 5 сек'                        /* нулевой */
  ];
  for (const text of none) {
    it(JSON.stringify(text) + ' → null', () => assert.equal(CR.parseIntervalDelete(text), null));
  }
});

describe('ChatRouter.parseIntervalDelete — первые/последние N', () => {
  it('«удали первые 10 секунд» → [0,10]', () => {
    const r = CR.parseIntervalDelete('удали первые 10 секунд');
    assert.deepEqual([r.startSec, r.endSec, r.form], [0, 10, 'first']);
  });
  it('«вырежи первую минуту» → [0,60]', () => {
    const r = CR.parseIntervalDelete('вырежи первую минуту');
    assert.deepEqual([r.startSec, r.endSec], [0, 60]);
  });
  it('«убери последние 5 секунд» без длительности → needsDuration', () => {
    const r = CR.parseIntervalDelete('убери последние 5 секунд');
    assert.equal(r.needsDuration, true);
    assert.equal(r.lastSec, 5);
  });
  it('«убери последние 5 секунд» с durationSec=100 → [95,100]', () => {
    const r = CR.parseIntervalDelete('убери последние 5 секунд', { durationSec: 100 });
    assert.deepEqual([r.startSec, r.endSec, r.form], [95, 100, 'last']);
  });
  it('«удали последнюю минуту» с durationSec=30 → [0,30] (клэмп)', () => {
    const r = CR.parseIntervalDelete('удали последнюю минуту', { durationSec: 30 });
    assert.deepEqual([r.startSec, r.endSec], [0, 30]);
  });
});

describe('ChatRouter.hasExplicitTimecodes', () => {
  for (const t of ['вырежи с 1:30 по 1:45', 'удали первые 10 секунд', 'обрежь 2 мин'])
    it(JSON.stringify(t) + ' → true', () => assert.equal(CR.hasExplicitTimecodes(t), true));
  for (const t of ['убери паразитов', 'собери ролик про стратегию', 'сделай 3 главы'])
    it(JSON.stringify(t) + ' → false', () => assert.equal(CR.hasExplicitTimecodes(t), false));
});

describe('ChatRouter.matchPipelineIntent — детерминированные пайплайны', () => {
  const hits = [
    ['убери тишины', 'silences', {}],
    ['Убери все паузы', 'silences', {}],
    ['вырежи паузы длиннее 2 секунд', 'silences', { minDuration: 2 }],
    ['удали паузы дольше 1.5 сек', 'silences', { minDuration: 1.5 }],
    ['убери тишины, не смыкая', 'silences', { cutMode: 'keep_spaces' }],
    ['заглуши паузы', 'silences', { cutMode: 'mute' }],
    ['убери паузы с кроссфейдами', 'silences', { crossfade: true }],
    ['сделай джампкаты', 'jumps', {}],
    ['jump cuts', 'jumps', {}],
    ['джамп-каты по паузам длиннее 0.4 сек', 'jumps', { maxPause: 0.4 }],
    ['убери паразитов', 'fillers', { sensitivity: 'strict' }],
    ['почисти слова-паразиты', 'fillers', { sensitivity: 'strict' }],
    ['убери все паразиты, включая «типа» и «вот»', 'fillers', { sensitivity: 'normal' }],
    ['убери эканье', 'fillers', { sensitivity: 'strict' }],
    ['заглуши мат', 'profanity', { cutMode: 'mute' }],
    ['вырежи мат', 'profanity', { cutMode: 'remove' }],
    ['поставь главы', 'chapters', {}],
    ['расставь 5 глав', 'chapters', { maxChapters: 5 }],
    ['сделай оглавление', 'chapters', {}],
    ['закрой пробелы на таймлайне', 'gaps', {}],
    ['убери дыры между клипами', 'gaps', {}],
    ['сомкни пробелы длиннее 1 сек', 'gaps', { minGapSec: 1 }]
  ];
  for (const [text, tool, params] of hits) {
    it(JSON.stringify(text) + ' → ' + tool, () => {
      const r = CR.matchPipelineIntent(text);
      assert.ok(r, 'ожидался пайплайн');
      assert.equal(r.tool, tool);
      for (const k of Object.keys(params)) assert.equal(r.params[k], params[k], 'param ' + k);
    });
  }
  const miss = [
    'убери паузы и собери ролик на 60 секунд',    /* смысловая сборка → LLM */
    'убери скучные паузы где он мямлит про бюджет', /* «про» → LLM */
    'поставь главы про стратегию',                /* тематические главы → LLM */
    'найди где говорят про тишину',
    'сделай динамичнее',
    'что на таймлайне',
    '/тишины minDuration=2',                      /* slash — свой парсер */
    'вырежи с 1:30 по 1:45',                      /* таймкодный рез — не пайплайн */
    'убери паузы в первой части, а во второй оставь как есть, только подчисти паразиты и добавь главы',
    /* составные запросы (live 02.09.2026) → LLM */
    'почисти оговорки и повторы, потом убери тишины',
    'убери тишины и паразитов',
    'убери оговорки',
    'убери паузы, а также поставь главы',
    'заглуши мат и вырежи вступление'
  ];
  for (const text of miss) {
    it(JSON.stringify(text.slice(0, 50)) + ' → null', () => assert.equal(CR.matchPipelineIntent(text), null));
  }
});

describe('ChatRouter.transcriptFreshness', () => {
  it('нет entry → none', () => assert.equal(CR.transcriptFreshness({ audioFp: 'a' }, null).state, 'none'));
  it('нет отпечатков → unknown', () => {
    assert.equal(CR.transcriptFreshness({ audioFp: 'a' }, { segments: [] }).state, 'unknown');
    assert.equal(CR.transcriptFreshness({}, { timelineFp: { hash: 'a' } }).state, 'unknown');
  });
  it('совпадение → fresh', () => assert.equal(CR.transcriptFreshness({ audioFp: 'a' }, { timelineFp: { hash: 'a' } }).state, 'fresh'));
  it('расхождение → stale', () => assert.equal(CR.transcriptFreshness({ audioFp: 'b' }, { timelineFp: { hash: 'a' } }).state, 'stale'));
  it('possiblyStale при совпадении отпечатков → suspect (предупреждение, не блок)', () => {
    assert.equal(CR.transcriptFreshness({ audioFp: 'a' }, { timelineFp: { hash: 'a' }, possiblyStale: true }).state, 'suspect');
  });
  it('расхождение отпечатков важнее possiblyStale → stale', () => {
    assert.equal(CR.transcriptFreshness({ audioFp: 'b' }, { timelineFp: { hash: 'a' }, possiblyStale: true }).state, 'stale');
  });
});

describe('ChatRouter.snapshotDurationSec', () => {
  it('max(sequenceEndSec, clips)', () => {
    assert.equal(CR.snapshotDurationSec({ ok: true, sequenceEndSec: 0, clips: [{ endSec: 12.5 }, { endSec: 3 }] }), 12.5);
    assert.equal(CR.snapshotDurationSec({ ok: true, sequenceEndSec: 20, clips: [{ endSec: 12.5 }] }), 20);
    assert.equal(CR.snapshotDurationSec(null), 0);
  });
});
