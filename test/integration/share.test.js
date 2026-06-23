// 短链分享集成测试：/s/:key 公开/私有访问控制 + 分享链接控制（重新生成/别名/过期/密码）。
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

// ---------- 基础短链访问 ----------

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

// ---------- 重新生成短链（撤销旧链接）----------

test('重新生成短链：旧链接立即 404，新链接可用', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'regen.md', content: '# 重新生成', isPublic: true,
  });
  const oldKey = up.body.share_key;

  const regen = await agent.post(`/api/files/${up.body.id}/share/regenerate`);
  assert.strictEqual(regen.status, 200);
  assert.ok(regen.body.share_key);
  assert.notStrictEqual(regen.body.share_key, oldKey);

  // 旧链接失效
  const oldRes = await request(env.app).get(`/s/${oldKey}`);
  assert.strictEqual(oldRes.status, 404);
  // 新链接可用
  const newRes = await request(env.app).get(`/s/${regen.body.share_key}`);
  assert.strictEqual(newRes.status, 200);
});

test('重新生成短链：非所有者 → 403', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'regen-priv.md', content: '# x', isPublic: true,
  });
  // 新建普通用户
  await agent.post('/api/users').send({ username: 'user2', password: 'pass1234', role: 'user' });
  const userAgent = request.agent(env.app);
  await userAgent.post('/api/auth/login').send({ username: 'user2', password: 'pass1234' });
  const res = await userAgent.post(`/api/files/${up.body.id}/share/regenerate`);
  assert.strictEqual(res.status, 403);
});

test('重新生成短链：未登录 → 401', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'regen-anon.md', content: '# x', isPublic: true,
  });
  const res = await request(env.app).post(`/api/files/${up.body.id}/share/regenerate`);
  assert.strictEqual(res.status, 401);
});

// ---------- 自定义别名 ----------

test('自定义别名：设置后可用，回显到详情', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'alias.md', content: '# 别名', isPublic: true,
  });
  const alias = 'my-cool-alias';
  const setRes = await agent.put(`/api/files/${up.body.id}/share`).send({ alias });
  assert.strictEqual(setRes.status, 200);
  assert.strictEqual(setRes.body.share_key, alias);

  // 别名短链可用
  const res = await request(env.app).get(`/s/${alias}`);
  assert.strictEqual(res.status, 200);

  // 详情回显
  const detail = await agent.get(`/api/files/${up.body.id}`);
  assert.strictEqual(detail.body.share_key, alias);
});

test('自定义别名：非法格式 → 400', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'alias-bad.md', content: '# x', isPublic: true,
  });
  const res = await agent.put(`/api/files/${up.body.id}/share`).send({ alias: 'ab' }); // 太短
  assert.strictEqual(res.status, 400);
});

test('自定义别名：重复 → 409', async () => {
  const up1 = await agent.post('/api/files/upload-json').send({
    name: 'dup1.md', content: '# x', isPublic: true,
  });
  const up2 = await agent.post('/api/files/upload-json').send({
    name: 'dup2.md', content: '# x', isPublic: true,
  });
  await agent.put(`/api/files/${up1.body.id}/share`).send({ alias: 'taken-alias' });
  const res = await agent.put(`/api/files/${up2.body.id}/share`).send({ alias: 'taken-alias' });
  assert.strictEqual(res.status, 409);
});

test('自定义别名：清空回到随机短链', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'alias-clear.md', content: '# x', isPublic: true,
  });
  await agent.put(`/api/files/${up.body.id}/share`).send({ alias: 'temp-alias' });
  const res = await agent.put(`/api/files/${up.body.id}/share`).send({ alias: '' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.share_key);
  assert.notStrictEqual(res.body.share_key, 'temp-alias');
});

// ---------- 过期时间 ----------

test('过期时间：未来时间可设置，回显到详情', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'expire-future.md', content: '# x', isPublic: true,
  });
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const setRes = await agent.put(`/api/files/${up.body.id}/share`).send({ expiresAt: future });
  assert.strictEqual(setRes.status, 200);
  assert.ok(setRes.body.share_expires_at);
  // 未过期仍可访问
  const res = await request(env.app).get(`/s/${setRes.body.share_key}`);
  assert.strictEqual(res.status, 200);
  // 详情回显
  const detail = await agent.get(`/api/files/${up.body.id}`);
  assert.ok(detail.body.share_expires_at);
});

test('过期时间：过去时间 → 400', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'expire-past.md', content: '# x', isPublic: true,
  });
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  const res = await agent.put(`/api/files/${up.body.id}/share`).send({ expiresAt: past });
  assert.strictEqual(res.status, 400);
});

test('过期时间：已过期链接 → 410 Gone', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'expire-gone.md', content: '# x', isPublic: true,
  });
  // 直接设置一个刚过去的过期时间（绕过后端的过去时间校验：用稍远的未来设置，再等不可能——
  // 改为设置 1 秒后过期，等待，使其自然过期）
  const near = new Date(Date.now() + 1100).toISOString();
  await agent.put(`/api/files/${up.body.id}/share`).send({ expiresAt: near });
  await new Promise(r => setTimeout(r, 1300));
  const res = await request(env.app).get(`/s/${up.body.share_key}`);
  assert.strictEqual(res.status, 410);
});

test('过期时间：清空 → 恢复永不过期', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'expire-clear.md', content: '# x', isPublic: true,
  });
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await agent.put(`/api/files/${up.body.id}/share`).send({ expiresAt: future });
  const res = await agent.put(`/api/files/${up.body.id}/share`).send({ expiresAt: null });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.share_expires_at, null);
});

// ---------- 访问密码 ----------

test('访问密码：设置后匿名访问返回密码表单（200 + 含"需要访问密码"）', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'pwd.md', content: '# 受保护内容', isPublic: true,
  });
  await agent.put(`/api/files/${up.body.id}/share`).send({ password: 'secret123' });
  const res = await request(env.app).get(`/s/${up.body.share_key}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /需要访问密码/);
  // 表单页应含密码输入框，而非直接渲染受保护内容
  assert.match(res.text, /type="password"/);
  assert.doesNotMatch(res.text, /受保护内容/);
});

test('访问密码：正确密码 POST 后解锁，可渲染', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'pwd-ok.md', content: '# 解锁内容', isPublic: true,
  });
  const key = up.body.share_key;
  await agent.put(`/api/files/${up.body.id}/share`).send({ password: 'secret123' });

  // 用独立 agent 模拟访客会话（密码解锁态存 session）
  const visitor = request.agent(env.app);
  // 错误密码 → 仍表单页
  const wrong = await visitor.post(`/s/${key}`).send('password=wrongpass').type('form');
  assert.match(wrong.text, /密码错误/);

  // 正确密码 → 302 重定向到 GET
  const ok = await visitor.post(`/s/${key}`).send('password=secret123').type('form');
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(ok.headers.location, `/s/${key}`);

  // 重定向后 GET → 渲染（已解锁）
  const rendered = await visitor.get(`/s/${key}`);
  assert.strictEqual(rendered.status, 200);
  assert.match(rendered.text, /解锁内容/);
});

test('访问密码：清除后无需密码直接访问', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'pwd-clear.md', content: '# 清除', isPublic: true,
  });
  await agent.put(`/api/files/${up.body.id}/share`).send({ password: 'secret123' });
  await agent.put(`/api/files/${up.body.id}/share`).send({ password: null });
  const res = await request(env.app).get(`/s/${up.body.share_key}`);
  assert.strictEqual(res.status, 200);
  assert.doesNotMatch(res.text, /需要访问密码/);
});

test('访问密码：详情/列表只回布尔，不回哈希', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'pwd-leak.md', content: '# x', isPublic: true,
  });
  await agent.put(`/api/files/${up.body.id}/share`).send({ password: 'secret123' });

  const detail = await agent.get(`/api/files/${up.body.id}`);
  assert.strictEqual(detail.body.has_share_password, true);
  assert.strictEqual(detail.body.share_password_hash, undefined);
  assert.strictEqual(detail.body.share_password, undefined);

  const list = await agent.get('/api/files/?limit=50');
  const item = list.body.files.find(f => f.id === up.body.id);
  assert.ok(item);
  assert.ok(item.has_share_password);
  assert.strictEqual(item.share_password_hash, undefined);
});

test('访问密码：长度 < 4 → 400', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'pwd-short.md', content: '# x', isPublic: true,
  });
  const res = await agent.put(`/api/files/${up.body.id}/share`).send({ password: 'ab' });
  assert.strictEqual(res.status, 400);
});

// ---------- PUT /share 边界 ----------

test('PUT /share：无更新字段 → 400', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'share-empty.md', content: '# x', isPublic: true,
  });
  const res = await agent.put(`/api/files/${up.body.id}/share`).send({});
  assert.strictEqual(res.status, 400);
});

test('PUT /share：非所有者 → 403', async () => {
  const up = await agent.post('/api/files/upload-json').send({
    name: 'share-own.md', content: '# x', isPublic: true,
  });
  const userAgent = request.agent(env.app);
  await userAgent.post('/api/auth/login').send({ username: 'user2', password: 'pass1234' });
  const res = await userAgent.put(`/api/files/${up.body.id}/share`).send({ alias: 'hack-alias' });
  assert.strictEqual(res.status, 403);
});
