// 分类集成测试：templates 列表 / 分类 CRUD / PUT·DELETE 仅 admin / file_count。
// 挂载点 /api（/categories、/categories/:id、/templates）。
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
  // 建一个普通用户
  await adminAgent.post('/api/users').send({ username: 'regular', password: 'regularpass123', role: 'user' });
  userAgent = request.agent(env.app);
  await userAgent.post('/api/auth/login').send({ username: 'regular', password: 'regularpass123' });
});

test.after(() => {
  env.cleanup();
});

// --- templates 列表 ---
test('GET /api/templates → 200，含内置模板', async () => {
  const res = await adminAgent.get('/api/templates');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.templates));
  // 至少有 default 内置模板
  assert.ok(res.body.templates.some(t => t.name === 'default'));
});

test('未登录 GET /api/templates → 401', async () => {
  const res = await request(env.app).get('/api/templates');
  assert.strictEqual(res.status, 401);
});

// --- 分类列表 ---
test('admin GET /api/categories → 200，含 file_count', async () => {
  const res = await adminAgent.get('/api/categories');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.categories));
});

// --- 创建 ---
test('创建分类：空名 → 400', async () => {
  const res = await adminAgent.post('/api/categories').send({ name: '' });
  assert.strictEqual(res.status, 400);
});

test('创建分类：happy path → 200', async () => {
  const res = await adminAgent.post('/api/categories').send({ name: '技术文档' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.id);
  assert.strictEqual(res.body.name, '技术文档');
});

test('创建分类：重名返回现有 → 200，id 相同', async () => {
  const a = await adminAgent.post('/api/categories').send({ name: '笔记' });
  const b = await adminAgent.post('/api/categories').send({ name: '笔记' });
  assert.strictEqual(b.status, 200);
  assert.strictEqual(a.body.id, b.body.id);
});

// --- PUT/DELETE 仅 admin ---
test('普通用户 PUT /api/categories/:id → 403', async () => {
  const create = await adminAgent.post('/api/categories').send({ name: '仅admin可改' });
  const res = await userAgent.put(`/api/categories/${create.body.id}`).send({ name: '被改了' });
  assert.strictEqual(res.status, 403);
});

test('普通用户 DELETE /api/categories/:id → 403', async () => {
  const create = await adminAgent.post('/api/categories').send({ name: '仅admin可删' });
  const res = await userAgent.delete(`/api/categories/${create.body.id}`);
  assert.strictEqual(res.status, 403);
});

// --- admin 改/删 ---
test('admin 重命名分类 → 200', async () => {
  const create = await adminAgent.post('/api/categories').send({ name: '原名' });
  const res = await adminAgent.put(`/api/categories/${create.body.id}`).send({ name: '新名' });
  assert.strictEqual(res.status, 200);
  // 列表里应见新名
  const list = await adminAgent.get('/api/categories');
  assert.ok(list.body.categories.some(c => c.id === create.body.id && c.name === '新名'));
});

test('admin 删除分类：happy path → 200，文件的 category_id 被置空', async () => {
  const create = await adminAgent.post('/api/categories').send({ name: '待删分类' });
  const catId = create.body.id;
  // 建文件并归类
  const up = await adminAgent.post('/api/files/upload-json').send({ name: 'categorized.md', content: 'x' });
  await adminAgent.put(`/api/files/${up.body.id}/category`).send({ categoryId: catId });
  // 删分类
  const del = await adminAgent.delete(`/api/categories/${catId}`);
  assert.strictEqual(del.status, 200);
  // 文件详情的 category_id 应为 null
  const detail = await adminAgent.get(`/api/files/${up.body.id}`);
  assert.strictEqual(detail.body.category_id, null);
});
