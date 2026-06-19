// view_count 内存累加 + 批量 flush。
// 短链 /s/:key 是热点写路径。把 UPDATE files SET view_count 累积到内存，
// 定时（30s）或进程退出时批量回写，减少每访问一次就一次写。
// 从 server.js 提取，行为保持不变。

const crypto = require('crypto');
const { dbRun, dbGet } = require('./db');
const { clientIp } = require('./util');

const VIEW_COUNT_BUFFER = new Map(); // fileId -> pending increments
const VIEW_COUNT_FLUSH_MS = 30000;
let viewCountFlushTimer = null;

async function flushViewCounts() {
  if (!VIEW_COUNT_BUFFER.size) return;
  const entries = [...VIEW_COUNT_BUFFER.entries()];
  VIEW_COUNT_BUFFER.clear();
  for (const [fileId, n] of entries) {
    await dbRun('UPDATE files SET view_count = view_count + ? WHERE id = ?', [n, fileId]).catch(() => {});
  }
}

function getPendingViewCount(fileId) {
  return VIEW_COUNT_BUFFER.get(fileId) || 0;
}

function bufferViewCount(fileId) {
  VIEW_COUNT_BUFFER.set(fileId, (VIEW_COUNT_BUFFER.get(fileId) || 0) + 1);
}

function scheduleViewCountFlush() {
  if (viewCountFlushTimer) return;
  viewCountFlushTimer = setInterval(flushViewCounts, VIEW_COUNT_FLUSH_MS);
  if (typeof viewCountFlushTimer.unref === 'function') viewCountFlushTimer.unref();
}

async function recordVisit(file, req) {
  const ip = clientIp(req);
  const ipHash = crypto.createHash('sha256').update(ip + process.env.SESSION_SECRET).digest('hex').slice(0, 16);
  const ua = (req.headers['user-agent'] || '').slice(0, 200);
  const recent = await dbGet(
    "SELECT id FROM link_visits WHERE file_id = ? AND ip_hash = ? AND visited_at > datetime('now','-5 minutes') LIMIT 1",
    [file.id, ipHash]
  );
  if (recent) return;
  await dbRun(
    'INSERT INTO link_visits (file_id, share_key, ip_hash, user_agent) VALUES (?, ?, ?, ?)',
    [file.id, file.share_key, ipHash, ua]
  );
  bufferViewCount(file.id);
}

module.exports = {
  flushViewCounts,
  getPendingViewCount,
  bufferViewCount,
  scheduleViewCountFlush,
  recordVisit,
};
