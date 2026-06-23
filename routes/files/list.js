// 文件列表 + 全文搜索路由。
// 从 routes/files.js 提取，行为保持不变。挂在共享 router 上。
// 注意：路由注册顺序敏感 —— `/` 和 `/search` 必须在 `/:id` 之前注册，
// 否则 `/:id` 会吞掉这些静态路径。聚合器 routes/files/index.js 按序调用。

const { dbGet, dbAll } = require('../../lib/db');
const { requireAuth } = require('../../lib/middleware/auth');
const { getCategoryName } = require('../../lib/categories');
const { escapeFtsQuery } = require('../../lib/fts');
const logger = require('../../logger');

function registerList(router) {
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

      // 排序参数（白名单校验，防 SQL 注入）
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
      const sql = `SELECT f.id, f.original_name, f.file_type, f.size, f.is_public, f.created_at, f.updated_at, f.share_key, f.category_id, f.uploaded_by, f.is_bundle, f.entry_path, f.view_count, f.template_id, f.share_expires_at, (f.share_password_hash IS NOT NULL) AS has_share_password,
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
        'SELECT f.id, f.original_name, f.file_type, f.size, f.is_public, f.created_at, f.updated_at, f.share_key, f.category_id, f.uploaded_by, f.is_bundle, f.entry_path, f.view_count, f.share_expires_at, (f.share_password_hash IS NOT NULL) AS has_share_password, ' +
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
}

module.exports = { registerList };
