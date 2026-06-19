// 用户管理路由（仅 admin）。从 server.js 提取，行为保持不变。
// 挂载点：/api/users

const express = require('express');
const bcrypt = require('bcryptjs');
const { dbAll, dbGet, dbRun } = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/middleware/auth');
const { clientIp } = require('../lib/util');
const logger = require('../logger');

const router = express.Router();

router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await dbAll('SELECT id, username, email, email_verified, role, created_at FROM users ORDER BY id ASC');
    res.json({ users: users.map(u => ({ ...u, emailVerified: !!u.email_verified })) });
  } catch (e) {
    res.status(500).json({ error: '获取用户列表失败' });
  }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, role, email } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length > 30 || username.length < 2 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: '用户名 2-30 位，只能包含字母、数字和下划线' });
  }
  if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
  if (!['admin', 'user'].includes(role || 'user')) return res.status(400).json({ error: '无效角色' });
  if (email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  }
  try {
    // 唯一性检查
    if (email) {
      const emailConflict = await dbGet('SELECT id FROM users WHERE email = ? OR username = ?', [email, email]);
      if (emailConflict) return res.status(409).json({ error: '该邮箱已被使用' });
    }
    const nameConflict = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
    if (nameConflict) return res.status(409).json({ error: '用户名已存在' });

    const hash = await bcrypt.hash(password, 10);
    const result = await dbRun(
      'INSERT INTO users (username, email, email_verified, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      [username, email || null, email ? 1 : 0, hash, role || 'user']
    );
    logger.audit('user.create', { userId: result.lastID, username, email, role: role || 'user', createdBy: req.userId, ip: clientIp(req) });
    res.json({ id: result.lastID, username, email: email || null, role: role || 'user' });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ error: '用户名或邮箱已存在' });
    res.status(500).json({ error: '创建用户失败' });
  }
});

router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: '无效用户 ID' });
  const { role, password, username, email } = req.body || {};
  if (!role && !password && !username && email === undefined) return res.status(400).json({ error: '无更新字段' });
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (username) {
      if (username.length > 30 || username.length < 2 || !/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: '用户名 2-30 位，只能包含字母、数字和下划线' });
      }
      const conflict = await dbGet('SELECT id FROM users WHERE username = ? AND id != ?', [username, targetId]);
      if (conflict) return res.status(409).json({ error: '用户名已存在' });
      await dbRun('UPDATE users SET username = ? WHERE id = ?', [username, targetId]);
    }
    if (email !== undefined) {
      if (email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
        const conflict = await dbGet('SELECT id FROM users WHERE (email = ? OR username = ?) AND id != ?', [email, email, targetId]);
        if (conflict) return res.status(409).json({ error: '该邮箱已被使用' });
        await dbRun('UPDATE users SET email = ?, email_verified = ? WHERE id = ?', [email, 1, targetId]);
      } else {
        await dbRun('UPDATE users SET email = NULL, email_verified = 0 WHERE id = ?', [targetId]);
      }
    }
    if (role) {
      if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: '无效角色' });
      await dbRun('UPDATE users SET role = ? WHERE id = ?', [role, targetId]);
    }
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
      const hash = await bcrypt.hash(password, 10);
      await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [hash, targetId]);
    }
    logger.audit('user.update', { targetUserId: targetId, changes: { role, username, email, password: !!password }, updatedBy: req.userId, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '更新用户失败' });
  }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
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

module.exports = router;
