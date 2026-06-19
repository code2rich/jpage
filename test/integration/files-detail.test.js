// 详情/原文/资产/渲染/下载 路由集成测试。
// 覆盖 routes/files/detail-serve.js 的权限矩阵（401/403/200）、路径穿越、ENOENT、bundle 分支。

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const JSZip = require('jszip');
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

// 用 JSZip 构造 ZIP buffer
async function makeZip(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function seedPrivateMd(agent, name) {
  const up = await agent.post('/api/files/upload-json').send({ name, content: '# 私有', isPublic: false });
  return up.body.id;
}

async function seedPublicMd(agent, name) {
  const up = await agent.post('/api/files/upload-json').send({ name, content: '# 公开', isPublic: true });
  return up.body.id;
}

async function seedBundle(agent, name, files) {
  const buf = await makeZip(files);
  const up = await agent.post('/api/files/upload-zip-base64').send({
    name, content: buf.toString('base64'), isPublic: false,
  });
  return up.body.id;
}

// ====================== GET /:id 详情 ======================

test('详情：匿名访问私有文件 → 401', async () => {
  const id = await seedPrivateMd(user, 'det-anon.md');
  const res = await request(env.app).get(`/api/files/${id}`);
  assert.strictEqual(res.status, 401);
});

test('详情：跨用户访问私有文件 → 403', async () => {
  const id = await seedPrivateMd(user, 'det-cross.md');
  const res = await otherUser.get(`/api/files/${id}`);
  assert.strictEqual(res.status, 403);
});

test('详情：所有者访问自己的私有文件 → 200', async () => {
  const id = await seedPrivateMd(user, 'det-owner.md');
  const res = await user.get(`/api/files/${id}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.id, id);
  assert.strictEqual(res.body.is_public, 0);
});

test('详情：admin 可访问任意私有文件 → 200', async () => {
  const id = await seedPrivateMd(user, 'det-admin.md');
  const res = await admin.get(`/api/files/${id}`);
  assert.strictEqual(res.status, 200);
});

test('详情：匿名访问公开文件 → 200（含 tags/starred/version_count）', async () => {
  const id = await seedPublicMd(user, 'det-pub.md');
  const res = await request(env.app).get(`/api/files/${id}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.is_public, 1);
  assert.ok(Array.isArray(res.body.tags));
  assert.strictEqual(res.body.starred, false);
  assert.ok('version_count' in res.body);
});

test('详情：文件不存在 → 404', async () => {
  const res = await admin.get('/api/files/999999');
  assert.strictEqual(res.status, 404);
});

// ====================== GET /:id/content 原文 ======================

test('原文：匿名访问 → 401（requireAuth 前置）', async () => {
  const id = await seedPublicMd(user, 'cnt-anon.md');
  const res = await request(env.app).get(`/api/files/${id}/content`);
  assert.strictEqual(res.status, 401);
});

test('原文：跨用户访问公开文件 → 403（loadFileWithPrivacy 放行后的所有权检查）', async () => {
  // 公开文件：loadFileWithPrivacy 允许任意登录用户通过，但 content 路由的所有权检查仍拒绝非所有者
  const id = await seedPublicMd(user, 'cnt-cross.md');
  const res = await otherUser.get(`/api/files/${id}/content`);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, '无权读取此文件原文');
});

test('原文：所有者 → 200 返回 content', async () => {
  const id = await seedPrivateMd(user, 'cnt-owner.md');
  const res = await user.get(`/api/files/${id}/content`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.content, '# 私有');
});

test('原文：bundle 降级返回入口文件 + 目录清单', async () => {
  const id = await seedBundle(user, 'cnt-bundle.zip', {
    'index.html': '<h1>bundle entry</h1>',
    'css/style.css': 'body{color:red}',
  });
  const res = await user.get(`/api/files/${id}/content`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.is_bundle, 1);
  assert.ok(res.body.content.includes('bundle entry'));
  assert.ok(Array.isArray(res.body.entries));
});

// ====================== GET /:id/asset/* bundle 资源 ======================

test('asset：非 bundle 文件 → 400', async () => {
  const id = await seedPublicMd(user, 'asset-nobundle.md');
  const res = await request(env.app).get(`/api/files/${id}/asset/anything`);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '非网站包');
});

test('asset：路径穿越 → 403', async () => {
  const id = await seedBundle(user, 'asset-trav.zip', { 'index.html': '<p>x</p>', 'css/x.css': 'a{}' });
  // 用所有者身份排除权限干扰，专注路径穿越守卫
  const res = await user.get(`/api/files/${id}/asset/..%2f..%2fetc%2fpasswd`);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, '非法路径');
});

test('asset：资源不存在 → 404', async () => {
  const id = await seedBundle(user, 'asset-404.zip', { 'index.html': '<p>x</p>', 'css/x.css': 'a{}' });
  const res = await user.get(`/api/files/${id}/asset/no-such-file.css`);
  assert.strictEqual(res.status, 404);
});

test('asset：正常读取 bundle 内资源 → 200', async () => {
  const id = await seedBundle(user, 'asset-ok.zip', {
    'index.html': '<p>x</p>',
    'css/style.css': 'body{color:red}',
  });
  const res = await user.get(`/api/files/${id}/asset/css/style.css`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.text, 'body{color:red}');
});

// ====================== GET /:id/render 渲染 ======================

test('渲染：匿名访问公开文件 → 200', async () => {
  const id = await seedPublicMd(user, 'rnd-pub.md');
  const res = await request(env.app).get(`/api/files/${id}/render`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
});

test('渲染：匿名访问私有文件 → 401', async () => {
  const id = await seedPrivateMd(user, 'rnd-priv.md');
  const res = await request(env.app).get(`/api/files/${id}/render`);
  assert.strictEqual(res.status, 401);
});

// ====================== GET /:id/download 下载 ======================

test('下载：普通文件 → 200 + Content-Disposition attachment', async () => {
  const id = await seedPrivateMd(user, 'dl-md.md');
  const res = await user.get(`/api/files/${id}/download`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-disposition'] || '', /attachment/);
});

test('下载：bundle → 200 + application/zip', async () => {
  const id = await seedBundle(user, 'dl-bundle.zip', {
    'index.html': '<p>x</p>',
    'a.txt': 'aaa',
  });
  const res = await user.get(`/api/files/${id}/download`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'] || '', /application\/zip/);
});

test('下载：匿名访问公开文件 → 200', async () => {
  const id = await seedPublicMd(user, 'dl-pub.md');
  const res = await request(env.app).get(`/api/files/${id}/download`);
  assert.strictEqual(res.status, 200);
});
