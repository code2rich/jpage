const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function runMigrations(db) {
  // 创建 _migrations 版本表
  await dbRun(db, `CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 获取已执行的 migration
  const applied = await dbAll(db, 'SELECT name FROM _migrations');
  const appliedNames = new Set(applied.map(r => r.name));

  // 读取并排序 migration 文件
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();

  const helpers = { dbRun, dbGet, dbAll };

  for (const file of files) {
    const migration = require(path.join(MIGRATIONS_DIR, file));

    if (appliedNames.has(migration.name)) continue;

    logger.info({ type: 'migration', message: `Running: ${migration.name}` });
    await migration.up(db, helpers);
    await dbRun(db, 'INSERT INTO _migrations (name) VALUES (?)', [migration.name]);
    logger.info({ type: 'migration', message: `Done: ${migration.name}` });
  }
}

module.exports = { runMigrations, dbRun, dbGet, dbAll };
