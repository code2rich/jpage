// 标签集成测试：创建（重复返回现有）/ 列表（role 区分 file_count）/ 删除（级联 file_tags）/ 边界。
// 挂载点 /api/tags，全部 requireAuth。
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

let env;
let agent;

test.before(async () => {
  env = createTestEnv();
  await env.ready();
  agent = request.agent(env.app);
  await agent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
});

test.after(() => {
  env.cleanup();
});

// --- 权限边界 ---
test('未登录 GET /api/tags → 401', async () => {
  const res = await request(env.app).get('/api/tags');
  assert.strictEqual(res.status, 401);
});

// --- 创建 ---
test('创建标签：空名 → 400', async () => {
  const res = await agent.post('/api/tags').send({ name: '  ' });
  assert.strictEqual(res.status, 400);
});

test('创建标签：happy path → 200，返回 id', async () => {
  const res = await agent.post('/api/tags').send({ name: '前端' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.id);
  assert.strictEqual(res.body.name, '前端');
});

test('创建标签：重名返回现有（不报错）→ 200，id 相同', async () => {
  const first = await agent.post('/api/tags').send({ name: '重复标签' });
  const second = await agent.post('/api/tags').send({ name: '重复标签' });
  assert.strictEqual(second.status, 200);
  assert.strictEqual(first.body.id, second.body.id);
});

// --- 列表 ---
test('列表 GET /api/tags → 200，含 file_count', async () => {
  const res = await agent.get('/api/tags');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.tags));
  assert.ok(res.body.tags.length > 0);
  // 每项含 file_count
  assert.strictEqual(typeof res.body.tags[0].file_count, 'number');
});

// --- 删除 + 级联 ---
test('删除标签：happy path → 200，列表中消失', async () => {
  const create = await agent.post('/api/tags').send({ name: '待删除' });
  const del = await agent.delete(`/api/tags/${create.body.id}`);
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.success, true);
  const list = await agent.get('/api/tags');
  assert.ok(!list.body.tags.some(t => t.id === create.body.id));
});

test('删除标签：不存在 → 404', async () => {
  const res = await agent.delete('/api/tags/999999');
  assert.strictEqual(res.status, 404);
});

test('删除标签后，文件-标签关联被级联清理', async () => {
  // 建标签 + 建文件 + 关联
  const tagRes = await agent.post('/api/tags').send({ name: '级联测试标签' });
  const tagId = tagRes.body.id;
  const up = await agent.post('/api/files/upload-json').send({ name: 'cascade.md', content: 'x' });
  await agent.put(`/api/files/${up.body.id}/tags`).send({ tagIds: [tagId] });
  // 删标签
  await agent.delete(`/api/tags/${tagId}`);
  // 文件详情里 tags 不应再含该标签
  const detail = await agent.get(`/api/files/${up.body.id}`);
  assert.ok(!detail.body.tags.some(t => t.id === tagId));
});


// --- 文件标签归属（回归：普通用户必须能编辑自己的文件标签） ---
test('普通用户给自有文件绑定标签 → 200，且详情中可见标签', async () => {
  // admin 创建一个普通用户
  await agent.post('/api/users').send({ username: 'tag_owner', password: 'tagpass123', role: 'user' });
  const user = request.agent(env.app);
  await user.post('/api/auth/login').send({ username: 'tag_owner', password: 'tagpass123' });

  // 普通用户创建文件和标签并绑定
  const up = await user.post('/api/files/upload-json').send({ name: 'owner.md', content: '# owner file' });
  assert.strictEqual(up.status, 200);
  const tagRes = await user.post('/api/tags').send({ name: '普通用户标签' });
  assert.strictEqual(tagRes.status, 200);
  const tagId = tagRes.body.id;

  const bind = await user.put(`/api/files/${up.body.id}/tags`).send({ tagIds: [tagId] });
  assert.strictEqual(bind.status, 200);
  assert.strictEqual(bind.body.success, true);

  // 详情中应返回该标签
  const detail = await user.get(`/api/files/${up.body.id}`);
  assert.ok(detail.body.tags.some(t => t.id === tagId));
});
