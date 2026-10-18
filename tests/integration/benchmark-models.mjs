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
 *   S5 info      — «сколько длится?»       → ждём текстовый ответ с длительностью (±2%)
 *
 * Если у entry есть topics (главы), темы для S4/H2/H5 берутся из них, и
 * H2/H5 проверяются по диапазонам глав — иначе промпты июньского транскрипта.
 *
 * Метрики на модель: passed/N, средняя латентность, токены вход/выход, стоимость
 * по FM_DEFAULTS.pricing, заметки.
 * Запуск: node tests/integration/benchmark-models.mjs
 * env: MODELS="a,b" — подмножество моделей; HARD=1 — сложный набор;
 *      THINKING=1 — enable_thinking=true, как thinkingPolicy.chat в панели;
 *      CACHE_KEY — ключ кэша (по умолчанию первый);
 *      BENCH_ENTRY=tmp/entry-mc20-mix.json — entry из файла, если кэш панели стёрт.
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

/* Транскрипт: entry из файла (BENCH_ENTRY) либо из кэша панели. */
let cacheKey, entry;
if (process.env.BENCH_ENTRY) {
  entry = JSON.parse(readFileSync(resolve(ROOT, process.env.BENCH_ENTRY), 'utf8'));
  cacheKey = entry.seqName || entry.seqId || 'bench';
} else {
  let CACHE = {};
  try { CACHE = JSON.parse(readFileSync(resolve(os.homedir(), '.extensions_llm_chat_pr/_llm_transcript_cache.json'), 'utf8')); } catch (e) {}
  cacheKey = process.env.CACHE_KEY || Object.keys(CACHE)[0];
  entry = CACHE[cacheKey];
}
if (!entry || !entry.segments || !entry.segments.length) {
  console.error('Нет транскрипта: кэш панели пуст — задайте BENCH_ENTRY=tmp/entry-mc20-mix.json'); process.exit(1);
}
if (!entry.paragraphs || !entry.paragraphs.length) ctx.TranscriptStructure.buildStructure(entry);
const segs0 = entry.segments;
const minSec = segs0[0].startSec, maxSec = segs0[segs0.length - 1].endSec;
const totalDur = maxSec;
console.log(`Кэш: "${cacheKey}" segments=${segs0.length} paragraphs=${entry.paragraphs.length} диапазон=${minSec}–${maxSec.toFixed(1)}с\n`);

/* Модели, доступные проекту ключа (живая проба 18.10.2026). */
const MODELS = process.env.MODELS ? process.env.MODELS.split(',') : [
  'zai-org/GLM-4.7',
  'ai-sage/GigaChat3.5-432B-A28B-Reasoning',
  'MiniMaxAI/MiniMax-M2.5'
];
const THINKING = process.env.THINKING === '1';

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

/* Параметры как у агента панели (chatParams: max_tokens 16000, temperature 0.1).
   Раньше здесь были params/toolChoice — клиент таких полей не знает и молча их терял. */
const CHAT_PARAMS = ctx.FM_DEFAULTS.chatParams || {};

async function runAgent(model, userPrompt, maxTurns=8) {
  const messages=[{role:'system',content:SYSTEM},{role:'user',content:userPrompt}];
  const trace=[]; let proposal=null; let tokens=0; let lastContent='';
  const usage={pt:0,ct:0};
  for (let turn=1; turn<=maxTurns; turn++) {
    let resp;
    try {
      resp=await CC.chatCompletions({ baseUrl:BASEURL, apiKey:APIKEY, model, messages, tools:TOOLS, chatParams:CHAT_PARAMS, enableThinking:THINKING });
    } catch(e){ return { error:'API: '+(e.message||e), trace, tokens, usage, proposal, lastContent }; }
    if (resp && resp.usage) {
      usage.pt+=resp.usage.prompt_tokens||0; usage.ct+=resp.usage.completion_tokens||0;
      if (resp.usage.total_tokens) tokens+=resp.usage.total_tokens;
    }
    const ch=resp.choices&&resp.choices[0]; if(!ch) return { error:'no choice', trace, tokens, usage, proposal, lastContent };
    const msg=ch.message||{}; lastContent=msg.content||lastContent;
    messages.push({role:'assistant',content:msg.content||'',tool_calls:msg.tool_calls});
    if (!msg.tool_calls||!msg.tool_calls.length) return { ok:true, trace, tokens, usage, proposal, lastContent:msg.content||'', turns:turn };
    for (const tc of msg.tool_calls){ const nm=tc.function&&tc.function.name; let a={}; try{a=JSON.parse(tc.function.arguments||'{}');}catch(e){} const r=execTool(nm,a); trace.push({tool:nm,args:a,res:r}); if(r._validated)proposal={...r}; messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(r)}); }
    if (proposal && turn>=2) break;
  }
  return { ok:true, trace, tokens, usage, proposal, lastContent, turns:maxTurns };
}

/* ₽ по тарифу FM_DEFAULTS.pricing (модель вне карты → 0). */
function costRub(model, pt, ct) {
  const p=(ctx.FM_DEFAULTS.pricing&&ctx.FM_DEFAULTS.pricing.models||{})[model];
  return p ? (pt*p.inPerM+ct*p.outPerM)/1e6 : 0;
}

/* Длительность в ответе: секунды, минуты («20 минут», «20,8 мин») или м:сс / ч:мм:сс.
   true, если хоть одно прочтение попадает в ±5% (не меньше 30с) от dur: «около
   20 минут» при 20:46 — честный ответ, а 363с вместо 484с (июньский gpt-oss) — нет.
   Без \b: в JS он не видит границ кириллических слов. */
function mentionsDuration(text, dur) {
  const tol=Math.max(30, dur*0.05); const cands=[];
  const t=String(text||'').toLowerCase().replace(/(\d),(\d)/g,'$1.$2');
  for (const m of t.matchAll(/(\d+):(\d{2})(?::(\d{2}))?/g)) cands.push(m[3]!=null ? (+m[1])*3600+(+m[2])*60+(+m[3]) : (+m[1])*60+(+m[2]));
  for (const m of t.matchAll(/(\d+)\s*мин[а-яё]*\s*(\d+)\s*с/g)) cands.push((+m[1])*60+(+m[2]));
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(час|ч(?![а-яё])|мин|м(?![а-яё])|сек|с(?![а-яё]))?/g)) {
    const n=+m[1], u=m[2]||'';
    if (u.charAt(0)==='ч') cands.push(n*3600); else if (u.charAt(0)==='м') cands.push(n*60); else if (u) cands.push(n); else cands.push(n, n*60);
  }
  return cands.some(c=>Math.abs(c-dur)<=tol);
}

function sumIv(iv){ return (iv||[]).reduce((a,x)=>a+(Math.max(0,(x.endSec||x.end||0)-(x.startSec||x.start||0))),0); }

/* Темы из глав entry: S4/H2/H5 спрашивают о том, что в этом транскрипте реально
   обсуждают, а H2/H5 сверяются с диапазонами глав. Без глав — июньские промпты. */
const TOPICS=(entry.topics||[]).filter(t=>t&&t.title&&typeof t.startSec==='number'&&typeof t.endSec==='number');
const HAS_TOPICS=TOPICS.length>=4;
const pickT=(i)=>TOPICS[Math.min(i,TOPICS.length-1)];
const T_FIND=HAS_TOPICS?pickT(4):null, T_THEME=HAS_TOPICS?[pickT(0),pickT(3)]:null, T_MARK=HAS_TOPICS?pickT(5):null;
function ivStart(iv){ return iv.startSec!=null?iv.startSec:iv.start; }
function ivEnd(iv){ return iv.endSec!=null?iv.endSec:iv.end; }
/* Доля длительности keep-интервалов внутри глав (с запасом pad секунд). */
function shareInTopics(keep, topics, pad){
  let tot=0, inside=0;
  for (const iv of keep){ const a=ivStart(iv), b=ivEnd(iv); if(!(b>a)) continue; tot+=b-a;
    for (const t of topics) inside+=Math.max(0,Math.min(b,t.endSec+pad)-Math.max(a,t.startSec-pad)); }
  return tot ? Math.min(1,inside/tot) : 0;
}

const SCENARIOS = [
  { id:'S1-fillers', prompt:'Почисти речь: убери слова-паразиты и оговорки',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts'||!r.proposal._remove||!r.proposal._remove.length) return {pass:false,note:'нет removeIntervals'}; const bad=r.proposal._remove.some(iv=>((iv.endSec||iv.end)-(iv.startSec||iv.start))>30); return {pass:!bad,note:(bad?'есть кусок>30с; ':'')+'remove='+r.proposal._remove.length}; } },
  { id:'S2-target', prompt:'Собери короткую нарезку на 60 секунд из самых важных моментов',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts'||!r.proposal._keep||!r.proposal._keep.length) return {pass:false,note:'нет keepIntervals'}; const s=sumIv(r.proposal._keep); const okT=r.proposal._target!=null; const okS=s>=30&&s<=90; return {pass:okT&&okS,note:'keepSum='+s.toFixed(0)+'с target='+r.proposal._target}; } },
  { id:'S3-markers', prompt:'Поставь 4 маркера на основные темы',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='markers') return {pass:false,note:'нет markers'}; const m=r.proposal._markers||[]; const cnt=m.length; const inRange=m.every(x=>{const t=x.timeSec!=null?x.timeSec:x.time; return t>=minSec-2&&t<=maxSec+2;}); return {pass:cnt>=3&&cnt<=7&&inRange,note:'cnt='+cnt+(inRange?'':' вне диапазона')}; } },
  { id:'S4-find', prompt:HAS_TOPICS?'Найди момент, где обсуждают тему «'+T_FIND.title+'»':'Найди момент, где говорят про детство и увлечение автомобилями',
    score:(r)=>{ const called=r.trace.some(t=>t.tool==='find_moments'); const ans=(r.lastContent||'').length>10; return {pass:called&&ans,note:(called?'find_moments✓':'без find_moments')+(ans?' +ответ':' нет ответа')}; } },
  { id:'S5-info', prompt:'Сколько примерно длится материал на таймлайне?',
    score:(r)=>{ const c=r.lastContent||''; const okDur=mentionsDuration(c,totalDur); return {pass:okDur&&c.length>8,note:(okDur?'':'длительность неверна: ')+c.slice(0,50).replace(/\n/g,' ')}; } }
];

const HARD = [
  { id:'H1-multi', prompt:'Убери паразиты и уложи всё в 2 минуты',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts') return {pass:false,note:'нет transcript_cuts'}; const keep=r.proposal._keep, rem=r.proposal._remove; const s=keep?sumIv(keep):(rem?(maxSec-minSec-sumIv(rem)):0); const okT=r.proposal._target!=null; return {pass:okT&&s<=150&&s>=60,note:'итог≈'+s.toFixed(0)+'с target='+r.proposal._target}; } },
  { id:'H2-theme', prompt:HAS_TOPICS?'Собери нарезку только про темы «'+T_THEME[0].title+'» и «'+T_THEME[1].title+'»':'Собери нарезку только про детство, автоспорт и старт проекта',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts'||!r.proposal._keep) return {pass:false,note:'нет keepIntervals'}; const k=r.proposal._keep;
      if (HAS_TOPICS){ const sh=shareInTopics(k,T_THEME,10); return {pass:k.length>=1&&sh>=0.8,note:'keep='+k.length+' в темах '+Math.round(sh*100)+'%'}; }
      const inEarly=k.every(iv=>(iv.startSec||iv.start)<320); return {pass:k.length>=1&&inEarly,note:'keep='+k.length+(inEarly?' (ранние темы✓)':' (захватил поздние)')}; } },
  { id:'H3-ambig', prompt:'Сделай покороче, оставь только самое главное',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts') return {pass:false,note:'нет плана (амбигуитет не разрешён)'}; const keep=r.proposal._keep,rem=r.proposal._remove; return {pass:!!(keep&&keep.length)||!!(rem&&rem.length),note:keep?('keep='+keep.length):('remove='+(rem?rem.length:0))}; } },
  { id:'H4-negation', prompt:'Убери всё, кроме рассказа про сам проект и компанию',
    score:(r)=>{ if(!r.proposal||r.proposal._kind!=='transcript_cuts') return {pass:false,note:'нет плана'}; const keep=r.proposal._keep,rem=r.proposal._remove; return {pass:!!(keep&&keep.length)||!!(rem&&rem.length),note:(keep?'keep='+keep.length:'remove='+(rem?rem.length:0))+' (негация)'}; } },
  { id:'H5-twostep', prompt:HAS_TOPICS?'Найди, где обсуждают тему «'+T_MARK.title+'», и поставь там маркер-хайлайт':'Найди где говорят про Tesla и поставь там маркер-хайлайт',
    score:(r)=>{ const found=r.trace.some(t=>t.tool==='find_moments'); const mk=r.proposal&&r.proposal._kind==='markers';
      let place=true, where='';
      if (HAS_TOPICS&&mk){ const ts=(r.proposal._markers||[]).map(x=>x.timeSec!=null?x.timeSec:x.time); place=ts.length>0&&ts.every(t=>t>=T_MARK.startSec-15&&t<=T_MARK.endSec+15); where=place?' в теме✓':' мимо темы ('+ts.map(t=>Math.round(t)).join(',')+'с)'; }
      return {pass:found&&mk&&place,note:(found?'find✓':'без find')+' '+(mk?'+маркер':'без маркера')+where}; } }
];

const SET = process.env.HARD ? HARD : SCENARIOS;
const SETNAME = process.env.HARD ? 'СЛОЖНЫЕ' : 'базовые';
const REPEAT = Math.max(1, parseInt(process.env.REPEAT || '1', 10) || 1);
console.log('Набор сценариев: '+SETNAME+' ('+SET.length+')'+(REPEAT>1?' ×'+REPEAT:'')+', enable_thinking='+THINKING+(HAS_TOPICS?', темы из глав entry':''));
for (const sc of SET) console.log('  '+sc.id+': '+sc.prompt);

const results = {};
for (const model of MODELS) {
  console.log('\n████ '+model+' ████');
  results[model]={pass:0,total:SET.length*REPEAT,lat:[],tokens:0,pt:0,ct:0,errors:0,details:[]};
  for (let rep=0; rep<REPEAT; rep++) for (const sc of SET) {
    const t0=Date.now();
    const r=await runAgent(model, sc.prompt);
    const dt=(Date.now()-t0)/1000;
    results[model].pt+=r.usage.pt; results[model].ct+=r.usage.ct; /* токены ошибочного прогона тоже оплачены */
    if (r.error){ results[model].errors++; results[model].details.push(sc.id+': ERR '+r.error.slice(0,60)); console.log(`  ${sc.id}: ⚠ ERR ${r.error.slice(0,70)} (${dt.toFixed(1)}s)`); continue; }
    const sres=sc.score(r); results[model].lat.push(dt); results[model].tokens+=r.tokens||0;
    if (sres.pass) results[model].pass++;
    results[model].details.push(sc.id+': '+(sres.pass?'✓':'✗')+' '+sres.note);
    console.log(`  ${sc.id}: ${sres.pass?'✓':'✗'} ${sres.note} | ${dt.toFixed(1)}s, ${r.usage.pt}+${r.usage.ct}tok, turns=${r.turns||'?'}`);
  }
}

console.log('\n\n═══════════ СВОДНАЯ ТАБЛИЦА ═══════════');
console.log('| Модель | Прошло | Ср.латентность | Ток вход | Ток выход | ₽ | Ошибки |');
console.log('|--------|--------|----------------|----------|-----------|---|--------|');
for (const m of MODELS) {
  const r=results[m]; const avg=r.lat.length?(r.lat.reduce((a,b)=>a+b,0)/r.lat.length):0;
  console.log(`| ${m} | ${r.pass}/${r.total} | ${avg.toFixed(1)}s | ${r.pt} | ${r.ct} | ${costRub(m,r.pt,r.ct).toFixed(2)} | ${r.errors} |`);
}
console.log('\nДетали:');
for (const m of MODELS){ console.log('\n'+m+':'); results[m].details.forEach(d=>console.log('  '+d)); }
