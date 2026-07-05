import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadStarters() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'client', 'shared', 'conversation-starters.js'),
    'utf8'
  );
  const store = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; }
  };
  const root = { localStorage, console };
  root.window = root;
  root.global = root;
  vm.runInNewContext(src, root);
  return root.ConversationStarters;
}

const CS = loadStarters();

test('montage-plan starter v2: не требует blocks и get_transcript_structure', () => {
  const s = CS.findById('textmontage', 'montage-plan');
  assert.ok(s, 'стартер montage-plan существует');
  const addon = s.systemPromptAddon;
  // v2: плагин строит план сам — модель НЕ передаёт blocks и НЕ зовёт get_transcript_structure.
  // Оба упоминаются только как явные запреты, поэтому проверяем именно negation-фразы,
  // а не отсутствие подстроки (текст addon намеренно содержит «НЕ ... blocks»).
  assert.match(addon, /НЕ\s+передавай\s+blocks/i, 'должен явно запрещать передавать blocks');
  assert.match(addon, /НЕ\s+вызывай\s+get_transcript_structure/i, 'должен явно запрещать get_transcript_structure');
  // Не должно быть позитивной инструкции строить/передавать blocks в вызов plan.
  assert.doesNotMatch(addon, /Построй\s+blocks/i, 'не должен инструктировать строить blocks');
  assert.doesNotMatch(
    addon,
    /propose_montage_plan\(\{[^}]*blocks/i,
    'сигнатура вызова не должна содержать blocks'
  );
  assert.match(addon, /propose_montage_plan/);
});
