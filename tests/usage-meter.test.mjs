import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadUsageMeter } from './load-usage-meter.mjs';

const EPS = 1e-6;

test('recordChat GLM-5.1: 1M in + 1M out → 198.86 + 829.60 = 1028.46 ₽', () => {
  const m = loadUsageMeter();
  m.recordChat('zai-org/GLM-5.1', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  const s = m.getSummary();
  assert.equal(s.inTokens, 1_000_000);
  assert.equal(s.outTokens, 1_000_000);
  assert.equal(s.totalTokens, 2_000_000);
  assert.ok(Math.abs(s.rubles - 1028.46) < EPS, `rubles=${s.rubles}`);
});

test('recordChat DeepSeek-V4-Pro: 1M in + 1M out → 183 + 732 = 915 ₽', () => {
  const m = loadUsageMeter();
  m.recordChat('deepseek-ai/DeepSeek-V4-Pro', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  const s = m.getSummary();
  assert.ok(Math.abs(s.rubles - 915) < EPS, `rubles=${s.rubles}`);
});

test('unknown model → 0 ₽, tokens still accumulate', () => {
  const m = loadUsageMeter();
  m.recordChat('foo/bar', { prompt_tokens: 1000, completion_tokens: 500 });
  const s = m.getSummary();
  assert.equal(s.inTokens, 1000);
  assert.equal(s.outTokens, 500);
  assert.equal(s.totalTokens, 1500);
  assert.equal(s.rubles, 0);
});

test('recordWhisper(120) → rubles += 1.20', () => {
  const m = loadUsageMeter();
  m.recordWhisper(120);
  const s = m.getSummary();
  assert.equal(s.whisperSec, 120);
  assert.ok(Math.abs(s.rubles - 1.20) < EPS, `rubles=${s.rubles}`);
});

test('accumulation across multiple calls → correct totals', () => {
  const m = loadUsageMeter();
  m.recordChat('zai-org/GLM-5.1', { prompt_tokens: 1_000_000, completion_tokens: 0 });      // 198.86
  m.recordChat('deepseek-ai/DeepSeek-V4-Pro', { prompt_tokens: 0, completion_tokens: 1_000_000 }); // 732
  m.recordWhisper(60);                                                                        // 0.60
  const s = m.getSummary();
  assert.equal(s.inTokens, 1_000_000);
  assert.equal(s.outTokens, 1_000_000);
  assert.equal(s.totalTokens, 2_000_000);
  assert.equal(s.whisperSec, 60);
  assert.ok(Math.abs(s.rubles - (198.86 + 732 + 0.60)) < EPS, `rubles=${s.rubles}`);
});

test('missing/broken usage → no throw, counters unchanged', () => {
  const m = loadUsageMeter();
  m.recordChat('zai-org/GLM-5.1', undefined);
  m.recordChat('zai-org/GLM-5.1', null);
  m.recordChat('zai-org/GLM-5.1', {});
  m.recordChat('zai-org/GLM-5.1', { prompt_tokens: 'x', completion_tokens: 5 });
  m.recordChat('zai-org/GLM-5.1', { prompt_tokens: 5, completion_tokens: NaN });
  m.recordWhisper(undefined);
  m.recordWhisper(0);
  m.recordWhisper(-10);
  const s = m.getSummary();
  assert.equal(s.inTokens, 0);
  assert.equal(s.outTokens, 0);
  assert.equal(s.whisperSec, 0);
  assert.equal(s.rubles, 0);
});

test('missing pricing → rates 0 but tokens still accumulate', () => {
  const m = loadUsageMeter({}); // no .pricing
  m.recordChat('zai-org/GLM-5.1', { prompt_tokens: 1000, completion_tokens: 500 });
  m.recordWhisper(30);
  const s = m.getSummary();
  assert.equal(s.inTokens, 1000);
  assert.equal(s.outTokens, 500);
  assert.equal(s.whisperSec, 30);
  assert.equal(s.rubles, 0);
});

test('onChange fires on record; reset() zeroes everything', () => {
  const m = loadUsageMeter();
  const seen = [];
  m.onChange((s) => seen.push(s));

  m.recordChat('zai-org/GLM-5.1', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  assert.equal(seen.length, 1);
  assert.ok(Math.abs(seen[0].rubles - 1028.46) < EPS);

  m.recordWhisper(120);
  assert.equal(seen.length, 2);

  m.reset();
  assert.equal(seen.length, 3);
  const last = seen[seen.length - 1];
  assert.equal(last.inTokens, 0);
  assert.equal(last.outTokens, 0);
  assert.equal(last.totalTokens, 0);
  assert.equal(last.whisperSec, 0);
  assert.equal(last.rubles, 0);

  const s = m.getSummary();
  assert.equal(s.totalTokens, 0);
  assert.equal(s.rubles, 0);
});

test('one bad onChange callback does not break others', () => {
  const m = loadUsageMeter();
  let goodFired = false;
  m.onChange(() => { throw new Error('boom'); });
  m.onChange(() => { goodFired = true; });
  m.recordWhisper(10);
  assert.equal(goodFired, true);
});
