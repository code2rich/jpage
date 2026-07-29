// 按 ID 覆盖上传（预览页专用）：multipart / JSON。自动保留版本历史。
// 从 routes/files.js 提取。覆盖前校验所有权（admin 或所有者），避免任意登录用户
// 拿到公开文件 id 即可覆盖他人文件。挂在共享 router 上。

const fs = require('fs');
const path = require('path');
const { dbGet } = require('../../lib/db');
const { requireAuth } = require('../../lib/middleware/auth');
const { unlinkQuiet, clientIp, decodeFilename, resolveUploadSource, currentUserId } = require('../../lib/util');
const { UPLOAD_DIR } = require('../../lib/paths');
const { isFtsIndexable, indexFileContent } = require('../../lib/fts');
const { uploadLimiter, upload, largeJson, MAX_FILE_SIZE, backupAndApplyVersion } = require('./_shared');
const { checkFileOwnership } = require('../../lib/middleware/files');
const { handleZipUpload, translateZipError } = require('../../lib/zip');
const logger = require('../../logger');

function registerOverwrite(router) {
  // --- multipart 覆盖 ---
  router.post('/:id/overwrite', requireAuth, uploadLimiter, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '未上传文件' });
    req.file.originalname = decodeFilename(req.file.originalname);
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === '.zip') {
      try {
        const zipBuffer = await fs.promises.readFile(req.file.path);
        await unlinkQuiet(req.file.path);
        return handleZipUpload(req, res, zipBuffer, { targetFileId: req.params.id });
      } catch (e) {
        await unlinkQuiet(req.file.path);
        if (res.headersSent) return;
        logger.error({ type: 'app', action: 'zip.overwrite', error: e.message });
        return res.status(e.statusCode || 500).json({
          error: e.isUserError ? e.message : translateZipError(e)
        });
      }
    }
    let fileType = 'html';
    if (ext === '.md' || ext === '.markdown') fileType = 'markdown';
    const source = resolveUploadSource(req);

    try {
      const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
      if (!file) {
        await unlinkQuiet(path.join(UPLOAD_DIR, req.file.filename));
        return res.status(404).json({ error: '文件不存在' });
      }
      if (!checkFileOwnership(req, file)) {
        await unlinkQuiet(path.join(UPLOAD_DIR, req.file.filename));
        return res.status(403).json({ error: '无权操作此文件' });
      }
      if (file.is_bundle) {
        await unlinkQuiet(path.join(UPLOAD_DIR, req.file.filename));
        return res.status(400).json({ error: 'ZIP 网站包只能使用 ZIP 文件覆盖' });
      }

      // 校验文件类型
      if (file.file_type !== fileType) {
        await unlinkQuiet(path.join(UPLOAD_DIR, req.file.filename));
        return res.status(400).json({ error: '文件类型不匹配' });
      }

      const { version } = await backupAndApplyVersion(
        file,
        { storedName: req.file.filename, size: req.file.size },
        file.uploaded_by,
        source,
        currentUserId(req)
      );

      // FTS 索引同步
      if (isFtsIndexable(fileType, req.file.filename)) {
        indexFileContent(file.id, req.file.filename);
      }

      logger.audit('file.overwrite', { fileId: file.id, fileName: file.original_name, version, fileType, size: req.file.size, userId: currentUserId(req), ip: clientIp(req) });
      res.json({
        id: file.id,
        overwritten: true,
        version,
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

  // --- ZIP(base64) 显式覆盖 ---
  router.post('/:id/overwrite-zip-base64', requireAuth, uploadLimiter, largeJson, async (req, res) => {
    const { name, content } = req.body || {};
    if (typeof name !== 'string' || path.extname(name).toLowerCase() !== '.zip') {
      return res.status(400).json({ error: '仅支持 ZIP 文件' });
    }
    if (typeof content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });
    try {
      const zipBuffer = Buffer.from(content, 'base64');
      if (zipBuffer.length > MAX_FILE_SIZE) return res.status(400).json({ error: 'ZIP 文件超过50MB限制' });
      req.file = { originalname: decodeFilename(name) };
      return handleZipUpload(req, res, zipBuffer, { targetFileId: req.params.id });
    } catch (e) {
      if (res.headersSent) return;
      logger.error({ type: 'app', action: 'zip.overwrite.base64', error: e.message });
      return res.status(e.statusCode || 500).json({
        error: e.isUserError ? e.message : translateZipError(e)
      });
    }
  });

  // --- JSON 覆盖 ---
  router.post('/:id/overwrite-json', requireAuth, uploadLimiter, largeJson, async (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });

    let storedName;
    try {
      const file = await dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]);
      if (!file) return res.status(404).json({ error: '文件不存在' });
      if (!checkFileOwnership(req, file)) return res.status(403).json({ error: '无权操作此文件' });
      if (file.is_bundle) return res.status(400).json({ error: 'ZIP 网站包只能使用 ZIP 文件覆盖' });

      const size = Buffer.byteLength(content, 'utf-8');
      if (size > MAX_FILE_SIZE) return res.status(400).json({ error: '文件大小超过50MB限制' });

      const ext = file.file_type === 'markdown' ? '.md' : '.html';
      const { generateStoredName } = require('./_shared');
      storedName = generateStoredName(ext);
      const filePath = path.join(UPLOAD_DIR, storedName);

      try {
        await fs.promises.writeFile(filePath, content, 'utf-8');
      } catch (e) {
        logger.error({ type: 'app', message: '写入文件失败', error: e.message });
        return res.status(500).json({ error: '写入文件失败' });
      }

      const { version } = await backupAndApplyVersion(
        file,
        { storedName, size },
        file.uploaded_by,
        resolveUploadSource(req),
        currentUserId(req)
      );

      // FTS 索引同步
      if (isFtsIndexable(file.file_type, storedName)) {
        indexFileContent(file.id, storedName);
      }

      logger.audit('file.overwrite', { fileId: file.id, fileName: file.original_name, version, fileType: file.file_type, size, userId: currentUserId(req), ip: clientIp(req) });
      res.json({
        id: file.id,
        overwritten: true,
        version,
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
}

module.exports = { registerOverwrite };
