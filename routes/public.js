// 公开访问接口：无需登录即可使用，当前仅包含首页「粘贴试用」。
// 设计约束：
//   - 严格限流（IP 级），避免被滥用为免费匿名托管。
//   - 内容大小限制在 200KB，仅支持 HTML / Markdown 自动识别。
//   - 生成 10 分钟有效的临时短链，过期后由访问时懒清理 + 启动时全量清理回收。
//   - 匿名文件 uploaded_by 为 NULL，不参与用户存储配额计算。

const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { dbRun, dbAll } = require('../lib/db');
const { UPLOAD_DIR } = require('../lib/paths');
const { now, unlinkQuiet, generateShareKey, clientIp } = require('../lib/util');
const { generateStoredName } = require('./files/_shared');
const { isFtsIndexable, indexFileContent, deleteFileIndex } = require('../lib/fts');
const logger = require('../logger');

const TRY_PASTE_MAX_SIZE = 200 * 1024;          // 200KB
const TRY_PASTE_TTL_MINUTES = 10;               // 10 分钟有效期
const TRY_PASTE_JSON_LIMIT = '300kb';

// IP 级限流：15 分钟内最多 5 次试用请求
const tryPasteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: '试用请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 简单启发式识别：以 < 开头的文本视为 HTML，其余视为 Markdown
function detectPasteType(content) {
  return /^\s*</.test(content) ? 'html' : 'markdown';
}

// 计算过期时间（UTC ISO 字符串，与 now() 格式一致便于比较）
function pasteExpiresAt() {
  return new Date(Date.now() + TRY_PASTE_TTL_MINUTES * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function routerFactory() {
  const router = express.Router();

  // POST /api/public/try-paste
  // Body: { content: string }
  // Response: { id, share_key, file_type, expires_at, url }
  router.post('/try-paste', tryPasteLimiter, express.json({ limit: TRY_PASTE_JSON_LIMIT }), async (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: '内容不能为空' });
    }

    const size = Buffer.byteLength(content, 'utf-8');
    if (size > TRY_PASTE_MAX_SIZE) {
      return res.status(400).json({ error: '内容大小超过 200KB 限制' });
    }

    const fileType = detectPasteType(content);
    const ext = fileType === 'html' ? '.html' : '.md';
    const originalName = `paste-try-${Date.now()}${ext}`;
    const storedName = generateStoredName(ext);
    const filePath = path.join(UPLOAD_DIR, storedName);

    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
    } catch (e) {
      logger.error({ type: 'app', message: '粘贴试用写入文件失败', error: e.message });
      return res.status(500).json({ error: '保存内容失败' });
    }

    const shareKey = generateShareKey();
    const expiresAt = pasteExpiresAt();

    try {
      const result = await dbRun(
        `INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by,
                            share_key, upload_source, share_expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [originalName, storedName, fileType, size, 1, null, shareKey, 'try_paste', expiresAt, now()]
      );

      if (isFtsIndexable(fileType, storedName)) {
        indexFileContent(result.lastID, storedName).catch(() => {});
      }

      logger.audit('file.tryPaste', { fileId: result.lastID, fileType, size, ip: clientIp(req) });

      res.json({
        id: result.lastID,
        share_key: shareKey,
        file_type: fileType,
        expires_at: expiresAt,
        url: `/s/${shareKey}`
      });
    } catch (e) {
      await unlinkQuiet(filePath);
      logger.error({ type: 'app', message: '粘贴试用保存记录失败', error: e.message });
      res.status(500).json({ error: '保存失败' });
    }
  });

  return router;
}

// 清理所有已过期且来源为 try_paste 的临时文件。
// 可被启动流程调用，也可在访问短链时懒执行。
async function cleanupExpiredTryPastes() {
  try {
    const rows = await dbAll(
      `SELECT id, stored_name FROM files
       WHERE upload_source = 'try_paste' AND share_expires_at <= ?`,
      [now()]
    );
    for (const row of rows) {
      await unlinkQuiet(path.join(UPLOAD_DIR, row.stored_name));
      await deleteFileIndex(row.id);
      await dbRun('DELETE FROM files WHERE id = ?', [row.id]);
    }
    if (rows.length > 0) {
      logger.info({ type: 'app', message: '清理过期粘贴试用文件', count: rows.length });
    }
    return rows.length;
  } catch (e) {
    logger.error({ type: 'app', message: '清理过期粘贴试用失败', error: e.message });
    return 0;
  }
}

module.exports = { router: routerFactory(), cleanupExpiredTryPastes };
