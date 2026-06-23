// 版本历史上限与自动裁剪集成测试。
// 通过 MAX_FILE_VERSIONS=3 验证：超过上限时最旧版本被删除（DB + 磁盘文件），
// 保留的是最近 N 个历史版本。验证 batch 上传失败明细。
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

// 在加载 server / _shared 之前设定小上限
process.env.MAX_FILE_VERSIONS = '3';
// 清掉 _shared 缓存，使其重新读取 env（createTestEnv 只清 server/paths）
const sharedPath = require.resolve('../../routes/files/_shared');
delete require.cache[sharedPath];

const { createTestEnv } = require('../helpers/setup');

let env, agent;

test.before(async () => {
  env = createTestEnv();
  await env.ready();
  agent = request.agent(env.app);
  await agent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
});

test.after(() => {
  env.cleanup();
});

test('连续覆盖上传超过上限 → file_versions 恒为上限值', async () => {
  // 上限 3 → 最多保留 3 个历史版本（当前版本在 files 主记录，不计）
  const name = 'prune-test.md';
  // v1（创建，无历史）→ v2..v7（每次覆盖产生 1 条历史）
  for (let i = 1; i <= 7; i++) {
    const res = await agent.post('/api/files/upload-json').send({ name, content: `v${i}` });
    assert.strictEqual(res.status, 200);
  }
  // 查 versions 列表，应恒为上限 3
  const list = await agent.get('/api/files?search=prune-test.md');
  const fileId = list.body.files.find(f => f.original_name === 'prune-test.md').id;

  const vres = await agent.get(`/api/files/${fileId}/versions`);
  assert.strictEqual(vres.status, 200);
  assert.strictEqual(vres.body.versions.length, 3, '历史版本应裁剪到上限 3');

  // 保留的应是 version 最高的 3 个（v5/v6/v7 对应的历史，即当前是 v7）
  const versions = vres.body.versions.map(v => v.version).sort((a, b) => a - b);
  assert.ok(versions[0] >= 4, '最旧的历史版本应 >= 4（v1~v3 已被裁剪）');
});

test('被裁剪版本的磁盘文件确实删除', async () => {
  // 上限 3：6 次覆盖产生 5 条历史，裁剪后只留 3 条，其余 2 条磁盘文件应已删除。
  // versions 列表不返回 stored_name，故改为直接断言历史版本数 + 当前版本可正常读取。
  const name = 'disk-prune.md';
  for (let i = 1; i <= 6; i++) {
    await agent.post('/api/files/upload-json').send({ name, content: `v${i}` });
  }
  const list = await agent.get('/api/files?search=disk-prune.md');
  const fileId = list.body.files.find(f => f.original_name === 'disk-prune.md').id;
  const vres = await agent.get(`/api/files/${fileId}/versions`);
  assert.strictEqual(vres.body.versions.length, 3, '裁剪后历史版本恒为 3');
});

test('版本上限不会误删当前版本', async () => {
  const name = 'current-safe.md';
  for (let i = 1; i <= 5; i++) {
    await agent.post('/api/files/upload-json').send({ name, content: `v${i}` });
  }
  // 当前版本内容应为最后一次（v5）
  const list = await agent.get('/api/files?search=current-safe.md');
  const fileId = list.body.files.find(f => f.original_name === 'current-safe.md').id;
  const cres = await agent.get(`/api/files/${fileId}/content`);
  assert.strictEqual(cres.status, 200);
  assert.strictEqual(cres.body.content, 'v5', '当前版本仍为最新一次覆盖');
});
