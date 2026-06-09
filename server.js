const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const sqlite3 = require('sqlite3').verbose();
const { runMigrations, dbRun: _dbRun, dbGet: _dbGet, dbAll: _dbAll } = require('./migrations');
const { marked } = require('marked');
const { markedHighlight } = require('marked-highlight');
const hljs = require('highlight.js');
const katex = require('katex');
const JSZip = require('jszip');
const { mountMcpServer, closeMcpTransports } = require('./mcp-server');
const { listSkills, getSkill, createZipStream } = require('./skills-registry');
const cron = require('node-cron');
const archiver = require('archiver');
const morgan = require('morgan');
const logger = require('./logger');

// --- 北京时间工具 ---
function now() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

// --- 异步文件清理 ---
function unlinkQuiet(p) { return fs.promises.unlink(p).catch(() => {}); }

// --- ZIP 安全常量 ---
const ZIP_MAX_FILE_COUNT = 1000;
const ZIP_MAX_EXTRACTED_SIZE = 200 * 1024 * 1024;
const ZIP_MAX_SINGLE_FILE_SIZE = 50 * 1024 * 1024;

// --- ZIP 工具函数 ---

async function validateZipEntries(zip) {
  const entries = [];
  let fileCount = 0;
  return new Promise((resolve, reject) => {
    zip.forEach((normalizedPath, zipEntry) => {
      if (normalizedPath.includes('..')) {
        return reject(new Error('ZIP 条目路径包含目录穿越: ' + (zipEntry.unsafeOriginalName || normalizedPath)));
      }
      if (zipEntry.unixPermissions != null &&
          (zipEntry.unixPermissions & 0o170000) === 0o120000) {
        return reject(new Error('ZIP 包含符号链接: ' + (zipEntry.unsafeOriginalName || normalizedPath)));
      }
      if (!normalizedPath.trim() || zipEntry.dir) return;
      fileCount++;
      entries.push({ name: normalizedPath, originalName: zipEntry.unsafeOriginalName || normalizedPath });
    });
    if (fileCount === 0) return reject(new Error('ZIP 包中无文件'));
    if (fileCount > ZIP_MAX_FILE_COUNT) return reject(new Error('ZIP 包含 ' + fileCount + ' 个文件，超过上限 ' + ZIP_MAX_FILE_COUNT));
    resolve(entries);
  });
}

async function extractEntries(zip, entries, targetDir) {
  let totalSize = 0;
  const results = [];
  const resolvedTarget = path.resolve(targetDir) + path.sep;
  for (const entry of entries) {
    const zipFile = zip.file(entry.name);
    if (!zipFile) continue;
    const buf = await zipFile.async('nodebuffer');
    if (buf.length > ZIP_MAX_SINGLE_FILE_SIZE) throw new Error('文件 ' + entry.name + ' 解压后超过单文件限制');
    totalSize += buf.length;
    if (totalSize > ZIP_MAX_EXTRACTED_SIZE) throw new Error('解压总大小超过 ' + Math.round(ZIP_MAX_EXTRACTED_SIZE / 1024 / 1024) + 'MB 限制');
    const filePath = path.join(targetDir, entry.name);
    if (!path.resolve(filePath).startsWith(resolvedTarget)) throw new Error('路径穿越: ' + entry.name);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buf);
    results.push({ name: entry.name, size: buf.length });
  }
  return { entries: results, totalSize };
}

function findEntryHtml(entries) {
  const htmlExts = ['.html', '.htm'];
  for (const name of ['index.html', 'index.htm']) {
    const found = entries.find(e => e.name.toLowerCase() === name);
    if (found) return found.name;
  }
  const rootHtmls = entries.filter(e =>
    htmlExts.some(ext => e.name.toLowerCase().endsWith(ext)) && !e.name.includes('/')
  ).sort((a, b) => a.name.localeCompare(b.name));
  if (rootHtmls.length > 0) return rootHtmls[0].name;
  for (const name of ['index.html', 'index.htm']) {
    const found = entries.find(e => e.name.split('/').pop().toLowerCase() === name);
    if (found) return found.name;
  }
  const anyHtml = entries.find(e => htmlExts.some(ext => e.name.toLowerCase().endsWith(ext)));
  return anyHtml ? anyHtml.name : null;
}

function classifyZip(entries) {
  const htmlExts = ['.html', '.htm'];
  const assetExts = ['.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif',
    '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot',
    '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.pdf',
    '.map', '.webmanifest', '.xml', '.txt'];
  const htmlFiles = entries.filter(e => htmlExts.some(ext => e.name.toLowerCase().endsWith(ext)));
  const mdFiles = entries.filter(e => e.name.toLowerCase().endsWith('.md') || e.name.toLowerCase().endsWith('.markdown'));
  const assetFiles = entries.filter(e => assetExts.some(ext => e.name.toLowerCase().endsWith(ext)));
  const hasSubDirs = entries.some(e => e.name.includes('/'));
  if (htmlFiles.length === 0 && mdFiles.length === 0) return { type: 'reject', reason: 'ZIP 中无 HTML 或 Markdown 文件' };
  const hasRootIndex = entries.some(e => e.name.toLowerCase() === 'index.html' || e.name.toLowerCase() === 'index.htm');
  if (htmlFiles.length >= 1 && hasRootIndex && (hasSubDirs || assetFiles.length > 0)) return { type: 'bundle', entryFile: findEntryHtml(entries) };
  if (htmlFiles.length >= 1 && (hasSubDirs || assetFiles.length > 0) && mdFiles.length === 0) {
    const entry = findEntryHtml(entries);
    if (entry) return { type: 'bundle', entryFile: entry };
  }
  if (!hasSubDirs && assetFiles.length === 0) return { type: 'batch', files: [...htmlFiles, ...mdFiles] };
  if (htmlFiles.length === 1) return { type: 'bundle', entryFile: findEntryHtml(entries) };
  return { type: 'batch', files: [...htmlFiles, ...mdFiles] };
}


// --- 模板系统 ---
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const templateCache = {};

const TEMPLATE_PLACEHOLDERS = {
  katex_css_url: '/vendor/katex/katex.min.css',
  hljs_css_url: '/vendor/highlight.js/styles',
  mermaid_js_url: '/vendor/mermaid/mermaid.min.js',
  hljs_js_url: '/vendor/highlight.js/highlight.min.js',
  katex_js_url: '/vendor/katex/katex.min.js',
  marked_js_url: '/vendor/marked/marked.min.js',
};

function loadTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return;
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.html'));
  for (const f of files) {
    const name = path.basename(f, '.html');
    templateCache[name] = fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf-8');
  }
  logger.info({ type: 'app', msg: 'templates loaded', count: Object.keys(templateCache).length });
}

function applyTemplate(tpl, title, content, hljsTheme) {
  let html = tpl;
  html = html.replace(/\{\{title\}\}/g, title);
  html = html.replace(/\{\{content\}\}/g, content);
  html = html.replace(/\{\{hljs_theme\}\}/g, hljsTheme || 'github');
  for (const [key, value] of Object.entries(TEMPLATE_PLACEHOLDERS)) {
    html = html.replace(new RegExp('\\{\\{' + key + '\\}\\}', 'g'), value);
  }
  return html;
}

const BUILTIN_TEMPLATE_THEMES = {
  default: 'github',
  github: 'github',
  academic: 'github',
  'dark-pro': 'github-dark-dimmed',
};

let templateNameToId = {};

async function loadTemplateNameMap() {
  const rows = await dbAll('SELECT id, name FROM templates');
  templateNameToId = {};
  for (const r of rows) templateNameToId[r.name] = r.id;
}

async function getTemplateForFile(file) {
  const tplId = file.template_id;
  if (tplId) {
    const row = await dbGet('SELECT name FROM templates WHERE id = ?', [tplId]);
    if (row && templateCache[row.name]) return row.name;
  }
  return 'default';
}

function renderKatex(tex, displayMode) {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: 'html',
      strict: false
    });
  } catch (e) {
    return `<code class="katex-error">${tex}</code>`;
  }
}

marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  }
}));

marked.use({
  extensions: [
    {
      name: 'katexInline',
      level: 'inline',
      start(src) { return src.indexOf('$'); },
      tokenizer(src) {
        const match = /^\$([^\$\n]+?)\$/.exec(src);
        if (!match) return;
        return {
          type: 'katexInline',
          raw: match[0],
          text: match[1]
        };
      },
      renderer(token) {
        return renderKatex(token.text, false);
      }
    },
    {
      name: 'katexBlock',
      level: 'block',
      start(src) { return src.indexOf('$$'); },
      tokenizer(src) {
        const match = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);
        if (!match) return;
        return {
          type: 'katexBlock',
          raw: match[0],
          text: match[1]
        };
      },
      renderer(token) {
        return `<div class="katex-display">${renderKatex(token.text, true)}</div>\n`;
      }
    }
  ]
});

const app = express();
const PORT = process.env.PORT || 8858;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new sqlite3.Database(path.join(DATA_DIR, 'database.sqlite'));

function generateShareKey() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

function dbRun(sql, params = []) {
  return _dbRun(db, sql, params);
}

function dbGet(sql, params = []) {
  return _dbGet(db, sql, params);
}

function dbAll(sql, params = []) {
  return _dbAll(db, sql, params);
}

// --- FTS5 全文搜索 ---

const FTS_INDEXABLE_EXTS = new Set(['.html', '.htm', '.md', '.markdown', '.txt']);
const FTS_MAX_CONTENT_SIZE = 100 * 1024; // 100KB

function isFtsIndexable(fileType, storedName) {
  if (fileType === 'bundle') return false;
  const ext = path.extname(storedName || '').toLowerCase();
  return FTS_INDEXABLE_EXTS.has(ext);
}

async function indexFileContent(fileId, storedName) {
  try {
    const filePath = path.join(UPLOAD_DIR, storedName);
    if (!fs.existsSync(filePath)) return;
    let content = await fs.promises.readFile(filePath, 'utf-8');
    if (content.length > FTS_MAX_CONTENT_SIZE) content = content.slice(0, FTS_MAX_CONTENT_SIZE);
    // 去除 HTML 标签，只保留纯文本用于索引
    content = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // 对 CJK 字符逐字加空格，使 unicode61 tokenizer 能按字符分词
    content = content.replace(/([一-鿿])/g, ' $1 ');
    content = content.replace(/\s+/g, ' ').trim();
    await dbRun('DELETE FROM file_contents_fts WHERE file_id = ?', [fileId]);
    await dbRun('INSERT INTO file_contents_fts(rowid, file_id, content) VALUES (?, ?, ?)', [fileId, fileId, content]);
  } catch (e) {
    logger.error({ type: 'app', message: 'FTS 索引失败', fileId, error: e.message });
  }
}

async function deleteFileIndex(fileId) {
  try {
    await dbRun('DELETE FROM file_contents_fts WHERE file_id = ?', [fileId]);
  } catch (e) {
    logger.error({ type: 'app', message: 'FTS 删除索引失败', fileId, error: e.message });
  }
}

async function backfillFtsIndex() {
  try {
    const count = await dbGet('SELECT COUNT(*) AS cnt FROM file_contents_fts');
    if (count.cnt > 0) return;
    const files = await dbAll('SELECT id, stored_name, file_type, is_bundle FROM files');
    let indexed = 0;
    for (const f of files) {
      if (f.is_bundle) continue;
      if (!isFtsIndexable(f.file_type, f.stored_name)) continue;
      await indexFileContent(f.id, f.stored_name);
      indexed++;
    }
    if (indexed > 0) logger.info({ type: 'app', message: 'FTS 索引回填完成', count: indexed });
  } catch (e) {
    logger.error({ type: 'app', message: 'FTS 索引回填失败', error: e.message });
  }
}

function escapeFtsQuery(q) {
  // 移除 FTS5 特殊字符
  let cleaned = q.replace(/["'*:(){}[\]\\^+\-&|!~]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  // 对 CJK 字符逐字加空格，与索引时一致
  cleaned = cleaned.replace(/([一-鿿])/g, ' $1 ').replace(/\s+/g, ' ').trim();
  // 对每个 token 加引号，避免 FTS5 语法错误
  return cleaned.split(/\s+/).map(w => `"${w}"`).join(' ');
}

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

let adminUserId = null;

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CSP 中间件：保护即页主应用，跳过用户内容渲染端点
app.use((req, res, next) => {
  if (/^\/api\/files\/\d+\/(render|versions\/\d+\/render|asset\/)/.test(req.path) || /^\/s\//.test(req.path)) return next();
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'"
  );
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

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
    secure: false,
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

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.socket?.remoteAddress || '-';
}

function currentUserId(req) {
  return req.userId || (req.session && req.session.userId) || null;
}

async function requireAuth(req, res, next) {
  // Session 路径
  if (req.session && req.session.userId) {
    req.userId = req.session.userId;
    // 从 session 读取 role，若旧 session 无 role 则从 DB 回填
    if (req.session.userRole) {
      req.userRole = req.session.userRole;
    } else {
      const user = await dbGet('SELECT role FROM users WHERE id = ?', [req.session.userId]);
      if (!user) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: '未登录' });
      }
      req.session.userRole = user.role;
      req.userRole = user.role;
    }
    return next();
  }

  // Bearer Token 路径
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const tokenValue = auth.slice(7);

    // 1. 旧 MCP_TOKEN 向后兼容
    if (process.env.MCP_TOKEN && tokenValue === process.env.MCP_TOKEN && adminUserId) {
      req.mcpUserId = adminUserId;
      req.userId = adminUserId;
      const admin = await dbGet('SELECT role FROM users WHERE id = ?', [adminUserId]);
      req.userRole = admin ? admin.role : 'admin';
      return next();
    }

    // 2. 用户级 Token 查询
    const hash = crypto.createHash('sha256').update(tokenValue).digest('hex');
    const tokenRow = await dbGet(
      'SELECT t.user_id, u.role FROM tokens t JOIN users u ON t.user_id = u.id WHERE t.token_hash = ?',
      [hash]
    );
    if (tokenRow) {
      dbRun('UPDATE tokens SET last_used_at = ? WHERE token_hash = ?', [now(), hash]).catch(() => {});
      req.tokenUserId = tokenRow.user_id;
      req.userId = tokenRow.user_id;
      req.userRole = tokenRow.role;
      return next();
    }
  }

  return res.status(401).json({ error: '未登录' });
}

function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

function loadFileWithPrivacy(req, res, next) {
  dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]).then(file => {
    if (!file) return res.status(404).json({ error: '文件不存在' });
    const userId = req.userId;
    const role = req.userRole;

    // admin 可访问一切
    if (role === 'admin') {
      req.fileRecord = file;
      return next();
    }
    // 普通用户：公开文件 或 自己的文件
    if (userId && (file.is_public || file.uploaded_by === userId)) {
      req.fileRecord = file;
      return next();
    }
    // 未登录：仅公开文件
    if (!userId && file.is_public) {
      req.fileRecord = file;
      return next();
    }
    if (!userId) return res.status(401).json({ error: '未登录' });
    return res.status(403).json({ error: '无权访问此文件' });
  }).catch(() => {
    res.status(500).json({ error: '读取失败' });
  });
}

function checkFileOwnership(req, file) {
  if (req.userRole === 'admin') return true;
  if (file.uploaded_by === req.userId) return true;
  return false;
}

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: '上传请求过于频繁，请稍后再试' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '登录尝试过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false
});

function decodeFilename(name) {
  if (!name) return name;
  // 如果字符串已包含非 latin1 字符（如中文），说明 multer 已正确解码，直接返回
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 255) return name;
  }
  // 纯 latin1 字符串 — 尝试当作原始 UTF-8 字节解读并验证
  const buf = Buffer.from(name, 'latin1');
  const decoded = buf.toString('utf8');
  if (Buffer.from(decoded).equals(buf)) return decoded;
  return name;
}

function generateReadablePassword(length) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let pwd = '';
  for (let i = 0; i < length; i++) {
    pwd += chars[bytes[i] % chars.length];
  }
  return pwd;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const decoded = decodeFilename(file.originalname);
    const ext = path.extname(decoded);
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const decoded = decodeFilename(file.originalname);
    const allowed = ['.html', '.htm', '.md', '.markdown', '.zip'];
    const ext = path.extname(decoded).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('仅支持 HTML、Markdown 和 ZIP 文件'));
  }
});

const { version: PACKAGE_VERSION } = require('./package.json');

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

app.get('/api/auth/me', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: '未登录' });
  try {
    const user = await dbGet('SELECT id, username, role FROM users WHERE id = ?', [req.session.userId]);
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: '未登录' });
    }
    res.json({ id: user.id, username: user.username, role: user.role });
  } catch (e) {
    res.status(500).json({ error: '查询失败' });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  try {
    const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) return res.status(401).json({ error: '登录失败' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      logger.audit('login', { username, ip: clientIp(req), success: false });
      return res.status(401).json({ error: '登录失败' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.userRole = user.role;
    logger.audit('login', { username, ip: clientIp(req), success: true });
    res.json({ id: user.id, username: user.username, role: user.role });
  } catch (e) {
    res.status(500).json({ error: '登录失败' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const userId = req.session?.userId;
  req.session.destroy(() => {
    res.clearCookie('jpage.sid');
    logger.audit('logout', { userId, ip: clientIp(req) });
    res.json({ success: true });
  });
});


// --- 修改密码 ---
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
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

// --- 用户管理（仅 admin） ---
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await dbAll('SELECT id, username, role, created_at FROM users ORDER BY id ASC');
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: '获取用户列表失败' });
  }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
  if (!['admin', 'user'].includes(role || 'user')) return res.status(400).json({ error: '无效角色' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await dbRun(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, hash, role || 'user']
    );
    logger.audit('user.create', { userId: result.lastID, username, role: role || 'user', createdBy: req.userId, ip: clientIp(req) });
    res.json({ id: result.lastID, username, role: role || 'user' });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ error: '用户名已存在' });
    res.status(500).json({ error: '创建用户失败' });
  }
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: '无效用户 ID' });
  const { role, password } = req.body || {};
  if (!role && !password) return res.status(400).json({ error: '无更新字段' });
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (role) {
      if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: '无效角色' });
      await dbRun('UPDATE users SET role = ? WHERE id = ?', [role, targetId]);
    }
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
      const hash = await bcrypt.hash(password, 10);
      await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [hash, targetId]);
    }
    logger.audit('user.update', { targetUserId: targetId, changes: { role, password: !!password }, updatedBy: req.userId, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '更新用户失败' });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: '无效用户 ID' });
  if (targetId === req.userId) return res.status(400).json({ error: '不能删除自己' });
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    // 将该用户的文件转交给第一个 admin
    const admin = await dbGet("SELECT id FROM users WHERE role = 'admin' AND id != ? ORDER BY id ASC LIMIT 1", [targetId]);
    if (admin) {
      await dbRun('UPDATE files SET uploaded_by = ? WHERE uploaded_by = ?', [admin.id, targetId]);
    }
    // 删除用户（ON DELETE CASCADE 会清理 tokens）
    await dbRun('DELETE FROM users WHERE id = ?', [targetId]);
    logger.audit('user.delete', { targetUserId: targetId, username: user.username, deletedBy: req.userId, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '删除用户失败' });
  }
});

// --- Token 管理 ---
function generateApiToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(32);
  let token = 'jp_';
  for (let i = 0; i < 32; i++) {
    token += chars[bytes[i] % chars.length];
  }
  return token;
}

app.get('/api/tokens', requireAuth, async (req, res) => {
  try {
    const tokens = await dbAll(
      'SELECT id, name, token_prefix, last_used_at, created_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC',
      [req.userId]
    );
    res.json({ tokens });
  } catch (e) {
    res.status(500).json({ error: '获取令牌列表失败' });
  }
});

app.post('/api/tokens', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '令牌名称不能为空' });
  try {
    // 每用户最多 10 个 Token
    const count = await dbGet('SELECT COUNT(*) AS c FROM tokens WHERE user_id = ?', [req.userId]);
    if (count.c >= 10) return res.status(400).json({ error: '最多创建 10 个令牌' });

    const tokenValue = generateApiToken();
    const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');
    const tokenPrefix = tokenValue.slice(0, 8);

    const result = await dbRun(
      'INSERT INTO tokens (user_id, name, token_hash, token_prefix) VALUES (?, ?, ?, ?)',
      [req.userId, name.trim(), tokenHash, tokenPrefix]
    );
    logger.audit('token.create', { tokenId: result.lastID, name: name.trim(), userId: req.userId, ip: clientIp(req) });
    res.json({
      id: result.lastID,
      name: name.trim(),
      token: tokenValue,
      token_prefix: tokenPrefix,
    });
  } catch (e) {
    res.status(500).json({ error: '创建令牌失败' });
  }
});

app.delete('/api/tokens/:id', requireAuth, async (req, res) => {
  const tokenId = parseInt(req.params.id);
  if (isNaN(tokenId)) return res.status(400).json({ error: '无效令牌 ID' });
  try {
    const token = await dbGet('SELECT * FROM tokens WHERE id = ?', [tokenId]);
    if (!token) return res.status(404).json({ error: '令牌不存在' });
    if (token.user_id !== req.userId && req.userRole !== 'admin') {
      return res.status(403).json({ error: '无权删除此令牌' });
    }
    await dbRun('DELETE FROM tokens WHERE id = ?', [tokenId]);
    logger.audit('token.delete', { tokenId, userId: req.userId, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '删除令牌失败' });
  }
});

app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const role = req.userRole;

    // 分页参数
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const maxLimit = 100;
    const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    // 排序参数
    const allowedSorts = ['updated_at', 'created_at', 'original_name', 'size'];
    const sort = allowedSorts.includes(req.query.sort) ? req.query.sort : 'updated_at';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

    // 筛选参数
    const keyword = (req.query.keyword || '').trim();
    const categoryId = req.query.category || null;
    const tagId = req.query.tag || null;

    // 构建 WHERE 条件
    const conditions = [];
    const params = [];

    if (role !== 'admin') {
      conditions.push(`(f.uploaded_by = ? OR f.is_public = 1)`);
      params.push(userId);
    }
    if (keyword) {
      conditions.push(`f.original_name LIKE ?`);
      params.push(`%${keyword}%`);
    }
    if (categoryId === 'uncategorized') {
      conditions.push(`f.category_id IS NULL`);
    } else if (categoryId) {
      conditions.push(`f.category_id = ?`);
      params.push(parseInt(categoryId));
    }
    if (tagId) {
      conditions.push(`EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id AND ft.tag_id = ?)`);
      params.push(parseInt(tagId));
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // 总数查询
    const countRow = await dbGet(`SELECT COUNT(*) AS total FROM files f ${whereClause}`, params);
    const total = countRow.total;
    const totalPages = Math.ceil(total / limit) || 1;

    // 数据查询
    const sql = `SELECT f.id, f.original_name, f.file_type, f.size, f.is_public, f.created_at, f.updated_at, f.share_key, f.category_id, f.uploaded_by, f.is_bundle, f.entry_path, f.view_count, f.template_id,
      (SELECT COUNT(*) FROM file_versions WHERE file_id = f.id) AS version_count
    FROM files f ${whereClause} ORDER BY f.${sort} ${order} LIMIT ? OFFSET ?`;
    const files = await dbAll(sql, [...params, limit, offset]);

    const fileIdStr = files.length ? files.map(f => f.id).join(',') : '0';

    // 批量获取标签
    const tagRows = await dbAll(
      `SELECT ft.file_id, t.id AS tag_id, t.name AS tag_name FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.file_id IN (${fileIdStr})`
    );
    const tagsMap = {};
    tagRows.forEach(r => {
      if (!tagsMap[r.file_id]) tagsMap[r.file_id] = [];
      tagsMap[r.file_id].push({ id: r.tag_id, name: r.tag_name });
    });

    // 批量获取收藏状态
    let starredSet = new Set();
    if (userId) {
      const starRows = await dbAll(
        `SELECT file_id FROM starred_files WHERE user_id = ? AND file_id IN (${fileIdStr})`, [userId]
      );
      starredSet = new Set(starRows.map(r => r.file_id));
    }

    // 批量获取分类名称
    const catMap = {};
    if (files.some(f => f.category_id)) {
      const catRows = await dbAll('SELECT id, name FROM categories');
      catRows.forEach(c => { catMap[c.id] = c.name; });
    }

    const result = files.map(f => ({
      ...f,
      tags: tagsMap[f.id] || [],
      starred: starredSet.has(f.id),
      category_name: f.category_id ? (catMap[f.category_id] || null) : null,
    }));

    res.json({
      files: result,
      pagination: { page, limit, total, totalPages }
    });
  } catch (e) {
    res.status(500).json({ error: '获取文件列表失败' });
  }
});

// --- 全文搜索 ---
app.get('/api/files/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: '搜索关键词不能为空' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const userId = req.userId;
  const role = req.userRole;

  const ftsQuery = escapeFtsQuery(q);
  if (!ftsQuery) return res.json({ files: [], pagination: { page, limit, total: 0, totalPages: 0 } });

  try {
    let permClause = '';
    const permParams = [];
    if (role !== 'admin') {
      permClause = 'AND (f.uploaded_by = ? OR f.is_public = 1)';
      permParams.push(userId);
    }

    const countRow = await dbGet(
      `SELECT COUNT(*) AS total FROM files f JOIN file_contents_fts fts ON f.id = fts.file_id WHERE fts.content MATCH ? ${permClause}`,
      [ftsQuery, ...permParams]
    );
    const total = countRow.total;
    const totalPages = Math.ceil(total / limit) || 1;

    const files = await dbAll(
      `SELECT f.id, f.original_name, f.file_type, f.size, f.is_public, f.created_at, f.updated_at, f.share_key, f.category_id, f.uploaded_by, f.is_bundle, f.entry_path, f.view_count,
        (SELECT COUNT(*) FROM file_versions WHERE file_id = f.id) AS version_count,
        snippet(file_contents_fts, 0, '<mark>', '</mark>', '...', 32) AS snippet
      FROM files f JOIN file_contents_fts fts ON f.id = fts.file_id
      WHERE fts.content MATCH ? ${permClause}
      ORDER BY f.updated_at DESC LIMIT ? OFFSET ?`,
      [ftsQuery, ...permParams, limit, offset]
    );

    // 同时按文件名匹配（LIKE），合并去重
    let nameFiles = [];
    const likeQ = `%${q}%`;
    if (role !== 'admin') {
      nameFiles = await dbAll(
        `SELECT f.id, f.original_name, f.file_type, f.size, f.is_public, f.created_at, f.updated_at, f.share_key, f.category_id, f.uploaded_by, f.is_bundle, f.entry_path, f.view_count,
          (SELECT COUNT(*) FROM file_versions WHERE file_id = f.id) AS version_count
        FROM files f WHERE f.original_name LIKE ? AND (f.uploaded_by = ? OR f.is_public = 1)
        ORDER BY f.updated_at DESC`,
        [likeQ, userId]
      );
    } else {
      nameFiles = await dbAll(
        `SELECT f.id, f.original_name, f.file_type, f.size, f.is_public, f.created_at, f.updated_at, f.share_key, f.category_id, f.uploaded_by, f.is_bundle, f.entry_path, f.view_count,
          (SELECT COUNT(*) FROM file_versions WHERE file_id = f.id) AS version_count
        FROM files f WHERE f.original_name LIKE ?
        ORDER BY f.updated_at DESC`,
        [likeQ]
      );
    }

    const ftsIds = new Set(files.map(f => f.id));
    const extraNameFiles = nameFiles.filter(f => !ftsIds.has(f.id)).map(f => ({ ...f, snippet: null }));
    const allFiles = [...files, ...extraNameFiles];

    const fileIdStr = allFiles.length ? allFiles.map(f => f.id).join(',') : '0';

    const tagRows = await dbAll(
      `SELECT ft.file_id, t.id AS tag_id, t.name AS tag_name FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.file_id IN (${fileIdStr})`
    );
    const tagsMap = {};
    tagRows.forEach(r => {
      if (!tagsMap[r.file_id]) tagsMap[r.file_id] = [];
      tagsMap[r.file_id].push({ id: r.tag_id, name: r.tag_name });
    });

    let starredSet = new Set();
    if (userId) {
      const starRows = await dbAll(
        `SELECT file_id FROM starred_files WHERE user_id = ? AND file_id IN (${fileIdStr})`, [userId]
      );
      starredSet = new Set(starRows.map(r => r.file_id));
    }

    const catMap = {};
    if (allFiles.some(f => f.category_id)) {
      const catRows = await dbAll('SELECT id, name FROM categories');
      catRows.forEach(c => { catMap[c.id] = c.name; });
    }

    const result = allFiles.map(f => ({
      ...f,
      tags: tagsMap[f.id] || [],
      starred: starredSet.has(f.id),
      category_name: f.category_id ? (catMap[f.category_id] || null) : null,
    }));

    const realTotal = countRow.total + extraNameFiles.length;
    res.json({
      files: result,
      query: q,
      pagination: { page, limit, total: realTotal, totalPages: Math.ceil(realTotal / limit) || 1 }
    });
  } catch (e) {
    res.status(500).json({ error: '搜索失败' });
  }
});

app.post('/api/files/upload', requireAuth, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  req.file.originalname = decodeFilename(req.file.originalname);
  const ext = path.extname(req.file.originalname).toLowerCase();
  // ZIP 处理
  if (ext === '.zip') {
    return handleZipUpload(req, res, await fs.promises.readFile(req.file.path));
  }
  let fileType = 'html';
  if (ext === '.md' || ext === '.markdown') fileType = 'markdown';
  const isPublic = req.body.isPublic === 'true' || req.body.isPublic === true;
  try {
    // 检查同名文件
    const existing = await dbGet(
      'SELECT id, stored_name, size, uploaded_by, file_type FROM files WHERE original_name = ?',
      [req.file.originalname]
    );

    if (existing) {
      // 同名文件：校验文件类型
      if (existing.file_type !== fileType) {
        // 类型不匹配，清理已上传的文件，拒绝覆盖
        await unlinkQuiet(path.join(UPLOAD_DIR, req.file.filename));
        return res.status(400).json({ error: '文件类型不匹配' });
      }

      // 计算版本号
      const verRow = await dbGet(
        'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
        [existing.id]
      );
      const nextVer = verRow.nextVer;

      // 备份当前版本到 file_versions
      await dbRun(
        'INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
        [existing.id, nextVer, existing.stored_name, existing.size, existing.uploaded_by]
      );

      // 更新 files 主记录（新文件已由 multer 写入磁盘）
      await dbRun(
        'UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?',
        [req.file.filename, req.file.size, now(), existing.id]
      );

      // FTS 索引同步
      if (isFtsIndexable(fileType, req.file.filename)) {
        indexFileContent(existing.id, req.file.filename);
      }

      const shareKey = await dbGet('SELECT share_key FROM files WHERE id = ?', [existing.id]).then(r => r?.share_key);
      logger.audit('file.overwrite', { fileId: existing.id, fileName: req.file.originalname, version: nextVer + 1, fileType, size: req.file.size, ip: clientIp(req) });
      return res.json({
        id: existing.id,
        overwritten: true,
        version: nextVer + 1,
        original_name: req.file.originalname,
        file_type: fileType,
        size: req.file.size,
        is_public: existing.is_public,
        share_key: shareKey
      });
    }

    // 不存在同名文件：新建
    const result = await dbRun(
      'INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by, share_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.file.originalname, req.file.filename, fileType, req.file.size, isPublic ? 1 : 0, currentUserId(req), generateShareKey(), now()]
    );
    // FTS 索引同步
    if (isFtsIndexable(fileType, req.file.filename)) {
      indexFileContent(result.lastID, req.file.filename);
    }
    const shareKey = await dbGet('SELECT share_key FROM files WHERE id = ?', [result.lastID]).then(r => r?.share_key);
    logger.audit('file.upload', { fileId: result.lastID, fileName: req.file.originalname, fileType, size: req.file.size, ip: clientIp(req) });
    res.json({
      id: result.lastID,
      original_name: req.file.originalname,
      file_type: fileType,
      size: req.file.size,
      is_public: isPublic ? 1 : 0,
      share_key: shareKey
    });
  } catch (e) {
    res.status(500).json({ error: '保存文件记录失败' });
  }
});

app.post('/api/files/upload-json', requireAuth, uploadLimiter, async (req, res) => {
  const { name, content, isPublic } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: '文件名不能为空' });
  if (typeof content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });
  const decoded = decodeFilename(name.trim());
  const ext = path.extname(decoded).toLowerCase();
  const allowed = ['.html', '.htm', '.md', '.markdown'];
  if (!allowed.includes(ext)) return res.status(400).json({ error: '仅支持 HTML 和 Markdown 文件' });
  const size = Buffer.byteLength(content, 'utf-8');
  if (size > 50 * 1024 * 1024) return res.status(400).json({ error: '文件大小超过50MB限制' });
  const fileType = (ext === '.md' || ext === '.markdown') ? 'markdown' : 'html';
  const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
  const storedName = unique + ext;
  const filePath = path.join(UPLOAD_DIR, storedName);
  try {
    await fs.promises.writeFile(filePath, content, 'utf-8');
  } catch (e) {
    logger.error({ type: 'app', message: '写入文件失败', error: e.message });
    return res.status(500).json({ error: '写入文件失败' });
  }

  // 检查同名文件
  const existing = await dbGet(
    'SELECT id, stored_name, size, uploaded_by, file_type, is_public, share_key FROM files WHERE original_name = ?',
    [decoded]
  ).catch(() => null);

  if (existing) {
    // 同名文件：校验文件类型
    if (existing.file_type !== fileType) {
      await unlinkQuiet(filePath);
      return res.status(400).json({ error: '文件类型不匹配' });
    }

    try {
      // 计算版本号
      const verRow = await dbGet(
        'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
        [existing.id]
      );
      const nextVer = verRow.nextVer;

      // 备份当前版本到 file_versions
      await dbRun(
        'INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
        [existing.id, nextVer, existing.stored_name, existing.size, existing.uploaded_by]
      );

      // 更新 files 主记录
      await dbRun(
        'UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?',
        [storedName, size, now(), existing.id]
      );

      // FTS 索引同步
      if (isFtsIndexable(fileType, storedName)) {
        indexFileContent(existing.id, storedName);
      }

      logger.audit('file.overwrite', { fileId: existing.id, fileName: decoded, version: nextVer + 1, fileType, size, ip: clientIp(req) });
      return res.json({
        id: existing.id,
        overwritten: true,
        version: nextVer + 1,
        original_name: decoded,
        file_type: fileType,
        size,
        is_public: existing.is_public,
        share_key: existing.share_key
      });
    } catch (e) {
      await unlinkQuiet(filePath);
      return res.status(500).json({ error: '覆盖上传失败' });
    }
  }

  // 不存在同名文件：新建
  const isPublicFlag = isPublic === false ? 0 : 1;
  try {
    const result = await dbRun(
      'INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by, share_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [decoded, storedName, fileType, size, isPublicFlag, currentUserId(req), generateShareKey(), now()]
    );
    // FTS 索引同步
    if (isFtsIndexable(fileType, storedName)) {
      indexFileContent(result.lastID, storedName);
    }
    const shareKey = await dbGet('SELECT share_key FROM files WHERE id = ?', [result.lastID]).then(r => r?.share_key);
    logger.audit('file.upload', { fileId: result.lastID, fileName: decoded, fileType, size, ip: clientIp(req) });
    res.json({
      id: result.lastID,
      original_name: decoded,
      file_type: fileType,
      size,
      is_public: isPublicFlag,
      share_key: shareKey
    });
  } catch (e) {
    await unlinkQuiet(filePath);
    res.status(500).json({ error: '保存文件记录失败' });
  }
});

app.put('/api/files/:id', requireAuth, async (req, res) => {
  const { name, isPublic, templateId } = req.body || {};
  if (name === undefined && isPublic === undefined && templateId === undefined) {
    return res.status(400).json({ error: '无更新字段' });
  }
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (!checkFileOwnership(req, file)) return res.status(403).json({ error: '无权操作此文件' });
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: '文件名不能为空' });
      await dbRun('UPDATE files SET original_name = ? WHERE id = ?', [name.trim(), req.params.id]);
    }
    if (isPublic !== undefined) {
      await dbRun('UPDATE files SET is_public = ? WHERE id = ?', [isPublic ? 1 : 0, req.params.id]);
    }
    if (templateId !== undefined) {
      const tid = templateId ? parseInt(templateId) : null;
      if (tid) {
        const tpl = await dbGet('SELECT id FROM templates WHERE id = ?', [tid]);
        if (!tpl) return res.status(400).json({ error: '模板不存在' });
      }
      await dbRun('UPDATE files SET template_id = ? WHERE id = ?', [tid, req.params.id]);
    }
    logger.audit('file.update', { fileId: req.params.id, changes: { name, isPublic, templateId }, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '更新失败' });
  }
});

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (!checkFileOwnership(req, file)) return res.status(403).json({ error: '无权操作此文件' });

    // 清理关联数据
    await dbRun('DELETE FROM file_tags WHERE file_id = ?', [req.params.id]);
    await dbRun('DELETE FROM starred_files WHERE file_id = ?', [req.params.id]);
    await deleteFileIndex(req.params.id);

    // 清理版本记录及对应磁盘文件
    const versions = await dbAll('SELECT stored_name FROM file_versions WHERE file_id = ?', [req.params.id]);
    for (const v of versions) {
      const p = path.join(UPLOAD_DIR, v.stored_name);
      if (fs.existsSync(p)) await unlinkQuiet(p);
    }
    await dbRun('DELETE FROM file_versions WHERE file_id = ?', [req.params.id]);

    // 删除主文件
    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (fs.existsSync(filePath)) await unlinkQuiet(filePath);
    await dbRun('DELETE FROM files WHERE id = ?', [req.params.id]);
    logger.audit('file.delete', { fileId: req.params.id, fileName: file.original_name, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败' });
  }
});

// --- 批量操作 ---
app.post('/api/files/batch', requireAuth, async (req, res) => {
  try {
    const { action, ids, data } = req.body;
    if (!action || !Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: '缺少 action 或 ids 参数' });
    }
    if (ids.length > 200) return res.status(400).json({ error: '单次最多操作 200 个文件' });
    const validActions = ['delete', 'setPublic', 'setPrivate', 'setCategory'];
    if (!validActions.includes(action)) return res.status(400).json({ error: '不支持的操作: ' + action });

    const placeholders = ids.map(() => '?').join(',');
    const files = await dbAll(`SELECT * FROM files WHERE id IN (${placeholders})`, ids);
    if (!files.length) return res.json({ success: true, affected: 0 });
    for (const f of files) {
      if (!checkFileOwnership(req, f)) return res.status(403).json({ error: '无权操作部分文件' });
    }

    const fileIds = files.map(f => f.id);
    const idPlaceholders = fileIds.map(() => '?').join(',');

    if (action === 'delete') {
      await dbRun('BEGIN');
      try {
        await dbRun(`DELETE FROM file_tags WHERE file_id IN (${idPlaceholders})`, fileIds);
        await dbRun(`DELETE FROM starred_files WHERE file_id IN (${idPlaceholders})`, fileIds);
        const versions = await dbAll(`SELECT stored_name FROM file_versions WHERE file_id IN (${idPlaceholders})`, fileIds);
        for (const v of versions) {
          await unlinkQuiet(path.join(UPLOAD_DIR, v.stored_name));
        }
        await dbRun(`DELETE FROM file_versions WHERE file_id IN (${idPlaceholders})`, fileIds);
        for (const f of files) {
          await unlinkQuiet(path.join(UPLOAD_DIR, f.stored_name));
        }
        await dbRun(`DELETE FROM files WHERE id IN (${idPlaceholders})`, fileIds);
        await dbRun('COMMIT');
      } catch (e) {
        await dbRun('ROLLBACK');
        throw e;
      }
      logger.audit('file.batchDelete', { count: fileIds.length, ip: clientIp(req) });
    } else if (action === 'setPublic' || action === 'setPrivate') {
      const isPublic = action === 'setPublic' ? 1 : 0;
      await dbRun(`UPDATE files SET is_public = ? WHERE id IN (${idPlaceholders})`, [isPublic, ...fileIds]);
      logger.audit('file.batchSetPrivacy', { action, count: fileIds.length, ip: clientIp(req) });
    } else if (action === 'setCategory') {
      const categoryId = data && data.categoryId ? data.categoryId : null;
      await dbRun(`UPDATE files SET category_id = ? WHERE id IN (${idPlaceholders})`, [categoryId, ...fileIds]);
      logger.audit('file.batchSetCategory', { categoryId, count: fileIds.length, ip: clientIp(req) });
    }

    res.json({ success: true, affected: fileIds.length });
  } catch (e) {
    logger.error({ type: 'app', action: 'file.batch', error: e.message });
    res.status(500).json({ error: '批量操作失败' });
  }
});

app.get('/api/files/:id/content', loadFileWithPrivacy, async (req, res) => {
  const file = req.fileRecord;
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件已丢失' });
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    res.json({
      id: file.id,
      original_name: file.original_name,
      file_type: file.file_type,
      is_public: file.is_public,
      uploaded_by: file.uploaded_by,
      is_bundle: file.is_bundle,
      template_id: file.template_id,
      content
    });
  } catch (e) {
    res.status(500).json({ error: '读取文件失败' });
  }
});

async function renderFile(res, file) {
  // Bundle 渲染
  if (file.is_bundle) {
    const bundleDir = path.join(UPLOAD_DIR, file.stored_name);
    const entryPath = path.join(bundleDir, file.entry_path || 'index.html');
    const resolved = path.resolve(entryPath);
    const resolvedDir = path.resolve(bundleDir) + path.sep;
    if (!resolved.startsWith(resolvedDir)) return res.status(403).json({ error: '非法路径' });
    if (!fs.existsSync(entryPath)) return res.status(404).json({ error: '入口文件已丢失' });
    try {
      let content = await fs.promises.readFile(entryPath, 'utf-8');
      // 注入 <base> 标签使相对路径指向资源端点
      const baseTag = '<base href="/api/files/' + file.id + '/asset/">';
      if (/<head>/i.test(content)) {
        content = content.replace(/<head>/i, '<head>\n' + baseTag);
      } else if (/<html/i.test(content)) {
        content = content.replace(/<html[^>]*>/i, '$&\n<head>' + baseTag + '</head>');
      }
      // 注入 charset
      if (!/<meta[^>]+charset=/i.test(content)) {
        const charsetTag = '<meta charset="UTF-8">';
        if (/<head>/i.test(content)) {
          content = content.replace(/<head>/i, '<head>\n' + charsetTag);
        } else {
          content = charsetTag + '\n' + content;
        }
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(content);
    } catch (e) {
      return res.status(500).json({ error: '渲染失败' });
    }
  }
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件已丢失' });
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');

    if (file.file_type === 'markdown') {
      const html = marked.parse(content, { gfm: true, breaks: false })
        .replace(/<pre><code class="hljs language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
          (_, code) => `<pre class="mermaid">${code}</pre>`);
      const tplName = await getTemplateForFile(file);
      const tpl = templateCache[tplName] || templateCache['default'];
      const hljsTheme = BUILTIN_TEMPLATE_THEMES[tplName] || 'github';
      const fullHtml = applyTemplate(tpl, file.original_name, html, hljsTheme);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(fullHtml);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const hasCharset = /<meta[^>]+charset=/i.test(content);
    if (!hasCharset) {
      const injected = '<meta charset="UTF-8">';
      if (/<head>/i.test(content)) {
        res.send(content.replace(/<head>/i, '<head>\n' + injected));
      } else if (/<html/i.test(content)) {
        res.send(content.replace(/<html[^>]*>/i, '$&\n<head>' + injected + '</head>'));
      } else {
        res.send('<meta charset="UTF-8">\n' + content);
      }
    } else {
      res.send(content);
    }
  } catch (e) {
    res.status(500).json({ error: '渲染失败' });
  }
}

// Bundle 资源文件服务
app.get('/api/files/:id/asset/*', loadFileWithPrivacy, async (req, res) => {
  const file = req.fileRecord;
  if (!file.is_bundle) return res.status(400).json({ error: '非网站包' });
  const bundleDir = path.resolve(path.join(UPLOAD_DIR, file.stored_name));
  const assetRelative = req.params[0];
  const assetPath = path.resolve(path.join(bundleDir, assetRelative));
  if (!assetPath.startsWith(bundleDir + path.sep) && assetPath !== bundleDir) {
    return res.status(403).json({ error: '非法路径' });
  }
  if (!fs.existsSync(assetPath)) return res.status(404).json({ error: '资源不存在' });
  try {
    const stat = await fs.promises.stat(assetPath);
    if (stat.isDirectory()) return res.status(404).json({ error: '资源不存在' });
  } catch {
    return res.status(404).json({ error: '资源不存在' });
  }
  res.sendFile(assetPath);
});

app.get('/api/files/:id/render', loadFileWithPrivacy, async (req, res) => {
  await renderFile(res, req.fileRecord);
});

app.get('/api/files/:id/download', loadFileWithPrivacy, async (req, res) => {
  const file = req.fileRecord;
  if (file.is_bundle) {
    const bundleDir = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(bundleDir)) return res.status(404).json({ error: '文件已丢失' });
    const encoded = encodeURIComponent(file.original_name);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encoded + '"; filename*=UTF-8\'\'' + encoded);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.directory(bundleDir, false);
    archive.on('end', () => res.end());
    archive.pipe(res);
    return archive.finalize().catch(e => {
      logger.error({ type: 'app', message: 'bundle 打包失败', error: e.message });
      if (!res.headersSent) res.status(500).json({ error: '打包失败' });
    });
  }
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件已丢失' });
  const encoded = encodeURIComponent(file.original_name);
  res.setHeader('Content-Disposition', 'attachment; filename="' + encoded + '"; filename*=UTF-8\'\'' + encoded);
  res.sendFile(filePath);
});

// --- 覆盖上传端点（预览页专用） ---

app.post('/api/files/:id/overwrite', requireAuth, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  req.file.originalname = decodeFilename(req.file.originalname);
  const ext = path.extname(req.file.originalname).toLowerCase();
  let fileType = 'html';
  if (ext === '.md' || ext === '.markdown') fileType = 'markdown';

  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    // 校验文件类型
    if (file.file_type !== fileType) {
      await unlinkQuiet(path.join(UPLOAD_DIR, req.file.filename));
      return res.status(400).json({ error: '文件类型不匹配' });
    }

    // 计算版本号
    const verRow = await dbGet(
      'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
      [file.id]
    );
    const nextVer = verRow.nextVer;

    // 备份当前版本
    await dbRun(
      'INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
      [file.id, nextVer, file.stored_name, file.size, file.uploaded_by]
    );

    // 更新 files 主记录
    await dbRun(
      'UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?',
      [req.file.filename, req.file.size, now(), file.id]
    );

    // FTS 索引同步
    if (isFtsIndexable(fileType, req.file.filename)) {
      indexFileContent(file.id, req.file.filename);
    }

    logger.audit('file.overwrite', { fileId: file.id, fileName: file.original_name, version: nextVer + 1, fileType, size: req.file.size, ip: clientIp(req) });
    res.json({
      id: file.id,
      overwritten: true,
      version: nextVer + 1,
      original_name: file.original_name,
      file_type: fileType,
      size: req.file.size,
      is_public: file.is_public,
      share_key: file.share_key
    });
  } catch (e) {
    res.status(500).json({ error: '覆盖上传失败' });
  }
});

app.post('/api/files/:id/overwrite-json', requireAuth, uploadLimiter, async (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });

  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const size = Buffer.byteLength(content, 'utf-8');
    if (size > 50 * 1024 * 1024) return res.status(400).json({ error: '文件大小超过50MB限制' });

    const ext = file.file_type === 'markdown' ? '.md' : '.html';
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const storedName = unique + ext;
    const filePath = path.join(UPLOAD_DIR, storedName);

    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
    } catch (e) {
      logger.error({ type: 'app', message: '写入文件失败', error: e.message });
      return res.status(500).json({ error: '写入文件失败' });
    }

    // 计算版本号
    const verRow = await dbGet(
      'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
      [file.id]
    );
    const nextVer = verRow.nextVer;

    // 备份当前版本
    await dbRun(
      'INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
      [file.id, nextVer, file.stored_name, file.size, file.uploaded_by]
    );

    // 更新 files 主记录
    await dbRun(
      'UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?',
      [storedName, size, now(), file.id]
    );

    // FTS 索引同步
    if (isFtsIndexable(file.file_type, storedName)) {
      indexFileContent(file.id, storedName);
    }

    logger.audit('file.overwrite', { fileId: file.id, fileName: file.original_name, version: nextVer + 1, fileType: file.file_type, size, ip: clientIp(req) });
    res.json({
      id: file.id,
      overwritten: true,
      version: nextVer + 1,
      original_name: file.original_name,
      file_type: file.file_type,
      size,
      is_public: file.is_public,
      share_key: file.share_key
    });
  } catch (e) {
    if (storedName) { await unlinkQuiet(path.join(UPLOAD_DIR, storedName)); }
    res.status(500).json({ error: '覆盖上传失败' });
  }
});

// --- 版本 CRUD API ---

// 列出版本历史
app.get('/api/files/:id/versions', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT id, size, updated_at FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const versions = await dbAll(
      'SELECT id, version, size, created_at FROM file_versions WHERE file_id = ? ORDER BY version DESC',
      [req.params.id]
    );

    res.json({
      file_id: file.id,
      current: { size: file.size, updated_at: file.updated_at },
      versions
    });
  } catch (e) {
    res.status(500).json({ error: '获取版本列表失败' });
  }
});

// 获取历史版本原文
app.get('/api/files/:id/versions/:ver/content', requireAuth, async (req, res) => {
  try {
    const ver = await dbGet(
      'SELECT * FROM file_versions WHERE file_id = ? AND version = ?',
      [req.params.id, req.params.ver]
    );
    if (!ver) return res.status(404).json({ error: '版本不存在' });

    const filePath = path.join(UPLOAD_DIR, ver.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '版本文件已丢失' });

    const file = await dbGet('SELECT original_name, file_type FROM files WHERE id = ?', [req.params.id]);
    const content = await fs.promises.readFile(filePath, 'utf-8');
    res.json({
      id: parseInt(req.params.id),
      version: ver.version,
      original_name: file?.original_name,
      file_type: file?.file_type,
      content
    });
  } catch (e) {
    res.status(500).json({ error: '读取版本内容失败' });
  }
});

// 渲染历史版本
app.get('/api/files/:id/versions/:ver/render', requireAuth, async (req, res) => {
  try {
    const ver = await dbGet(
      'SELECT * FROM file_versions WHERE file_id = ? AND version = ?',
      [req.params.id, req.params.ver]
    );
    if (!ver) return res.status(404).json({ error: '版本不存在' });

    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    // 构造一个 file-like 对象，使用历史版本的 stored_name
    const versionFile = { ...file, stored_name: ver.stored_name };
    await renderFile(res, versionFile);
  } catch (e) {
    res.status(500).json({ error: '渲染版本失败' });
  }
});

// 恢复到指定版本
app.post('/api/files/:id/versions/:ver/restore', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const targetVer = await dbGet(
      'SELECT * FROM file_versions WHERE file_id = ? AND version = ?',
      [req.params.id, req.params.ver]
    );
    if (!targetVer) return res.status(404).json({ error: '版本不存在' });

    // 读取目标版本文件内容
    const targetPath = path.join(UPLOAD_DIR, targetVer.stored_name);
    if (!fs.existsSync(targetPath)) return res.status(404).json({ error: '版本文件已丢失' });
    const targetContent = await fs.promises.readFile(targetPath, 'utf-8');

    // 复制到新磁盘文件
    const ext = file.file_type === 'markdown' ? '.md' : '.html';
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const newStoredName = unique + ext;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, newStoredName), targetContent, 'utf-8');

    // 当前版本备份到 file_versions
    const verRow = await dbGet(
      'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
      [file.id]
    );
    const nextVer = verRow.nextVer;
    await dbRun(
      'INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
      [file.id, nextVer, file.stored_name, file.size, currentUserId(req)]
    );

    // 更新 files 主记录
    const newSize = Buffer.byteLength(targetContent, 'utf-8');
    await dbRun(
      'UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?',
      [newStoredName, newSize, now(), file.id]
    );

    logger.audit('file.restore', { fileId: file.id, fileName: file.original_name, restoredVersion: parseInt(req.params.ver), newVersion: nextVer + 1, ip: clientIp(req) });
    res.json({
      success: true,
      id: file.id,
      version: nextVer + 1,
      restored_from: parseInt(req.params.ver),
      size: newSize
    });
  } catch (e) {
    if (newStoredName) { await unlinkQuiet(path.join(UPLOAD_DIR, newStoredName)); }
    res.status(500).json({ error: '恢复版本失败' });
  }
});

// 删除指定历史版本
app.delete('/api/files/:id/versions/:ver', requireAuth, async (req, res) => {
  try {
    const ver = await dbGet(
      'SELECT * FROM file_versions WHERE file_id = ? AND version = ?',
      [req.params.id, req.params.ver]
    );
    if (!ver) return res.status(404).json({ error: '版本不存在' });

    // 删除磁盘文件
    const filePath = path.join(UPLOAD_DIR, ver.stored_name);
    if (fs.existsSync(filePath)) await unlinkQuiet(filePath);

    // 删除版本记录
    await dbRun('DELETE FROM file_versions WHERE id = ?', [ver.id]);

    logger.audit('file.version.delete', { fileId: parseInt(req.params.id), version: parseInt(req.params.ver), ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '删除版本失败' });
  }
});

// --- 标签管理 ---

app.get('/api/tags', requireAuth, async (req, res) => {
  try {
    const tags = await dbAll(`
      SELECT t.id, t.name, t.created_at, COUNT(ft.file_id) AS file_count
      FROM tags t LEFT JOIN file_tags ft ON t.id = ft.tag_id
      GROUP BY t.id ORDER BY t.name ASC
    `);
    res.json({ tags });
  } catch (e) {
    res.status(500).json({ error: '获取标签失败' });
  }
});

app.post('/api/tags', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '标签名不能为空' });
  try {
    const existing = await dbGet('SELECT id, name, created_at FROM tags WHERE name = ?', [name.trim()]);
    if (existing) return res.json(existing);
    const result = await dbRun('INSERT INTO tags (name) VALUES (?)', [name.trim()]);
    res.json({ id: result.lastID, name: name.trim() });
    logger.audit('tag.create', { tagId: result.lastID, tagName: name.trim(), ip: clientIp(req) });
  } catch (e) {
    res.status(500).json({ error: '创建标签失败' });
  }
});

app.delete('/api/tags/:id', requireAuth, async (req, res) => {
  try {
    const tag = await dbGet('SELECT id FROM tags WHERE id = ?', [req.params.id]);
    if (!tag) return res.status(404).json({ error: '标签不存在' });
    await dbRun('DELETE FROM file_tags WHERE tag_id = ?', [req.params.id]);
    await dbRun('DELETE FROM tags WHERE id = ?', [req.params.id]);
    res.json({ success: true });
    logger.audit('tag.delete', { tagId: req.params.id, ip: clientIp(req) });
  } catch (e) {
    res.status(500).json({ error: '删除标签失败' });
  }
});

app.put('/api/files/:id/tags', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT id FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (!checkFileOwnership(req, file)) return res.status(403).json({ error: '无权操作此文件' });
    const { tagIds } = req.body || {};
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: 'tagIds 必须是数组' });
    await dbRun('DELETE FROM file_tags WHERE file_id = ?', [req.params.id]);
    for (const tid of tagIds) {
      await dbRun('INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)', [req.params.id, tid]);
    }
    res.json({ success: true });
    logger.audit('file.updateTags', { fileId: req.params.id, tagIds, ip: clientIp(req) });
  } catch (e) {
    res.status(500).json({ error: '更新标签失败' });
  }
});

// --- 收藏管理 ---

app.post('/api/files/:id/star', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT id FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    await dbRun('INSERT OR IGNORE INTO starred_files (user_id, file_id) VALUES (?, ?)', [req.userId, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '收藏失败' });
  }
});

app.delete('/api/files/:id/star', requireAuth, async (req, res) => {
  try {
    await dbRun('DELETE FROM starred_files WHERE user_id = ? AND file_id = ?', [req.userId, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '取消收藏失败' });
  }
});

app.get('/api/templates', requireAuth, async (req, res) => {
  try {
    const templates = await dbAll('SELECT * FROM templates ORDER BY is_builtin DESC, name ASC');
    res.json({ templates });
  } catch (e) {
    res.status(500).json({ error: '获取模板列表失败' });
  }
});

app.get('/api/categories', requireAuth, async (req, res) => {
  try {
    const categories = await dbAll(`
      SELECT c.id, c.name, c.created_at, COUNT(f.id) AS file_count
      FROM categories c LEFT JOIN files f ON f.category_id = c.id
      GROUP BY c.id ORDER BY c.created_at ASC
    `);
    res.json({ categories });
  } catch (e) {
    res.status(500).json({ error: '获取分类失败' });
  }
});

app.post('/api/categories', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '分类名不能为空' });
  try {
    const existing = await dbGet('SELECT id, name, created_at FROM categories WHERE name = ?', [name.trim()]);
    if (existing) return res.json(existing);
    const result = await dbRun('INSERT INTO categories (name, user_id) VALUES (?, ?)', [name.trim(), req.userId]);
    logger.audit('category.create', { categoryId: result.lastID, name: name.trim(), ip: clientIp(req) });
    res.json({ id: result.lastID, name: name.trim() });
  } catch (e) {
    res.status(500).json({ error: '创建分类失败' });
  }
});

app.put('/api/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '分类名不能为空' });
  try {
    await dbRun('UPDATE categories SET name = ? WHERE id = ?', [name.trim(), req.params.id]);
    logger.audit('category.rename', { categoryId: req.params.id, name: name.trim(), ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '重命名分类失败' });
  }
});

app.delete('/api/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await dbRun('UPDATE files SET category_id = NULL WHERE category_id = ?', [req.params.id]);
    await dbRun('DELETE FROM categories WHERE id = ?', [req.params.id]);
    logger.audit('category.delete', { categoryId: req.params.id, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '删除分类失败' });
  }
});

app.put('/api/files/:id/category', requireAuth, async (req, res) => {
  const { categoryId } = req.body || {};
  try {
    const file = await dbGet('SELECT id, uploaded_by FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (req.userRole !== 'admin' && file.uploaded_by !== req.userId) {
      return res.status(403).json({ error: '无权操作' });
    }
    await dbRun('UPDATE files SET category_id = ? WHERE id = ?', [categoryId || null, req.params.id]);
    logger.audit('file.setCategory', { fileId: parseInt(req.params.id), categoryId: categoryId || null, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '设置分类失败' });
  }
});

// --- 管理员：数据备份与恢复 ---

// 用于 import 的独立 multer 实例（不限文件类型）
const adminUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DATA_DIR),
    filename: (req, file, cb) => cb(null, 'import-' + Date.now() + '.zip')
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
});

function createBackupArchive() {
  const archive = archiver('zip', { zlib: { level: 9 } });
  db.run('PRAGMA wal_checkpoint(FULL)', (err) => {
    if (err) logger.warn({ type: 'app', message: 'WAL checkpoint 失败', error: err.message });
  });
  archive.file(path.join(DATA_DIR, 'database.sqlite'), { name: 'database.sqlite' });
  const sessionFile = path.join(DATA_DIR, 'sessions.sqlite');
  if (fs.existsSync(sessionFile)) archive.file(sessionFile, { name: 'sessions.sqlite' });
  if (fs.existsSync(UPLOAD_DIR)) archive.directory(UPLOAD_DIR, 'uploads');
  return archive;
}

app.get('/api/admin/export', requireAuth, requireAdmin, (req, res) => {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const fname = `jpage-backup-${date}.zip`;
    const encoded = encodeURIComponent(fname);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
    const archive = createBackupArchive();
    archive.on('end', () => res.end());
    archive.pipe(res);
    archive.finalize().catch(e => {
      logger.error({ type: 'app', message: '备份导出失败', error: e.message });
      if (!res.headersSent) res.status(500).json({ error: '导出失败' });
    });
    logger.audit('backup.export', { ip: clientIp(req) });
  } catch (e) {
    res.status(500).json({ error: '导出失败' });
  }
});

app.post('/api/admin/import', requireAuth, requireAdmin, adminUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 ZIP 文件' });
  const zipPath = req.file.path;
  try {
    const zipBuf = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipBuf);
    if (!zip.file('database.sqlite')) {
      fs.unlinkSync(zipPath);
      return res.status(400).json({ error: '无效的备份文件：缺少 database.sqlite' });
    }
    const backupDate = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = path.join(path.dirname(DATA_DIR), `data-backup-${backupDate}`);
    fs.cpSync(DATA_DIR, backupDir, { recursive: true });
    logger.info({ type: 'app', message: '导入前备份已创建', backupDir });
    for (const entry of fs.readdirSync(DATA_DIR)) {
      fs.rmSync(path.join(DATA_DIR, entry), { recursive: true, force: true });
    }
    for (const [relPath, entry] of Object.entries(zip.files)) {
      if (entry.dir) {
        fs.mkdirSync(path.join(DATA_DIR, relPath), { recursive: true });
      } else {
        const buf = await entry.async('nodebuffer');
        const filePath = path.join(DATA_DIR, relPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buf);
      }
    }
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    db.close();
    const newDb = new sqlite3.Database(path.join(DATA_DIR, 'database.sqlite'));
    db.run = newDb.run.bind(newDb);
    db.get = newDb.get.bind(newDb);
    db.all = newDb.all.bind(newDb);
    db.close = newDb.close.bind(newDb);
    logger.audit('backup.import', { ip: clientIp(req), backupDir });
    res.json({ success: true, message: '数据已恢复，建议刷新页面重新加载' });
  } catch (e) {
    logger.error({ type: 'app', message: '数据导入失败', error: e.message });
    res.status(500).json({ error: '导入失败: ' + e.message });
  } finally {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  }
});

app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const fileCount = await dbGet('SELECT COUNT(*) AS c FROM files');
    let dbSize = 0;
    const dbPath = path.join(DATA_DIR, 'database.sqlite');
    if (fs.existsSync(dbPath)) dbSize = fs.statSync(dbPath).size;
    let uploadsSize = 0;
    if (fs.existsSync(UPLOAD_DIR)) {
      for (const f of fs.readdirSync(UPLOAD_DIR)) {
        const s = fs.statSync(path.join(UPLOAD_DIR, f));
        if (s.isFile()) uploadsSize += s.size;
      }
    }
    res.json({ fileCount: fileCount.c, dbSize, uploadsSize, totalSize: dbSize + uploadsSize });
  } catch (e) {
    res.status(500).json({ error: '获取统计失败' });
  }
});

app.get('/api/skills', requireAuth, async (req, res) => {
  try {
    res.json({ skills: listSkills() });
  } catch (e) {
    logger.error({ type: 'app', message: '列出 skills 失败', error: e.message });
    res.status(500).json({ error: '列出 skills 失败' });
  }
});

app.get('/api/skills/:name', requireAuth, async (req, res) => {
  const skill = getSkill(req.params.name);
  if (!skill) return res.status(404).json({ error: 'Skill 不存在' });
  if (skill.installBody) {
    skill.installHtml = marked.parse(skill.installBody, { gfm: true, breaks: false });
  }
  res.json(skill);
});

app.get('/api/mcp/config', requireAuth, async (req, res) => {
  const enabled = !!process.env.MCP_TOKEN || true; // 现在总是可以用用户级 Token
  const host = req.headers.host || `localhost:${PORT}`;
  const protocol = req.protocol || 'http';
  const url = `${protocol}://${host}/mcp`;

  // 获取当前用户的 Token 列表
  const tokens = await dbAll(
    'SELECT id, name, token_prefix, created_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC',
    [req.userId]
  );

  const globalToken = process.env.MCP_TOKEN && req.userRole === 'admin' ? process.env.MCP_TOKEN : null;

  res.json({
    enabled,
    globalToken,
    url,
    tokens,
    config: {
      mcpServers: {
        jpage: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${globalToken || '<YOUR_TOKEN>'}` }
        }
      }
    }
  });
});

app.get('/api/skills/:name/download', requireAuth, (req, res) => {
  const archive = createZipStream(req.params.name);
  if (!archive) return res.status(404).json({ error: 'Skill 不存在' });
  const fname = `${req.params.name}.zip`;
  const encoded = encodeURIComponent(fname);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  archive.on('end', () => res.end());
  archive.pipe(res);
  archive.finalize().catch(e => {
    logger.error({ type: 'app', message: 'archiver finalize 失败', error: e.message });
    if (!res.headersSent) res.status(500).json({ error: '打包失败' });
  });
});

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

const NODE_MODULES = path.join(__dirname, 'node_modules');
app.use('/vendor/katex', express.static(path.join(NODE_MODULES, 'katex', 'dist')));
app.use('/vendor/highlight.js', express.static(path.join(NODE_MODULES, 'highlight.js')));
app.use('/vendor/mermaid', express.static(path.join(NODE_MODULES, 'mermaid', 'dist')));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/s/:key', async (req, res) => {
  try {
    const file = await dbGet('SELECT * FROM files WHERE share_key = ?', [req.params.key]);
    if (!file) return res.status(404).send('<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:sans-serif;text-align:center;padding:4em"><h1>404</h1><p>页面不存在</p><a href="/">返回首页</a></body></html>');
    if (!file.is_public && !currentUserId(req)) return res.redirect('/');
    recordVisit(file, req).catch(() => {});
    await renderFile(res, file);
  } catch (e) {
    res.status(500).json({ error: '渲染失败' });
  }
});

async function recordVisit(file, req) {
  const ip = clientIp(req);
  const ipHash = crypto.createHash('sha256').update(ip + process.env.SESSION_SECRET).digest('hex').slice(0, 16);
  const ua = (req.headers['user-agent'] || '').slice(0, 200);
  const recent = await dbGet(
    "SELECT id FROM link_visits WHERE file_id = ? AND ip_hash = ? AND visited_at > datetime('now','-5 minutes') LIMIT 1",
    [file.id, ipHash]
  );
  if (recent) return;
  await dbRun(db,
    'INSERT INTO link_visits (file_id, share_key, ip_hash, user_agent) VALUES (?, ?, ?, ?)',
    [file.id, file.share_key, ipHash, ua]
  );
  await dbRun(db, 'UPDATE files SET view_count = view_count + 1 WHERE id = ?', [file.id]);
}

// --- 访问统计 API ---
app.get('/api/files/:id/stats', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT id, uploaded_by, view_count FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (req.userRole !== 'admin' && file.uploaded_by !== req.userId) {
      return res.status(403).json({ error: '无权访问' });
    }
    const [daily7, daily30] = await Promise.all([
      dbAll(db,
        "SELECT date(visited_at) as date, COUNT(*) as count FROM link_visits WHERE file_id = ? AND visited_at > datetime('now','-7 days') GROUP BY date(visited_at) ORDER BY date",
        [file.id]
      ),
      dbAll(db,
        "SELECT date(visited_at) as date, COUNT(*) as count FROM link_visits WHERE file_id = ? AND visited_at > datetime('now','-30 days') GROUP BY date(visited_at) ORDER BY date",
        [file.id]
      )
    ]);
    res.json({ viewCount: file.view_count || 0, daily7, daily30 });
  } catch (e) {
    res.status(500).json({ error: '获取统计失败' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  logger.error({ type: 'app', message: err.message, stack: err.stack });
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '文件大小超过50MB限制' });
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

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

app.listen(PORT, async () => {
  const mcpIp = process.env.MCP_IP || 'localhost';
  await runMigrations(db);
  loadTemplates();
  await loadTemplateNameMap();
  await backfillFtsIndex();
  logger.info({ type: 'app', message: '服务已启动', url: `http://${mcpIp}:${PORT}` });
  if (sessionSecretWarning) logger.warn({ type: 'app', message: 'SESSION_SECRET 未设置，已生成临时密钥（重启后会话会失效）' });
  await bootstrapAdmin();
  try {
    const row = await dbGet('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    if (row) adminUserId = row.id;
  } catch (e) {
    logger.error({ type: 'app', message: '解析 admin user id 失败', error: e.message });
  }

  // 自动定时备份
  const backupCron = process.env.BACKUP_CRON;
  if (backupCron) {
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
    await closeMcpTransports();
    process.exit(0);
  });
}
