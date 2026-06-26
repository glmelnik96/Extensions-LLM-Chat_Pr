/**
 * Загружает browser-IIFE timeline-transcribe.js в Node-контексте.
 * Подменяет window на root; AudioPreprocess можно застабить через opts.AudioPreprocess.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadTimelineTranscribe(opts) {
  opts = opts || {};
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'timeline-transcribe.js');
  let src = fs.readFileSync(filePath, 'utf8');

  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error('timeline-transcribe.js: expected footer ' + marker);
  }
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);

  const root = {};
  if (opts.AudioPreprocess) root.AudioPreprocess = opts.AudioPreprocess;

  vm.runInNewContext(
    src,
    {
      root,
      window: root,
      Promise,
      Date,
      Array,
      Object,
      Math,
      String,
      Number,
      JSON,
      Error,
      RegExp,
      isNaN,
      parseFloat,
      parseInt,
      setTimeout,
      clearTimeout,
      console,
      undefined
    },
    { filename: 'timeline-transcribe.js' }
  );

  if (!root.TimelineTranscribe) {
    throw new Error('TimelineTranscribe not attached to root');
  }
  return root.TimelineTranscribe;
}
