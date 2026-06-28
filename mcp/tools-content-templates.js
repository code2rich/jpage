// MCP 内容模板类工具：list_content_templates / get_content_template / instantiate_content_template。
//
// 重构后调用市场公开端点（/market），保证只返回已审核且展示的市场内容。
// 旧 scene 参数保留为兼容入口（映射到 category）；新逻辑以 category 为主。

const { z } = require('zod');
const { textResult } = require('./util');

function registerContentTemplateTools(server, { api, port, mcpIp, protocol }) {
  // --- list_content_templates ---
  server.registerTool(
    'list_content_templates',
    {
      title: 'List Content Templates',
      description: '列出内容模板市场的模板。返回模板元数据（不含完整内容），供 AI 选择合适的风格参考。支持按分类、文件类型、关键词筛选。市场只包含已审核通过且展示的模板。',
      inputSchema: {
        category: z.string().optional().describe('按分类筛选，可传 slug（html-ppt / html-book）或名称（HTML-PPT / HTML-BOOK）'),
        scene: z.string().optional().describe('[兼容] 旧场景参数。dashboard/presentation→html-ppt；report/note/book→html-book；其他忽略'),
        fileType: z.enum(['html', 'markdown']).optional().describe('按文件类型筛选'),
        keyword: z.string().optional().describe('按标题或描述搜索'),
        sort: z.enum(['use_count', 'created_at', 'featured']).optional().describe('排序方式，默认 use_count（最热门优先）'),
        limit: z.number().optional().describe('返回数量，默认 10，最大 20'),
      },
    },
    async ({ category, scene, fileType, keyword, sort, limit }) => {
      // scene 兼容映射到 category
      let resolvedCategory = category;
      if (!resolvedCategory && scene) {
        const pptScenes = ['dashboard', 'presentation', 'card', 'email'];
        const bookScenes = ['report', 'note', 'resume', 'landing', 'other'];
        if (pptScenes.includes(scene)) resolvedCategory = 'html-ppt';
        else if (bookScenes.includes(scene)) resolvedCategory = 'html-book';
      }

      const params = new URLSearchParams();
      if (resolvedCategory) params.set('category', resolvedCategory);
      if (fileType) params.set('fileType', fileType);
      if (keyword) params.set('keyword', keyword);
      if (sort) params.set('sort', sort);
      if (limit) params.set('limit', String(Math.min(limit, 20)));
      const qs = params.toString();
      const data = await api.get('/api/content-templates/market' + (qs ? '?' + qs : ''));
      return textResult(data.templates);
    }
  );

  // --- get_content_template ---
  server.registerTool(
    'get_content_template',
    {
      title: 'Get Content Template',
      description: '获取指定内容模板的完整样例内容。仅可获取市场中已审核通过且展示的模板。AI 拿到样例后，应学习其风格、布局和结构，生成风格一致但内容全新的作品。',
      inputSchema: {
        id: z.number().int().positive().describe('模板 ID（list_content_templates 返回的 id）'),
      },
    },
    async ({ id }) => {
      const data = await api.get(`/api/content-templates/market/${id}/preview`);
      return textResult({
        id: data.id,
        title: data.title,
        file_type: data.file_type,
        content: data.content,
        hint: '请学习此样例的风格和结构，生成风格一致但内容全新的作品。不要复制样例的具体文字内容。生成 HTML 时保持单一自包含文件（CSS/JS 内联、图片 data URI 或在线 URL），不要拆成多文件再打包。',
      });
    }
  );

  // --- instantiate_content_template ---
  server.registerTool(
    'instantiate_content_template',
    {
      title: 'Instantiate Content Template',
      description: '使用指定内容模板在当前 Token 所属用户下创建一个新文件。调用会消耗用户存储空间，并记录模板使用热度。',
      inputSchema: {
        id: z.number().int().positive().describe('模板 ID'),
        originalName: z.string().optional().describe('实例化后的文件名，默认使用模板标题'),
        isPublic: z.boolean().optional().describe('是否设为公开文件，默认 false'),
      },
    },
    async ({ id, originalName, isPublic }) => {
      const data = await api.post(`/api/content-templates/${id}/instantiate`, {
        originalName,
        isPublic,
      });
      return textResult({
        success: true,
        fileId: data.fileId,
        templateId: data.templateId,
        url: `${protocol}://${mcpIp}:${port}/s/${data.shareKey || data.fileId}`,
        hint: '文件已创建到您的文件列表，可直接编辑或分享。',
      });
    }
  );
}

module.exports = { registerContentTemplateTools };
