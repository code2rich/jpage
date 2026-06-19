// FTS5 全文搜索：索引写入 / 删除 / 回填 / 查询转义。
// 从 server.js 提取，行为保持不变。

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { dbRun, dbGet, dbAll } = require('./db');
const { UPLOAD_DIR } = require('./paths');

const FTS_INDEXABLE_EXTS = new Set(['.html', '.htm', '.md', '.markdown', '.txt']);
const FTS_MAX_CONTENT_SIZE = 100 * 1024; // 100KB

function isFtsIndexable(fileType, storedName) {
  if (fileType === 'bundle') return false;
  const ext = path.extname(storedName || '').toLowerCase();
  return FTS_INDEXABLE_EXTS.has(ext);
}

async function indexFileContent(fileId, storedName) {
  try {
    const filePath = path.join(UPLOAD_DIR, storedName);
    if (!fs.existsSync(filePath)) return;
    let content = await fs.promises.readFile(filePath, 'utf-8');
    if (content.length > FTS_MAX_CONTENT_SIZE) content = content.slice(0, FTS_MAX_CONTENT_SIZE);
    // 去除 HTML 标签，只保留纯文本用于索引
    content = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // 对 CJK 字符逐字加空格，使 unicode61 tokenizer 能按字符分词
    content = content.replace(/([一-鿿])/g, ' $1 ');
    content = content.replace(/\s+/g, ' ').trim();
    await dbRun('DELETE FROM file_contents_fts WHERE file_id = ?', [fileId]);
    await dbRun('INSERT INTO file_contents_fts(rowid, file_id, content) VALUES (?, ?, ?)', [fileId, fileId, content]);
  } catch (e) {
    logger.error({ type: 'app', message: 'FTS 索引失败', fileId, error: e.message });
  }
}

async function deleteFileIndex(fileId) {
  try {
    await dbRun('DELETE FROM file_contents_fts WHERE file_id = ?', [fileId]);
  } catch (e) {
    logger.error({ type: 'app', message: 'FTS 删除索引失败', fileId, error: e.message });
  }
}

async function backfillFtsIndex() {
  try {
    const count = await dbGet('SELECT COUNT(*) AS cnt FROM file_contents_fts');
    if (count.cnt > 0) return;
    const files = await dbAll('SELECT id, stored_name, file_type, is_bundle FROM files');
    let indexed = 0;
    for (const f of files) {
      if (f.is_bundle) continue;
      if (!isFtsIndexable(f.file_type, f.stored_name)) continue;
      await indexFileContent(f.id, f.stored_name);
      indexed++;
    }
    if (indexed > 0) logger.info({ type: 'app', message: 'FTS 索引回填完成', count: indexed });
  } catch (e) {
    logger.error({ type: 'app', message: 'FTS 索引回填失败', error: e.message });
  }
}

function escapeFtsQuery(q) {
  // 移除 FTS5 特殊字符
  let cleaned = q.replace(/["'*:(){}[\]\\^+\-&|!~]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  // 对 CJK 字符逐字加空格，与索引时一致
  cleaned = cleaned.replace(/([一-鿿])/g, ' $1 ').replace(/\s+/g, ' ').trim();
  // 对每个 token 加引号，避免 FTS5 语法错误
  return cleaned.split(/\s+/).map(w => `"${w}"`).join(' ');
}

module.exports = {
  FTS_INDEXABLE_EXTS,
  FTS_MAX_CONTENT_SIZE,
  isFtsIndexable,
  indexFileContent,
  deleteFileIndex,
  backfillFtsIndex,
  escapeFtsQuery,
};
