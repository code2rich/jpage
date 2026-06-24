module.exports = {
  name: 'market_instantiation',
  async up(db, { dbRun, dbAll }) {
    const fileCols = await dbAll(db, 'PRAGMA table_info(files)');
    const fileColNames = new Set(fileCols.map(c => c.name));

    if (!fileColNames.has('source_asset_id')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN source_asset_id INTEGER');
    }
    if (!fileColNames.has('source_asset_version')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN source_asset_version TEXT');
    }
    if (!fileColNames.has('created_from')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN created_from TEXT');
    }
    if (!fileColNames.has('forked_from_page_id')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN forked_from_page_id INTEGER');
    }
    if (!fileColNames.has('instantiation_variables')) {
      await dbRun(db, 'ALTER TABLE files ADD COLUMN instantiation_variables TEXT');
    }

    const templateCols = await dbAll(db, 'PRAGMA table_info(content_templates)');
    const templateColNames = new Set(templateCols.map(c => c.name));
    if (!templateColNames.has('version')) {
      await dbRun(db, "ALTER TABLE content_templates ADD COLUMN version TEXT NOT NULL DEFAULT '1.0.0'");
    }
    if (!templateColNames.has('view_count')) {
      await dbRun(db, 'ALTER TABLE content_templates ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!templateColNames.has('instantiation_count')) {
      await dbRun(db, 'ALTER TABLE content_templates ADD COLUMN instantiation_count INTEGER NOT NULL DEFAULT 0');
    }

    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_files_source_asset ON files(source_asset_id)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_files_created_from ON files(created_from)');

    await dbRun(db, `CREATE TABLE IF NOT EXISTS content_template_installs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      file_id INTEGER NOT NULL,
      source_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(template_id, user_id)
    )`);
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_ct_installs_template ON content_template_installs(template_id)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_ct_installs_user ON content_template_installs(user_id)');

    await dbRun(db, `CREATE TABLE IF NOT EXISTS content_template_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      user_id INTEGER,
      file_id INTEGER,
      event_type TEXT NOT NULL,
      source_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_ct_events_template ON content_template_events(template_id, event_type)');
  }
};
