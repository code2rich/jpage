// 文件管理路由：列表 / 搜索 / 上传(multipart+json+zip) / CRUD / 批量 /
// 详情 / 原文 / 资源 / 渲染 / 下载 / 覆盖上传 / 版本历史 / 标签关联 / 收藏 / 分类 / 访问统计。
// 从 server.js 提取，行为保持不变。挂载点：/api/files

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const archiver = require('archiver');
const { dbGet, dbRun, dbAll } = require('../lib/db');
const { requireAuth } = require('../lib/middleware/auth');
const { loadFileWithPrivacy, checkFileOwnership } = require('../lib/middleware/files');
const { now, unlinkQuiet, generateShareKey, currentUserId, clientIp, decodeFilename } = require('../lib/util');
const { UPLOAD_DIR } = require('../lib/paths');
const { getCategoryName } = require('../lib/categories');
const { isFtsIndexable, indexFileContent, deleteFileIndex, escapeFtsQuery } = require('../lib/fts');
const { invalidateRenderCache } = require('../lib/render-cache');
const { listBundleEntries, renderFile } = require('../lib/render');
const { handleZipUpload } = require('../lib/zip');
const { getPendingViewCount } = require('../lib/view-counts');
const logger = require('../logger');

const router = express.Router();

// --- 上传相关配置 ---
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: '上传请求过于频繁，请稍后再试' }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const decoded = decodeFilename(file.originalname);
    const ext = path.extname(decoded);
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const decoded = decodeFilename(file.originalname);
    const allowed = ['.html', '.htm', '.md', '.markdown', '.zip'];
    const ext = path.extname(decoded).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('仅支持 HTML、Markdown 和 ZIP 文件'));
  }
});

const largeJson = express.json({ limit: '50mb' });

// --- 列表 ---
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const role = req.userRole;

    // 分页参数
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const maxLimit = 100;
    const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    // 排序参数
    const allowedSorts = ['updated_at', 'created_at', 'original_name', 'size'];
    const sort = allowedSorts.includes(req.query.sort) ? req.query.sort : 'updated_at';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

    // 筛选参数
    const keyword = (req.query.keyword || '').trim();
    const categoryId = req.query.category || null;
    const tagId = req.query.tag || null;

    // 构建 WHERE 条件
    const conditions = [];
    const params = [];

    if (role !== 'admin') {
      conditions.push(`f.uploaded_by = ?`);
      params.push(userId);
    }
    if (keyword) {
      conditions.push(`f.original_name LIKE ?`);
      params.push(`%${keyword}%`);
    }
    if (categoryId === 'uncategorized') {
      conditions.push(`f.category_id IS NULL`);
    } else if (categoryId) {
      conditions.push(`f.category_id = ?`);
      params.push(parseInt(categoryId));
    }
    if (tagId) {
      conditions.push(`EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id AND ft.tag_id = ?)`);
      params.push(parseInt(tagId));
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // 总数查询
    const countRow = await dbGet(`SELECT COUNT(*) AS total FROM files f ${whereClause}`, params);
    const total = countRow.total;
    const totalPages = Math.ceil(total / limit) || 1;

    // 数据查询
    const sql = `SELECT f.id, f.original_name, f.file_type, f.size, f.is_public, f.created_at, f.updated_at, f.share_key, f.category_id, f.uploaded_by, f.is_bundle, f.entry_path, f.view_count, f.template_id,
      (SELECT COUNT(*) FROM file_versions WHERE file_id = f.id) AS version_count
    FROM files f ${whereClause} ORDER BY f.${sort} ${order} LIMIT ? OFFSET ?`;
    const files = await dbAll(sql, [...params, limit, offset]);

    const fileIdStr = files.length ? files.map(f => f.id).join(',') : '0';

    // 批量获取标签
    const tagRows = await dbAll(
      `SELECT ft.file_id, t.id AS tag_id, t.name AS tag_name FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.file_id IN (${fileIdStr})`
    );
    const tagsMap = {};
    tagRows.forEach(r => {
      if (!tagsMap[r.file_id]) tagsMap[r.file_id] = [];
      tagsMap[r.file_id].push({ id: r.tag_id, name: r.tag_name });
    });

    // 批量获取收藏状态
    let starredSet = new Set();
    if (userId) {
      const starRows = await dbAll(
        `SELECT file_id FROM starred_files WHERE user_id = ? AND file_id IN (${fileIdStr})`, [userId]
      );
      starredSet = new Set(starRows.map(r => r.file_id));
    }

    // 分类名称走内存缓存（避免每次列表全表扫 categories）
    const result = files.map(f => ({
      ...f,
      tags: tagsMap[f.id] || [],
      starred: starredSet.has(f.id),
      category_name: f.category_id ? getCategoryName(f.category_id) : null,
    }));

    res.json({
      files: result,
      pagination: { page, limit, total, totalPages }
    });
  } catch (e) {
    res.status(500).json({ error: '获取文件列表失败' });
  }
});

// --- 全文搜索 ---
// FTS5 的 MATCH 不能与普通列在 LEFT JOIN + OR 中混用（SQLite 报 "unable to use function MATCH"）。
// 因此用 UNION 合并两类命中：FTS 全文命中（带 snippet）+ 文件名 LIKE 命中（snippet 为 NULL）。
// UNION 自动按整行去重；外层 JOIN files 取详情，COUNT 与 LIMIT 同源，分页准确、无重复。
// 一次往返替代原来的两次全量查询 + 内存去重。
router.get('/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: '搜索关键词不能为空' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const userId = req.userId;
  const role = req.userRole;

  const ftsQuery = escapeFtsQuery(q);
  const likeQ = '%' + q + '%';
  const useFts = !!ftsQuery;

  try {
    // 权限子句作用于外层 files 行
    let permClause = '';
    const permParams = [];
    if (role !== 'admin') {
      permClause = 'AND f.uploaded_by = ?';
      permParams.push(userId);
    }

    // 匹配 id 集合（含 snippet）：FTS 命中 UNION 文件名命中
    const matchedIdsSql = useFts
      ? "(SELECT fts.file_id AS id, snippet(file_contents_fts, 0, '<mark>', '</mark>', '...', 32) AS snippet " +
        'FROM file_contents_fts fts WHERE fts.content MATCH ? ' +
        'UNION ' +
        'SELECT f2.id AS id, NULL AS snippet FROM files f2 WHERE f2.original_name LIKE ?)'
      : '(SELECT f2.id AS id, NULL AS snippet FROM files f2 WHERE f2.original_name LIKE ?)';
    const matchedParams = useFts ? [ftsQuery, likeQ] : [likeQ];

    const countRow = await dbGet(
      'SELECT COUNT(*) AS total FROM files f JOIN ' + matchedIdsSql + ' m ON m.id = f.id WHERE 1=1 ' + permClause,
      [...matchedParams, ...permParams]
    );
    const total = countRow.total;
    const totalPages = Math.ceil(total / limit) || 1;

    const files = await dbAll(
      'SELECT f.id, f.original_name, f.file_type, f.size, f.is_public, f.created_at, f.updated_at, f.share_key, f.category_id, f.uploaded_by, f.is_bundle, f.entry_path, f.view_count, ' +
      '(SELECT COUNT(*) FROM file_versions WHERE file_id = f.id) AS version_count, m.snippet ' +
      'FROM files f JOIN ' + matchedIdsSql + ' m ON m.id = f.id WHERE 1=1 ' + permClause + ' ' +
      'ORDER BY f.updated_at DESC LIMIT ? OFFSET ?',
      [...matchedParams, ...permParams, limit, offset]
    );

    const fileIdStr = files.length ? files.map(f => f.id).join(',') : '0';

    const tagRows = await dbAll(
      'SELECT ft.file_id, t.id AS tag_id, t.name AS tag_name FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.file_id IN (' + fileIdStr + ')'
    );
    const tagsMap = {};
    tagRows.forEach(r => {
      if (!tagsMap[r.file_id]) tagsMap[r.file_id] = [];
      tagsMap[r.file_id].push({ id: r.tag_id, name: r.tag_name });
    });

    let starredSet = new Set();
    if (userId) {
      const starRows = await dbAll(
        'SELECT file_id FROM starred_files WHERE user_id = ? AND file_id IN (' + fileIdStr + ')', [userId]
      );
      starredSet = new Set(starRows.map(r => r.file_id));
    }

    // 分类名称走内存缓存
    const result = files.map(f => ({
      ...f,
      tags: tagsMap[f.id] || [],
      starred: starredSet.has(f.id),
      category_name: f.category_id ? getCategoryName(f.category_id) : null,
    }));

    res.json({
      files: result,
      query: q,
      pagination: { page, limit, total, totalPages }
    });
  } catch (e) {
    logger.error({ type: 'app', message: '搜索失败', error: e.message });
    res.status(500).json({ error: '搜索失败' });
  }
});

// --- 上传 ---
router.post('/upload', requireAuth, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  req.file.originalname = decodeFilename(req.file.originalname);
  const ext = path.extname(req.file.originalname).toLowerCase();
  // ZIP 处理
  if (ext === '.zip') {
    return handleZipUpload(req, res, await fs.promises.readFile(req.file.path));
  }
  let fileType = 'html';
  if (ext === '.md' || ext === '.markdown') fileType = 'markdown';
  const isPublic = req.body.isPublic === 'true' || req.body.isPublic === true;
  try {
    // 检查同名文件
    const existing = await dbGet(
      'SELECT id, stored_name, size, uploaded_by, file_type FROM files WHERE original_name = ?',
      [req.file.originalname]
    );

    if (existing) {
      // 同名文件：校验文件类型
      if (existing.file_type !== fileType) {
        // 类型不匹配，清理已上传的文件，拒绝覆盖
        await unlinkQuiet(path.join(UPLOAD_DIR, req.file.filename));
        return res.status(400).json({ error: '文件类型不匹配' });
      }

      // 计算版本号
      const verRow = await dbGet(
        'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
        [existing.id]
      );
      const nextVer = verRow.nextVer;

      // 备份当前版本到 file_versions
      await dbRun(
        'INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
        [existing.id, nextVer, existing.stored_name, existing.size, existing.uploaded_by]
      );

      // 更新 files 主记录（新文件已由 multer 写入磁盘）
      await dbRun(
        'UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?',
        [req.file.filename, req.file.size, now(), existing.id]
      );

      // FTS 索引同步
      if (isFtsIndexable(fileType, req.file.filename)) {
        indexFileContent(existing.id, req.file.filename);
      }

      const shareKey = await dbGet('SELECT share_key FROM files WHERE id = ?', [existing.id]).then(r => r?.share_key);
      logger.audit('file.overwrite', { fileId: existing.id, fileName: req.file.originalname, version: nextVer + 1, fileType, size: req.file.size, ip: clientIp(req) });
      return res.json({
        id: existing.id,
        overwritten: true,
        version: nextVer + 1,
        original_name: req.file.originalname,
        file_type: fileType,
        size: req.file.size,
        is_public: existing.is_public,
        share_key: shareKey
      });
    }

    // 不存在同名文件：新建
    const result = await dbRun(
      'INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by, share_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.file.originalname, req.file.filename, fileType, req.file.size, isPublic ? 1 : 0, currentUserId(req), generateShareKey(), now()]
    );
    // FTS 索引同步
    if (isFtsIndexable(fileType, req.file.filename)) {
      indexFileContent(result.lastID, req.file.filename);
    }
    const shareKey = await dbGet('SELECT share_key FROM files WHERE id = ?', [result.lastID]).then(r => r?.share_key);
    logger.audit('file.upload', { fileId: result.lastID, fileName: req.file.originalname, fileType, size: req.file.size, ip: clientIp(req) });
    res.json({
      id: result.lastID,
      original_name: req.file.originalname,
      file_type: fileType,
      size: req.file.size,
      is_public: isPublic ? 1 : 0,
      share_key: shareKey
    });
  } catch (e) {
    res.status(500).json({ error: '保存文件记录失败' });
  }
});

router.post('/upload-json', requireAuth, uploadLimiter, largeJson, async (req, res) => {
  const { name, content, isPublic } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: '文件名不能为空' });
  if (typeof content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });
  const decoded = decodeFilename(name.trim());
  const ext = path.extname(decoded).toLowerCase();
  const allowed = ['.html', '.htm', '.md', '.markdown'];
  if (!allowed.includes(ext)) return res.status(400).json({ error: '仅支持 HTML 和 Markdown 文件' });
  const size = Buffer.byteLength(content, 'utf-8');
  if (size > 50 * 1024 * 1024) return res.status(400).json({ error: '文件大小超过50MB限制' });
  const fileType = (ext === '.md' || ext === '.markdown') ? 'markdown' : 'html';
  const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
  const storedName = unique + ext;
  const filePath = path.join(UPLOAD_DIR, storedName);
  try {
    await fs.promises.writeFile(filePath, content, 'utf-8');
  } catch (e) {
    logger.error({ type: 'app', message: '写入文件失败', error: e.message });
    return res.status(500).json({ error: '写入文件失败' });
  }

  // 检查同名文件
  const existing = await dbGet(
    'SELECT id, stored_name, size, uploaded_by, file_type, is_public, share_key FROM files WHERE original_name = ?',
    [decoded]
  ).catch(() => null);

  if (existing) {
    // 同名文件：校验文件类型
    if (existing.file_type !== fileType) {
      await unlinkQuiet(filePath);
      return res.status(400).json({ error: '文件类型不匹配' });
    }

    try {
      // 计算版本号
      const verRow = await dbGet(
        'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
        [existing.id]
      );
      const nextVer = verRow.nextVer;

      // 备份当前版本到 file_versions
      await dbRun(
        'INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
        [existing.id, nextVer, existing.stored_name, existing.size, existing.uploaded_by]
      );

      // 更新 files 主记录
      await dbRun(
        'UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?',
        [storedName, size, now(), existing.id]
      );

      // FTS 索引同步
      if (isFtsIndexable(fileType, storedName)) {
        indexFileContent(existing.id, storedName);
      }

      logger.audit('file.overwrite', { fileId: existing.id, fileName: decoded, version: nextVer + 1, fileType, size, ip: clientIp(req) });
      return res.json({
        id: existing.id,
        overwritten: true,
        version: nextVer + 1,
        original_name: decoded,
        file_type: fileType,
        size,
        is_public: existing.is_public,
        share_key: existing.share_key
      });
    } catch (e) {
      await unlinkQuiet(filePath);
      return res.status(500).json({ error: '覆盖上传失败' });
    }
  }

  // 不存在同名文件：新建
  const isPublicFlag = isPublic === false ? 0 : 1;
  try {
    const result = await dbRun(
      'INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by, share_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [decoded, storedName, fileType, size, isPublicFlag, currentUserId(req), generateShareKey(), now()]
    );
    // FTS 索引同步
    if (isFtsIndexable(fileType, storedName)) {
      indexFileContent(result.lastID, storedName);
    }
    const shareKey = await dbGet('SELECT share_key FROM files WHERE id = ?', [result.lastID]).then(r => r?.share_key);
    logger.audit('file.upload', { fileId: result.lastID, fileName: decoded, fileType, size, ip: clientIp(req) });
    res.json({
      id: result.lastID,
      original_name: decoded,
      file_type: fileType,
      size,
      is_public: isPublicFlag,
      share_key: shareKey
    });
  } catch (e) {
    await unlinkQuiet(filePath);
    res.status(500).json({ error: '保存文件记录失败' });
  }
});

router.post('/upload-zip-base64', requireAuth, uploadLimiter, largeJson, async (req, res) => {
  const { name, content, isPublic } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: '文件名不能为空' });
  if (typeof content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });
  const ext = path.extname(name).toLowerCase();
  if (ext !== '.zip') return res.status(400).json({ error: '仅支持 ZIP 文件' });
  try {
    const zipBuffer = Buffer.from(content, 'base64');
    if (zipBuffer.length > 50 * 1024 * 1024) return res.status(400).json({ error: 'ZIP 文件超过50MB限制' });
    req.file = { originalname: decodeFilename(name) };
    req.body.isPublic = isPublic;
    return await handleZipUpload(req, res, zipBuffer);
  } catch (e) {
    logger.error({ type: 'app', action: 'zip.base64', error: e.message });
    return res.status(500).json({ error: 'ZIP 处理失败: ' + e.message });
  }
});

// --- 更新 / 删除 ---
router.put('/:id', requireAuth, async (req, res) => {
  const { name, isPublic, templateId } = req.body || {};
  if (name === undefined && isPublic === undefined && templateId === undefined) {
    return res.status(400).json({ error: '无更新字段' });
  }
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (!checkFileOwnership(req, file)) return res.status(403).json({ error: '无权操作此文件' });
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: '文件名不能为空' });
      await dbRun('UPDATE files SET original_name = ? WHERE id = ?', [name.trim(), req.params.id]);
    }
    if (isPublic !== undefined) {
      await dbRun('UPDATE files SET is_public = ? WHERE id = ?', [isPublic ? 1 : 0, req.params.id]);
    }
    if (templateId !== undefined) {
      const tid = templateId ? parseInt(templateId) : null;
      if (tid) {
        const tpl = await dbGet('SELECT id FROM templates WHERE id = ?', [tid]);
        if (!tpl) return res.status(400).json({ error: '模板不存在' });
      }
      await dbRun('UPDATE files SET template_id = ? WHERE id = ?', [tid, req.params.id]);
    }
    logger.audit('file.update', { fileId: req.params.id, changes: { name, isPublic, templateId }, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '更新失败' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (!checkFileOwnership(req, file)) return res.status(403).json({ error: '无权操作此文件' });

    // 清理关联数据
    await dbRun('DELETE FROM file_tags WHERE file_id = ?', [req.params.id]);
    await dbRun('DELETE FROM starred_files WHERE file_id = ?', [req.params.id]);
    await deleteFileIndex(req.params.id);

    // 清理版本记录及对应磁盘文件
    const versions = await dbAll('SELECT stored_name FROM file_versions WHERE file_id = ?', [req.params.id]);
    for (const v of versions) {
      const p = path.join(UPLOAD_DIR, v.stored_name);
      if (fs.existsSync(p)) await unlinkQuiet(p);
    }
    await dbRun('DELETE FROM file_versions WHERE file_id = ?', [req.params.id]);

    // 删除主文件
    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (fs.existsSync(filePath)) await unlinkQuiet(filePath);
    await dbRun('DELETE FROM files WHERE id = ?', [req.params.id]);
    invalidateRenderCache(req.params.id);
    logger.audit('file.delete', { fileId: req.params.id, fileName: file.original_name, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败' });
  }
});

// --- 批量操作 ---
router.post('/batch', requireAuth, async (req, res) => {
  try {
    const { action, ids, data } = req.body;
    if (!action || !Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: '缺少 action 或 ids 参数' });
    }
    if (ids.length > 200) return res.status(400).json({ error: '单次最多操作 200 个文件' });
    const validActions = ['delete', 'setPublic', 'setPrivate', 'setCategory'];
    if (!validActions.includes(action)) return res.status(400).json({ error: '不支持的操作: ' + action });

    const placeholders = ids.map(() => '?').join(',');
    const files = await dbAll(`SELECT * FROM files WHERE id IN (${placeholders})`, ids);
    if (!files.length) return res.json({ success: true, affected: 0 });
    for (const f of files) {
      if (!checkFileOwnership(req, f)) return res.status(403).json({ error: '无权操作部分文件' });
    }

    const fileIds = files.map(f => f.id);
    const idPlaceholders = fileIds.map(() => '?').join(',');

    if (action === 'delete') {
      await dbRun('BEGIN');
      try {
        await dbRun(`DELETE FROM file_tags WHERE file_id IN (${idPlaceholders})`, fileIds);
        await dbRun(`DELETE FROM starred_files WHERE file_id IN (${idPlaceholders})`, fileIds);
        const versions = await dbAll(`SELECT stored_name FROM file_versions WHERE file_id IN (${idPlaceholders})`, fileIds);
        for (const v of versions) {
          await unlinkQuiet(path.join(UPLOAD_DIR, v.stored_name));
        }
        await dbRun(`DELETE FROM file_versions WHERE file_id IN (${idPlaceholders})`, fileIds);
        for (const f of files) {
          await unlinkQuiet(path.join(UPLOAD_DIR, f.stored_name));
        }
        await dbRun(`DELETE FROM files WHERE id IN (${idPlaceholders})`, fileIds);
        await dbRun('COMMIT');
      } catch (e) {
        await dbRun('ROLLBACK');
        throw e;
      }
      logger.audit('file.batchDelete', { count: fileIds.length, ip: clientIp(req) });
    } else if (action === 'setPublic' || action === 'setPrivate') {
      const isPublic = action === 'setPublic' ? 1 : 0;
      await dbRun(`UPDATE files SET is_public = ? WHERE id IN (${idPlaceholders})`, [isPublic, ...fileIds]);
      logger.audit('file.batchSetPrivacy', { action, count: fileIds.length, ip: clientIp(req) });
    } else if (action === 'setCategory') {
      const categoryId = data && data.categoryId ? data.categoryId : null;
      await dbRun(`UPDATE files SET category_id = ? WHERE id IN (${idPlaceholders})`, [categoryId, ...fileIds]);
      logger.audit('file.batchSetCategory', { categoryId, count: fileIds.length, ip: clientIp(req) });
    }

    res.json({ success: true, affected: fileIds.length });
  } catch (e) {
    logger.error({ type: 'app', action: 'file.batch', error: e.message });
    res.status(500).json({ error: '批量操作失败' });
  }
});

// --- 详情 ---
router.get('/:id', loadFileWithPrivacy, async (req, res) => {
  try {
    const f = req.fileRecord;
    // 并行查询：tags / starred / category / version_count（WAL 下读不互斥）
    const [tags, starredRow, cat, versionRow] = await Promise.all([
      dbAll('SELECT t.id, t.name FROM tags t JOIN file_tags ft ON ft.tag_id = t.id WHERE ft.file_id = ?', [f.id]),
      req.userId ? dbGet('SELECT 1 AS hit FROM starred_files WHERE user_id = ? AND file_id = ?', [req.userId, f.id]) : Promise.resolve(null),
      f.category_id ? dbGet('SELECT name FROM categories WHERE id = ?', [f.category_id]) : Promise.resolve(null),
      dbGet('SELECT COUNT(*) AS c FROM file_versions WHERE file_id = ?', [f.id]),
    ]);
    const starred = !!(starredRow && starredRow.hit);
    const category_name = cat ? cat.name : null;
    res.json({
      id: f.id,
      original_name: f.original_name,
      file_type: f.file_type,
      size: f.size,
      is_public: f.is_public,
      created_at: f.created_at,
      updated_at: f.updated_at,
      share_key: f.share_key,
      category_id: f.category_id,
      uploaded_by: f.uploaded_by,
      is_bundle: f.is_bundle,
      entry_path: f.entry_path,
      view_count: f.view_count,
      template_id: f.template_id,
      version_count: versionRow ? versionRow.c : 0,
      tags,
      starred,
      category_name,
    });
  } catch (e) {
    logger.error({ type: 'app', error: e.message });
    res.status(500).json({ error: '获取文件失败' });
  }
});

// --- 原文 ---
router.get('/:id/content', requireAuth, loadFileWithPrivacy, async (req, res) => {
  const file = req.fileRecord;
  if (req.userRole !== 'admin' && file.uploaded_by !== req.userId) {
    return res.status(403).json({ error: '无权读取此文件原文' });
  }

  // Bundle 没有单一原文：降级返回入口文件内容（源码视图）+ 目录清单 + 元信息。
  // 这样前端预览页能正常进入，源码视图展示入口文件，完整包仍走 /download。
  if (file.is_bundle) {
    const bundleDir = path.join(UPLOAD_DIR, file.stored_name);
    const entryPath = path.join(bundleDir, file.entry_path || 'index.html');
    // 入口路径必须落在 bundle 目录内，防穿越（与 renderFile 同款校验）
    const resolvedEntry = path.resolve(entryPath);
    const resolvedDir = path.resolve(bundleDir) + path.sep;
    if (!resolvedEntry.startsWith(resolvedDir)) {
      return res.status(403).json({ error: '非法路径' });
    }
    try {
      // 入口读不到时降级为空串而非报错：预览页仍可用 iframe /render 与下载
      const entryContent = await fs.promises.readFile(entryPath, 'utf-8').catch(() => '');
      const { entries, truncated } = await listBundleEntries(bundleDir);
      return res.json({
        id: file.id,
        original_name: file.original_name,
        file_type: file.file_type,
        is_public: file.is_public,
        uploaded_by: file.uploaded_by,
        is_bundle: file.is_bundle,
        entry_path: file.entry_path,
        template_id: file.template_id,
        content: entryContent,
        entries,
        entries_truncated: truncated,
      });
    } catch (e) {
      if (e && e.code === 'ENOENT') return res.status(404).json({ error: '文件已丢失' });
      logger.error({ type: 'app', error: e.message });
      return res.status(500).json({ error: '读取文件失败' });
    }
  }

  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    res.json({
      id: file.id,
      original_name: file.original_name,
      file_type: file.file_type,
      is_public: file.is_public,
      uploaded_by: file.uploaded_by,
      is_bundle: file.is_bundle,
      template_id: file.template_id,
      content
    });
  } catch (e) {
    if (e && e.code === 'ENOENT') return res.status(404).json({ error: '文件已丢失' });
    res.status(500).json({ error: '读取文件失败' });
  }
});

// --- 资源 / 渲染 / 下载 ---
router.get('/:id/asset/*', loadFileWithPrivacy, async (req, res) => {
  const file = req.fileRecord;
  if (!file.is_bundle) return res.status(400).json({ error: '非网站包' });
  const bundleDir = path.resolve(path.join(UPLOAD_DIR, file.stored_name));
  const assetRelative = req.params[0];
  const assetPath = path.resolve(path.join(bundleDir, assetRelative));
  if (!assetPath.startsWith(bundleDir + path.sep) && assetPath !== bundleDir) {
    return res.status(403).json({ error: '非法路径' });
  }
  try {
    const stat = await fs.promises.stat(assetPath);
    if (stat.isDirectory()) return res.status(404).json({ error: '资源不存在' });
  } catch {
    return res.status(404).json({ error: '资源不存在' });
  }
  res.sendFile(assetPath, (err) => {
    if (err && !res.headersSent && err.code === 'ENOENT') {
      res.status(404).json({ error: '资源不存在' });
    }
  });
});

router.get('/:id/render', loadFileWithPrivacy, async (req, res) => {
  await renderFile(res, req.fileRecord);
});

router.get('/:id/download', loadFileWithPrivacy, async (req, res) => {
  const file = req.fileRecord;
  if (file.is_bundle) {
    const bundleDir = path.join(UPLOAD_DIR, file.stored_name);
    try {
      const st = await fs.promises.stat(bundleDir);
      if (!st.isDirectory()) return res.status(404).json({ error: '文件已丢失' });
    } catch {
      return res.status(404).json({ error: '文件已丢失' });
    }
    const encoded = encodeURIComponent(file.original_name);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encoded + '"; filename*=UTF-8\'\'' + encoded);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.directory(bundleDir, false);
    archive.on('end', () => res.end());
    archive.pipe(res);
    return archive.finalize().catch(e => {
      logger.error({ type: 'app', message: 'bundle 打包失败', error: e.message });
      if (!res.headersSent) res.status(500).json({ error: '打包失败' });
    });
  }
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  const encoded = encodeURIComponent(file.original_name);
  res.setHeader('Content-Disposition', 'attachment; filename="' + encoded + '"; filename*=UTF-8\'\'' + encoded);
  // 去掉同步 existsSync 预检：sendFile 找不到文件时走 errback 返回 404
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: '文件已丢失' });
      logger.error({ type: 'app', message: '下载失败', error: err.message });
      return res.status(500).json({ error: '下载失败' });
    }
  });
});

// --- 覆盖上传端点（预览页专用） ---
router.post('/:id/overwrite', requireAuth, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  req.file.originalname = decodeFilename(req.file.originalname);
  const ext = path.extname(req.file.originalname).toLowerCase();
  let fileType = 'html';
  if (ext === '.md' || ext === '.markdown') fileType = 'markdown';

  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    // 校验文件类型
    if (file.file_type !== fileType) {
      await unlinkQuiet(path.join(UPLOAD_DIR, req.file.filename));
      return res.status(400).json({ error: '文件类型不匹配' });
    }

    // 计算版本号
    const verRow = await dbGet(
      'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
      [file.id]
    );
    const nextVer = verRow.nextVer;

    // 备份当前版本
    await dbRun(
      'INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
      [file.id, nextVer, file.stored_name, file.size, file.uploaded_by]
    );

    // 更新 files 主记录
    await dbRun(
      'UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?',
      [req.file.filename, req.file.size, now(), file.id]
    );

    // FTS 索引同步
    if (isFtsIndexable(fileType, req.file.filename)) {
      indexFileContent(file.id, req.file.filename);
    }

    logger.audit('file.overwrite', { fileId: file.id, fileName: file.original_name, version: nextVer + 1, fileType, size: req.file.size, ip: clientIp(req) });
    res.json({
      id: file.id,
      overwritten: true,
      version: nextVer + 1,
      original_name: file.original_name,
      file_type: fileType,
      size: req.file.size,
      is_public: file.is_public,
      share_key: file.share_key
    });
  } catch (e) {
    res.status(500).json({ error: '覆盖上传失败' });
  }
});

router.post('/:id/overwrite-json', requireAuth, uploadLimiter, largeJson, async (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });

  let storedName;
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const size = Buffer.byteLength(content, 'utf-8');
    if (size > 50 * 1024 * 1024) return res.status(400).json({ error: '文件大小超过50MB限制' });

    const ext = file.file_type === 'markdown' ? '.md' : '.html';
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    storedName = unique + ext;
    const filePath = path.join(UPLOAD_DIR, storedName);

    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
    } catch (e) {
      logger.error({ type: 'app', message: '写入文件失败', error: e.message });
      return res.status(500).json({ error: '写入文件失败' });
    }

    // 计算版本号
    const verRow = await dbGet(
      'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
      [file.id]
    );
    const nextVer = verRow.nextVer;

    // 备份当前版本
    await dbRun(
      'INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
      [file.id, nextVer, file.stored_name, file.size, file.uploaded_by]
    );

    // 更新 files 主记录
    await dbRun(
      'UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?',
      [storedName, size, now(), file.id]
    );

    // FTS 索引同步
    if (isFtsIndexable(file.file_type, storedName)) {
      indexFileContent(file.id, storedName);
    }

    logger.audit('file.overwrite', { fileId: file.id, fileName: file.original_name, version: nextVer + 1, fileType: file.file_type, size, ip: clientIp(req) });
    res.json({
      id: file.id,
      overwritten: true,
      version: nextVer + 1,
      original_name: file.original_name,
      file_type: file.file_type,
      size,
      is_public: file.is_public,
      share_key: file.share_key
    });
  } catch (e) {
    if (storedName) { await unlinkQuiet(path.join(UPLOAD_DIR, storedName)); }
    res.status(500).json({ error: '覆盖上传失败' });
  }
});

// --- 版本历史 ---
router.get('/:id/versions', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT id, size, updated_at FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const versions = await dbAll(
      'SELECT id, version, size, created_at FROM file_versions WHERE file_id = ? ORDER BY version DESC',
      [req.params.id]
    );

    res.json({
      file_id: file.id,
      current: { size: file.size, updated_at: file.updated_at },
      versions
    });
  } catch (e) {
    res.status(500).json({ error: '获取版本列表失败' });
  }
});

router.get('/:id/versions/:ver/content', requireAuth, async (req, res) => {
  try {
    const ver = await dbGet(
      'SELECT * FROM file_versions WHERE file_id = ? AND version = ?',
      [req.params.id, req.params.ver]
    );
    if (!ver) return res.status(404).json({ error: '版本不存在' });

    const filePath = path.join(UPLOAD_DIR, ver.stored_name);

    const file = await dbGet('SELECT original_name, file_type, uploaded_by FROM files WHERE id = ?', [req.params.id]);
    if (req.userRole !== 'admin' && file?.uploaded_by !== req.userId) {
      return res.status(403).json({ error: '无权读取此文件原文' });
    }
    let content;
    try {
      content = await fs.promises.readFile(filePath, 'utf-8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return res.status(404).json({ error: '版本文件已丢失' });
      throw e;
    }
    res.json({
      id: parseInt(req.params.id),
      version: ver.version,
      original_name: file?.original_name,
      file_type: file?.file_type,
      content
    });
  } catch (e) {
    res.status(500).json({ error: '读取版本内容失败' });
  }
});

router.get('/:id/versions/:ver/render', requireAuth, async (req, res) => {
  try {
    const ver = await dbGet(
      'SELECT * FROM file_versions WHERE file_id = ? AND version = ?',
      [req.params.id, req.params.ver]
    );
    if (!ver) return res.status(404).json({ error: '版本不存在' });

    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    // 构造一个 file-like 对象，使用历史版本的 stored_name
    const versionFile = { ...file, stored_name: ver.stored_name };
    await renderFile(res, versionFile);
  } catch (e) {
    res.status(500).json({ error: '渲染版本失败' });
  }
});

router.post('/:id/versions/:ver/restore', requireAuth, async (req, res) => {
  let newStoredName;
  try {
    const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const targetVer = await dbGet(
      'SELECT * FROM file_versions WHERE file_id = ? AND version = ?',
      [req.params.id, req.params.ver]
    );
    if (!targetVer) return res.status(404).json({ error: '版本不存在' });

    // 读取目标版本文件内容
    const targetPath = path.join(UPLOAD_DIR, targetVer.stored_name);
    let targetContent;
    try {
      targetContent = await fs.promises.readFile(targetPath, 'utf-8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return res.status(404).json({ error: '版本文件已丢失' });
      throw e;
    }

    // 复制到新磁盘文件
    const ext = file.file_type === 'markdown' ? '.md' : '.html';
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    newStoredName = unique + ext;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, newStoredName), targetContent, 'utf-8');

    // 当前版本备份到 file_versions
    const verRow = await dbGet(
      'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
      [file.id]
    );
    const nextVer = verRow.nextVer;
    await dbRun(
      'INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
      [file.id, nextVer, file.stored_name, file.size, currentUserId(req)]
    );

    // 更新 files 主记录
    const newSize = Buffer.byteLength(targetContent, 'utf-8');
    await dbRun(
      'UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?',
      [newStoredName, newSize, now(), file.id]
    );

    logger.audit('file.restore', { fileId: file.id, fileName: file.original_name, restoredVersion: parseInt(req.params.ver), newVersion: nextVer + 1, ip: clientIp(req) });
    res.json({
      success: true,
      id: file.id,
      version: nextVer + 1,
      restored_from: parseInt(req.params.ver),
      size: newSize
    });
  } catch (e) {
    if (newStoredName) { await unlinkQuiet(path.join(UPLOAD_DIR, newStoredName)); }
    res.status(500).json({ error: '恢复版本失败' });
  }
});

router.delete('/:id/versions/:ver', requireAuth, async (req, res) => {
  try {
    const ver = await dbGet(
      'SELECT * FROM file_versions WHERE file_id = ? AND version = ?',
      [req.params.id, req.params.ver]
    );
    if (!ver) return res.status(404).json({ error: '版本不存在' });

    // 删除磁盘文件
    const filePath = path.join(UPLOAD_DIR, ver.stored_name);
    if (fs.existsSync(filePath)) await unlinkQuiet(filePath);

    // 删除版本记录
    await dbRun('DELETE FROM file_versions WHERE id = ?', [ver.id]);

    logger.audit('file.version.delete', { fileId: parseInt(req.params.id), version: parseInt(req.params.ver), ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '删除版本失败' });
  }
});

// --- 标签关联 ---
router.put('/:id/tags', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT id FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (!checkFileOwnership(req, file)) return res.status(403).json({ error: '无权操作此文件' });
    const { tagIds } = req.body || {};
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: 'tagIds 必须是数组' });
    await dbRun('DELETE FROM file_tags WHERE file_id = ?', [req.params.id]);
    for (const tid of tagIds) {
      await dbRun('INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)', [req.params.id, tid]);
    }
    res.json({ success: true });
    logger.audit('file.updateTags', { fileId: req.params.id, tagIds, ip: clientIp(req) });
  } catch (e) {
    res.status(500).json({ error: '更新标签失败' });
  }
});

// --- 收藏 ---
router.post('/:id/star', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT id FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    await dbRun('INSERT OR IGNORE INTO starred_files (user_id, file_id) VALUES (?, ?)', [req.userId, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '收藏失败' });
  }
});

router.delete('/:id/star', requireAuth, async (req, res) => {
  try {
    await dbRun('DELETE FROM starred_files WHERE user_id = ? AND file_id = ?', [req.userId, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '取消收藏失败' });
  }
});

// --- 分类设置 ---
router.put('/:id/category', requireAuth, async (req, res) => {
  const { categoryId } = req.body || {};
  try {
    const file = await dbGet('SELECT id, uploaded_by FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (req.userRole !== 'admin' && file.uploaded_by !== req.userId) {
      return res.status(403).json({ error: '无权操作' });
    }
    await dbRun('UPDATE files SET category_id = ? WHERE id = ?', [categoryId || null, req.params.id]);
    logger.audit('file.setCategory', { fileId: parseInt(req.params.id), categoryId: categoryId || null, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '设置分类失败' });
  }
});

// --- 访问统计 ---
router.get('/:id/stats', requireAuth, async (req, res) => {
  try {
    const file = await dbGet('SELECT id, uploaded_by, view_count FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (req.userRole !== 'admin' && file.uploaded_by !== req.userId) {
      return res.status(403).json({ error: '无权访问' });
    }
    const [daily7, daily30] = await Promise.all([
      dbAll(
        "SELECT date(visited_at) as date, COUNT(*) as count FROM link_visits WHERE file_id = ? AND visited_at > datetime('now','-7 days') GROUP BY date(visited_at) ORDER BY date",
        [file.id]
      ),
      dbAll(
        "SELECT date(visited_at) as date, COUNT(*) as count FROM link_visits WHERE file_id = ? AND visited_at > datetime('now','-30 days') GROUP BY date(visited_at) ORDER BY date",
        [file.id]
      )
    ]);
    res.json({ viewCount: (file.view_count || 0) + getPendingViewCount(file.id), daily7, daily30 });
  } catch (e) {
    res.status(500).json({ error: '获取统计失败' });
  }
});

module.exports = router;
