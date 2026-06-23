// 分享链接控制：过期时间 + 访问密码。
//
// - share_expires_at：UTC 字符串 'YYYY-MM-DD HH:MM:SS'，NULL=永不过期。
//   与 now() / CURRENT_TIMESTAMP 同格式，便于 server.js 直接字符串比较。
// - share_password_hash：bcrypt 哈希，NULL=无密码保护。
//
// 自定义别名 / 重新生成短链复用已有 share_key 列（含唯一索引 idx_files_share_key），
// 故本迁移只加这两列。
module.exports = {
  name: 'add_share_control',

  async up(db, { dbRun, dbAll }) {
    const cols = await dbAll(db, 'PRAGMA table_info(files)');
    const names = new Set(cols.map(c => c.name));

    if (!names.has('share_expires_at')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN share_expires_at TEXT');
    }
    if (!names.has('share_password_hash')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN share_password_hash TEXT');
    }
  }
};
