/**
 * Debug buildTopics на 297-параграфном подкасте.
 * Цель: понять почему на production вернулся 0 topics — обрезка JSON, finish_reason=length, или иное.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED = resolve(__dirname, '../../client/shared');

const ctx = {
  Array, Object, Math, String, Number, JSON, Error, RegExp, Date,
  Boolean, Promise, Symbol, Map, Set, WeakMap, WeakSet,
  setTimeout, clearTimeout, console, undefined,
  fetch, AbortController,
  module: { exports: {} }, exports: {}
};
ctx.global = ctx; ctx.window = ctx;
vm.createContext(ctx);
['fm-defaults.js', 'fm-secrets.js', 'cloudru-client.js'].forEach(f => {
  vm.runInContext(readFileSync(resolve(SHARED, f), 'utf8'), ctx, { filename: f });
});

const cache = JSON.parse(readFileSync('/Users/gmmelnikov/.extensions_llm_chat_pr/_llm_transcript_cache.json', 'utf8'));
const entry = cache[Object.keys(cache)[0]];
const paragraphs = entry.paragraphs.map(p => ({
  startSec: p.startSec || p.start, endSec: p.endSec || p.end, text: p.text || ''
}));

const compact = paragraphs.map((p, idx) => {
  const words = String(p.text).split(/\s+/).slice(0, 40).join(' ');
  return {
    i: idx, t0: p.startSec, t1: p.endSec,
    text: words + (p.text.split(/\s+/).length > 40 ? '…' : '')
  };
});

const userMsg = JSON.stringify({ paragraphs: compact });
console.log('=== Input size ===');
console.log('paragraphs:', paragraphs.length);
console.log('compact userMsg chars:', userMsg.length, '(~', Math.round(userMsg.length / 3.5), 'tokens)');
console.log('first paragraph t0:', paragraphs[0].startSec, 'last t1:', paragraphs[paragraphs.length - 1].endSec);

const sysMsg =
  'Ты — монтажёр, размечающий видеоролик по смысловым главам. ' +
  'На входе — абзацы расшифровки с таймкодами (секунды на таймлайне). ' +
  'Сгруппируй их в 3–12 глав по СМЕНЕ ТЕМЫ. ' +
  'КАЖДАЯ ГЛАВА ДОЛЖНА ИМЕТЬ УНИКАЛЬНОЕ НАЗВАНИЕ — не повторяй одно и то же. ' +
  'Если несколько абзацев подряд про одно и то же — объедини их в ОДНУ главу. ' +
  'Если весь ролик на одну тему (короткое выступление, одна мысль) — верни 1-3 главы, не растягивай. ' +
  'Названия глав: 3-6 слов, отражают СУТЬ блока, на русском. Без слов «Часть N», «Продолжение», «Раздел N». ' +
  'Возвращай СТРОГО JSON {"topics":[{"startSec":N,"endSec":N,"title":"…","summary":"одно предложение"}]}. ' +
  'startSec первой главы = startSec первого абзаца; endSec последней = endSec последнего. ' +
  'Главы без дыр: endSec текущей = startSec следующей. Между главами не меньше 20 сек. Без markdown, только JSON.';

console.log('\n=== Calling GLM-4.7 with thinking ON, max_tokens=8000 ===');
const t0 = Date.now();
const resp = await ctx.CloudRuClient.chatCompletions({
  baseUrl: ctx.FM_DEFAULTS.baseUrl,
  apiKey: ctx.FM_SECRETS.apiKey,
  model: 'zai-org/GLM-4.7',
  messages: [
    { role: 'system', content: sysMsg },
    { role: 'user', content: userMsg }
  ],
  chatParams: { max_tokens: 8000, temperature: 0.2 },
  responseFormat: 'json_object',
  enableThinking: true
});
const dt = Date.now() - t0;

const choice = resp.choices && resp.choices[0];
const msg = choice && choice.message;
console.log('\n=== RAW RESPONSE (' + dt + 'ms) ===');
console.log('finish_reason:', choice && choice.finish_reason);
console.log('usage:', JSON.stringify(resp.usage || {}));
console.log('reasoning_content len:', (msg && msg.reasoning_content || '').length);
console.log('content len:', (msg && msg.content || '').length);
console.log('\n--- content first 800 chars ---');
console.log((msg && msg.content || '').slice(0, 800));
console.log('\n--- content last 400 chars ---');
console.log((msg && msg.content || '').slice(-400));

console.log('\n=== Parse attempt ===');
const content = (msg && msg.content) || '';
const m = content.match(/\{[\s\S]*\}/);
if (!m) { console.log('No JSON match'); }
else {
  try {
    const j = JSON.parse(m[0]);
    console.log('Parsed keys:', Object.keys(j));
    console.log('topics array len:', j.topics?.length);
    if (j.topics?.length) {
      console.log('First topic:', JSON.stringify(j.topics[0]));
      console.log('Last topic:', JSON.stringify(j.topics[j.topics.length - 1]));
    }
  } catch (e) {
    console.log('Parse error:', e.message);
    console.log('Trying to find where JSON is malformed...');
    const start = content.indexOf('{');
    const sample = content.slice(start, start + 500);
    console.log('Start of JSON:', sample);
  }
}
