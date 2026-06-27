// 用量统计工具函数：维护用户级存储空间，并提供重算入口。
// 所有维护函数均为异步、幂等（delta 可为负数），并在失败时静默忽略，
// 避免影响主业务流程。

const { dbRun, dbGet, dbAll } = require('./db');

/**
 * 以 delta（可正可负）调整用户的 total_storage_bytes。
 * @param {number|null} userId
 * @param {number} bytes
 */
async function addUserStorage(userId, bytes) {
  if (!userId || !Number.isFinite(bytes) || bytes === 0) return;
  try {
    await dbRun(
      'UPDATE users SET total_storage_bytes = COALESCE(total_storage_bytes, 0) + ? WHERE id = ?',
      [bytes, userId]
    );
  } catch {
    // 静默失败：存储统计不应阻塞主流程
  }
}

/**
 * 根据 files + file_versions 重新计算指定用户的总存储。
 * @param {number|null} userId
 */
async function recalculateUserStorage(userId) {
  if (!userId) return;
  try {
    const row = await dbGet(`
      SELECT COALESCE((SELECT SUM(size) FROM files WHERE uploaded_by = ?), 0) +
             COALESCE((SELECT SUM(v.size)
                       FROM file_versions v
                       JOIN files f ON v.file_id = f.id
                       WHERE f.uploaded_by = ?), 0) AS total
    `, [userId, userId]);
    await dbRun(
      'UPDATE users SET total_storage_bytes = ? WHERE id = ?',
      [row ? row.total : 0, userId]
    );
  } catch {
    // 静默失败
  }
}

/**
 * 重新计算所有用户的 total_storage_bytes。
 * 适用于导入恢复、批量修复等场景。
 */
async function recalculateAllUsersStorage() {
  try {
    const users = await dbAll('SELECT id FROM users');
    for (const u of users) {
      await recalculateUserStorage(u.id);
    }
  } catch {
    // 静默失败
  }
}

/**
 * 删除文件时，扣减该文件及其所有历史版本占用的空间。
 * @param {{id: number, size: number, uploaded_by: number}} file
 */
async function subtractFileStorage(file) {
  if (!file || !file.uploaded_by) return;
  try {
    const row = await dbGet(
      'SELECT COALESCE(SUM(size), 0) AS versionSize FROM file_versions WHERE file_id = ?',
      [file.id]
    );
    const versionSize = row ? row.versionSize : 0;
    await addUserStorage(file.uploaded_by, -(file.size + versionSize));
  } catch {
    // 静默失败
  }
}

module.exports = {
  addUserStorage,
  recalculateUserStorage,
  recalculateAllUsersStorage,
  subtractFileStorage,
};
