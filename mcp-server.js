// MCP 服务入口（re-export transport 层）。
//
// 历史上 mcp-server.js 是一个 717 行的单体文件，承载 MCP 工具注册 + transport 生命周期。
// 已按职责拆分到 mcp/ 目录：
//   constants.js              共享常量（RESOURCE_MAX_BYTES / ALLOWED_EXTS / MAX_FILE_SIZE）
//   util.js                   纯函数 + API 辅助（textResult / formatSize / formatTime /
//                             resolveTagIds / applyTagsAndCategory）
//   tools-files.js            list_files / upload_file / get_file_content / delete_file /
//                             rename_file / get_file_url / star_file / unstar_file
//   tools-versions.js         list_file_versions / restore_file_version
//   tools-tags.js             list_tags / add_tags_to_file
//   tools-categories.js       list_categories / create_category / set_file_category
//   tools-content-templates.js list_content_templates / get_content_template
//   resources.js              jpage://files / jpage://file/{id}
//   server.js                 createMcpServer 工厂（装配 17 tools + 2 resources）
//   transport.js              mountMcpServer / closeMcpTransports（会话生命周期）
//
// 此文件保留为外部入口，re-export transport 层，使 server.js 的 require('./mcp-server')
// 零变化。行为与拆分前完全一致（共 17 tools + 2 resources）。
module.exports = require('./mcp/transport');
