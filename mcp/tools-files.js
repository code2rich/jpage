// MCP 文件类工具：list_files / upload_file / get_file_content / delete_file /
// rename_file / get_file_url / star_file / unstar_file。
// 从 mcp-server.js 提取，行为保持不变。
//
// 统一接口：导出 register(server, ctx)，ctx = { api, port, mcpIp, protocol }。
// api 是 lib/dispatch 的进程内客户端（{get,post,put,del}），与 fetch 客户端同形。

const { z } = require('zod');
const { textResult, applyTagsAndCategory } = require('./util');
const { ALLOWED_EXTS, MAX_FILE_SIZE } = require('./constants');

function registerFileTools(server, { api, port, mcpIp, protocol }) {
  // --- list_files ---
  server.registerTool(
    'list_files',
    {
      title: 'List Files',
      description: '列出 jpage 中存储的所有 HTML/Markdown 文件元数据。适用于查看已上传文件列表、确认上传结果、或决定后续操作目标。支持分页和排序。',
      inputSchema: {
        page: z.number().optional().describe('页码（默认 1）'),
        limit: z.number().optional().describe('每页数量（默认 20，最大 100）'),
        sort: z.enum(['updated_at', 'created_at', 'original_name', 'size']).optional().describe('排序字段（默认 updated_at）'),
        order: z.enum(['asc', 'desc']).optional().describe('排序方向（默认 desc）'),
        keyword: z.string().optional().describe('按文件名搜索'),
        category: z.string().optional().describe('按分类 ID 筛选，"uncategorized" 表示未分类'),
        tag: z.string().optional().describe('按标签 ID 筛选'),
      },
    },
    async ({ page, limit, sort, order, keyword, category, tag }) => {
      const params = new URLSearchParams();
      if (page) params.set('page', page);
      if (limit) params.set('limit', Math.min(limit, 100));
      if (sort) params.set('sort', sort);
      if (order) params.set('order', order);
      if (keyword) params.set('keyword', keyword);
      if (category) params.set('category', category);
      if (tag) params.set('tag', tag);
      const qs = params.toString();
      const data = await api.get('/api/files' + (qs ? '?' + qs : ''));
      const files = (data.files || []).map((f) => ({
        ...f,
        url: f.share_key ? `${protocol}://${mcpIp}:${port}/s/${f.share_key}` : null,
      }));
      return textResult({ files, pagination: data.pagination });
    }
  );

  // --- upload_file ---
  server.registerTool(
    'upload_file',
    {
      title: 'Upload File',
      description:
        '上传 HTML、Markdown 或 ZIP 文件到 jpage。ZIP 支持两种模式：网站包（含 index.html + 资源，作为整体预览）和批量上传（多个独立 HTML/MD，各自创建记录）。' +
        '非 ZIP 文件类型按扩展名自动识别。返回的 url 字段是可公开访问的预览地址。适用于将生成的报告、笔记、可视化页面等内容上传分享。',
      inputSchema: {
        name: z.string().describe('文件名，需带扩展名，例如 "report.html" 或 "note.md"'),
        content: z.string().describe('文件正文，UTF-8 字符串'),
        isPublic: z
          .boolean()
          .optional()
          .describe('是否公开可访问（无需登录）。默认 true。'),
        overwriteFileId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('显式指定覆盖目标文件 ID。提供时调用覆盖上传 API（POST /api/files/:id/overwrite-json），不提供时走同名自动覆盖逻辑。'),
        tags: z
          .array(z.string())
          .optional()
          .describe('标签名列表，上传后自动设置。标签不存在时自动创建。'),
        categoryId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('分类 id，上传后将文件归入该分类。'),
      },
    },
    async ({ name, content, isPublic, overwriteFileId, tags, categoryId }) => {
      const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();

      // ZIP 文件：content 为 base64 编码
      if (ext === '.zip') {
        const buf = Buffer.from(content, 'base64');
        if (buf.length > MAX_FILE_SIZE) {
          return textResult(`ZIP 文件过大 (${buf.length} 字节)，上限 50MB`, { isError: true });
        }
        try {
          const data = await api.post('/api/files/upload-zip-base64', {
            name,
            content,
            isPublic: isPublic ?? true,
          });
          if (data.type === 'batch') {
            for (const f of data.files) {
              await applyTagsAndCategory(api, f.id, tags, categoryId);
            }
            return textResult({
              type: 'batch',
              count: data.count,
              files: data.files,
            });
          }
          await applyTagsAndCategory(api, data.id, tags, categoryId);
          return textResult({
            ...data,
            url: data.share_key ? `${protocol}://${mcpIp}:${port}/s/${data.share_key}` : `${protocol}://${mcpIp}:${port}/api/files/${data.id}/render`,
          });
        } catch (e) {
          return textResult(`ZIP 上传失败: ${e.message}`, { isError: true });
        }
      }

      if (!ALLOWED_EXTS.includes(ext)) {
        return textResult(
          `不支持的文件扩展名: ${ext}。仅允许 ${ALLOWED_EXTS.join(', ')}`,
          { isError: true }
        );
      }
      const size = Buffer.byteLength(content, 'utf-8');
      if (size > MAX_FILE_SIZE) {
        return textResult(`文件过大 (${size} 字节)，上限 50MB`, { isError: true });
      }
      const uploadPath = overwriteFileId
        ? `/api/files/${overwriteFileId}/overwrite-json`
        : '/api/files/upload-json';
      const data = await api.post(uploadPath, {
        name,
        content,
        isPublic: isPublic ?? true,
      });

      await applyTagsAndCategory(api, data.id, tags, categoryId);

      return textResult({
        ...data,
        url: data.share_key ? `${protocol}://${mcpIp}:${port}/s/${data.share_key}` : `${protocol}://${mcpIp}:${port}/api/files/${data.id}/render`,
      });
    }
  );

  // --- get_file_content ---
  server.registerTool(
    'get_file_content',
    {
      title: 'Get File Content',
      description: '读取指定 id 的文件原始内容（UTF-8 文本）。适用于查看或编辑已有文件内容，不限文件大小。不支持网站包（bundle）类型的 ZIP——list_files 中 is_bundle=1 的文件请改用 get_file_url 获取预览链接。',
      inputSchema: {
        id: z.number().int().positive().describe('文件 id（list_files 返回的 id 字段）'),
      },
    },
    async ({ id }) => {
      const data = await api.get(`/api/files/${id}/content`);
      return textResult({
        id: data.id,
        original_name: data.original_name,
        file_type: data.file_type,
        size: Buffer.byteLength(data.content, 'utf-8'),
        content: data.content,
      });
    }
  );

  // --- delete_file ---
  server.registerTool(
    'delete_file',
    {
      title: 'Delete File',
      description: '删除指定 id 的文件（同时移除数据库记录与磁盘文件）。适用于清理不需要的页面。此操作不可撤销。',
      inputSchema: {
        id: z.number().int().positive().describe('文件 id'),
      },
    },
    async ({ id }) => {
      const data = await api.del(`/api/files/${id}`);
      return textResult({ id, ...data });
    }
  );

  // --- rename_file ---
  server.registerTool(
    'rename_file',
    {
      title: 'Rename File',
      description: '修改指定 id 的文件名（仅 original_name 字段，不影响磁盘存储名）。适用于修正文件名或更改显示标题。',
      inputSchema: {
        id: z.number().int().positive().describe('文件 id'),
        name: z.string().min(1).describe('新文件名，需带扩展名'),
      },
    },
    async ({ id, name }) => {
      const data = await api.put(`/api/files/${id}`, { name });
      return textResult({ id, name, ...data });
    }
  );

  // --- get_file_url ---
  server.registerTool(
    'get_file_url',
    {
      title: 'Get File Public URL',
      description: '返回指定 id 的公开预览短链接（/s/:key）。适用于获取分享链接，无需读取文件内容。',
      inputSchema: {
        id: z.number().int().positive().describe('文件 id'),
      },
    },
    async ({ id }) => {
      const data = await api.get(`/api/files/${id}`);
      const url = data.share_key ? `${protocol}://${mcpIp}:${port}/s/${data.share_key}` : `${protocol}://${mcpIp}:${port}/api/files/${id}/render`;
      return textResult({ id, url, share_key: data.share_key || null });
    }
  );

  // --- star_file ---
  server.registerTool(
    'star_file',
    {
      title: 'Star File',
      description: '收藏指定文件。',
      inputSchema: {
        fileId: z.number().int().positive().describe('文件 id'),
      },
    },
    async ({ fileId }) => {
      await api.post(`/api/files/${fileId}/star`);
      return textResult({ fileId, starred: true });
    }
  );

  // --- unstar_file ---
  server.registerTool(
    'unstar_file',
    {
      title: 'Unstar File',
      description: '取消收藏指定文件。',
      inputSchema: {
        fileId: z.number().int().positive().describe('文件 id'),
      },
    },
    async ({ fileId }) => {
      await api.del(`/api/files/${fileId}/star`);
      return textResult({ fileId, starred: false });
    }
  );
}

module.exports = { registerFileTools };
