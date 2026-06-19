module.exports = {
  name: 'add_templates_system',
  async up(db, { dbRun, dbGet, dbAll }) {
    // 创建 templates 表
    await dbRun(db, `CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      file_path TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // 注册内置模板
    const builtins = [
      ['default', '默认模板', 'templates/default.html'],
      ['github', 'GitHub 风格', 'templates/github.html'],
      ['academic', '学术风格', 'templates/academic.html'],
      ['dark-pro', '深色专业', 'templates/dark-pro.html'],
    ];
    for (const [name, desc, filePath] of builtins) {
      await dbRun(db,
        `INSERT OR IGNORE INTO templates (name, description, file_path, is_builtin) VALUES (?, ?, ?, 1)`,
        [name, desc, filePath]
      );
    }

    // files 表增加 template_id 列（幂等）
    const cols = await dbAll(db, `PRAGMA table_info(files)`);
    if (!cols.some(c => c.name === 'template_id')) {
      await dbRun(db, `ALTER TABLE files ADD COLUMN template_id INTEGER REFERENCES templates(id)`);
    }
  }
};
