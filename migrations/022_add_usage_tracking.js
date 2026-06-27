// 用量统计：用户级聚合 + API 调用明细表。
//
// users.total_storage_bytes —— 用户所有文件（含历史版本）占用的总字节数
// users.api_calls_count     —— 用户发起的 API 调用总数（缓存计数，加速个人面板）
// users.storage_quota_bytes —— 可选存储配额，为后续限制功能预留
// api_calls                 —— 每次 API 调用的明细（来源、动作、时间）

module.exports = {
  name: 'add_usage_tracking',

  async up(db, { dbRun, dbAll }) {
    // --- users 表新增聚合字段（幂等）---
    const userCols = await dbAll(db, 'PRAGMA table_info(users)');
    const userNames = new Set(userCols.map(c => c.name));

    if (!userNames.has('total_storage_bytes')) {
      await dbRun(db, "ALTER TABLE users ADD COLUMN total_storage_bytes INTEGER DEFAULT 0");
    }
    if (!userNames.has('api_calls_count')) {
      await dbRun(db, "ALTER TABLE users ADD COLUMN api_calls_count INTEGER DEFAULT 0");
    }
    if (!userNames.has('storage_quota_bytes')) {
      await dbRun(db, "ALTER TABLE users ADD COLUMN storage_quota_bytes INTEGER DEFAULT NULL");
    }

    // --- 历史数据回填：按用户累加 files.size + file_versions.size ---
    // 注意：ALTER 列后默认值已是 0，这里用子查询精确回填。
    await dbRun(db, `
      UPDATE users
      SET total_storage_bytes = COALESCE((SELECT SUM(size) FROM files WHERE uploaded_by = users.id), 0) +
                                COALESCE((SELECT SUM(v.size)
                                          FROM file_versions v
                                          JOIN files f ON v.file_id = f.id
                                          WHERE f.uploaded_by = users.id), 0)
    `);

    // --- API 调用明细表 ---
    await dbRun(db, `CREATE TABLE IF NOT EXISTS api_calls (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      source     TEXT,
      action     TEXT,
      method     TEXT,
      path       TEXT,
      status     INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_api_calls_user_time ON api_calls(user_id, created_at)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_api_calls_source_time ON api_calls(source, created_at)');
  }
};
