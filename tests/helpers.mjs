/**
 * Общий лоадер browser-IIFE модулей в Node (ревью тестов 06.08.2026).
 *
 * Все модули client/shared — IIFE вида `(function (global) {...})(window)` или
 * UMD-хвост `typeof window !== 'undefined' ? window : ...`: достаточно передать
 * `root` под именем window. Заменил 13 почти одинаковых load-*.mjs.
 *
 * new Function исполняет код в host-realm: возвращённые объекты делят
 * Object.prototype с Node, поэтому assert/strict deepEqual работает
 * (в vm.runInNewContext — другой realm, deepEqual на Node ≥ 24 ломается;
 * см. бывший load-nest-reconstruct.mjs).
 *
 * Специализированные лоадеры (стабы зависимостей, моки клиентов, opts) живут
 * отдельно: load-context-store, load-cloudru-client, load-usage-meter,
 * load-agent-loop, load-timeline-transcribe, load-deterministic-pipelines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} relFile — путь от корня репо, напр. 'client/shared/find-moments.js'
 * @param {string} globalName — имя глобала, который IIFE вешает на window
 * @param {object} [root] — заготовка window (для пресетов вроде FM_DEFAULTS)
 * @returns {*} root[globalName]
 */
export function loadIife(relFile, globalName, root = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', relFile), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', src)(root);
  if (!root[globalName]) {
    throw new Error(globalName + ' not attached to window by ' + relFile);
  }
  return root[globalName];
}
