/**
 * Тесты MarkdownLite — безопасный мини-рендер markdown для пузырей чата.
 * Критично: XSS-кейсы (модельный вывод попадает в innerHTML).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadMarkdownLite() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'markdown-lite.js');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) throw new Error('markdown-lite.js: expected footer ' + marker);
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);
  const root = {};
  vm.runInContext(src, vm.createContext({ root, String, RegExp }), { filename: 'markdown-lite.js' });
  return root.MarkdownLite;
}

const ML = loadMarkdownLite();

describe('MarkdownLite — безопасность (XSS)', () => {
  it('экранирует <script>', () => {
    const h = ML.render('<script>alert(1)</script>');
    assert.ok(!h.includes('<script'));
    assert.ok(h.includes('&lt;script&gt;'));
  });
  it('экранирует onerror-атрибуты', () => {
    const h = ML.render('<img src=x onerror=alert(1)>');
    assert.ok(!h.includes('<img'));
  });
  it('HTML внутри **bold** остаётся экранированным', () => {
    const h = ML.render('**<b>x</b>**');
    assert.ok(h.includes('<strong>&lt;b&gt;x&lt;/b&gt;</strong>'));
  });
  it('HTML внутри `кода` остаётся экранированным', () => {
    const h = ML.render('`<script>`');
    assert.ok(h.includes('&lt;script&gt;'));
    assert.ok(!h.includes('<script'));
  });
  it('HTML внутри fenced-блока экранирован', () => {
    const h = ML.render('```\n<script>alert(1)</script>\n```');
    assert.ok(!h.includes('<script'));
    assert.ok(h.includes('md-pre'));
  });
});

describe('MarkdownLite — рендеринг', () => {
  it('**bold** → <strong>', () => {
    assert.ok(ML.render('текст **жирный** конец').includes('<strong>жирный</strong>'));
  });
  it('*italic* → <em>', () => {
    assert.ok(ML.render('а *курсив* б').includes('<em>курсив</em>'));
  });
  it('одиночные звёздочки в выражении 2*3*4 не превращаются в курсив', () => {
    const h = ML.render('результат 2*3*4 готов');
    assert.ok(!h.includes('<em>'));
  });
  it('`код` → <code>', () => {
    assert.ok(ML.render('вызови `propose_markers`').includes('<code class="md-code">propose_markers</code>'));
  });
  it('## заголовок → .md-h2', () => {
    assert.ok(ML.render('## План').includes('md-h2'));
  });
  it('списки -/1. → <ul><li>', () => {
    const h = ML.render('- раз\n- два\n1. три');
    assert.ok(h.includes('<ul class="md-ul">'));
    assert.equal((h.match(/<li>/g) || []).length, 3);
  });
  it('fenced-блок с языком: имя языка отброшено', () => {
    const h = ML.render('```json\n{"a":1}\n```');
    assert.ok(h.includes('{&quot;a&quot;:1}'));
    assert.ok(!h.includes('json\n'));
  });
  it('пустые строки → md-gap, без дублей', () => {
    const h = ML.render('а\n\n\n\nб');
    assert.equal((h.match(/md-gap/g) || []).length, 1);
  });
  it('null/undefined → пустая строка', () => {
    assert.equal(ML.render(null), '');
    assert.equal(ML.render(undefined), '');
  });
  it('** внутри кода не превращается в bold', () => {
    const h = ML.render('`a ** b`');
    assert.ok(!h.includes('<strong>'));
  });
});
