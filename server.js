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
const { marked } = require('marked');
const { markedHighlight } = require('marked-highlight');
const hljs = require('highlight.js');
const katex = require('katex');
const { mountMcpServer, closeMcpTransports } = require('./mcp-server');
const { listSkills, getSkill, createZipStream } = require('./skills-registry');

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

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_public INTEGER NOT NULL DEFAULT 1,
    uploaded_by INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.all(`PRAGMA table_info(files)`, (err, cols) => {
    if (err) return;
    const names = new Set(cols.map(c => c.name));
    if (!names.has('is_public')) {
      db.run(`ALTER TABLE files ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1`);
    }
    if (!names.has('uploaded_by')) {
      db.run(`ALTER TABLE files ADD COLUMN uploaded_by INTEGER`);
    }
  });
});

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

let sessionSecret = process.env.SESSION_SECRET;
let sessionSecretWarning = false;
if (!sessionSecret) {
  if (NODE_ENV === 'production') {
    console.error('[即页] 错误：生产模式下必须设置 SESSION_SECRET');
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
    sameSite: 'strict',
    secure: 'auto',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (process.env.MCP_TOKEN && adminUserId) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ') && auth.slice(7) === process.env.MCP_TOKEN) {
      req.session.userId = adminUserId;
      return next();
    }
  }
  return res.status(401).json({ error: '未登录' });
}

function loadFileWithPrivacy(req, res, next) {
  dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]).then(file => {
    if (!file) return res.status(404).json({ error: '文件不存在' });
    const effectiveUserId = (req.session && req.session.userId)
      || (process.env.MCP_TOKEN && adminUserId
        && req.headers.authorization === `Bearer ${process.env.MCP_TOKEN}`
        ? adminUserId
        : null);
    if (!file.is_public && !effectiveUserId) {
      return res.status(401).json({ error: '未登录' });
    }
    req.fileRecord = file;
    next();
  }).catch(() => {
    res.status(500).json({ error: '读取失败' });
  });
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
  return Buffer.from(name, 'latin1').toString('utf8');
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
    const allowed = ['.html', '.htm', '.md', '.markdown'];
    const ext = path.extname(decoded).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('仅支持 HTML 和 Markdown 文件'));
  }
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: '未登录' });
  try {
    const user = await dbGet('SELECT id, username FROM users WHERE id = ?', [req.session.userId]);
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: '未登录' });
    }
    res.json({ username: user.username, isAdmin: true });
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
    if (!ok) return res.status(401).json({ error: '登录失败' });
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ username: user.username, isAdmin: true });
  } catch (e) {
    res.status(500).json({ error: '登录失败' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('jpage.sid');
    res.json({ success: true });
  });
});

app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const files = await dbAll('SELECT id, original_name, file_type, size, is_public, created_at FROM files ORDER BY created_at DESC');
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: '获取文件列表失败' });
  }
});

app.post('/api/files/upload', requireAuth, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  req.file.originalname = decodeFilename(req.file.originalname);
  const ext = path.extname(req.file.originalname).toLowerCase();
  let fileType = 'html';
  if (ext === '.md' || ext === '.markdown') fileType = 'markdown';
  const isPublic = req.body.isPublic === 'true' || req.body.isPublic === true;
  try {
    const result = await dbRun(
      'INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
      [req.file.originalname, req.file.filename, fileType, req.file.size, isPublic ? 1 : 0, req.session.userId]
    );
    res.json({
      id: result.lastID,
      original_name: req.file.originalname,
      file_type: fileType,
      size: req.file.size,
      is_public: isPublic ? 1 : 0
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
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (e) {
    console.error('[即页] 写入文件失败:', e);
    return res.status(500).json({ error: '写入文件失败' });
  }
  const isPublicFlag = isPublic === false ? 0 : 1;
  try {
    const result = await dbRun(
      'INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
      [decoded, storedName, fileType, size, isPublicFlag, req.session.userId]
    );
    res.json({
      id: result.lastID,
      original_name: decoded,
      file_type: fileType,
      size,
      is_public: isPublicFlag
    });
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch {}
    res.status(500).json({ error: '保存文件记录失败' });
  }
});

app.put('/api/files/:id', requireAuth, async (req, res) => {
  const { name, isPublic } = req.body || {};
  if (name === undefined && isPublic === undefined) {
    return res.status(400).json({ error: '无更新字段' });
  }
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: '文件名不能为空' });
      await dbRun('UPDATE files SET original_name = ? WHERE id = ?', [name.trim(), req.params.id]);
    }
    if (isPublic !== undefined) {
      await dbRun('UPDATE files SET is_public = ? WHERE id = ?', [isPublic ? 1 : 0, req.params.id]);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '更新失败' });
  }
});

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await dbRun('DELETE FROM files WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败' });
  }
});

app.get('/api/files/:id/content', loadFileWithPrivacy, async (req, res) => {
  const file = req.fileRecord;
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件已丢失' });
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({
      id: file.id,
      original_name: file.original_name,
      file_type: file.file_type,
      is_public: file.is_public,
      content
    });
  } catch (e) {
    res.status(500).json({ error: '读取文件失败' });
  }
});

app.get('/api/files/:id/render', loadFileWithPrivacy, async (req, res) => {
  const file = req.fileRecord;
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件已丢失' });
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    if (file.file_type === 'markdown') {
      const html = marked.parse(content, { gfm: true, breaks: false })
        .replace(/<pre><code class="hljs language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
          (_, code) => `<pre class="mermaid">${code}</pre>`);
      const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${file.original_name}</title>
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<link rel="stylesheet" href="/vendor/highlight.js/styles/github.min.css" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="/vendor/highlight.js/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
<style>
:root { color-scheme: light dark; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; line-height: 1.7; color: #24292f; background: #ffffff; }
h1, h2, h3, h4 { color: #1f2328; margin-top: 1.5em; margin-bottom: 0.6em; }
pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
code { font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 0.9em; }
:not(pre) > code { background: rgba(175, 184, 193, 0.2); padding: 2px 6px; border-radius: 3px; }
blockquote { border-left: 4px solid #d0d7de; margin: 0; padding-left: 16px; color: #57606a; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #d0d7de; padding: 8px 12px; text-align: left; }
th { background: #f6f8fa; }
img { max-width: 100%; height: auto; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
.katex-display { margin: 1em 0; overflow-x: auto; overflow-y: hidden; }
pre.mermaid { background: #ffffff; color: #1f2328; text-align: center; }
.katex-error { color: #cf222e; background: #ffebe9; padding: 1px 4px; border-radius: 3px; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  h1, h2, h3, h4 { color: #f0f6fc; }
  pre { background: #161b22; }
  blockquote { border-left-color: #3d444d; color: #9198a1; }
  th, td { border-color: #3d444d; }
  th { background: #161b22; }
  a { color: #2f81f7; }
  pre.mermaid { background: #0d1117; color: #e6edf3; }
}
</style>
</head>
<body>${html}
<script src="/vendor/mermaid/mermaid.min.js"></script>
<script>
(function() {
  function initMermaid() {
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    mermaid.initialize({ startOnLoad: true, securityLevel: 'loose', theme: dark ? 'dark' : 'default' });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMermaid);
  } else {
    initMermaid();
  }
})();
</script>
</body>
</html>`;
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
});

app.get('/api/files/:id/download', loadFileWithPrivacy, async (req, res) => {
  const file = req.fileRecord;
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件已丢失' });
  const encoded = encodeURIComponent(file.original_name);
  res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  res.sendFile(filePath);
});

app.get('/api/skills', requireAuth, async (req, res) => {
  try {
    res.json({ skills: listSkills() });
  } catch (e) {
    console.error('[即页] 列出 skills 失败:', e);
    res.status(500).json({ error: '列出 skills 失败' });
  }
});

app.get('/api/skills/:name', requireAuth, async (req, res) => {
  const skill = getSkill(req.params.name);
  if (!skill) return res.status(404).json({ error: 'Skill 不存在' });
  res.json(skill);
});

app.get('/api/mcp/config', requireAuth, (req, res) => {
  const enabled = !!process.env.MCP_TOKEN;
  const host = req.headers.host || `localhost:${PORT}`;
  const protocol = req.protocol || 'http';
  const url = `${protocol}://${host}/mcp`;
  res.json({
    enabled,
    token: enabled ? process.env.MCP_TOKEN : null,
    url,
    config: {
      mcpServers: {
        jpage: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${process.env.MCP_TOKEN || '<YOUR_TOKEN>'}` }
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
    console.error('[即页] archiver finalize 失败:', e);
    if (!res.headersSent) res.status(500).json({ error: '打包失败' });
  });
});

mountMcpServer(app, { port: PORT, mcpToken: process.env.MCP_TOKEN });

const NODE_MODULES = path.join(__dirname, 'node_modules');
app.use('/vendor/katex', express.static(path.join(NODE_MODULES, 'katex', 'dist')));
app.use('/vendor/highlight.js', express.static(path.join(NODE_MODULES, 'highlight.js')));
app.use('/vendor/mermaid', express.static(path.join(NODE_MODULES, 'mermaid', 'dist')));

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
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
        console.warn('[即页] ADMIN_PASSWORD 长度不足 8 位，跳过自动创建');
        console.warn('[即页] 解决方式：设置为 ≥8 位的强密码，或留空以自动生成');
        return;
      }
      adminPass = explicitPass;
    } else {
      adminPass = generateReadablePassword(16);
    }

    const hash = await bcrypt.hash(adminPass, 10);
    await dbRun('INSERT INTO users (username, password_hash) VALUES (?, ?)', [adminUser, hash]);
    console.log(`[即页] 已创建初始管理员: ${adminUser}`);
    if (!explicitPass) {
      console.log(`[即页] 初始密码（请妥善保存）: ${adminPass}`);
      console.log(`[即页] ⚠️  首次登录后请立即修改密码`);
    }
  } catch (e) {
    console.error('[即页] 初始化管理员失败:', e);
  }
}

app.listen(PORT, async () => {
  const mcpIp = process.env.MCP_IP || 'localhost';
  console.log(`[即页] 服务已启动: http://${mcpIp}:${PORT}`);
  if (sessionSecretWarning) console.warn('[即页] SESSION_SECRET 未设置，已生成临时密钥（重启后会话会失效）');
  await bootstrapAdmin();
  try {
    const row = await dbGet('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    if (row) adminUserId = row.id;
  } catch (e) {
    console.error('[即页] 解析 admin user id 失败:', e);
  }
  if (process.env.MCP_TOKEN && !adminUserId) {
    console.warn('[即页] MCP_TOKEN 已设置但 users 表为空，MCP 端点将禁用');
  } else if (process.env.MCP_TOKEN && adminUserId) {
    console.log(`[即页] MCP 端点已启用: http://${mcpIp}:${PORT}/mcp`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`[即页] 收到 ${sig}，正在关闭 MCP transport...`);
    await closeMcpTransports();
    process.exit(0);
  });
}
