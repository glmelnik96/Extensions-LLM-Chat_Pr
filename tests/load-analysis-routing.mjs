/**
 * Загружает browser-IIFE analysis-routing.js в Node-контексте.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadAnalysisRouting() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'analysis-routing.js');
  const src = fs.readFileSync(filePath, 'utf8');
  const root = {};
  vm.runInNewContext(src, {
    window: root,
    Array,
    Object,
    Math,
    String,
    Number,
    JSON,
    Error,
    RegExp,
    console,
    undefined
  }, { filename: 'analysis-routing.js' });
  if (!root.AnalysisRouting) {
    throw new Error('AnalysisRouting not attached to root');
  }
  return root.AnalysisRouting;
}
