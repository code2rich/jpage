const crypto = require('crypto');

function generateShareKey() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

module.exports = {
  name: 'add_share_key',

  async up(db, { dbRun, dbAll, dbGet }) {
    // 检查 share_key 列是否已存在
    const cols = await dbAll(db, 'PRAGMA table_info(files)');
    const names = new Set(cols.map(c => c.name));

    if (!names.has('share_key')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN share_key TEXT');
    }

    await dbRun(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_files_share_key ON files(share_key)');

    // 回填已有行
    const rows = await dbAll(db, 'SELECT id FROM files WHERE share_key IS NULL');
    for (const row of rows) {
      const key = generateShareKey();
      try {
        await dbRun(db, 'UPDATE files SET share_key = ? WHERE id = ?', [key, row.id]);
      } catch (_) {
        const retryKey = generateShareKey();
        await dbRun(db, 'UPDATE files SET share_key = ? WHERE id = ?', [retryKey, row.id]);
      }
    }
  }
};
