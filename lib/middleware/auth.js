// 认证与授权中间件：requireAuth（Session / Bearer Token / MCP_TOKEN）+ requireAdmin。
// 从 server.js 提取，行为保持不变。

const crypto = require('crypto');
const { dbGet, dbRun } = require('../db');
const { now } = require('../util');
const { getAdminUserId } = require('../auth-state');

// 软认证：尽力解析 Session/Bearer Token 并填充 req.userId / req.userRole，
// 但不拒绝匿名请求。用于「允许匿名访问公开内容、同时让登录用户/admin 访问受限内容」
// 的端点（详情 / 渲染 / 下载 / 资源 / 短链）。
// 与 requireAuth 共用解析逻辑，仅在未通过认证时不返回 401 而是放行。
async function loadSession(req, res, next) {
  // Session 路径
  if (req.session && req.session.userId) {
    req.userId = req.session.userId;
    if (req.session.userRole) {
      req.userRole = req.session.userRole;
    } else {
      const user = await dbGet('SELECT role FROM users WHERE id = ?', [req.session.userId]);
      if (user) {
        req.session.userRole = user.role;
        req.userRole = user.role;
      }
    }
    return next();
  }

  // Bearer Token 路径（与 requireAuth 一致，成功才填充）
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const tokenValue = auth.slice(7);
    const adminUserId = getAdminUserId();
    if (process.env.MCP_TOKEN && tokenValue === process.env.MCP_TOKEN && adminUserId) {
      req.userId = adminUserId;
      const admin = await dbGet('SELECT role FROM users WHERE id = ?', [adminUserId]);
      req.userRole = admin ? admin.role : 'admin';
      return next();
    }
    const hash = crypto.createHash('sha256').update(tokenValue).digest('hex');
    const tokenRow = await dbGet(
      'SELECT t.user_id, u.role FROM tokens t JOIN users u ON t.user_id = u.id WHERE t.token_hash = ?',
      [hash]
    );
    if (tokenRow) {
      dbRun('UPDATE tokens SET last_used_at = ? WHERE token_hash = ?', [now(), hash]).catch(() => {});
      req.userId = tokenRow.user_id;
      req.userRole = tokenRow.role;
      return next();
    }
  }

  // 未通过认证：放行（由下游中间件如 loadFileWithPrivacy 决定是否拒绝）
  return next();
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
    const adminUserId = getAdminUserId();
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

module.exports = { loadSession, requireAuth, requireAdmin };
