// lib 薄弱分支集成测试：dispatch 进程内分发器 + view-counts 访问去重。
// dispatch 用 createDispatcher 对真实 app 发请求，验证 200/4xx/404 与 err.status。
// view-counts 通过 /s/:key 验证 5 分钟内同 IP 去重 + buffer 累积。

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');

let env;
let admin;

test.before(async () => {
  env = createTestEnv();
  await env.ready();
  admin = request.agent(env.app);
  await admin.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
});

test.after(() => {
  env.cleanup();
});

// ====================== lib/dispatch.js：createDispatcher 进程内分发 ======================

test('dispatch：未登录访问受保护端点 → reject 带 err.status=401', async () => {
  const { createDispatcher } = require('../../lib/dispatch');
  const dispatch = createDispatcher(env.app, {});
  await assert.rejects(
    () => dispatch.get('/api/files'),
    (err) => err.status === 401 && /REST GET \/api\/files/.test(err.message),
  );
});

test('dispatch：不存在的路由 → reject 带 err.status=404', async () => {
  const { createDispatcher } = require('../../lib/dispatch');
  const express = require('express');
  // 用极简 app（无 SPA '*' 兜底）专门测 dispatcher 的 404 分支
  const bareApp = express();
  bareApp.get('/api/exists', (req, res) => res.json({ ok: true }));
  const dispatch = createDispatcher(bareApp, {});
  await assert.rejects(
    () => dispatch.get('/api/no-such-route-xyz'),
    (err) => err.status === 404,
  );
});

test('dispatch：带 token 访问 → resolve JSON（200）', async () => {
  const { createDispatcher } = require('../../lib/dispatch');
  // 创建一个用户 token
  const tokenRes = await admin.post('/api/tokens').send({ name: 'dispatch-test' });
  const token = tokenRes.body.token;
  const dispatch = createDispatcher(env.app, { token });
  const data = await dispatch.get('/api/files');
  assert.ok(Array.isArray(data.files));
});

test('dispatch：POST 带 body 透传', async () => {
  const { createDispatcher } = require('../../lib/dispatch');
  const tokenRes = await admin.post('/api/tokens').send({ name: 'dispatch-post' });
  const dispatch = createDispatcher(env.app, { token: tokenRes.body.token });
  // 创建一个分类（POST + body）
  const data = await dispatch.post('/api/categories', { name: 'via-dispatch' });
  assert.ok(data.success !== undefined || data.id !== undefined || data.name !== undefined);
});

// ====================== lib/view-counts.js：访问去重 + buffer ======================

test('view-counts：同 IP 5 分钟内重复访问 /s/:key → 去重，pending 只增一次', async () => {
  const { getPendingViewCount, flushViewCounts } = require('../../lib/view-counts');
  const up = await admin.post('/api/files/upload-json').send({
    name: 'vc-dedup.md', content: '# x', isPublic: true,
  });
  const shareKey = up.body.share_key;
  const fileId = up.body.id;

  // 第一次访问：插入 link_visits + buffer +1
  await request(env.app).get(`/s/${shareKey}`);
  const pending1 = getPendingViewCount(fileId);
  assert.ok(pending1 >= 1, `首次访问后 pending 应 >=1，实际 ${pending1}`);

  // 第二次访问（同 IP，5 分钟内）：recordVisit 命中去重直接 return，不再 buffer
  await request(env.app).get(`/s/${shareKey}`);
  const pending2 = getPendingViewCount(fileId);
  assert.strictEqual(pending2, pending1, '同 IP 5 分钟内重复访问应被去重，pending 不再增加');

  // flush 后 pending 归零，view_count 落库
  await flushViewCounts();
  assert.strictEqual(getPendingViewCount(fileId), 0);
  const detail = await admin.get(`/api/files/${fileId}`);
  assert.ok(detail.body.view_count >= 1, `flush 后 view_count 应 >=1，实际 ${detail.body.view_count}`);
});

test('view-counts：flush 空缓冲区 → 无副作用', async () => {
  const { flushViewCounts } = require('../../lib/view-counts');
  // 不触发任何访问，直接 flush
  await flushViewCounts();
  assert.ok(true, '空 flush 不应抛错');
});

test('view-counts：bufferViewCount 直接累加 + getPendingViewCount 读取', () => {
  const { bufferViewCount, getPendingViewCount, flushViewCounts } = require('../../lib/view-counts');
  const testId = 99999999;
  bufferViewCount(testId);
  bufferViewCount(testId);
  assert.strictEqual(getPendingViewCount(testId), 2);
  // 清理：手动 flush 会尝试 UPDATE 一个不存在的 id（无副作用，catch 吞错）
  return flushViewCounts();
});
