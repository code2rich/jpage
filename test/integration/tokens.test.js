// 令牌集成测试：创建 / 列表(viewable) / 查看明文 / 删除 / 鉴权边界
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

test('创建令牌 → 返回明文且带 jp_ 前缀', async () => {
  const res = await agent.post('/api/tokens').send({ name: 'CI Token' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token.startsWith('jp_'));
  assert.strictEqual(res.body.name, 'CI Token');
  assert.ok(res.body.token_prefix);
});

test('列表包含 viewable=true（新建令牌有加密明文）', async () => {
  const res = await agent.get('/api/tokens');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.tokens.length > 0);
  const t = res.body.tokens[0];
  assert.strictEqual(t.viewable, 1, '新建令牌应有可查看的加密明文');
  // 列表不应返回明文或密文
  assert.strictEqual(t.token, undefined);
  assert.strictEqual(t.token_enc, undefined);
});

test('查看令牌明文 → 与创建时一致', async () => {
  const create = await agent.post('/api/tokens').send({ name: 'Reveal Test' });
  const createdToken = create.body.token;
  const list = await agent.get('/api/tokens');
  const item = list.body.tokens.find(t => t.name === 'Reveal Test');
  assert.ok(item);

  const reveal = await agent.post('/api/tokens/' + item.id + '/reveal');
  assert.strictEqual(reveal.status, 200);
  assert.strictEqual(reveal.body.token, createdToken, 'reveal 返回的明文应与创建时一致');
});

test('reveal 无效 ID → 400', async () => {
  const res = await agent.post('/api/tokens/abc/reveal');
  assert.strictEqual(res.status, 400);
});

test('reveal 不存在的令牌 → 404', async () => {
  const res = await agent.post('/api/tokens/999999/reveal');
  assert.strictEqual(res.status, 404);
});

test('未登录 reveal → 401', async () => {
  const list = await agent.get('/api/tokens');
  const item = list.body.tokens[0];
  const res = await request(env.app).post('/api/tokens/' + item.id + '/reveal');
  assert.strictEqual(res.status, 401);
});

test('删除令牌 → 200，之后 reveal 该令牌 → 404', async () => {
  await agent.post('/api/tokens').send({ name: 'ToDelete' });
  const list = await agent.get('/api/tokens');
  const item = list.body.tokens.find(t => t.name === 'ToDelete');

  const del = await agent.delete('/api/tokens/' + item.id);
  assert.strictEqual(del.status, 200);

  const reveal = await agent.post('/api/tokens/' + item.id + '/reveal');
  assert.strictEqual(reveal.status, 404);
});

test('Bearer 鉴权用返回的明文可访问受保护端点', async () => {
  const create = await agent.post('/api/tokens').send({ name: 'Bearer Test' });
  const token = create.body.token;
  // /api/files 由 requireAuth 保护，支持 session 与 Bearer
  const res = await request(env.app)
    .get('/api/files')
    .set('Authorization', 'Bearer ' + token);
  assert.strictEqual(res.status, 200);
});
