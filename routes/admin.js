// 管理员路由：数据备份导出 / 导入恢复 / 存储统计。从 server.js 提取，行为保持不变。
// 挂载点：/api/admin

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const archiver = require('archiver');
const JSZip = require('jszip');
const sqlite3 = require('sqlite3').verbose();
const { getDb, dbGet, dbAll, configureDatabase, resetDb } = require('../lib/db');
const { DATA_DIR, UPLOAD_DIR } = require('../lib/paths');
const { requireAuth, requireAdmin } = require('../lib/middleware/auth');
const { clientIp } = require('../lib/util');
const { loadTemplateNameMap } = require('../lib/templates');
const { reloadCategoryNameCache } = require('../lib/categories');
const { clearRenderCache } = require('../lib/render-cache');
const { recalculateAllUsersStorage } = require('../lib/usage');
const logger = require('../logger');

const router = express.Router();

// 用于 import 的独立 multer 实例（不限文件类型）
const adminUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DATA_DIR),
    filename: (req, file, cb) => cb(null, 'import-' + Date.now() + '.zip')
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
});

function createBackupArchive() {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const db = getDb();
  db.run('PRAGMA wal_checkpoint(FULL)', (err) => {
    if (err) logger.warn({ type: 'app', message: 'WAL checkpoint 失败', error: err.message });
  });
  archive.file(path.join(DATA_DIR, 'database.sqlite'), { name: 'database.sqlite' });
  const sessionFile = path.join(DATA_DIR, 'sessions.sqlite');
  if (fs.existsSync(sessionFile)) archive.file(sessionFile, { name: 'sessions.sqlite' });
  if (fs.existsSync(UPLOAD_DIR)) archive.directory(UPLOAD_DIR, 'uploads');
  return archive;
}

router.get('/export', requireAuth, requireAdmin, (req, res) => {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const fname = `jpage-backup-${date}.zip`;
    const encoded = encodeURIComponent(fname);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
    const archive = createBackupArchive();
    archive.on('end', () => res.end());
    archive.pipe(res);
    archive.finalize().catch(e => {
      logger.error({ type: 'app', message: '备份导出失败', error: e.message });
      if (!res.headersSent) res.status(500).json({ error: '导出失败' });
    });
    logger.audit('backup.export', { ip: clientIp(req) });
  } catch (e) {
    res.status(500).json({ error: '导出失败' });
  }
});

router.post('/import', requireAuth, requireAdmin, adminUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 ZIP 文件' });
  const zipPath = req.file.path;
  try {
    const zipBuf = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipBuf);
    if (!zip.file('database.sqlite')) {
      fs.unlinkSync(zipPath);
      return res.status(400).json({ error: '无效的备份文件：缺少 database.sqlite' });
    }
    const backupDate = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = path.join(path.dirname(DATA_DIR), `data-backup-${backupDate}`);
    fs.cpSync(DATA_DIR, backupDir, { recursive: true });
    logger.info({ type: 'app', message: '导入前备份已创建', backupDir });
    // 清理业务数据与上传目录，保留会话库与 token 加密密钥，
    // 避免 express-session 的 SQLiteStore 因文件被删而只读报错。
    const keepEntries = new Set(['sessions.sqlite', 'token-key.key']);
    for (const entry of fs.readdirSync(DATA_DIR)) {
      if (keepEntries.has(entry)) continue;
      fs.rmSync(path.join(DATA_DIR, entry), { recursive: true, force: true });
    }
    for (const [relPath, entry] of Object.entries(zip.files)) {
      if (entry.dir) {
        fs.mkdirSync(path.join(DATA_DIR, relPath), { recursive: true });
      } else {
        const buf = await entry.async('nodebuffer');
        const filePath = path.join(DATA_DIR, relPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buf);
      }
    }
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    // 导入替换数据库连接：通过 lib/db 的 resetDb 安全切换，
    // Proxy 保证所有已持有 getDb() 引用的模块继续使用新连接。
    const newDb = new sqlite3.Database(path.join(DATA_DIR, 'database.sqlite'));
    await resetDb(newDb);
    // 导入替换了连接：重新应用性能 PRAGMA 与刷新分类缓存
    await configureDatabase();
    await loadTemplateNameMap();
    await reloadCategoryNameCache();
    clearRenderCache();
    await recalculateAllUsersStorage();
    logger.audit('backup.import', { ip: clientIp(req), backupDir });
    res.json({ success: true, message: '数据已恢复，建议刷新页面重新加载' });
  } catch (e) {
    logger.error({ type: 'app', message: '数据导入失败', error: e.message });
    res.status(500).json({ error: '导入失败: ' + e.message });
  } finally {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  }
});

router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const fileCount = await dbGet('SELECT COUNT(*) AS c FROM files');
    let dbSize = 0;
    const dbPath = path.join(DATA_DIR, 'database.sqlite');
    if (fs.existsSync(dbPath)) dbSize = fs.statSync(dbPath).size;
    let uploadsSize = 0;
    if (fs.existsSync(UPLOAD_DIR)) {
      for (const f of fs.readdirSync(UPLOAD_DIR)) {
        const s = fs.statSync(path.join(UPLOAD_DIR, f));
        if (s.isFile()) uploadsSize += s.size;
      }
    }

    const userCount = await dbGet('SELECT COUNT(*) AS c FROM users');
    const totalStorage = await dbGet('SELECT COALESCE(SUM(total_storage_bytes), 0) AS total FROM users');
    const totalViews = await dbGet('SELECT COALESCE(SUM(view_count), 0) AS total FROM files');
    const totalApiCalls = await dbGet('SELECT COUNT(*) AS c FROM api_calls');
    const sourceRows = await dbAll('SELECT source, COUNT(*) AS count FROM api_calls GROUP BY source');
    const apiCallsBySource = {};
    for (const row of sourceRows) {
      apiCallsBySource[row.source || 'unknown'] = row.count;
    }

    res.json({
      fileCount: fileCount.c,
      dbSize,
      uploadsSize,
      totalSize: dbSize + uploadsSize,
      userCount: userCount.c,
      totalStorageBytes: totalStorage.total,
      totalShortLinkViews: totalViews.total,
      totalApiCalls: totalApiCalls.c,
      apiCallsBySource,
    });
  } catch (e) {
    res.status(500).json({ error: '获取统计失败' });
  }
});

module.exports = router;
module.exports.createBackupArchive = createBackupArchive;
