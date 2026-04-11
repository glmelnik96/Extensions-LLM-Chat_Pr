/**
 * Загружает browser-IIFE transcript-structure.js в Node-контексте.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadTranscriptStructure() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'transcript-structure.js');
  const src = fs.readFileSync(filePath, 'utf8');
  const root = {};
  vm.runInNewContext(src, { window: root, console, Promise, Date, Math, Array, String, Number, JSON, Object, Error, RegExp, parseInt, parseFloat, isNaN, isFinite, undefined }, { filename: 'transcript-structure.js' });
  if (!root.TranscriptStructure) {
    throw new Error('TranscriptStructure not attached to root');
  }
  return root.TranscriptStructure;
}
