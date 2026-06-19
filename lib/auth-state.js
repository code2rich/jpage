// 可变/共享的认证状态。adminUserId 在启动时由 bootstrapAdmin 设置，
// requireAuth（Bearer MCP_TOKEN 路径）需要读取它。单独抽出避免循环依赖。
// 从 server.js 提取，行为保持不变。

let adminUserId = null;

function setAdminUserId(id) {
  adminUserId = id;
}

function getAdminUserId() {
  return adminUserId;
}

module.exports = { setAdminUserId, getAdminUserId };
