/** Загружает browser-IIFE usage-meter.js в Node-контексте. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Mirrors FM_DEFAULTS.pricing from client/shared/fm-defaults.js (spec 2026-07-06). */
export const defaultPricing = {
  currency: '₽',
  models: {
    'zai-org/GLM-5.1':             { inPerM: 198.86, outPerM: 829.60 },
    'deepseek-ai/DeepSeek-V4-Pro': { inPerM: 183.00, outPerM: 732.00 },
    'zai-org/GLM-4.7':             { inPerM: 549.00, outPerM: 793.00 },
    'openai/gpt-oss-120b':         { inPerM: 15.86,  outPerM: 61.00 },
    'moonshotai/Kimi-K2.6':        { inPerM: 175.68, outPerM: 725.90 }
  },
  whisperPerSec: 0.01
};

/**
 * Loads UsageMeter. usage-meter reads global.FM_DEFAULTS.pricing at call-time,
 * so injecting FM_DEFAULTS onto `root` (the IIFE's `global`) before/after run works.
 * Pass a custom fmDefaults to test the missing-pricing branch (e.g. {}).
 */
export function loadUsageMeter(fmDefaults) {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'usage-meter.js');
  const src = fs.readFileSync(filePath, 'utf8');
  const root = {};
  root.FM_DEFAULTS = fmDefaults === undefined
    ? { pricing: defaultPricing }
    : fmDefaults;
  // Run in host realm so returned plain objects share the host Object.prototype,
  // making them compatible with assert/strict deepEqual in Node ≥ 24.
  // eslint-disable-next-line no-new-func
  new Function('window', src)(root);
  if (!root.UsageMeter) throw new Error('UsageMeter not attached to root');
  return root.UsageMeter;
}
