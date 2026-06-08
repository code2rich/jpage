module.exports = {
  name: 'zip_bundle_support',

  async up(db, { dbRun, dbGet, dbAll }) {
    const cols = await dbAll(db, 'PRAGMA table_info(files)');
    const colNames = new Set(cols.map(c => c.name));

    if (!colNames.has('is_bundle')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN is_bundle INTEGER NOT NULL DEFAULT 0');
    }
    if (!colNames.has('entry_path')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN entry_path TEXT DEFAULT NULL');
    }

    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_files_is_bundle ON files(is_bundle)');
  }
};
