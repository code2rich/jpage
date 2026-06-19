// 关联路由集成测试：标签关联 / 收藏 / 分类设置 / 访问统计 的权限与校验分支。
// 覆盖 routes/files/associations.js 的 404、403 非所有者、400 校验失败等分支。

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

let env;
let admin;
let user;      // 文件所有者
let otherUser; // 另一个普通用户

test.before(async () => {
  env = createTestEnv();
  await env.ready();

  admin = request.agent(env.app);
  await admin.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });

  await admin.post('/api/users').send({ username: 'alice', password: 'alicepass123', role: 'user' });
  await admin.post('/api/users').send({ username: 'bob', password: 'bobpass123', role: 'user' });

  user = request.agent(env.app);
  await user.post('/api/auth/login').send({ username: 'alice', password: 'alicepass123' });
  otherUser = request.agent(env.app);
  await otherUser.post('/api/auth/login').send({ username: 'bob', password: 'bobpass123' });
});

test.after(() => {
  env.cleanup();
});

async function seedPrivateFile(agent, name) {
  const up = await agent.post('/api/files/upload-json').send({ name, content: '# x', isPublic: false });
  return up.body.id;
}

// ====================== PUT /:id/tags ======================

test('关联标签：文件不存在 → 404', async () => {
  const res = await user.put('/api/files/999999/tags').send({ tagIds: [] });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '文件不存在');
});

test('关联标签：非所有者 → 403', async () => {
  const id = await seedPrivateFile(user, 'tag-403.md');
  const res = await otherUser.put(`/api/files/${id}/tags`).send({ tagIds: [] });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, '无权操作此文件');
});

test('关联标签：tagIds 非数组 → 400', async () => {
  const id = await seedPrivateFile(user, 'tag-bad.md');
  const res = await user.put(`/api/files/${id}/tags`).send({ tagIds: 'not-array' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'tagIds 必须是数组');
});

test('关联标签：所有者替换标签集 → 200，详情可见', async () => {
  const id = await seedPrivateFile(user, 'tag-ok.md');
  const t1 = await user.post('/api/tags').send({ name: 'tag-a' });
  const t2 = await user.post('/api/tags').send({ name: 'tag-b' });
  const res = await user.put(`/api/files/${id}/tags`).send({ tagIds: [t1.body.id, t2.body.id] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  const detail = await user.get(`/api/files/${id}`);
  assert.strictEqual(detail.body.tags.length, 2);
});

// ====================== POST/DELETE /:id/star ======================

test('收藏：文件不存在 → 404', async () => {
  const res = await user.post('/api/files/999999/star');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '文件不存在');
});

test('收藏/取消收藏：正常 toggle，详情 starred 字段随之变化', async () => {
  const id = await seedPrivateFile(user, 'star-ok.md');
  const on = await user.post(`/api/files/${id}/star`);
  assert.strictEqual(on.status, 200);
  assert.strictEqual(on.body.success, true);
  let detail = await user.get(`/api/files/${id}`);
  assert.strictEqual(detail.body.starred, true);

  const off = await user.delete(`/api/files/${id}/star`);
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.success, true);
  detail = await user.get(`/api/files/${id}`);
  assert.strictEqual(detail.body.starred, false);
});

test('取消收藏：不存在的文件也返回 200（幂等）', async () => {
  // DELETE /:id/star 不检查文件是否存在，仅删除关联记录
  const res = await user.delete('/api/files/999999/star');
  assert.strictEqual(res.status, 200);
});

// ====================== PUT /:id/category ======================

test('设置分类：文件不存在 → 404', async () => {
  const res = await user.put('/api/files/999999/category').send({ categoryId: 1 });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '文件不存在');
});

test('设置分类：非所有者 → 403', async () => {
  const id = await seedPrivateFile(user, 'cat-403.md');
  const res = await otherUser.put(`/api/files/${id}/category`).send({ categoryId: null });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, '无权操作');
});

test('设置分类：所有者设置/清空分类 → 200', async () => {
  const id = await seedPrivateFile(user, 'cat-ok.md');
  const cat = await user.post('/api/categories').send({ name: '工作' });
  const set = await user.put(`/api/files/${id}/category`).send({ categoryId: cat.body.id });
  assert.strictEqual(set.status, 200);
  let detail = await user.get(`/api/files/${id}`);
  assert.strictEqual(detail.body.category_id, cat.body.id);

  const clear = await user.put(`/api/files/${id}/category`).send({ categoryId: null });
  assert.strictEqual(clear.status, 200);
  detail = await user.get(`/api/files/${id}`);
  assert.ok(!detail.body.category_id);
});

// ====================== GET /:id/stats ======================

test('访问统计：文件不存在 → 404', async () => {
  const res = await user.get('/api/files/999999/stats');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '文件不存在');
});

test('访问统计：非所有者 → 403', async () => {
  const id = await seedPrivateFile(user, 'stat-403.md');
  const res = await otherUser.get(`/api/files/${id}/stats`);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, '无权访问');
});

test('访问统计：所有者 → 200 含 viewCount / daily7 / daily30', async () => {
  const id = await seedPrivateFile(user, 'stat-ok.md');
  const res = await user.get(`/api/files/${id}/stats`);
  assert.strictEqual(res.status, 200);
  assert.ok('viewCount' in res.body);
  assert.ok('daily7' in res.body);
  assert.ok('daily30' in res.body);
  assert.ok(Array.isArray(res.body.daily7));
});
