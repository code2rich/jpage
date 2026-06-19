// 认证与授权中间件：requireAuth（Session / Bearer Token / MCP_TOKEN）+ requireAdmin。
// 从 server.js 提取，行为保持不变。

const crypto = require('crypto');
const { dbGet, dbRun } = require('../db');
const { now } = require('../util');
const { getAdminUserId } = require('../auth-state');

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

module.exports = { requireAuth, requireAdmin };
