// 短链分享集成测试：/s/:key 公开/私有访问控制
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

test('公开文件：匿名访问短链 /s/:key → 200', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'public.md',
    content: '# 公开文档',
    isPublic: true,
  });
  const res = await request(env.app).get(`/s/${up.body.share_key}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
});

test('私有文件：匿名访问短链 /s/:key → 重定向到首页', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'private.md',
    content: '# 私有文档',
    isPublic: false,
  });
  const res = await request(env.app).get(`/s/${up.body.share_key}`);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/');
});

test('不存在的短链 → 404', async () => {
  const res = await request(env.app).get('/s/NOTEXIST');
  assert.strictEqual(res.status, 404);
});

test('公开文件渲染端点 /api/files/:id/render 匿名可访问', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'pub-render.md',
    content: '# 渲染',
    isPublic: true,
  });
  const res = await request(env.app).get(`/api/files/${up.body.id}/render`);
  assert.strictEqual(res.status, 200);
});

test('私有文件：匿名访问 /api/files/:id → 401', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'priv2.md',
    content: '# 私有',
    isPublic: false,
  });
  const res = await request(env.app).get(`/api/files/${up.body.id}`);
  assert.strictEqual(res.status, 401);
});

test('健康检查 /health → 200', async () => {
  const res = await request(env.app).get('/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
  assert.ok(res.body.db === true);
});

test('SPA 兜底 / → 返回 HTML', async () => {
  const res = await request(env.app).get('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
});
