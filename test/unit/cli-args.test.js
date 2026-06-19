// bin/args.js argv 解析器单元测试
const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../../bin/args');

test('parse: 空数组 → cmd/sub 为 null', () => {
  const r = parse([]);
  assert.strictEqual(r.cmd, null);
  assert.strictEqual(r.sub, null);
  assert.deepStrictEqual(r.opts, {});
  assert.deepStrictEqual(r.positional, []);
});

test('parse: 单命令', () => {
  const r = parse(['ls']);
  assert.strictEqual(r.cmd, 'ls');
  assert.strictEqual(r.sub, null);
  assert.deepStrictEqual(r.positional, ['ls']);
});

test('parse: 命令 + 子命令', () => {
  const r = parse(['skills', 'ls']);
  assert.strictEqual(r.cmd, 'skills');
  assert.strictEqual(r.sub, 'ls');
  assert.deepStrictEqual(r.positional, ['skills', 'ls']);
});

test('parse: 命令 + 位置参数（3 个）', () => {
  const r = parse(['mv', '12', 'new.html']);
  assert.strictEqual(r.cmd, 'mv');
  assert.strictEqual(r.sub, '12');
  assert.deepStrictEqual(r.positional, ['mv', '12', 'new.html']);
});

test('parse: --key value 形式', () => {
  const r = parse(['ls', '--page', '2', '--limit', '50']);
  assert.strictEqual(r.opts.page, '2');
  assert.strictEqual(r.opts.limit, '50');
});

test('parse: --key=value 形式', () => {
  const r = parse(['ls', '--page=2', '--limit=50']);
  assert.strictEqual(r.opts.page, '2');
  assert.strictEqual(r.opts.limit, '50');
});

test('parse: 布尔标志（无值）', () => {
  const r = parse(['upload', 'a.html', '--public']);
  assert.strictEqual(r.opts.public, true);
  assert.deepStrictEqual(r.positional, ['upload', 'a.html']);
});

test('parse: 布尔标志后跟另一个选项时识别为布尔', () => {
  const r = parse(['upload', 'a.html', '--public', '--token', 'x']);
  assert.strictEqual(r.opts.public, true);
  assert.strictEqual(r.opts.token, 'x');
});

test('parse: -- 后内容全部当位置参数', () => {
  const r = parse(['cat', '--', '--weird-id']);
  assert.deepStrictEqual(r.positional, ['cat', '--weird-id']);
  assert.strictEqual(r.opts['weird-id'], undefined);
});

test('parse: 选项在命令之前也能解析', () => {
  const r = parse(['--token', 'abc', 'ls', '--page', '1']);
  assert.strictEqual(r.opts.token, 'abc');
  assert.strictEqual(r.cmd, 'ls');
  assert.strictEqual(r.opts.page, '1');
});

test('parse: --token=value 与位置参数混合', () => {
  const r = parse(['--token=abc', 'upload', 'x.html']);
  assert.strictEqual(r.opts.token, 'abc');
  assert.strictEqual(r.cmd, 'upload');
  assert.strictEqual(r.sub, 'x.html');
});

test('parse: 末尾布尔标志（无后续 token）', () => {
  const r = parse(['upload', 'x.html', '--public']);
  assert.strictEqual(r.opts.public, true);
});

test('parse: 多个布尔标志', () => {
  const r = parse(['x', '--public', '--verbose']);
  assert.strictEqual(r.opts.public, true);
  assert.strictEqual(r.opts.verbose, true);
});
