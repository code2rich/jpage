// 用量统计集成测试：存储、API 调用、短链浏览等统计项。
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

let env;
let adminAgent;
let userAgent;

test.before(async () => {
  env = createTestEnv();
  await env.ready();
  adminAgent = request.agent(env.app);
  await adminAgent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
  await adminAgent.post('/api/users').send({ username: 'regular', password: 'regularpass123', role: 'user' });
  userAgent = request.agent(env.app);
  await userAgent.post('/api/auth/login').send({ username: 'regular', password: 'regularpass123' });
});

test.after(() => {
  env.cleanup();
});

// ---------- 个人用量 ----------
test('GET /api/users/me/usage → 未登录 401', async () => {
  const res = await request(env.app).get('/api/users/me/usage');
  assert.strictEqual(res.status, 401);
});

test('普通用户初始用量为 0', async () => {
  const res = await userAgent.get('/api/users/me/usage');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.storageBytes, 0);
  assert.strictEqual(res.body.fileCount, 0);
  assert.strictEqual(res.body.apiCallsTotal, 0);
  assert.deepStrictEqual(res.body.apiCallsBySource, {});
  assert.strictEqual(res.body.shortLinkViews, 0);
  assert.strictEqual(res.body.storageQuota, null);
});

test('上传文件后个人用量增加', async () => {
  const before = await userAgent.get('/api/users/me/usage');

  const content = '# Hello\nusage test';
  const upload = await userAgent
    .post('/api/files/upload-json')
    .set('X-Upload-Source', 'cli')
    .send({ name: 'usage.md', content });
  assert.strictEqual(upload.status, 200);
  const size = Buffer.byteLength(content, 'utf-8');

  const after = await userAgent.get('/api/users/me/usage');
  assert.strictEqual(after.body.storageBytes, (before.body.storageBytes || 0) + size);
  assert.strictEqual(after.body.fileCount, 1);
  assert.ok(after.body.apiCallsTotal > before.body.apiCallsTotal);
  assert.ok(after.body.apiCallsBySource.cli >= 1);
});

// ---------- admin 全局统计 ----------
test('admin stats 包含用量相关字段', async () => {
  const res = await adminAgent.get('/api/admin/stats');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof res.body.userCount, 'number');
  assert.strictEqual(typeof res.body.totalStorageBytes, 'number');
  assert.strictEqual(typeof res.body.totalShortLinkViews, 'number');
  assert.strictEqual(typeof res.body.totalApiCalls, 'number');
  assert.ok(typeof res.body.apiCallsBySource === 'object' && res.body.apiCallsBySource !== null);
});

test('admin stats 的 totalStorageBytes 与已上传文件大小一致', async () => {
  const content = '<p>admin stats test</p>';
  const upload = await userAgent
    .post('/api/files/upload-json')
    .set('X-Upload-Source', 'mcp')
    .send({ name: 'adminstats.html', content });
  assert.strictEqual(upload.status, 200);

  const stats = await adminAgent.get('/api/admin/stats');
  assert.ok(stats.body.totalStorageBytes >= Buffer.byteLength(content, 'utf-8'));
  assert.ok(stats.body.totalApiCalls >= 1);
  assert.ok(stats.body.apiCallsBySource.mcp >= 1 || stats.body.apiCallsBySource.cli >= 1);
});

// ---------- 删除释放存储 ----------
test('删除文件后个人存储减少', async () => {
  const content = 'delete me';
  const upload = await userAgent
    .post('/api/files/upload-json')
    .send({ name: 'todelete.html', content });
  assert.strictEqual(upload.status, 200);
  const before = await userAgent.get('/api/users/me/usage');

  const del = await userAgent.delete(`/api/files/${upload.body.id}`);
  assert.strictEqual(del.status, 200);

  const after = await userAgent.get('/api/users/me/usage');
  assert.strictEqual(after.body.storageBytes, before.body.storageBytes - Buffer.byteLength(content, 'utf-8'));
  assert.strictEqual(after.body.fileCount, before.body.fileCount - 1);
});
