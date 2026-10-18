/**
 * benchmark-find-moments.mjs (18.10.2026)
 *
 * Точность find_moments на реальном кэше транскриптов: лексика (FindMoments.find)
 * vs эмбеддинги Cloud.ru (MomentEmbeddings, lexWeight=0) vs гибрид (как в панели).
 * Эталон — главы entry.topics: запрос = title / summary (+ опционально свои
 * запросы), попадание = начало результата внутри главы ±TOL с; top-1 и top-3.
 * Реальные вызовы /v1/embeddings; кэш транскриптов только читается.
 *
 * Запуск: node tests/integration/benchmark-find-moments.mjs
 * env: EMB_MODELS="a,b"   — модели (по умолчанию embeddingModel из fm-defaults + 480M)
 *      FM_SECRETS_FILE    — путь к fm-secrets.js (по умолчанию client/shared/fm-secrets.js)
 *      BENCH_QUERIES      — JSON { "<ключ кэша>": [{ i, short, ask }] } — свои запросы к главам
 *      TOL=15             — допуск к границам главы, с
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHARED = resolve(ROOT, 'client/shared');
const TOL = Number(process.env.TOL || 15);

const win = {};
function load(file) {
  // eslint-disable-next-line no-new-func
  new Function('window', readFileSync(file, 'utf8'))(win);
}
for (const f of ['fm-defaults.js', 'usage-meter.js', 'cloudru-client.js', 'find-moments.js', 'moment-embeddings.js']) {
  load(resolve(SHARED, f));
}
try { load(process.env.FM_SECRETS_FILE || resolve(SHARED, 'fm-secrets.js')); } catch (e) {}
if (!win.FM_SECRETS || !win.FM_SECRETS.apiKey) {
  console.error('Нет FM_SECRETS.apiKey (client/shared/fm-secrets.js или FM_SECRETS_FILE)');
  process.exit(1);
}
const { FindMoments: FM, MomentEmbeddings: ME, CloudRuClient: CC, UsageMeter: UM, FM_DEFAULTS: D } = win;
const MODELS = process.env.EMB_MODELS
  ? process.env.EMB_MODELS.split(',')
  : [D.embeddingModel, 'ai-sage/Giga-Embeddings-instruct-480M'].filter((m, i, a) => m && a.indexOf(m) === i);

/* Транскрипты с главами; копии (бэкапы секвенций) — один раз. */
const CACHE = JSON.parse(readFileSync(resolve(os.homedir(), '.extensions_llm_chat_pr/_llm_transcript_cache.json'), 'utf8'));
const extra = process.env.BENCH_QUERIES ? JSON.parse(readFileSync(process.env.BENCH_QUERIES, 'utf8')) : {};
const seen = new Set();
const sets = [];
for (const key of Object.keys(CACHE)) {
  const e = CACHE[key];
  if (!e || !Array.isArray(e.topics) || e.topics.length < 3 || !Array.isArray(e.paragraphs) || !e.paragraphs.length) continue;
  const sig = e.paragraphs.length + '|' + e.topics.map((t) => t.title).join('|');
  if (seen.has(sig)) continue;
  seen.add(sig);
  for (const q of extra[key] || []) Object.assign(e.topics[q.i] || {}, { short: q.short, ask: q.ask });
  const last = e.segments && e.segments.length ? e.segments[e.segments.length - 1].endSec : 0;
  sets.push({ key, name: e.seqName || key, entry: e, min: Math.round(last / 60) });
}
const KINDS = ['title', 'summary', 'short', 'ask'].filter((k) => sets.some((s) => s.entry.topics.some((t) => t[k])));
console.log('Транскрипты:');
for (const s of sets) console.log(`  «${s.name}» ${s.min} мин, ${s.entry.paragraphs.length} абз., ${s.entry.topics.length} глав`);

function embedder(model) {
  return (texts) => CC.embeddings({ baseUrl: D.baseUrl, apiKey: win.FM_SECRETS.apiKey, model, input: texts })
    .then((r) => r.vectors);
}
const inCh = (sec, ch) => sec >= ch.startSec - TOL && sec <= ch.endSec + TOL;

async function evaluate(rank) {
  const acc = {};
  for (const s of sets) {
    for (const ch of s.entry.topics) {
      for (const kind of KINDS) {
        if (!ch[kind]) continue;
        const top = (await rank(s.entry, ch[kind])).slice(0, 3);
        const o = acc[kind] || (acc[kind] = { n: 0, t1: 0, t3: 0 });
        o.n++;
        if (top[0] && inCh(top[0].startSec, ch)) o.t1++;
        if (top.some((m) => inCh(m.startSec, ch))) o.t3++;
      }
    }
  }
  acc.all = Object.values(acc).reduce((a, o) => ({ n: a.n + o.n, t1: a.t1 + o.t1, t3: a.t3 + o.t3 }), { n: 0, t1: 0, t3: 0 });
  return acc;
}
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0) + '%';
const rows = [];
function row(name, acc, extraCols) {
  const cells = KINDS.concat('all').map((k) => (acc[k] ? `${pct(acc[k].t1, acc[k].n)} / ${pct(acc[k].t3, acc[k].n)}` : '—'));
  rows.push(`| ${name} | ${cells.join(' | ')} | ${extraCols} |`);
  console.log(rows[rows.length - 1]);
}

const nQ = sets.reduce((a, s) => a + s.entry.topics.reduce((b, t) => b + KINDS.filter((k) => t[k]).length, 0), 0);
console.log(`\nЗапросов: ${nQ} (${KINDS.join(', ')}), допуск ±${TOL} с; ячейка = top-1 / top-3\n`);
console.log(`| Вариант | ${KINDS.concat('все').join(' | ')} | время, ₽ |`);
console.log(`|---|${KINDS.concat('все').map(() => '---').join('|')}|---|`);

let t0 = Date.now();
const lex = await evaluate((e, q) => FM.find(e, q, { k: 5 }));
row('лексика: FindMoments.find (было)', lex, `${((Date.now() - t0) / nQ).toFixed(1)} мс/запрос, 0 ₽`);

for (const model of MODELS) {
  const short = model.replace(/^.*\//, '');
  const embedTexts = embedder(model);
  ME._resetForTests();
  UM.reset();
  const idx = [];
  for (const s of sets) {
    t0 = Date.now();
    await ME.ensureParagraphVectors(s.entry, { model, embedTexts });
    idx.push(`${s.min} мин — ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  }
  const docSum = UM.getSummary();
  const lat = [];
  t0 = Date.now();
  const pure = await evaluate(async (e, q) => {
    const t = Date.now();
    const r = await ME.search(e, q, { k: 5, model, embedTexts, lexWeight: 0 });
    lat.push(Date.now() - t);
    if (r.mode !== 'semantic') throw new Error('фолбэк на лексику: ' + r.fallbackReason);
    return r.moments;
  });
  lat.sort((a, b) => a - b);
  const all = UM.getSummary();
  const qRub = (all.rubles - docSum.rubles) / nQ;
  row(`эмбеддинги ${short}`, pure,
    `векторы: ${idx.join(', ')}; ${docSum.inTokens} ток. = ${docSum.rubles.toFixed(2)} ₽; запрос ~${lat[lat.length >> 1]} мс, ${qRub.toFixed(4)} ₽`);
  const hyb = await evaluate(async (e, q) => (await ME.search(e, q, { k: 5, model, embedTexts })).moments);
  row(`гибрид ${short} + 0.1·стемы (панель)`, hyb, 'те же векторы и запросы');
}
