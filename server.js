// 即页 jpage 服务端入口。
// 仅负责：app 创建、中间件装配、路由挂载、MCP/静态/catch-all、全局错误处理、启动编排与关闭钩子。
// 业务逻辑分布在 lib/（共享层）与 routes/（按域拆分的 Router）。

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const sqlite3 = require('sqlite3').verbose();
const morgan = require('morgan');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');

const { runMigrations } = require('./migrations');
const { setDb, dbGet, dbRun, configureDatabase } = require('./lib/db');
const { DATA_DIR, UPLOAD_DIR } = require('./lib/paths');
const { generateReadablePassword, currentUserId, now } = require('./lib/util');
const { loadTemplates, loadTemplateNameMap } = require('./lib/templates');
const { reloadCategoryNameCache } = require('./lib/categories');
const { backfillFtsIndex } = require('./lib/fts');
const { scheduleViewCountFlush, flushViewCounts, recordVisit } = require('./lib/view-counts');
const { setAdminUserId } = require('./lib/auth-state');
const { renderFile } = require('./lib/render');
const { initMailer } = require('./mailer');
const { mountMcpServer, closeMcpTransports } = require('./mcp-server');
const logger = require('./logger');

// 路由域
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const tokensRouter = require('./routes/tokens');
const filesRouter = require('./routes/files');
const tagsRouter = require('./routes/tags');
const categoriesRouter = require('./routes/categories');
const contentTemplatesRouter = require('./routes/content-templates');
const adminRouter = require('./routes/admin');
const skillsRouter = require('./routes/skills');

const PORT = process.env.PORT || 8858;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION === 'true';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 创建并注入数据库实例（lib/* 通过 require('./lib/db') 取同一实例）
const db = new sqlite3.Database(path.join(DATA_DIR, 'database.sqlite'));
setDb(db);

// --- 会话密钥 ---
let sessionSecret = process.env.SESSION_SECRET;
let sessionSecretWarning = false;
if (!sessionSecret) {
  if (NODE_ENV === 'production') {
    logger.error({ type: 'app', message: '生产模式下必须设置 SESSION_SECRET' });
    process.exit(1);
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
  sessionSecretWarning = true;
}

const app = express();
app.set('trust proxy', 1);

// helmet：关闭内置 CSP（由下方手写中间件 + render.js 分级下发），
// frameguard 默认 deny（全局 X-Frame-Options: DENY），但渲染端点需被同源 iframe 嵌入（文件列表卡片缩略图），
// 故在下方 CSP 中间件里对渲染端点移除该头，改由 lib/render.js 显式下发 X-Frame-Options: SAMEORIGIN + CSP frame-ancestors 'self'，
// 只允许同源嵌入、外站仍被拒。
// crossOriginEmbedderPolicy 关闭：渲染端点会加载用户内容（可能含未带 CORP 的子资源）。
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' },
}));

// CSP 中间件：管理界面下发严格 APP_CSP；渲染端点（render/asset/短链）跳过，
// 由 lib/render.js 的 renderFile 按内容类型分级下发 Markdown/HTML 策略。
// 渲染端点还需被同源 iframe 嵌入（文件列表卡片缩略图），故移除 helmet 全局下发的
// X-Frame-Options: DENY，改由 render.js 下发 SAMEORIGIN（仅同源可嵌入）。
const { APP_CSP, isRenderPath } = require('./lib/csp');
app.use((req, res, next) => {
  if (isRenderPath(req.path)) {
    res.removeHeader('X-Frame-Options'); // 由 render.js 按需下发 SAMEORIGIN
    return next();
  }
  res.setHeader('Content-Security-Policy', APP_CSP);
  next();
});

// 全局 JSON 解析限制为 1MB；大 body（upload-json / upload-zip-base64）由端点级中间件放宽。
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'jpage.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // HTTPS 部署应开启 secure，避免会话 cookie 被中间人嗅探。
    // 显式通过 COOKIE_SECURE=true 开启；未设时保持 false 以兼容 HTTP 部署。
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// --- 结构化 HTTP 请求日志 ---
morgan.token('user-id', (req) => req.userId || req.session?.userId || '-');
morgan.token('ts', () => new Date().toISOString());
app.use(morgan((tokens, req, res) => {
  return JSON.stringify({
    level: 'info',
    type: 'http',
    method: tokens.method(req, res),
    url: tokens.url(req, res),
    status: parseInt(tokens.status(req, res), 10),
    contentLength: tokens.res(req, res, 'content-length') || 0,
    responseTime: tokens['response-time'](req, res) + ' ms',
    remoteAddr: tokens['remote-addr'](req, res),
    userAgent: tokens['user-agent'](req, res),
    referrer: tokens.referrer(req, res) || '',
    userId: tokens['user-id'](req, res),
    timestamp: tokens.ts(req, res),
  });
}, {
  skip: (req) => req.path.startsWith('/vendor/') || /\.(css|js|map|png|ico|woff2?)$/i.test(req.path),
}));

const { version: PACKAGE_VERSION } = require('./package.json');

// --- 健康检查 ---
app.get('/health', async (req, res) => {
  let dbOk = false;
  let diskOk = false;
  try { await dbGet('SELECT 1'); dbOk = true; } catch {}
  try { diskOk = fs.existsSync(UPLOAD_DIR); } catch {}
  const ok = dbOk && diskOk;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    db: dbOk,
    disk: diskOk,
    uptime: process.uptime(),
    version: PACKAGE_VERSION
  });
});

// --- 路由挂载 ---
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/tokens', tokensRouter);
app.use('/api/files', filesRouter);
app.use('/api/tags', tagsRouter);
app.use('/api', categoriesRouter);       // /api/categories、/api/templates
app.use('/api/content-templates', contentTemplatesRouter);
app.use('/api/admin', adminRouter);
app.use('/api', skillsRouter);            // /api/skills、/api/mcp/config

// --- 短链（根路径，公开热点）---
// 访问门槛（按序）：
//   1. 文件不存在 → 404
//   2. 已过期（share_expires_at <= 当前 UTC）→ 410 Gone 页
//   3. 私有且未登录 → 重定向首页
//   4. 设了访问密码且本会话未解锁 → 密码表单页（200）
//   5. 否则记录访问 + 渲染
//
// 密码解锁态存服务端 SQLite session（unlockedShares: { [shareKey]: true }），
// 会话级有效，无需额外 cookie。POST /s/:key 验密码并写入该态。
const shareKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: '尝试过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 判定短链文件是否已被本会话解锁（无密码视为已解锁）。
function isShareUnlocked(req, file) {
  if (!file.share_password_hash) return true;
  const unlocked = req.session && req.session.unlockedShares;
  return !!(unlocked && unlocked[file.share_key]);
}

// 过期页 HTML：告知链接已过期，引导联系分享者。
const EXPIRED_HTML = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:sans-serif;text-align:center;padding:4em"><h1>链接已过期</h1><p>该分享链接已失效。</p><a href="/">返回首页</a></body></html>';

// 密码表单页：内联样式 + 单一表单，POST 回 /s/:key。
// 转义防 XSS（key 来自 DB 但仍防御性处理）。error 非空时显示错误提示。
function renderSharePasswordPage(key, error) {
  const safeKey = String(key).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const errorBlock = error
    ? `<div style="color:#cf222e;margin-bottom:1em">${String(error).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]))}</div>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>需要密码</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f8fa">
<div style="background:#fff;padding:2.5em;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);width:100%;max-width:360px;box-sizing:border-box">
<h1 style="font-size:1.3em;margin:0 0 .5em;color:#1f2328">需要访问密码</h1>
<p style="color:#57606a;margin:0 0 1.5em;font-size:.9em">该分享链接受密码保护，请输入密码后查看。</p>
<form method="POST" action="/s/${safeKey}">
${errorBlock}
<input type="password" name="password" placeholder="输入密码" autofocus required style="width:100%;padding:.6em .75em;border:1px solid #d0d7de;border-radius:6px;font-size:1em;box-sizing:border-box;margin-bottom:1em">
<button type="submit" style="width:100%;padding:.65em;background:#1f6feb;color:#fff;border:none;border-radius:6px;font-size:1em;cursor:pointer">查看</button>
</form>
</div></body></html>`;
}

app.get('/s/:key', async (req, res) => {
  try {
    const file = await dbGet('SELECT * FROM files WHERE share_key = ?', [req.params.key]);
    if (!file) return res.status(404).send('<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:sans-serif;text-align:center;padding:4em"><h1>404</h1><p>页面不存在</p><a href="/">返回首页</a></body></html>');
    // 过期判定（UTC 字符串比较）
    if (file.share_expires_at && file.share_expires_at <= now()) {
      return res.status(410).send(EXPIRED_HTML);
    }
    if (!file.is_public && !currentUserId(req)) return res.redirect('/');
    // 访问密码门
    if (!isShareUnlocked(req, file)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(renderSharePasswordPage(req.params.key, null));
    }
    recordVisit(file, req).catch(() => {});
    await renderFile(res, file);
  } catch (e) {
    logger.error({ type: 'app', action: 'shortlink.get', error: e.message });
    res.status(500).json({ error: '渲染失败' });
  }
});

// --- 短链密码校验（POST）---
// 验证通过 → 在 session 标记解锁该 key → 重定向回 GET /s/:key（现可渲染）。
// 失败 → 重新返回表单页并提示错误。
app.post('/s/:key', shareKeyLimiter, async (req, res) => {
  try {
    const file = await dbGet('SELECT * FROM files WHERE share_key = ?', [req.params.key]);
    // 出于安全：无论文件是否存在，密码错误时都回"密码错误"，避免泄露文件存在性。
    const password = (req.body && req.body.password) ? String(req.body.password) : '';
    if (!file) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(renderSharePasswordPage(req.params.key, '密码错误'));
    }
    if (file.share_expires_at && file.share_expires_at <= now()) {
      return res.status(410).send(EXPIRED_HTML);
    }
    if (!file.is_public && !currentUserId(req)) return res.redirect('/');
    const ok = file.share_password_hash
      ? await bcrypt.compare(password, file.share_password_hash).catch(() => false)
      : true; // 无密码：放行（与 GET 一致）
    if (!ok) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(renderSharePasswordPage(req.params.key, '密码错误'));
    }
    if (!req.session.unlockedShares) req.session.unlockedShares = {};
    req.session.unlockedShares[file.share_key] = true;
    res.redirect(`/s/${encodeURIComponent(file.share_key)}`);
  } catch (e) {
    logger.error({ type: 'app', action: 'shortlink.post', error: e.message });
    res.status(500).json({ error: '校验失败' });
  }
});

// --- MCP 端点 ---
async function authenticateMcpToken(tokenValue) {
  // 旧 MCP_TOKEN
  if (process.env.MCP_TOKEN && tokenValue === process.env.MCP_TOKEN) return true;
  // 用户级 Token
  const hash = crypto.createHash('sha256').update(tokenValue).digest('hex');
  const row = await dbGet('SELECT id FROM tokens WHERE token_hash = ?', [hash]);
  return !!row;
}

mountMcpServer(app, {
  port: PORT,
  mcpToken: process.env.MCP_TOKEN,
  mcpIp: process.env.MCP_IP || 'localhost',
  protocol: process.env.MCP_PROTOCOL || 'http',
  authenticateRequest: authenticateMcpToken,
});

// --- 静态资源 ---
const NODE_MODULES = path.join(__dirname, 'node_modules');
// 静态资源长缓存：版本化路径（vendor 内容随包固定，public 资源带 ?v= 查询参数）
// 30 天 + immutable，命中后浏览器零往返；首次加载仍走 ETag。
const STATIC_OPTS = { maxAge: '30d', immutable: true, etag: true, lastModified: true };
app.use('/vendor/katex', express.static(path.join(NODE_MODULES, 'katex', 'dist'), STATIC_OPTS));
app.use('/vendor/highlight.js', express.static(path.join(NODE_MODULES, 'highlight.js'), STATIC_OPTS));
app.use('/vendor/mermaid', express.static(path.join(NODE_MODULES, 'mermaid', 'dist'), STATIC_OPTS));

// index:false —— 不让 static 自动把 / 映射到 index.html（由下方 catch-all 注入哈希资源路径后返回）
app.use(express.static(path.join(__dirname, 'public'), { ...STATIC_OPTS, index: false }));

// --- SPA 兜底：返回 index.html，注入打包后的带哈希资源路径（若已 build）---
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
const DIST_MANIFEST_PATH = path.join(__dirname, 'public', 'dist', 'manifest.json');
let _indexHtmlCache = { html: null, manifestMtime: 0, manifest: null };
function getIndexHtml() {
  let manifest = null, manifestMtime = 0;
  try {
    const st = fs.statSync(DIST_MANIFEST_PATH);
    manifestMtime = st.mtimeMs;
    if (_indexHtmlCache.html && _indexHtmlCache.manifestMtime === manifestMtime) {
      return _indexHtmlCache.html; // manifest 未变，用缓存
    }
    manifest = JSON.parse(fs.readFileSync(DIST_MANIFEST_PATH, 'utf8'));
  } catch {
    // 无构建产物 → 返回源 index.html（引用源文件 /css、/js）
    if (_indexHtmlCache.html && !_indexHtmlCache.manifest) return _indexHtmlCache.html;
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    _indexHtmlCache = { html, manifestMtime: 0, manifest: null };
    return html;
  }
  // 注入哈希路径
  let html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  if (manifest['style.css']) {
    html = html.replace(/\/css\/style\.css\?v=[^"']+/g, '/dist/' + manifest['style.css']);
  }
  if (manifest['app.js']) {
    html = html.replace(/\/js\/app\.js\?v=[^"']+/g, '/dist/' + manifest['app.js']);
  }
  _indexHtmlCache = { html, manifestMtime, manifest };
  return html;
}

app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getIndexHtml());
});

// --- 全局错误处理 ---
app.use((err, req, res, _next) => {
  logger.error({ type: 'app', message: err.message, stack: err.stack });
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '文件大小超过50MB限制' });
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

// --- 初始管理员引导 ---
async function bootstrapAdmin() {
  let adminUser = process.env.ADMIN_USER;
  const explicitPass = process.env.ADMIN_PASSWORD;
  try {
    const row = await dbGet('SELECT COUNT(*) AS c FROM users');
    if (row.c > 0) return;

    if (!adminUser) adminUser = 'admin';

    let adminPass;
    if (explicitPass) {
      if (explicitPass.length < 8) {
        logger.warn({ type: 'app', message: 'ADMIN_PASSWORD 长度不足 8 位，跳过自动创建' });
        logger.warn({ type: 'app', message: '解决方式：设置为 ≥8 位的强密码，或留空以自动生成' });
        return;
      }
      adminPass = explicitPass;
    } else {
      adminPass = generateReadablePassword(16);
    }

    const hash = await bcrypt.hash(adminPass, 10);
    await dbRun('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [adminUser, hash, 'admin']);
    logger.info({ type: 'app', message: '已创建初始管理员', username: adminUser });
    if (!explicitPass) {
      logger.info({ type: 'app', message: '初始密码', password: adminPass, sensitive: true });
      logger.info({ type: 'app', message: '首次登录后请立即修改密码' });
    }
  } catch (e) {
    logger.error({ type: 'app', message: '初始化管理员失败', error: e.message });
  }
}

// --- 启动 ---
// 初始化数据库与缓存（启动和测试都需要）；listen 仅在直接运行时执行。
async function initApp() {
  await configureDatabase();
  await runMigrations(db);
  initMailer();
  loadTemplates();
  await loadTemplateNameMap();
  await reloadCategoryNameCache();
  await backfillFtsIndex();
  await bootstrapAdmin();
  let adminUserId = null;
  try {
    const row = await dbGet('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    if (row) adminUserId = row.id;
  } catch (e) {
    logger.error({ type: 'app', message: '解析 admin user id 失败', error: e.message });
  }
  setAdminUserId(adminUserId);
  scheduleViewCountFlush();
  return adminUserId;
}

if (require.main === module) {
  app.listen(PORT, async () => {
    const mcpIp = process.env.MCP_IP || 'localhost';
    const adminUserId = await initApp();
    logger.info({ type: 'app', message: '服务已启动', url: `http://${mcpIp}:${PORT}`, registration: ALLOW_REGISTRATION ? 'open' : 'closed' });
    if (sessionSecretWarning) logger.warn({ type: 'app', message: 'SESSION_SECRET 未设置，已生成临时密钥（重启后会话会失效）' });

    // 自动定时备份
    const backupCron = process.env.BACKUP_CRON;
    if (backupCron) {
      const { createBackupArchive } = adminRouter;
      const backupDir = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      if (cron.validate(backupCron)) {
        cron.schedule(backupCron, () => {
          try {
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const fname = `jpage-backup-${ts}.zip`;
            const fpath = path.join(backupDir, fname);
            const output = fs.createWriteStream(fpath);
            const archive = createBackupArchive();
            output.on('close', () => {
              logger.info({ type: 'app', message: '自动备份完成', file: fpath });
              const backups = fs.readdirSync(backupDir)
                .filter(f => f.startsWith('jpage-backup-') && f.endsWith('.zip'))
                .sort();
              while (backups.length > 7) {
                fs.unlinkSync(path.join(backupDir, backups.shift()));
              }
            });
            archive.pipe(output);
            archive.finalize();
          } catch (e) {
            logger.error({ type: 'app', message: '自动备份失败', error: e.message });
          }
        });
        logger.info({ type: 'app', message: '自动备份已启用', cron: backupCron, dir: backupDir });
      } else {
        logger.warn({ type: 'app', message: 'BACKUP_CRON 格式无效', cron: backupCron });
      }
    }
    if (process.env.MCP_TOKEN && !adminUserId) {
      logger.warn({ type: 'app', message: 'MCP_TOKEN 已设置但 users 表为空，MCP 端点将禁用' });
    } else if (process.env.MCP_TOKEN && adminUserId) {
      logger.info({ type: 'app', message: 'MCP 端点已启用', url: `http://${mcpIp}:${PORT}/mcp` });
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      logger.info({ type: 'app', message: `收到 ${sig}，正在关闭 MCP transport` });
      await flushViewCounts(); // 关闭前回写缓冲的 view_count，避免丢失
      await closeMcpTransports();
      process.exit(0);
    });
  }
}

// 导出供集成测试使用（require 时不 listen）
module.exports = { app, db, initApp };
