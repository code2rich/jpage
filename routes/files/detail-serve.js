// 详情 / 原文 / 资源 / 渲染 / 下载 路由。
// 从 routes/files.js 提取，行为保持不变。挂在共享 router 上。
// 注册顺序：在静态路径（/、/search、/upload*）之后，其他 /:id/* 之前。

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { dbAll, dbGet } = require('../../lib/db');
const { requireAuth } = require('../../lib/middleware/auth');
const { loadFileWithPrivacy } = require('../../lib/middleware/files');
const { UPLOAD_DIR } = require('../../lib/paths');
const { listBundleEntries, renderFile } = require('../../lib/render');
const { setDownloadHeaders, isWithinBundle } = require('./_shared');
const logger = require('../../logger');

function registerDetailServe(router) {
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
      if (!isWithinBundle(entryPath, bundleDir)) {
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

  // --- 资源（bundle 内静态文件） ---
  router.get('/:id/asset/*', loadFileWithPrivacy, async (req, res) => {
    const file = req.fileRecord;
    if (!file.is_bundle) return res.status(400).json({ error: '非网站包' });
    const bundleDir = path.resolve(path.join(UPLOAD_DIR, file.stored_name));
    const assetRelative = req.params[0];
    const assetPath = path.resolve(path.join(bundleDir, assetRelative));
    if (!isWithinBundle(assetPath, bundleDir)) {
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

  // --- 渲染 ---
  router.get('/:id/render', loadFileWithPrivacy, async (req, res) => {
    await renderFile(res, req.fileRecord);
  });

  // --- 下载 ---
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
      setDownloadHeaders(res, file.original_name);
      res.setHeader('Content-Type', 'application/zip');
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
    setDownloadHeaders(res, file.original_name);
    // 去掉同步 existsSync 预检：sendFile 找不到文件时走 errback 返回 404
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: '文件已丢失' });
        logger.error({ type: 'app', message: '下载失败', error: err.message });
        return res.status(500).json({ error: '下载失败' });
      }
    });
  });
}

module.exports = { registerDetailServe };
