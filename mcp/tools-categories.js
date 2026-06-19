// MCP 分类类工具：list_categories / create_category / set_file_category。
// 从 mcp-server.js 提取，行为保持不变。

const { z } = require('zod');
const { textResult } = require('./util');

function registerCategoryTools(server, { api }) {
  // --- list_categories ---
  server.registerTool(
    'list_categories',
    {
      title: 'List Categories',
      description: '列出所有分类及其文件数量。',
      inputSchema: {},
    },
    async () => {
      const data = await api.get('/api/categories');
      return textResult(data.categories);
    }
  );

  // --- create_category ---
  server.registerTool(
    'create_category',
    {
      title: 'Create Category',
      description: '创建一个新分类（文件夹）。',
      inputSchema: {
        name: z.string().min(1).describe('分类名称'),
      },
    },
    async ({ name }) => {
      const data = await api.post('/api/categories', { name });
      return textResult(data);
    }
  );

  // --- set_file_category ---
  server.registerTool(
    'set_file_category',
    {
      title: 'Set File Category',
      description: '设置文件所属分类。传 null 或不传 categoryId 表示移除分类。',
      inputSchema: {
        fileId: z.number().int().positive().describe('文件 id'),
        categoryId: z.number().int().positive().nullable().optional().describe('分类 id，null 表示移除分类'),
      },
    },
    async ({ fileId, categoryId }) => {
      await api.put(`/api/files/${fileId}/category`, { categoryId: categoryId ?? null });
      return textResult({ fileId, categoryId: categoryId ?? null });
    }
  );
}

module.exports = { registerCategoryTools };
