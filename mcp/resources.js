// MCP 资源：jpage://files（全部文件元数据）/ jpage://file/{id}（单文件内容）。
// 从 mcp-server.js 提取，行为保持不变。

const { ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { RESOURCE_MAX_BYTES } = require('./constants');

function registerResources(server, { api }) {
  // --- jpage://files ---
  server.registerResource(
    'files',
    'jpage://files',
    {
      title: 'All Files',
      description: 'jpage 中所有文件的元数据列表（id, name, type, size, is_public, created_at）。适用于快速浏览文件概况，无需逐个查询。',
      mimeType: 'application/json',
    },
    async () => {
      const data = await api.get('/api/files');
      return {
        contents: [
          {
            uri: 'jpage://files',
            mimeType: 'application/json',
            text: JSON.stringify(data.files, null, 2),
          },
        ],
      };
    }
  );

  // --- jpage://file/{id} ---
  server.registerResource(
    'file',
    new ResourceTemplate('jpage://file/{id}', { list: undefined }),
    {
      title: 'Single File Content',
      description:
        '单文件内容（资源）。仅当文件 ≤ 256KB 时返回正文；超过则返回提示，让模型改用 get_file_content 工具。适用于 AI 上下文注入或轻量内容查看。',
      mimeType: 'text/plain',
    },
    async (uri, vars) => {
      const id = Number(vars.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`Invalid file id: ${vars.id}`);
      }
      const data = await api.get(`/api/files/${id}/content`);
      const size = Buffer.byteLength(data.content, 'utf-8');
      if (size > RESOURCE_MAX_BYTES) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/plain',
              text:
                `文件过大 (${size} 字节 > ${RESOURCE_MAX_BYTES} 字节)，请改用 get_file_content 工具读取完整内容。`,
            },
          ],
        };
      }
      const mimeType = data.file_type === 'markdown' ? 'text/markdown' : 'text/html';
      return {
        contents: [
          {
            uri: uri.href,
            mimeType,
            text: data.content,
          },
        ],
      };
    }
  );
}

module.exports = { registerResources };
