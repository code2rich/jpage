// ZIP 多版本覆盖集成测试：bundle / batch 同名覆盖、显式覆盖、历史版本生命周期。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const JSZip = require('jszip');
const { createTestEnv } = require('../helpers/setup');

process.env.MAX_FILE_VERSIONS = '3';

let env;
let agent;

async function makeZip(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function uploadZip(name, files) {
  const buf = await makeZip(files);
  return agent.post('/api/files/upload-zip-base64').send({
    name,
    content: buf.toString('base64'),
    isPublic: false,
  });
}

async function assertStorageAccounting() {
  const { dbGet } = require('../../lib/db');
  const [user, logical] = await Promise.all([
    dbGet('SELECT total_storage_bytes FROM users WHERE id = 1'),
    dbGet(`
      SELECT COALESCE((SELECT SUM(size) FROM files WHERE uploaded_by = 1), 0) +
             COALESCE((SELECT SUM(size) FROM file_versions WHERE uploaded_by = 1), 0) AS total
    `),
  ]);
  assert.strictEqual(user.total_storage_bytes, logical.total);
}

test.before(async () => {
  env = createTestEnv();
  await env.ready();
  agent = request.agent(env.app);
  await agent.post('/api/auth/login').send({
    username: 'admin',
    password: 'testpassword123',
  });
});

test.after(() => env.cleanup());

test('同名 bundle ZIP 覆盖保持 file ID/share key，并可渲染历史版本', async () => {
  const first = await uploadZip('versioned-site.zip', {
    'index.html': '<h1>bundle-v1</h1>',
    'assets/app.js': 'window.bundleVersion=1',
  });
  const second = await uploadZip('versioned-site.zip', {
    'index.html': '<h1>bundle-v2</h1>',
    'assets/app.js': 'window.bundleVersion=2',
  });

  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body.id, first.body.id);
  assert.strictEqual(second.body.share_key, first.body.share_key);
  assert.strictEqual(second.body.overwritten, true);
  assert.strictEqual(second.body.version, 2);

  const versions = await agent.get(`/api/files/${first.body.id}/versions`);
  assert.strictEqual(versions.status, 200);
  assert.strictEqual(versions.body.versions.length, 1);
  assert.strictEqual(versions.body.versions[0].is_bundle, 1);
  assert.strictEqual(versions.body.versions[0].entry_path, 'index.html');

  const oldRender = await agent.get(`/api/files/${first.body.id}/versions/1/render`);
  const currentRender = await agent.get(`/api/files/${first.body.id}/render`);
  assert.strictEqual(oldRender.status, 200);
  assert.match(oldRender.text, /bundle-v1/);
  assert.match(oldRender.text, new RegExp(`/api/files/${first.body.id}/versions/1/asset/`));
  const oldAsset = await agent.get(`/api/files/${first.body.id}/versions/1/asset/assets/app.js`);
  assert.strictEqual(oldAsset.status, 200);
  assert.match(oldAsset.text, /bundleVersion=1/);
  assert.strictEqual(currentRender.status, 200);
  assert.match(currentRender.text, /bundle-v2/);
  await assertStorageAccounting();
});

test('bundle 历史版本可恢复、下载和递归删除', async () => {
  const first = await uploadZip('restore-site.zip', {
    'index.html': '<h1>restore-v1</h1>',
    'nested/asset.txt': 'asset-v1',
  });
  await uploadZip('restore-site.zip', {
    'index.html': '<h1>restore-v2</h1>',
    'nested/asset.txt': 'asset-v2',
  });

  const download = await agent
    .get(`/api/files/${first.body.id}/versions/1/download`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  assert.strictEqual(download.status, 200);
  const archive = await JSZip.loadAsync(download.body);
  assert.strictEqual(await archive.file('nested/asset.txt').async('string'), 'asset-v1');

  const restore = await agent.post(`/api/files/${first.body.id}/versions/1/restore`);
  assert.strictEqual(restore.status, 200);
  const restoredRender = await agent.get(`/api/files/${first.body.id}/render`);
  assert.match(restoredRender.text, /restore-v1/);

  const { dbGet } = require('../../lib/db');
  const archived = await dbGet(
    'SELECT stored_name, is_bundle FROM file_versions WHERE file_id = ? AND version = 1',
    [first.body.id]
  );
  const archivedPath = path.join(env.dataDir, 'uploads', archived.stored_name);
  assert.strictEqual(archived.is_bundle, 1);
  assert.strictEqual(fs.existsSync(archivedPath), true);

  const deleted = await agent.delete(`/api/files/${first.body.id}/versions/1`);
  assert.strictEqual(deleted.status, 200);
  assert.strictEqual(fs.existsSync(archivedPath), false);
  await assertStorageAccounting();
});

test('batch ZIP 对包内同名文件逐项覆盖并生成各自历史版本', async () => {
  const first = await uploadZip('batch-versions.zip', {
    'alpha.html': '<h1>alpha-v1</h1>',
    'beta.md': '# beta-v1',
  });
  const second = await uploadZip('batch-versions.zip', {
    'alpha.html': '<h1>alpha-v2</h1>',
    'beta.md': '# beta-v2',
  });

  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body.type, 'batch');
  assert.deepStrictEqual(
    second.body.files.map(file => file.id),
    first.body.files.map(file => file.id)
  );
  assert.ok(second.body.files.every(file => file.overwritten === true && file.version === 2));

  for (const file of second.body.files) {
    const versions = await agent.get(`/api/files/${file.id}/versions`);
    assert.strictEqual(versions.body.versions.length, 1);
    const current = await agent.get(`/api/files/${file.id}/content`);
    assert.match(current.body.content, /v2/);
  }
  await assertStorageAccounting();
});

test('显式 bundle ZIP 覆盖支持 multipart/base64，且拒绝存储形态错配', async () => {
  const first = await uploadZip('explicit-site.zip', {
    'index.html': '<h1>explicit-v1</h1>',
    'assets/app.js': 'window.v=1',
  });
  const multipartZip = await makeZip({
    'index.html': '<h1>explicit-v2</h1>',
    'assets/app.js': 'window.v=2',
  });
  const multipart = await agent
    .post(`/api/files/${first.body.id}/overwrite`)
    .attach('file', multipartZip, 'explicit-site.zip');
  assert.strictEqual(multipart.status, 200);
  assert.strictEqual(multipart.body.id, first.body.id);
  assert.strictEqual(multipart.body.overwritten, true);
  assert.match((await agent.get(`/api/files/${first.body.id}/render`)).text, /explicit-v2/);

  const base64Zip = await makeZip({
    'index.html': '<h1>explicit-v3</h1>',
    'assets/app.js': 'window.v=3',
  });
  const base64 = await agent
    .post(`/api/files/${first.body.id}/overwrite-zip-base64`)
    .send({ name: 'explicit-site.zip', content: base64Zip.toString('base64') });
  assert.strictEqual(base64.status, 200);
  assert.strictEqual(base64.body.version, 3);
  assert.match((await agent.get(`/api/files/${first.body.id}/render`)).text, /explicit-v3/);

  const bundleWithText = await agent
    .post(`/api/files/${first.body.id}/overwrite`)
    .attach('file', Buffer.from('<h1>wrong</h1>'), 'wrong.html');
  assert.strictEqual(bundleWithText.status, 400);
  assert.match((await agent.get(`/api/files/${first.body.id}/render`)).text, /explicit-v3/);

  const text = await agent.post('/api/files/upload-json').send({
    name: 'plain.html',
    content: '<h1>plain</h1>',
  });
  const textWithZip = await agent
    .post(`/api/files/${text.body.id}/overwrite`)
    .attach('file', multipartZip, 'wrong.zip');
  assert.strictEqual(textWithZip.status, 400);
  assert.match((await agent.get(`/api/files/${text.body.id}/render`)).text, /plain/);
  await assertStorageAccounting();
});

test('显式覆盖拒绝 batch ZIP；batch 内重复 basename 也确定性拒绝', async () => {
  const bundle = await uploadZip('single-target.zip', {
    'index.html': '<h1>target</h1>',
    'assets/app.js': 'window.v=1',
  });
  const batch = await makeZip({
    'a.html': '<p>a</p>',
    'b.html': '<p>b</p>',
  });
  const explicitBatch = await agent
    .post(`/api/files/${bundle.body.id}/overwrite-zip-base64`)
    .send({ name: 'batch.zip', content: batch.toString('base64') });
  assert.strictEqual(explicitBatch.status, 400);

  const duplicateBasename = await uploadZip('duplicate-basename.zip', {
    'a/same.html': '<p>a</p>',
    'b/same.html': '<p>b</p>',
    'readme.md': '# force batch',
  });
  assert.strictEqual(duplicateBasename.status, 400);
  assert.match(duplicateBasename.body.error, /同名/);
  await assertStorageAccounting();
});

test('bundle 历史超过上限时裁剪最旧目录且不留孤儿', async () => {
  const first = await uploadZip('pruned-site.zip', {
    'index.html': '<h1>prune-v1</h1>',
    'assets/app.js': 'window.v=1',
  });
  await uploadZip('pruned-site.zip', {
    'index.html': '<h1>prune-v2</h1>',
    'assets/app.js': 'window.v=2',
  });

  const { dbGet } = require('../../lib/db');
  const oldest = await dbGet(
    'SELECT stored_name FROM file_versions WHERE file_id = ? AND version = 1',
    [first.body.id]
  );
  const oldestPath = path.join(env.dataDir, 'uploads', oldest.stored_name);
  assert.strictEqual(fs.existsSync(oldestPath), true);

  for (let version = 3; version <= 5; version++) {
    await uploadZip('pruned-site.zip', {
      'index.html': `<h1>prune-v${version}</h1>`,
      'assets/app.js': `window.v=${version}`,
    });
  }

  const versions = await agent.get(`/api/files/${first.body.id}/versions`);
  assert.strictEqual(versions.body.versions.length, 3);
  assert.deepStrictEqual(
    versions.body.versions.map(item => item.version).sort((a, b) => a - b),
    [2, 3, 4]
  );
  assert.strictEqual(fs.existsSync(oldestPath), false);
  await assertStorageAccounting();
});
