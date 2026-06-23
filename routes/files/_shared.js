// 文件路由的共享层：上传配置（multer/限流）+ 版本备份序列 + 下载头 + 路径守卫。
// 由 routes/files/ 下各子模块按需 require，避免重复定义。
//
// 设计原则：只放「真正安全、零行为差异」的提取项。权限校验、行级 enrichment 等
// 涉及行为语义的逻辑仍留在各路由文件内，不在本轮重构中改动。

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { dbGet, dbAll, dbRun } = require('../../lib/db');
const { now, unlinkQuiet, decodeFilename } = require('../../lib/util');
const { UPLOAD_DIR } = require('../../lib/paths');

// --- 常量 ---
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_UPLOAD_EXTS = ['.html', '.htm', '.md', '.markdown', '.zip']; // 上传（含 ZIP）
const ALLOWED_TEXT_EXTS = ['.html', '.htm', '.md', '.markdown'];          // JSON 上传（无 ZIP）
// 单个文件保留的历史版本数（file_versions 表），超过则自动删除最旧的。
// 当前版本存在 files 主记录，不计入此上限。env 可配，默认 20。
// 注：推翻设计文档 013 原定的「version 不设上限」。
const MAX_FILE_VERSIONS = parseInt(process.env.MAX_FILE_VERSIONS, 10) || 20;

// --- 上传限流 ---
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: '上传请求过于频繁，请稍后再试' }
});

// --- multer 配置（multipart 上传用） ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const decoded = decodeFilename(file.originalname);
    const ext = path.extname(decoded);
    cb(null, generateStoredName(ext));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const decoded = decodeFilename(file.originalname);
    const ext = path.extname(decoded).toLowerCase();
    if (ALLOWED_UPLOAD_EXTS.includes(ext)) return cb(null, true);
    cb(new Error('仅支持 HTML、Markdown 和 ZIP 文件'));
  }
});

// JSON body 解析器：上传类端点需要放宽到 50MB（全局默认 1MB）
const largeJson = express.json({ limit: '50mb' });

// --- 文件名生成：替换原先散落在 5 处的 Date.now()+'-'+Math.round(...)+ext ---
function generateStoredName(ext) {
  return Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
}

// --- 版本备份 + 主记录更新序列 ---
// 原先在 upload/upload-json/overwrite/overwrite-json/restore 共 5 处重复。
// 行为零差异：读 nextVer → INSERT 旧版本到 file_versions → UPDATE files 主记录。
//
// @param {object} file       - 旧 files 行（含 stored_name/size/id）
// @param {object} next       - 新版本数据 { storedName, size }
// @param {number} recordedBy - 写入 file_versions.uploaded_by 的用户 id
//                              （upload/overwrite 各处用 file.uploaded_by；restore 用 currentUserId）
// @returns {Promise<{ version: number }>} 返回新版本号（nextVer + 1，对齐审计日志语义）
async function backupAndApplyVersion(file, next, recordedBy) {
  const verRow = await dbGet(
    'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
    [file.id]
  );
  const nextVer = verRow.nextVer;
  await dbRun(
    'INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
    [file.id, nextVer, file.stored_name, file.size, recordedBy]
  );
  await dbRun(
    'UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?',
    [next.storedName, next.size, now(), file.id]
  );
  // 超过上限时删除最旧的历史版本（含磁盘文件），避免长期占盘。
  await pruneOldVersions(file.id, MAX_FILE_VERSIONS);
  return { version: nextVer + 1 };
}

// --- 历史版本裁剪 ---
// 保留每个文件最近 keep 个历史版本（version 最大的 keep 个），删掉更老的，
// 同步清理磁盘文件。当前版本在 files 主记录，不参与计数。
async function pruneOldVersions(fileId, keep) {
  if (!Number.isFinite(keep) || keep <= 0) return;
  // version 倒序：前 keep 条保留，其余删除
  const all = await dbAll(
    'SELECT id, stored_name FROM file_versions WHERE file_id = ? ORDER BY version DESC',
    [fileId]
  );
  const toRemove = all.slice(keep);
  for (const v of toRemove) {
    if (v.stored_name) await unlinkQuiet(path.join(UPLOAD_DIR, v.stored_name));
    await dbRun('DELETE FROM file_versions WHERE id = ?', [v.id]);
  }
}

// --- 下载 Content-Disposition 头（UTF-8 文件名） ---
// 替换 download 路由两处重复的 encoded + filename*=UTF-8'' 拼接。
function setDownloadHeaders(res, name) {
  const encoded = encodeURIComponent(name);
  res.setHeader('Content-Disposition', "attachment; filename=\"" + encoded + "\"; filename*=UTF-8''" + encoded);
}

// --- bundle 路径穿越守卫 ---
// 替换 content/asset 路由的 path.resolve + startsWith 重复校验。
// 返回 true 表示安全（路径落在 bundleDir 内）。
function isWithinBundle(absPath, bundleDir) {
  const resolvedDir = path.resolve(bundleDir) + path.sep;
  const resolved = path.resolve(absPath);
  return resolved.startsWith(resolvedDir) || resolved === path.resolve(bundleDir);
}

module.exports = {
  MAX_FILE_SIZE,
  MAX_FILE_VERSIONS,
  ALLOWED_UPLOAD_EXTS,
  ALLOWED_TEXT_EXTS,
  uploadLimiter,
  upload,
  largeJson,
  generateStoredName,
  backupAndApplyVersion,
  pruneOldVersions,
  setDownloadHeaders,
  isWithinBundle,
};
