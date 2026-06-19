// 用户管理集成测试（仅 admin）：列表 / 创建 / 更新 / 删除 / 校验 / 权限边界。
// 挂载点 /api/users，全部 requireAuth + requireAdmin。
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

let env;
let adminAgent;

test.before(async () => {
  env = createTestEnv();
  await env.ready();
  adminAgent = request.agent(env.app);
  await adminAgent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
});

test.after(() => {
  env.cleanup();
});

// --- 权限边界 ---
test('未登录 GET /api/users → 401', async () => {
  const res = await request(env.app).get('/api/users');
  assert.strictEqual(res.status, 401);
});

test('普通用户 GET /api/users → 403', async () => {
  await adminAgent.post('/api/users').send({ username: 'regular', password: 'regularpass123', role: 'user' });
  const userAgent = request.agent(env.app);
  await userAgent.post('/api/auth/login').send({ username: 'regular', password: 'regularpass123' });
  const res = await userAgent.get('/api/users');
  assert.strictEqual(res.status, 403);
});

// --- 列表 ---
test('admin GET /api/users → 200，含 emailVerified 布尔', async () => {
  const res = await adminAgent.get('/api/users');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.users));
  assert.ok(res.body.users.length > 0);
  // admin 用户存在
  assert.ok(res.body.users.some(u => u.username === 'admin'));
  // emailVerified 字段存在且为布尔
  assert.strictEqual(typeof res.body.users[0].emailVerified, 'boolean');
});

// --- 创建 + 校验 ---
test('创建用户：用户名太短 → 400', async () => {
  const res = await adminAgent.post('/api/users').send({ username: 'a', password: 'validpass123', role: 'user' });
  assert.strictEqual(res.status, 400);
});

test('创建用户：密码 < 8 位 → 400', async () => {
  const res = await adminAgent.post('/api/users').send({ username: 'newuser2', password: 'short', role: 'user' });
  assert.strictEqual(res.status, 400);
});

test('创建用户：无效角色 → 400', async () => {
  const res = await adminAgent.post('/api/users').send({ username: 'newuser3', password: 'validpass123', role: 'superadmin' });
  assert.strictEqual(res.status, 400);
});

test('创建用户：缺用户名或密码 → 400', async () => {
  const res = await adminAgent.post('/api/users').send({ username: 'noname' });
  assert.strictEqual(res.status, 400);
});

test('创建用户：邮箱格式错误 → 400', async () => {
  const res = await adminAgent.post('/api/users').send({ username: 'newuser4', password: 'validpass123', role: 'user', email: 'not-an-email' });
  assert.strictEqual(res.status, 400);
});

test('创建用户：happy path → 200，返回 id', async () => {
  const res = await adminAgent.post('/api/users').send({ username: 'happyuser', password: 'validpass123', role: 'user' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.id);
  assert.strictEqual(res.body.username, 'happyuser');
  assert.strictEqual(res.body.role, 'user');
});

test('创建用户：用户名冲突 → 409', async () => {
  // happyuser 已创建
  const res = await adminAgent.post('/api/users').send({ username: 'happyuser', password: 'validpass123', role: 'user' });
  assert.strictEqual(res.status, 409);
});

// --- 更新 ---
test('更新用户：无更新字段 → 400', async () => {
  const create = await adminAgent.post('/api/users').send({ username: 'updateable', password: 'validpass123', role: 'user' });
  const res = await adminAgent.put(`/api/users/${create.body.id}`).send({});
  assert.strictEqual(res.status, 400);
});

test('更新用户：重置密码 → 200', async () => {
  const create = await adminAgent.post('/api/users').send({ username: 'pwdreset', password: 'validpass123', role: 'user' });
  const res = await adminAgent.put(`/api/users/${create.body.id}`).send({ password: 'newpassword123' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  // 用新密码能登录
  const userAgent = request.agent(env.app);
  const login = await userAgent.post('/api/auth/login').send({ username: 'pwdreset', password: 'newpassword123' });
  assert.strictEqual(login.status, 200);
});

test('更新用户：角色切换 → 200', async () => {
  const create = await adminAgent.post('/api/users').send({ username: 'roleswap', password: 'validpass123', role: 'user' });
  const res = await adminAgent.put(`/api/users/${create.body.id}`).send({ role: 'admin' });
  assert.strictEqual(res.status, 200);
});

test('更新用户：不存在 → 404', async () => {
  const res = await adminAgent.put('/api/users/999999').send({ role: 'user' });
  assert.strictEqual(res.status, 404);
});

// --- 删除 ---
test('删除用户：删自己 → 400', async () => {
  // admin 的 id 一般是 1
  const list = await adminAgent.get('/api/users');
  const admin = list.body.users.find(u => u.username === 'admin');
  const res = await adminAgent.delete(`/api/users/${admin.id}`);
  assert.strictEqual(res.status, 400);
});

test('删除用户：不存在 → 404', async () => {
  const res = await adminAgent.delete('/api/users/999999');
  assert.strictEqual(res.status, 404);
});

test('删除用户：happy path → 200', async () => {
  const create = await adminAgent.post('/api/users').send({ username: 'deleteme', password: 'validpass123', role: 'user' });
  const res = await adminAgent.delete(`/api/users/${create.body.id}`);
  assert.strictEqual(res.status, 200);
  // 再列不应有 deleteme
  const list = await adminAgent.get('/api/users');
  assert.ok(!list.body.users.some(u => u.username === 'deleteme'));
});
