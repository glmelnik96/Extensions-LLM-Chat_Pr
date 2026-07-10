/**
 * Загружает browser-IIFE cloudru-client.js в Node-контексте.
 * Возвращает чистые internals (_cloudRuInternals): normalizeBase, apiV1Root,
 * parseJsonResponse, isPayloadTooLarge, isRetryable, parseSSEStream.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadCloudRuClient(sandboxExtras) {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'cloudru-client.js');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error('cloudru-client.js: expected footer ' + marker);
  }
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);

  const root = {};
  const sandbox = {
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
    TextDecoder,
    setTimeout,
    clearTimeout,
    console,
    undefined
  };
  if (sandboxExtras) Object.assign(sandbox, sandboxExtras);
  vm.runInNewContext(src, sandbox, { filename: 'cloudru-client.js' });

  if (!root._cloudRuInternals) {
    throw new Error('_cloudRuInternals not attached to root');
  }
  return root._cloudRuInternals;
}

/**
 * Фейковый Response с .body.getReader() для тестов parseSSEStream.
 * Принимает строку (SSE-поток), произвольно нарезает её на байтовые чанки.
 */
export function makeSSEResponse(sseText, chunkSize) {
  const bytes = new TextEncoder().encode(sseText);
  const size = chunkSize || bytes.length;
  let offset = 0;
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (offset >= bytes.length) return { done: true, value: undefined };
            const end = Math.min(offset + size, bytes.length);
            const value = bytes.slice(offset, end);
            offset = end;
            return { done: false, value };
          },
          releaseLock() {}
        };
      }
    }
  };
}
