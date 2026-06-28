// 认证与授权中间件：requireAuth（Session / Bearer Token / MCP_TOKEN）+ requireAdmin + requireTokenAuth。
// 从 server.js 提取，行为保持不变。

const crypto = require('crypto');
const { dbGet, dbRun } = require('../db');
const { now } = require('../util');
const { getAdminUserId } = require('../auth-state');

function hashPrefix(tokenValue, len = 16) {
  return crypto.createHash('sha256').update(tokenValue).digest('hex').slice(0, len);
}

// 软认证：尽力解析 Session/Bearer Token 并填充 req.userId / req.userRole，
// 但不拒绝匿名请求。用于「允许匿名访问公开内容、同时让登录用户/admin 访问受限内容」
// 的端点（详情 / 渲染 / 下载 / 资源 / 短链）。
// 与 requireAuth 共用解析逻辑，仅在未通过认证时不返回 401 而是放行。
async function loadSession(req, res, next) {
  // Session 路径
  if (req.session && req.session.userId) {
    req.userId = req.session.userId;
    req.tokenSource = 'web';
    req.tokenPrefix = 'session';
    req.tokenHashPrefix = 'session';
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
      req.tokenSource = 'mcp';
      req.tokenPrefix = 'mcp';
      req.tokenHashPrefix = hashPrefix(tokenValue);
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
      const source = req.get('x-upload-source');
      req.tokenSource = source === 'mcp' ? 'mcp' : (source === 'cli' ? 'cli' : 'api');
      req.tokenPrefix = tokenRow.token_prefix || tokenValue.slice(0, 12);
      req.tokenHashPrefix = hashPrefix(tokenValue);
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
    req.tokenSource = 'web';
    req.tokenPrefix = 'session';
    req.tokenHashPrefix = 'session';
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
      req.tokenSource = 'mcp';
      req.tokenPrefix = 'mcp';
      req.tokenHashPrefix = hashPrefix(tokenValue);
      const admin = await dbGet('SELECT role FROM users WHERE id = ?', [adminUserId]);
      req.userRole = admin ? admin.role : 'admin';
      return next();
    }

    // 2. 用户级 Token 查询
    const hash = crypto.createHash('sha256').update(tokenValue).digest('hex');
    const tokenRow = await dbGet(
      'SELECT t.user_id, t.token_prefix, u.role FROM tokens t JOIN users u ON t.user_id = u.id WHERE t.token_hash = ?',
      [hash]
    );
    if (tokenRow) {
      dbRun('UPDATE tokens SET last_used_at = ? WHERE token_hash = ?', [now(), hash]).catch(() => {});
      req.tokenUserId = tokenRow.user_id;
      req.userId = tokenRow.user_id;
      req.userRole = tokenRow.role;
      const source = req.get('x-upload-source');
      req.tokenSource = source === 'mcp' ? 'mcp' : (source === 'cli' ? 'cli' : 'api');
      req.tokenPrefix = tokenRow.token_prefix || tokenValue.slice(0, 12);
      req.tokenHashPrefix = hashPrefix(tokenValue);
      return next();
    }
  }

  return res.status(401).json({ error: '未登录' });
}

function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// 必须使用 Token（MCP_TOKEN 或用户级 jp_...）调用，禁止纯 Session Cookie。
// 内容模板「使用/实例化」等需要与系统 Token 绑定的端点使用。
function requireTokenAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: '未登录' });
  if (req.tokenSource === 'web') {
    return res.status(403).json({ error: '请使用 API Token 通过 CLI 或 MCP 使用模板' });
  }
  next();
}

module.exports = { loadSession, requireAuth, requireAdmin, requireTokenAuth };
