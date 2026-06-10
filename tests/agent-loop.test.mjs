import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import assertLoose from 'node:assert';
import { loadAgentLoop } from './load-agent-loop.mjs';

const { internals: AL } = loadAgentLoop();

/* ═══════════════════════════════════════════════════════════════
 * repairJson — починка невалидного JSON от open-source моделей
 * ═══════════════════════════════════════════════════════════════ */
describe('agent-loop.repairJson', () => {
  test('null/пустой ввод → "{}"', () => {
    assert.equal(AL.repairJson(null), '{}');
    assert.equal(AL.repairJson(''), '{}');
    assert.equal(AL.repairJson(undefined), '{}');
  });

  test('trailing comma перед } или ] убирается', () => {
    assert.deepEqual(JSON.parse(AL.repairJson('{"a":1,}')), { a: 1 });
    assert.deepEqual(JSON.parse(AL.repairJson('[1,2,]')), [1, 2]);
  });

  test('одинарные кавычки → двойные', () => {
    assert.deepEqual(JSON.parse(AL.repairJson("{'action':'remove'}")), { action: 'remove' });
  });

  test('некавыченные ключи → кавыченные', () => {
    assert.deepEqual(JSON.parse(AL.repairJson('{action: "remove"}')), { action: 'remove' });
  });

  test('обрыв на середине (max_tokens) — закрываются скобки', () => {
    assert.deepEqual(JSON.parse(AL.repairJson('{"a":1')), { a: 1 });
    assert.deepEqual(JSON.parse(AL.repairJson('{"a":{"b":2')), { a: { b: 2 } });
  });

  test('обрыв внутри строки — закрывается кавычка и скобка', () => {
    assert.deepEqual(JSON.parse(AL.repairJson('{"a":"hel')), { a: 'hel' });
  });
});

describe('agent-loop.safeParseArgs', () => {
  test('валидный JSON парсится как есть', () => {
    assertLoose.deepEqual(AL.safeParseArgs('{"x":42}'), { x: 42 });
  });

  test('пустой ввод → {}', () => {
    assertLoose.deepEqual(AL.safeParseArgs(''), {});
  });

  test('чинимый JSON проходит через repair', () => {
    assertLoose.deepEqual(AL.safeParseArgs('{"a":1,}'), { a: 1 });
  });

  test('безнадёжный мусор → _parseError', () => {
    const out = AL.safeParseArgs('это не json совсем !!!');
    assert.ok(out._parseError, 'ожидался _parseError');
    assert.ok(/Невалидный JSON/.test(out._parseError));
  });
});

/* ═══════════════════════════════════════════════════════════════
 * detectCycle / hashToolCall — защита от зацикливания
 * ═══════════════════════════════════════════════════════════════ */
describe('agent-loop.hashToolCall', () => {
  test('хэш = name + ":" + arguments', () => {
    assert.equal(
      AL.hashToolCall({ function: { name: 'cut', arguments: '{"a":1}' } }),
      'cut:{"a":1}'
    );
  });

  test('пустые поля не падают', () => {
    assert.equal(AL.hashToolCall({ function: {} }), ':');
  });
});

describe('agent-loop.detectCycle', () => {
  test('меньше порога (3) — никогда не цикл', () => {
    assert.equal(AL.detectCycle([]), false);
    assert.equal(AL.detectCycle(['a']), false);
    assert.equal(AL.detectCycle(['a', 'a']), false);
  });

  test('3 одинаковых подряд → цикл', () => {
    assert.equal(AL.detectCycle(['a', 'a', 'a']), true);
  });

  test('3 одинаковых в конце (с историей до) → цикл', () => {
    assert.equal(AL.detectCycle(['x', 'b', 'a', 'a', 'a']), true);
  });

  test('перемешанные последние 3 → не цикл', () => {
    assert.equal(AL.detectCycle(['a', 'a', 'b']), false);
    assert.equal(AL.detectCycle(['a', 'b', 'a']), false);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * trimHistory / compressToolHistory — усечение контекста
 * ═══════════════════════════════════════════════════════════════ */
describe('agent-loop.trimHistory', () => {
  test('пустой/не-массив возвращается как есть', () => {
    assert.deepEqual(AL.trimHistory([], 5), []);
    assert.equal(AL.trimHistory(null, 5), null);
  });

  test('system-сообщения всегда сохраняются + последние N non-system', () => {
    const msgs = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' }
    ];
    const out = AL.trimHistory(msgs, 2);
    assert.deepEqual([...out].map((m) => m.content), ['S', 'u2', 'a2']);
  });

  test('keep не начинается с tool-сообщения (иначе FM 400)', () => {
    const msgs = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 't' },
      { role: 'user', content: 'u2' }
    ];
    const out = AL.trimHistory(msgs, 2);
    assert.equal(out[0].role, 'system');
    assert.ok(out.every((m) => m.role !== 'tool' || out.some((x) => x.role === 'assistant' && x.tool_calls)),
      'tool без своей пары не должен оказаться в начале');
    assert.equal(out[1].content, 'u2');
  });

  test('осиротевший assistant+tool_calls в начале отбрасывается', () => {
    const msgs = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 't' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' }
    ];
    const out = AL.trimHistory(msgs, 4);
    assert.equal(out[0].content, 'S');
    assert.ok(![...out].some((m) => m.role === 'tool'), 'осиротевший tool должен уйти');
    assert.deepEqual([...out].slice(1).map((m) => m.content), ['u2', 'a2']);
  });
});

describe('agent-loop.compressToolHistory', () => {
  function bigTool(id) {
    return { role: 'tool', tool_call_id: id, content: 'x'.repeat(700) };
  }

  test('последние 4 tool-результата — полные, более старые усечены до 600 байт', () => {
    const msgs = [bigTool('t0'), bigTool('t1'), bigTool('t2'), bigTool('t3'), bigTool('t4'), bigTool('t5')];
    const out = AL.compressToolHistory(msgs);
    /* свежие 4 (t2..t5) — полные */
    assert.equal(out[5].content.length, 700);
    assert.equal(out[2].content.length, 700);
    /* старые 2 (t0,t1) — усечены */
    assert.ok(out[0].content.length < 700);
    assert.ok(/\[truncated 100 bytes/.test(out[0].content));
    assert.ok(/\[truncated 100 bytes/.test(out[1].content));
  });

  test('порядок сообщений и tool_call_id сохраняются', () => {
    const msgs = [bigTool('t0'), bigTool('t1'), bigTool('t2'), bigTool('t3'), bigTool('t4'), bigTool('t5')];
    const out = AL.compressToolHistory(msgs);
    assert.deepEqual([...out].map((m) => m.tool_call_id), ['t0', 't1', 't2', 't3', 't4', 't5']);
  });

  test('не-tool сообщения не трогаются', () => {
    const msgs = [{ role: 'user', content: 'u' }, bigTool('t0')];
    const out = AL.compressToolHistory(msgs);
    assert.equal(out[0].content, 'u');
  });
});

/* ═══════════════════════════════════════════════════════════════
 * runAgentLoop — интеграция с mock CloudRuClient
 * ═══════════════════════════════════════════════════════════════ */
function makeMock(responses) {
  let i = 0;
  const calls = [];
  const client = {
    chatCompletions: async function (opts) {
      calls.push(opts);
      const r = typeof responses === 'function' ? responses(i) : responses[i];
      i++;
      return r;
    }
  };
  return { client, calls: () => calls };
}

function baseOpts(extra) {
  return Object.assign(
    {
      settings: { baseUrl: 'http://x', apiKey: 'k', chatModel: 'm' },
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolExecutors: {},
      maxSteps: 8
    },
    extra || {}
  );
}

describe('runAgentLoop (mock CloudRuClient)', () => {
  test('финальный ответ без tool_calls завершает цикл', async () => {
    const { client, calls } = makeMock([{ choices: [{ message: { content: 'Готово' } }] }]);
    const { runAgentLoop } = loadAgentLoop(client);
    const res = await runAgentLoop(baseOpts());
    assert.equal(res.finalText, 'Готово');
    assert.equal(res.aborted, false);
    assert.equal(calls().length, 1);
  });

  test('один tool_call → исполнение → финальный ответ', async () => {
    const { client, calls } = makeMock([
      { choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'echo', arguments: '{"v":7}' } }] } }] },
      { choices: [{ message: { content: 'done' } }] }
    ]);
    const { runAgentLoop } = loadAgentLoop(client);
    let received = null;
    const res = await runAgentLoop(baseOpts({
      toolExecutors: { echo: async (a) => { received = a; return { ok: a.v }; } }
    }));
    assert.deepEqual(received, { v: 7 });
    assert.equal(res.finalText, 'done');
    assert.equal(calls().length, 2);
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    assert.deepEqual(JSON.parse(toolMsg.content), { ok: 7 });
  });

  test('зацикливание (3 одинаковых tool_call) останавливает цикл', async () => {
    const sameCall = { choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'spin', arguments: '{}' } }] } }] };
    const { client, calls } = makeMock(() => sameCall);
    const { runAgentLoop } = loadAgentLoop(client);
    const res = await runAgentLoop(baseOpts({
      toolExecutors: { spin: async () => ({ again: true }) },
      maxSteps: 20
    }));
    assert.equal(res.cycleDetected, true);
    assert.equal(calls().length, 3);
    assert.ok(/зацикливание/i.test(res.finalText));
  });

  test('неизвестный инструмент → tool-результат с ошибкой, цикл продолжается', async () => {
    const { client } = makeMock([
      { choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'nope', arguments: '{}' } }] } }] },
      { choices: [{ message: { content: 'ладно' } }] }
    ]);
    const { runAgentLoop } = loadAgentLoop(client);
    const res = await runAgentLoop(baseOpts());
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    assert.ok(/Неизвестный инструмент: nope/.test(toolMsg.content));
    assert.equal(res.finalText, 'ладно');
  });

  test('исключение в executor → tool-результат с error, без падения цикла', async () => {
    const { client } = makeMock([
      { choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'boom', arguments: '{}' } }] } }] },
      { choices: [{ message: { content: 'recovered' } }] }
    ]);
    const { runAgentLoop } = loadAgentLoop(client);
    const res = await runAgentLoop(baseOpts({
      toolExecutors: { boom: async () => { throw new Error('взрыв'); } }
    }));
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    assert.ok(/взрыв/.test(toolMsg.content));
    assert.equal(res.finalText, 'recovered');
  });

  test('достижение maxSteps добавляет сообщение о лимите', async () => {
    /* разные аргументы каждый шаг — чтобы не сработал cycle-detector */
    const { client, calls } = makeMock((i) => ({
      choices: [{ message: { tool_calls: [{ id: 'c' + i, function: { name: 'step', arguments: JSON.stringify({ n: i }) } }] } }]
    }));
    const { runAgentLoop } = loadAgentLoop(client);
    const res = await runAgentLoop(baseOpts({
      toolExecutors: { step: async () => ({ ok: true }) },
      maxSteps: 2
    }));
    assert.equal(calls().length, 2);
    const last = res.messages[res.messages.length - 1];
    assert.ok(/Достигнут лимит шагов/.test(last.content));
  });
});

/* ═══════════════════════════════════════════════════════════════
 * AgentLoopStats — ETA per-model (EMA времени до первого ответа)
 * ═══════════════════════════════════════════════════════════════ */
describe('agent-loop.AgentLoopStats (ETA)', () => {
  test('нет данных → expectedLatencyMs возвращает null', () => {
    const { AgentLoopStats } = loadAgentLoop();
    assert.equal(AgentLoopStats.expectedLatencyMs('glm-5.1'), null);
  });

  test('первый замер → значение как есть; повторные → EMA 0.7/0.3', () => {
    const { AgentLoopStats } = loadAgentLoop();
    AgentLoopStats.recordModelLatency('m', 1000);
    assert.equal(AgentLoopStats.expectedLatencyMs('m'), 1000);
    AgentLoopStats.recordModelLatency('m', 2000);
    assert.equal(AgentLoopStats.expectedLatencyMs('m'), 1300); // 1000*0.7 + 2000*0.3
  });

  test('сиды из live-замеров: GLM-5.1 c thinking ~45с, без — 1.5с', () => {
    const { AgentLoopStats } = loadAgentLoop();
    assert.equal(AgentLoopStats.expectedLatencyMs('zai-org/GLM-5.1#think'), 45000);
    assert.equal(AgentLoopStats.expectedLatencyMs('zai-org/GLM-5.1'), 1500);
    assert.equal(AgentLoopStats.expectedLatencyMs('openai/gpt-oss-120b'), 1500);
  });

  test('мусорные входы игнорируются', () => {
    const { AgentLoopStats } = loadAgentLoop();
    AgentLoopStats.recordModelLatency('', 500);
    AgentLoopStats.recordModelLatency('m', -5);
    AgentLoopStats.recordModelLatency('m', NaN);
    AgentLoopStats.recordModelLatency(null, 500);
    assert.equal(AgentLoopStats.expectedLatencyMs('m'), null);
  });

  test('runAgentLoop без стриминга записывает латентность модели', async () => {
    let resolveCall;
    const client = {
      chatCompletions: () => new Promise((res) => { resolveCall = res; })
    };
    const { runAgentLoop, AgentLoopStats } = loadAgentLoop(client);
    const p = runAgentLoop({
      settings: { activeAgentModel: 'test-model' },
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolExecutors: {}
    });
    // даём запросу «повисеть» >0мс, затем отвечаем
    await new Promise((r) => setTimeout(r, 15));
    resolveCall({ choices: [{ message: { content: 'ok' } }] });
    await p;
    const eta = AgentLoopStats.expectedLatencyMs('test-model');
    assert.ok(typeof eta === 'number' && eta >= 10, 'ETA должна быть записана (' + eta + ')');
  });

  test('onStatus phase=llm содержит model и etaMs после первого замера', async () => {
    const client = {
      chatCompletions: async () => ({ choices: [{ message: { content: 'ok' } }] })
    };
    const { runAgentLoop } = loadAgentLoop(client);
    const events = [];
    const opts = {
      settings: { activeAgentModel: 'm2' },
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolExecutors: {},
      onStatus: (ev) => events.push(ev)
    };
    await runAgentLoop(opts);          // первый прогон — пишет латентность
    await runAgentLoop(opts);          // второй — должен отдать etaMs
    const llmEvents = events.filter((e) => e.phase === 'llm');
    assert.equal(llmEvents[0].model, 'm2');
    assert.equal(llmEvents[0].etaMs, null);
    const second = llmEvents[llmEvents.length - 1];
    assert.ok(typeof second.etaMs === 'number' && second.etaMs >= 0);
    assert.ok(/Запрос к FM: m2/.test(second.message));
  });
});
