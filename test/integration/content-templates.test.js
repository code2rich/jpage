// 内容模板市场集成测试：上架-审核-展示-分类运营 主链路。
// 挂载点 /api/content-templates。迁移 017 建好分类表 + 2 默认分类（html-ppt=1, html-book=2）。
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

let env;
let adminAgent;
let userAgent;

const SAMPLE_HTML = '<!doctype html><body><h1>路演 PPT</h1></body>';

test.before(async () => {
  env = createTestEnv();
  await env.ready();
  adminAgent = request.agent(env.app);
  await adminAgent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
  await adminAgent.post('/api/users').send({ username: 'regular', password: 'regularpass123', role: 'user' });
  userAgent = request.agent(env.app);
  await userAgent.post('/api/auth/login').send({ username: 'regular', password: 'regularpass123' });
});

test.after(() => { env.cleanup(); });

// --- 公开端点（匿名） ---
test('匿名 GET /market → 200，返回空列表（旧数据已归档）', async () => {
  const res = await request(env.app).get('/api/content-templates/market');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.templates));
  assert.strictEqual(res.body.templates.length, 0, '旧内置模板应被归档，市场为空');
});

test('匿名 GET /categories → 200，返回 2 个默认分类', async () => {
  const res = await request(env.app).get('/api/content-templates/categories');
  assert.strictEqual(res.status, 200);
  const slugs = res.body.categories.map(c => c.slug);
  assert.ok(slugs.includes('html-ppt'));
  assert.ok(slugs.includes('html-book'));
});

// --- 提交校验 ---
test('提交模板：缺标题 → 400', async () => {
  const res = await userAgent.post('/api/content-templates').send({ content: '<p>x</p>', categoryId: 1 });
  assert.strictEqual(res.status, 400);
});

test('提交模板：缺内容 → 400', async () => {
  const res = await userAgent.post('/api/content-templates').send({ title: 't', categoryId: 1 });
  assert.strictEqual(res.status, 400);
});

test('提交模板：缺分类 → 400', async () => {
  const res = await userAgent.post('/api/content-templates').send({ title: 't', content: '<p>x</p>' });
  assert.strictEqual(res.status, 400);
});

test('提交模板：非法 fileType → 400', async () => {
  const res = await userAgent.post('/api/content-templates').send({ title: 't', content: 'x', fileType: 'pdf', categoryId: 1 });
  assert.strictEqual(res.status, 400);
});

test('提交模板：分类不存在 → 400', async () => {
  const res = await userAgent.post('/api/content-templates').send({ title: 't', content: 'x', categoryId: 9999 });
  assert.strictEqual(res.status, 400);
});

// --- 主链路：提交 → 待审 → 不展示 → 审核通过 → 展示 ---
test('提交后状态为 pending，市场不展示', async () => {
  const submit = await userAgent.post('/api/content-templates').send({
    title: '商务路演 PPT', description: '融资演示', fileType: 'html', categoryId: 1, content: SAMPLE_HTML,
  });
  assert.strictEqual(submit.status, 200);
  assert.strictEqual(submit.body.status, 'pending');

  // 市场首页看不到
  const market = await request(env.app).get('/api/content-templates/market');
  assert.strictEqual(market.body.templates.length, 0);

  // 我的上架能看到，状态 pending
  const mine = await userAgent.get('/api/content-templates/mine');
  const found = mine.body.templates.find(t => t.id === submit.body.id);
  assert.ok(found);
  assert.strictEqual(found.status, 'pending');
});

test('管理员审核通过+展示 → 出现在市场', async () => {
  const submit = await userAgent.post('/api/content-templates').send({
    title: '通过展示的模板', fileType: 'html', categoryId: 1, content: SAMPLE_HTML,
  });
  const id = submit.body.id;

  // 审核前市场为空
  assert.strictEqual((await request(env.app).get('/api/content-templates/market')).body.templates.length, 0);

  const review = await adminAgent.post(`/api/content-templates/${id}/review`).send({
    status: 'approved', visibility: 'visible', reviewNote: '通过',
  });
  assert.strictEqual(review.status, 200);

  // 现在市场能看到
  const market = await request(env.app).get('/api/content-templates/market');
  assert.ok(market.body.templates.some(t => t.id === id));

  // 详情可匿名访问
  const detail = await request(env.app).get(`/api/content-templates/market/${id}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.title, '通过展示的模板');

  // 预览内容可匿名访问
  const preview = await request(env.app).get(`/api/content-templates/market/${id}/preview`);
  assert.strictEqual(preview.status, 200);
  assert.ok(preview.body.content.includes('路演'));
});

test('管理员通过但隐藏 → 不出现在市场', async () => {
  const submit = await userAgent.post('/api/content-templates').send({
    title: '通过但隐藏', fileType: 'html', categoryId: 1, content: '<p>hidden</p>',
  });
  await adminAgent.post(`/api/content-templates/${submit.body.id}/review`).send({
    status: 'approved', visibility: 'hidden',
  });
  const market = await request(env.app).get('/api/content-templates/market');
  assert.ok(!market.body.templates.some(t => t.id === submit.body.id));
});

test('管理员拒绝 → 市场不展示，作者看到 review_note', async () => {
  const submit = await userAgent.post('/api/content-templates').send({
    title: '会被拒', fileType: 'html', categoryId: 1, content: '<p>x</p>',
  });
  const id = submit.body.id;
  await adminAgent.post(`/api/content-templates/${id}/review`).send({
    status: 'rejected', reviewNote: '内容不完整',
  });
  // 市场无
  const market = await request(env.app).get('/api/content-templates/market');
  assert.ok(!market.body.templates.some(t => t.id === id));
  // 作者看到拒绝+意见
  const mine = await userAgent.get('/api/content-templates/mine?status=rejected');
  const found = mine.body.templates.find(t => t.id === id);
  assert.ok(found);
  assert.strictEqual(found.status, 'rejected');
  assert.strictEqual(found.review_note, '内容不完整');
});

// --- 权限 ---
test('未登录提交 → 401', async () => {
  const res = await request(env.app).post('/api/content-templates').send({ title: 't', content: 'x', categoryId: 1 });
  assert.strictEqual(res.status, 401);
});

test('非作者不能编辑他人 pending 模板 → 403', async () => {
  const submit = await adminAgent.post('/api/content-templates').send({
    title: 'admin的', fileType: 'html', categoryId: 1, content: '<p>x</p>',
  });
  const res = await userAgent.put(`/api/content-templates/${submit.body.id}`).send({ title: '篡改' });
  assert.strictEqual(res.status, 403);
});

test('approved 模板编辑后回退 pending', async () => {
  const submit = await userAgent.post('/api/content-templates').send({
    title: '已通过待编辑', fileType: 'html', categoryId: 1, content: '<p>x</p>',
  });
  const id = submit.body.id;
  await adminAgent.post(`/api/content-templates/${id}/review`).send({ status: 'approved', visibility: 'visible' });
  // 作者编辑
  await userAgent.put(`/api/content-templates/${id}`).send({ title: '改过了' });
  const mine = await userAgent.get('/api/content-templates/mine?status=pending');
  const found = mine.body.templates.find(t => t.id === id);
  assert.ok(found, '编辑后应回退到 pending');
  assert.strictEqual(found.status, 'pending');
});

// --- 删除（软归档）---
test('作者归档模板 → 市场移除，但数据保留', async () => {
  const submit = await userAgent.post('/api/content-templates').send({
    title: '待归档', fileType: 'html', categoryId: 1, content: '<p>x</p>',
  });
  const id = submit.body.id;
  await adminAgent.post(`/api/content-templates/${id}/review`).send({ status: 'approved', visibility: 'visible' });
  // 归档前在市场
  assert.ok((await request(env.app).get('/api/content-templates/market')).body.templates.some(t => t.id === id));
  // 归档
  const del = await userAgent.delete(`/api/content-templates/${id}`);
  assert.strictEqual(del.status, 200);
  // 市场移除
  assert.ok(!(await request(env.app).get('/api/content-templates/market')).body.templates.some(t => t.id === id));
  // 我的上架里能看到 archived
  const mine = await userAgent.get('/api/content-templates/mine?status=archived');
  assert.ok(mine.body.templates.some(t => t.id === id));
});

// --- 使用计数 ---
test('POST :id/use 对 approved+visible 递增，对未上架拒绝', async () => {
  const submit = await userAgent.post('/api/content-templates').send({
    title: '计数', fileType: 'html', categoryId: 1, content: '<p>x</p>',
  });
  const id = submit.body.id;
  // 未上架时 use → 400
  const beforeApprove = await adminAgent.post(`/api/content-templates/${id}/use`);
  assert.strictEqual(beforeApprove.status, 400);
  await adminAgent.post(`/api/content-templates/${id}/review`).send({ status: 'approved', visibility: 'visible' });
  const use = await adminAgent.post(`/api/content-templates/${id}/use`);
  assert.strictEqual(use.status, 200);
  assert.ok(use.body.use_count >= 1);
});

// --- 管理员分类管理 ---
test('管理员可新增/编辑/停用分类', async () => {
  // 新增
  const create = await adminAgent.post('/api/content-templates/admin/categories').send({
    slug: 'html-doc', name: 'HTML-DOC', sortOrder: 3,
  });
  assert.strictEqual(create.status, 200);
  const catId = create.body.id;

  // 编辑（改名+停用）
  const upd = await adminAgent.put(`/api/content-templates/admin/categories/${catId}`).send({ isEnabled: false });
  assert.strictEqual(upd.status, 200);

  // 公开分类列表不含已停用
  const cats = await request(env.app).get('/api/content-templates/categories');
  assert.ok(!cats.body.categories.some(c => c.id === catId));

  // 管理员列表能看到（含禁用）
  const adminCats = await adminAgent.get('/api/content-templates/admin/categories');
  assert.ok(adminCats.body.categories.some(c => c.id === catId && c.is_enabled === 0));
});

test('非管理员不能访问管理端点 → 403', async () => {
  const res = await userAgent.get('/api/content-templates/admin/list');
  assert.strictEqual(res.status, 403);
});

test('非管理员不能审核 → 403', async () => {
  const submit = await userAgent.post('/api/content-templates').send({
    title: 'x', fileType: 'html', categoryId: 1, content: '<p>x</p>',
  });
  const res = await userAgent.post(`/api/content-templates/${submit.body.id}/review`).send({ status: 'approved', visibility: 'visible' });
  assert.strictEqual(res.status, 403);
});

test('删除有模板的分类 → 改为停用而非物理删除', async () => {
  // html-ppt(id=1) 下提交一个模板
  const submit = await userAgent.post('/api/content-templates').send({
    title: '占位', fileType: 'html', categoryId: 1, content: '<p>x</p>',
  });
  assert.strictEqual(submit.status, 200);
  // 删除分类 1 → 应返回 disabled:true
  const del = await adminAgent.delete('/api/content-templates/admin/categories/1');
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.disabled, true);
  // 分类仍存在但已停用
  const adminCats = await adminAgent.get('/api/content-templates/admin/categories');
  const cat1 = adminCats.body.categories.find(c => c.id === 1);
  assert.ok(cat1);
  assert.strictEqual(cat1.is_enabled, 0);
});
