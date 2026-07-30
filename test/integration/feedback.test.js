// 问题反馈集成测试：免登录公开接口 POST /api/feedback
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

test('POST /api/feedback → 空内容返回 400', async () => {
  const res = await request(env.app).post('/api/feedback').send({ content: '' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /不能为空/);
});

test('POST /api/feedback → 超长内容返回 400', async () => {
  const big = 'x'.repeat(5001);
  const res = await request(env.app).post('/api/feedback').send({ content: big });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /5000/);
});

test('POST /api/feedback → 匿名提交成功并写库', async () => {
  const res = await request(env.app)
    .post('/api/feedback')
    .send({ content: '希望支持暗色模式', category: 'feature', name: 'Alice', contact: 'alice@example.com' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.id);

  // 验证写库
  const { dbGet } = require('../../lib/db');
  const row = await dbGet('SELECT * FROM feedback WHERE id = ?', [res.body.id]);
  assert.strictEqual(row.content, '希望支持暗色模式');
  assert.strictEqual(row.category, 'feature');
  assert.strictEqual(row.name, 'Alice');
  assert.strictEqual(row.contact, 'alice@example.com');
  assert.strictEqual(row.user_id, null); // 匿名
  assert.strictEqual(row.status, 'new');
});

test('POST /api/feedback → 非法 category 回退为 feature（与默认一致）', async () => {
  const res = await request(env.app)
    .post('/api/feedback')
    .send({ content: '测试非法类型', category: 'invalid_type' });
  assert.strictEqual(res.status, 200);
  const { dbGet } = require('../../lib/db');
  const row = await dbGet('SELECT category FROM feedback WHERE id = ?', [res.body.id]);
  assert.strictEqual(row.category, 'feature');
});

test('POST /api/feedback → 未带 category 默认 feature', async () => {
  const res = await request(env.app).post('/api/feedback').send({ content: '没填类型' });
  assert.strictEqual(res.status, 200);
  const { dbGet } = require('../../lib/db');
  const row = await dbGet('SELECT category FROM feedback WHERE id = ?', [res.body.id]);
  assert.strictEqual(row.category, 'feature');
});

test('resolveFeedbackEmail → 优先级 FEEDBACK_EMAIL > admin 邮箱 > SMTP_FROM', async () => {
  const { resolveFeedbackEmail } = require('../../routes/feedback');
  const { dbGet, dbRun } = require('../../lib/db');

  // 1. 未配置任何变量、admin 无邮箱 → 返回 null
  delete process.env.FEEDBACK_EMAIL;
  delete process.env.SMTP_FROM;
  const admin = await dbGet("SELECT id, email FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
  const originalEmail = admin.email;
  await dbRun('UPDATE users SET email = NULL WHERE id = ?', [admin.id]);
  assert.strictEqual(await resolveFeedbackEmail(), null);

  // 2. admin 有邮箱 → 返回 admin 邮箱
  await dbRun('UPDATE users SET email = ? WHERE id = ?', ['admin@example.com', admin.id]);
  assert.strictEqual(await resolveFeedbackEmail(), 'admin@example.com');

  // 3. 配置 FEEDBACK_EMAIL → 覆盖 admin 邮箱
  process.env.FEEDBACK_EMAIL = 'feedback@example.com';
  assert.strictEqual(await resolveFeedbackEmail(), 'feedback@example.com');

  // 4. SMTP_FROM 兜底（admin 无邮箱、无 FEEDBACK_EMAIL）
  delete process.env.FEEDBACK_EMAIL;
  await dbRun('UPDATE users SET email = NULL WHERE id = ?', [admin.id]);
  process.env.SMTP_FROM = 'noreply@example.com';
  assert.strictEqual(await resolveFeedbackEmail(), 'noreply@example.com');

  // 还原环境
  delete process.env.SMTP_FROM;
  await dbRun('UPDATE users SET email = ? WHERE id = ?', [originalEmail, admin.id]);
});
