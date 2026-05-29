/**
 * Debug-call: raw chatCompletions для buildTopics — посмотрим что реально вернула GLM.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED = resolve(__dirname, '../../client/shared');

const ctx = {
  Array, Object, Math, String, Number, JSON, Error, RegExp, Date,
  Boolean, Promise, Symbol, Map, Set, WeakMap, WeakSet,
  setTimeout, clearTimeout, console, undefined,
  fetch, AbortController,
  module: { exports: {} },
  exports: {}
};
ctx.global = ctx; ctx.window = ctx;
vm.createContext(ctx);

['fm-defaults.js', 'fm-secrets.js', 'cloudru-client.js'].forEach(f => {
  vm.runInContext(readFileSync(resolve(SHARED, f), 'utf8'), ctx, { filename: f });
});

const cache = JSON.parse(readFileSync(join(homedir(), '.extensions_llm_chat_pr', '_llm_transcript_cache.json'), 'utf8'));
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

const sysMsg =
  'Ты — монтажёр, размечающий видеоролик по смысловым главам. ' +
  'На входе — абзацы расшифровки с таймкодами (секунды на таймлайне). ' +
  'Сгруппируй их в 3–12 глав по смене темы. ' +
  'Возвращай СТРОГО JSON {"topics":[{"startSec":N,"endSec":N,"title":"…","summary":"одно предложение"}]}. ' +
  'startSec первой главы = startSec первого абзаца; endSec последней = endSec последнего. ' +
  'Главы без дыр: endSec текущей = startSec следующей. Между главами не меньше 20 сек. Без markdown, только JSON.';

console.log('=== Sending raw call to GLM-4.7 ===');
console.log('paragraphs total:', paragraphs.length, '— первый t0=' + paragraphs[0].startSec + ', последний t1=' + paragraphs[paragraphs.length - 1].endSec);

const t0 = Date.now();
const resp = await ctx.CloudRuClient.chatCompletions({
  baseUrl: ctx.FM_DEFAULTS.baseUrl,
  apiKey: ctx.FM_SECRETS.apiKey,
  model: 'zai-org/GLM-4.7',
  messages: [
    { role: 'system', content: sysMsg },
    { role: 'user', content: JSON.stringify({ paragraphs: compact }) }
  ],
  chatParams: { max_tokens: 4000, temperature: 0.2 },
  responseFormat: 'json_object',
  enableThinking: true
});
const dt = Date.now() - t0;

console.log('\n=== RAW RESPONSE (' + dt + 'ms) ===');
const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
console.log('finish_reason:', resp.choices[0].finish_reason);
console.log('usage:', JSON.stringify(resp.usage || {}));
console.log('reasoning_content (thinking):', msg.reasoning_content ? msg.reasoning_content.slice(0, 500) + '...' : 'none');
console.log('\n--- content ---');
console.log(msg.content || '(empty)');
console.log('--- end content ---');

console.log('\n=== Parse attempt ===');
try {
  const m = String(msg.content || '').match(/\{[\s\S]*\}/);
  if (!m) { console.log('No JSON match'); }
  else {
    const j = JSON.parse(m[0]);
    console.log('Parsed keys:', Object.keys(j));
    console.log('topics array:', j.topics?.length, 'items');
    if (j.topics?.length) console.log('First topic:', JSON.stringify(j.topics[0]));
  }
} catch (e) { console.log('Parse error:', e.message); }
