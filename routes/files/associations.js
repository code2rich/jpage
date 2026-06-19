// 标签关联 / 收藏 / 分类设置 / 访问统计 路由。
// 从 routes/files.js 提取，行为保持不变。挂在共享 router 上。

const { dbGet, dbRun, dbAll } = require('../../lib/db');
const { requireAuth } = require('../../lib/middleware/auth');
const { checkFileOwnership } = require('../../lib/middleware/files');
const { clientIp } = require('../../lib/util');
const { getPendingViewCount } = require('../../lib/view-counts');
const logger = require('../../logger');

function registerAssociations(router) {
  // --- 标签关联（替换文件的全部标签） ---
  router.put('/:id/tags', requireAuth, async (req, res) => {
    try {
      const file = await dbGet('SELECT id, uploaded_by FROM files WHERE id = ?', [req.params.id]);
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
}

module.exports = { registerAssociations };
