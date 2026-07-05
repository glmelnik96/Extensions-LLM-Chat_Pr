import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadMontagePlan } from './load-montage-plan-module.mjs';

const MP = loadMontagePlan();

/** Нормализация cross-realm объектов (vm-песочница создаёт объекты с другим прототипом,
 *  deepStrictEqual падает). JSON round-trip — стандартный паттерн в этом репо. */
function norm(v) { return JSON.parse(JSON.stringify(v)); }

/** 8 абзацев по 60с: [0,60), [60,120) … [420,480); темы: 0-2 «Завязка», 3-5 «Тема Б», 6-7 «Финал» */
function makeEntry() {
  const paragraphs = [];
  for (let i = 0; i < 8; i++) {
    paragraphs.push({ i, startSec: i * 60, endSec: (i + 1) * 60, text: 'абзац ' + i });
  }
  return {
    paragraphs,
    topics: [
      { startSec: 0, endSec: 180, title: 'Завязка' },
      { startSec: 180, endSec: 360, title: 'Тема Б' },
      { startSec: 360, endSec: 480, title: 'Финал' }
    ]
  };
}

function plan(targetSec, blocks) {
  return { targetDurationSec: targetSec, blocks, summary: 'тест' };
}

const KEEP = (from, to, theme) => ({ action: 'keep', paragraphs: { from, to }, theme: theme || 'Тема' });
const CUT = (from, to, reason) => ({ action: 'cut', paragraphs: { from, to }, reason: reason || 'вода' });

describe('MontagePlan.validatePlan — структура', () => {
  test('валидный план: ok, errors пуст, stats посчитан', () => {
    const r = MP.validatePlan(plan(240, [KEEP(0, 3, 'Суть'), CUT(4, 7, 'повтор')]), makeEntry());
    assert.equal(r.ok, true);
    assert.deepEqual(norm(r.errors), []);
    assert.equal(r.stats.keepSec, 240);
    assert.equal(r.stats.cutSec, 240);
    assert.equal(r.stats.keepBlocks, 1);
    assert.equal(r.stats.cutBlocks, 1);
  });

  test('нет targetDurationSec → error', () => {
    const r = MP.validatePlan({ blocks: [KEEP(0, 7)] }, makeEntry());
    assert.equal(r.ok, false);
    assert.ok(r.errors.join(' ').includes('targetDurationSec'));
  });

  test('targetDurationSec: NaN → error', () => {
    const r = MP.validatePlan(plan(NaN, [KEEP(0, 7, 'Суть')]), makeEntry());
    assert.equal(r.ok, false);
    assert.ok(r.errors.join(' ').includes('targetDurationSec'));
  });

  test('targetDurationSec: Infinity → error', () => {
    const r = MP.validatePlan(plan(Infinity, [KEEP(0, 7, 'Суть')]), makeEntry());
    assert.equal(r.ok, false);
    assert.ok(r.errors.join(' ').includes('targetDurationSec'));
  });

  test('blocks пуст/не массив → error', () => {
    assert.equal(MP.validatePlan(plan(60, []), makeEntry()).ok, false);
    assert.equal(MP.validatePlan(plan(60, null), makeEntry()).ok, false);
  });

  test('незнакомый action → error с индексом блока', () => {
    const r = MP.validatePlan(plan(240, [{ action: 'trim', paragraphs: { from: 0, to: 7 } }]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /блок 0/i);
  });

  test('paragraphs.from > to или вне диапазона → error', () => {
    assert.equal(MP.validatePlan(plan(240, [KEEP(3, 1), CUT(0, 7)]), makeEntry()).ok, false);
    assert.equal(MP.validatePlan(plan(240, [KEEP(0, 99)]), makeEntry()).ok, false);
    assert.equal(MP.validatePlan(plan(240, [KEEP(-1, 7)]), makeEntry()).ok, false);
  });
});

describe('MontagePlan.validatePlan — покрытие', () => {
  test('дыра (абзац ни в одном блоке) → error с номером абзаца', () => {
    const r = MP.validatePlan(plan(240, [KEEP(0, 3, 'Суть'), CUT(5, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /4/);
  });

  test('перекрытие (абзац в двух блоках) → error с номером', () => {
    const r = MP.validatePlan(plan(240, [KEEP(0, 4, 'Суть'), CUT(4, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /4/);
  });
});

describe('MontagePlan.validatePlan — хронометраж ±10% (реальные длительности, не LLM)', () => {
  test('в пределах +10% → ok (граница ровно 10% допустима)', () => {
    // keep 0-3 = 240с, цель 219 → 240/219 ≈ +9.6% → ok
    const r = MP.validatePlan(plan(219, [KEEP(0, 3, 'Суть'), CUT(4, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, true);
  });

  test('ровно +10% (ratio === 1.10) → ok (условие strict >)', () => {
    // keep 0-3 = 240с, цель = 240/1.1 → ratio ровно 1.1
    const r = MP.validatePlan(plan(240 / 1.1, [KEEP(0, 3, 'Суть'), CUT(4, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, true);
  });

  test('ровно −10% (ratio === 0.90) → ok (условие strict <)', () => {
    // keep 0-2 = 180с, цель = 200 → ratio = 180/200 = 0.9 ровно
    const r = MP.validatePlan(plan(200, [KEEP(0, 2, 'Суть'), CUT(3, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, true);
  });

  test('перебор > +10% → error с точными цифрами и сколько убрать', () => {
    // keep 0-3 = 240с, цель 200 → +20%
    const r = MP.validatePlan(plan(200, [KEEP(0, 3, 'Суть'), CUT(4, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, false);
    const msg = r.errors.join(' ');
    assert.match(msg, /240|4:00/);
    assert.match(msg, /200|3:20/);
    assert.match(msg, /убер/i);
  });

  test('недобор > −10% → error с подсказкой вернуть или предложить меньшую цель', () => {
    // keep 0-1 = 120с, цель 240 → 50%
    const r = MP.validatePlan(plan(240, [KEEP(0, 1, 'Суть'), CUT(2, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /недобор|[Вв]ерни|меньшую цель/);
  });
});

describe('MontagePlan.validatePlan — причины и темы', () => {
  test('cut без reason → error с индексом блока', () => {
    const r = MP.validatePlan(
      plan(240, [KEEP(0, 3, 'Суть'), { action: 'cut', paragraphs: { from: 4, to: 7 } }]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /reason|причин/i);
  });

  test('keep без theme → error', () => {
    const r = MP.validatePlan(
      plan(240, [{ action: 'keep', paragraphs: { from: 0, to: 3 } }, CUT(4, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /theme|тем/i);
  });
});

describe('MontagePlan.validatePlan — пожертвованные темы (warnings, не errors)', () => {
  test('тема, все абзацы которой в cut → warning с названием темы', () => {
    // «Тема Б» = 180-360с = абзацы 3,4,5 — все в cut; keep 0-2 (180с) + 6-7 (120с) = 300с, цель 300
    const r = MP.validatePlan(
      plan(300, [KEEP(0, 2, 'Завязка'), CUT(3, 5, 'офтоп'), KEEP(6, 7, 'Финал')]), makeEntry());
    assert.equal(r.ok, true);
    assert.match(r.warnings.join(' '), /Тема Б/);
    assert.deepEqual(norm(r.stats.sacrificedTopics), ['Тема Б']);
  });

  test('тема частично сохранена → warning НЕ ставится', () => {
    const r = MP.validatePlan(plan(240, [KEEP(0, 3, 'Суть'), CUT(4, 7, 'вода')]), makeEntry());
    assert.equal(r.warnings.filter(w => w.includes('Тема Б')).length, 0);
  });

  test('entry без topics → нет warnings, нет падения', () => {
    const entry = makeEntry();
    delete entry.topics;
    const r = MP.validatePlan(plan(240, [KEEP(0, 3, 'Суть'), CUT(4, 7, 'вода')]), entry);
    assert.equal(r.ok, true);
    assert.deepEqual(norm(r.stats.sacrificedTopics), []);
  });
});

describe('MontagePlan.buildRemoveRefs / buildSummaries — сортировка (I4)', () => {
  test('блоки в обратном порядке → buildRemoveRefs отсортирован по paragraph ascending', () => {
    const refs = MP.buildRemoveRefs([CUT(4, 7, 'вода'), KEEP(0, 3, 'Суть')]);
    const paragraphs = norm(refs).map(r => r.paragraph);
    assert.deepEqual(paragraphs, [4, 5, 6, 7]);
  });

  test('блоки в обратном порядке → buildSummaries.keepSummary отсортирован по startSec ascending', () => {
    const s = MP.buildSummaries([CUT(4, 7, 'вода'), KEEP(0, 3, 'Суть')], makeEntry());
    assert.equal(norm(s).keepSummary[0].startSec, 0);
  });

  test('блоки в обратном порядке → buildSummaries.removeSummary отсортирован по startSec ascending', () => {
    const s = MP.buildSummaries(
      [CUT(6, 7, 'финал'), KEEP(0, 1, 'Суть'), CUT(2, 3, 'вступление'), KEEP(4, 5, 'Основа')],
      makeEntry()
    );
    const removeStarts = norm(s).removeSummary.map(r => r.startSec);
    assert.deepEqual(removeStarts, [120, 360]);
  });
});

describe('MontagePlan.buildRemoveRefs / buildSummaries', () => {
  test('cut-блоки разворачиваются в одиночные removeRefs c reason', () => {
    const refs = MP.buildRemoveRefs([KEEP(0, 3, 'Суть'), CUT(4, 6, 'повтор'), CUT(7, 7, 'вода')]);
    assert.deepEqual(norm(refs), [
      { paragraph: 4, reason: 'повтор' },
      { paragraph: 5, reason: 'повтор' },
      { paragraph: 6, reason: 'повтор' },
      { paragraph: 7, reason: 'вода' }
    ]);
  });

  test('buildSummaries: keepSummary из theme, removeSummary с таймингами из entry и reason', () => {
    const s = MP.buildSummaries([KEEP(0, 1, 'Суть дела'), CUT(2, 7, 'вода')], makeEntry());
    assert.deepEqual(norm(s.keepSummary), [{ startSec: 0, endSec: 120, quote: 'Суть дела' }]);
    assert.equal(s.removeSummary.length, 1);
    assert.equal(s.removeSummary[0].startSec, 120);
    assert.equal(s.removeSummary[0].endSec, 480);
    assert.equal(s.removeSummary[0].reason, 'вода');
    assert.ok(s.removeSummary[0].quote.includes('абзац 2'));
  });
});
