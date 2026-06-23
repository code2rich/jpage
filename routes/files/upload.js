// 上传路由：multipart / JSON / ZIP(base64)。同名文件自动覆盖并保留版本历史。
// 从 routes/files.js 提取，行为保持不变。挂在共享 router 上。
// 注册顺序：必须在 `/:id` 系列之前注册。

const fs = require('fs');
const path = require('path');
const { dbGet, dbRun } = require('../../lib/db');
const { requireAuth } = require('../../lib/middleware/auth');
const { now, unlinkQuiet, generateShareKey, currentUserId, clientIp, decodeFilename, resolveUploadSource } = require('../../lib/util');
const { UPLOAD_DIR } = require('../../lib/paths');
const { isFtsIndexable, indexFileContent } = require('../../lib/fts');
const { handleZipUpload, translateZipError } = require('../../lib/zip');
const { uploadLimiter, upload, largeJson, MAX_FILE_SIZE, ALLOWED_TEXT_EXTS, backupAndApplyVersion } = require('./_shared');
const logger = require('../../logger');

function registerUpload(router) {
  // --- multipart 上传 ---
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
    const source = resolveUploadSource(req);
    try {
      // 检查同名文件（按用户隔离：同名只在当前用户命名空间内匹配，
      // 不会命中其他用户的同名记录，避免跨用户覆盖）
      const existing = await dbGet(
        'SELECT id, stored_name, size, uploaded_by, file_type, is_public FROM files WHERE original_name = ? AND uploaded_by = ?',
        [req.file.originalname, currentUserId(req)]
      );

      if (existing) {
        // 同名文件：校验文件类型
        if (existing.file_type !== fileType) {
          // 类型不匹配，清理已上传的文件，拒绝覆盖
          await unlinkQuiet(path.join(UPLOAD_DIR, req.file.filename));
          return res.status(400).json({ error: '文件类型不匹配' });
        }

        // 备份当前版本并更新主记录（新文件已由 multer 写入磁盘）
        // performedBy = currentUserId：记录触发本次覆盖的操作者（审计用）
        const { version } = await backupAndApplyVersion(
          existing,
          { storedName: req.file.filename, size: req.file.size },
          existing.uploaded_by,
          source,
          currentUserId(req)
        );

        // FTS 索引同步
        if (isFtsIndexable(fileType, req.file.filename)) {
          indexFileContent(existing.id, req.file.filename);
        }

        const shareKey = await dbGet('SELECT share_key FROM files WHERE id = ?', [existing.id]).then(r => r?.share_key);
        logger.audit('file.overwrite', { fileId: existing.id, fileName: req.file.originalname, version, fileType, size: req.file.size, userId: currentUserId(req), ip: clientIp(req) });
        return res.json({
          id: existing.id,
          overwritten: true,
          version,
          original_name: req.file.originalname,
          file_type: fileType,
          size: req.file.size,
          is_public: existing.is_public,
          share_key: shareKey
        });
      }

      // 不存在同名文件：新建
      const result = await dbRun(
        'INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by, share_key, upload_source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [req.file.originalname, req.file.filename, fileType, req.file.size, isPublic ? 1 : 0, currentUserId(req), generateShareKey(), source, now()]
      );
      // FTS 索引同步
      if (isFtsIndexable(fileType, req.file.filename)) {
        indexFileContent(result.lastID, req.file.filename);
      }
      const shareKey = await dbGet('SELECT share_key FROM files WHERE id = ?', [result.lastID]).then(r => r?.share_key);
      logger.audit('file.upload', { fileId: result.lastID, fileName: req.file.originalname, fileType, size: req.file.size, userId: currentUserId(req), ip: clientIp(req) });
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

  // --- JSON 上传 ---
  router.post('/upload-json', requireAuth, uploadLimiter, largeJson, async (req, res) => {
    const { name, content, isPublic } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: '文件名不能为空' });
    if (typeof content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });
    const decoded = decodeFilename(name.trim());
    const ext = path.extname(decoded).toLowerCase();
    if (!ALLOWED_TEXT_EXTS.includes(ext)) return res.status(400).json({ error: '仅支持 HTML 和 Markdown 文件' });
    const size = Buffer.byteLength(content, 'utf-8');
    if (size > MAX_FILE_SIZE) return res.status(400).json({ error: '文件大小超过50MB限制' });
    const fileType = (ext === '.md' || ext === '.markdown') ? 'markdown' : 'html';
    const source = resolveUploadSource(req);
    const { generateStoredName } = require('./_shared');
    const storedName = generateStoredName(ext);
    const filePath = path.join(UPLOAD_DIR, storedName);
    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
    } catch (e) {
      logger.error({ type: 'app', message: '写入文件失败', error: e.message });
      return res.status(500).json({ error: '写入文件失败' });
    }

    // 检查同名文件（按用户隔离，理由同 multipart /upload）
    const existing = await dbGet(
      'SELECT id, stored_name, size, uploaded_by, file_type, is_public, share_key FROM files WHERE original_name = ? AND uploaded_by = ?',
      [decoded, currentUserId(req)]
    ).catch(() => null);

    if (existing) {
      // 同名文件：校验文件类型
      if (existing.file_type !== fileType) {
        await unlinkQuiet(filePath);
        return res.status(400).json({ error: '文件类型不匹配' });
      }

      try {
        const { version } = await backupAndApplyVersion(
          existing,
          { storedName, size },
          existing.uploaded_by,
          source,
          currentUserId(req)
        );

        // FTS 索引同步
        if (isFtsIndexable(fileType, storedName)) {
          indexFileContent(existing.id, storedName);
        }

        logger.audit('file.overwrite', { fileId: existing.id, fileName: decoded, version, fileType, size, userId: currentUserId(req), ip: clientIp(req) });
        return res.json({
          id: existing.id,
          overwritten: true,
          version,
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
        'INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by, share_key, upload_source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [decoded, storedName, fileType, size, isPublicFlag, currentUserId(req), generateShareKey(), source, now()]
      );
      // FTS 索引同步
      if (isFtsIndexable(fileType, storedName)) {
        indexFileContent(result.lastID, storedName);
      }
      const shareKey = await dbGet('SELECT share_key FROM files WHERE id = ?', [result.lastID]).then(r => r?.share_key);
      logger.audit('file.upload', { fileId: result.lastID, fileName: decoded, fileType, size, userId: currentUserId(req), ip: clientIp(req) });
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

  // --- ZIP(base64) 上传 ---
  router.post('/upload-zip-base64', requireAuth, uploadLimiter, largeJson, async (req, res) => {
    const { name, content, isPublic } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: '文件名不能为空' });
    if (typeof content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });
    const ext = path.extname(name).toLowerCase();
    if (ext !== '.zip') return res.status(400).json({ error: '仅支持 ZIP 文件' });
    try {
      const zipBuffer = Buffer.from(content, 'base64');
      if (zipBuffer.length > MAX_FILE_SIZE) return res.status(400).json({ error: 'ZIP 文件超过50MB限制' });
      req.file = { originalname: decodeFilename(name) };
      req.body.isPublic = isPublic;
      return await handleZipUpload(req, res, zipBuffer);
    } catch (e) {
      // handleZipUpload 已自行响应业务错误；这里仅捕获 base64 解码等前置异常。
      if (res.headersSent) return;
      logger.error({ type: 'app', action: 'zip.base64', error: e.message });
      const friendly = e.isUserError ? e.message : translateZipError(e);
      return res.status(e.statusCode || 500).json({ error: friendly });
    }
  });
}

module.exports = { registerUpload };
