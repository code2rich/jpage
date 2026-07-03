// 公开接口集成测试：免登录粘贴试用 /api/public/try-paste
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

let env;

test.before(async () => {
  env = createTestEnv();
  await env.ready();
});

test.after(() => {
  env.cleanup();
});

test('POST /api/public/try-paste → 空内容返回 400', async () => {
  const res = await request(env.app).post('/api/public/try-paste').send({ content: '' });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.error);
});

test('POST /api/public/try-paste → HTML 内容生成临时页面', async () => {
  const res = await request(env.app)
    .post('/api/public/try-paste')
    .send({ content: '<h1>Hello jpage</h1>' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.id);
  assert.strictEqual(res.body.file_type, 'html');
  assert.ok(res.body.share_key);
  assert.ok(res.body.expires_at);
  assert.match(res.body.url, /^\/s\//);

  // 短链可公开访问
  const shareRes = await request(env.app).get(res.body.url);
  assert.strictEqual(shareRes.status, 200);
  assert.match(shareRes.text, /Hello jpage/);
});

test('POST /api/public/try-paste → Markdown 内容生成临时页面', async () => {
  const res = await request(env.app)
    .post('/api/public/try-paste')
    .send({ content: '# Markdown 试用\n\n这是一段测试内容。' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.file_type, 'markdown');

  const shareRes = await request(env.app).get(res.body.url);
  assert.strictEqual(shareRes.status, 200);
  assert.match(shareRes.text, /Markdown 试用/);
});

test('POST /api/public/try-paste → 超大内容返回 400', async () => {
  const big = 'x'.repeat(300 * 1024);
  const res = await request(env.app).post('/api/public/try-paste').send({ content: big });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /200KB/);
});

test('GET /s/:key → 粘贴试用过期后返回 410 并清理文件', async () => {
  // 创建一条已过期记录：直接操作 DB，让 share_expires_at 为过去时间
  const { dbRun } = require('../../lib/db');
  const { generateShareKey, now } = require('../../lib/util');
  const shareKey = generateShareKey();
  const past = new Date(Date.now() - 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  await dbRun(
    `INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by,
                        share_key, upload_source, share_expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['expired.html', 'nonexistent.html', 'html', 10, 1, null, shareKey, 'try_paste', past, now()]
  );

  const res = await request(env.app).get(`/s/${shareKey}`);
  assert.strictEqual(res.status, 410);

  // 再次访问应 404，说明记录已被清理
  const res2 = await request(env.app).get(`/s/${shareKey}`);
  assert.strictEqual(res2.status, 404);
});
