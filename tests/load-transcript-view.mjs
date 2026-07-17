/** Загружает browser-IIFE transcript-view.js в Node-контексте. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadTranscriptView() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'transcript-view.js');
  const src = fs.readFileSync(filePath, 'utf8');
  const root = {};
  // eslint-disable-next-line no-new-func
  new Function('window', src)(root);
  if (!root.TranscriptView) throw new Error('TranscriptView not attached to root');
  return root.TranscriptView;
}
