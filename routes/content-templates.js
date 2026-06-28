// 内容模板市场路由。挂载点：/api/content-templates
//
// 重构后的语义：用户上架 → 管理员审核 → approved+visible 才进市场。
// 分类由 template_market_categories 表驱动（管理员可配置）。
// 旧 scene 概念废弃；旧 is_public 字段保留但不再被市场逻辑依赖。

const express = require('express');
const fs = require('fs');
const path = require('path');
const { dbGet, dbRun, dbAll } = require('../lib/db');
const { requireAuth, requireAdmin, requireTokenAuth, loadSession } = require('../lib/middleware/auth');
const { clientIp, now, generateShareKey } = require('../lib/util');
const { UPLOAD_DIR } = require('../lib/paths');
const { generateStoredName, uploadLimiter } = require('./files/_shared');
const { isFtsIndexable, indexFileContent } = require('../lib/fts');
const { addUserStorage } = require('../lib/usage');
const { renderTemplateContent } = require('../lib/render');
const { marketListerLimiter, marketPreviewLimiter, marketBotFilter, marketRobotsTag } = require('../lib/market-guard');
const logger = require('../logger');

const router = express.Router();

const CONTENT_TEMPLATE_MAX_SIZE = 512000; // 500KB
const FILE_TYPES = ['html', 'markdown'];
const STATUS_VALUES = ['draft', 'pending', 'approved', 'rejected', 'archived'];
const VISIBILITY_VALUES = ['visible', 'hidden'];

// 市场展示条件片段：approved + visible + 分类启用
const MARKET_VISIBLE_COND = `ct.status = 'approved' AND ct.visibility = 'visible' AND COALESCE(c.is_enabled, 0) = 1`;

// 分页参数解析
function parsePaging(req, defaultLimit = 12) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || defaultLimit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// ============================================================
// 公开端点（匿名可访问）—— 市场浏览
// ============================================================

// 公开分类列表（仅启用分类）
router.get('/categories', marketBotFilter, marketListerLimiter, marketRobotsTag, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, slug, name, description FROM template_market_categories
       WHERE is_enabled = 1 ORDER BY sort_order ASC, id ASC`
    );
    res.json({ categories: rows });
  } catch (e) {
    logger.error({ type: 'app', msg: '获取分类列表失败', error: e.message });
    res.status(500).json({ error: '获取分类列表失败' });
  }
});

// 市场首页列表（匿名，登录用户附带收藏状态）
router.get('/market', loadSession, marketBotFilter, marketListerLimiter, marketRobotsTag, async (req, res) => {
  try {
    const { page, limit, offset } = parsePaging(req);
    const { category, keyword, fileType, sort } = req.query;

    const conditions = [MARKET_VISIBLE_COND];
    const params = [];
    if (category) {
      conditions.push('(c.slug = ? OR c.name = ?)');
      params.push(category, category);
    }
    if (fileType) { conditions.push('ct.file_type = ?'); params.push(fileType); }
    if (keyword) {
      conditions.push('(ct.title LIKE ? OR ct.description LIKE ? OR u.username LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    const where = 'WHERE ' + conditions.join(' AND ');

    // 排序：featured 优先，再按 sort_order / use_count / created_at
    let orderBy;
    if (sort === 'created_at') {
      orderBy = 'ct.featured DESC, ct.created_at DESC, ct.sort_order ASC';
    } else if (sort === 'featured') {
      orderBy = 'ct.featured DESC, ct.sort_order ASC, ct.use_count DESC';
    } else {
      orderBy = 'ct.featured DESC, ct.use_count DESC, ct.sort_order ASC';
    }

    const total = await dbGet(
      `SELECT COUNT(*) as count FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       LEFT JOIN users u ON ct.uploaded_by = u.id ${where}`,
      params
    );
    const starSelect = req.userId
      ? '(SELECT 1 FROM starred_templates st WHERE st.user_id = ? AND st.template_id = ct.id) AS starred'
      : '0 AS starred';
    const templates = await dbAll(
      `SELECT ct.id, ct.title, ct.description, ct.file_type, ct.use_count, ct.view_count, ct.featured,
              ct.created_at, ct.published_at, ct.category_id, ct.share_key,
              c.slug AS category_slug, c.name AS category_name,
              u.username AS uploader_name,
              (SELECT COUNT(*) FROM content_template_installs i WHERE i.template_id = ct.id) AS instantiation_count,
              ${starSelect}
       FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       LEFT JOIN users u ON ct.uploaded_by = u.id
       ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      req.userId ? [req.userId, ...params, limit, offset] : [...params, limit, offset]
    );
    res.json({
      templates,
      pagination: { page, limit, total: total.count, totalPages: Math.ceil(total.count / limit) }
    });
  } catch (e) {
    logger.error({ type: 'app', msg: '获取市场模板列表失败', error: e.message });
    res.status(500).json({ error: '获取市场模板列表失败' });
  }
});

// 市场详情（匿名，仅 approved+visible）
// 每次访问详情页，view_count +1，用于在市场展示热度。
router.get('/market/:id', loadSession, marketBotFilter, marketPreviewLimiter, marketRobotsTag, async (req, res) => {
  try {
    await dbRun('UPDATE content_templates SET view_count = view_count + 1 WHERE id = ?', [req.params.id]);
    const t = await dbGet(
      `SELECT ct.id, ct.title, ct.description, ct.file_type, ct.use_count, ct.view_count, ct.featured,
              ct.created_at, ct.published_at, ct.category_id, ct.share_key,
              c.slug AS category_slug, c.name AS category_name,
              u.username AS uploader_name,
              (SELECT COUNT(*) FROM content_template_installs i WHERE i.template_id = ct.id) AS instantiation_count
       FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       LEFT JOIN users u ON ct.uploaded_by = u.id
       WHERE ct.id = ? AND ${MARKET_VISIBLE_COND}`,
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '模板不存在或未上架' });
    // 登录用户附加收藏状态
    let starred = false;
    if (req.userId) {
      const row = await dbGet('SELECT 1 FROM starred_templates WHERE user_id = ? AND template_id = ?', [req.userId, req.params.id]);
      starred = !!row;
    }

    // 同系列推荐：同一分类下其他已上架可见模板
    const related = await dbAll(
      `SELECT ct.id, ct.title, ct.file_type, ct.view_count, ct.featured,
              c.name AS category_name, ct.share_key
       FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       WHERE ct.id != ? AND ct.category_id = ? AND ${MARKET_VISIBLE_COND}
       ORDER BY ct.featured DESC, ct.use_count DESC, ct.created_at DESC
       LIMIT 4`,
      [req.params.id, t.category_id]
    );

    res.json({ ...t, starred, related });
  } catch (e) {
    logger.error({ type: 'app', msg: '获取市场模板详情失败', error: e.message });
    res.status(500).json({ error: '获取模板详情失败' });
  }
});

// 市场预览内容（匿名，用于 iframe 缩略图/详情页）
router.get('/market/:id/preview', loadSession, marketBotFilter, marketPreviewLimiter, marketRobotsTag, async (req, res) => {
  try {
    const t = await dbGet(
      `SELECT ct.id, ct.title, ct.file_type, ct.content
       FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       WHERE ct.id = ? AND ${MARKET_VISIBLE_COND}`,
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '模板不存在或未上架' });
    res.json({ id: t.id, title: t.title, file_type: t.file_type, content: t.content });
  } catch (e) {
    res.status(500).json({ error: '获取模板预览失败' });
  }
});

// 市场预览 HTML（用于 iframe src，避免 srcdoc 继承父页严格 CSP 导致内联脚本被拦截）
router.get('/market/:id/preview-html', loadSession, marketBotFilter, marketPreviewLimiter, marketRobotsTag, async (req, res) => {
  try {
    const t = await dbGet(
      `SELECT ct.title, ct.file_type, ct.content
       FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       WHERE ct.id = ? AND ${MARKET_VISIBLE_COND}`,
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '模板不存在或未上架' });
    return await renderTemplateContent(res, t);
  } catch (e) {
    logger.error({ type: 'app', msg: '获取市场预览 HTML 失败', error: e.message });
    res.status(500).json({ error: '渲染预览失败' });
  }
});

// ============================================================
// 登录用户端点 —— 提交、我的上架、编辑
// ============================================================

// 我的模板列表（所有状态）
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { page, limit, offset } = parsePaging(req);
    const { status } = req.query;

    const conditions = ['ct.uploaded_by = ?'];
    const params = [req.userId];
    if (status && STATUS_VALUES.includes(status)) {
      conditions.push('ct.status = ?');
      params.push(status);
    }
    const where = 'WHERE ' + conditions.join(' AND ');

    const total = await dbGet(`SELECT COUNT(*) as count FROM content_templates ct ${where}`, params);
    const templates = await dbAll(
      `SELECT ct.id, ct.title, ct.description, ct.file_type, ct.status, ct.visibility,
              ct.review_note, ct.use_count, ct.created_at, ct.submitted_at, ct.published_at,
              ct.category_id, ct.source_file_id, c.slug AS category_slug, c.name AS category_name,
              sf.original_name AS source_file_name
       FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       LEFT JOIN files sf ON ct.source_file_id = sf.id
       ${where} ORDER BY ct.created_at DESC, ct.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json({
      templates,
      pagination: { page, limit, total: total.count, totalPages: Math.ceil(total.count / limit) }
    });
  } catch (e) {
    logger.error({ type: 'app', msg: '获取我的模板失败', error: e.message });
    res.status(500).json({ error: '获取我的模板失败' });
  }
});

// 我收藏的模板列表（仅当前登录用户，approved+visible）
router.get('/mine/starred', requireAuth, async (req, res) => {
  try {
    const { page, limit, offset } = parsePaging(req);

    const total = await dbGet(
      `SELECT COUNT(*) as count
       FROM starred_templates st
       JOIN content_templates ct ON st.template_id = ct.id
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       WHERE st.user_id = ? AND ${MARKET_VISIBLE_COND}`,
      [req.userId]
    );
    const templates = await dbAll(
      `SELECT ct.id, ct.title, ct.description, ct.file_type, ct.use_count, ct.featured,
              ct.created_at, ct.published_at, ct.category_id, ct.share_key,
              c.slug AS category_slug, c.name AS category_name,
              u.username AS uploader_name,
              (SELECT COUNT(*) FROM content_template_installs i WHERE i.template_id = ct.id) AS instantiation_count,
              1 AS starred
       FROM starred_templates st
       JOIN content_templates ct ON st.template_id = ct.id
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       LEFT JOIN users u ON ct.uploaded_by = u.id
       WHERE st.user_id = ? AND ${MARKET_VISIBLE_COND}
       ORDER BY st.created_at DESC
       LIMIT ? OFFSET ?`,
      [req.userId, limit, offset]
    );
    res.json({
      templates,
      pagination: { page, limit, total: total.count, totalPages: Math.ceil(total.count / limit) }
    });
  } catch (e) {
    logger.error({ type: 'app', msg: '获取收藏模板失败', error: e.message });
    res.status(500).json({ error: '获取收藏模板失败' });
  }
});

// 模板详情（作者或管理员）
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const t = await dbGet(
      `SELECT ct.*, c.slug AS category_slug, c.name AS category_name, u.username AS uploader_name
       FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       LEFT JOIN users u ON ct.uploaded_by = u.id
       WHERE ct.id = ?`,
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '模板不存在' });
    if (req.userRole !== 'admin' && t.uploaded_by !== req.userId) {
      // 非作者非管理员：仅当 approved+visible 才可看元数据
      if (!(t.status === 'approved' && t.visibility === 'visible')) {
        return res.status(403).json({ error: '无权访问' });
      }
    }
    res.json(t);
  } catch (e) {
    logger.error({ type: 'app', msg: '获取模板详情失败', error: e.message });
    res.status(500).json({ error: '获取模板详情失败' });
  }
});

// 查询文件的上架状态（供文件列表「更多」菜单判断入口文案）
router.get("/by-file/:fileId", requireAuth, async (req, res) => {
  try {
    const t = await dbGet(
      `SELECT id, title, status, visibility, category_id FROM content_templates
       WHERE source_file_id = ? ORDER BY id DESC LIMIT 1`,
      [req.params.fileId]
    );
    if (!t) return res.json({ published: false });
    res.json({
      published: true, templateId: t.id, title: t.title,
      status: t.status, visibility: t.visibility, categoryId: t.category_id,
    });
  } catch (e) {
    res.status(500).json({ error: "查询上架状态失败" });
  }
});

// 从文件上架到市场（快照文件当前内容到模板）
// 一文件一模板：同文件再次上架=更新现有模板+重新审核
router.post("/from-file", requireAuth, async (req, res) => {
  const { fileId, title, description, categoryId } = req.body || {};
  if (!fileId) return res.status(400).json({ error: "缺少 fileId" });

  try {
    // 1. 校验文件：存在、归属、非 bundle、类型合法
    const file = await dbGet(
      "SELECT id, original_name, stored_name, file_type, is_bundle, uploaded_by FROM files WHERE id = ?",
      [fileId]
    );
    if (!file) return res.status(404).json({ error: "文件不存在" });
    if (req.userRole !== "admin" && file.uploaded_by !== req.userId) {
      return res.status(403).json({ error: "无权操作他人文件" });
    }
    if (file.is_bundle) return res.status(400).json({ error: "ZIP 包不支持上架" });
    if (!FILE_TYPES.includes(file.file_type)) {
      return res.status(400).json({ error: "仅支持 HTML / Markdown 文件" });
    }

    // 2. 校验分类
    if (!categoryId) return res.status(400).json({ error: "请选择分类" });
    const cat = await dbGet("SELECT id FROM template_market_categories WHERE id = ? AND is_enabled = 1", [categoryId]);
    if (!cat) return res.status(400).json({ error: "分类不存在或已停用" });

    // 3. 读文件内容做快照（ENOENT→文件已丢失）
    let content;
    try {
      content = await fs.promises.readFile(path.join(UPLOAD_DIR, file.stored_name), "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") return res.status(500).json({ error: "源文件已丢失，无法快照" });
      throw e;
    }
    if (!content) return res.status(400).json({ error: "文件内容为空" });
    if (Buffer.byteLength(content, "utf-8") > CONTENT_TEMPLATE_MAX_SIZE) {
      return res.status(400).json({ error: "文件内容超过 500KB 上限" });
    }

    const finalTitle = (title && title.trim()) ? title.trim() : file.original_name;
    const ts = now();

    // 4. 防重：同文件已有模板→更新+重新审核；否则新建
    const existing = await dbGet(
      "SELECT id, status FROM content_templates WHERE source_file_id = ? ORDER BY id DESC LIMIT 1",
      [fileId]
    );

    if (existing) {
      // 更新现有模板：刷新内容/标题/分类，回退 pending 重新审核
      await dbRun(
        `UPDATE content_templates SET
           title = ?, description = ?, content = ?, category_id = ?, file_type = ?,
           status = "pending", visibility = "hidden", review_note = NULL,
           submitted_at = ?, updated_at = datetime("now")
         WHERE id = ?`,
        [finalTitle, description || null, content, categoryId, file.file_type, ts, existing.id]
      );
      logger.audit("content_template.republish_from_file", { templateId: existing.id, fileId, ip: clientIp(req) });
      return res.json({ id: existing.id, status: "pending", republished: true });
    }

    const result = await dbRun(
      `INSERT INTO content_templates
        (title, description, file_type, content, uploaded_by, category_id,
         source_file_id, status, visibility, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, "pending", "hidden", ?)`,
      [finalTitle, description || null, file.file_type, content, req.userId, categoryId, fileId, ts]
    );
    logger.audit("content_template.publish_from_file", { templateId: result.lastID, fileId, ip: clientIp(req) });
    res.json({ id: result.lastID, status: "pending", republished: false });
  } catch (e) {
    logger.error({ type: "app", msg: "从文件上架失败", error: e.message });
    res.status(500).json({ error: "上架失败" });
  }
});

// 模板内容（作者或管理员，或已上架的公开内容）
router.get('/:id/content', requireAuth, async (req, res) => {
  try {
    const t = await dbGet(
      'SELECT id, title, file_type, content, status, visibility, uploaded_by FROM content_templates WHERE id = ?',
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '模板不存在' });
    const isMarketVisible = t.status === 'approved' && t.visibility === 'visible';
    if (!isMarketVisible && req.userRole !== 'admin' && t.uploaded_by !== req.userId) {
      return res.status(403).json({ error: '无权访问' });
    }
    res.json({ id: t.id, title: t.title, file_type: t.file_type, content: t.content });
  } catch (e) {
    res.status(500).json({ error: '获取模板内容失败' });
  }
});

// 提交模板（默认进入 pending）
router.post('/', requireAuth, async (req, res) => {
  const { title, description, fileType, categoryId, content } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: '模板标题不能为空' });
  if (!content) return res.status(400).json({ error: '样例内容不能为空' });
  if (Buffer.byteLength(content, 'utf-8') > CONTENT_TEMPLATE_MAX_SIZE) {
    return res.status(400).json({ error: '样例内容不能超过 500KB' });
  }
  const ft = fileType || 'html';
  if (!FILE_TYPES.includes(ft)) return res.status(400).json({ error: '文件类型仅支持 html 或 markdown' });
  if (!categoryId) return res.status(400).json({ error: '请选择分类' });

  try {
    // 校验分类存在且启用
    const cat = await dbGet('SELECT id FROM template_market_categories WHERE id = ? AND is_enabled = 1', [categoryId]);
    if (!cat) return res.status(400).json({ error: '分类不存在或已停用' });

    const ts = now();
    const result = await dbRun(
      `INSERT INTO content_templates
        (title, description, file_type, content, uploaded_by, category_id,
         status, visibility, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'hidden', ?)`,
      [title.trim(), description || null, ft, content, req.userId, categoryId, ts]
    );
    logger.audit('content_template.submit', { templateId: result.lastID, title: title.trim(), categoryId, ip: clientIp(req) });
    res.json({ id: result.lastID, title: title.trim(), status: 'pending' });
  } catch (e) {
    logger.error({ type: 'app', msg: '创建内容模板失败', error: e.message });
    res.status(500).json({ error: '创建内容模板失败' });
  }
});

// 编辑模板（作者）
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const t = await dbGet('SELECT id, uploaded_by, status FROM content_templates WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    if (req.userRole !== 'admin' && t.uploaded_by !== req.userId) return res.status(403).json({ error: '无权操作' });
    if (t.status === 'archived') return res.status(400).json({ error: '已删除模板不可编辑' });

    const { title, description, fileType, categoryId, content } = req.body || {};
    const sets = [];
    const params = [];

    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ error: '模板标题不能为空' });
      sets.push('title = ?'); params.push(title.trim());
    }
    if (description !== undefined) { sets.push('description = ?'); params.push(description); }
    if (fileType !== undefined) {
      if (!FILE_TYPES.includes(fileType)) return res.status(400).json({ error: '文件类型仅支持 html 或 markdown' });
      sets.push('file_type = ?'); params.push(fileType);
    }
    if (categoryId !== undefined) {
      const cat = await dbGet('SELECT id FROM template_market_categories WHERE id = ? AND is_enabled = 1', [categoryId]);
      if (!cat) return res.status(400).json({ error: '分类不存在或已停用' });
      sets.push('category_id = ?'); params.push(categoryId);
    }
    if (content !== undefined) {
      if (Buffer.byteLength(content, 'utf-8') > CONTENT_TEMPLATE_MAX_SIZE) {
        return res.status(400).json({ error: '样例内容不能超过 500KB' });
      }
      sets.push('content = ?'); params.push(content);
    }

    if (sets.length === 0) return res.json({ success: true });

    // approved 编辑后回退到 pending（避免绕过审核）；pending/pending 保持 pending
    // 已 rejected 编辑后变 pending（重新提交）
    if (t.status === 'approved' || t.status === 'rejected') {
      sets.push('status = ?', 'submitted_at = ?', 'review_note = NULL');
      params.push('pending', now());
    }
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

// 软删除
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const t = await dbGet('SELECT id, uploaded_by FROM content_templates WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    if (req.userRole !== 'admin' && t.uploaded_by !== req.userId) return res.status(403).json({ error: '无权操作' });
    await dbRun(
      `UPDATE content_templates SET status = 'archived', visibility = 'hidden', updated_at = datetime('now') WHERE id = ?`,
      [req.params.id]
    );
    logger.audit('content_template.archive', { templateId: parseInt(req.params.id), ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    logger.error({ type: 'app', msg: '删除内容模板失败', error: e.message });
    res.status(500).json({ error: '删除内容模板失败' });
  }
});

// 旧「使用计数」端点已废弃：「使用模板」= 实例化出文件，必须由 Token 驱动。
// 保留 410 响应，引导客户端改用 /instantiate 或 /use-guide。
router.post('/:id/use', (req, res) => {
  res.status(410).json({ error: '该端点已废弃，请使用 POST /instantiate 实例化模板，或 GET /use-guide 获取 CLI/MCP 命令' });
});

// 实例化模板 → 在用户文件列表创建一个新文件（基于模板内容），并记录追溯。
// 语义：「使用模板」= 用户真正得到一个可编辑的文件，而非空计数。
// 仅对 approved+visible 模板生效；必须通过 Token（MCP_TOKEN 或 jp_...）调用，禁止 Session Cookie。
// 同用户对同模板可多次实例化（每次得到新文件）。
router.post('/:id/instantiate', uploadLimiter, requireAuth, requireTokenAuth, async (req, res) => {
  try {
    const t = await dbGet(
      `SELECT ct.id, ct.title, ct.content, ct.file_type, ct.version
       FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       WHERE ct.id = ? AND ${MARKET_VISIBLE_COND}`,
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '模板不存在或未上架' });
    if (!t.content) return res.status(400).json({ error: '模板内容为空' });

    const ext = t.file_type === 'markdown' ? '.md' : '.html';
    const safeTitle = (t.title || '模板').replace(/[\\/:*?"<>|]/g, '_').trim() || '模板';
    const requestedName = req.body && typeof req.body.originalName === 'string' && req.body.originalName.trim()
      ? req.body.originalName.trim()
      : null;
    const originalName = requestedName || (safeTitle + ext);
    const storedName = generateStoredName(ext);
    const content = t.content;
    const size = Buffer.byteLength(content, 'utf-8');
    const filePath = path.join(UPLOAD_DIR, storedName);

    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
    } catch (e) {
      logger.error({ type: 'app', msg: '实例化写入文件失败', error: e.message });
      return res.status(500).json({ error: '创建文件失败' });
    }

    const isPublic = req.body && req.body.isPublic === true ? 1 : 0;
    const uploadSource = req.tokenSource === 'mcp' ? 'market-mcp' : 'market-cli';
    const ts = now();
    let fileId;
    try {
      const result = await dbRun(
        `INSERT INTO files
          (original_name, stored_name, file_type, size, is_public, uploaded_by,
           share_key, upload_source, source_asset_id, created_from, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [originalName, storedName, t.file_type, size, isPublic, req.userId, generateShareKey(), uploadSource, req.params.id, 'market', ts]
      );
      fileId = result.lastID;
      await addUserStorage(req.userId, size);
    } catch (e) {
      // 写库失败需回滚磁盘文件
      fs.promises.unlink(filePath).catch(() => {});
      logger.error({ type: 'app', msg: '实例化建文件记录失败', error: e.message });
      return res.status(500).json({ error: '创建文件失败' });
    }

    // FTS 索引同步
    if (isFtsIndexable(t.file_type, storedName)) {
      indexFileContent(fileId, storedName);
    }

    // 记录实例化追溯与 Token 绑定（UNIQUE(template_id, user_id)：同用户重复实例化时刷新为最新文件）
    await dbRun(
      `INSERT INTO content_template_installs
        (template_id, user_id, file_id, source_version, source, token_prefix, token_hash_prefix)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(template_id, user_id) DO UPDATE SET
         file_id = excluded.file_id,
         source_version = excluded.source_version,
         source = excluded.source,
         token_prefix = excluded.token_prefix,
         token_hash_prefix = excluded.token_hash_prefix,
         created_at = datetime('now')`,
      [req.params.id, req.userId, fileId, t.version || '1.0.0', req.tokenSource || 'unknown',
       req.tokenPrefix || null, req.tokenHashPrefix || null]
    );

    // 模板热度：use_count 同步 +1；实例化次数由 content_template_installs 子查询实时统计
    await dbRun('UPDATE content_templates SET use_count = use_count + 1 WHERE id = ?', [req.params.id]);

    // 读出新建文件的 share_key 返回，方便客户端直接构造预览链接
    const fileRow = await dbGet('SELECT share_key FROM files WHERE id = ?', [fileId]);

    logger.audit('content_template.instantiate', {
      templateId: parseInt(req.params.id), fileId, userId: req.userId,
      source: req.tokenSource, tokenHashPrefix: req.tokenHashPrefix, ip: clientIp(req)
    });
    res.json({ success: true, fileId, templateId: parseInt(req.params.id), shareKey: fileRow ? fileRow.share_key : null });
  } catch (e) {
    logger.error({ type: 'app', msg: '实例化模板失败', error: e.message });
    res.status(500).json({ error: '实例化失败' });
  }
});

// 公开端点：返回某模板的 CLI/MCP 使用引导命令，供 Web UI「使用此模板」按钮展示。
// 匿名可访问，因为只是命令文本，不创建文件。
router.get('/:id/use-guide', loadSession, marketBotFilter, marketPreviewLimiter, marketRobotsTag, async (req, res) => {
  try {
    const t = await dbGet(
      `SELECT ct.id, ct.title, ct.file_type, ct.share_key
       FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       WHERE ct.id = ? AND ${MARKET_VISIBLE_COND}`,
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '模板不存在或未上架' });

    const ext = t.file_type === 'markdown' ? '.md' : '.html';
    const safeName = (t.title || '模板').replace(/[\\/:*?"<>|]/g, '_').trim() || '模板';
    const defaultName = safeName + ext;
    const templateId = parseInt(t.id, 10);

    res.json({
      templateId,
      title: t.title,
      fileType: t.file_type,
      cli: `jpage template use ${templateId}`,
      cliWithName: `jpage template use ${templateId} --name "${defaultName}"`,
      mcp: {
        tool: 'instantiate_content_template',
        args: { id: templateId },
      },
      hint: '使用此模板需要有效的 API Token（jp_...）或 MCP_TOKEN，将在您的账户下创建一个新文件。',
    });
  } catch (e) {
    logger.error({ type: 'app', msg: '获取模板使用引导失败', error: e.message });
    res.status(500).json({ error: '获取使用引导失败' });
  }
});

// 收藏模板（toggle：已收藏则取消，否则收藏）
router.post('/:id/star', requireAuth, async (req, res) => {
  try {
    const t = await dbGet('SELECT id FROM content_templates WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    const existing = await dbGet('SELECT 1 FROM starred_templates WHERE user_id = ? AND template_id = ?', [req.userId, req.params.id]);
    if (existing) {
      await dbRun('DELETE FROM starred_templates WHERE user_id = ? AND template_id = ?', [req.userId, req.params.id]);
      res.json({ starred: false });
    } else {
      await dbRun('INSERT INTO starred_templates (user_id, template_id) VALUES (?, ?)', [req.userId, req.params.id]);
      res.json({ starred: true });
    }
  } catch (e) {
    res.status(500).json({ error: '操作失败' });
  }
});

// 下载模板内容为文件（HTML/MD）
router.get('/:id/download', requireAuth, async (req, res) => {
  try {
    const t = await dbGet(
      `SELECT ct.title, ct.content, ct.file_type FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       WHERE ct.id = ? AND ${MARKET_VISIBLE_COND}`,
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '模板不存在或未上架' });
    const ext = t.file_type === 'markdown' ? '.md' : '.html';
    const safeName = (t.title || '模板').replace(/[\\/:*?"<>|]/g, '_').trim() || '模板';
    const filename = encodeURIComponent(safeName + ext);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.setHeader('Content-Type', t.file_type === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8');
    res.send(t.content);
  } catch (e) {
    res.status(500).json({ error: '下载失败' });
  }
});

// 生成模板公开短链（返回 /t/:key 完整 URL）
router.post('/:id/share', requireAuth, async (req, res) => {
  try {
    const t = await dbGet(
      `SELECT ct.id, ct.share_key FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       WHERE ct.id = ? AND ${MARKET_VISIBLE_COND}`,
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '模板不存在或未上架' });
    // 已有 key 直接复用
    if (t.share_key) return res.json({ key: t.share_key });
    // 生成唯一 key（与 files 的 share_key 空间隔离：模板 key 存 content_templates）
    let key;
    for (let i = 0; i < 10; i++) {
      const candidate = generateShareKey();
      const clash = await dbGet('SELECT 1 FROM content_templates WHERE share_key = ?', [candidate]);
      if (!clash) { key = candidate; break; }
    }
    if (!key) return res.status(500).json({ error: '生成短链失败' });
    await dbRun('UPDATE content_templates SET share_key = ? WHERE id = ?', [key, req.params.id]);
    logger.audit('content_template.share', { templateId: parseInt(req.params.id), ip: clientIp(req) });
    res.json({ key });
  } catch (e) {
    logger.error({ type: 'app', msg: '生成模板短链失败', error: e.message });
    res.status(500).json({ error: '生成短链失败' });
  }
});

// ============================================================
// 管理员端点 —— 审核、运营、分类管理
// ============================================================

// 管理员查询所有模板
router.get('/admin/list', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { page, limit, offset } = parsePaging(req, 20);
    const { status, visibility, categoryId, keyword, uploaderId } = req.query;

    const conditions = [];
    const params = [];
    if (status && STATUS_VALUES.includes(status)) { conditions.push('ct.status = ?'); params.push(status); }
    if (visibility && VISIBILITY_VALUES.includes(visibility)) { conditions.push('ct.visibility = ?'); params.push(visibility); }
    if (categoryId) { conditions.push('ct.category_id = ?'); params.push(categoryId); }
    if (keyword) {
      conditions.push('(ct.title LIKE ? OR ct.description LIKE ? OR u.username LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (uploaderId) { conditions.push('ct.uploaded_by = ?'); params.push(uploaderId); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const total = await dbGet(
      `SELECT COUNT(*) as count FROM content_templates ct
       LEFT JOIN users u ON ct.uploaded_by = u.id ${where}`, params
    );
    const templates = await dbAll(
      `SELECT ct.id, ct.title, ct.description, ct.file_type, ct.status, ct.visibility,
              ct.review_note, ct.use_count, ct.featured, ct.sort_order,
              ct.created_at, ct.submitted_at, ct.published_at, ct.reviewed_at,
              ct.category_id, ct.uploaded_by, ct.source_file_id, ct.content IS NOT NULL AS has_content,
              c.slug AS category_slug, c.name AS category_name,
              u.username AS uploader_name, ru.username AS reviewer_name,
              sf.original_name AS source_file_name
       FROM content_templates ct
       LEFT JOIN template_market_categories c ON ct.category_id = c.id
       LEFT JOIN users u ON ct.uploaded_by = u.id
       LEFT JOIN users ru ON ct.reviewed_by = ru.id
       LEFT JOIN files sf ON ct.source_file_id = sf.id
       ${where} ORDER BY ct.created_at DESC, ct.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json({
      templates,
      pagination: { page, limit, total: total.count, totalPages: Math.ceil(total.count / limit) }
    });
  } catch (e) {
    logger.error({ type: 'app', msg: '管理员查询模板失败', error: e.message });
    res.status(500).json({ error: '查询模板失败' });
  }
});

// 审核模板
router.post('/:id/review', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status, visibility, reviewNote } = req.body || {};
    if (!STATUS_VALUES.includes(status)) {
      return res.status(400).json({ error: '非法状态' });
    }
    const t = await dbGet('SELECT id, status FROM content_templates WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: '模板不存在' });

    const sets = ['status = ?', 'review_note = ?', 'reviewed_by = ?', 'reviewed_at = ?', "updated_at = datetime('now')"];
    const params = [status, reviewNote || null, req.userId, now()];
    const ts = now();

    if (status === 'approved') {
      const vis = visibility === 'visible' ? 'visible' : 'hidden';
      sets.push('visibility = ?', 'published_at = ?');
      params.push(vis, ts);
    } else if (status === 'rejected') {
      // 拒绝时保持 hidden
      sets.push('visibility = ?');
      params.push('hidden');
    }
    params.push(req.params.id);
    await dbRun(`UPDATE content_templates SET ${sets.join(', ')} WHERE id = ?`, params);
    logger.audit('content_template.review', {
      templateId: parseInt(req.params.id), status, visibility: status === 'approved' ? visibility : null,
      ip: clientIp(req)
    });
    res.json({ success: true });
  } catch (e) {
    logger.error({ type: 'app', msg: '审核模板失败', error: e.message });
    res.status(500).json({ error: '审核失败' });
  }
});

// 管理员运营配置（分类/可见性/精选/排序）
router.patch('/:id/admin', requireAuth, requireAdmin, async (req, res) => {
  try {
    const t = await dbGet('SELECT id FROM content_templates WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: '模板不存在' });

    const { categoryId, visibility, featured, sortOrder } = req.body || {};
    const sets = [];
    const params = [];

    if (categoryId !== undefined) {
      const cat = await dbGet('SELECT id FROM template_market_categories WHERE id = ?', [categoryId]);
      if (!cat) return res.status(400).json({ error: '分类不存在' });
      sets.push('category_id = ?'); params.push(categoryId);
    }
    if (visibility !== undefined) {
      if (!VISIBILITY_VALUES.includes(visibility)) return res.status(400).json({ error: '非法可见性' });
      sets.push('visibility = ?'); params.push(visibility);
    }
    if (featured !== undefined) { sets.push('featured = ?'); params.push(featured ? 1 : 0); }
    if (sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(parseInt(sortOrder) || 0); }

    if (sets.length === 0) return res.json({ success: true });
    sets.push("updated_at = datetime('now')");
    params.push(req.params.id);
    await dbRun(`UPDATE content_templates SET ${sets.join(', ')} WHERE id = ?`, params);
    logger.audit('content_template.admin_config', { templateId: parseInt(req.params.id), ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    logger.error({ type: 'app', msg: '管理员配置模板失败', error: e.message });
    res.status(500).json({ error: '配置失败' });
  }
});

// 管理员查看模板内容（任意状态）
router.get('/admin/:id/content', requireAuth, requireAdmin, async (req, res) => {
  try {
    const t = await dbGet('SELECT id, title, file_type, content FROM content_templates WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    res.json({ id: t.id, title: t.title, file_type: t.file_type, content: t.content });
  } catch (e) {
    res.status(500).json({ error: '获取模板内容失败' });
  }
});

// ---- 分类管理 ----

// 分类列表（含禁用的）
router.get('/admin/categories', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT mc.*,
              (SELECT COUNT(*) FROM content_templates ct WHERE ct.category_id = mc.id) AS template_count
       FROM template_market_categories mc
       ORDER BY mc.sort_order ASC, mc.id ASC`
    );
    res.json({ categories: rows });
  } catch (e) {
    logger.error({ type: 'app', msg: '获取分类列表失败', error: e.message });
    res.status(500).json({ error: '获取分类列表失败' });
  }
});

router.post('/admin/categories', requireAuth, requireAdmin, async (req, res) => {
  const { slug, name, description, sortOrder } = req.body || {};
  if (!slug || !slug.trim()) return res.status(400).json({ error: '分类 slug 不能为空' });
  if (!name || !name.trim()) return res.status(400).json({ error: '分类名称不能为空' });
  if (!/^[a-z0-9-]+$/.test(slug.trim())) {
    return res.status(400).json({ error: 'slug 只能包含小写字母、数字和连字符' });
  }
  try {
    const result = await dbRun(
      `INSERT INTO template_market_categories (slug, name, description, sort_order) VALUES (?, ?, ?, ?)`,
      [slug.trim(), name.trim(), description || null, parseInt(sortOrder) || 0]
    );
    logger.audit('content_template.category_create', { categoryId: result.lastID, slug: slug.trim(), ip: clientIp(req) });
    res.json({ id: result.lastID });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'slug 已存在' });
    }
    logger.error({ type: 'app', msg: '创建分类失败', error: e.message });
    res.status(500).json({ error: '创建分类失败' });
  }
});

// 批量重排序：body.order = [id, id, ...]，按数组下标写入 sort_order。
// 必须注册在 PUT /admin/categories/:id 之前，否则字面量 reorder 会被 :id 捕获。
router.put('/admin/categories/reorder', requireAuth, requireAdmin, async (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: '缺少排序数组' });
  }
  const ids = order.map(x => parseInt(x));
  if (ids.some(x => !Number.isInteger(x))) {
    return res.status(400).json({ error: '存在非法 ID' });
  }
  try {
    // 校验所有 ID 都真实存在，避免越权写入不存在的行
    const ph = ids.map(() => '?').join(',');
    const found = await dbAll(`SELECT id FROM template_market_categories WHERE id IN (${ph})`, ids);
    if (found.length !== ids.length) return res.status(400).json({ error: '存在无效分类' });

    // 逐条 UPDATE sort_order；admin 低频操作，reorder 幂等可重试
    for (let i = 0; i < ids.length; i++) {
      await dbRun(
        `UPDATE template_market_categories SET sort_order = ?, updated_at = datetime('now') WHERE id = ?`,
        [i, ids[i]]
      );
    }
    logger.audit('content_template.category_reorder', { count: ids.length, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    logger.error({ type: 'app', msg: '分类排序失败', error: e.message });
    res.status(500).json({ error: '排序失败' });
  }
});

router.put('/admin/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const existing = await dbGet('SELECT id FROM template_market_categories WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: '分类不存在' });

    const { name, description, sortOrder, isEnabled } = req.body || {};
    const sets = [];
    const params = [];
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: '分类名称不能为空' });
      sets.push('name = ?'); params.push(name.trim());
    }
    if (description !== undefined) { sets.push('description = ?'); params.push(description); }
    if (sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(parseInt(sortOrder) || 0); }
    if (isEnabled !== undefined) { sets.push('is_enabled = ?'); params.push(isEnabled ? 1 : 0); }
    if (sets.length === 0) return res.json({ success: true });
    sets.push("updated_at = datetime('now')");
    params.push(req.params.id);
    await dbRun(`UPDATE template_market_categories SET ${sets.join(', ')} WHERE id = ?`, params);
    logger.audit('content_template.category_update', { categoryId: parseInt(req.params.id), ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    logger.error({ type: 'app', msg: '更新分类失败', error: e.message });
    res.status(500).json({ error: '更新分类失败' });
  }
});

router.delete('/admin/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const count = await dbGet(
      'SELECT COUNT(*) as count FROM content_templates WHERE category_id = ?', [req.params.id]
    );
    if (count.count > 0) {
      // 有模板的分类只能停用，不能物理删除
      await dbRun(
        `UPDATE template_market_categories SET is_enabled = 0, updated_at = datetime('now') WHERE id = ?`,
        [req.params.id]
      );
      return res.json({ success: true, disabled: true, message: '分类下有模板，已停用而非删除' });
    }
    await dbRun('DELETE FROM template_market_categories WHERE id = ?', [req.params.id]);
    logger.audit('content_template.category_delete', { categoryId: parseInt(req.params.id), ip: clientIp(req) });
    res.json({ success: true, disabled: false });
  } catch (e) {
    logger.error({ type: 'app', msg: '删除分类失败', error: e.message });
    res.status(500).json({ error: '删除分类失败' });
  }
});

module.exports = router;
