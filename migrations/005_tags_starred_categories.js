module.exports = {
  name: 'tags_starred_categories',

  async up(db, { dbRun, dbGet, dbAll }) {
    // 创建标签词典表
    await dbRun(db, `CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 创建文件-标签关联表（多对多）
    await dbRun(db, `CREATE TABLE IF NOT EXISTS file_tags (
      file_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (file_id, tag_id)
    )`);

    // 创建收藏表
    await dbRun(db, `CREATE TABLE IF NOT EXISTS starred_files (
      user_id INTEGER NOT NULL,
      file_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, file_id)
    )`);

    // 创建分类表（用户自建，互斥）
    await dbRun(db, `CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name, user_id)
    )`);

    // files 表加 category_id 列（幂等检测）
    const cols = await dbAll(db, 'PRAGMA table_info(files)');
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has('category_id')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN category_id INTEGER');
    }

    // 索引
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_starred_user_file ON starred_files(user_id, file_id)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_files_category ON files(category_id)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)');
  }
};
