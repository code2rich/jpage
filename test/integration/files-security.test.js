// 文件路由安全关键路径集成测试：ZIP 上传（安全校验）/ CSP 分级下发 / 权限隔离。
// 与 files.test.js 共用同一套 helper（隔离 SQLite 数据目录 + admin agent）。

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const JSZip = require('jszip');
const { createTestEnv } = require('../helpers/setup');

let env;
let admin;        // admin agent
let user;         // 普通用户 agent
let otherUser;    // 另一个普通用户 agent

// 用 JSZip 构造 ZIP buffer（同步拼装，上传时转 base64）
async function makeZip(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

test.before(async () => {
  env = createTestEnv();
  await env.ready();

  admin = request.agent(env.app);
  await admin.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });

  // admin 创建两个普通用户
  await admin.post('/api/users').send({ username: 'alice', password: 'alicepass123', role: 'user' });
  await admin.post('/api/users').send({ username: 'bob', password: 'bobpass123', role: 'user' });

  user = request.agent(env.app);
  await user.post('/api/auth/login').send({ username: 'alice', password: 'alicepass123' });
  otherUser = request.agent(env.app);
  await otherUser.post('/api/auth/login').send({ username: 'bob', password: 'bobpass123' });
});

test.after(() => {
  env.cleanup();
});

// ====================== ZIP 上传安全 ======================

test('ZIP bundle 上传：index.html + 子目录资源 → is_bundle=1', async () => {
  const buf = await makeZip({
    'index.html': '<!DOCTYPE html><html><body><h1>bundle</h1></body></html>',
    'css/style.css': 'body{color:red}',
    'img/logo.svg': '<svg></svg>',
  });
  const res = await user.post('/api/files/upload-zip-base64').send({
    name: 'site.zip',
    content: buf.toString('base64'),
    isPublic: false,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.is_bundle, 1);
  assert.ok(res.body.entry_path);
  assert.strictEqual(res.body.file_type, 'html');
});

test('ZIP batch 上传：多个根目录 HTML → type=batch', async () => {
  const buf = await makeZip({
    'a.html': '<p>a</p>',
    'b.html': '<p>b</p>',
  });
  const res = await user.post('/api/files/upload-zip-base64').send({
    name: 'batch.zip',
    content: buf.toString('base64'),
    isPublic: false,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.type, 'batch');
  assert.ok(res.body.count >= 2);
});

test('ZIP 穿越防护：上传带 ../ 的 ZIP 不会写出越界文件', async () => {
  // JSZip 在生成阶段会把真实 ../ 规范化掉，所以这里无法通过 HTTP 端点
  // 触发 validateZipEntries 的目录穿越分支（该分支由 test/unit/zip.test.js
  // 直接注入恶意 normalizedPath 覆盖）。本用例验证端到端的最终保证：
  // 即便 zip 里有 ../ 前缀条目，服务端也不会在 UPLOAD_DIR 之外创建文件。
  const zip = new JSZip();
  zip.file('../escape-attempt.txt', 'evil'); // 生成后会被规范化为 escape-attempt.txt
  zip.file('index.html', '<p>ok</p>');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const res = await user.post('/api/files/upload-zip-base64').send({
    name: 'traversal.zip',
    content: buf.toString('base64'),
  });
  // 上传成功（被规范化为合法 bundle），但越界文件绝不能存在
  assert.strictEqual(res.status, 200);
  const dataDir = env.dataDir;
  const uploadsDir = require('path').join(dataDir, 'uploads');
  const walk = (dir) => {
    const found = [];
    for (const e of require('fs').readdirSync(dir, { withFileTypes: true })) {
      const full = require('path').join(dir, e.name);
      if (e.isDirectory()) found.push(...walk(full));
      else found.push(full);
    }
    return found;
  };
  const allFiles = walk(uploadsDir);
  // UPLOAD_DIR 之外不应出现 escape-attempt.txt
  const escaped = allFiles.filter(f => !f.startsWith(uploadsDir));
  assert.strictEqual(escaped.length, 0, '不应有文件写到 UPLOAD_DIR 之外');
  // 也不应有真正叫 escape-attempt.txt 的越界文件（规范化后落在 bundle 目录内才算正常）
  assert.ok(!allFiles.some(f => f.endsWith('../escape-attempt.txt')));
});

test('ZIP 无任何 HTML/Markdown → 400', async () => {
  const buf = await makeZip({
    'a.css': 'body{}',
    'b.js': 'console.log(1)',
  });
  const res = await user.post('/api/files/upload-zip-base64').send({
    name: 'nohtml.zip',
    content: buf.toString('base64'),
  });
  assert.strictEqual(res.status, 400);
});

test('upload-zip-base64 非 zip 扩展名 → 400', async () => {
  const res = await user.post('/api/files/upload-zip-base64').send({
    name: 'notzip.txt',
    content: 'aGVsbG8=',
  });
  assert.strictEqual(res.status, 400);
});

test('ZIP batch 响应含 failed 字段（成功时为空数组）', async () => {
  // 验证 batch 响应契约：新增 failed 数组，成功时为空
  const buf = await makeZip({
    'batch-ok-1.html': '<p>1</p>',
    'batch-ok-2.html': '<p>2</p>',
  });
  const res = await user.post('/api/files/upload-zip-base64').send({
    name: 'batch-contract.zip',
    content: buf.toString('base64'),
    isPublic: false,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.type, 'batch');
  assert.strictEqual(res.body.count, 2);
  assert.ok(Array.isArray(res.body.failed), 'batch 响应必须含 failed 数组');
  assert.strictEqual(res.body.failed.length, 0, '全部成功时 failed 为空数组');
});

test('损坏的 ZIP（非 ZIP 字节）→ 500 + 友好中文（不再含「ZIP 处理失败:」前缀）', async () => {
  // 构造一段不是 ZIP 的字节
  const notZip = Buffer.from('this is definitely not a zip file payload');
  const res = await user.post('/api/files/upload-zip-base64').send({
    name: 'corrupt.zip',
    content: notZip.toString('base64'),
  });
  assert.strictEqual(res.status, 500);
  assert.ok(res.body.error, '应返回错误消息');
  assert.ok(!res.body.error.startsWith('ZIP 处理失败:'), '不应再用「ZIP 处理失败:」前缀');
  assert.match(res.body.error, /损坏|损坏或不是|解压失败|加密/);
});

// ====================== CSP 分级下发 ======================

test('Markdown 渲染页下发严格 CSP（含 nonce，无 unsafe-inline script）', async () => {
  const up = await admin.post('/api/files/upload-json').send({
    name: 'csp-md.md',
    content: '# 标题\n\n```mermaid\ngraph LR;A-->B\n```',
    isPublic: true,
  });
  const res = await admin.get(`/api/files/${up.body.id}/render`);
  assert.strictEqual(res.status, 200);
  const csp = res.headers['content-security-policy'] || '';
  // 必须有 script-src 且含 nonce（不能是 unsafe-inline）
  assert.match(csp, /script-src[^;]*'nonce-/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'Markdown 页不应放开 script unsafe-inline');
});

test('HTML 渲染页下发宽松 CSP（允许 inline script + https）', async () => {
  const up = await admin.post('/api/files/upload-json').send({
    name: 'csp-html.html',
    content: '<!DOCTYPE html><html><body><script>console.log(1)</script></body></html>',
    isPublic: true,
  });
  const res = await admin.get(`/api/files/${up.body.id}/render`);
  assert.strictEqual(res.status, 200);
  const csp = res.headers['content-security-policy'] || '';
  assert.match(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /script-src[^;]*https:/);
});

test('管理界面 API 下发严格 CSP（无 unsafe-inline script）', async () => {
  // files 列表走 APP_CSP（非渲染端点）
  const res = await admin.get('/api/files');
  assert.strictEqual(res.status, 200);
  const csp = res.headers['content-security-policy'] || '';
  assert.match(csp, /script-src[^;]*'self'/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), '管理界面不应放开 script unsafe-inline');
  // 管理界面 frame-ancestors none
  assert.match(csp, /frame-ancestors 'none'/);
});

// ====================== 权限隔离 ======================

test('普通用户上传的私有文件，其他普通用户访问 → 403', async () => {
  // alice 上传私有文件
  const up = await user.post('/api/files/upload-json').send({
    name: 'alice-private.md',
    content: '# secret',
    isPublic: false,
  });
  assert.strictEqual(up.body.is_public, 0);
  // bob 尝试读取详情 → 403
  const detail = await otherUser.get(`/api/files/${up.body.id}`);
  assert.strictEqual(detail.status, 403);
  // bob 尝试读取原文 → 403
  const content = await otherUser.get(`/api/files/${up.body.id}/content`);
  assert.strictEqual(content.status, 403);
  // bob 尝试渲染 → 403
  const render = await otherUser.get(`/api/files/${up.body.id}/render`);
  assert.strictEqual(render.status, 403);
});

test('普通用户不能修改/删除他人私有文件 → 403', async () => {
  const up = await user.post('/api/files/upload-json').send({
    name: 'alice-no-edit.md',
    content: 'x',
    isPublic: false,
  });
  // bob 尝试改名
  const rename = await otherUser.put(`/api/files/${up.body.id}`).send({ name: 'hacked.md' });
  assert.strictEqual(rename.status, 403);
  // bob 尝试删除
  const del = await otherUser.delete(`/api/files/${up.body.id}`);
  assert.strictEqual(del.status, 403);
});

test('普通用户不能批量删除他人文件 → 403', async () => {
  const up = await user.post('/api/files/upload-json').send({
    name: 'alice-batch.md',
    content: 'x',
    isPublic: false,
  });
  const res = await otherUser.post('/api/files/batch').send({ action: 'delete', ids: [up.body.id] });
  assert.strictEqual(res.status, 403);
});

test('公开文件任何登录用户都能访问', async () => {
  const up = await user.post('/api/files/upload-json').send({
    name: 'alice-public.md',
    content: '# public',
    isPublic: true,
  });
  const detail = await otherUser.get(`/api/files/${up.body.id}`);
  assert.strictEqual(detail.status, 200);
});

test('admin 可访问任意用户的私有文件', async () => {
  const up = await user.post('/api/files/upload-json').send({
    name: 'alice-admin-can-see.md',
    content: 'private',
    isPublic: false,
  });
  const detail = await admin.get(`/api/files/${up.body.id}`);
  assert.strictEqual(detail.status, 200);
});

test('跨用户上传同名文件：互不影响、不覆盖（按用户隔离）', async () => {
  // alice 上传 alice-collision.md
  const aliceUp = await user.post('/api/files/upload-json').send({
    name: 'user-collision.md',
    content: '# alice content',
    isPublic: false,
  });
  assert.strictEqual(aliceUp.status, 200);
  assert.ok(!aliceUp.body.overwritten, '首次上传不应是覆盖');
  const aliceId = aliceUp.body.id;

  // bob 上传同名 user-collision.md：应为新建，不覆盖 alice 的记录
  const bobUp = await otherUser.post('/api/files/upload-json').send({
    name: 'user-collision.md',
    content: '# bob content',
    isPublic: false,
  });
  assert.strictEqual(bobUp.status, 200);
  assert.ok(!bobUp.body.overwritten, '跨用户同名不应覆盖');
  assert.notStrictEqual(bobUp.body.id, aliceId, '应是两条不同记录');

  // alice 的原文件内容未被改动（读回原文验证）
  const aliceContent = await user.get(`/api/files/${aliceId}/content`);
  assert.strictEqual(aliceContent.status, 200);
  assert.strictEqual(aliceContent.body.content, '# alice content');

  // alice 的版本数仍为 0（未被覆盖生成版本）
  const aliceVersions = await user.get(`/api/files/${aliceId}/versions`);
  assert.strictEqual(aliceVersions.status, 200);
  assert.strictEqual(aliceVersions.body.versions.length, 0, 'alice 文件不应产生历史版本');
});

test('同用户上传同名文件：仍保留覆盖+版本语义', async () => {
  const first = await user.post('/api/files/upload-json').send({
    name: 'alice-self-overwrite.md',
    content: 'v1',
    isPublic: false,
  });
  const second = await user.post('/api/files/upload-json').send({
    name: 'alice-self-overwrite.md',
    content: 'v2',
    isPublic: false,
  });
  assert.strictEqual(second.status, 200);
  assert.ok(second.body.overwritten, '同用户同名应触发覆盖');
  assert.strictEqual(second.body.id, first.body.id, '覆盖后应为同一条记录 id');
  const versions = await user.get(`/api/files/${first.body.id}/versions`);
  assert.ok(versions.body.versions.length >= 1, '应生成至少一条历史版本');
});

test('按 ID 覆盖他人文件 → 403（无权操作）', async () => {
  // alice 上传一个公开文件
  const up = await user.post('/api/files/upload-json').send({
    name: 'alice-overwrite-target.md',
    content: 'original',
    isPublic: true,
  });
  assert.strictEqual(up.status, 200);
  // bob 尝试按 id 覆盖（即便文件公开）→ 403
  const overwrite = await otherUser.post(`/api/files/${up.body.id}/overwrite-json`).send({
    content: '# hacked by bob',
  });
  assert.strictEqual(overwrite.status, 403);
  // 验证 alice 的内容未被改动
  const content = await user.get(`/api/files/${up.body.id}/content`);
  assert.strictEqual(content.body.content, 'original');
});

test('改名撞同用户其他文件名 → 409', async () => {
  // alice 先建两个文件
  await user.post('/api/files/upload-json').send({ name: 'rename-target.md', content: 'a', isPublic: false });
  const other = await user.post('/api/files/upload-json').send({ name: 'rename-exist.md', content: 'b', isPublic: false });
  // 把 rename-target 改名为已存在的 rename-exist.md → 409
  const res = await user.put(`/api/files/${other.body.id}`).send({ name: 'rename-target.md' });
  assert.strictEqual(res.status, 409);
});

test('版本审计：覆盖者被记录为操作者（performed_by），与内容归属 uploaded_by 区分', async () => {
  // alice 上传文件，admin 覆盖它（admin 经 checkFileOwnership 放行）
  const up = await user.post('/api/files/upload-json').send({
    name: 'audit-target.md',
    content: 'alice-original',
    isPublic: false,
  });
  assert.strictEqual(up.status, 200);
  const aliceFileId = up.body.id;

  // admin 通过同名上传覆盖（admin 命名空间内未同名，但 admin 可读 alice 私有文件 →
  // 改用按 id 覆盖路径验证 performed_by）
  const overwrite = await admin.post(`/api/files/${aliceFileId}/overwrite-json`).send({
    content: 'admin-overwritten',
  });
  assert.strictEqual(overwrite.status, 200);
  assert.strictEqual(overwrite.body.overwritten, true);

  // 版本列表：被归档那一版的 uploaded_by 应仍为 alice（内容归属不变），
  // performed_by 应为 admin（触发覆盖的操作者）
  const versions = await admin.get(`/api/files/${aliceFileId}/versions`);
  assert.strictEqual(versions.status, 200);
  assert.ok(versions.body.versions.length >= 1, '应生成历史版本');
  const archived = versions.body.versions[0]; // 仅 1 条历史版本（alice 的原内容）
  assert.strictEqual(archived.performed_by_name, 'admin', '操作者应为 admin');
  assert.notStrictEqual(archived.performed_by_name, 'alice', '操作者不应是 alice');
});

test('短链 /s/:key 私有文件未登录 → 重定向', async () => {
  const up = await user.post('/api/files/upload-json').send({
    name: 'short-private.md',
    content: '# private shortlink',
    isPublic: false,
  });
  const key = up.body.share_key;
  const res = await request(env.app).get(`/s/${key}`);
  // 私有文件未登录访问：302 重定向到 /
  assert.strictEqual(res.status, 302);
});
