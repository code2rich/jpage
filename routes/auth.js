// 认证路由：me / login / register / logout / change-password / profile /
// verify-email / resend-verification / send-register-code / smtp-status / registration-status。
// 从 server.js 提取，行为保持不变。挂载点：/api/auth

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { dbGet, dbRun } = require('../lib/db');
const { requireAuth } = require('../lib/middleware/auth');
const { clientIp } = require('../lib/util');
const { sendMail, getAppUrl, isMailerConfigured } = require('../mailer');
const logger = require('../logger');

const router = express.Router();

const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION === 'true';
const WECHAT_PROVIDER = 'wechat';
const GITHUB_PROVIDER = 'github';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '登录尝试过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  // 测试环境密集登录会触发限流，跳过以保证集成测试稳定（生产不受影响）
  skip: () => process.env.NODE_ENV === 'test'
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: '注册请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false
});

const sendCodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1,
  message: { error: '发送过于频繁，请 1 分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false
});

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' }
});

// --- 邮箱验证 ---

function generateVerifyToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(32);
  let token = 'jv_';
  for (let i = 0; i < 32; i++) token += chars[bytes[i] % chars.length];
  return token;
}

async function sendVerificationEmail(userId, email, type, newEmail) {
  const token = generateVerifyToken();
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const prefix = token.slice(0, 8);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await dbRun("DELETE FROM email_verifications WHERE user_id = ? AND type = ?", [userId, type]);
  await dbRun(
    'INSERT INTO email_verifications (user_id, token_hash, token_prefix, type, new_email, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, hash, prefix, type, newEmail || null, expiresAt]
  );

  if (!isMailerConfigured()) return { sent: false };

  const targetEmail = newEmail || email;
  const appUrl = getAppUrl();
  const link = `${appUrl}/api/auth/verify-email?token=${token}`;
  try {
    await sendMail(targetEmail, '验证你的邮箱 — 即页',
      `<div style="max-width:480px;margin:0 auto;font-family:system-ui,sans-serif;padding:24px">
        <h2 style="color:#1a1a1a">验证你的邮箱</h2>
        <p style="color:#555;font-size:15px">请点击以下按钮验证你的邮箱地址：</p>
        <p style="margin:24px 0"><a href="${link}" style="display:inline-block;padding:12px 28px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-size:15px">验证邮箱</a></p>
        <p style="color:#888;font-size:13px">或复制链接到浏览器：<br><a href="${link}" style="word-break:break-all">${link}</a></p>
        <p style="color:#888;font-size:13px">链接 24 小时内有效。</p>
      </div>`
    );
    return { sent: true };
  } catch (e) {
    logger.error({ type: 'app', message: '发送验证邮件失败', error: e.message, userId });
    return { sent: false, error: e.message };
  }
}

// 从邮箱前缀生成唯一用户名
async function generateUsernameFromEmail(email) {
  let base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
  if (!base) base = 'user';
  let username = base;
  let suffix = 1;
  while (await dbGet('SELECT id FROM users WHERE username = ?', [username])) {
    username = base + suffix;
    suffix++;
    if (username.length > 30) username = base.slice(0, 24) + suffix;
  }
  return username;
}

async function sendRegisterCode(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return { ok: false, status: 400, error: '邮箱格式不正确' };

  const conflict = await dbGet('SELECT id FROM users WHERE email = ? OR username = ?', [email, email]);
  if (conflict) return { ok: false, status: 409, error: '该邮箱已被使用' };

  if (!isMailerConfigured()) return { ok: false, status: 503, error: '邮件服务未配置，无法注册' };

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const hash = crypto.createHash('sha256').update(code + email).digest('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await dbRun("DELETE FROM email_verifications WHERE type = 'register_code' AND new_email = ?", [email]);
  await dbRun(
    'INSERT INTO email_verifications (user_id, token_hash, token_prefix, type, new_email, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [0, hash, code.slice(0, 3) + '***', 'register_code', email, expiresAt]
  );

  try {
    await sendMail(email, '注册验证码 — 即页',
      `<div style="max-width:480px;margin:0 auto;padding:32px 24px;font-family:system-ui,-apple-system,sans-serif;color:#333">
        <h2 style="margin:0 0 24px;font-size:20px;color:#111">注册验证码</h2>
        <p style="margin:0 0 16px;font-size:15px">你的注册验证码是：</p>
        <p style="margin:0 0 24px;font-size:32px;font-weight:700;letter-spacing:6px;color:#4f46e5">${code}</p>
        <p style="margin:0;font-size:13px;color:#888">验证码 10 分钟内有效。如非本人操作请忽略。</p>
      </div>`
    );
    return { ok: true };
  } catch (e) {
    logger.error({ type: 'app', message: '发送注册验证码失败', error: e.message });
    return { ok: false, status: 500, error: '验证码发送失败，请稍后重试' };
  }
}

function isWechatLoginEnabled() {
  return !!(process.env.WECHAT_OPEN_APP_ID && process.env.WECHAT_OPEN_APP_SECRET);
}

function normalizeReturnTo(value) {
  const raw = String(value || '/').trim();
  if (!raw || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return '/';
  if (raw.startsWith('#/')) return raw.slice(1);
  if (raw.startsWith('/')) return raw;
  return '/';
}

function appBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${process.env.PORT || 8858}`;
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function redirectForReturnTo(req, returnTo) {
  const path = normalizeReturnTo(returnTo);
  return `${appBaseUrl(req)}/#${path}`;
}

function sanitizeWechatUsername(raw) {
  return String(raw || '')
    .normalize('NFKD')
    .replace(/[^\w]/g, '')
    .slice(0, 24);
}

async function generateUsernameFromWechat(profile) {
  const idTail = String(profile.unionid || profile.openid || crypto.randomBytes(4).toString('hex')).slice(-8);
  let base = sanitizeWechatUsername(profile.nickname);
  if (base.length < 2) base = `wechat_${idTail}`;
  base = base.slice(0, 24);
  let username = base;
  let suffix = 1;
  while (await dbGet('SELECT id FROM users WHERE username = ?', [username])) {
    username = `${base}_${suffix}`;
    if (username.length > 30) username = `${base.slice(0, 20)}_${suffix}`;
    suffix++;
  }
  return username;
}

async function fetchWechatJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('微信接口返回无效 JSON', { cause: e });
  }
  if (!response.ok) throw new Error(`微信接口请求失败：HTTP ${response.status}`);
  if (data.errcode) throw new Error(data.errmsg || `微信接口错误：${data.errcode}`);
  return data;
}

async function fetchWechatProfile(code, redirectUri) {
  const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
  tokenUrl.searchParams.set('appid', process.env.WECHAT_OPEN_APP_ID);
  tokenUrl.searchParams.set('secret', process.env.WECHAT_OPEN_APP_SECRET);
  tokenUrl.searchParams.set('code', code);
  tokenUrl.searchParams.set('grant_type', 'authorization_code');
  const token = await fetchWechatJson(tokenUrl.toString());
  if (!token.access_token || !token.openid) throw new Error('微信授权结果缺少 access_token 或 openid');

  const userUrl = new URL('https://api.weixin.qq.com/sns/userinfo');
  userUrl.searchParams.set('access_token', token.access_token);
  userUrl.searchParams.set('openid', token.openid);
  userUrl.searchParams.set('lang', 'zh_CN');
  const profile = await fetchWechatJson(userUrl.toString());
  return {
    openid: profile.openid || token.openid,
    unionid: profile.unionid || token.unionid || null,
    nickname: profile.nickname || '',
    avatarUrl: profile.headimgurl || '',
    raw: { token: { scope: token.scope, unionid: token.unionid || null }, profile, redirectUri }
  };
}

function loginAsUser(req, user) {
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.userRole = user.role;
}

async function findWechatAccount(profile) {
  const byOpenid = await dbGet(
    'SELECT oa.*, u.username, u.role FROM oauth_accounts oa JOIN users u ON u.id = oa.user_id WHERE oa.provider = ? AND oa.provider_user_id = ?',
    [WECHAT_PROVIDER, profile.openid]
  );
  if (byOpenid) return byOpenid;
  if (!profile.unionid) return null;
  return dbGet(
    'SELECT oa.*, u.username, u.role FROM oauth_accounts oa JOIN users u ON u.id = oa.user_id WHERE oa.provider = ? AND oa.unionid = ?',
    [WECHAT_PROVIDER, profile.unionid]
  );
}

async function upsertWechatAccount(userId, profile) {
  await dbRun(
    `INSERT INTO oauth_accounts
       (user_id, provider, provider_user_id, unionid, nickname, avatar_url, raw_profile_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider, provider_user_id) DO UPDATE SET
       user_id = excluded.user_id,
       unionid = excluded.unionid,
       nickname = excluded.nickname,
       avatar_url = excluded.avatar_url,
       raw_profile_json = excluded.raw_profile_json,
       updated_at = datetime('now')`,
    [
      userId,
      WECHAT_PROVIDER,
      profile.openid,
      profile.unionid || null,
      profile.nickname || null,
      profile.avatarUrl || null,
      JSON.stringify(profile.raw || {})
    ]
  );
}

async function createUserFromWechat(profile) {
  const username = await generateUsernameFromWechat(profile);
  const disabledPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const result = await dbRun(
    'INSERT INTO users (username, email, email_verified, password_hash, role) VALUES (?, NULL, 0, ?, ?)',
    [username, disabledPasswordHash, 'user']
  );
  return { id: result.lastID, username, role: 'user' };
}

// --- GitHub OAuth 辅助函数 ---

function isGithubLoginEnabled() {
  return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

function sanitizeGithubUsername(raw) {
  return String(raw || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 24);
}

async function generateUsernameFromGithub(profile) {
  const idTail = String(profile.providerUserId || crypto.randomBytes(4).toString('hex')).slice(-8);
  let base = sanitizeGithubUsername(profile.username || profile.login);
  if (base.length < 2) base = `github_${idTail}`;
  base = base.slice(0, 24);
  let username = base;
  let suffix = 1;
  while (await dbGet('SELECT id FROM users WHERE username = ?', [username])) {
    username = `${base}_${suffix}`;
    if (username.length > 30) username = `${base.slice(0, 20)}_${suffix}`;
    suffix++;
  }
  return username;
}

async function fetchGithubJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('GitHub 接口返回无效 JSON', { cause: e });
  }
  if (!response.ok) throw new Error(`GitHub 接口请求失败：HTTP ${response.status}`);
  if (data.error) throw new Error(data.error_description || data.error);
  return data;
}

async function fetchGithubToken(code, redirectUri) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri
    })
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('GitHub token 接口返回无效 JSON', { cause: e });
  }
  if (!response.ok) throw new Error(`GitHub token 接口请求失败：HTTP ${response.status}`);
  if (data.error) throw new Error(data.error_description || data.error);
  if (!data.access_token) throw new Error('GitHub 授权结果缺少 access_token');
  return data;
}

async function fetchGithubUser(token) {
  return fetchGithubJson('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jpage'
    }
  });
}

async function fetchGithubPrimaryEmail(token) {
  const emails = await fetchGithubJson('https://api.github.com/user/emails', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jpage'
    }
  });
  if (!Array.isArray(emails) || emails.length === 0) return null;
  const primary = emails.find(e => e.primary && e.verified);
  if (primary) return primary.email;
  const verified = emails.find(e => e.verified);
  if (verified) return verified.email;
  return emails[0].email;
}

async function fetchGithubProfile(code, redirectUri) {
  const tokenData = await fetchGithubToken(code, redirectUri);
  const user = await fetchGithubUser(tokenData.access_token);
  let email = user.email || null;
  if (!email) {
    try {
      email = await fetchGithubPrimaryEmail(tokenData.access_token);
    } catch (e) {
      logger.warn({ type: 'app', message: '获取 GitHub 邮箱失败', error: e.message });
    }
  }
  return {
    providerUserId: String(user.id),
    login: user.login || '',
    username: user.login || '',
    email: email || null,
    emailVerified: !!email,
    avatarUrl: user.avatar_url || '',
    name: user.name || '',
    raw: { token: { scope: tokenData.scope }, user, redirectUri }
  };
}

async function findGithubAccount(profile) {
  return dbGet(
    'SELECT oa.*, u.username, u.role FROM oauth_accounts oa JOIN users u ON u.id = oa.user_id WHERE oa.provider = ? AND oa.provider_user_id = ?',
    [GITHUB_PROVIDER, profile.providerUserId]
  );
}

async function upsertGithubAccount(userId, profile) {
  await dbRun(
    `INSERT INTO oauth_accounts
       (user_id, provider, provider_user_id, unionid, nickname, avatar_url, raw_profile_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider, provider_user_id) DO UPDATE SET
       user_id = excluded.user_id,
       unionid = excluded.unionid,
       nickname = excluded.nickname,
       avatar_url = excluded.avatar_url,
       raw_profile_json = excluded.raw_profile_json,
       updated_at = datetime('now')`,
    [
      userId,
      GITHUB_PROVIDER,
      profile.providerUserId,
      null,
      profile.name || profile.username || null,
      profile.avatarUrl || null,
      JSON.stringify(profile.raw || {})
    ]
  );
}

async function createUserFromGithub(profile) {
  const username = await generateUsernameFromGithub(profile);
  const disabledPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const result = await dbRun(
    'INSERT INTO users (username, email, email_verified, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [username, profile.email || null, profile.emailVerified ? 1 : 0, disabledPasswordHash, 'user']
  );
  return { id: result.lastID, username, role: 'user' };
}

// --- 路由 ---

router.get('/me', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: '未登录' });
  try {
    const user = await dbGet('SELECT id, username, email, email_verified, role FROM users WHERE id = ?', [req.session.userId]);
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: '未登录' });
    }
    res.json({ id: user.id, username: user.username, email: user.email || null, emailVerified: !!user.email_verified, role: user.role });
  } catch (e) {
    res.status(500).json({ error: '查询失败' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, account, password } = req.body || {};
  const input = account || username;
  if (!input || !password) return res.status(400).json({ error: '用户名/邮箱和密码不能为空' });
  try {
    // 统一入口：自动识别用户名或邮箱
    const isEmail = input.includes('@');
    const user = isEmail
      ? await dbGet('SELECT * FROM users WHERE email = ?', [input])
      : await dbGet('SELECT * FROM users WHERE username = ?', [input]);
    if (!user) {
      if (isEmail) {
        // 邮箱未注册：自动发送验证码，引导完成注册
        const result = await sendRegisterCode(input);
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        logger.audit('register_code.sent', { email: input, ip: clientIp(req), source: 'login_unregistered' });
        return res.json({ action: 'register_code_sent', email: input });
      }
      logger.audit('login', { username: input, ip: clientIp(req), success: false, reason: 'not_found' });
      return res.status(404).json({ error: '用户名不存在' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      logger.audit('login', { username: input, ip: clientIp(req), success: false });
      return res.status(401).json({ error: '密码错误' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.userRole = user.role;
    logger.audit('login', { username: user.username, ip: clientIp(req), success: true });
    res.json({ id: user.id, username: user.username, email: user.email || null, emailVerified: !!user.email_verified, role: user.role });
  } catch (e) {
    res.status(500).json({ error: '登录失败' });
  }
});

router.get('/wechat/status', (req, res) => {
  res.json({
    enabled: isWechatLoginEnabled(),
    appId: process.env.WECHAT_OPEN_APP_ID || null,
    callbackPath: '/api/auth/wechat/callback'
  });
});

router.get('/wechat/start', loginLimiter, (req, res) => {
  if (!isWechatLoginEnabled()) return res.status(503).json({ error: '微信登录未配置' });
  const state = crypto.randomBytes(24).toString('hex');
  const returnTo = normalizeReturnTo(req.query.returnTo);
  const redirectUri = `${appBaseUrl(req)}/api/auth/wechat/callback`;
  req.session.wechatOAuthState = {
    state,
    returnTo,
    createdAt: Date.now()
  };
  const url = new URL('https://open.weixin.qq.com/connect/qrconnect');
  url.searchParams.set('appid', process.env.WECHAT_OPEN_APP_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'snsapi_login');
  url.searchParams.set('state', state);
  res.redirect(url.toString() + '#wechat_redirect');
});

router.get('/wechat/callback', loginLimiter, async (req, res) => {
  const fail = (reason, status = 302) => {
    logger.audit('wechat.login', { success: false, reason, ip: clientIp(req) });
    return res.status(status).redirect(`${appBaseUrl(req)}/#/login`);
  };
  if (!isWechatLoginEnabled()) return fail('not_configured');
  const saved = req.session.wechatOAuthState;
  delete req.session.wechatOAuthState;
  if (!saved || saved.state !== req.query.state || Date.now() - saved.createdAt > 10 * 60 * 1000) {
    return fail('invalid_state');
  }
  if (req.query.errcode) return fail(String(req.query.errmsg || req.query.errcode));
  const code = String(req.query.code || '').trim();
  if (!code) return fail('missing_code');

  try {
    const redirectUri = `${appBaseUrl(req)}/api/auth/wechat/callback`;
    const profile = await fetchWechatProfile(code, redirectUri);
    if (!profile.openid) return fail('missing_openid');

    const currentUserId = req.session?.userId || null;
    if (currentUserId) {
      const user = await dbGet('SELECT id, username, role FROM users WHERE id = ?', [currentUserId]);
      if (!user) return fail('current_user_missing');
      const existing = await findWechatAccount(profile);
      if (existing && existing.user_id !== user.id) return fail('wechat_already_bound');
      await upsertWechatAccount(user.id, profile);
      loginAsUser(req, user);
      logger.audit('wechat.bind', { userId: user.id, openid: profile.openid, unionid: profile.unionid || null, ip: clientIp(req) });
      return res.redirect(redirectForReturnTo(req, saved.returnTo));
    }

    const account = await findWechatAccount(profile);
    let user;
    if (account) {
      await upsertWechatAccount(account.user_id, profile);
      user = { id: account.user_id, username: account.username, role: account.role };
    } else {
      user = await createUserFromWechat(profile);
      await upsertWechatAccount(user.id, profile);
      logger.audit('wechat.register', { userId: user.id, username: user.username, openid: profile.openid, unionid: profile.unionid || null, ip: clientIp(req) });
    }
    loginAsUser(req, user);
    logger.audit('wechat.login', { success: true, userId: user.id, openid: profile.openid, unionid: profile.unionid || null, ip: clientIp(req) });
    res.redirect(redirectForReturnTo(req, saved.returnTo));
  } catch (e) {
    logger.error({ type: 'app', msg: 'wechat login error', error: e.message });
    return fail(e.message);
  }
});

// --- GitHub OAuth 路由 ---

router.get('/github/status', (req, res) => {
  res.json({
    enabled: isGithubLoginEnabled(),
    clientId: process.env.GITHUB_CLIENT_ID || null,
    callbackPath: '/api/auth/github/callback'
  });
});

router.get('/github/start', loginLimiter, (req, res) => {
  if (!isGithubLoginEnabled()) return res.status(503).json({ error: 'GitHub 登录未配置' });
  const state = crypto.randomBytes(24).toString('hex');
  const returnTo = normalizeReturnTo(req.query.returnTo);
  const redirectUri = `${appBaseUrl(req)}/api/auth/github/callback`;
  req.session.githubOAuthState = {
    state,
    returnTo,
    createdAt: Date.now()
  };
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

router.get('/github/callback', loginLimiter, async (req, res) => {
  const fail = (reason, status = 302) => {
    logger.audit('github.login', { success: false, reason, ip: clientIp(req) });
    return res.status(status).redirect(`${appBaseUrl(req)}/#/login`);
  };
  if (!isGithubLoginEnabled()) return fail('not_configured');
  const saved = req.session.githubOAuthState;
  delete req.session.githubOAuthState;
  if (!saved || saved.state !== req.query.state || Date.now() - saved.createdAt > 10 * 60 * 1000) {
    return fail('invalid_state');
  }
  if (req.query.error) return fail(String(req.query.error_description || req.query.error));
  const code = String(req.query.code || '').trim();
  if (!code) return fail('missing_code');

  try {
    const redirectUri = `${appBaseUrl(req)}/api/auth/github/callback`;
    const profile = await fetchGithubProfile(code, redirectUri);
    if (!profile.providerUserId) return fail('missing_user_id');

    const currentUserId = req.session?.userId || null;
    if (currentUserId) {
      const user = await dbGet('SELECT id, username, role FROM users WHERE id = ?', [currentUserId]);
      if (!user) return fail('current_user_missing');
      const existing = await findGithubAccount(profile);
      if (existing && existing.user_id !== user.id) return fail('github_already_bound');
      await upsertGithubAccount(user.id, profile);
      loginAsUser(req, user);
      logger.audit('github.bind', { userId: user.id, providerUserId: profile.providerUserId, ip: clientIp(req) });
      return res.redirect(redirectForReturnTo(req, saved.returnTo));
    }

    const account = await findGithubAccount(profile);
    let user;
    if (account) {
      await upsertGithubAccount(account.user_id, profile);
      user = { id: account.user_id, username: account.username, role: account.role };
    } else {
      user = await createUserFromGithub(profile);
      await upsertGithubAccount(user.id, profile);
      logger.audit('github.register', { userId: user.id, username: user.username, providerUserId: profile.providerUserId, ip: clientIp(req) });
    }
    loginAsUser(req, user);
    logger.audit('github.login', { success: true, userId: user.id, providerUserId: profile.providerUserId, ip: clientIp(req) });
    res.redirect(redirectForReturnTo(req, saved.returnTo));
  } catch (e) {
    logger.error({ type: 'app', msg: 'github login error', error: e.message });
    return fail(e.message);
  }
});

router.post('/register', registerLimiter, async (req, res) => {
  if (!ALLOW_REGISTRATION) return res.status(403).json({ error: '注册功能未开放' });
  const { email, username, password, confirmPassword, code } = req.body || {};
  if (!email) return res.status(400).json({ error: '请填写邮箱' });
  if (!code) return res.status(400).json({ error: '请填写验证码' });
  if (!password || !confirmPassword) return res.status(400).json({ error: '请填写密码' });
  if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
  if (password !== confirmPassword) return res.status(400).json({ error: '两次密码不一致' });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });

  // 验证码校验（仅验证，不删除）
  const codeHash = crypto.createHash('sha256').update(code + email).digest('hex');
  const codeRow = await dbGet(
    "SELECT * FROM email_verifications WHERE type = 'register_code' AND new_email = ? AND token_hash = ? AND expires_at > datetime('now')",
    [email, codeHash]
  );
  if (!codeRow) return res.status(400).json({ error: '验证码无效或已过期' });

  let finalUsername = username;

  try {
    // 邮箱唯一性检查
    const emailConflict = await dbGet('SELECT id FROM users WHERE email = ? OR username = ?', [email, email]);
    if (emailConflict) return res.status(409).json({ error: '该邮箱已被使用' });

    // 如果没提供 username，从邮箱自动生成
    if (!finalUsername) {
      finalUsername = await generateUsernameFromEmail(email);
    } else {
      if (finalUsername.length < 2 || finalUsername.length > 30 || !/^[a-zA-Z0-9_]+$/.test(finalUsername)) {
        return res.status(400).json({ error: '用户名只能包含字母、数字和下划线，2-30 位' });
      }
      const nameConflict = await dbGet('SELECT id FROM users WHERE username = ? OR email = ?', [finalUsername, finalUsername]);
      if (nameConflict) return res.status(409).json({ error: '该用户名已被使用' });
    }

    // 所有校验通过，消费验证码
    await dbRun('DELETE FROM email_verifications WHERE id = ?', [codeRow.id]);

    const hash = await bcrypt.hash(password, 10);
    const result = await dbRun(
      'INSERT INTO users (username, email, email_verified, password_hash, role) VALUES (?, ?, 1, ?, ?)',
      [finalUsername, email, hash, 'user']
    );
    req.session.userId = result.lastID;
    req.session.username = finalUsername;
    req.session.userRole = 'user';
    logger.audit('register', { username: finalUsername, email, userId: result.lastID, ip: clientIp(req) });
    res.status(201).json({ id: result.lastID, username: finalUsername, email, emailVerified: true, role: 'user' });
  } catch (e) {
    logger.error({ type: 'app', msg: 'register error', error: e.message });
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: '用户名或邮箱已存在' });
    res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});

router.post('/logout', (req, res) => {
  const userId = req.session?.userId;
  req.session.destroy(() => {
    res.clearCookie('jpage.sid');
    logger.audit('logout', { userId, ip: clientIp(req) });
    res.json({ success: true });
  });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: '当前密码和新密码不能为空' });
  if (newPassword.length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.status(401).json({ error: '未登录' });
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(400).json({ error: '当前密码错误' });
    const hash = await bcrypt.hash(newPassword, 10);
    await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.userId]);
    logger.audit('password.change', { userId: req.userId, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '修改密码失败' });
  }
});

router.post('/profile', requireAuth, async (req, res) => {
  const { username, email } = req.body || {};
  if (!username && email === undefined) return res.status(400).json({ error: '无更新字段' });
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.status(401).json({ error: '未登录' });
    const changes = {};
    if (username && username !== user.username) {
      if (username.length > 30 || username.length < 2 || !/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: '用户名 2-30 位，只能包含字母、数字和下划线' });
      }
      const conflict = await dbGet('SELECT id FROM users WHERE username = ? AND id != ?', [username, req.userId]);
      if (conflict) return res.status(409).json({ error: '该用户名已被使用' });
      await dbRun('UPDATE users SET username = ? WHERE id = ?', [username, req.userId]);
      req.session.username = username;
      changes.username = username;
    }
    if (email !== undefined && email !== user.email) {
      if (email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
        const conflict = await dbGet('SELECT id FROM users WHERE (email = ? OR username = ?) AND id != ?', [email, email, req.userId]);
        if (conflict) return res.status(409).json({ error: '该邮箱已被使用' });
        await dbRun('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?', [email, req.userId]);
        changes.email = email;
        changes.emailVerified = false;
        await sendVerificationEmail(req.userId, email, 'verify_email');
      } else {
        await dbRun('UPDATE users SET email = NULL, email_verified = 0 WHERE id = ?', [req.userId]);
        changes.email = null;
        changes.emailVerified = false;
      }
    }
    logger.audit('profile.update', { userId: req.userId, changes, ip: clientIp(req) });
    const updated = await dbGet('SELECT username, email, email_verified FROM users WHERE id = ?', [req.userId]);
    res.json({ username: updated.username, email: updated.email || null, emailVerified: !!updated.email_verified });
  } catch (e) {
    res.status(500).json({ error: '更新失败' });
  }
});

// GET /api/auth/verify-email?token=...
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/#/email-verify-failed');
  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await dbGet('SELECT * FROM email_verifications WHERE token_hash = ?', [hash]);
    if (!row) return res.redirect('/#/email-verify-failed');
    if (new Date(row.expires_at) < new Date()) {
      await dbRun('DELETE FROM email_verifications WHERE id = ?', [row.id]);
      return res.redirect('/#/email-verify-expired');
    }
    if (row.type === 'verify_email') {
      await dbRun('UPDATE users SET email_verified = 1 WHERE id = ?', [row.user_id]);
    } else if (row.type === 'change_email' && row.new_email) {
      await dbRun('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?', [row.new_email, row.user_id]);
    }
    await dbRun('DELETE FROM email_verifications WHERE id = ?', [row.id]);
    logger.audit('email.verify', { userId: row.user_id, type: row.type });
    res.redirect('/#/email-verified');
  } catch (e) {
    logger.error({ type: 'app', message: '邮箱验证失败', error: e.message });
    res.redirect('/#/email-verify-failed');
  }
});

router.post('/resend-verification', requireAuth, resendLimiter, async (req, res) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.status(401).json({ error: '未登录' });
    if (!user.email) return res.status(400).json({ error: '未设置邮箱' });
    if (user.email_verified) return res.status(400).json({ error: '邮箱已验证' });
    const result = await sendVerificationEmail(user.id, user.email, 'verify_email');
    res.json({ success: true, sent: result.sent });
  } catch (e) {
    res.status(500).json({ error: '发送失败' });
  }
});

router.post('/send-register-code', sendCodeLimiter, async (req, res) => {
  if (!ALLOW_REGISTRATION) return res.status(403).json({ error: '注册功能未开放' });
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: '请填写邮箱' });
  const result = await sendRegisterCode(email);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ sent: true });
});

router.get('/smtp-status', (req, res) => {
  res.json({ configured: isMailerConfigured() });
});

router.get('/registration-status', (req, res) => {
  res.json({ enabled: ALLOW_REGISTRATION });
});

module.exports = router;
