// 路径常量集中管理。被多个 lib 模块和 routes 共享。
// 从 server.js 提取，行为保持不变。

const path = require('path');

const DATA_DIR = process.env.JPAGE_DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

module.exports = { DATA_DIR, UPLOAD_DIR };
