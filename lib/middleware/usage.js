// API 调用用量采集中间件。
// 挂在 /api 路由之前，对所有 API 请求（含未登录，如登录接口）无侵入地记录：
//   - 已认证用户：写入 api_calls 明细 + users.api_calls_count +1
//   - 未认证：直接放行，不记录
//
// 来源判定：优先取 X-Upload-Source 请求头（CLI / MCP / utools 已注入），
// 缺失时回退 'web'（网页 session 或 API Token 未标头时）。

const { dbRun } = require('../db');
const { resolveUploadSource } = require('../util');

const UPLOAD_SOURCES = new Set(['web', 'cli', 'mcp', 'utools']);

/**
 * 根据请求方法和路径推断一个友好的 action 名称（用于明细分析，不保证唯一）。
 */
function inferAction(req) {
  const path = req.originalUrl || req.path || '';
  const method = (req.method || 'GET').toUpperCase();

  if (path.includes('/upload')) return 'file.upload';
  if (path.includes('/overwrite')) return 'file.overwrite';
  if (path.includes('/versions') && path.includes('/restore')) return 'file.restore';
  if (path.includes('/versions') && method === 'DELETE') return 'file.version.delete';
  if (path.includes('/batch')) return 'file.batch';
  if (method === 'DELETE' && /\/api\/files\/[^/]+$/.test(path)) return 'file.delete';
  if (method === 'PUT' && /\/api\/files\/[^/]+$/.test(path)) return 'file.update';
  if (path.startsWith('/api/files')) return 'file.read';
  if (path.startsWith('/api/auth')) return 'auth';
  if (path.startsWith('/api/admin')) return 'admin';
  if (path.startsWith('/api/content-templates')) return 'content_template';
  return 'api.call';
}

function recordUsage(req, res, next) {
  // 在响应完成后再检查 req.userId：此时后续路由的鉴权中间件已填充用户信息。
  // 未登录接口（登录/注册/健康检查）在 finish 回调里会被自然跳过。
  res.on('finish', () => {
    if (!req.userId) return;
    const source = resolveUploadSource(req);
    const action = inferAction(req);
    const method = req.method || 'GET';
    const path = req.originalUrl || req.path || '';
    const status = res.statusCode || 0;

    // 明细：忽略写入失败，不能影响响应
    dbRun(
      'INSERT INTO api_calls (user_id, source, action, method, path, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.userId, source, action, method, path, status]
    ).catch(() => {});

    // 聚合计数缓存
    dbRun(
      'UPDATE users SET api_calls_count = COALESCE(api_calls_count, 0) + 1 WHERE id = ?',
      [req.userId]
    ).catch(() => {});
  });

  next();
}

module.exports = { recordUsage, UPLOAD_SOURCES };
