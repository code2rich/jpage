// 文件管理集成测试：上传(json) / 列表 / 渲染 / 详情 / 删除 / 版本
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

test('upload-json 上传 Markdown → 200，返回 id + share_key', async () => {
  const res = await agent.post('/api/files/upload-json').send({
    name: 'test-doc.md',
    content: '# 标题\n\n这是一段 **Markdown** 内容。\n\n```js\nconsole.log("hi");\n```',
    isPublic: true,
  });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.id);
  assert.ok(res.body.share_key);
  assert.strictEqual(res.body.file_type, 'markdown');
  assert.strictEqual(res.body.is_public, 1);
});

test('upload-json 缺少 name → 400', async () => {
  const res = await agent.post('/api/files/upload-json').send({ content: 'x' });
  assert.strictEqual(res.status, 400);
});

test('upload-json 不支持的扩展名 → 400', async () => {
  const res = await agent.post('/api/files/upload-json').send({ name: 'a.txt', content: 'x' });
  assert.strictEqual(res.status, 400);
});

test('列表包含已上传文件', async () => {
  const res = await agent.get('/api/files');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.files));
  assert.ok(res.body.files.length > 0);
  assert.ok(res.body.pagination);
  // 每个文件含 tags 数组
  assert.ok(Array.isArray(res.body.files[0].tags));
});

test('详情 GET /api/files/:id', async () => {
  const up = await agent.post('/api/files/upload-json').send({ name: 'detail.md', content: '# 详情' });
  const res = await agent.get(`/api/files/${up.body.id}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.original_name, 'detail.md');
  assert.ok(Array.isArray(res.body.tags));
  assert.strictEqual(typeof res.body.starred, 'boolean');
});

test('详情不存在 → 404', async () => {
  const res = await agent.get('/api/files/999999');
  assert.strictEqual(res.status, 404);
});

test('原文 GET /api/files/:id/content', async () => {
  const up = await agent.post('/api/files/upload-json').send({ name: 'content.md', content: '# 原文测试' });
  const res = await agent.get(`/api/files/${up.body.id}/content`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.content, '# 原文测试');
});

test('渲染 GET /api/files/:id/render → HTML', async () => {
  const up = await agent.post('/api/files/upload-json').send({ name: 'render.md', content: '# 渲染\n\n$E=mc^2$' });
  const res = await agent.get(`/api/files/${up.body.id}/render`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
  assert.ok(res.text.includes('<h1>'));
});

test('同名覆盖上传 → overwritten: true + 版本号递增', async () => {
  await agent.post('/api/files/upload-json').send({ name: 'versioned.md', content: 'v1' });
  const res = await agent.post('/api/files/upload-json').send({ name: 'versioned.md', content: 'v2' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.overwritten, true);
  assert.ok(res.body.version >= 2);
});

test('版本列表 GET /api/files/:id/versions', async () => {
  const up = await agent.post('/api/files/upload-json').send({ name: 'ver-list.md', content: 'a' });
  await agent.post('/api/files/upload-json').send({ name: 'ver-list.md', content: 'b' });
  const res = await agent.get(`/api/files/${up.body.id}/versions`);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.versions));
  assert.ok(res.body.versions.length >= 1);
});

test('更新文件名 PUT /api/files/:id', async () => {
  const up = await agent.post('/api/files/upload-json').send({ name: 'rename.md', content: 'x' });
  const res = await agent.put(`/api/files/${up.body.id}`).send({ name: 'renamed.md' });
  assert.strictEqual(res.status, 200);
});

test('删除文件 DELETE /api/files/:id', async () => {
  const up = await agent.post('/api/files/upload-json').send({ name: 'delete-me.md', content: 'x' });
  const res = await agent.delete(`/api/files/${up.body.id}`);
  assert.strictEqual(res.status, 200);
  // 再查应 404
  const gone = await agent.get(`/api/files/${up.body.id}`);
  assert.strictEqual(gone.status, 404);
});

test('FTS 搜索命中内容', async () => {
  await agent.post('/api/files/upload-json').send({ name: 'searchable.md', content: '这是一个 uniquekeyword 标记的文档' });
  const res = await agent.get('/api/files/search').query({ q: 'uniquekeyword' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.files.length > 0);
});

test('标签：创建 + 关联到文件', async () => {
  const tagRes = await agent.post('/api/tags').send({ name: '测试标签' });
  assert.ok(tagRes.status === 200 || tagRes.status === 201);
  const tagId = tagRes.body.id;

  const up = await agent.post('/api/files/upload-json').send({ name: 'tagged.md', content: 'x' });
  const linkRes = await agent.put(`/api/files/${up.body.id}/tags`).send({ tagIds: [tagId] });
  assert.strictEqual(linkRes.status, 200);

  const detail = await agent.get(`/api/files/${up.body.id}`);
  assert.ok(detail.body.tags.some(t => t.id === tagId));
});

test('收藏文件', async () => {
  const up = await agent.post('/api/files/upload-json').send({ name: 'star.md', content: 'x' });
  const starRes = await agent.post(`/api/files/${up.body.id}/star`);
  assert.strictEqual(starRes.status, 200);
});
