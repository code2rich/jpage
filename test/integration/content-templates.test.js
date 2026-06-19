// 内容模板市场集成测试：公开匿名访问 / 创建校验 / owner-or-admin 权限 / use 计数。
// 挂载点 /api/content-templates。/public 与 /public/:id/preview 匿名可访问。
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

// --- 公开端点（匿名） ---
test('匿名 GET /api/content-templates/public → 200', async () => {
  const res = await request(env.app).get('/api/content-templates/public');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.templates));
});

test('匿名 GET /api/content-templates/scenes → 401（需登录）', async () => {
  const res = await request(env.app).get('/api/content-templates/scenes');
  assert.strictEqual(res.status, 401);
});

test('登录 GET /api/content-templates/scenes → 200，返回场景列表', async () => {
  const res = await adminAgent.get('/api/content-templates/scenes');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.scenes));
  assert.ok(res.body.scenes.includes('dashboard'));
});

// --- 列表（需登录） ---
test('未登录 GET /api/content-templates → 401', async () => {
  const res = await request(env.app).get('/api/content-templates');
  assert.strictEqual(res.status, 401);
});

test('登录 GET /api/content-templates → 200', async () => {
  const res = await adminAgent.get('/api/content-templates');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.templates));
});

// --- 创建 + 校验 ---
test('创建模板：缺标题 → 400', async () => {
  const res = await adminAgent.post('/api/content-templates').send({ content: '<p>x</p>' });
  assert.strictEqual(res.status, 400);
});

test('创建模板：缺内容 → 400', async () => {
  const res = await adminAgent.post('/api/content-templates').send({ title: '无内容模板' });
  assert.strictEqual(res.status, 400);
});

test('创建模板：非法 fileType → 400', async () => {
  const res = await adminAgent.post('/api/content-templates').send({ title: 't', content: 'x', fileType: 'pdf' });
  assert.strictEqual(res.status, 400);
});

test('创建模板：happy path → 200，返回 id', async () => {
  const res = await adminAgent.post('/api/content-templates').send({
    title: '仪表板模板',
    description: '示例',
    fileType: 'html',
    scene: 'dashboard',
    content: '<div class="dashboard">hello</div>',
    isPublic: true,
  });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.id);
});

// --- owner-or-admin 权限 ---
test('普通用户不能访问他人私有模板 → 403', async () => {
  // admin 建私有模板
  const create = await adminAgent.post('/api/content-templates').send({
    title: '私密模板',
    fileType: 'html',
    content: '<p>private</p>',
    isPublic: false,
  });
  // 普通用户读详情 → 403
  const res = await userAgent.get(`/api/content-templates/${create.body.id}`);
  assert.strictEqual(res.status, 403);
});

test('所有者可读自己的私有模板 → 200', async () => {
  const create = await adminAgent.post('/api/content-templates').send({
    title: '我的私密',
    fileType: 'html',
    content: '<p>mine</p>',
    isPublic: false,
  });
  const res = await adminAgent.get(`/api/content-templates/${create.body.id}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.title, '我的私密');
});

test('普通用户不能改他人模板 → 403', async () => {
  const create = await adminAgent.post('/api/content-templates').send({
    title: '他人模板',
    fileType: 'html',
    content: '<p>x</p>',
  });
  const res = await userAgent.put(`/api/content-templates/${create.body.id}`).send({ title: '篡改' });
  assert.strictEqual(res.status, 403);
});

// --- use 计数 ---
test('POST /api/content-templates/:id/use → 200，use_count 递增', async () => {
  const create = await adminAgent.post('/api/content-templates').send({
    title: '使用计数模板',
    fileType: 'html',
    content: '<p>use me</p>',
  });
  const before = await adminAgent.get(`/api/content-templates/${create.body.id}`);
  const useCountBefore = before.body.use_count || 0;
  const use = await adminAgent.post(`/api/content-templates/${create.body.id}/use`);
  assert.strictEqual(use.status, 200);
  assert.ok(use.body.use_count > useCountBefore);
});

// --- 删除 ---
test('所有者删除模板 → 200，再读 404', async () => {
  const create = await adminAgent.post('/api/content-templates').send({
    title: '待删模板',
    fileType: 'html',
    content: '<p>bye</p>',
  });
  const del = await adminAgent.delete(`/api/content-templates/${create.body.id}`);
  assert.strictEqual(del.status, 200);
  const after = await adminAgent.get(`/api/content-templates/${create.body.id}`);
  assert.strictEqual(after.status, 404);
});
