# План монтажа по смыслам (`propose_montage_plan`) — план имплементации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** новый инструмент агента `propose_montage_plan` — структурированный план сокращения ролика (блоки keep/cut с темами и причинами), детерминированная валидация (покрытие, хронометраж ±10%, причины, пожертвованные темы), карточка плана, применение через существующий propose/apply-путь.

**Architecture:** чистый валидатор `client/shared/montage-plan.js` (IIFE + vm-loader для тестов, как analysis-routing) → executor в panel.js — тонкий слой: валидация → removeRefs → делегирование в существующий `execProposeTranscriptCuts` → карточка расширяется секцией плана. Спека: `docs/superpowers/specs/2026-07-05-montage-plan-design.md`.

**Tech Stack:** vanilla JS (браузерный IIFE, БЕЗ ES-модулей в client/), node:test для юнитов, ExtendScript-host НЕ трогаем.

**Правила проекта (обязательны):**
- Коммиты делает ТОЛЬКО оркестратор после ревью — субагенты НЕ коммитят.
- `npm test` из корня — все тесты должны быть зелёными (сейчас 534).
- panel.js исполняется в CEF (Chromium) — современный JS можно; host/premiere.jsx — ES3, но в этом плане host не меняется.
- Кириллица в сообщениях об ошибках — как в остальном коде.

---

### Task 1: модуль `MontagePlan.validatePlan` (валидатор, TDD)

**Files:**
- Create: `client/shared/montage-plan.js`
- Create: `tests/load-montage-plan-module.mjs` (имя НЕ `load-montage-plan.mjs` — оно занято мультикамом!)
- Create: `tests/montage-plan-validator.test.mjs` (имя НЕ `montage-plan.test.mjs` — занято)

⚠ В репо уже есть `client/shared/multicam-plan.js` + `tests/load-multicam-plan.mjs` (мультикам). Новый модуль называется `montage-plan.js`, глобал `MontagePlan` — не путать.

- [ ] **Step 1: лоадер** — скопировать паттерн `tests/load-analysis-routing.mjs`:

```js
/**
 * Загружает browser-IIFE montage-plan.js в Node-контексте.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadMontagePlan() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'montage-plan.js');
  const src = fs.readFileSync(filePath, 'utf8');
  const root = {};
  vm.runInNewContext(src, {
    window: root, Array, Object, Math, String, Number, JSON, Error, RegExp, console, undefined
  }, { filename: 'montage-plan.js' });
  if (!root.MontagePlan) throw new Error('MontagePlan not attached to root');
  return root.MontagePlan;
}
```

- [ ] **Step 2: failing-тесты валидатора.** Фикстура: entry c 8 абзацами по 60с (0–480с) и topics. Написать тесты (полный файл):

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadMontagePlan } from './load-montage-plan-module.mjs';

const MP = loadMontagePlan();

/** 8 абзацев по 60с: [0,60), [60,120) … [420,480); темы: 0-2 «Завязка», 3-5 «Тема Б», 6-7 «Финал» */
function makeEntry() {
  const paragraphs = [];
  for (let i = 0; i < 8; i++) {
    paragraphs.push({ i, startSec: i * 60, endSec: (i + 1) * 60, text: 'абзац ' + i });
  }
  return {
    paragraphs,
    topics: [
      { startSec: 0, endSec: 180, title: 'Завязка' },
      { startSec: 180, endSec: 360, title: 'Тема Б' },
      { startSec: 360, endSec: 480, title: 'Финал' }
    ]
  };
}

function plan(targetSec, blocks) {
  return { targetDurationSec: targetSec, blocks, summary: 'тест' };
}

const KEEP = (from, to, theme) => ({ action: 'keep', paragraphs: { from, to }, theme: theme || 'Тема' });
const CUT = (from, to, reason) => ({ action: 'cut', paragraphs: { from, to }, reason: reason || 'вода' });

describe('MontagePlan.validatePlan — структура', () => {
  test('валидный план: ok, errors пуст, stats посчитан', () => {
    // keep 0-3 (240с) + cut 4-7 → цель 240 → ровно 100%
    const r = MP.validatePlan(plan(240, [KEEP(0, 3, 'Суть'), CUT(4, 7, 'повтор')]), makeEntry());
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.stats.keepSec, 240);
    assert.equal(r.stats.cutSec, 240);
    assert.equal(r.stats.keepBlocks, 1);
    assert.equal(r.stats.cutBlocks, 1);
  });

  test('нет targetDurationSec → error', () => {
    const r = MP.validatePlan({ blocks: [KEEP(0, 7)] }, makeEntry());
    assert.equal(r.ok, false);
    assert.ok(r.errors.join(' ').includes('targetDurationSec'));
  });

  test('blocks пуст/не массив → error', () => {
    assert.equal(MP.validatePlan(plan(60, []), makeEntry()).ok, false);
    assert.equal(MP.validatePlan(plan(60, null), makeEntry()).ok, false);
  });

  test('незнакомый action → error с индексом блока', () => {
    const r = MP.validatePlan(plan(240, [{ action: 'trim', paragraphs: { from: 0, to: 7 } }]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /блок 0/i);
  });

  test('paragraphs.from > to или вне диапазона → error', () => {
    assert.equal(MP.validatePlan(plan(240, [KEEP(3, 1), CUT(0, 7)]), makeEntry()).ok, false);
    assert.equal(MP.validatePlan(plan(240, [KEEP(0, 99)]), makeEntry()).ok, false);
    assert.equal(MP.validatePlan(plan(240, [KEEP(-1, 7)]), makeEntry()).ok, false);
  });
});

describe('MontagePlan.validatePlan — покрытие', () => {
  test('дыра (абзац ни в одном блоке) → error с номером абзаца', () => {
    // 4 не покрыт
    const r = MP.validatePlan(plan(240, [KEEP(0, 3, 'Суть'), CUT(5, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /4/);
  });

  test('перекрытие (абзац в двух блоках) → error с номером', () => {
    const r = MP.validatePlan(plan(240, [KEEP(0, 4, 'Суть'), CUT(4, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /4/);
  });
});

describe('MontagePlan.validatePlan — хронометраж ±10% (реальные длительности, не LLM)', () => {
  test('в пределах +10% → ok (граница ровно 10% допустима)', () => {
    // keep 0-3 = 240с, цель 219 → 240/219 ≈ +9.6% → ok
    const r = MP.validatePlan(plan(219, [KEEP(0, 3, 'Суть'), CUT(4, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, true);
  });

  test('перебор > +10% → error с точными цифрами и сколько убрать', () => {
    // keep 0-3 = 240с, цель 200 → +20%
    const r = MP.validatePlan(plan(200, [KEEP(0, 3, 'Суть'), CUT(4, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, false);
    const msg = r.errors.join(' ');
    assert.match(msg, /240/);          // фактический keep
    assert.match(msg, /200/);          // цель
    assert.match(msg, /убер/i);        // «убери ещё ~40с»
  });

  test('недобор > −10% → error с подсказкой вернуть или предложить меньшую цель', () => {
    // keep 0-1 = 120с, цель 240 → 50%
    const r = MP.validatePlan(plan(240, [KEEP(0, 1, 'Суть'), CUT(2, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /недобор|верни|меньшую цель/i);
  });
});

describe('MontagePlan.validatePlan — причины и темы', () => {
  test('cut без reason → error с индексом блока', () => {
    const r = MP.validatePlan(
      plan(240, [KEEP(0, 3, 'Суть'), { action: 'cut', paragraphs: { from: 4, to: 7 } }]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /reason|причин/i);
  });

  test('keep без theme → error', () => {
    const r = MP.validatePlan(
      plan(240, [{ action: 'keep', paragraphs: { from: 0, to: 3 } }, CUT(4, 7, 'вода')]), makeEntry());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /theme|тем/i);
  });
});

describe('MontagePlan.validatePlan — пожертвованные темы (warnings, не errors)', () => {
  test('тема, все абзацы которой в cut → warning с названием темы', () => {
    // «Тема Б» = 180-360с = абзацы 3,4,5 — все в cut; keep 0-2 (180с) + 6-7 (120с) = 300с, цель 300
    const r = MP.validatePlan(
      plan(300, [KEEP(0, 2, 'Завязка'), CUT(3, 5, 'офтоп'), KEEP(6, 7, 'Финал')]), makeEntry());
    assert.equal(r.ok, true);
    assert.match(r.warnings.join(' '), /Тема Б/);
    assert.deepEqual(r.stats.sacrificedTopics, ['Тема Б']);
  });

  test('тема частично сохранена → warning НЕ ставится', () => {
    const r = MP.validatePlan(plan(240, [KEEP(0, 3, 'Суть'), CUT(4, 7, 'вода')]), makeEntry());
    // «Тема Б» (абзацы 3-5): абзац 3 в keep → не пожертвована
    assert.equal(r.warnings.filter(w => w.includes('Тема Б')).length, 0);
  });

  test('entry без topics → нет warnings, нет падения', () => {
    const entry = makeEntry();
    delete entry.topics;
    const r = MP.validatePlan(plan(240, [KEEP(0, 3, 'Суть'), CUT(4, 7, 'вода')]), entry);
    assert.equal(r.ok, true);
    assert.deepEqual(r.stats.sacrificedTopics, []);
  });
});

describe('MontagePlan.buildRemoveRefs / buildSummaries', () => {
  test('cut-блоки разворачиваются в одиночные removeRefs c reason', () => {
    const refs = MP.buildRemoveRefs([KEEP(0, 3, 'Суть'), CUT(4, 6, 'повтор'), CUT(7, 7, 'вода')]);
    assert.deepEqual(refs, [
      { paragraph: 4, reason: 'повтор' },
      { paragraph: 5, reason: 'повтор' },
      { paragraph: 6, reason: 'повтор' },
      { paragraph: 7, reason: 'вода' }
    ]);
  });

  test('buildSummaries: keepSummary из theme, removeSummary из reason, тайминги из entry', () => {
    const s = MP.buildSummaries([KEEP(0, 1, 'Суть дела'), CUT(2, 7, 'вода')], makeEntry());
    assert.deepEqual(s.keepSummary, [{ startSec: 0, endSec: 120, quote: 'Суть дела' }]);
    assert.deepEqual(s.removeSummary, [{ startSec: 120, endSec: 480, quote: 'абзац 2 …', reason: 'вода' }]);
  });
});
```

Про `quote: 'абзац 2 …'` в removeSummary: цитата = первые ~60 символов текста первого абзаца блока + ' …' если обрезано; тест подстроить под фактический формат, но проверять что startSec/endSec взяты из entry и reason пробрасывается.

- [ ] **Step 3: запустить — тесты падают** (`node --test tests/montage-plan-validator.test.mjs` → FAIL: файла модуля нет).

- [ ] **Step 4: реализация `client/shared/montage-plan.js`.** Шапка и каркас:

```js
/**
 * MontagePlan — детерминированная валидация «плана монтажа по смыслам»
 * (инструмент propose_montage_plan). Вся арифметика хронометража — здесь,
 * НЕ у LLM. Чистые функции без DOM/ContextStore — юнит-тестируемо в Node.
 * Спека: docs/superpowers/specs/2026-07-05-montage-plan-design.md
 */
(function (global) {
  var TOLERANCE = 0.10; // ±10% допуск попадания в целевой хронометраж

  function fmtSec(s) {
    var m = Math.floor(s / 60);
    var ss = Math.round(s - m * 60);
    if (ss === 60) { m += 1; ss = 0; }
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function paraDur(p) { return Math.max(0, (p.endSec || 0) - (p.startSec || 0)); }

  /**
   * @param {object} plan {targetDurationSec, blocks:[{action,paragraphs:{from,to},theme?,reason?}], summary?}
   * @param {object} entry транскрипт-кэш: {paragraphs:[{i,startSec,endSec,text}], topics?:[{startSec,endSec,title}]}
   * @returns {{ok:boolean, errors:string[], warnings:string[], stats:object}}
   */
  function validatePlan(plan, entry) { /* … по правилам ниже … */ }

  /** cut-блоки → [{paragraph:i, reason}] (диапазон разворачивается в одиночные ref'ы). */
  function buildRemoveRefs(blocks) { /* … */ }

  /** блоки → {keepSummary:[{startSec,endSec,quote}], removeSummary:[{startSec,endSec,quote,reason}]}. */
  function buildSummaries(blocks, entry) { /* … */ }

  global.MontagePlan = { validatePlan: validatePlan, buildRemoveRefs: buildRemoveRefs, buildSummaries: buildSummaries, _fmtSec: fmtSec };
})(window);
```

Правила `validatePlan` (порядок проверок; первая группа ошибок НЕ прерывает сбор остальных — собирать все в `errors[]`):
1. `entry` без непустого `paragraphs` → единственная ошибка «нет структуры транскрипта — вызови get_transcript_structure».
2. `targetDurationSec` не число или ≤ 0 → «нужен targetDurationSec > 0 (секунды)».
3. `blocks` не непустой массив → ошибка.
4. По каждому блоку b с индексом bi: action не keep/cut → «блок bi: action должен быть keep|cut»; paragraphs.from/to не целые, from>to, from<0, to≥P → ошибка с bi; keep без trim(theme) → «блок bi (keep): нужен theme»; cut без trim(reason) → «блок bi (cut): нужен reason — почему вырезаем».
5. Покрытие: массив `assigned = new Array(P).fill(-1)`; при повторном назначении → «абзац N в двух блоках (bi1 и bi2)»; после прохода непокрытые → «абзацы N,M,… не попали ни в один блок — план должен покрывать весь транскрипт» (номера списком, максимум 10 + «и ещё K»).
6. Если ошибок структуры/покрытия нет — хронометраж: `keepSec` = сумма paraDur по абзацам keep-блоков; `ratio = keepSec / target`;
   - ratio > 1 + TOLERANCE → «хронометраж: получилось fmtSec(keepSec) при цели fmtSec(target) (+X%) — переведи в cut ещё ~fmtSec(keepSec−target)»;
   - ratio < 1 − TOLERANCE → «хронометраж: недобор — fmtSec(keepSec) при цели fmtSec(target) (−X%). Верни в keep ~fmtSec(target−keepSec) или предложи пользователю меньшую цель»;
   X% — округлённый процент отклонения.
7. Темы: если `entry.topics` непустой — тема пожертвована, когда ВСЕ абзацы, пересекающиеся с [topic.startSec, topic.endSec) (пересечение: `p.startSec < topic.endSec && topic.startSec < p.endSec`), лежат в cut-блоках; тогда warning «тема '<title>' пожертвована целиком» и title в `stats.sacrificedTopics`. Тема без пересекающихся абзацев — не warning.
8. `stats = {keepSec, cutSec, targetSec, keepBlocks, cutBlocks, sacrificedTopics}` (cutSec — сумма по cut-абзацам); `ok = errors.length === 0`.

- [ ] **Step 5: прогнать** `node --test tests/montage-plan-validator.test.mjs` → все PASS; затем полный `npm test` → 534 + новые, 0 fail.

- [ ] **Step 6: подключить модуль в панель** — `client/unified/index2.html`, список скриптов (строки ~550-577): добавить `'../shared/montage-plan.js',` ПОСЛЕ `'../shared/analysis-routing.js',`.

---

### Task 2: схема инструмента + промпт-роутинг

**Files:**
- Modify: `client/unified/panel.js` — массив TOOLS_TEXTMONTAGE (схема `propose_transcript_cuts` там на ~595-675; новую схему добавить рядом, читай соседние определения и повторяй стиль)
- Modify: `client/shared/prompts.js` — секция TIER1_TRANSCRIPT (~112-270)
- Test: `tests/prompts.test.mjs` — если там есть тесты на наличие инструментов, дополнить; если нет — не выдумывать

- [ ] **Step 1: схема инструмента** (в стиле соседних, description на русском):

```js
{
  type: 'function',
  function: {
    name: 'propose_montage_plan',
    description: 'План монтажа по смыслам: сократить материал до целевого хронометража. ' +
      'Блоки keep/cut покрывают ВСЕ абзацы транскрипта ровно по одному разу. ' +
      'Плагин сам считает длительности по абзацам (не считай секунды вручную), ' +
      'валидирует попадание в цель ±10% и показывает пользователю карточку плана на подтверждение. ' +
      'Используй для запросов «сожми до N минут», «сократи сохранив суть», «собери по смыслу». ' +
      'Требуется транскрипт (get_transcript_structure).',
    parameters: {
      type: 'object',
      properties: {
        sequenceKey: { type: 'string', description: 'Имя секвенции (sequenceName из снимка)' },
        targetDurationSec: { type: 'number', description: 'Целевой хронометраж в секундах, > 0' },
        blocks: {
          type: 'array',
          description: 'Блоки плана в хронологическом порядке. Каждый абзац транскрипта — ровно в одном блоке.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['keep', 'cut'] },
              paragraphs: {
                type: 'object',
                properties: {
                  from: { type: 'number', description: 'Первый абзац блока (индекс i)' },
                  to: { type: 'number', description: 'Последний абзац блока включительно' }
                },
                required: ['from', 'to']
              },
              theme: { type: 'string', description: 'Для keep: тема/роль блока в драматургии (3-6 слов)' },
              reason: { type: 'string', description: 'Для cut: почему вырезаем (повтор / вода / слабый кусок / офтоп + уточнение)' }
            },
            required: ['action', 'paragraphs']
          }
        },
        summary: { type: 'string', description: '1-2 предложения: что получится' }
      },
      required: ['sequenceKey', 'targetDurationSec', 'blocks', 'summary']
    }
  }
}
```

- [ ] **Step 2: prompts.js** — в описание транскрипт-инструментов добавить 2-3 строки: запросы «сожми до N минут / сократи сохранив суть» → СНАЧАЛА `get_transcript_structure`, затем `propose_montage_plan` (НЕ голый `propose_transcript_cuts` — у плана есть проверка покрытия и хронометража). Точное место — рядом с существующим описанием propose_transcript_cuts, не ломая нумерацию/структуру текста.

- [ ] **Step 3: `npm test`** → зелёный (схема — данные, поведение не меняется).

---

### Task 3: executor `execProposeMontagePlan` + регистрация

**Files:**
- Modify: `client/unified/panel.js`:
  - новый executor рядом с `execProposeTranscriptCuts` (~2697-2842) — ПРОЧИТАЙ его целиком перед работой: там паттерны поиска entry, staleness, возвратов ошибок агенту;
  - `execProposeTranscriptCuts` — 3 строки для проброса planBlocks (см. Step 2);
  - `buildExecutorsForPreset` (~3711) — регистрация `propose_montage_plan: execProposeMontagePlan` в тех же пресетах, где доступен `propose_transcript_cuts`.

- [ ] **Step 1: executor.** Каркас (точные имена хелперов сверить с кодом — `ContextStore.findTranscriptEntry`, staleness-паттерн из `_resolveRemoveRefs`):

```js
/**
 * План монтажа по смыслам (спека 2026-07-05): валидация детерминированным
 * MontagePlan.validatePlan → removeRefs → делегирование в execProposeTranscriptCuts
 * (padding/snap/merge/карточка/apply переиспользуются целиком).
 */
async function execProposeMontagePlan(args) {
  args = args || {};
  var sequenceKey = String(args.sequenceKey || '').trim();
  if (!sequenceKey) return { error: 'propose_montage_plan: нужен sequenceKey (sequenceName из снимка)' };

  var entry = ContextStore.findTranscriptEntry(activePanelId(), sequenceKey); // ← сверить сигнатуру с _resolveRemoveRefs
  if (!entry) return { error: 'Транскрипт для «' + sequenceKey + '» не найден. Вызови get_transcript_structure.' };
  if (entry.possiblyStale) {
    return { error: 'Транскрипт устарел (таймлайн менялся). Перестрой транскрипт перед планированием.' };
  }

  var v = MontagePlan.validatePlan(args, entry);
  if (!v.ok) {
    return { error: 'План не прошёл проверку: ' + v.errors.join('; '), _planStats: v.stats };
  }

  var refs = MontagePlan.buildRemoveRefs(args.blocks);
  var summaries = MontagePlan.buildSummaries(args.blocks, entry);

  _pendingPlanContext = { blocks: args.blocks, stats: v.stats, warnings: v.warnings };
  var res;
  try {
    res = await execProposeTranscriptCuts({
      sequenceKey: sequenceKey,
      removeRefs: refs,
      targetDurationSec: args.targetDurationSec,
      keepSummary: summaries.keepSummary,
      removeSummary: summaries.removeSummary,
      summary: args.summary
    });
  } finally {
    _pendingPlanContext = null;
  }
  if (res && res.ok) res._planStats = v.stats;
  if (res && res.ok && v.warnings.length) res._planWarnings = v.warnings;
  return res;
}
```

Плюс объявление `var _pendingPlanContext = null;` рядом с `_pendingProposal`.

- [ ] **Step 2: проброс в `execProposeTranscriptCuts`** — в месте создания `_pendingProposal` (~2811-2825) добавить:

```js
if (_pendingPlanContext) {
  _pendingProposal.planBlocks = _pendingPlanContext.blocks;
  _pendingProposal.planStats = _pendingPlanContext.stats;
  _pendingProposal.planWarnings = _pendingPlanContext.warnings;
}
```

(ДО вызова `renderPendingProposalCard()` — карточка сразу видит план). Также warnings плана добавить к `warnings` proposal'а, если карточка рендерит их из общего поля — сверить с кодом.

- [ ] **Step 3: регистрация в `buildExecutorsForPreset`** — по образцу строки `propose_transcript_cuts`.

- [ ] **Step 4: `npm test`** → зелёный (executor'ы в тестах не исполняются, но регресс проверяем).

---

### Task 4: карточка плана

**Files:**
- Modify: `client/unified/panel.js` — `renderPendingProposalCard`, ветка `kind === 'transcript_cuts'` (~1948-2106). Прочитай существующий рендер keep/remove-секций и `_tcJumpEl` — повторяй их DOM-стиль (createElement, никакого innerHTML с интерполяцией пользовательских строк — XSS).
- Modify: `client/shared/styles.css` — если нужны 2-3 класса для блоков плана (по образцу существующих proposal-стилей).

- [ ] **Step 1: секция плана.** Если `p.planBlocks` есть — ПЕРЕД списками keep/remove вставить:

- заголовок «📋 План монтажа (N блоков)»;
- строка итога из `p.planStats`: «Хронометраж: fmtSec(keepSec+cutSec) → fmtSec(keepSec) · цель fmtSec(targetSec)» — с той же цветовой логикой что target-badge (✓ в пределах ±10%);
- по блокам, в порядке массива: keep → `✓ [tc] Тема · fmtSec(длит.)`, cut → `✗ [tc] fmtSec(длит.) · причина` (текст причины — textContent!); `[tc]` — кликабельный `_tcJumpEl(startSec первого абзаца блока)`; длительность блока считать по entry НЕ нужно — достаточно `planStats` для итога и таймкодов из существующих keepSummary/removeSummary (startSec/endSec там уже есть — блоки плана 1:1 с элементами summaries из `buildSummaries`);
- `p.planWarnings` (пожертвованные темы) — в существующий warnings-блок карточки;
- существующие списки keep/remove-интервалов при наличии плана свернуть: обернуть в `<details><summary>Детализация интервалов</summary>…</details>` (или классом-аналогом, если details в панели не используются — проверить).

- [ ] **Step 2: смок вручную не требуется** (живой прогон — Task 6); проверить `npm test` зелёный.

---

### Task 5: стартер + welcome-карточка + build bump

**Files:**
- Modify: `client/shared/conversation-starters.js` — категория `textmontage` в BUILTIN (после story-cutter-timed)
- Modify: `client/unified/panel.js` — welcome-карточка (~3993-4024) + `__PANEL_BUILD__` (строка 10)

- [ ] **Step 1: builtin-стартер** (правило файла: только с systemPromptAddon + смок-валидацией — live e2e будет в Task 6):

```js
{
  id: 'montage-plan',
  name: 'Монтаж по смыслам',
  description: 'Сократить ролик до цели: план keep/cut с темами и причинами на подтверждение',
  systemPromptAddon: [
    'РЕЖИМ МОНТАЖ ПО СМЫСЛАМ — сокращение материала с сохранением сути через план блоков.',
    '',
    'АЛГОРИТМ:',
    '',
    '1. Если в запросе нет целевого хронометража — спроси: «До какой длительности сжать?» НЕ продолжай без цели.',
    '',
    '2. get_timeline_snapshot → sequenceName, sequenceEndSec.',
    '',
    '3. get_transcript_structure(sequenceKey: sequenceName) → абзацы + topics (главы).',
    '',
    '4. ПОЙМИ МАТЕРИАЛ: перечисли темы и драматургию (завязка → развитие → финал).',
    '   Реши, что несёт суть, а что жертвуем. Сохраняй начало и вывод — без них ролик разваливается.',
    '',
    '5. Построй blocks: каждый абзац ровно в одном блоке.',
    '   • keep: theme — роль блока в истории (3-6 слов).',
    '   • cut: reason из списка — повтор / вода / слабый кусок / офтоп (+ уточнение).',
    '   НЕ считай секунды сам — плагин посчитает по абзацам и проверит цель ±10%.',
    '',
    '6. propose_montage_plan({sequenceKey, targetDurationSec, blocks, summary}).',
    '   Ошибка валидации → перебалансируй план по подсказке и вызови ещё раз (это нормально, не сдавайся).',
    '   Если недобор из-за того, что материала по сути меньше цели — скажи пользователю и предложи меньшую цель.',
    '',
    '7. После status waiting_user_confirmation — финальное сообщение: 1-2 фразы о структуре плана',
    '   и цифры ТОЛЬКО из _planStats/_verification (не свои). Пользователь применит кнопкой.',
    '',
    'НИКОГДА не вызывай apply_transcript_cuts напрямую в этом режиме.'
  ].join('\n'),
  userPrompt: 'Сожми ролик до 15 минут, сохранив суть и драматургию',
  panelId: 'textmontage',
  builtin: true
}
```

- [ ] **Step 2: welcome-карточка** — добавить пункт в список возможностей: «Сжать ролик до нужной длины с сохранением сути — агент покажет план (что остаётся и почему режем) до применения. Пример: „сожми до 15 минут“».

- [ ] **Step 3: build bump** — `__PANEL_BUILD__ = '2026-07-05-montage-plan-v37'`.

- [ ] **Step 4: `npm test`** → зелёный. Если для conversation-starters есть тест на количество/валидность builtin'ов — обновить.

---

### Task 6 (оркестратор, НЕ субагент): live-валидация

- [ ] hardreload панели через CDP (метод из памяти: Network.setCacheDisabled + Page.reload{ignoreCache:true}), проверить `__PANEL_BUILD__ === '2026-07-05-montage-plan-v37'`, `window.MontagePlan` существует.
- [ ] Структурный смок через CDP: `MontagePlan.validatePlan` на синтетическом плане против реального entry; схема `propose_montage_plan` присутствует в TOOLS; стартер «Монтаж по смыслам» виден в категории текст.
- [ ] Полный e2e на подкасте «Атом» (53 мин, транскрипт был): бэкап секвенции → рез КОПИИ → «сожми до 15 минут» через стартер → карточка плана (блоки/темы/причины/итог/warnings) → Apply → `_timelineDiff.match === true` → вернуть оригинал. Пользователь читает план и смотрит результат — субъективная оценка связности = финальная приёмка.
- [ ] Коммит(ы) — только после отмашки пользователя.

---

## Self-review (выполнен)

- Покрытие спеки: §1 контракт → Task 2; §2 валидатор → Task 1; §3 executor → Task 3; §4 карточка → Task 4; §5 промпт-протокол → Task 2+5; §6 UI старта → Task 5; §7 тесты/приёмка → Task 1+6. Гэпов нет.
- Имена согласованы: `MontagePlan.validatePlan/buildRemoveRefs/buildSummaries`, `_pendingPlanContext`, `planBlocks/planStats/planWarnings`, `_planStats/_planWarnings` в ответе агенту.
- Коллизия имён с мультикамом (`multicam-plan.js` / `load-multicam-plan.mjs`) учтена в Task 1.
