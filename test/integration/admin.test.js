// 管理员集成测试（仅 admin）：export 备份 / import 恢复 / stats / 权限边界。
// 挂载点 /api/admin，全部 requireAuth + requireAdmin。
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const JSZip = require('jszip');
const { createTestEnv } = require('../helpers/setup');

// supertest 二进制响应解析器：把响应体收集成 Buffer 挂到 res.body。
// export / skills download 都是流式 zip，需 .buffer(true).parse(binaryParser) 才能拿到字节。
function binaryParser(res, cb) {
  const data = [];
  res.on('data', chunk => data.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(data)));
}

let env;
let adminAgent;
let userAgent;

test.before(async () => {
  env = createTestEnv();
  await env.ready();
  adminAgent = request.agent(env.app);
  await adminAgent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
  // 建一个普通用户
  await adminAgent.post('/api/users').send({ username: 'regular', password: 'regularpass123', role: 'user' });
  userAgent = request.agent(env.app);
  await userAgent.post('/api/auth/login').send({ username: 'regular', password: 'regularpass123' });
});

test.after(() => {
  env.cleanup();
});

// --- 权限边界 ---
test('未登录 GET /api/admin/stats → 401', async () => {
  const res = await request(env.app).get('/api/admin/stats');
  assert.strictEqual(res.status, 401);
});

test('普通用户 GET /api/admin/stats → 403', async () => {
  const res = await userAgent.get('/api/admin/stats');
  assert.strictEqual(res.status, 403);
});

// --- stats ---
test('admin GET /api/admin/stats → 200，含统计字段', async () => {
  const res = await adminAgent.get('/api/admin/stats');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof res.body.fileCount, 'number');
  assert.strictEqual(typeof res.body.dbSize, 'number');
  assert.strictEqual(typeof res.body.uploadsSize, 'number');
  assert.strictEqual(res.body.totalSize, res.body.dbSize + res.body.uploadsSize);
});

// --- export ---
test('admin GET /api/admin/export → 200，application/zip', async () => {
  const res = await adminAgent.get('/api/admin/export').buffer(true).parse(binaryParser);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'] || '', /application\/zip/);
  assert.match(res.headers['content-disposition'] || '', /attachment/);
  // 至少有内容（zip 魔数 PK）
  assert.ok(Buffer.isBuffer(res.body));
  assert.ok(res.body.length > 4);
  assert.strictEqual(res.body[0], 0x50); // 'P'
});

test('普通用户 GET /api/admin/export → 403', async () => {
  const res = await userAgent.get('/api/admin/export');
  assert.strictEqual(res.status, 403);
});

// --- import ---
test('admin import：非 ZIP / 缺 file 字段 → 400', async () => {
  const res = await adminAgent.post('/api/admin/import');
  assert.strictEqual(res.status, 400);
});

test('admin import：ZIP 缺 database.sqlite → 400', async () => {
  // 构造一个不含 database.sqlite 的 zip
  const zip = new JSZip();
  zip.file('readme.txt', 'not a backup');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const res = await adminAgent.post('/api/admin/import').attach('file', buf, 'bad.zip');
  assert.strictEqual(res.status, 400);
});

test('admin export→import round-trip → 200', async () => {
  // 先 export 拿到合法备份（buffer 二进制）
  const exportRes = await adminAgent.get('/api/admin/export').buffer(true).parse(binaryParser);
  const buf = exportRes.body; // 已是 Buffer
  // 再 import 回去（应有 database.sqlite）
  const res = await adminAgent.post('/api/admin/import').attach('file', buf, 'roundtrip.zip');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  // 导入后 stats 仍可读
  const stats = await adminAgent.get('/api/admin/stats');
  assert.strictEqual(stats.status, 200);
});

test('普通用户 import → 403', async () => {
  const zip = new JSZip();
  zip.file('database.sqlite', 'fake');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const res = await userAgent.post('/api/admin/import').attach('file', buf, 'x.zip');
  assert.strictEqual(res.status, 403);
});
