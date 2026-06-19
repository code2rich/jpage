// 内容模板市场路由。从 server.js 提取，行为保持不变。
// 挂载点：/api/content-templates

const express = require('express');
const { dbGet, dbRun, dbAll } = require('../lib/db');
const { requireAuth } = require('../lib/middleware/auth');
const { clientIp } = require('../lib/util');
const logger = require('../logger');

const router = express.Router();

const CONTENT_TEMPLATE_MAX_SIZE = 512000; // 500KB
const CONTENT_TEMPLATE_SCENES = ['dashboard', 'report', 'resume', 'landing', 'note', 'presentation', 'card', 'email', 'other'];

// 公开模板列表（无需登录）
router.get('/public', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 8));
    const offset = (page - 1) * limit;
    const { scene } = req.query;

    const conditions = ['ct.is_public = 1'];
    const params = [];
    if (scene) { conditions.push('ct.scene = ?'); params.push(scene); }
    const where = 'WHERE ' + conditions.join(' AND ');

    const total = await dbGet(`SELECT COUNT(*) as count FROM content_templates ct ${where}`, params);
    const templates = await dbAll(
      `SELECT ct.id, ct.title, ct.description, ct.file_type, ct.scene, ct.style_tags, ct.use_count
       FROM content_templates ct
       ${where} ORDER BY ct.use_count DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json({
      templates,
      pagination: { page, limit, total: total.count, totalPages: Math.ceil(total.count / limit) }
    });
  } catch (e) {
    logger.error({ type: 'app', msg: '获取公开模板列表失败', error: e.message });
    res.status(500).json({ error: '获取模板列表失败' });
  }
});

// 公开模板预览（无需登录）
router.get('/public/:id/preview', async (req, res) => {
  try {
    const t = await dbGet(
      'SELECT id, title, file_type, content FROM content_templates WHERE id = ? AND is_public = 1',
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '模板不存在' });
    res.json({ id: t.id, title: t.title, file_type: t.file_type, content: t.content });
  } catch (e) {
    res.status(500).json({ error: '获取模板预览失败' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;
    const { scene, keyword, fileType, sort } = req.query;

    const conditions = [];
    const params = [];
    if (req.userRole !== 'admin') {
      conditions.push('(ct.is_public = 1 OR ct.uploaded_by = ?)');
      params.push(req.userId);
    }
    if (scene) { conditions.push('ct.scene = ?'); params.push(scene); }
    if (fileType) { conditions.push('ct.file_type = ?'); params.push(fileType); }
    if (keyword) {
      conditions.push('(ct.title LIKE ? OR ct.description LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const orderBy = sort === 'created_at' ? 'ct.created_at DESC' : 'ct.use_count DESC';

    const total = await dbGet(`SELECT COUNT(*) as count FROM content_templates ct ${where}`, params);
    const templates = await dbAll(
      `SELECT ct.id, ct.title, ct.description, ct.file_type, ct.scene, ct.style_tags,
              ct.uploaded_by, ct.use_count, ct.is_public, ct.created_at, ct.updated_at,
              u.username as uploader_name
       FROM content_templates ct LEFT JOIN users u ON ct.uploaded_by = u.id
       ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json({
      templates,
      pagination: { page, limit, total: total.count, totalPages: Math.ceil(total.count / limit) }
    });
  } catch (e) {
    logger.error({ type: 'app', msg: '获取内容模板列表失败', error: e.message });
    res.status(500).json({ error: '获取内容模板列表失败' });
  }
});

router.get('/scenes', requireAuth, async (req, res) => {
  res.json({ scenes: CONTENT_TEMPLATE_SCENES });
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const t = await dbGet(
      `SELECT ct.id, ct.title, ct.description, ct.file_type, ct.scene, ct.style_tags,
              ct.uploaded_by, ct.use_count, ct.is_public, ct.created_at, ct.updated_at,
              u.username as uploader_name
       FROM content_templates ct LEFT JOIN users u ON ct.uploaded_by = u.id
       WHERE ct.id = ?`, [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '模板不存在' });
    if (!t.is_public && req.userRole !== 'admin' && t.uploaded_by !== req.userId) {
      return res.status(403).json({ error: '无权访问' });
    }
    res.json(t);
  } catch (e) {
    res.status(500).json({ error: '获取模板详情失败' });
  }
});

router.get('/:id/content', requireAuth, async (req, res) => {
  try {
    const t = await dbGet('SELECT id, title, file_type, content, is_public, uploaded_by FROM content_templates WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    if (!t.is_public && req.userRole !== 'admin' && t.uploaded_by !== req.userId) {
      return res.status(403).json({ error: '无权访问' });
    }
    res.json({ id: t.id, title: t.title, file_type: t.file_type, content: t.content });
  } catch (e) {
    res.status(500).json({ error: '获取模板内容失败' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  const { title, description, fileType, scene, styleTags, content, isPublic } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: '模板标题不能为空' });
  if (!content) return res.status(400).json({ error: '样例内容不能为空' });
  if (Buffer.byteLength(content, 'utf-8') > CONTENT_TEMPLATE_MAX_SIZE) {
    return res.status(400).json({ error: '样例内容不能超过 500KB' });
  }
  const ft = fileType || 'html';
  if (ft !== 'html' && ft !== 'markdown') return res.status(400).json({ error: '文件类型仅支持 html 或 markdown' });
  try {
    const result = await dbRun(
      `INSERT INTO content_templates (title, description, file_type, scene, style_tags, content, uploaded_by, is_public) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [title.trim(), description || null, ft, scene || null, styleTags || null, content, req.userId, isPublic !== false ? 1 : 0]
    );
    logger.audit('content_template.create', { templateId: result.lastID, title: title.trim(), scene, ip: clientIp(req) });
    res.json({ id: result.lastID, title: title.trim() });
  } catch (e) {
    logger.error({ type: 'app', msg: '创建内容模板失败', error: e.message });
    res.status(500).json({ error: '创建内容模板失败' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const t = await dbGet('SELECT id, uploaded_by FROM content_templates WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    if (req.userRole !== 'admin' && t.uploaded_by !== req.userId) return res.status(403).json({ error: '无权操作' });

    const { title, description, scene, styleTags, content, isPublic } = req.body || {};
    const sets = [];
    const params = [];
    if (title !== undefined) { sets.push('title = ?'); params.push(title.trim()); }
    if (description !== undefined) { sets.push('description = ?'); params.push(description); }
    if (scene !== undefined) { sets.push('scene = ?'); params.push(scene); }
    if (styleTags !== undefined) { sets.push('style_tags = ?'); params.push(styleTags); }
    if (content !== undefined) {
      if (Buffer.byteLength(content, 'utf-8') > CONTENT_TEMPLATE_MAX_SIZE) {
        return res.status(400).json({ error: '样例内容不能超过 500KB' });
      }
      sets.push('content = ?'); params.push(content);
    }
    if (isPublic !== undefined) { sets.push('is_public = ?'); params.push(isPublic ? 1 : 0); }
    if (sets.length === 0) return res.json({ success: true });

    sets.push("updated_at = datetime('now')");
    params.push(req.params.id);
    await dbRun(`UPDATE content_templates SET ${sets.join(', ')} WHERE id = ?`, params);
    logger.audit('content_template.update', { templateId: parseInt(req.params.id), ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    logger.error({ type: 'app', msg: '更新内容模板失败', error: e.message });
    res.status(500).json({ error: '更新内容模板失败' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const t = await dbGet('SELECT id, uploaded_by FROM content_templates WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    if (req.userRole !== 'admin' && t.uploaded_by !== req.userId) return res.status(403).json({ error: '无权操作' });
    await dbRun('DELETE FROM content_templates WHERE id = ?', [req.params.id]);
    logger.audit('content_template.delete', { templateId: parseInt(req.params.id), ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    logger.error({ type: 'app', msg: '删除内容模板失败', error: e.message });
    res.status(500).json({ error: '删除内容模板失败' });
  }
});

router.post('/:id/use', requireAuth, async (req, res) => {
  try {
    await dbRun('UPDATE content_templates SET use_count = use_count + 1 WHERE id = ?', [req.params.id]);
    const t = await dbGet('SELECT use_count FROM content_templates WHERE id = ?', [req.params.id]);
    res.json({ success: true, use_count: t ? t.use_count : 0 });
  } catch (e) {
    res.status(500).json({ error: '记录使用失败' });
  }
});

module.exports = router;
