// lib/util.js 单元测试
const test = require('node:test');
const assert = require('node:assert');
const {
  now,
  generateShareKey,
  decodeFilename,
  generateReadablePassword,
  clientIp,
  currentUserId,
} = require('../../lib/util');

test('now() 返回 UTC 字符串，格式 YYYY-MM-DD HH:MM:SS', () => {
  const t = now();
  assert.match(t, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // 与 SQLite datetime('now') 一致：不含时区后缀、非 ISO 的 T 分隔
  assert.ok(!t.includes('T'));
  assert.ok(!t.includes('Z'));
});

test('generateShareKey 返回 8 位 base64url 字符串', () => {
  const key = generateShareKey();
  assert.strictEqual(key.length, 8);
  // base64url 字符集：不含 + / =
  assert.match(key, /^[A-Za-z0-9_-]+$/);
});

test('generateShareKey 随机性：连续生成不重复', () => {
  const keys = new Set();
  for (let i = 0; i < 1000; i++) keys.add(generateShareKey());
  // 8 位 base64url 理论空间 ~64^8，1000 次几乎不可能碰撞
  assert.strictEqual(keys.size, 1000);
});

test('decodeFilename：已是 UTF-8（含中文）则原样返回', () => {
  assert.strictEqual(decodeFilename('测试文件.md'), '测试文件.md');
  assert.strictEqual(decodeFilename('readme.md'), 'readme.md');
});

test('decodeFilename：latin1 包装的 UTF-8 能正确还原', () => {
  // '测试.md' 的 UTF-8 字节以 latin1 解读的字符串
  const buf = Buffer.from('测试.md', 'utf8');
  const latin1 = buf.toString('latin1');
  assert.strictEqual(decodeFilename(latin1), '测试.md');
});

test('decodeFilename：null/undefined 透传', () => {
  assert.strictEqual(decodeFilename(null), null);
  assert.strictEqual(decodeFilename(undefined), undefined);
  assert.strictEqual(decodeFilename(''), '');
});

test('generateReadablePassword：长度正确且排除易混字符', () => {
  const pwd = generateReadablePassword(16);
  assert.strictEqual(pwd.length, 16);
  // 不含 0/O/1/l/I
  assert.ok(!/[0O1lI]/.test(pwd));
});

test('clientIp：优先 X-Forwarded-For 首段', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: { remoteAddress: '9.9.9.9' } };
  assert.strictEqual(clientIp(req), '1.2.3.4');
});

test('clientIp：无代理头时回退 socket.remoteAddress', () => {
  const req = { headers: {}, socket: { remoteAddress: '9.9.9.9' } };
  assert.strictEqual(clientIp(req), '9.9.9.9');
});

test('currentUserId：优先 req.userId', () => {
  assert.strictEqual(currentUserId({ userId: 5, session: { userId: 9 } }), 5);
});

test('currentUserId：回退 session.userId', () => {
  assert.strictEqual(currentUserId({ session: { userId: 9 } }), 9);
});

test('currentUserId：都没有时返回 null', () => {
  assert.strictEqual(currentUserId({}), null);
  assert.strictEqual(currentUserId({ session: {} }), null);
});
