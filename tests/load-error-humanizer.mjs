/**
 * Загружает browser-IIFE error-humanizer.js в Node (подмена window на root).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadErrorHumanizer() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'error-humanizer.js');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error('error-humanizer.js: expected footer ' + marker);
  }
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);
  const root = {};
  vm.runInNewContext(src, { root, console }, { filename: 'error-humanizer.js' });
  if (!root.ErrorHumanizer) {
    throw new Error('ErrorHumanizer not attached to root');
  }
  return root.ErrorHumanizer;
}
