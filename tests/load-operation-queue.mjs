/**
 * Загружает browser-IIFE operation-queue.js в Node-контексте.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadOperationQueue() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'operation-queue.js');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error('operation-queue.js: expected footer ' + marker);
  }
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);

  const root = {};
  vm.runInNewContext(
    src,
    { root, window: root, Promise, Array, Object, console, undefined },
    { filename: 'operation-queue.js' }
  );

  if (!root.OperationQueue) {
    throw new Error('OperationQueue not attached to root');
  }
  return root.OperationQueue;
}
