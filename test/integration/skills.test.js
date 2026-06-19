// Skills 集成测试：列表 / 详情 / 下载 zip / mcp/config 结构。全部 requireAuth。
// 挂载点 /api（/skills、/skills/:name、/skills/:name/download、/mcp/config）。
// 依赖仓库内 skills/jpage-upload/SKILL.md（内置 skill）。
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

// supertest 二进制响应解析器：skills download 是流式 zip，需 buffer(true).parse 才能拿到字节。
function binaryParser(res, cb) {
  const data = [];
  res.on('data', chunk => data.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(data)));
}

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

// --- 权限 ---
test('未登录 GET /api/skills → 401', async () => {
  const res = await request(env.app).get('/api/skills');
  assert.strictEqual(res.status, 401);
});

// --- 列表 ---
test('GET /api/skills → 200，含内置 jpage-upload skill', async () => {
  const res = await agent.get('/api/skills');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.skills));
  // 仓库内置 jpage-upload skill 应被发现
  assert.ok(res.body.skills.some(s => s.name === 'jpage-upload'), '应含 jpage-upload skill');
});

// --- 详情 ---
test('GET /api/skills/jpage-upload → 200', async () => {
  const res = await agent.get('/api/skills/jpage-upload');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.name, 'jpage-upload');
});

test('GET /api/skills/不存在 → 404', async () => {
  const res = await agent.get('/api/skills/no-such-skill-xyz');
  assert.strictEqual(res.status, 404);
});

// --- 下载 ---
test('GET /api/skills/jpage-upload/download → 200，application/zip', async () => {
  const res = await agent.get('/api/skills/jpage-upload/download').buffer(true).parse(binaryParser);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'] || '', /application\/zip/);
  // Content-Disposition 是附件
  assert.match(res.headers['content-disposition'] || '', /attachment/);
  // zip 魔数 PK
  assert.ok(Buffer.isBuffer(res.body));
  assert.ok(res.body.length > 4);
  assert.strictEqual(res.body[0], 0x50); // 'P'
});

test('GET /api/skills/不存在/download → 404', async () => {
  const res = await agent.get('/api/skills/no-such-skill-xyz/download');
  assert.strictEqual(res.status, 404);
});

// --- mcp/config ---
test('GET /api/mcp/config → 200，含 config.mcpServers.jpage', async () => {
  const res = await agent.get('/api/mcp/config');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.config);
  assert.ok(res.body.config.mcpServers);
  assert.ok(res.body.config.mcpServers.jpage);
  assert.ok(res.body.config.mcpServers.jpage.url);
  assert.strictEqual(res.body.config.mcpServers.jpage.type, 'http');
  // tokens 是当前用户的 token 列表
  assert.ok(Array.isArray(res.body.tokens));
});
