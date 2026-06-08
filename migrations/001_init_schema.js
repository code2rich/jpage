module.exports = {
  name: 'init_schema',

  async up(db, { dbRun }) {
    await dbRun(db, `CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_public INTEGER NOT NULL DEFAULT 1,
      uploaded_by INTEGER
    )`);

    await dbRun(db, `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC)');
  }
};
