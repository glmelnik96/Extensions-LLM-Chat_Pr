/** Загружает browser-IIFE nest-reconstruct.js в Node-контексте. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadNestReconstruct() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'nest-reconstruct.js');
  const src = fs.readFileSync(filePath, 'utf8');
  const root = {};
  // Run in host realm so returned plain objects share the host Object.prototype,
  // making them compatible with assert/strict deepEqual in Node ≥ 24.
  // eslint-disable-next-line no-new-func
  new Function('window', src)(root);
  if (!root.NestReconstruct) throw new Error('NestReconstruct not attached to root');
  return root.NestReconstruct;
}
