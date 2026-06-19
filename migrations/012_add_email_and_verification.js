module.exports = {
  name: 'add_email_and_verification',
  async up(db, { dbRun, dbGet, dbAll }) {
    const cols = await dbAll(db, 'PRAGMA table_info(users)');
    const colNames = new Set(cols.map(c => c.name));

    if (!colNames.has('email')) {
      await dbRun(db, 'ALTER TABLE users ADD COLUMN email TEXT');
    }
    if (!colNames.has('email_verified')) {
      await dbRun(db, 'ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
    }

    // 邮箱唯一索引（排除 NULL）
    await dbRun(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');

    // 回填：现有用户名看起来像邮箱的用户
    await dbRun(db, "UPDATE users SET email = username, email_verified = 1 WHERE email IS NULL AND username LIKE '%@%'");

    // 邮箱验证 token 表
    await dbRun(db, `CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'verify_email',
      new_email TEXT,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id)');
    await dbRun(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_email_verifications_hash ON email_verifications(token_hash)');
  }
};
