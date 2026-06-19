// 分类 + 模板元数据路由。从 server.js 提取，行为保持不变。
// 挂载点：/api（内部路径 /categories、/categories/:id、/templates）
// 注：/api/files/:id/category 归 routes/files.js（同为 /api/files 前缀）。

const express = require('express');
const { dbAll, dbGet, dbRun } = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/middleware/auth');
const { clientIp } = require('../lib/util');
const { reloadCategoryNameCache } = require('../lib/categories');
const logger = require('../logger');

const router = express.Router();

// --- 模板列表（渲染样式模板，区别于内容模板市场 content-templates）---
router.get('/templates', requireAuth, async (req, res) => {
  try {
    const templates = await dbAll('SELECT * FROM templates ORDER BY is_builtin DESC, name ASC');
    res.json({ templates });
  } catch (e) {
    res.status(500).json({ error: '获取模板列表失败' });
  }
});

// --- 分类管理 ---

router.get('/categories', requireAuth, async (req, res) => {
  try {
    const role = req.userRole;
    const userId = req.userId;
    let categories;
    if (role === 'admin') {
      categories = await dbAll(`
        SELECT c.id, c.name, c.created_at, COUNT(f.id) AS file_count
        FROM categories c LEFT JOIN files f ON f.category_id = c.id
        GROUP BY c.id ORDER BY c.created_at ASC
      `);
    } else {
      categories = await dbAll(`
        SELECT c.id, c.name, c.created_at, COUNT(f.id) AS file_count
        FROM categories c LEFT JOIN files f ON f.category_id = c.id AND f.uploaded_by = ?
        GROUP BY c.id ORDER BY c.created_at ASC
      `, [userId]);
    }
    res.json({ categories });
  } catch (e) {
    res.status(500).json({ error: '获取分类失败' });
  }
});

router.post('/categories', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '分类名不能为空' });
  try {
    const existing = await dbGet('SELECT id, name, created_at FROM categories WHERE name = ?', [name.trim()]);
    if (existing) return res.json(existing);
    const result = await dbRun('INSERT INTO categories (name, user_id) VALUES (?, ?)', [name.trim(), req.userId]);
    await reloadCategoryNameCache();
    logger.audit('category.create', { categoryId: result.lastID, name: name.trim(), ip: clientIp(req) });
    res.json({ id: result.lastID, name: name.trim() });
  } catch (e) {
    res.status(500).json({ error: '创建分类失败' });
  }
});

router.put('/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '分类名不能为空' });
  try {
    await dbRun('UPDATE categories SET name = ? WHERE id = ?', [name.trim(), req.params.id]);
    await reloadCategoryNameCache();
    logger.audit('category.rename', { categoryId: req.params.id, name: name.trim(), ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '重命名分类失败' });
  }
});

router.delete('/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await dbRun('UPDATE files SET category_id = NULL WHERE category_id = ?', [req.params.id]);
    await dbRun('DELETE FROM categories WHERE id = ?', [req.params.id]);
    await reloadCategoryNameCache();
    logger.audit('category.delete', { categoryId: req.params.id, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '删除分类失败' });
  }
});

module.exports = router;
