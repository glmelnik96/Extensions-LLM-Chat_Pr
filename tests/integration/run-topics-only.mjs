/* Quick: только buildTopics на production-кеше — после max_tokens fix. */
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
['fm-defaults.js', 'fm-secrets.js', 'cloudru-client.js',
 'analysis-routing.js', 'context-store.js', 'transcript-structure.js'].forEach(f => {
  vm.runInContext(readFileSync(resolve(SHARED, f), 'utf8'), ctx, { filename: f });
});

const cache = JSON.parse(readFileSync('/Users/gmmelnikov/.extensions_llm_chat_pr/_llm_transcript_cache.json', 'utf8'));
const entry = cache[Object.keys(cache)[0]];
const paragraphs = entry.paragraphs.map(p => ({
  startSec: p.startSec || p.start, endSec: p.endSec || p.end, text: p.text || ''
}));

console.log('Paragraphs:', paragraphs.length);
console.log('Last endSec:', paragraphs[paragraphs.length - 1].endSec);

const settings = {
  baseUrl: ctx.FM_DEFAULTS.baseUrl,
  apiKey: ctx.FM_SECRETS.apiKey,
  chatModel: 'zai-org/GLM-4.7',
  analysisModel: 'zai-org/GLM-4.7',
  chapterModel: 'zai-org/GLM-4.7',
  thinkingPolicy: { analyze: false, chapter: true, chat: true, report: true },
  enableThinking: true
};

console.log('\n=== buildTopicsWithLLM ===');
const t0 = Date.now();
const topics = await ctx.TranscriptStructure.buildTopicsWithLLM(paragraphs, {
  settings, CloudRuClient: ctx.CloudRuClient
});
const dt = (Date.now() - t0) / 1000;
console.log('Время:', dt.toFixed(1), 'с');
console.log('Topics:', topics.length);
topics.forEach((t, i) => {
  const dur = t.endSec - t.startSec;
  console.log(`  [${i + 1}] ${(t.startSec / 60).toFixed(1)}–${(t.endSec / 60).toFixed(1)}мин (${dur.toFixed(0)}с) | ${t.title}`);
  if (t.summary) console.log(`      └─ ${t.summary.slice(0, 100)}`);
});
