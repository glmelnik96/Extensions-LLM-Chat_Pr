/**
 * Загружает browser-IIFE agent-loop.js в Node-контексте.
 * Возвращает чистые internals (_agentLoopInternals) + runAgentLoop.
 * Опционально принимает mock CloudRuClient для интеграционных тестов цикла.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadAgentLoop(mockCloudRuClient) {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'agent-loop.js');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error('agent-loop.js: expected footer ' + marker);
  }
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);

  const root = {};
  vm.runInNewContext(
    src,
    {
      root,
      window: root,
      CloudRuClient: mockCloudRuClient,
      Promise,
      Date,
      Array,
      Object,
      Math,
      String,
      Number,
      JSON,
      Error,
      RegExp,
      setTimeout,
      console,
      undefined
    },
    { filename: 'agent-loop.js' }
  );

  if (!root._agentLoopInternals) {
    throw new Error('_agentLoopInternals not attached to root');
  }
  return {
    internals: root._agentLoopInternals,
    runAgentLoop: root.runAgentLoop,
    AgentLoopStats: root.AgentLoopStats
  };
}
