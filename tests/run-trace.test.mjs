/**
 * RunTrace — трейс хода агента (сентябрь 2026): запись, компакт, события onStatus, feedback.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadIife } from './helpers.mjs';

const RT = loadIife('client/shared/run-trace.js', 'RunTrace');

describe('RunTrace.create / event / finish', () => {
  it('запись содержит мета-поля, события и статус', () => {
    const t = RT.create({ panelId: 'unified', text: 'убери паузы', route: 'pipeline-intent', model: 'm', intents: ['transcript'] });
    assert.ok(t.id);
    t.event('tool', { name: 'run_tool', args: { name: 'silences' } });
    const rec = t.finish('proposal', { proposalKind: 'transcript_cuts' });
    assert.equal(rec.kind, 'turn');
    assert.equal(rec.id, t.id);
    assert.equal(rec.route, 'pipeline-intent');
    assert.equal(rec.status, 'proposal');
    assert.equal(rec.proposalKind, 'transcript_cuts');
    assert.equal(rec.events.length, 1);
    assert.equal(rec.events[0].kind, 'tool');
    assert.equal(rec.events[0].name, 'run_tool');
    assert.deepEqual(rec.events[0].args, { name: 'silences' });
    assert.equal(typeof rec.events[0].t, 'number');
    assert.ok(rec.ms >= 0);
  });
  it('текст запроса режется до 500 символов', () => {
    const rec = RT.create({ text: 'x'.repeat(900) }).finish('done');
    assert.equal(rec.text.length, 500);
  });
  it('кап событий 400 — старые вытесняются', () => {
    const t = RT.create({});
    for (let i = 0; i < 450; i++) t.event('llm', { step: i });
    const rec = t.record();
    assert.equal(rec.events.length, 400);
    assert.equal(rec.events[0].step, 50);
  });
  it('уникальные id', () => {
    const a = RT.newId(), b = RT.newId();
    assert.notEqual(a, b);
  });
});

describe('RunTrace.compact', () => {
  it('строки режутся, массивы до 5, объекты до 12 ключей / 2 уровней', () => {
    const c = RT.compact({
      s: 'a'.repeat(200),
      arr: [1, 2, 3, 4, 5, 6, 7],
      deep: { a: { b: { c: 1 } } },
      fn: function () {}
    });
    assert.equal(c.s.length, 121);
    assert.equal(c.arr.length, 6);
    assert.equal(c.arr[5], '…+2');
    assert.equal(c.deep.a.b, '{…}');
    assert.equal(c.fn, undefined);
    const many = {};
    for (let i = 0; i < 20; i++) many['k' + i] = i;
    assert.equal(Object.keys(RT.compact(many)).length, 13);
  });
  it('план правок: ops[] и поля op видны, глубже — схлопывается', () => {
    const c = RT.compact({ ops: [{ kind: 'ripple_delete_interval', startSec: 1, endSec: 2, meta: { x: [1, 2] } }] });
    assert.equal(c.ops[0].kind, 'ripple_delete_interval');
    assert.equal(c.ops[0].startSec, 1);
    assert.equal(c.ops[0].meta, '{…}');
    assert.deepEqual(RT.compact({ a: [[1, 2, 3]] }), { a: ['[3]'] });
  });
});

describe('RunTrace.fromStatusEvent', () => {
  it('llm/tool/tool-done/model-fallback → события; стрим/размышления → null', () => {
    assert.deepEqual(RT.fromStatusEvent({ phase: 'llm', step: 1, model: 'm', etaMs: 100 }), { kind: 'llm', step: 1, model: 'm', etaMs: 100 });
    assert.equal(RT.fromStatusEvent({ phase: 'tool', step: 1, name: 'find_moments', args: { q: 'x' } }).args.q, 'x');
    assert.deepEqual(RT.fromStatusEvent({ phase: 'tool-done', step: 1, name: 't', ok: false, ms: 5 }), { kind: 'tool-done', step: 1, name: 't', ok: false, ms: 5 });
    assert.equal(RT.fromStatusEvent({ phase: 'model-fallback', step: 2, model: 'b', message: 'x' }).kind, 'fallback');
    assert.equal(RT.fromStatusEvent({ phase: 'streaming' }), null);
    assert.equal(RT.fromStatusEvent({ phase: 'reasoning' }), null);
    assert.equal(RT.fromStatusEvent(null), null);
  });
});

describe('RunTrace.feedbackRecord', () => {
  it('good/bad, note режется до 300', () => {
    const r = RT.feedbackRecord('t1', 'good', 'n'.repeat(400));
    assert.equal(r.kind, 'feedback');
    assert.equal(r.traceId, 't1');
    assert.equal(r.vote, 'good');
    assert.equal(r.note.length, 300);
    assert.equal(RT.feedbackRecord('t1', 'whatever').vote, 'bad');
  });
});
