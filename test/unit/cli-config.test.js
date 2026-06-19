// bin/config.js 配置解析单元测试
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveConfig, parseEnvFile, loadEnvUp, DEFAULT_BASE } = require('../../bin/config');

test('parseEnvFile: 基本 KEY=VALUE', () => {
  const tmp = path.join(os.tmpdir(), '.env-test-' + process.pid);
  fs.writeFileSync(tmp, 'MCP_TOKEN=abc123\nJPAGE_BASE=http://1.2.3.4:8858\n');
  const parsed = parseEnvFile(tmp);
  assert.strictEqual(parsed.MCP_TOKEN, 'abc123');
  assert.strictEqual(parsed.JPAGE_BASE, 'http://1.2.3.4:8858');
  fs.unlinkSync(tmp);
});

test('parseEnvFile: 去引号 + 跳过注释/空行', () => {
  const tmp = path.join(os.tmpdir(), '.env-test2-' + process.pid);
  fs.writeFileSync(tmp, '# 注释\nFOO="bar baz"\nQUOTED=\'single\'\n\n');
  const parsed = parseEnvFile(tmp);
  assert.strictEqual(parsed.FOO, 'bar baz');
  assert.strictEqual(parsed.QUOTED, 'single');
  fs.unlinkSync(tmp);
});

test('parseEnvFile: 不存在返回空对象', () => {
  assert.deepStrictEqual(parseEnvFile('/no/such/path/.env'), {});
});

test('resolveConfig: --token 最高优先级', () => {
  const r = resolveConfig({ token: 'cli' }, { JPAGE_TOKEN: 'env', MCP_TOKEN: 'global' });
  assert.strictEqual(r.token, 'cli');
});

test('resolveConfig: JPAGE_TOKEN 高于 MCP_TOKEN', () => {
  const r = resolveConfig({}, { JPAGE_TOKEN: 'jp', MCP_TOKEN: 'mc' });
  assert.strictEqual(r.token, 'jp');
});

test('resolveConfig: 回退 MCP_TOKEN', () => {
  const r = resolveConfig({}, { MCP_TOKEN: 'mc' });
  assert.strictEqual(r.token, 'mc');
});

test('resolveConfig: 无 token 返回 null', () => {
  // 用临时 cwd，避免读到项目根的 .env（其中有 MCP_TOKEN）造成泄漏
  const cleanCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jpage-clean-'));
  try {
    const r = resolveConfig({}, {}, cleanCwd);
    assert.strictEqual(r.token, null);
  } finally {
    fs.rmSync(cleanCwd, { recursive: true, force: true });
  }
});

test('resolveConfig: --base 优先于环境变量', () => {
  const r = resolveConfig({ base: 'http://cli:9' }, { JPAGE_BASE: 'http://env:9' });
  assert.strictEqual(r.base, 'http://cli:9');
});

test('resolveConfig: base 去尾部斜杠', () => {
  const r = resolveConfig({ base: 'http://x:9///' }, {});
  assert.strictEqual(r.base, 'http://x:9');
});

test('resolveConfig: 默认 base', () => {
  assert.strictEqual(resolveConfig({}, {}).base, DEFAULT_BASE);
});

test('loadEnvUp: 向上查找 .env 并合并', () => {
  // 在临时目录树里放 .env，验证向上查找
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jpage-env-'));
  const sub = path.join(root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'MCP_TOKEN=root-token\nJPAGE_BASE=http://root:9\n');
  const loaded = loadEnvUp(sub);
  assert.strictEqual(loaded.MCP_TOKEN, 'root-token');
  assert.strictEqual(loaded.JPAGE_BASE, 'http://root:9');
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveConfig: .env 里的 MCP_TOKEN 被用作回退', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jpage-env2-'));
  fs.writeFileSync(path.join(root, '.env'), 'MCP_TOKEN=from-file\n');
  const r = resolveConfig({}, {}, root);
  assert.strictEqual(r.token, 'from-file');
  fs.rmSync(root, { recursive: true, force: true });
});
