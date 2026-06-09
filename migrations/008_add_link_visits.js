module.exports = {
  name: 'add_link_visits_and_view_count',
  async up(db, { dbRun, dbGet, dbAll }) {
    await dbRun(db, `CREATE TABLE IF NOT EXISTS link_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id),
      share_key TEXT,
      ip_hash TEXT,
      user_agent TEXT,
      visited_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_link_visits_file ON link_visits(file_id)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_link_visits_ip_file ON link_visits(ip_hash, file_id)');

    const cols = await dbAll(db, 'PRAGMA table_info(files)');
    if (!cols.some(c => c.name === 'view_count')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN view_count INTEGER DEFAULT 0');
    }
  }
};
