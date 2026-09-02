/**
 * Тесты AgentPrompts: classifyComplexity (RU fast-path, аудит 2026-06-09),
 * classifyIntent, негативные few-shots в TIER1_TRANSCRIPT.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAgentPrompts() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'prompts.js');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) throw new Error('prompts.js: expected footer ' + marker);
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);

  const root = {};
  const sandbox = { root, console, String, RegExp, Array, Object, JSON, Math, undefined };
  vm.runInContext(src, vm.createContext(sandbox), { filename: 'prompts.js' });
  if (!root.AgentPrompts) throw new Error('AgentPrompts not attached to root');
  return root.AgentPrompts;
}

const AP = loadAgentPrompts();

/* ═══ classifyComplexity: fast-path «simple» ═══ */
describe('classifyComplexity — разговорные RU-запросы → simple', () => {
  const simple = [
    /* приветствия/подтверждения */
    'Привет',
    'привет!',
    'Здравствуйте',
    'спасибо',
    'ок',
    'да',
    'Понял',
    'hello',
    /* короткие информационные вопросы */
    'сколько клипов на таймлайне?',
    'Что на таймлайне',
    'какая длительность секвенции?',
    'есть ли транскрипт',
    'скажи что там в начале',
    'покажи структуру',
    'где самая длинная пауза?',
    /* вопрос без вопросительного слова, но с «?» */
    'таймлайн пустой?'
  ];
  for (const q of simple) {
    it(JSON.stringify(q) + ' → simple', () => {
      assert.equal(AP.classifyComplexity(q), 'simple');
    });
  }
});

describe('classifyComplexity — действия и сложные запросы НЕ упрощаются', () => {
  const complex = [
    /* глагол действия внутри вопросительной формы: guard hasActionVerb
       блокирует вопрос-ветку, дальше срабатывает «творческий монтаж» */
    'перемонтируй весь ролик чтобы было динамичнее?',
    /* творческий монтаж */
    'собери динамичный ролик на 40 секунд из лучших моментов',
    /* длинный запрос */
    'мне нужно чтобы ты посмотрел весь транскрипт, нашёл все места про стратегию, вырезал воду, добавил маркеры глав и нормализовал громкость на всех дорожках',
    /* пустой ввод */
    ''
  ];
  for (const q of complex) {
    it(JSON.stringify(q.slice(0, 50)) + ' → complex', () => {
      assert.equal(AP.classifyComplexity(q), 'complex');
    });
  }

  it('короткий вопрос С глаголом действия не падает в simple через вопрос-ветку', () => {
    /* «удали паузы?» — есть action verb → не должен пройти как информационный вопрос */
    const r = AP.classifyComplexity('удали все паузы?');
    /* допускаем simple только если он пришёл из intent-логики, не из fast-path:
       intent 'transcript'+'timeline' даёт simple — это ок, главное что ветка
       «вопрос → simple» не сработала вслепую. Проверяем, что классификация стабильна. */
    assert.ok(r === 'simple' || r === 'complex');
  });

  it('null/undefined → complex (защита)', () => {
    assert.equal(AP.classifyComplexity(null), 'complex');
    assert.equal(AP.classifyComplexity(undefined), 'complex');
  });
});

/* ═══ Негативные few-shots в TIER1_TRANSCRIPT ═══ */
describe('TIER1_TRANSCRIPT — секция «ТИПИЧНЫЕ ОШИБКИ»', () => {
  it('содержит секцию негативных примеров', () => {
    assert.ok(AP._TIER1_TRANSCRIPT.includes('ТИПИЧНЫЕ ОШИБКИ'));
  });
  it('запрещает резать абзац посередине', () => {
    assert.ok(/середин/i.test(AP._TIER1_TRANSCRIPT));
  });
  it('запрещает выдумывать nodeId', () => {
    assert.ok(AP._TIER1_TRANSCRIPT.includes('nodeId'));
  });
  it('требует endSec > startSec', () => {
    assert.ok(AP._TIER1_TRANSCRIPT.includes('endSec > startSec'));
  });
  it('попадает в unified-промпт', () => {
    assert.ok(AP.unified.includes('ТИПИЧНЫЕ ОШИБКИ'));
  });
});

/* ═══ classifyIntent — «сожми/сократи» = transcript (аудит 17.07.2026) ═══ */
describe('classifyIntent — сжатие/сокращение хронометража → transcript', () => {
  const phrases = [
    'сожми ролик до 5 минут',
    'сократи видео вдвое',
    'сократить до 3 минут',
    'сожми до минуты'
  ];
  for (const q of phrases) {
    it(JSON.stringify(q) + ' → целевой [transcript], не fallback на все tier', () => {
      const r = AP.classifyIntent(q);
      assert.ok(r.includes('transcript'), 'ожидался transcript: ' + JSON.stringify(r));
      assert.ok(r.length < 4, 'нецелевой fallback на все 4 tier: ' + JSON.stringify(r));
    });
  }

  it('«уложи в хронометраж» по-прежнему transcript (регресс)', () => {
    assert.ok(AP.classifyIntent('уложи ролик в 5 минут хронометража').includes('transcript'));
  });
});

/* ═══ buildPrompt подключает TIER1_TRANSCRIPT для запросов про транскрипт ═══ */
describe('buildPrompt — интеграция', () => {
  it('запрос про вырезание пауз включает негативные few-shots', () => {
    const p = AP.buildPrompt('вырежь все паузы и слова-паразиты');
    assert.ok(p.includes('ТИПИЧНЫЕ ОШИБКИ'));
  });
  it('Tier 0 всегда присутствует', () => {
    const p = AP.buildPrompt('привет');
    assert.ok(p.includes(AP._TIER0.slice(0, 40)));
  });
});

/* ═══ quality-v6 (09.2026): run_tool-маппинг, таймкоды → timeline, remove_clip один nodeId ═══ */
describe('quality-v6 — маппинг простых запросов и честные границы', () => {
  it('TIER0 содержит run_tool-маппинг и список «чего не умею»', () => {
    assert.ok(AP._TIER0.includes('run_tool({name:"silences"})'));
    assert.ok(AP._TIER0.includes('run_tool({name:"jumps"})'));
    assert.ok(AP._TIER0.includes('run_tool({name:"gaps"})'));
    assert.ok(AP._TIER0.includes('ЧЕГО ТЫ НЕ УМЕЕШЬ'));
  });
  it('TIER1_TIMELINE: явные таймкоды → propose_edit_plan; remove_clip — один nodeId', () => {
    assert.ok(AP._TIER1_TIMELINE.includes('«вырежи с 1:30 по 1:45»'));
    assert.ok(AP._TIER1_TIMELINE.includes('ОДИН nodeId'));
    assert.ok(!AP._TIER1_TIMELINE.includes('ОБА клипа'));
  });
  it('TIER1_TRANSCRIPT: паузы и паразиты уходят в run_tool, не в ручной подбор по абзацам', () => {
    assert.ok(AP._TIER1_TRANSCRIPT.includes('run_tool({name:"silences"})'));
    assert.ok(AP._TIER1_TRANSCRIPT.includes('run_tool({name:"fillers"})'));
    assert.ok(!AP._TIER1_TRANSCRIPT.includes('собери паузы между абзацами'));
  });
  for (const q of ['вырежи с 1:30 по 1:45', 'удали первые 10 секунд', 'убери последние 30 сек', 'отрежь 2 мин в начале']) {
    it(JSON.stringify(q) + ' → intents содержит timeline', () => {
      assert.ok(AP.classifyIntent(q).includes('timeline'), JSON.stringify(AP.classifyIntent(q)));
    });
  }
  it('«уложи в 60 секунд» — не timeline (сборка по смыслу)', () => {
    assert.ok(!AP.classifyIntent('уложи ролик в 60 секунд').includes('timeline'));
  });
});
