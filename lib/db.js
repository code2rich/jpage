// SQLite 数据库访问层。
// db 实例由 server.js 创建并通过 setDb() 注入；之后 dbRun/dbGet/dbAll 即可使用。
// 从 server.js 提取，行为保持不变。

const { dbRun: _dbRun, dbGet: _dbGet, dbAll: _dbAll } = require('../migrations');

let db = null;

function setDb(instance) {
  db = instance;
}

function getDb() {
  return db;
}

function dbRun(sql, params = []) {
  return _dbRun(db, sql, params);
}

function dbGet(sql, params = []) {
  return _dbGet(db, sql, params);
}

function dbAll(sql, params = []) {
  return _dbAll(db, sql, params);
}

// --- SQLite 性能 PRAGMA ---
// 在任何查询前应用：WAL 让读写不互斥（并发提升），synchronous=NORMAL 减少每次提交的 fsync，
// busy_timeout 在写冲突时自动重试，cache_size/temp_store/mmap_size 提升读吞吐。
function configureDatabase() {
  return new Promise((resolve, reject) => {
    db.exec(
      `PRAGMA journal_mode=WAL;
       PRAGMA synchronous=NORMAL;
       PRAGMA busy_timeout=5000;
       PRAGMA cache_size=-20000;
       PRAGMA temp_store=MEMORY;
       PRAGMA mmap_size=268435452;`,
      (err) => (err ? reject(err) : resolve())
    );
  });
}

module.exports = {
  setDb,
  getDb,
  dbRun,
  dbGet,
  dbAll,
  configureDatabase,
};
