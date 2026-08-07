// 覆盖上传路由集成测试：multipart / JSON 覆盖的校验与版本保留分支。
// 覆盖 routes/files/overwrite.js 的 400（无文件/类型不匹配/非字符串/超限）、404、200 分支。

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

let env;
let admin;
let user;

test.before(async () => {
  env = createTestEnv();
  await env.ready();

  admin = request.agent(env.app);
  await admin.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });

  await admin.post('/api/users').send({ username: 'alice', password: 'alicepass123', role: 'user' });
  user = request.agent(env.app);
  await user.post('/api/auth/login').send({ username: 'alice', password: 'alicepass123' });
});

test.after(() => {
  env.cleanup();
});

async function seedMd(agent, name) {
  const up = await agent.post('/api/files/upload-json').send({ name, content: '# v1', isPublic: false });
  return up.body.id;
}

// ====================== POST /:id/overwrite （multipart） ======================

test('multipart 覆盖：未上传文件 → 400', async () => {
  const id = await seedMd(user, 'ow-nofile.md');
  const res = await user.post(`/api/files/${id}/overwrite`);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '未上传文件');
});

test('multipart 覆盖：文件不存在 → 404', async () => {
  const res = await user.post('/api/files/999999/overwrite')
    .attach('file', Buffer.from('# x'), 'x.md');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '文件不存在');
});

test('multipart 覆盖：文件类型不匹配（md → html）→ 400', async () => {
  const id = await seedMd(user, 'ow-typemismatch.md');
  const res = await user.post(`/api/files/${id}/overwrite`)
    .attach('file', Buffer.from('<p>x</p>'), 'x.html');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '文件类型不匹配');
});

test('multipart 覆盖：同名类型匹配 → 200 且版本递增', async () => {
  const id = await seedMd(user, 'ow-ok.md');
  const before = await user.get(`/api/files/${id}/versions`);
  const res = await user.post(`/api/files/${id}/overwrite`)
    .attach('file', Buffer.from('# v2'), 'ow-ok.md');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.overwritten, true);
  assert.ok(res.body.version > 1);
  const after = await user.get(`/api/files/${id}/versions`);
  assert.ok(after.body.versions.length > before.body.versions.length);
});

// ====================== POST /:id/overwrite-json ======================

test('json 覆盖：content 非字符串 → 400', async () => {
  const id = await seedMd(user, 'owj-bad.md');
  const res = await user.post(`/api/files/${id}/overwrite-json`).send({ content: 123 });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'content 必须是字符串');
});

test('json 覆盖：文件不存在 → 404', async () => {
  const res = await user.post('/api/files/999999/overwrite-json').send({ content: 'x' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '文件不存在');
});

test('json 覆盖：body 超过 50MB → 被拒绝（largeJson 兜底，非 200）', async () => {
  const id = await seedMd(user, 'owj-big.md');
  // 构造 >50MB 的字符串：largeJson（express.json limit 50mb）会先于路由拦截
  const huge = 'x'.repeat(51 * 1024 * 1024);
  const res = await user.post(`/api/files/${id}/overwrite-json`).send({ content: huge });
  assert.notStrictEqual(res.status, 200);
  assert.ok(res.status >= 400, `期望 4xx/5xx，实际 ${res.status}`);
});

test('json 覆盖：正常 → 200 且内容更新', async () => {
  const id = await seedMd(user, 'owj-ok.md');
  const res = await user.post(`/api/files/${id}/overwrite-json`).send({ content: '# updated' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.overwritten, true);
  const content = await user.get(`/api/files/${id}/content`);
  assert.strictEqual(content.body.content, '# updated');
});

// ====================== upload.js 剩余分支（upload-json 同名覆盖 / zip-base64 校验） ======================

test('upload-json：同名文件覆盖且类型匹配 → overwritten=true', async () => {
  await user.post('/api/files/upload-json').send({ name: 'dup.md', content: '# first', isPublic: false });
  const res = await user.post('/api/files/upload-json').send({ name: 'dup.md', content: '# second', isPublic: false });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.overwritten, true);
});

test('upload-json：扩展名不支持 → 400', async () => {
  const res = await user.post('/api/files/upload-json').send({ name: 'bad.txt', content: 'x', isPublic: false });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /仅支持/);
});

test('upload-zip-base64：非 zip 扩展名 → 400', async () => {
  const res = await user.post('/api/files/upload-zip-base64').send({ name: 'notzip.md', content: 'eA==', isPublic: false });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '仅支持 ZIP 文件');
});

test('upload-zip-base64：body 超过 50MB → 被拒绝（largeJson 兜底，非 200）', async () => {
  // 构造 base64 解码后 >50MB 的字符串：largeJson 会先于路由拦截
  const huge = 'A'.repeat(51 * 1024 * 1024);
  const res = await user.post('/api/files/upload-zip-base64').send({ name: 'big.zip', content: huge, isPublic: false });
  assert.notStrictEqual(res.status, 200);
  assert.ok(res.status >= 400, `期望 4xx/5xx，实际 ${res.status}`);
});

test('upload-zip-base64：name 为空 → 400', async () => {
  const res = await user.post('/api/files/upload-zip-base64').send({ name: '', content: 'eA==', isPublic: false });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '文件名不能为空');
});
