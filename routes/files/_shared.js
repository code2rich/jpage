// 文件路由的共享层：上传配置（multer/限流）+ 版本备份序列 + 下载头 + 路径守卫。
// 由 routes/files/ 下各子模块按需 require，避免重复定义。
//
// 设计原则：只放「真正安全、零行为差异」的提取项。权限校验、行级 enrichment 等
// 涉及行为语义的逻辑仍留在各路由文件内，不在本轮重构中改动。

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { decodeFilename } = require('../../lib/util');
const { UPLOAD_DIR } = require('../../lib/paths');
const {
  MAX_FILE_VERSIONS,
  generateStoredName,
  removeStoredObject,
  copyStoredObject,
  backupAndApplyVersion,
  pruneOldVersions,
} = require('../../lib/file-storage');

// --- 常量 ---
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_UPLOAD_EXTS = ['.html', '.htm', '.md', '.markdown', '.zip']; // 上传（含 ZIP）
const ALLOWED_TEXT_EXTS = ['.html', '.htm', '.md', '.markdown'];          // JSON 上传（无 ZIP）

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
  removeStoredObject,
  copyStoredObject,
  backupAndApplyVersion,
  pruneOldVersions,
  setDownloadHeaders,
  isWithinBundle,
};
