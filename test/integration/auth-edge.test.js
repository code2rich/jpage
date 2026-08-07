// 鉴权与邮件边界路由集成测试。
// 覆盖 routes/auth.js 的 verify-email 重定向、change-password、profile、send-register-code、smtp-status 分支。
// 测试环境默认 ALLOW_REGISTRATION 未设（注册关闭）+ SMTP 未配置。

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

let env;
let admin;

test.before(async () => {
  env = createTestEnv();
  await env.ready();
  admin = request.agent(env.app);
  await admin.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
});

test.after(() => {
  env.cleanup();
});

// ====================== GET /verify-email 重定向分支 ======================

test('verify-email：无 token → 302 重定向到失败页', async () => {
  const res = await request(env.app).get('/api/auth/verify-email');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/#/email-verify-failed');
});

test('verify-email：无效 token → 302 重定向到失败页', async () => {
  const res = await request(env.app).get('/api/auth/verify-email?token=invalid-token-xyz');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/#/email-verify-failed');
});

// ====================== POST /change-password ======================

test('change-password：缺字段 → 400', async () => {
  const res = await admin.post('/api/auth/change-password').send({ currentPassword: 'x' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '当前密码和新密码不能为空');
});

test('change-password：新密码不足 8 位 → 400', async () => {
  const res = await admin.post('/api/auth/change-password').send({ currentPassword: 'testpassword123', newPassword: 'short' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '新密码至少 8 位');
});

test('change-password：当前密码错误 → 400', async () => {
  const res = await admin.post('/api/auth/change-password').send({ currentPassword: 'wrongpassword', newPassword: 'newpassword123' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '当前密码错误');
});

test('change-password：正确旧密码 → 200 success', async () => {
  const res = await admin.post('/api/auth/change-password').send({ currentPassword: 'testpassword123', newPassword: 'newpassword123' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  // 改回原密码，避免污染后续测试
  await admin.post('/api/auth/change-password').send({ currentPassword: 'newpassword123', newPassword: 'testpassword123' });
});

test('change-password：未登录 → 401', async () => {
  const res = await request(env.app).post('/api/auth/change-password').send({ currentPassword: 'x', newPassword: 'newpassword123' });
  assert.strictEqual(res.status, 401);
});

// ====================== POST /profile ======================

test('profile：无更新字段 → 400', async () => {
  const res = await admin.post('/api/auth/profile').send({});
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '无更新字段');
});

test('profile：用户名格式非法（含特殊字符）→ 400', async () => {
  const res = await admin.post('/api/auth/profile').send({ username: 'bad name!' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /用户名/);
});

test('profile：用户名格式非法（长度 < 2）→ 400', async () => {
  const res = await admin.post('/api/auth/profile').send({ username: 'a' });
  assert.strictEqual(res.status, 400);
});

test('profile：邮箱格式不正确 → 400', async () => {
  const res = await admin.post('/api/auth/profile').send({ email: 'not-an-email' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '邮箱格式不正确');
});

test('profile：用户名冲突 → 409', async () => {
  // admin 创建另一个用户，再尝试把 admin 改成同名
  await admin.post('/api/users').send({ username: 'conflictuser', password: 'userpass123', role: 'user' });
  const res = await admin.post('/api/auth/profile').send({ username: 'conflictuser' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error, '该用户名已被使用');
});

test('profile：合法用户名 → 200 更新成功', async () => {
  const res = await admin.post('/api/auth/profile').send({ username: 'admin_renamed' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.username, 'admin_renamed');
  // 改回
  await admin.post('/api/auth/profile').send({ username: 'admin' });
});

// ====================== POST /send-register-code ======================

test('send-register-code：注册关闭 → 403', async () => {
  // 测试环境 ALLOW_REGISTRATION 未设为 'true'，默认关闭
  const res = await request(env.app).post('/api/auth/send-register-code').send({ email: 'new@test.com' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, '注册功能未开放');
});

// ====================== POST /resend-verification ======================

test('resend-verification：未设置邮箱 → 400', async () => {
  // admin 默认无邮箱
  const res = await admin.post('/api/auth/resend-verification');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '未设置邮箱');
});

// ====================== GET /smtp-status & /registration-status ======================

test('smtp-status：返回 configured 布尔字段', async () => {
  const res = await request(env.app).get('/api/auth/smtp-status');
  assert.strictEqual(res.status, 200);
  assert.ok('configured' in res.body);
  assert.strictEqual(typeof res.body.configured, 'boolean');
});

test('registration-status：返回 enabled 字段（测试环境为 false）', async () => {
  const res = await request(env.app).get('/api/auth/registration-status');
  assert.strictEqual(res.status, 200);
  assert.ok('enabled' in res.body);
  assert.strictEqual(res.body.enabled, false);
});
