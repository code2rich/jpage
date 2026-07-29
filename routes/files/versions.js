// 版本历史路由：列表 / 内容 / 渲染 / 恢复 / 删除单版本。
// 从 routes/files.js 提取，行为保持不变。挂在共享 router 上。

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { dbGet, dbAll, dbRun } = require('../../lib/db');
const { requireAuth } = require('../../lib/middleware/auth');
const { currentUserId, clientIp, resolveUploadSource } = require('../../lib/util');
const { UPLOAD_DIR } = require('../../lib/paths');
const { renderFile, listBundleEntries } = require('../../lib/render');
const {
  generateStoredName,
  removeStoredObject,
  copyStoredObject,
  backupAndApplyVersion,
  setDownloadHeaders,
  isWithinBundle,
} = require('./_shared');
const { isFtsIndexable, indexFileContent } = require('../../lib/fts');
const { checkFileOwnership } = require('../../lib/middleware/files');
const { addUserStorage } = require('../../lib/usage');
const logger = require('../../logger');

function registerVersions(router) {
  // --- 版本列表 ---
  router.get('/:id/versions', requireAuth, async (req, res) => {
    try {
      const file = await dbGet('SELECT id, size, updated_at FROM files WHERE id = ?', [req.params.id]);
      if (!file) return res.status(404).json({ error: '文件不存在' });

      const versions = await dbAll(
        `SELECT fv.id, fv.version, fv.size, fv.created_at, fv.performed_by,
                fv.is_bundle, fv.entry_path, fv.file_type,
                pu.username AS performed_by_name
         FROM file_versions fv
         LEFT JOIN users pu ON fv.performed_by = pu.id
         WHERE fv.file_id = ? ORDER BY fv.version DESC`,
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
      if (!file) return res.status(404).json({ error: '文件不存在' });

      if (ver.is_bundle) {
        const bundleDir = path.join(UPLOAD_DIR, ver.stored_name);
        const entryPath = path.join(bundleDir, ver.entry_path || 'index.html');
        if (!isWithinBundle(entryPath, bundleDir)) {
          return res.status(403).json({ error: '非法路径' });
        }
        let content;
        try {
          content = await fs.promises.readFile(entryPath, 'utf-8');
        } catch (e) {
          if (e && e.code === 'ENOENT') return res.status(404).json({ error: '版本文件已丢失' });
          throw e;
        }
        const { entries, truncated } = await listBundleEntries(bundleDir);
        return res.json({
          id: parseInt(req.params.id),
          version: ver.version,
          original_name: file.original_name,
          file_type: ver.file_type || file.file_type,
          is_bundle: 1,
          entry_path: ver.entry_path,
          content,
          entries,
          entries_truncated: truncated,
        });
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

      // 构造历史版本的完整 file-like 对象，bundle 依赖入口路径与存储形态。
      const versionFile = {
        ...file,
        stored_name: ver.stored_name,
        size: ver.size,
        file_type: ver.file_type || file.file_type,
        is_bundle: ver.is_bundle ? 1 : 0,
        entry_path: ver.entry_path,
        updated_at: ver.created_at,
        asset_base_path: `/api/files/${file.id}/versions/${ver.version}/asset/`,
      };
      await renderFile(res, versionFile);
    } catch (e) {
      res.status(500).json({ error: '渲染版本失败' });
    }
  });

  // --- bundle 历史版本资源 ---
  router.get('/:id/versions/:ver/asset/*', requireAuth, async (req, res) => {
    try {
      const [file, ver] = await Promise.all([
        dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]),
        dbGet('SELECT * FROM file_versions WHERE file_id = ? AND version = ?', [req.params.id, req.params.ver]),
      ]);
      if (!file) return res.status(404).json({ error: '文件不存在' });
      if (!ver) return res.status(404).json({ error: '版本不存在' });
      if (!ver.is_bundle) return res.status(400).json({ error: '非网站包版本' });
      if (req.userRole !== 'admin' && file.uploaded_by !== req.userId) {
        return res.status(403).json({ error: '无权读取此文件版本' });
      }

      const bundleDir = path.join(UPLOAD_DIR, ver.stored_name);
      const assetPath = path.join(bundleDir, req.params[0]);
      if (!isWithinBundle(assetPath, bundleDir)) return res.status(403).json({ error: '非法路径' });
      const stat = await fs.promises.stat(assetPath).catch(() => null);
      if (!stat || stat.isDirectory()) return res.status(404).json({ error: '资源不存在' });
      return res.sendFile(path.resolve(assetPath));
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: '读取版本资源失败' });
    }
  });

  // --- 历史版本下载 ---
  router.get('/:id/versions/:ver/download', requireAuth, async (req, res) => {
    try {
      const [file, ver] = await Promise.all([
        dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]),
        dbGet('SELECT * FROM file_versions WHERE file_id = ? AND version = ?', [req.params.id, req.params.ver]),
      ]);
      if (!file) return res.status(404).json({ error: '文件不存在' });
      if (!ver) return res.status(404).json({ error: '版本不存在' });
      if (req.userRole !== 'admin' && file.uploaded_by !== req.userId) {
        return res.status(403).json({ error: '无权下载此文件版本' });
      }

      const storedPath = path.join(UPLOAD_DIR, ver.stored_name);
      setDownloadHeaders(res, file.original_name);
      if (ver.is_bundle) {
        res.setHeader('Content-Type', 'application/zip');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.directory(storedPath, false);
        archive.on('error', error => {
          logger.error({ type: 'app', action: 'file.version.download', error: error.message });
          if (!res.headersSent) res.status(500).json({ error: '版本打包失败' });
        });
        archive.pipe(res);
        await archive.finalize();
        return;
      }
      return res.sendFile(storedPath, error => {
        if (error && !res.headersSent) {
          if (error.code === 'ENOENT') return res.status(404).json({ error: '版本文件已丢失' });
          return res.status(500).json({ error: '版本下载失败' });
        }
      });
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: '版本下载失败' });
    }
  });

  // --- 恢复历史版本 ---
  router.post('/:id/versions/:ver/restore', requireAuth, async (req, res) => {
    let newStoredName;
    let newIsBundle = false;
    let versionApplied = false;
    try {
      const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
      if (!file) return res.status(404).json({ error: '文件不存在' });
      if (!checkFileOwnership(req, file)) return res.status(403).json({ error: '无权操作此文件' });

      const targetVer = await dbGet(
        'SELECT * FROM file_versions WHERE file_id = ? AND version = ?',
        [req.params.id, req.params.ver]
      );
      if (!targetVer) return res.status(404).json({ error: '版本不存在' });

      newIsBundle = !!targetVer.is_bundle;
      const targetFileType = targetVer.file_type || file.file_type;
      const ext = newIsBundle ? '' : (targetFileType === 'markdown' ? '.md' : '.html');
      newStoredName = generateStoredName(ext);
      try {
        await copyStoredObject(targetVer.stored_name, newStoredName, newIsBundle);
      } catch (e) {
        if (e && e.code === 'ENOENT') return res.status(404).json({ error: '版本文件已丢失' });
        throw e;
      }

      // 当前版本备份并更新主记录。
      // 注意：restore 记录的是执行恢复的用户（currentUserId），与 upload/overwrite
      // 记录 file.uploaded_by（原始上传者）的语义不同，此处刻意保留原行为。
      const newSize = targetVer.size;
      const { version } = await backupAndApplyVersion(
        file,
        {
          storedName: newStoredName,
          size: newSize,
          fileType: targetFileType,
          isBundle: newIsBundle,
          entryPath: targetVer.entry_path,
        },
        currentUserId(req),
        resolveUploadSource(req),
        currentUserId(req)
      );
      versionApplied = true;
      if (!newIsBundle && isFtsIndexable(targetFileType, newStoredName)) {
        try {
          indexFileContent(file.id, newStoredName);
        } catch (e) {
          logger.error({ type: 'app', action: 'file.restore.index', fileId: file.id, error: e.message });
        }
      }

      logger.audit('file.restore', { fileId: file.id, fileName: file.original_name, restoredVersion: parseInt(req.params.ver), newVersion: version, userId: currentUserId(req), ip: clientIp(req) });
      res.json({
        success: true,
        id: file.id,
        version,
        restored_from: parseInt(req.params.ver),
        size: newSize
      });
    } catch (e) {
      if (newStoredName && !versionApplied) {
        await removeStoredObject(newStoredName, newIsBundle).catch(() => {});
      }
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
      const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
      if (!file) return res.status(404).json({ error: '文件不存在' });
      if (!checkFileOwnership(req, file)) return res.status(403).json({ error: '无权操作此文件' });

      // 删除磁盘文件
      await removeStoredObject(ver.stored_name, ver.is_bundle);

      // 删除版本记录
      await dbRun('DELETE FROM file_versions WHERE id = ?', [ver.id]);
      await addUserStorage(file.uploaded_by, -ver.size);

      logger.audit('file.version.delete', { fileId: parseInt(req.params.id), version: parseInt(req.params.ver), userId: currentUserId(req), ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: '删除版本失败' });
    }
  });
}

module.exports = { registerVersions };
