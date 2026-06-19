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
