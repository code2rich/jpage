// MCP 模块共享常量。从 mcp-server.js 提取，行为保持不变。

// 资源（jpage://file/{id}）返回正文的大小上限：超过则提示改用 get_file_content 工具。
const RESOURCE_MAX_BYTES = 256 * 1024;

// upload_file 工具允许的文件扩展名（含 ZIP）。
const ALLOWED_EXTS = ['.html', '.htm', '.md', '.markdown', '.zip'];

// 上传单文件大小上限（与 routes/files 上传限制一致）。
const MAX_FILE_SIZE = 50 * 1024 * 1024;

module.exports = {
  RESOURCE_MAX_BYTES,
  ALLOWED_EXTS,
  MAX_FILE_SIZE,
};
