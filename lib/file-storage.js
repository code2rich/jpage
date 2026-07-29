// 文件/目录型存储对象的版本生命周期：命名、归档、恢复复制、删除和历史裁剪。

const fs = require('fs');
const path = require('path');
const { dbGet, dbAll, dbRun } = require('./db');
const { now } = require('./util');
const { UPLOAD_DIR } = require('./paths');
const { addUserStorage } = require('./usage');
const logger = require('../logger');

const MAX_FILE_VERSIONS = parseInt(process.env.MAX_FILE_VERSIONS, 10) || 20;

function generateStoredName(ext = '') {
  return Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
}

async function removeStoredObject(storedName, isBundle = false) {
  if (!storedName) return;
  const target = path.join(UPLOAD_DIR, storedName);
  await fs.promises.rm(target, { recursive: !!isBundle, force: true });
}

async function copyStoredObject(sourceStoredName, targetStoredName, isBundle = false) {
  const source = path.join(UPLOAD_DIR, sourceStoredName);
  const target = path.join(UPLOAD_DIR, targetStoredName);
  if (isBundle) {
    await fs.promises.cp(source, target, { recursive: true, errorOnExist: true });
  } else {
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  }
}

// 归档当前 files 行并切换到 next。DB 两步写入处于同一事务，避免只写入历史或只更新主记录。
async function backupAndApplyVersion(file, next, recordedBy, source = 'web', performedBy) {
  const performedById = performedBy !== undefined ? performedBy : recordedBy;
  const nextFileType = next.fileType !== undefined ? next.fileType : file.file_type;
  const nextIsBundle = next.isBundle !== undefined ? (next.isBundle ? 1 : 0) : (file.is_bundle ? 1 : 0);
  const nextEntryPath = next.entryPath !== undefined ? next.entryPath : file.entry_path;
  let nextVer;

  await dbRun('BEGIN IMMEDIATE');
  try {
    const verRow = await dbGet(
      'SELECT COALESCE(MAX(version), 0) + 1 AS nextVer FROM file_versions WHERE file_id = ?',
      [file.id]
    );
    nextVer = verRow.nextVer;
    await dbRun(
      `INSERT INTO file_versions
         (file_id, version, stored_name, size, uploaded_by, upload_source, performed_by,
          is_bundle, entry_path, file_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        file.id,
        nextVer,
        file.stored_name,
        file.size,
        recordedBy,
        source,
        performedById,
        file.is_bundle ? 1 : 0,
        file.entry_path || null,
        file.file_type,
      ]
    );
    await dbRun(
      `UPDATE files
          SET stored_name = ?, size = ?, file_type = ?, is_bundle = ?, entry_path = ?,
              upload_source = ?, updated_at = ?
        WHERE id = ?`,
      [
        next.storedName,
        next.size,
        nextFileType,
        nextIsBundle,
        nextEntryPath || null,
        source,
        now(),
        file.id,
      ]
    );
    await dbRun('COMMIT');
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }

  // 旧当前版本仍作为历史保留，因此新增占用等于新当前版本本身的大小。
  await addUserStorage(file.uploaded_by, next.size);

  try {
    await pruneOldVersions(file.id, MAX_FILE_VERSIONS);
  } catch (e) {
    // 主版本切换已经提交；裁剪失败只能留下可清理的旧版本，不能让调用方误删当前存储。
    logger.error({ type: 'app', action: 'file.version.prune', fileId: file.id, error: e.message });
  }
  return { version: nextVer + 1 };
}

async function pruneOldVersions(fileId, keep) {
  if (!Number.isFinite(keep) || keep <= 0) return;
  const all = await dbAll(
    `SELECT id, stored_name, is_bundle, size, uploaded_by
       FROM file_versions
      WHERE file_id = ?
      ORDER BY version DESC`,
    [fileId]
  );
  for (const version of all.slice(keep)) {
    await removeStoredObject(version.stored_name, version.is_bundle);
    await dbRun('DELETE FROM file_versions WHERE id = ?', [version.id]);
    await addUserStorage(version.uploaded_by, -version.size);
  }
}

module.exports = {
  MAX_FILE_VERSIONS,
  generateStoredName,
  removeStoredObject,
  copyStoredObject,
  backupAndApplyVersion,
  pruneOldVersions,
};
