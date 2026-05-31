/**
 * Загружает browser-IIFE deterministic-pipelines.js в Node-контексте.
 * Подменяет window на root, подставляет stub TranscriptStructure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadDeterministicPipelines(opts) {
  opts = opts || {};
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'deterministic-pipelines.js');
  let src = fs.readFileSync(filePath, 'utf8');

  /* Заменяем (window) на (root) для Node */
  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error('deterministic-pipelines.js: expected footer ' + marker);
  }
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);

  const root = {};

  /* Stub TranscriptStructure — для chapterize */
  const TranscriptStructure = opts.TranscriptStructure || {
    buildParagraphs: function () { return []; },
    buildTopicsWithLLM: function () { return Promise.resolve([]); }
  };

  /* Stub CloudRuClient */
  const CloudRuClient = opts.CloudRuClient || null;

  const sandbox = {
    root,
    console,
    Promise,
    Math,
    Array,
    String,
    Number,
    JSON,
    Object,
    Error,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    undefined,
    TranscriptStructure,
    CloudRuClient
  };
  const ctx = vm.createContext(sandbox);

  /* multicamFromAudio вызывает MulticamPlan.{framesFromRmsTimelines,buildSwitchPlan}.
     Грузим multicam-plan.js в ТОТ ЖЕ контекст ДО deterministic-pipelines.js.
     IIFE multicam-plan присваивает global.MulticamPlan (global здесь === sandbox). */
  const mcPath = path.join(__dirname, '..', 'client', 'shared', 'multicam-plan.js');
  const mcSrc = fs.readFileSync(mcPath, 'utf8');
  vm.runInContext(mcSrc, ctx, { filename: 'multicam-plan.js' });

  vm.runInContext(src, ctx, { filename: 'deterministic-pipelines.js' });

  if (!root.DeterministicPipelines) {
    throw new Error('DeterministicPipelines not attached to root');
  }
  return root.DeterministicPipelines;
}
