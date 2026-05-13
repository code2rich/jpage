const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const { marked } = require('marked');

const app = express();
const PORT = process.env.PORT || 3000;
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: '上传请求过于频繁，请稍后再试' }
});

function decodeFilename(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
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

app.get('/api/files', async (req, res) => {
  try {
    const files = await dbAll('SELECT id, original_name, file_type, size, created_at FROM files ORDER BY created_at DESC');
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: '获取文件列表失败' });
  }
});

app.post('/api/files/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  req.file.originalname = decodeFilename(req.file.originalname);
  const ext = path.extname(req.file.originalname).toLowerCase();
  let fileType = 'html';
  if (ext === '.md' || ext === '.markdown') fileType = 'markdown';
  try {
    const result = await dbRun('INSERT INTO files (original_name, stored_name, file_type, size) VALUES (?, ?, ?, ?)',
      [req.file.originalname, req.file.filename, fileType, req.file.size]);
    res.json({ id: result.lastID, original_name: req.file.originalname, file_type: fileType, size: req.file.size });
  } catch (e) {
    res.status(500).json({ error: '保存文件记录失败' });
  }
});

app.delete('/api/files/:id', async (req, res) => {
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

app.put('/api/files/:id/rename', async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length === 0) return res.status(400).json({ error: '文件名不能为空' });
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    await dbRun('UPDATE files SET original_name = ? WHERE id = ?', [name.trim(), req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '重命名失败' });
  }
});

app.get('/api/files/:id/content', async (req, res) => {
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件已丢失' });
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ id: file.id, original_name: file.original_name, file_type: file.file_type, content });
  } catch (e) {
    res.status(500).json({ error: '读取文件失败' });
  }
});

app.get('/api/files/:id/render', async (req, res) => {
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件已丢失' });
    const content = fs.readFileSync(filePath, 'utf-8');

    if (file.file_type === 'markdown') {
      const html = marked(content, { headerIds: false, mangle: false });
      const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${file.original_name}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; line-height: 1.7; color: #333; background: #fff; }
h1, h2, h3, h4 { color: #222; margin-top: 1.5em; margin-bottom: 0.6em; }
pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; }
code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #ddd; margin: 0; padding-left: 16px; color: #666; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
th { background: #f6f8fa; }
img { max-width: 100%; height: auto; }
a { color: #0366d6; text-decoration: none; }
a:hover { text-decoration: underline; }
</style>
</head>
<body>${html}</body>
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

app.get('/api/files/:id/download', async (req, res) => {
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件已丢失' });
    res.download(filePath, file.original_name);
  } catch (e) {
    res.status(500).json({ error: '下载失败' });
  }
});

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

app.listen(PORT, () => {
  console.log(`[即页] 服务已启动: http://localhost:${PORT}`);
});
