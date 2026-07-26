// 认证集成测试：登录 / 登出 / me / 权限边界
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { OAuth2Client } = require('google-auth-library');
const { createTestEnv } = require('../helpers/setup');
const logger = require('../../logger');

let env;

test.before(async () => {
  env = createTestEnv();
  await env.ready();
});

test.after(() => {
  env.cleanup();
});

async function withMockedGoogle(payloadFactory, run, options = {}) {
  const oldClientId = process.env.GOOGLE_CLIENT_ID;
  const oldClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const oldAppUrl = process.env.APP_URL;
  const oldTimeout = process.env.GOOGLE_HTTP_TIMEOUT_MS;
  const oldProxy = process.env.GOOGLE_HTTPS_PROXY;
  const oldGetToken = OAuth2Client.prototype.getToken;
  const oldVerifyIdToken = OAuth2Client.prototype.verifyIdToken;
  let expectedNonce = null;
  let transporterOptions = null;

  process.env.GOOGLE_CLIENT_ID = 'google-test-client.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'google-test-secret';
  process.env.APP_URL = 'https://jpage.cn';
  if (options.timeout !== undefined) process.env.GOOGLE_HTTP_TIMEOUT_MS = String(options.timeout);
  else delete process.env.GOOGLE_HTTP_TIMEOUT_MS;
  if (options.proxy !== undefined) process.env.GOOGLE_HTTPS_PROXY = String(options.proxy);
  else delete process.env.GOOGLE_HTTPS_PROXY;
  OAuth2Client.prototype.getToken = async function getToken(code) {
    assert.strictEqual(code, 'mock-code');
    transporterOptions = { ...this.transporter.defaults };
    if (options.tokenError) throw options.tokenError;
    return { tokens: { id_token: 'mock-google-id-token' } };
  };
  OAuth2Client.prototype.verifyIdToken = async ({ idToken, audience }) => {
    assert.strictEqual(idToken, 'mock-google-id-token');
    assert.strictEqual(audience, 'google-test-client.apps.googleusercontent.com');
    const payload = typeof payloadFactory === 'function'
      ? payloadFactory(expectedNonce)
      : { ...payloadFactory, nonce: expectedNonce };
    return { getPayload: () => payload };
  };

  try {
    await run({
      setExpectedNonce(value) {
        expectedNonce = value;
      },
      getTransporterOptions() {
        return transporterOptions;
      }
    });
  } finally {
    OAuth2Client.prototype.getToken = oldGetToken;
    OAuth2Client.prototype.verifyIdToken = oldVerifyIdToken;
    if (oldClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = oldClientId;
    if (oldClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = oldClientSecret;
    if (oldAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldAppUrl;
    if (oldTimeout === undefined) delete process.env.GOOGLE_HTTP_TIMEOUT_MS;
    else process.env.GOOGLE_HTTP_TIMEOUT_MS = oldTimeout;
    if (oldProxy === undefined) delete process.env.GOOGLE_HTTPS_PROXY;
    else process.env.GOOGLE_HTTPS_PROXY = oldProxy;
  }
}

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

test('用户名不存在时统一登录返回 404', async () => {
  const res = await request(env.app)
    .post('/api/auth/login')
    .send({ account: 'not_exists_user', password: 'anypassword' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, '用户名不存在');
});

test('邮箱未注册且 SMTP 未配置时统一登录返回 503', async () => {
  const res = await request(env.app)
    .post('/api/auth/login')
    .send({ account: 'notfound@example.com', password: 'anypassword' });
  assert.strictEqual(res.status, 503);
});

test('邮箱未注册时统一登录自动发送验证码并返回 register_code_sent', async () => {
  const oldSmtpHost = process.env.SMTP_HOST;
  process.env.SMTP_HOST = 'smtp.test.local';
  const nodemailer = require('nodemailer');
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async () => ({ messageId: 'test-message-id' })
  });
  const mailer = require('../../mailer');
  mailer.initMailer();

  try {
    const res = await request(env.app)
      .post('/api/auth/login')
      .send({ account: 'newuser@example.com', password: 'anypassword' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.action, 'register_code_sent');
    assert.strictEqual(res.body.email, 'newuser@example.com');
  } finally {
    nodemailer.createTransport = originalCreateTransport;
    mailer.initMailer();
    if (oldSmtpHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = oldSmtpHost;
  }
});

test('GitHub 登录未配置时状态为关闭', async () => {
  const oldClientId = process.env.GITHUB_CLIENT_ID;
  const oldClientSecret = process.env.GITHUB_CLIENT_SECRET;
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  const res = await request(env.app).get('/api/auth/github/status');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.enabled, false);
  if (oldClientId !== undefined) process.env.GITHUB_CLIENT_ID = oldClientId;
  if (oldClientSecret !== undefined) process.env.GITHUB_CLIENT_SECRET = oldClientSecret;
});

test('GitHub 回调可首次创建用户并建立 session', async () => {
  const oldClientId = process.env.GITHUB_CLIENT_ID;
  const oldClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const oldAppUrl = process.env.APP_URL;
  const oldFetch = global.fetch;
  process.env.GITHUB_CLIENT_ID = 'gh-test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'gh-test-client-secret';
  process.env.APP_URL = 'https://jpage.cn';
  global.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/login/oauth/access_token')) {
      return new Response(JSON.stringify({
        access_token: 'gh-access-token',
        token_type: 'bearer',
        scope: 'read:user user:email'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname.endsWith('/user') && u.hostname === 'api.github.com') {
      return new Response(JSON.stringify({
        id: 123456,
        login: 'octocat',
        email: null,
        avatar_url: 'https://github.com/avatar.png',
        name: 'Monalisa Octocat'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname.endsWith('/user/emails') && u.hostname === 'api.github.com') {
      return new Response(JSON.stringify([
        { email: 'octocat@example.com', primary: true, verified: true }
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  try {
    const agent = request.agent(env.app);
    const start = await agent.get('/api/auth/github/start?returnTo=%2F');
    assert.strictEqual(start.status, 302);
    const loginUrl = new URL(start.headers.location);
    assert.strictEqual(loginUrl.hostname, 'github.com');
    assert.strictEqual(loginUrl.pathname, '/login/oauth/authorize');
    assert.strictEqual(loginUrl.searchParams.get('client_id'), 'gh-test-client-id');
    assert.strictEqual(loginUrl.searchParams.get('scope'), 'read:user user:email');
    const state = loginUrl.searchParams.get('state');
    assert.ok(state);

    const callback = await agent.get(`/api/auth/github/callback?code=mock-code&state=${state}`);
    assert.strictEqual(callback.status, 302);
    assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/');

    const me = await agent.get('/api/auth/me');
    assert.strictEqual(me.status, 200);
    assert.match(me.body.username, /^octocat/);
    assert.strictEqual(me.body.role, 'user');
  } finally {
    global.fetch = oldFetch;
    if (oldClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = oldClientId;
    if (oldClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = oldClientSecret;
    if (oldAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldAppUrl;
  }
});

test('已绑定的 GitHub 账号不能被其他登录用户转绑', async () => {
  const oldClientId = process.env.GITHUB_CLIENT_ID;
  const oldClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const oldAppUrl = process.env.APP_URL;
  const oldFetch = global.fetch;
  process.env.GITHUB_CLIENT_ID = 'gh-test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'gh-test-client-secret';
  process.env.APP_URL = 'https://jpage.cn';
  global.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gh-access-token', token_type: 'bearer' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname.endsWith('/user') && u.hostname === 'api.github.com') {
      return new Response(JSON.stringify({ id: 123456, login: 'octocat', email: 'octocat@example.com', avatar_url: '', name: '' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname.endsWith('/user/emails') && u.hostname === 'api.github.com') {
      return new Response(JSON.stringify([{ email: 'octocat@example.com', primary: true, verified: true }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  try {
    const regularAgent = request.agent(env.app);
    await regularAgent.post('/api/auth/login').send({ username: 'regular', password: 'regularpass123' });
    const start = await regularAgent.get('/api/auth/github/start');
    const loginUrl = new URL(start.headers.location);
    const state = loginUrl.searchParams.get('state');
    const callback = await regularAgent.get(`/api/auth/github/callback?code=mock-code&state=${state}`);
    assert.strictEqual(callback.status, 302);
    assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/login');
    const stillRegular = await regularAgent.get('/api/auth/me');
    assert.strictEqual(stillRegular.status, 200);
    assert.strictEqual(stillRegular.body.username, 'regular');

    const githubAgent = request.agent(env.app);
    const startAgain = await githubAgent.get('/api/auth/github/start');
    const loginUrlAgain = new URL(startAgain.headers.location);
    const stateAgain = loginUrlAgain.searchParams.get('state');
    await githubAgent.get(`/api/auth/github/callback?code=mock-code&state=${stateAgain}`);
    const me = await githubAgent.get('/api/auth/me');
    assert.strictEqual(me.status, 200);
    assert.match(me.body.username, /^octocat/);
  } finally {
    global.fetch = oldFetch;
    if (oldClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = oldClientId;
    if (oldClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = oldClientSecret;
    if (oldAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldAppUrl;
  }
});

test('GitHub 邮箱已存在且已验证时自动绑定到现有用户', async () => {
  const oldClientId = process.env.GITHUB_CLIENT_ID;
  const oldClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const oldAppUrl = process.env.APP_URL;
  const oldFetch = global.fetch;
  process.env.GITHUB_CLIENT_ID = 'gh-test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'gh-test-client-secret';
  process.env.APP_URL = 'https://jpage.cn';
  global.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gh-access-token', token_type: 'bearer' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname.endsWith('/user') && u.hostname === 'api.github.com') {
      return new Response(JSON.stringify({ id: 999999, login: 'octocat', email: null, avatar_url: '', name: '' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname.endsWith('/user/emails') && u.hostname === 'api.github.com') {
      return new Response(JSON.stringify([{ email: 'existing@example.com', primary: true, verified: true }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  try {
    const adminAgent = request.agent(env.app);
    await adminAgent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
    await adminAgent.post('/api/users').send({ username: 'existinguser', password: 'existingpass123', role: 'user', email: 'existing@example.com' });

    const githubAgent = request.agent(env.app);
    const start = await githubAgent.get('/api/auth/github/start');
    const loginUrl = new URL(start.headers.location);
    const state = loginUrl.searchParams.get('state');
    const callback = await githubAgent.get(`/api/auth/github/callback?code=mock-code&state=${state}`);
    assert.strictEqual(callback.status, 302);
    assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/');

    const me = await githubAgent.get('/api/auth/me');
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.username, 'existinguser');
    assert.strictEqual(me.body.email, 'existing@example.com');
  } finally {
    global.fetch = oldFetch;
    if (oldClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = oldClientId;
    if (oldClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = oldClientSecret;
    if (oldAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldAppUrl;
  }
});

test('Google 登录未配置时状态为关闭', async () => {
  const oldClientId = process.env.GOOGLE_CLIENT_ID;
  const oldClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    const res = await request(env.app).get('/api/auth/google/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.enabled, false);
    assert.strictEqual(res.body.callbackPath, '/api/auth/google/callback');
  } finally {
    if (oldClientId !== undefined) process.env.GOOGLE_CLIENT_ID = oldClientId;
    if (oldClientSecret !== undefined) process.env.GOOGLE_CLIENT_SECRET = oldClientSecret;
  }
});

test('Google OAuth 使用专用请求超时和 HTTPS 代理配置', async () => {
  await withMockedGoogle({
    iss: 'https://accounts.google.com',
    aud: 'google-test-client.apps.googleusercontent.com',
    sub: 'google-transport-options',
    email: 'google.transport@example.com',
    email_verified: true,
    name: 'Google Transport User'
  }, async ({ setExpectedNonce, getTransporterOptions }) => {
    const agent = request.agent(env.app);
    const start = await agent.get('/api/auth/google/start');
    assert.strictEqual(start.status, 302);
    const loginUrl = new URL(start.headers.location);
    setExpectedNonce(loginUrl.searchParams.get('nonce'));

    const callback = await agent.get(`/api/auth/google/callback?code=mock-code&state=${loginUrl.searchParams.get('state')}`);
    assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/');
    assert.deepStrictEqual(getTransporterOptions(), {
      timeout: 2500,
      proxy: 'https://proxy.example.com:8443/'
    });
  }, {
    timeout: 2500,
    proxy: 'https://proxy.example.com:8443'
  });
});

test('Google OAuth 拒绝不支持的代理协议且不发起授权', async () => {
  await withMockedGoogle({}, async () => {
    const res = await request(env.app).get('/api/auth/google/start');
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.error, 'Google 登录网络配置无效');
  }, {
    proxy: 'socks5://proxy.example.com:1080'
  });
});

test('Google OAuth 将底层 AbortError 安全分类为上游超时', async () => {
  const oldAudit = logger.audit;
  let failureReason = null;
  logger.audit = function audit(action, details) {
    if (action === 'google.login' && details.success === false) failureReason = details.reason;
  };
  try {
    await withMockedGoogle({}, async () => {
      const agent = request.agent(env.app);
      const start = await agent.get('/api/auth/google/start');
      const loginUrl = new URL(start.headers.location);
      const callback = await agent.get(`/api/auth/google/callback?code=mock-code&state=${loginUrl.searchParams.get('state')}`);
      assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/login?oauth=google_failed');
      assert.strictEqual(failureReason, 'google_upstream_timeout');
    }, {
      tokenError: Object.assign(new Error('The operation was aborted.'), {
        cause: { name: 'AbortError' }
      })
    });
  } finally {
    logger.audit = oldAudit;
  }
});

test('Google OIDC 首次登录创建用户、绑定账号并建立 session', async () => {
  await withMockedGoogle({
    iss: 'https://accounts.google.com',
    aud: 'google-test-client.apps.googleusercontent.com',
    sub: 'google-user-1001',
    email: 'google.new@example.com',
    email_verified: true,
    name: 'Google New User',
    picture: 'https://example.com/avatar.png'
  }, async ({ setExpectedNonce }) => {
    const agent = request.agent(env.app);
    const start = await agent.get('/api/auth/google/start?returnTo=%2F');
    assert.strictEqual(start.status, 302);
    const loginUrl = new URL(start.headers.location);
    assert.strictEqual(loginUrl.hostname, 'accounts.google.com');
    assert.strictEqual(loginUrl.searchParams.get('client_id'), 'google-test-client.apps.googleusercontent.com');
    assert.strictEqual(loginUrl.searchParams.get('redirect_uri'), 'https://jpage.cn/api/auth/google/callback');
    assert.deepStrictEqual(
      new Set(loginUrl.searchParams.get('scope').split(' ')),
      new Set(['openid', 'email', 'profile'])
    );
    const state = loginUrl.searchParams.get('state');
    const nonce = loginUrl.searchParams.get('nonce');
    assert.ok(state);
    assert.ok(nonce);
    setExpectedNonce(nonce);

    const callback = await agent.get(`/api/auth/google/callback?code=mock-code&state=${state}`);
    assert.strictEqual(callback.status, 302);
    assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/');

    const me = await agent.get('/api/auth/me');
    assert.strictEqual(me.status, 200);
    assert.match(me.body.username, /^googlenew/);
    assert.strictEqual(me.body.email, 'google.new@example.com');
    assert.strictEqual(me.body.emailVerified, true);
    assert.strictEqual(me.body.role, 'user');
  });
});

test('已绑定的 Google 账号可以再次登录同一用户', async () => {
  await withMockedGoogle({
    iss: 'https://accounts.google.com',
    aud: 'google-test-client.apps.googleusercontent.com',
    sub: 'google-user-1001',
    email: 'google.new@example.com',
    email_verified: true,
    name: 'Google User Renamed',
    picture: ''
  }, async ({ setExpectedNonce }) => {
    const agent = request.agent(env.app);
    const start = await agent.get('/api/auth/google/start');
    const loginUrl = new URL(start.headers.location);
    setExpectedNonce(loginUrl.searchParams.get('nonce'));
    await agent.get(`/api/auth/google/callback?code=mock-code&state=${loginUrl.searchParams.get('state')}`);
    const me = await agent.get('/api/auth/me');
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.email, 'google.new@example.com');
  });
});

test('Google 已验证邮箱可绑定到已验证的现有用户', async () => {
  await withMockedGoogle({
    iss: 'https://accounts.google.com',
    aud: 'google-test-client.apps.googleusercontent.com',
    sub: 'google-user-existing-email',
    email: 'google.existing@example.com',
    email_verified: true,
    name: 'Existing Google User',
    picture: ''
  }, async ({ setExpectedNonce }) => {
    const adminAgent = request.agent(env.app);
    await adminAgent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
    const created = await adminAgent.post('/api/users').send({
      username: 'googleexisting',
      password: 'existingpass123',
      role: 'user',
      email: 'google.existing@example.com'
    });
    assert.strictEqual(created.status, 200);

    const googleAgent = request.agent(env.app);
    const start = await googleAgent.get('/api/auth/google/start');
    const loginUrl = new URL(start.headers.location);
    setExpectedNonce(loginUrl.searchParams.get('nonce'));
    const callback = await googleAgent.get(`/api/auth/google/callback?code=mock-code&state=${loginUrl.searchParams.get('state')}`);
    assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/');
    const me = await googleAgent.get('/api/auth/me');
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.username, 'googleexisting');
  });
});

test('已绑定 Google 账号不能被其他登录用户转绑', async () => {
  await withMockedGoogle({
    iss: 'https://accounts.google.com',
    aud: 'google-test-client.apps.googleusercontent.com',
    sub: 'google-user-1001',
    email: 'google.new@example.com',
    email_verified: true,
    name: 'Google New User',
    picture: ''
  }, async ({ setExpectedNonce }) => {
    const regularAgent = request.agent(env.app);
    await regularAgent.post('/api/auth/login').send({ username: 'regular', password: 'regularpass123' });
    const start = await regularAgent.get('/api/auth/google/start');
    const loginUrl = new URL(start.headers.location);
    setExpectedNonce(loginUrl.searchParams.get('nonce'));
    const callback = await regularAgent.get(`/api/auth/google/callback?code=mock-code&state=${loginUrl.searchParams.get('state')}`);
    assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/login?oauth=google_failed');
    const me = await regularAgent.get('/api/auth/me');
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.username, 'regular');
  });
});

test('Google nonce 校验失败时拒绝登录', async () => {
  await withMockedGoogle((expectedNonce) => ({
    iss: 'https://accounts.google.com',
    aud: 'google-test-client.apps.googleusercontent.com',
    sub: 'google-invalid-nonce',
    email: 'nonce@example.com',
    email_verified: true,
    nonce: `${expectedNonce}-tampered`
  }), async ({ setExpectedNonce }) => {
    const agent = request.agent(env.app);
    const start = await agent.get('/api/auth/google/start');
    const loginUrl = new URL(start.headers.location);
    setExpectedNonce(loginUrl.searchParams.get('nonce'));
    const callback = await agent.get(`/api/auth/google/callback?code=mock-code&state=${loginUrl.searchParams.get('state')}`);
    assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/login?oauth=google_failed');
    const me = await agent.get('/api/auth/me');
    assert.strictEqual(me.status, 401);
  });
});

test('Google state 不匹配时拒绝登录且不交换 token', async () => {
  await withMockedGoogle({
    iss: 'https://accounts.google.com',
    aud: 'google-test-client.apps.googleusercontent.com',
    sub: 'google-invalid-state',
    email: 'state@example.com',
    email_verified: true
  }, async () => {
    const agent = request.agent(env.app);
    await agent.get('/api/auth/google/start');
    const callback = await agent.get('/api/auth/google/callback?code=mock-code&state=tampered');
    assert.strictEqual(callback.headers.location, 'https://jpage.cn/#/login?oauth=google_failed');
    const me = await agent.get('/api/auth/me');
    assert.strictEqual(me.status, 401);
  });
});
