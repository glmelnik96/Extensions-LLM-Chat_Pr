/**
 * Загружает browser-IIFE context-store.js в Node: root.localStorage + require(fs/path).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadContextStoreWithTempRoot(opts) {
  opts = opts || {};
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpr-ctx-'));
  const fakeHome = path.join(tmpRoot, 'fake-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const mockOs = { homedir: function () { return fakeHome; } };
  const mem = new Map();
  /* opts.localStorage — подмена (например, бросающая SecurityError/QuotaExceeded,
     как в CEF при отключённом/переполненном localStorage). */
  const root = {
    localStorage: opts.localStorage || {
      getItem(k) {
        return mem.has(k) ? mem.get(k) : null;
      },
      setItem(k, v) {
        mem.set(k, String(v));
      },
      removeItem(k) {
        mem.delete(k);
      }
    }
  };

  const filePath = path.join(__dirname, '..', 'client', 'shared', 'context-store.js');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error('context-store.js: expected footer ' + marker);
  }
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);

  const nodeRequire = (id) => {
    if (id === 'fs') return fs;
    if (id === 'path') return path;
    if (id === 'os') return mockOs;
    throw new Error('Unexpected require: ' + id);
  };

  // Свободная переменная localStorage в context-store — не global.localStorage; в браузере это свойство window.
  vm.runInNewContext(
    src,
    { root, localStorage: root.localStorage, require: nodeRequire, console },
    { filename: 'context-store.js' }
  );

  if (!root.ContextStore) {
    throw new Error('ContextStore not attached to root');
  }

  root.ContextStore.setExtensionRoot(tmpRoot);

  function cleanup() {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  return { ContextStore: root.ContextStore, tmpRoot, cleanup, root };
}
