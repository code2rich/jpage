// 更新 / 删除 / 批量操作路由。
// 从 routes/files.js 提取，行为保持不变。挂在共享 router 上。

const fs = require('fs');
const path = require('path');
const { dbGet, dbRun, dbAll } = require('../../lib/db');
const { requireAuth } = require('../../lib/middleware/auth');
const { unlinkQuiet, clientIp } = require('../../lib/util');
const { UPLOAD_DIR } = require('../../lib/paths');
const { deleteFileIndex } = require('../../lib/fts');
const { invalidateRenderCache } = require('../../lib/render-cache');
const { checkFileOwnership } = require('../../lib/middleware/files');
const { subtractFileStorage } = require('../../lib/usage');
const logger = require('../../logger');

function registerCrud(router) {
  // --- 更新 ---
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
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed) return res.status(400).json({ error: '文件名不能为空' });
        // 改名按用户隔离同名：目标名若已被文件归属者的其他文件占用则拒绝，
        // 与上传同名隔离保持一致（每用户命名空间内文件名唯一）。
        const dup = await dbGet(
          'SELECT id FROM files WHERE original_name = ? AND uploaded_by = ? AND id != ?',
          [trimmed, file.uploaded_by, file.id]
        );
        if (dup) return res.status(409).json({ error: '该名称下已存在同名文件' });
        await dbRun('UPDATE files SET original_name = ? WHERE id = ?', [trimmed, req.params.id]);
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

  // --- 删除 ---
  router.delete('/:id', requireAuth, async (req, res) => {
    try {
      const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
      if (!file) return res.status(404).json({ error: '文件不存在' });
      if (!checkFileOwnership(req, file)) return res.status(403).json({ error: '无权操作此文件' });

      // 清理关联数据
      await dbRun('DELETE FROM file_tags WHERE file_id = ?', [req.params.id]);
      await dbRun('DELETE FROM starred_files WHERE file_id = ?', [req.params.id]);
      await deleteFileIndex(req.params.id);

      // 扣减用户存储量（含历史版本）
      await subtractFileStorage(file);

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
        // 扣减各文件所有者存储量（在事务外执行，避免统计写失败阻塞删除）
        for (const f of files) {
          await subtractFileStorage({ id: f.id, size: f.size, uploaded_by: f.uploaded_by });
        }

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
}

module.exports = { registerCrud };
