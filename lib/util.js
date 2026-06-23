// 通用工具函数：纯逻辑或仅依赖标准库/Express 请求对象，无 DB/全局状态耦合。
// 从 server.js 提取，行为保持不变。

const crypto = require('crypto');
const fs = require('fs');

// --- UTC 时间工具 ---
// 统一存 UTC：与 SQLite 的 CURRENT_TIMESTAMP / datetime('now') 一致，
// 避免跨时区部署时的时间偏差。展示层（前端）负责转本地时区。
// 比原 toLocaleString(Asia/Shanghai) 快约一个数量级。
function now() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// --- 异步文件清理 ---
function unlinkQuiet(p) { return fs.promises.unlink(p).catch(() => {}); }

// 8 位短链 key（base64url，去 padding）
function generateShareKey() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

// 取客户端 IP（优先信任反代的 X-Forwarded-For，配合 app.set('trust proxy', 1)）
function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.socket?.remoteAddress || '-';
}

// 当前用户 id：优先中间件写入的 req.userId，回退到 session
function currentUserId(req) {
  return req.userId || (req.session && req.session.userId) || null;
}

// 解析上传来源：读取 X-Upload-Source 请求头，白名单校验，缺失/非法回退 'web'。
// CLI / MCP 客户端在各自请求层注入该头；网页上传不发头，自然落到 'web'。
const UPLOAD_SOURCES = ['web', 'cli', 'mcp'];
function resolveUploadSource(req) {
  const raw = req && req.headers && req.headers['x-upload-source'];
  return UPLOAD_SOURCES.includes(raw) ? raw : 'web';
}

// multer 上传的中文文件名解码：部分客户端用 latin1 传输 UTF-8 文件名，
// 这里还原成原始 UTF-8。已包含非 latin1 字符则视为已正确解码。
function decodeFilename(name) {
  if (!name) return name;
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 255) return name;
  }
  const buf = Buffer.from(name, 'latin1');
  const decoded = buf.toString('utf8');
  if (Buffer.from(decoded).equals(buf)) return decoded;
  return name;
}

// 生成可读随机密码（去掉易混字符 0/O/1/l/I）
function generateReadablePassword(length) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let pwd = '';
  for (let i = 0; i < length; i++) {
    pwd += chars[bytes[i] % chars.length];
  }
  return pwd;
}

module.exports = {
  now,
  unlinkQuiet,
  generateShareKey,
  clientIp,
  currentUserId,
  resolveUploadSource,
  decodeFilename,
  generateReadablePassword,
};
