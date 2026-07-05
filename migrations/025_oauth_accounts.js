// 第三方 OAuth 账号绑定。当前用于微信开放平台网站应用扫码登录。

module.exports = {
  name: 'oauth_accounts',

  async up(db, { dbRun }) {
    await dbRun(db, `CREATE TABLE IF NOT EXISTS oauth_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      unionid TEXT,
      nickname TEXT,
      avatar_url TEXT,
      raw_profile_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await dbRun(db, `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_accounts_provider_user
      ON oauth_accounts(provider, provider_user_id)
    `);
    await dbRun(db, `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_accounts_provider_unionid
      ON oauth_accounts(provider, unionid)
      WHERE unionid IS NOT NULL AND unionid != ''
    `);
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user ON oauth_accounts(user_id)');
  }
};
