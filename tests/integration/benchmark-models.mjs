/**
 * benchmark-models.mjs (18 июня 2026)
 *
 * Сравнение LLM Cloud.ru на реальных сценариях монтажа (реальные вызовы API).
 * Использует реальный кэш транскрипта (~/.extensions_llm_chat_pr/_llm_transcript_cache.json).
 *
 * Сценарии (репрезентативные для плагина):
 *   S1 fillers   — «убери паразиты»     → ждём propose_transcript_cuts(removeIntervals)
 *   S2 target    — «нарезка 60 сек»      → ждём propose_transcript_cuts(keepIntervals + targetDurationSec)
 *   S3 markers   — «4 маркера тем»        → ждём propose_markers(3..7, в диапазоне)
 *   S4 find      — «найди про детство»    → ждём find_moments + текстовый ответ
 *   S5 info      — «сколько длится?»       → ждём текстовый ответ с длительностью
 *
 * Метрики на модель: passed/N, средняя латентность, суммарные токены, заметки.
 * Запуск: node tests/integration/benchmark-models.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SHARED = resolve(ROOT, 'client/shared');

const ctx = {
  Array, Object, Math, String, Number, JSON, Error, RegExp, Date,
  Boolean, Promise, Symbol, Map, Set, WeakMap, WeakSet,
  setTimeout, clearTimeout, setInterval, clearInterval, console, undefined,
  fetch, AbortController, module: { exports: {} }, exports: {}
};
ctx.global = ctx; ctx.window = ctx; ctx.self = ctx;
ctx.localStorage = { _s: {}, getItem(k){return this._s[k]||null;}, setItem(k,v){this._s[k]=v;}, removeItem(k){delete this._s[k];} };
vm.createContext(ctx);
for (const f of ['fm-defaults.js','fm-secrets.js','cloudru-client.js','analysis-routing.js','find-moments.js','transcript-structure.js']) {
  try { vm.runInContext(readFileSync(resolve(SHARED, f), 'utf8'), ctx, { filename: f }); }
  catch (e) { if (f === 'fm-secrets.js') { console.error('fm-secrets.js не загружен'); } else throw e; }
}
if (!ctx.FM_SECRETS || !ctx.FM_SECRETS.apiKey) { console.error('Нет apiKey'); process.exit(1); }

const CC = ctx.CloudRuClient;
const BASEURL = ctx.FM_DEFAULTS.baseUrl;
const APIKEY = ctx.FM_SECRETS.apiKey;

const CACHE = JSON.parse(readFileSync(resolve(os.homedir(), '.extensions_llm_chat_pr/_llm_transcript_cache.json'), 'utf8'));
const cacheKey = Object.keys(CACHE)[0];
const entry = CACHE[cacheKey];
const segs0 = entry.segments;
const minSec = segs0[0].startSec, maxSec = segs0[segs0.length - 1].endSec;
const totalDur = maxSec;
console.log(`Кэш: "${cacheKey}" segments=${segs0.length} paragraphs=${entry.paragraphs.length} диапазон=${minSec}–${maxSec.toFixed(1)}с\n`);

const MODELS = process.env.MODELS ? process.env.MODELS.split(',') : [
  'zai-org/GLM-5.1',
  'deepseek-ai/DeepSeek-V4-Pro',
  'moonshotai/Kimi-K2.6',
  'openai/gpt-oss-120b',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  'zai-org/GLM-4.6'
];

const TOOLS = [
  { type:'function', function:{ name:'get_timeline_snapshot', description:'Снимок таймлайна: sequenceName, sequenceEndSec, clips.', parameters:{type:'object',properties:{},required:[]} } },
  { type:'function', function:{ name:'get_transcript_structure', description:'Абзацы транскрипта startSec/endSec/text.', parameters:{type:'object',properties:{sequenceKey:{type:'string'}},required:['sequenceKey']} } },
  { type:'function', function:{ name:'find_moments', description:'Семантический поиск по транскрипту.', parameters:{type:'object',properties:{sequenceKey:{type:'string'},query:{type:'string'},k:{type:'number'}},required:['sequenceKey','query']} } },
  { type:'function', function:{ name:'analyze_transcript_for_cuts', description:'Детекторы меток сегментов (filler/outtake/repeat/...).', parameters:{type:'object',properties:{sequenceKey:{type:'string'},tasks:{type:'array',items:{type:'string'}},aggressiveness:{type:'string'}},required:['sequenceKey']} } },
  { type:'function', function:{ name:'propose_transcript_cuts', description:'План вырезок: keepIntervals ИЛИ removeIntervals (+targetDurationSec).', parameters:{type:'object',properties:{sequenceKey:{type:'string'},keepIntervals:{type:'array'},removeIntervals:{type:'array'},targetDurationSec:{type:'number'},paddingSec:{type:'number'},summary:{type:'string'}},required:['summary']} } },
  { type:'function', function:{ name:'propose_markers', description:'Маркеры (chapter/comment): [{timeSec,name,type}].', parameters:{type:'object',properties:{markers:{type:'array'},summary:{type:'string'}},required:['markers','summary']} } }
];

function paras() {
  return entry.paragraphs.map((p,i)=>({ i, startSec:p.startSec, endSec:p.endSec, durationSec:Math.round((p.endSec-p.startSec)*100)/100, text:p.text||'' }));
}
function execTool(name, args) {
  if (name==='get_timeline_snapshot') return { ok:true, sequenceName:cacheKey, sequenceEndSec:totalDur, inPointSec:minSec, outPointSec:maxSec, clips:[{startSec:minSec,endSec:maxSec}] };
  if (name==='get_transcript_structure') return { ok:true, sequenceKey:cacheKey, totalParagraphs:entry.paragraphs.length, paragraphCount:entry.paragraphs.length, paragraphs:paras(), hasMore:false };
  if (name==='find_moments') { const m=ctx.FindMoments.find(entry,args.query,{k:args.k||8}); return { ok:true, query:args.query, count:m.length, moments:m.map(x=>({startSec:x.startSec,endSec:x.endSec,quote:String(x.text||'').slice(0,160),source:x.source})) }; }
  if (name==='analyze_transcript_for_cuts') {
    const segs=segs0.map((s,i)=>({i,startSec:s.startSec,endSec:s.endSec,text:s.text||''}));
    const res=ctx.TranscriptStructure.runLocalDetectors(segs);
    const toRemove=res.labels.filter(lb=>ctx.AnalysisRouting.shouldRemoveLabel(lb.label,args.aggressiveness||'normal')).map(lb=>({startSec:segs[lb.i].startSec,endSec:segs[lb.i].endSec,label:lb.label,reason:lb.reason||lb.label}));
    return { ok:true, sequenceKey:cacheKey, totalSegments:segs.length, toRemove, toRemoveCount:toRemove.length };
  }
  if (name==='propose_transcript_cuts') {
    const hasKeep=Array.isArray(args.keepIntervals)&&args.keepIntervals.length;
    const hasRemove=Array.isArray(args.removeIntervals)&&args.removeIntervals.length;
    if (!hasKeep&&!hasRemove) return { validationError:'Нужен keepIntervals или removeIntervals' };
    if (hasKeep&&hasRemove) return { validationError:'Только что-то одно' };
    if (hasKeep&&typeof args.targetDurationSec==='number'){ const d=ctx.AnalysisRouting.validateKeepDuration(args.keepIntervals,args.targetDurationSec); if(d.error) return {validationError:d.error}; }
    return { ok:true, status:'waiting_user_confirmation', _validated:true, _kind:'transcript_cuts', _keep:args.keepIntervals||null, _remove:args.removeIntervals||null, _target:args.targetDurationSec||null };
  }
  if (name==='propose_markers') return { ok:true, status:'waiting_user_confirmation', _validated:true, _kind:'markers', _markers:args.markers||[] };
  return { error:'Unknown tool '+name };
}

const SYSTEM = [
  'Ты — AI-ассистент монтажа видео в Adobe Premiere Pro. Отвечай кратко по-русски.',
  'Инструменты: get_timeline_snapshot, get_transcript_structure, find_moments, analyze_transcript_for_cuts, propose_transcript_cuts, propose_markers.',
  'Для «убери паразиты» → analyze_transcript_for_cuts, затем propose_transcript_cuts с removeIntervals.',
  'Для «собери нарезку на N секунд» → propose_transcript_cuts с keepIntervals и targetDurationSec=N.',
  'Для «маркеры/главы» → propose_markers. Все propose_* показывают карточку — apply_* не вызывай.',
  'sequenceKey="'+cacheKey+'". Делай нужные tool-вызовы и заверши одним propose_* (или текстом для поиска/инфо).'
].join('\n');

async function runAgent(model, userPrompt, maxTurns=8) {
  const messages=[{role:'system',content:SYSTEM},{role:'user',content:userPrompt}];
  const trace=[]; let proposal=null; let tokens=0; let lastContent='';
  for (let turn=1; turn<=maxTurns; turn++) {
    let resp;
    try {
      resp=await CC.chatCompletions({ baseUrl:BASEURL, apiKey:APIKEY, model, messages, tools:TOOLS, toolChoice:'auto', params:{temperature:0.1,max_tokens:2200}, enableThinking:false });
    } catch(e){ return { error:'API: '+(e.message||e), trace, tokens, proposal, lastContent }; }
    if (resp && resp.usage && resp.usage.total_tokens) tokens+=resp.usage.total_tokens;
    const ch=resp.choices&&resp.choices[0]; if(!ch) return { error:'no choice', trace, tokens, proposal, lastContent };
    const msg=ch.message||{}; lastContent=msg.content||lastContent;
    messages.push({role:'assistant',content:msg.content||'',tool_calls:msg.tool_calls});
    if (!msg.tool_calls||!msg.tool_calls.length) return { ok:true, trace, tokens, proposal, lastContent:msg.content||'', turns:turn };
    for (const tc of msg.tool_calls){ const nm=tc.function&&tc.function.name; let a={}; try{a=JSON.parse(tc.function.arguments||'{}');}catch(e){} const r=execTool(nm,a); trace.push({tool:nm,args:a,res:r}); if(r._validated)proposal={...r}; messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(r)}); }
    if (proposal && turn>=2) break;
  }
  return { ok:true, trace, tokens, proposal, lastContent, turns:maxTurns };
}

function sumIv(iv){ return (iv||[]).reduce((a,x)=>a+(Math.max(0,(x.endSec||x.end||0)-(x.startSec||x.start||0))),0); }

const SCENARIOS = [
  { id:'S1-fillers', prompt:'Почисти речь: убери слова-паразиты и оговорки',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts'||!r.proposal._remove||!r.proposal._remove.length) return {pass:false,note:'нет removeIntervals'}; const bad=r.proposal._remove.some(iv=>((iv.endSec||iv.end)-(iv.startSec||iv.start))>30); return {pass:!bad,note:(bad?'есть кусок>30с; ':'')+'remove='+r.proposal._remove.length}; } },
  { id:'S2-target', prompt:'Собери короткую нарезку на 60 секунд из самых важных моментов',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts'||!r.proposal._keep||!r.proposal._keep.length) return {pass:false,note:'нет keepIntervals'}; const s=sumIv(r.proposal._keep); const okT=r.proposal._target!=null; const okS=s>=30&&s<=90; return {pass:okT&&okS,note:'keepSum='+s.toFixed(0)+'с target='+r.proposal._target}; } },
  { id:'S3-markers', prompt:'Поставь 4 маркера на основные темы',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='markers') return {pass:false,note:'нет markers'}; const m=r.proposal._markers||[]; const cnt=m.length; const inRange=m.every(x=>{const t=x.timeSec!=null?x.timeSec:x.time; return t>=minSec-2&&t<=maxSec+2;}); return {pass:cnt>=3&&cnt<=7&&inRange,note:'cnt='+cnt+(inRange?'':' вне диапазона')}; } },
  { id:'S4-find', prompt:'Найди момент, где говорят про детство и увлечение автомобилями',
    score:(r)=>{ const called=r.trace.some(t=>t.tool==='find_moments'); const ans=(r.lastContent||'').length>10; return {pass:called&&ans,note:(called?'find_moments✓':'без find_moments')+(ans?' +ответ':' нет ответа')}; } },
  { id:'S5-info', prompt:'Сколько примерно длится материал на таймлайне?',
    score:(r)=>{ const c=r.lastContent||''; const hasNum=/\d/.test(c); return {pass:hasNum&&c.length>8,note:c.slice(0,50).replace(/\n/g,' ')}; } }
];

const HARD = [
  { id:'H1-multi', prompt:'Убери паразиты и уложи всё в 2 минуты',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts') return {pass:false,note:'нет transcript_cuts'}; const keep=r.proposal._keep, rem=r.proposal._remove; const s=keep?sumIv(keep):(rem?(maxSec-minSec-sumIv(rem)):0); const okT=r.proposal._target!=null; return {pass:okT&&s<=150&&s>=60,note:'итог≈'+s.toFixed(0)+'с target='+r.proposal._target}; } },
  { id:'H2-theme', prompt:'Собери нарезку только про детство, автоспорт и старт проекта',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts'||!r.proposal._keep) return {pass:false,note:'нет keepIntervals'}; const k=r.proposal._keep; const inEarly=k.every(iv=>(iv.startSec||iv.start)<320); return {pass:k.length>=1&&inEarly,note:'keep='+k.length+(inEarly?' (ранние темы✓)':' (захватил поздние)')}; } },
  { id:'H3-ambig', prompt:'Сделай покороче, оставь только самое главное',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts') return {pass:false,note:'нет плана (амбигуитет не разрешён)'}; const keep=r.proposal._keep,rem=r.proposal._remove; return {pass:!!(keep&&keep.length)||!!(rem&&rem.length),note:keep?('keep='+keep.length):('remove='+(rem?rem.length:0))}; } },
  { id:'H4-negation', prompt:'Убери всё, кроме рассказа про сам проект и компанию',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts') return {pass:false,note:'нет плана'}; const keep=r.proposal._keep,rem=r.proposal._remove; return {pass:!!(keep&&keep.length)||!!(rem&&rem.length),note:(keep?'keep='+keep.length:'remove='+(rem?rem.length:0))+' (негация)'}; } },
  { id:'H5-twostep', prompt:'Найди где говорят про Tesla и поставь там маркер-хайлайт',
    score:(r)=>{ const found=r.trace.some(t=>t.tool==='find_moments'); const mk=r.proposal&&r.proposal._kind==='markers'; return {pass:found&&mk,note:(found?'find✓':'без find')+' '+(mk?'+маркер':'без маркера')}; } }
];

const SET = process.env.HARD ? HARD : SCENARIOS;
const SETNAME = process.env.HARD ? 'СЛОЖНЫЕ' : 'базовые';
console.log('Набор сценариев: '+SETNAME+' ('+SET.length+')');

const results = {};
for (const model of MODELS) {
  console.log('\n████ '+model+' ████');
  results[model]={pass:0,total:SET.length,lat:[],tokens:0,errors:0,details:[]};
  for (const sc of SET) {
    const t0=Date.now();
    const r=await runAgent(model, sc.prompt);
    const dt=(Date.now()-t0)/1000;
    if (r.error){ results[model].errors++; results[model].details.push(sc.id+': ERR '+r.error.slice(0,60)); console.log(`  ${sc.id}: ⚠ ERR ${r.error.slice(0,70)} (${dt.toFixed(1)}s)`); continue; }
    const sres=sc.score(r); results[model].lat.push(dt); results[model].tokens+=r.tokens||0;
    if (sres.pass) results[model].pass++;
    results[model].details.push(sc.id+': '+(sres.pass?'✓':'✗')+' '+sres.note);
    console.log(`  ${sc.id}: ${sres.pass?'✓':'✗'} ${sres.note} | ${dt.toFixed(1)}s, ${r.tokens||0}tok, turns=${r.turns||'?'}`);
  }
}

console.log('\n\n═══════════ СВОДНАЯ ТАБЛИЦА ═══════════');
console.log('| Модель | Прошло | Ср.латентность | Σток | Ошибки |');
console.log('|--------|--------|----------------|------|--------|');
for (const m of MODELS) {
  const r=results[m]; const avg=r.lat.length?(r.lat.reduce((a,b)=>a+b,0)/r.lat.length):0;
  console.log(`| ${m} | ${r.pass}/${r.total} | ${avg.toFixed(1)}s | ${r.tokens} | ${r.errors} |`);
}
console.log('\nДетали:');
for (const m of MODELS){ console.log('\n'+m+':'); results[m].details.forEach(d=>console.log('  '+d)); }
