import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC = resolve(__dirname, '../client/shared/youtube-export.js');

export function loadYouTubeExport() {
  const code = readFileSync(SRC, 'utf8');
  const ctx = {
    Array, Object, Math, String, Number, JSON, Error, RegExp,
    console, undefined,
    module: { exports: {} },
    exports: {}
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.YouTubeExport || ctx.module.exports;
}
