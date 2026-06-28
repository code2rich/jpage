// MCP server 工厂：创建 McpServer 并注册全部 tools + resources。
// 从 mcp-server.js 提取，行为保持不变。
//
// 注册顺序 = 原文件顺序（list/upload/content/delete/rename/url/versions/tags/star/
// categories/resources/content-templates）。顺序对 MCP 协议无影响，仅为对照方便。
// 当前共 18 tools + 2 resources。

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const pkgVersion = require('../package.json').version;
const { registerFileTools } = require('./tools-files');
const { registerVersionTools } = require('./tools-versions');
const { registerTagTools } = require('./tools-tags');
const { registerCategoryTools } = require('./tools-categories');
const { registerContentTemplateTools } = require('./tools-content-templates');
const { registerResources } = require('./resources');

/**
 * 创建并配置 MCP server（注册 17 tools + 2 resources）。
 * @param {object} opts
 * @param {number} opts.port
 * @param {object} opts.api - 进程内 dispatcher 客户端（{get,post,put,del}）
 * @param {string} opts.mcpIp
 * @param {string} opts.protocol
 * @returns {McpServer}
 */
function createMcpServer({ port, api, mcpIp, protocol }) {
  const server = new McpServer(
    { name: 'jpage', version: pkgVersion },
    { capabilities: {} }
  );

  const ctx = { api, port, mcpIp, protocol };

  registerFileTools(server, ctx);
  registerVersionTools(server, ctx);
  registerTagTools(server, ctx);
  registerCategoryTools(server, ctx);
  registerResources(server, ctx);
  registerContentTemplateTools(server, ctx);

  return server;
}

module.exports = { createMcpServer };
