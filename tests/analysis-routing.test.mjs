import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadAnalysisRouting } from './load-analysis-routing.mjs';

const AR = loadAnalysisRouting();

describe('AnalysisRouting.shouldRemoveLabel', () => {
  test('content никогда не режется (ни при одном режиме)', () => {
    assert.equal(AR.shouldRemoveLabel('content', 'gentle'), false);
    assert.equal(AR.shouldRemoveLabel('content', 'normal'), false);
    assert.equal(AR.shouldRemoveLabel('content', 'aggressive'), false);
  });

  test('gentle: только filler+artifact → toRemove', () => {
    assert.equal(AR.shouldRemoveLabel('filler', 'gentle'), true);
    assert.equal(AR.shouldRemoveLabel('artifact', 'gentle'), true);
    assert.equal(AR.shouldRemoveLabel('intro', 'gentle'), false);
    assert.equal(AR.shouldRemoveLabel('outro', 'gentle'), false);
    assert.equal(AR.shouldRemoveLabel('outtake', 'gentle'), false);
    assert.equal(AR.shouldRemoveLabel('repeat', 'gentle'), false);
    assert.equal(AR.shouldRemoveLabel('digression', 'gentle'), false);
  });

  test('normal (default): filler+artifact+intro+outro+outtake+repeat, НО НЕ digression', () => {
    assert.equal(AR.shouldRemoveLabel('filler', 'normal'), true);
    assert.equal(AR.shouldRemoveLabel('artifact', 'normal'), true);
    assert.equal(AR.shouldRemoveLabel('intro', 'normal'), true);
    assert.equal(AR.shouldRemoveLabel('outro', 'normal'), true);
    assert.equal(AR.shouldRemoveLabel('outtake', 'normal'), true);
    assert.equal(AR.shouldRemoveLabel('repeat', 'normal'), true);
    assert.equal(AR.shouldRemoveLabel('digression', 'normal'), false);
  });

  test('aggressive: всё не-content (включая digression) → toRemove', () => {
    assert.equal(AR.shouldRemoveLabel('filler', 'aggressive'), true);
    assert.equal(AR.shouldRemoveLabel('artifact', 'aggressive'), true);
    assert.equal(AR.shouldRemoveLabel('intro', 'aggressive'), true);
    assert.equal(AR.shouldRemoveLabel('outro', 'aggressive'), true);
    assert.equal(AR.shouldRemoveLabel('outtake', 'aggressive'), true);
    assert.equal(AR.shouldRemoveLabel('repeat', 'aggressive'), true);
    assert.equal(AR.shouldRemoveLabel('digression', 'aggressive'), true);
  });

  test('undefined/null aggressiveness → normal behavior', () => {
    assert.equal(AR.shouldRemoveLabel('digression'), false); /* normal default */
    assert.equal(AR.shouldRemoveLabel('digression', null), false);
    assert.equal(AR.shouldRemoveLabel('filler', undefined), true);
  });

  test('неизвестная метка → при normal/gentle не режется, при aggressive режется', () => {
    /* unknown label is "not content" — normal would remove, gentle would not */
    assert.equal(AR.shouldRemoveLabel('unknown_label', 'gentle'), false);
    assert.equal(AR.shouldRemoveLabel('unknown_label', 'normal'), true);
    assert.equal(AR.shouldRemoveLabel('unknown_label', 'aggressive'), true);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * invertKeepToRemove (US-004)
 * ═══════════════════════════════════════════════════════════════ */

describe('AnalysisRouting.invertKeepToRemove', () => {
  test('PRD acceptance: keep [[10,20],[40,50]] на 60с → remove [[0,10],[20,40],[50,60]]', () => {
    const r = AR.invertKeepToRemove(
      [{ startSec: 10, endSec: 20 }, { startSec: 40, endSec: 50 }],
      { minSec: 0, maxSec: 60 }
    );
    assert.ok(!r.error, 'ожидаем успех, получили: ' + r.error);
    assert.equal(r.removeIntervals.length, 3);
    assert.equal(r.removeIntervals[0].startSec, 0);
    assert.equal(r.removeIntervals[0].endSec, 10);
    assert.equal(r.removeIntervals[1].startSec, 20);
    assert.equal(r.removeIntervals[1].endSec, 40);
    assert.equal(r.removeIntervals[2].startSec, 50);
    assert.equal(r.removeIntervals[2].endSec, 60);
  });

  test('keep с самого начала → нет leading remove', () => {
    const r = AR.invertKeepToRemove(
      [{ startSec: 0, endSec: 20 }],
      { minSec: 0, maxSec: 60 }
    );
    assert.equal(r.removeIntervals.length, 1);
    assert.equal(r.removeIntervals[0].startSec, 20);
    assert.equal(r.removeIntervals[0].endSec, 60);
  });

  test('keep до конца → нет trailing remove', () => {
    const r = AR.invertKeepToRemove(
      [{ startSec: 40, endSec: 60 }],
      { minSec: 0, maxSec: 60 }
    );
    assert.equal(r.removeIntervals.length, 1);
    assert.equal(r.removeIntervals[0].startSec, 0);
    assert.equal(r.removeIntervals[0].endSec, 40);
  });

  test('keep покрывает всё → removeIntervals пустой', () => {
    const r = AR.invertKeepToRemove(
      [{ startSec: 0, endSec: 60 }],
      { minSec: 0, maxSec: 60 }
    );
    assert.equal(r.removeIntervals.length, 0);
  });

  test('пересекающиеся keep-интервалы → мёрджатся перед инверсией', () => {
    const r = AR.invertKeepToRemove(
      [{ startSec: 10, endSec: 25 }, { startSec: 20, endSec: 40 }],
      { minSec: 0, maxSec: 60 }
    );
    assert.equal(r.removeIntervals.length, 2);
    assert.equal(r.removeIntervals[0].endSec, 10);
    assert.equal(r.removeIntervals[1].startSec, 40);
  });

  test('пустой keep → error', () => {
    const r = AR.invertKeepToRemove([], { minSec: 0, maxSec: 60 });
    assert.ok(r.error);
    assert.match(r.error, /пуст/i);
  });

  test('нет границ → error', () => {
    const r = AR.invertKeepToRemove([{ startSec: 10, endSec: 20 }], { minSec: 60, maxSec: 0 });
    assert.ok(r.error);
  });

  test('некорректный интервал (end <= start) → error', () => {
    const r = AR.invertKeepToRemove(
      [{ startSec: 20, endSec: 10 }],
      { minSec: 0, maxSec: 60 }
    );
    assert.ok(r.error);
  });

  test('keep за пределами [min, max] → clipping', () => {
    const r = AR.invertKeepToRemove(
      [{ startSec: -5, endSec: 70 }],
      { minSec: 0, maxSec: 60 }
    );
    /* keep обрезается до [0, 60] → ничего не удаляем */
    assert.equal(r.removeIntervals.length, 0);
  });

  test('выравнивание по сегментам: keep [12, 18] расширяется до границ сегментов', () => {
    /* Segments: [0-10], [10-20], [20-30]. keep [12-18] пересекается с [10-20],
       значит keep расширяется до [10-20]. remove = [0-10], [20-60]. */
    const segments = [
      { startSec: 0, endSec: 10 },
      { startSec: 10, endSec: 20 },
      { startSec: 20, endSec: 30 },
      { startSec: 30, endSec: 40 },
      { startSec: 40, endSec: 50 },
      { startSec: 50, endSec: 60 }
    ];
    const r = AR.invertKeepToRemove(
      [{ startSec: 12, endSec: 18 }],
      { minSec: 0, maxSec: 60, segments: segments }
    );
    assert.equal(r.removeIntervals.length, 2);
    assert.equal(r.removeIntervals[0].startSec, 0);
    assert.equal(r.removeIntervals[0].endSec, 10);
    assert.equal(r.removeIntervals[1].startSec, 20);
    assert.equal(r.removeIntervals[1].endSec, 60);
  });
});
