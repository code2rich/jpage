// 认证集成测试：登录 / 登出 / me / 权限边界
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

test('未登录 GET /api/auth/me → 401', async () => {
  const res = await request(env.app).get('/api/auth/me');
  assert.strictEqual(res.status, 401);
});

test('登录错误密码 → 401', async () => {
  const res = await request(env.app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'wrongpassword' });
  assert.strictEqual(res.status, 401);
});

test('登录缺失字段 → 400', async () => {
  const res = await request(env.app)
    .post('/api/auth/login')
    .send({ username: 'admin' });
  assert.strictEqual(res.status, 400);
});

test('正确登录 → 200，返回用户信息', async () => {
  const res = await request(env.app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'testpassword123' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.username, 'admin');
  assert.strictEqual(res.body.role, 'admin');
  assert.ok(res.body.id);
  // Set-Cookie 带 jpage.sid
  assert.ok(res.headers['set-cookie']);
  assert.ok(res.headers['set-cookie'].some(c => c.startsWith('jpage.sid=')));
});

test('带 cookie 访问 /api/auth/me → 200', async () => {
  const agent = request.agent(env.app);
  await agent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
  const res = await agent.get('/api/auth/me');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.username, 'admin');
});

test('登出后再访问 /api/auth/me → 401', async () => {
  const agent = request.agent(env.app);
  await agent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
  await agent.post('/api/auth/logout');
  const res = await agent.get('/api/auth/me');
  assert.strictEqual(res.status, 401);
});

test('未登录访问受保护端点 /api/files → 401', async () => {
  const res = await request(env.app).get('/api/files');
  assert.strictEqual(res.status, 401);
});

test('未登录访问 /api/users → 401', async () => {
  const res = await request(env.app).get('/api/users');
  assert.strictEqual(res.status, 401);
});

test('非 admin 不能访问 /api/users', async () => {
  // 先用 admin 创建一个普通用户
  const adminAgent = request.agent(env.app);
  await adminAgent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
  await adminAgent.post('/api/users').send({ username: 'regular', password: 'regularpass123', role: 'user' });

  // 普通用户登录后访问 /api/users → 403
  const userAgent = request.agent(env.app);
  await userAgent.post('/api/auth/login').send({ username: 'regular', password: 'regularpass123' });
  const res = await userAgent.get('/api/users');
  assert.strictEqual(res.status, 403);
});

test('注册默认关闭（ALLOW_REGISTRATION 未设为 true）', async () => {
  const res = await request(env.app).get('/api/auth/registration-status');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.enabled, false);
});

test('微信登录未配置时状态为关闭', async () => {
  const oldAppId = process.env.WECHAT_OPEN_APP_ID;
  const oldSecret = process.env.WECHAT_OPEN_APP_SECRET;
  delete process.env.WECHAT_OPEN_APP_ID;
  delete process.env.WECHAT_OPEN_APP_SECRET;
  const res = await request(env.app).get('/api/auth/wechat/status');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.enabled, false);
  if (oldAppId !== undefined) process.env.WECHAT_OPEN_APP_ID = oldAppId;
  if (oldSecret !== undefined) process.env.WECHAT_OPEN_APP_SECRET = oldSecret;
});

test('微信扫码回调可首次创建用户并建立 session', async () => {
  const oldAppId = process.env.WECHAT_OPEN_APP_ID;
  const oldSecret = process.env.WECHAT_OPEN_APP_SECRET;
  const oldAppUrl = process.env.APP_URL;
  const oldFetch = global.fetch;
  process.env.WECHAT_OPEN_APP_ID = 'wx-test-appid';
  process.env.WECHAT_OPEN_APP_SECRET = 'wechat-secret';
  process.env.APP_URL = 'https://jpage.cn';
  global.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/sns/oauth2/access_token')) {
      assert.strictEqual(u.searchParams.get('appid'), 'wx-test-appid');
      assert.strictEqual(u.searchParams.get('code'), 'mock-code');
      return new Response(JSON.stringify({
        access_token: 'access-token',
        openid: 'openid-123',
        unionid: 'unionid-123',
        scope: 'snsapi_login'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname.endsWith('/sns/userinfo')) {
      assert.strictEqual(u.searchParams.get('openid'), 'openid-123');
      return new Response(JSON.stringify({
        openid: 'openid-123',
        unionid: 'unionid-123',
        nickname: '微信用户',
        headimgurl: 'https://example.com/avatar.png'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  try {
    const agent = request.agent(env.app);
    const start = await agent.get('/api/auth/wechat/start?returnTo=%2F');
    assert.strictEqual(start.status, 302);
    const loginUrl = new URL(start.headers.location);
    assert.strictEqual(loginUrl.hostname, 'open.weixin.qq.com');
    assert.strictEqual(loginUrl.searchParams.get('appid'), 'wx-test-appid');
    assert.strictEqual(loginUrl.searchParams.get('scope'), 'snsapi_login');
    assert.strictEqual(loginUrl.searchParams.get('redirect_uri'), 'https://jpage.cn/api/auth/wechat/callback');
    const state = loginUrl.searchParams.get('state');
    assert.ok(state);

    const callback = await agent.get(`/api/auth/wechat/callback?code=mock-code&state=${state}`);
    assert.strictEqual(callback.status, 302);
    assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/');

    const me = await agent.get('/api/auth/me');
    assert.strictEqual(me.status, 200);
    assert.match(me.body.username, /^wechat_/);
    assert.strictEqual(me.body.role, 'user');
  } finally {
    global.fetch = oldFetch;
    if (oldAppId === undefined) delete process.env.WECHAT_OPEN_APP_ID;
    else process.env.WECHAT_OPEN_APP_ID = oldAppId;
    if (oldSecret === undefined) delete process.env.WECHAT_OPEN_APP_SECRET;
    else process.env.WECHAT_OPEN_APP_SECRET = oldSecret;
    if (oldAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldAppUrl;
  }
});

test('已绑定的微信号不能被其他登录用户转绑', async () => {
  const oldAppId = process.env.WECHAT_OPEN_APP_ID;
  const oldSecret = process.env.WECHAT_OPEN_APP_SECRET;
  const oldAppUrl = process.env.APP_URL;
  const oldFetch = global.fetch;
  process.env.WECHAT_OPEN_APP_ID = 'wx-test-appid';
  process.env.WECHAT_OPEN_APP_SECRET = 'wechat-secret';
  process.env.APP_URL = 'https://jpage.cn';
  global.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/sns/oauth2/access_token')) {
      return new Response(JSON.stringify({
        access_token: 'access-token',
        openid: 'openid-123',
        unionid: 'unionid-123',
        scope: 'snsapi_login'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname.endsWith('/sns/userinfo')) {
      return new Response(JSON.stringify({
        openid: 'openid-123',
        unionid: 'unionid-123',
        nickname: '微信用户',
        headimgurl: 'https://example.com/avatar.png'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  try {
    const regularAgent = request.agent(env.app);
    await regularAgent.post('/api/auth/login').send({ username: 'regular', password: 'regularpass123' });
    const start = await regularAgent.get('/api/auth/wechat/start');
    const loginUrl = new URL(start.headers.location);
    const state = loginUrl.searchParams.get('state');
    const callback = await regularAgent.get(`/api/auth/wechat/callback?code=mock-code&state=${state}`);
    assert.strictEqual(callback.status, 302);
    assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/login');
    const stillRegular = await regularAgent.get('/api/auth/me');
    assert.strictEqual(stillRegular.status, 200);
    assert.strictEqual(stillRegular.body.username, 'regular');

    const wechatAgent = request.agent(env.app);
    const startAgain = await wechatAgent.get('/api/auth/wechat/start');
    const loginUrlAgain = new URL(startAgain.headers.location);
    const stateAgain = loginUrlAgain.searchParams.get('state');
    await wechatAgent.get(`/api/auth/wechat/callback?code=mock-code&state=${stateAgain}`);
    const me = await wechatAgent.get('/api/auth/me');
    assert.strictEqual(me.status, 200);
    assert.match(me.body.username, /^wechat_/);
  } finally {
    global.fetch = oldFetch;
    if (oldAppId === undefined) delete process.env.WECHAT_OPEN_APP_ID;
    else process.env.WECHAT_OPEN_APP_ID = oldAppId;
    if (oldSecret === undefined) delete process.env.WECHAT_OPEN_APP_SECRET;
    else process.env.WECHAT_OPEN_APP_SECRET = oldSecret;
    if (oldAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldAppUrl;
  }
});
