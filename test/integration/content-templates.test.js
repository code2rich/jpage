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
  const mine = await userAgent.get('/api/content-templates/mine?status=pending&limit=20');
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

// ============================================================
// 从文件上架（from-file）主链路
// ============================================================

// 辅助：上传一个文件并返回 id
async function uploadFile(agent, name, content) {
  const res = await agent.post('/api/files/upload-json').set('X-Upload-Source', 'test').send({ name, content });
  return res.body.id;
}

test('from-file：从文件上架 → pending，市场不展示', async () => {
  const fileId = await uploadFile(userAgent, '路演.html', '<!doctype html><body><h1>路演</h1></body>');
  assert.ok(fileId);
  const res = await userAgent.post('/api/content-templates/from-file').send({
    fileId, title: '商务路演', description: '融资演示', categoryId: 2,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'pending');
  assert.strictEqual(res.body.republished, false);
  // 市场不展示
  const market = await request(env.app).get('/api/content-templates/market');
  assert.ok(!market.body.templates.some(t => t.id === res.body.id));
});

test('from-file：同文件再次上架 → 更新现有模板 + 重新审核', async () => {
  const fileId = await uploadFile(userAgent, '重复上架.html', '<p>v1</p>');
  const first = await userAgent.post('/api/content-templates/from-file').send({ fileId, categoryId: 2 });
  const firstId = first.body.id;
  // 审核通过让它变 approved
  await adminAgent.post(`/api/content-templates/${firstId}/review`).send({ status: 'approved', visibility: 'visible' });
  // 再次上架（更新）
  const second = await userAgent.post('/api/content-templates/from-file').send({
    fileId, title: '改过了', categoryId: 2, description: '更新版',
  });
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body.id, firstId, '应返回同一个 template id');
  assert.strictEqual(second.body.republished, true);
  assert.strictEqual(second.body.status, 'pending', '应回退 pending');
  // 市场应已移除（回退 pending+hidden）
  const market = await request(env.app).get('/api/content-templates/market');
  assert.ok(!market.body.templates.some(t => t.id === firstId));
});

test('from-file：bundle 文件 → 400', async () => {
  // 上传一个 zip bundle
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('index.html', '<p>bundle</p>');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const upload = await userAgent.post('/api/files/upload')
    .attach('file', buf, { filename: 'bundle.zip', contentType: 'application/zip' });
  assert.strictEqual(upload.status, 200);
  const fileId = upload.body.id;
  const res = await userAgent.post('/api/content-templates/from-file').send({ fileId, categoryId: 2 });
  assert.strictEqual(res.status, 400);
});

test('from-file：他人文件 → 403', async () => {
  // admin 上传文件，普通用户尝试上架
  const fileId = await uploadFile(adminAgent, 'admin的.html', '<p>admin</p>');
  const res = await userAgent.post('/api/content-templates/from-file').send({ fileId, categoryId: 2 });
  assert.strictEqual(res.status, 403);
});

test('from-file：缺分类 → 400', async () => {
  const fileId = await uploadFile(userAgent, '无分类.html', '<p>x</p>');
  const res = await userAgent.post('/api/content-templates/from-file').send({ fileId });
  assert.strictEqual(res.status, 400);
});

test('GET /by-file/:fileId 返回正确上架状态', async () => {
  const fileId = await uploadFile(userAgent, '状态查询.html', '<p>x</p>');
  // 未上架
  const before = await userAgent.get(`/api/content-templates/by-file/${fileId}`);
  assert.strictEqual(before.status, 200);
  assert.strictEqual(before.body.published, false);
  // 上架
  const pub = await userAgent.post('/api/content-templates/from-file').send({ fileId, categoryId: 2 });
  const after = await userAgent.get(`/api/content-templates/by-file/${fileId}`);
  assert.strictEqual(after.body.published, true);
  assert.strictEqual(after.body.templateId, pub.body.id);
  assert.strictEqual(after.body.status, 'pending');
});

test('mine 列表含 source_file_name', async () => {
  const fileId = await uploadFile(userAgent, '来源追溯.html', '<p>x</p>');
  const pub = await userAgent.post('/api/content-templates/from-file').send({ fileId, categoryId: 2 });
  assert.strictEqual(pub.status, 200, '上架应成功');
  // 用 status=pending 缩小范围，避免分页把目标挤出第一页
  const mine = await userAgent.get('/api/content-templates/mine?status=pending');
  assert.ok(Array.isArray(mine.body.templates), 'mine 应返回 templates 数组');
  const found = mine.body.templates.find(t => t.id === pub.body.id);
  assert.ok(found, `应在 mine(pending) 中找到模板 id=${pub.body.id}，实际返回 ${mine.body.templates.length} 条`);
  assert.strictEqual(found.source_file_id, fileId, 'source_file_id 应等于源文件 id');
  assert.strictEqual(found.source_file_name, '来源追溯.html');
});

// ============================================================
// 实例化（instantiate）主链路：使用模板 → 创建真实文件 + 追溯
// ============================================================

// 辅助：创建一个 approved+visible 模板，返回 id。
// 用 categoryId:2（html-book）——分类 1 会被前置的「删除分类」测试停用。
async function createPublishedTemplate(agent, title) {
  const submit = await agent.post('/api/content-templates').send({
    title: title || '实例化测试模板', fileType: 'html', categoryId: 2, content: '<!doctype html><body><h1>实例化</h1></body>',
  });
  assert.ok(submit.body.id, `模板应创建成功，实际 status=${submit.status} body=${JSON.stringify(submit.body)}`);
  await adminAgent.post(`/api/content-templates/${submit.body.id}/review`).send({ status: 'approved', visibility: 'visible' });
  return submit.body.id;
}

test('instantiate：approved+visible → 创建文件 + 记录 installs + use_count+1', async () => {
  const id = await createPublishedTemplate(userAgent, '可实例化模板');

  // 实例化前 use_count=0
  const metaBefore = await request(env.app).get(`/api/content-templates/market/${id}`);
  assert.strictEqual(metaBefore.body.use_count, 0);

  const res = await userAgent.post(`/api/content-templates/${id}/instantiate`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.fileId, '应返回新建文件 id');
  assert.strictEqual(res.body.templateId, id);

  // 验证文件确实创建了（upload_source='market' 标记来自实例化）
  const fileRes = await userAgent.get(`/api/files/${res.body.fileId}`);
  assert.strictEqual(fileRes.status, 200);
  assert.strictEqual(fileRes.body.upload_source, 'market', '实例化产生的文件 upload_source 应为 market');

  // use_count +1
  const metaAfter = await request(env.app).get(`/api/content-templates/market/${id}`);
  assert.strictEqual(metaAfter.body.use_count, 1);

  // instantiation_count = 1
  assert.strictEqual(metaAfter.body.instantiation_count, 1);
});

test('instantiate：未登录 → 401', async () => {
  const id = await createPublishedTemplate(userAgent, '未登录实例化');
  const res = await request(env.app).post(`/api/content-templates/${id}/instantiate`);
  assert.strictEqual(res.status, 401);
});

test('instantiate：未上架模板（pending）→ 400', async () => {
  const submit = await userAgent.post('/api/content-templates').send({
    title: '未上架', fileType: 'html', categoryId: 2, content: '<p>x</p>',
  });
  const res = await userAgent.post(`/api/content-templates/${submit.body.id}/instantiate`);
  assert.strictEqual(res.status, 404, 'pending+hidden 模板不在市场可见范围，应 404');
});

test('instantiate：不存在的模板 id → 404', async () => {
  const res = await userAgent.post('/api/content-templates/999999/instantiate');
  assert.strictEqual(res.status, 404);
});

test('instantiate：同用户再次实例化同模板 → 刷新 installs 记录（非报错）', async () => {
  const id = await createPublishedTemplate(userAgent, '重复实例化');
  const first = await userAgent.post(`/api/content-templates/${id}/instantiate`);
  const second = await userAgent.post(`/api/content-templates/${id}/instantiate`);
  assert.strictEqual(second.status, 200, 'UNIQUE(template_id,user_id) 应走 ON CONFLICT 更新而非报错');
  assert.ok(second.body.fileId !== first.body.fileId, '每次实例化应创建新文件');
  // instantiation_count 仍为 1（同用户的 install 记录被更新，而非新增）
  const meta = await request(env.app).get(`/api/content-templates/market/${id}`);
  assert.strictEqual(meta.body.instantiation_count, 1, '同用户去重，install 记录数不变');
  assert.strictEqual(meta.body.use_count, 2, '但热度计数 use_count 每次 +1');
});

test('instantiate：不同用户实例化 → instantiation_count 累加', async () => {
  const id = await createPublishedTemplate(adminAgent, '多用户实例化');
  await adminAgent.post(`/api/content-templates/${id}/instantiate`);
  await userAgent.post(`/api/content-templates/${id}/instantiate`);
  const meta = await request(env.app).get(`/api/content-templates/market/${id}`);
  assert.strictEqual(meta.body.instantiation_count, 2, '两个不同用户应各记一条 install');
});

test('GET /market 列表项含 instantiation_count 字段', async () => {
  const id = await createPublishedTemplate(userAgent, '列表字段');
  const market = await request(env.app).get('/api/content-templates/market');
  const found = market.body.templates.find(t => t.id === id);
  assert.ok(found, '模板应在市场列表中');
  assert.strictEqual(typeof found.instantiation_count, 'number', '列表项应含 instantiation_count');
});

test('instantiate：创建的文件内容 = 模板内容快照', async () => {
  const uniqueContent = '<!doctype html><body><h1>快照验证_UNIQUE</h1></body>';
  const submit = await userAgent.post('/api/content-templates').send({
    title: '内容快照', fileType: 'html', categoryId: 2, content: uniqueContent,
  });
  const id = submit.body.id;
  await adminAgent.post(`/api/content-templates/${id}/review`).send({ status: 'approved', visibility: 'visible' });

  const res = await userAgent.post(`/api/content-templates/${id}/instantiate`);
  // 读文件原文，验证内容与模板一致
  const raw = await userAgent.get(`/api/files/${res.body.fileId}/content`);
  assert.strictEqual(raw.status, 200);
  assert.ok(raw.body.content.includes('快照验证_UNIQUE'), '实例化文件内容应与模板一致');
});

// ============================================================
// 收藏 / 下载 / 公开短链
// ============================================================

test('收藏：toggle 收藏/取消，详情返回 starred 状态', async () => {
  const id = await createPublishedTemplate(userAgent, '可收藏模板');
  // 初始未收藏
  const before = await userAgent.get(`/api/content-templates/market/${id}`);
  assert.strictEqual(before.body.starred, false);
  // 收藏
  const starOn = await userAgent.post(`/api/content-templates/${id}/star`);
  assert.strictEqual(starOn.status, 200);
  assert.strictEqual(starOn.body.starred, true);
  const after = await userAgent.get(`/api/content-templates/market/${id}`);
  assert.strictEqual(after.body.starred, true);
  // 取消收藏
  const starOff = await userAgent.post(`/api/content-templates/${id}/star`);
  assert.strictEqual(starOff.body.starred, false);
});

test('收藏：未登录 → 401', async () => {
  const id = await createPublishedTemplate(userAgent, '未登录收藏');
  const res = await request(env.app).post(`/api/content-templates/${id}/star`);
  assert.strictEqual(res.status, 401);
});

test('收藏：不存在的模板 → 404', async () => {
  const res = await userAgent.post('/api/content-templates/999999/star');
  assert.strictEqual(res.status, 404);
});

test('下载：approved+visible → 返回文件内容，Content-Disposition 正确', async () => {
  const id = await createPublishedTemplate(userAgent, '可下载模板');
  const res = await userAgent.get(`/api/content-templates/${id}/download`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.text.includes('实例化'), '下载内容应为模板内容');
  assert.ok(res.headers['content-disposition'].includes('attachment'), '应为附件下载');
  assert.ok(res.headers['content-disposition'].includes('.html'), 'html 模板扩展名应为 .html');
});

test('下载：未上架模板 → 404', async () => {
  const submit = await userAgent.post('/api/content-templates').send({
    title: '未上架下载', fileType: 'html', categoryId: 2, content: '<p>x</p>',
  });
  const res = await userAgent.get(`/api/content-templates/${submit.body.id}/download`);
  assert.strictEqual(res.status, 404);
});

test('短链：生成 → 返回 key → /t/:key 匿名可访问渲染', async () => {
  const id = await createPublishedTemplate(userAgent, '短链模板');
  const share = await userAgent.post(`/api/content-templates/${id}/share`);
  assert.strictEqual(share.status, 200);
  assert.ok(share.body.key, '应返回短链 key');
  // 再次生成应复用同一 key
  const share2 = await userAgent.post(`/api/content-templates/${id}/share`);
  assert.strictEqual(share2.body.key, share.body.key, '应复用已有 key');
  // 匿名访问 /t/:key 渲染内容
  const render = await request(env.app).get(`/t/${share.body.key}`);
  assert.strictEqual(render.status, 200);
  assert.ok(render.text.includes('实例化'), '短链应渲染模板内容');
});

test('短链：未上架模板 → 生成返回 404', async () => {
  const submit = await userAgent.post('/api/content-templates').send({
    title: '未上架短链', fileType: 'html', categoryId: 2, content: '<p>x</p>',
  });
  const res = await userAgent.post(`/api/content-templates/${submit.body.id}/share`);
  assert.strictEqual(res.status, 404);
});

test('短链：不存在的 key → 404', async () => {
  const res = await request(env.app).get('/t/nonexistent_key_12345');
  assert.strictEqual(res.status, 404);
});


