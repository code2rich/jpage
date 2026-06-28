// Skills 集成测试：列表 / 详情 / 下载 zip / mcp/config 结构 / cli 指南。全部 requireAuth。
// 挂载点 /api（/skills、/skills/:name、/skills/:name/download、/mcp/config、/cli/guide）。
// 依赖仓库内 skills/jpage/SKILL.md（内置 skill）。
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
test('GET /api/skills → 200，含内置 jpage skill', async () => {
  const res = await agent.get('/api/skills');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.skills));
  // 仓库内置 jpage skill 应被发现
  assert.ok(res.body.skills.some(s => s.name === 'jpage'), '应含 jpage skill');
});

// --- 详情 ---
test('GET /api/skills/jpage → 200', async () => {
  const res = await agent.get('/api/skills/jpage');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.name, 'jpage');
});

test('GET /api/skills/不存在 → 404', async () => {
  const res = await agent.get('/api/skills/no-such-skill-xyz');
  assert.strictEqual(res.status, 404);
});

// --- 下载 ---
test('GET /api/skills/jpage/download → 200，application/zip', async () => {
  const res = await agent.get('/api/skills/jpage/download').buffer(true).parse(binaryParser);
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

test('GET /api/mcp/config → 200，含多客户端 configs 数组（仅 MCP 客户端）', async () => {
  const res = await agent.get('/api/mcp/config');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.configs));
  // 5 项：全部为 MCP 客户端（CLI 走独立的 /api/cli/guide，不再混入此处）
  assert.strictEqual(res.body.configs.length, 5);
  const ids = res.body.configs.map(c => c.id);
  for (const id of ['claude-code', 'claude-desktop', 'cursor', 'zcode', 'generic']) {
    assert.ok(ids.includes(id), `configs 应包含 ${id}`);
  }
  // CLI 不应再出现在 MCP 配置里
  assert.ok(!ids.includes('cli'), 'configs 不应再包含 cli（已独立为 /api/cli/guide）');
  // 每项含 label / path
  res.body.configs.forEach(c => {
    assert.ok(c.label, `${c.id} 应有 label`);
    assert.ok('path' in c, `${c.id} 应有 path`);
  });
  // 每项都是 MCP 客户端，config.mcpServers.jpage 必有
  res.body.configs.forEach(c => {
    assert.ok(c.config && c.config.mcpServers && c.config.mcpServers.jpage, `${c.id} config 应含 mcpServers.jpage`);
  });
});

test('GET /api/cli/guide → 200，返回 CLI 用法指南（与 MCP 并列的独立入口）', async () => {
  const res = await agent.get('/api/cli/guide');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.enabled, true);
  assert.ok(typeof res.body.baseUrl === 'string' && res.body.baseUrl.length > 0, 'baseUrl 应为非空');
  assert.ok(typeof res.body.guideHtml === 'string' && res.body.guideHtml.length > 0, 'guideHtml 应为非空 HTML');
  assert.ok(res.body.guideHtml.includes('jpage'), 'guideHtml 应含 jpage 说明');
  assert.ok(typeof res.body.guideText === 'string' && res.body.guideText.length > 0, 'guideText 应为非空文档');
  // guideText 里 baseUrl 应已被替换为实际服务地址（不含 <baseUrl> 占位）
  assert.ok(!res.body.guideText.includes('<baseUrl>'), 'guideText 不应残留 baseUrl 占位符');
});

test('未登录 GET /api/cli/guide → 401', async () => {
  const res = await request(env.app).get('/api/cli/guide');
  assert.strictEqual(res.status, 401);
});
