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

  test('keep покрывает всё → error «нечего вырезать» (HIGH #5 fix, 6 мая 2026)', () => {
    const r = AR.invertKeepToRemove(
      [{ startSec: 0, endSec: 60 }],
      { minSec: 0, maxSec: 60 }
    );
    /* Раньше возвращал removeIntervals: []. Теперь error — иначе UI создаст
       proposal с «вырезано 0 интервалов» что путает пользователя. */
    assert.ok(r.error, 'expected error field');
    assert.match(r.error, /нечего вырезать/i);
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

  test('keep за пределами [min, max] → clipping → error (HIGH #5 fix, 6 мая 2026)', () => {
    const r = AR.invertKeepToRemove(
      [{ startSec: -5, endSec: 70 }],
      { minSec: 0, maxSec: 60 }
    );
    /* keep обрезается до [0, 60] → весь транскрипт оставлен → нечего вырезать.
       Раньше возвращал removeIntervals: [], теперь error чтобы UI не показывал
       proposal с «вырезано 0 интервалов». */
    assert.ok(r.error, 'expected error field');
    assert.match(r.error, /нечего вырезать/i);
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

/* ─── validateKeepDuration (HIGH 6 мая 2026) ─── */
describe('AnalysisRouting.validateKeepDuration', () => {
  test('пустой keep → ok с 0', () => {
    const r = AR.validateKeepDuration([], 40);
    assert.equal(r.ok, true);
    assert.equal(r.keepSumSec, 0);
  });

  test('без target → пропускает (ok)', () => {
    const r = AR.validateKeepDuration([{ startSec: 0, endSec: 100 }], 0);
    assert.equal(r.ok, true);
  });

  test('сумма ≤ target → ok', () => {
    const r = AR.validateKeepDuration(
      [{ startSec: 0, endSec: 20 }, { startSec: 30, endSec: 50 }],
      40
    );
    assert.equal(r.ok, true);
    assert.equal(r.keepSumSec, 40);
  });

  test('сумма ≤ target * 1.20 → ok (допуск)', () => {
    /* 47/40 = 1.175 ≤ 1.20 */
    const r = AR.validateKeepDuration([{ startSec: 0, endSec: 47 }], 40);
    assert.equal(r.ok, true);
  });

  test('сумма > target * 1.20 → error с подсказкой', () => {
    /* реальный кейс: 70с при цели 40с (overshoot 75%) */
    const r = AR.validateKeepDuration(
      [
        { startSec: 0, endSec: 34 },     /* 34с */
        { startSec: 35, endSec: 44 },    /* 9с */
        { startSec: 45, endSec: 60 },    /* 15с */
        { startSec: 70, endSec: 79 },    /* 9с */
        { startSec: 108, endSec: 111 }   /* 3с */
      ],
      40
    );
    assert.ok(r.error, 'должна быть ошибка для overshoot 75%');
    assert.equal(r.keepSumSec, 70);
    assert.equal(r.overshootPct, 75);
    assert.match(r.error, /70\.0с при цели 40с/);
    assert.match(r.error, /75%/);
  });

  test('кастомный allowedOvershoot=1.10 → строже', () => {
    /* 45/40 = 1.125 — превышение 12.5%, при cap 10% → error */
    const r = AR.validateKeepDuration([{ startSec: 0, endSec: 45 }], 40, 1.10);
    assert.ok(r.error);
  });

  test('некорректные интервалы (endSec ≤ startSec) — игнорируются в сумме', () => {
    const r = AR.validateKeepDuration(
      [
        { startSec: 0, endSec: 10 },
        { startSec: 20, endSec: 15 },     /* мусор */
        { startSec: 30, endSec: 40 }
      ],
      40
    );
    assert.equal(r.ok, true);
    assert.equal(r.keepSumSec, 20); /* 10 + 10, мусор не учтён */
  });
});
