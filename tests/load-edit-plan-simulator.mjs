/**
 * Загружает browser-IIFE edit-plan-simulator.js в Node-контексте.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadEditPlanSimulator() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'edit-plan-simulator.js');
  const src = fs.readFileSync(filePath, 'utf8');
  const root = {};
  vm.runInNewContext(src, { window: root, console }, { filename: 'edit-plan-simulator.js' });
  if (!root.EditPlanSimulator) {
    throw new Error('EditPlanSimulator not attached to root');
  }
  return root.EditPlanSimulator;
}
