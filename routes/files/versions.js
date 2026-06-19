// 版本历史路由：列表 / 内容 / 渲染 / 恢复 / 删除单版本。
// 从 routes/files.js 提取，行为保持不变。挂在共享 router 上。

const fs = require('fs');
const path = require('path');
const { dbGet, dbAll, dbRun } = require('../../lib/db');
const { requireAuth } = require('../../lib/middleware/auth');
const { unlinkQuiet, currentUserId, clientIp } = require('../../lib/util');
const { UPLOAD_DIR } = require('../../lib/paths');
const { renderFile } = require('../../lib/render');
const { generateStoredName, backupAndApplyVersion } = require('./_shared');
const logger = require('../../logger');

function registerVersions(router) {
  // --- 版本列表 ---
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

  // --- 版本内容（原文） ---
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

  // --- 版本渲染 ---
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

  // --- 恢复历史版本 ---
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
      newStoredName = generateStoredName(ext);
      await fs.promises.writeFile(path.join(UPLOAD_DIR, newStoredName), targetContent, 'utf-8');

      // 当前版本备份并更新主记录。
      // 注意：restore 记录的是执行恢复的用户（currentUserId），与 upload/overwrite
      // 记录 file.uploaded_by（原始上传者）的语义不同，此处刻意保留原行为。
      const newSize = Buffer.byteLength(targetContent, 'utf-8');
      const { version } = await backupAndApplyVersion(
        file,
        { storedName: newStoredName, size: newSize },
        currentUserId(req)
      );

      logger.audit('file.restore', { fileId: file.id, fileName: file.original_name, restoredVersion: parseInt(req.params.ver), newVersion: version, ip: clientIp(req) });
      res.json({
        success: true,
        id: file.id,
        version,
        restored_from: parseInt(req.params.ver),
        size: newSize
      });
    } catch (e) {
      if (newStoredName) { await unlinkQuiet(path.join(UPLOAD_DIR, newStoredName)); }
      res.status(500).json({ error: '恢复版本失败' });
    }
  });

  // --- 删除单版本 ---
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
}

module.exports = { registerVersions };
