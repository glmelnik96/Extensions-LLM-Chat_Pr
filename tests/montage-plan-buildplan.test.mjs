import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMontagePlan } from './load-montage-plan-module.mjs';

const MP = loadMontagePlan();

/* Хелпер: транскрипт из N абзацев по dur сек каждый */
function mkEntry(durs) {
  let t = 0;
  const paragraphs = durs.map((d, i) => {
    const p = { i, startSec: t, endSec: t + d, text: 'p' + i };
    t += d;
    return p;
  });
  return { paragraphs, topics: [] };
}

test('buildPlanFromLabels: золото в одной секции — keep берёт золото, не пропорцию', () => {
  // 10 абзацев по 60с (итого 600с). Цель 120с (2 блока). Золото — абзацы 7,8.
  const entry = mkEntry(Array(10).fill(60));
  const labeled = entry.paragraphs.map((p, i) => ({
    i, blockId: 'b' + i, importance: (i === 7 || i === 8) ? 3 : 1,
    role: (i === 7 || i === 8) ? 'payoff' : 'filler', theme: 'блок ' + i, protect: null
  }));
  const r = MP.buildPlanFromLabels(labeled, entry, 120);
  const keptIdx = [];
  r.blocks.forEach(b => { if (b.action === 'keep') for (let p = b.paragraphs.from; p <= b.paragraphs.to; p++) keptIdx.push(p); });
  assert.ok(keptIdx.includes(7) && keptIdx.includes(8), 'золото 7,8 должно быть в keep');
  assert.ok(r.stats.keepSec <= 120 * 1.1, 'keep в пределах бюджета +10%');
});

test('buildPlanFromLabels: защита protect start/end всегда в keep', () => {
  const entry = mkEntry(Array(6).fill(30)); // 180с
  const labeled = entry.paragraphs.map((p, i) => ({
    i, blockId: 'b' + i, importance: (i === 0 || i === 5) ? 0 : 2,
    role: 'argument', theme: 't' + i, protect: i === 0 ? 'start' : (i === 5 ? 'end' : null)
  }));
  const r = MP.buildPlanFromLabels(labeled, entry, 60);
  const kept = [];
  r.blocks.forEach(b => { if (b.action === 'keep') for (let p = b.paragraphs.from; p <= b.paragraphs.to; p++) kept.push(p); });
  assert.ok(kept.includes(0), 'start защищён');
  assert.ok(kept.includes(5), 'end защищён');
});

test('buildPlanFromLabels: покрытие — каждый абзац ровно в одном блоке, без дыр', () => {
  const entry = mkEntry(Array(8).fill(20));
  const labeled = entry.paragraphs.map((p, i) => ({
    i, blockId: 'b' + i, importance: i % 2, role: 'argument', theme: 't', protect: null
  }));
  const r = MP.buildPlanFromLabels(labeled, entry, 60);
  const seen = new Set();
  r.blocks.forEach(b => { for (let p = b.paragraphs.from; p <= b.paragraphs.to; p++) { assert.ok(!seen.has(p), 'нет перекрытия'); seen.add(p); } });
  for (let i = 0; i < 8; i++) assert.ok(seen.has(i), 'абзац ' + i + ' покрыт');
});

test('buildPlanFromLabels: cut-reason выводится из role', () => {
  const entry = mkEntry(Array(4).fill(100)); // 400с, цель 100 → 3 в cut
  const labeled = [
    { i:0, blockId:'b0', importance:3, role:'hook', theme:'t', protect:'start' },
    { i:1, blockId:'b1', importance:0, role:'repeat', theme:'t', protect:null },
    { i:2, blockId:'b2', importance:0, role:'filler', theme:'t', protect:null },
    { i:3, blockId:'b3', importance:0, role:'offtopic', theme:'t', protect:null }
  ];
  const r = MP.buildPlanFromLabels(labeled, entry, 100);
  const cuts = r.blocks.filter(b => b.action === 'cut');
  const reasons = cuts.map(c => c.reason).join(' ');
  assert.match(reasons, /повтор/);
  assert.match(reasons, /вода/);
  assert.match(reasons, /офтоп/);
});

test('buildPlanFromLabels: соседние одинаковые action сливаются в один блок', () => {
  const entry = mkEntry(Array(4).fill(50));
  const labeled = entry.paragraphs.map((p, i) => ({
    i, blockId: 'b' + i, importance: i < 2 ? 3 : 0, role: 'argument', theme: 't', protect: null
  }));
  const r = MP.buildPlanFromLabels(labeled, entry, 100);
  // абзацы 0,1 → keep (слиты), 2,3 → cut (слиты)
  assert.equal(r.blocks.length, 2, 'ровно 2 слитых блока');
});
