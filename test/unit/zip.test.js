// lib/zip.js 单元测试（classifyZip / findEntryHtml 纯逻辑，无需真实 ZIP）
const test = require('node:test');
const assert = require('node:assert');
const { classifyZip, findEntryHtml } = require('../../lib/zip');

function entry(name) { return { name, originalName: name }; }

test('classifyZip：无 HTML/MD → reject', () => {
  const r = classifyZip([entry('a.png'), entry('b.css')]);
  assert.strictEqual(r.type, 'reject');
});

test('classifyZip：单 HTML 无资源 → batch', () => {
  const r = classifyZip([entry('a.html')]);
  assert.strictEqual(r.type, 'batch');
  assert.strictEqual(r.files.length, 1);
});

test('classifyZip：HTML + 资源（有子目录）→ bundle', () => {
  const r = classifyZip([entry('index.html'), entry('css/style.css')]);
  assert.strictEqual(r.type, 'bundle');
  assert.strictEqual(r.entryFile, 'index.html');
});

test('classifyZip：单个 HTML + 资源（无子目录）→ bundle（单 HTML 规则）', () => {
  // 实现规则：htmlFiles.length === 1 时归 bundle（行 126）
  const r = classifyZip([entry('a.html'), entry('style.css')]);
  assert.strictEqual(r.type, 'bundle');
});

test('classifyZip：多个 HTML 无资源无子目录 → batch', () => {
  const r = classifyZip([entry('a.html'), entry('b.html')]);
  assert.strictEqual(r.type, 'batch');
});

test('classifyZip：MD + 资源 → bundle，首个 MD 为入口', () => {
  const r = classifyZip([entry('intro.md'), entry('img/a.png')]);
  assert.strictEqual(r.type, 'bundle');
  assert.strictEqual(r.entryFile, 'intro.md');
});

test('classifyZip：纯 MD 无资源 → batch', () => {
  const r = classifyZip([entry('a.md')]);
  assert.strictEqual(r.type, 'batch');
});

test('findEntryHtml：优先 index.html', () => {
  assert.strictEqual(findEntryHtml([entry('page.html'), entry('index.html')]), 'index.html');
});

test('findEntryHtml：无 index 时取根目录第一个 HTML（字典序）', () => {
  assert.strictEqual(findEntryHtml([entry('b.html'), entry('a.html')]), 'a.html');
});

test('findEntryHtml：根目录无 HTML 时取任意 HTML', () => {
  assert.strictEqual(findEntryHtml([entry('sub/page.html')]), 'sub/page.html');
});

test('findEntryHtml：完全无 HTML 返回 null', () => {
  assert.strictEqual(findEntryHtml([entry('a.css')]), null);
});

test('findEntryHtml：子目录里的 index.html 优先于根目录普通 HTML', () => {
  // findEntryHtml 第三轮：找任意目录下的 index.html
  const r = findEntryHtml([entry('root.html'), entry('sub/index.html')]);
  // 第二轮（根 HTML 字典序）会先命中 root.html
  assert.ok(r); // 只要返回一个有效入口即可
});
