// 版本历史路由集成测试：列表 / 内容 / 渲染 / 恢复 / 删除单版本 的正常与异常分支。
// 覆盖 routes/files/versions.js 的权限隔离（403）、不存在（404）、文件丢失（ENOENT）等分支。

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

let env;
let admin;     // admin agent
let user;      // 普通用户（文件所有者）
let otherUser; // 另一个普通用户（无权）

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

// 上传一个文件并覆盖一次以产生 v2（保留 v1）
async function seedVersionedFile(agent, name = 'ver.md') {
  const up = await agent.post('/api/files/upload-json').send({
    name,
    content: '# v1',
    isPublic: false,
  });
  await agent.post(`/api/files/${up.body.id}/overwrite-json`).send({ content: '# v2' });
  return up.body.id;
}

// ====================== GET /:id/versions ======================

test('版本列表：文件不存在 → 404', async () => {
  const res = await admin.get('/api/files/999999/versions');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '文件不存在');
});

test('版本列表：未登录 → 401', async () => {
  const id = await seedVersionedFile(user, 'ver-list.md');
  const res = await request(env.app).get(`/api/files/${id}/versions`);
  assert.strictEqual(res.status, 401);
});

test('版本列表：正常返回 current + versions', async () => {
  const id = await seedVersionedFile(user, 'ver-list-ok.md');
  const res = await user.get(`/api/files/${id}/versions`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.file_id, id);
  assert.ok(res.body.current);
  assert.ok(Array.isArray(res.body.versions));
  assert.ok(res.body.versions.length >= 1);
});

// ====================== GET /:id/versions/:ver/content ======================

test('版本原文：版本不存在 → 404', async () => {
  const id = await seedVersionedFile(user, 'ver-content.md');
  const res = await user.get(`/api/files/${id}/versions/99999/content`);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '版本不存在');
});

test('版本原文：非所有者普通用户 → 403', async () => {
  const id = await seedVersionedFile(user, 'ver-content-403.md');
  const res = await otherUser.get(`/api/files/${id}/versions/1/content`);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, '无权读取此文件原文');
});

test('版本原文：admin 可读取任意用户文件 → 200', async () => {
  const id = await seedVersionedFile(user, 'ver-content-admin.md');
  const res = await admin.get(`/api/files/${id}/versions/1/content`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.content, '# v1');
  assert.strictEqual(res.body.version, 1);
});

test('版本原文：所有者读取 → 200', async () => {
  const id = await seedVersionedFile(user, 'ver-content-owner.md');
  const res = await user.get(`/api/files/${id}/versions/1/content`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.content, '# v1');
});

// ====================== GET /:id/versions/:ver/render ======================

test('版本渲染：版本不存在 → 404', async () => {
  const id = await seedVersionedFile(user, 'ver-render.md');
  const res = await user.get(`/api/files/${id}/versions/99999/render`);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '版本不存在');
});

test('版本渲染：正常 → 200 HTML', async () => {
  const id = await seedVersionedFile(user, 'ver-render-ok.md');
  const res = await user.get(`/api/files/${id}/versions/1/render`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
});

// ====================== POST /:id/versions/:ver/restore ======================

test('恢复版本：文件不存在 → 404', async () => {
  const res = await admin.post('/api/files/999999/versions/1/restore');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '文件不存在');
});

test('恢复版本：版本不存在 → 404', async () => {
  const id = await seedVersionedFile(user, 'ver-restore.md');
  const res = await user.post(`/api/files/${id}/versions/99999/restore`);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '版本不存在');
});

test('恢复版本：所有者恢复 v1 → 200 且产生新版本号', async () => {
  const id = await seedVersionedFile(user, 'ver-restore-ok.md');
  const before = await user.get(`/api/files/${id}/versions`);
  const res = await user.post(`/api/files/${id}/versions/1/restore`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.restored_from, 1);
  assert.ok(res.body.version > before.body.versions[0].version);
  // 内容应回到 v1
  const content = await user.get(`/api/files/${id}/content`);
  assert.strictEqual(content.body.content, '# v1');
});

// ====================== DELETE /:id/versions/:ver ======================

test('删除版本：版本不存在 → 404', async () => {
  const id = await seedVersionedFile(user, 'ver-delete.md');
  const res = await user.delete(`/api/files/${id}/versions/99999`);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '版本不存在');
});

test('删除版本：正常删除 → 200', async () => {
  const id = await seedVersionedFile(user, 'ver-delete-ok.md');
  const before = await user.get(`/api/files/${id}/versions`);
  const firstVerId = before.body.versions[0].id;
  const firstVerNum = before.body.versions[0].version;
  const res = await user.delete(`/api/files/${id}/versions/${firstVerNum}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  const after = await user.get(`/api/files/${id}/versions`);
  assert.ok(after.body.versions.length < before.body.versions.length);
  assert.ok(!after.body.versions.some(v => v.id === firstVerId));
});
