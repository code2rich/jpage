module.exports = {
  name: 'add_roles_and_tokens',

  async up(db, { dbRun, dbAll }) {
    // 检查 role 列是否已存在
    const cols = await dbAll(db, 'PRAGMA table_info(users)');
    const names = new Set(cols.map(c => c.name));

    if (!names.has('role')) {
      await dbRun(db, "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
    }

    // 创建 tokens 表
    await dbRun(db, `CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      last_used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await dbRun(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id)');
  }
};
