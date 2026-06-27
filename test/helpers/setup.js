// 集成测试 helper：组装一个隔离的 app 实例（独立 SQLite 数据目录 + 已初始化 admin）。
// 通过 require('../server') 拿到不 listen 的 app，调用 initApp() 完成迁移与引导。

const path = require('path');
const fs = require('fs');

// 每个测试文件用唯一数据目录，避免并发污染
let counter = 0;

function createTestEnv() {
  const dataDir = path.join(__dirname, '..', '..', `data-test-${process.pid}-${counter++}`);
  // 在 require server.js 之前设好环境变量（lib/paths 在 require 时读取 JPAGE_DATA_DIR）
  process.env.JPAGE_DATA_DIR = dataDir;
  process.env.NODE_ENV = 'development';
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-fixed';
  process.env.ADMIN_USER = 'admin';
  process.env.ADMIN_PASSWORD = 'testpassword123';

  // 清理可能的残留
  fs.rmSync(dataDir, { recursive: true, force: true });

  // require server（require.main !== module，故不会 listen）
  // 用删除缓存的方式确保拿到全新 app（不同测试文件隔离）
  const serverPath = require.resolve('../../server');
  delete require.cache[serverPath];
  // 同时清理 lib/paths 缓存（它缓存了 DATA_DIR）
  const pathsPath = require.resolve('../../lib/paths');
  delete require.cache[pathsPath];
  // 清理 lib/db 缓存：server.js 注入的 db 实例保存在模块闭包中，必须重置以避免测试间状态污染
  const dbPath = require.resolve('../../lib/db');
  delete require.cache[dbPath];

  const { app, initApp } = require('../../server');

  return {
    app,
    async ready() {
      await initApp();
      return app;
    },
    cleanup() {
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
    dataDir,
  };
}

module.exports = { createTestEnv };
