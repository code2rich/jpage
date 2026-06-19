// MCP 标签类工具：list_tags / add_tags_to_file。
// 从 mcp-server.js 提取，行为保持不变。

const { z } = require('zod');
const { textResult, resolveTagIds } = require('./util');

function registerTagTools(server, { api }) {
  // --- list_tags ---
  server.registerTool(
    'list_tags',
    {
      title: 'List Tags',
      description: '列出所有标签及其关联文件数量。',
      inputSchema: {},
    },
    async () => {
      const data = await api.get('/api/tags');
      return textResult(data.tags);
    }
  );

  // --- add_tags_to_file ---
  server.registerTool(
    'add_tags_to_file',
    {
      title: 'Add Tags to File',
      description: '为指定文件设置标签（替换现有标签）。标签不存在时会自动创建。',
      inputSchema: {
        fileId: z.number().int().positive().describe('文件 id'),
        tags: z.array(z.string()).describe('标签名列表，如 ["报告", "Q3"]'),
      },
    },
    async ({ fileId, tags }) => {
      const tagIds = await resolveTagIds(api, tags);
      await api.put(`/api/files/${fileId}/tags`, { tagIds });
      return textResult({ fileId, tags });
    }
  );
}

module.exports = { registerTagTools };
