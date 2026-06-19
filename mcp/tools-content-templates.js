// MCP 内容模板类工具：list_content_templates / get_content_template。
// 从 mcp-server.js 提取，行为保持不变。

const { z } = require('zod');
const { textResult } = require('./util');

function registerContentTemplateTools(server, { api }) {
  // --- list_content_templates ---
  server.registerTool(
    'list_content_templates',
    {
      title: 'List Content Templates',
      description: '列出内容模板市场的模板。返回模板元数据（不含完整内容），供 AI 选择合适的风格参考。支持按场景、文件类型、关键词筛选。',
      inputSchema: {
        scene: z.string().optional().describe('按使用场景筛选：dashboard, report, resume, landing, note, presentation, card, email, other'),
        fileType: z.enum(['html', 'markdown']).optional().describe('按文件类型筛选'),
        keyword: z.string().optional().describe('按标题或描述搜索'),
        sort: z.enum(['use_count', 'created_at']).optional().describe('排序方式，默认 use_count（最热门优先）'),
        limit: z.number().optional().describe('返回数量，默认 10，最大 20'),
      },
    },
    async ({ scene, fileType, keyword, sort, limit }) => {
      const params = new URLSearchParams();
      if (scene) params.set('scene', scene);
      if (fileType) params.set('fileType', fileType);
      if (keyword) params.set('keyword', keyword);
      if (sort) params.set('sort', sort);
      if (limit) params.set('limit', String(Math.min(limit, 20)));
      const qs = params.toString();
      const data = await api.get('/api/content-templates' + (qs ? '?' + qs : ''));
      return textResult(data.templates);
    }
  );

  // --- get_content_template ---
  server.registerTool(
    'get_content_template',
    {
      title: 'Get Content Template',
      description: '获取指定内容模板的完整样例内容。AI 拿到样例后，应学习其风格、布局和结构，生成风格一致但内容全新的作品。',
      inputSchema: {
        id: z.number().int().positive().describe('模板 ID（list_content_templates 返回的 id）'),
      },
    },
    async ({ id }) => {
      const data = await api.get(`/api/content-templates/${id}/content`);
      await api.post(`/api/content-templates/${id}/use`).catch(() => {});
      return textResult({
        id: data.id,
        title: data.title,
        file_type: data.file_type,
        content: data.content,
        hint: '请学习此样例的风格和结构，生成风格一致但内容全新的作品。不要复制样例的具体文字内容。',
      });
    }
  );
}

module.exports = { registerContentTemplateTools };
