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
