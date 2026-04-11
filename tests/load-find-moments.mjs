/**
 * Загружает browser-IIFE find-moments.js в Node-контексте.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadFindMoments() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'find-moments.js');
  const src = fs.readFileSync(filePath, 'utf8');
  const root = {};
  vm.runInNewContext(src, { window: root, console }, { filename: 'find-moments.js' });
  if (!root.FindMoments) {
    throw new Error('FindMoments not attached to root');
  }
  return root.FindMoments;
}
