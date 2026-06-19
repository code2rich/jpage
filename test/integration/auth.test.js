// 认证集成测试：登录 / 登出 / me / 权限边界
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

let env;

test.before(async () => {
  env = createTestEnv();
  await env.ready();
});

test.after(() => {
  env.cleanup();
});

test('未登录 GET /api/auth/me → 401', async () => {
  const res = await request(env.app).get('/api/auth/me');
  assert.strictEqual(res.status, 401);
});

test('登录错误密码 → 401', async () => {
  const res = await request(env.app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'wrongpassword' });
  assert.strictEqual(res.status, 401);
});

test('登录缺失字段 → 400', async () => {
  const res = await request(env.app)
    .post('/api/auth/login')
    .send({ username: 'admin' });
  assert.strictEqual(res.status, 400);
});

test('正确登录 → 200，返回用户信息', async () => {
  const res = await request(env.app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'testpassword123' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.username, 'admin');
  assert.strictEqual(res.body.role, 'admin');
  assert.ok(res.body.id);
  // Set-Cookie 带 jpage.sid
  assert.ok(res.headers['set-cookie']);
  assert.ok(res.headers['set-cookie'].some(c => c.startsWith('jpage.sid=')));
});

test('带 cookie 访问 /api/auth/me → 200', async () => {
  const agent = request.agent(env.app);
  await agent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
  const res = await agent.get('/api/auth/me');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.username, 'admin');
});

test('登出后再访问 /api/auth/me → 401', async () => {
  const agent = request.agent(env.app);
  await agent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
  await agent.post('/api/auth/logout');
  const res = await agent.get('/api/auth/me');
  assert.strictEqual(res.status, 401);
});

test('未登录访问受保护端点 /api/files → 401', async () => {
  const res = await request(env.app).get('/api/files');
  assert.strictEqual(res.status, 401);
});

test('未登录访问 /api/users → 401', async () => {
  const res = await request(env.app).get('/api/users');
  assert.strictEqual(res.status, 401);
});

test('非 admin 不能访问 /api/users', async () => {
  // 先用 admin 创建一个普通用户
  const adminAgent = request.agent(env.app);
  await adminAgent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
  await adminAgent.post('/api/users').send({ username: 'regular', password: 'regularpass123', role: 'user' });

  // 普通用户登录后访问 /api/users → 403
  const userAgent = request.agent(env.app);
  await userAgent.post('/api/auth/login').send({ username: 'regular', password: 'regularpass123' });
  const res = await userAgent.get('/api/users');
  assert.strictEqual(res.status, 403);
});

test('注册默认关闭（ALLOW_REGISTRATION 未设为 true）', async () => {
  const res = await request(env.app).get('/api/auth/registration-status');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.enabled, false);
});
