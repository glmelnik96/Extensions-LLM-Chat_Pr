/**
 * Загружает browser-IIFE tool-validators.js в Node (подмена window на root).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadToolValidators() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'tool-validators.js');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error('tool-validators.js: expected footer ' + marker);
  }
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);
  const root = {};
  vm.runInNewContext(src, { root, console }, { filename: 'tool-validators.js' });
  if (!root.ToolValidators) {
    throw new Error('ToolValidators not attached to root');
  }
  return root.ToolValidators;
}
