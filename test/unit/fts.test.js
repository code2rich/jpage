// lib/fts.js 单元测试
const test = require('node:test');
const assert = require('node:assert');
const { escapeFtsQuery, isFtsIndexable } = require('../../lib/fts');

test('isFtsIndexable：可索引扩展名', () => {
  assert.ok(isFtsIndexable('html', 'a.html'));
  assert.ok(isFtsIndexable('markdown', 'b.md'));
  assert.ok(isFtsIndexable('html', 'c.MD')); // 大写
  assert.ok(isFtsIndexable('markdown', 'd.markdown'));
  assert.ok(isFtsIndexable('text', 'e.txt'));
  assert.ok(isFtsIndexable('html', 'f.HTM'));
});

test('isFtsIndexable：不可索引', () => {
  assert.ok(!isFtsIndexable('bundle', 'a.html')); // bundle 永不索引
  assert.ok(!isFtsIndexable('html', 'a.png'));
  assert.ok(!isFtsIndexable('html', 'noext'));
  assert.ok(!isFtsIndexable('html', ''));
});

test('escapeFtsQuery：移除 FTS5 特殊字符（特殊字符替换为空格后分词）', () => {
  const r = escapeFtsQuery('hello"world*test');
  // " 和 * 是 FTS5 特殊字符，替换为空格后分成三个 token
  assert.strictEqual(r, '"hello" "world" "test"');
});

test('escapeFtsQuery：空查询返回空串', () => {
  assert.strictEqual(escapeFtsQuery(''), '');
  assert.strictEqual(escapeFtsQuery('   '), '');
  assert.strictEqual(escapeFtsQuery('"*()'), '');
});

test('escapeFtsQuery：每个 token 被双引号包裹', () => {
  const r = escapeFtsQuery('hello world');
  assert.strictEqual(r, '"hello" "world"');
});

test('escapeFtsQuery：CJK 逐字分词', () => {
  const r = escapeFtsQuery('测试');
  // 每个 CJK 字符前后加空格，最终每个字单独成 token
  assert.ok(r.includes('"测"'));
  assert.ok(r.includes('"试"'));
});

test('escapeFtsQuery：CJK + ASCII 混合', () => {
  const r = escapeFtsQuery('api 测试');
  assert.ok(r.includes('"api"'));
  assert.ok(r.includes('"测"'));
  assert.ok(r.includes('"试"'));
});
