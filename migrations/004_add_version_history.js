module.exports = {
  name: 'add_version_history',

  async up(db, { dbRun, dbAll }) {
    // 1. 检查并添加 updated_at 列
    const cols = await dbAll(db, 'PRAGMA table_info(files)');
    const colNames = new Set(cols.map(c => c.name));

    if (!colNames.has('updated_at')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN updated_at DATETIME');
    }

    // 2. 回填 updated_at
    await dbRun(db, 'UPDATE files SET updated_at = created_at WHERE updated_at IS NULL');

    // 3. 创建 file_versions 表
    await dbRun(db, `CREATE TABLE IF NOT EXISTS file_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      stored_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      uploaded_by INTEGER,
      UNIQUE(file_id, version),
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    )`);

    // 4. 创建索引
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_fv_file_ver ON file_versions(file_id, version DESC)');
  }
};
