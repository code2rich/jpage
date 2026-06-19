// ZIP 上传处理：安全校验、解压、bundle/batch 分类与入库。
// 从 server.js 提取，行为保持不变。

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const logger = require('../logger');
const { dbRun, dbGet } = require('./db');
const { UPLOAD_DIR } = require('./paths');
const { now, generateShareKey, currentUserId, clientIp } = require('./util');
const { isFtsIndexable, indexFileContent } = require('./fts');

// --- ZIP 安全常量 ---
const ZIP_MAX_FILE_COUNT = 1000;
const ZIP_MAX_EXTRACTED_SIZE = 200 * 1024 * 1024;
const ZIP_MAX_SINGLE_FILE_SIZE = 50 * 1024 * 1024;

// --- ZIP 工具函数 ---

async function validateZipEntries(zip) {
  const entries = [];
  let fileCount = 0;
  return new Promise((resolve, reject) => {
    zip.forEach((normalizedPath, zipEntry) => {
      if (normalizedPath.includes('..')) {
        return reject(new Error('ZIP 条目路径包含目录穿越: ' + (zipEntry.unsafeOriginalName || normalizedPath)));
      }
      if (zipEntry.unixPermissions != null &&
          (zipEntry.unixPermissions & 0o170000) === 0o120000) {
        return reject(new Error('ZIP 包含符号链接: ' + (zipEntry.unsafeOriginalName || normalizedPath)));
      }
      if (!normalizedPath.trim() || zipEntry.dir) return;
      fileCount++;
      entries.push({ name: normalizedPath, originalName: zipEntry.unsafeOriginalName || normalizedPath });
    });
    if (fileCount === 0) return reject(new Error('ZIP 包中无文件'));
    if (fileCount > ZIP_MAX_FILE_COUNT) return reject(new Error('ZIP 包含 ' + fileCount + ' 个文件，超过上限 ' + ZIP_MAX_FILE_COUNT));
    resolve(entries);
  });
}

async function extractEntries(zip, entries, targetDir) {
  let totalSize = 0;
  const results = [];
  const resolvedTarget = path.resolve(targetDir) + path.sep;
  for (const entry of entries) {
    const zipFile = zip.file(entry.name);
    if (!zipFile) continue;
    const buf = await zipFile.async('nodebuffer');
    if (buf.length > ZIP_MAX_SINGLE_FILE_SIZE) throw new Error('文件 ' + entry.name + ' 解压后超过单文件限制');
    totalSize += buf.length;
    if (totalSize > ZIP_MAX_EXTRACTED_SIZE) throw new Error('解压总大小超过 ' + Math.round(ZIP_MAX_EXTRACTED_SIZE / 1024 / 1024) + 'MB 限制');
    const filePath = path.join(targetDir, entry.name);
    if (!path.resolve(filePath).startsWith(resolvedTarget)) throw new Error('路径穿越: ' + entry.name);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buf);
    results.push({ name: entry.name, size: buf.length });
  }
  return { entries: results, totalSize };
}

function findEntryHtml(entries) {
  const htmlExts = ['.html', '.htm'];
  for (const name of ['index.html', 'index.htm']) {
    const found = entries.find(e => e.name.toLowerCase() === name);
    if (found) return found.name;
  }
  const rootHtmls = entries.filter(e =>
    htmlExts.some(ext => e.name.toLowerCase().endsWith(ext)) && !e.name.includes('/')
  ).sort((a, b) => a.name.localeCompare(b.name));
  if (rootHtmls.length > 0) return rootHtmls[0].name;
  for (const name of ['index.html', 'index.htm']) {
    const found = entries.find(e => e.name.split('/').pop().toLowerCase() === name);
    if (found) return found.name;
  }
  const anyHtml = entries.find(e => htmlExts.some(ext => e.name.toLowerCase().endsWith(ext)));
  return anyHtml ? anyHtml.name : null;
}

function classifyZip(entries) {
  const htmlExts = ['.html', '.htm'];
  const assetExts = ['.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif',
    '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot',
    '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.pdf',
    '.map', '.webmanifest', '.xml', '.txt'];
  const htmlFiles = entries.filter(e => htmlExts.some(ext => e.name.toLowerCase().endsWith(ext)));
  const mdFiles = entries.filter(e => e.name.toLowerCase().endsWith('.md') || e.name.toLowerCase().endsWith('.markdown'));
  const assetFiles = entries.filter(e => assetExts.some(ext => e.name.toLowerCase().endsWith(ext)));
  const hasSubDirs = entries.some(e => e.name.includes('/'));
  if (htmlFiles.length === 0 && mdFiles.length === 0) return { type: 'reject', reason: 'ZIP 中无 HTML 或 Markdown 文件' };
  // 纯 Markdown + 资源文件：作为 bundle 处理，第一个 MD 文件作为入口
  if (htmlFiles.length === 0 && mdFiles.length >= 1 && assetFiles.length > 0) {
    return { type: 'bundle', entryFile: mdFiles[0].name };
  }
  const hasRootIndex = entries.some(e => e.name.toLowerCase() === 'index.html' || e.name.toLowerCase() === 'index.htm');
  if (htmlFiles.length >= 1 && hasRootIndex && (hasSubDirs || assetFiles.length > 0)) return { type: 'bundle', entryFile: findEntryHtml(entries) };
  if (htmlFiles.length >= 1 && (hasSubDirs || assetFiles.length > 0) && mdFiles.length === 0) {
    const entry = findEntryHtml(entries);
    if (entry) return { type: 'bundle', entryFile: entry };
  }
  if (!hasSubDirs && assetFiles.length === 0) return { type: 'batch', files: [...htmlFiles, ...mdFiles] };
  if (htmlFiles.length === 1) return { type: 'bundle', entryFile: findEntryHtml(entries) };
  return { type: 'batch', files: [...htmlFiles, ...mdFiles] };
}

async function handleZipUpload(req, res, zipBuffer) {
  try {
    const zip = await JSZip.loadAsync(zipBuffer);
    const entries = await validateZipEntries(zip);
    const classification = classifyZip(entries);

    if (classification.type === 'reject') {
      return res.status(400).json({ error: classification.reason });
    }

    const isPublic = req.body.isPublic === 'true' || req.body.isPublic === true;
    const userId = currentUserId(req);

    if (classification.type === 'bundle') {
      const dirName = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const bundleDir = path.join(UPLOAD_DIR, dirName);
      await extractEntries(zip, entries, bundleDir);

      const totalSize = await fs.promises.readdir(bundleDir).then(files =>
        Promise.all(files.map(f => fs.promises.stat(path.join(bundleDir, f)).then(s => s.size)))
      ).then(sizes => sizes.reduce((a, b) => a + b, 0));

      const originalName = req.file ? req.file.originalname : (req.body && req.body.name) || 'upload.zip';
      const entryExt = path.extname(classification.entryFile).toLowerCase();
      const fileType = (entryExt === '.md' || entryExt === '.markdown') ? 'markdown' : 'html';

      const result = await dbRun(
        'INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by, share_key, updated_at, is_bundle, entry_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
        [originalName, dirName, fileType, totalSize, isPublic ? 1 : 0, userId, generateShareKey(), now(), classification.entryFile]
      );

      const shareKey = await dbGet('SELECT share_key FROM files WHERE id = ?', [result.lastID]).then(r => r?.share_key);
      logger.audit('file.upload', { fileId: result.lastID, fileName: originalName, fileType: 'bundle', size: totalSize, ip: clientIp(req) });
      return res.json({
        id: result.lastID,
        original_name: originalName,
        file_type: fileType,
        size: totalSize,
        is_public: isPublic ? 1 : 0,
        is_bundle: 1,
        entry_path: classification.entryFile,
        share_key: shareKey
      });
    }

    // batch 模式
    const results = [];
    for (const entry of classification.files) {
      const zipFile = zip.file(entry.name);
      if (!zipFile) continue;
      const buf = await zipFile.async('nodebuffer');
      const ext = path.extname(entry.name).toLowerCase();
      const fileType = (ext === '.md' || ext === '.markdown') ? 'markdown' : 'html';
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const storedName = unique + ext;
      const filePath = path.join(UPLOAD_DIR, storedName);
      await fs.promises.writeFile(filePath, buf);

      const baseName = path.basename(entry.name);
      const dbResult = await dbRun(
        'INSERT INTO files (original_name, stored_name, file_type, size, is_public, uploaded_by, share_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [baseName, storedName, fileType, buf.length, isPublic ? 1 : 0, userId, generateShareKey(), now()]
      );
      if (isFtsIndexable(fileType, storedName)) {
        indexFileContent(dbResult.lastID, storedName);
      }
      results.push({ id: dbResult.lastID, original_name: baseName, file_type: fileType, size: buf.length });
    }

    logger.audit('file.upload', { fileType: 'batch', count: results.length, ip: clientIp(req) });
    return res.json({ type: 'batch', count: results.length, files: results });
  } catch (e) {
    logger.error({ type: 'app', action: 'zip.upload', error: e.message });
    return res.status(500).json({ error: 'ZIP 处理失败: ' + e.message });
  }
}

module.exports = {
  ZIP_MAX_FILE_COUNT,
  ZIP_MAX_EXTRACTED_SIZE,
  ZIP_MAX_SINGLE_FILE_SIZE,
  validateZipEntries,
  extractEntries,
  findEntryHtml,
  classifyZip,
  handleZipUpload,
};
