const { randomUUID } = require('node:crypto');
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const logger = require('./logger');

const RESOURCE_MAX_BYTES = 256 * 1024;

function decodeFilename(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

const ALLOWED_EXTS = ['.html', '.htm', '.md', '.markdown', '.zip'];

function buildApiClient({ baseUrl, token }) {
  async function call(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!res.ok) {
      const msg = (data && data.error) || res.statusText || 'unknown error';
      throw new Error(`REST ${method} ${path} -> ${res.status} ${msg}`);
    }
    return data;
  }
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
    del: (path) => call('DELETE', path),
  };
}

function textResult(payload, opts = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatTime(iso) {
  if (!iso) return '未知时间';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function createMcpServer({ port, api, mcpIp, protocol }) {
  const server = new McpServer(
    { name: 'jpage', version: '1.0.0' },
    { capabilities: {} }
  );

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
      if (limit) params.set('limit', limit);
      if (sort) params.set('sort', sort);
      if (order) params.set('order', order);
      if (keyword) params.set('keyword', keyword);
      if (category) params.set('category', category);
      if (tag) params.set('tag', tag);
      const qs = params.toString();
      const data = await api.get('/api/files' + (qs ? '?' + qs : ''));
      return textResult(data.files);
    }
  );

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
      const decoded = decodeFilename(name);
      const ext = (decoded.match(/\.[^.]+$/) || [''])[0].toLowerCase();

      // ZIP 文件：content 为 base64 编码
      if (ext === '.zip') {
        const buf = Buffer.from(content, 'base64');
        if (buf.length > 50 * 1024 * 1024) {
          return textResult(`ZIP 文件过大 (${buf.length} 字节)，上限 50MB`, { isError: true });
        }
        try {
          const data = await api.post('/api/files/upload-zip-base64', {
            name: decoded,
            content: content,
            isPublic: isPublic ?? true,
          });
          if (data.type === 'batch') {
            return textResult({
              type: 'batch',
              count: data.count,
              files: data.files,
            });
          }
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
      if (size > 50 * 1024 * 1024) {
        return textResult(`文件过大 (${size} 字节)，上限 50MB`, { isError: true });
      }
      const uploadPath = overwriteFileId
        ? `/api/files/${overwriteFileId}/overwrite-json`
        : '/api/files/upload-json';
      const data = await api.post(uploadPath, {
        name: decoded,
        content,
        isPublic: isPublic ?? true,
      });

      // 设置标签
      if (tags && tags.length > 0) {
        const tagIds = [];
        for (const t of tags) {
          const allTags = await api.get('/api/tags');
          const existing = allTags.tags.find(x => x.name === t);
          if (existing) { tagIds.push(existing.id); continue; }
          const created = await api.post('/api/tags', { name: t });
          tagIds.push(created.id);
        }
        await api.put(`/api/files/${data.id}/tags`, { tagIds });
      }

      // 设置分类
      if (categoryId) {
        await api.put(`/api/files/${data.id}/category`, { categoryId });
      }

      return textResult({
        ...data,
        url: data.share_key ? `${protocol}://${mcpIp}:${port}/s/${data.share_key}` : `${protocol}://${mcpIp}:${port}/api/files/${data.id}/render`,
      });
    }
  );

  server.registerTool(
    'get_file_content',
    {
      title: 'Get File Content',
      description: '读取指定 id 的文件原始内容（UTF-8 文本）。适用于查看或编辑已有文件内容，不限文件大小。',
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
        size: data.content.length,
        content: data.content,
      });
    }
  );

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
      const data = await api.get(`/api/files/${id}/content`);
      const url = data.share_key ? `${protocol}://${mcpIp}:${port}/s/${data.share_key}` : `${protocol}://${mcpIp}:${port}/api/files/${id}/render`;
      return textResult({ id, url });
    }
  );

  server.registerTool(
    'list_file_versions',
    {
      title: 'List File Versions',
      description: '列出指定文件的版本历史，包括当前版本信息。适用于查看文件修改历史、确认版本数量、或决定是否恢复到某个历史版本。',
      inputSchema: {
        fileId: z.number().positive().describe('文件 ID'),
      },
    },
    async ({ fileId }) => {
      const data = await api.get(`/api/files/${fileId}/versions`);
      const current = data.current;
      const versions = data.versions || [];
      const currentSize = formatSize(current.size);
      const updatedAt = formatTime(current.updated_at);
      let lines = [`文件 #${fileId} 版本历史（共 ${versions.length} 个历史版本）：`];
      lines.push(`当前版本: ${currentSize}, 更新于 ${updatedAt}`);
      for (const v of versions) {
        const vSize = formatSize(v.size);
        const vTime = formatTime(v.created_at);
        lines.push(`v${v.version}: ${vSize}, ${vTime}  [查看 | 恢复 | 删除]`);
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'restore_file_version',
    {
      title: 'Restore File Version',
      description: '恢复指定文件到某个历史版本。恢复后当前版本会被保存为新的历史版本，目标历史版本的内容成为新的当前版本。适用于撤销误修改或回退到之前的版本。',
      inputSchema: {
        fileId: z.number().positive().describe('文件 ID'),
        version: z.number().positive().describe('要恢复的版本号'),
      },
    },
    async ({ fileId, version }) => {
      const data = await api.post(`/api/files/${fileId}/versions/${version}/restore`);
      return textResult({
        fileId,
        restoredVersion: version,
        ...data,
      });
    }
  );

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
      const tagIds = [];
      for (const name of tags) {
        const allTags = await api.get('/api/tags');
        const existing = allTags.tags.find(t => t.name === name);
        if (existing) { tagIds.push(existing.id); continue; }
        const created = await api.post('/api/tags', { name });
        tagIds.push(created.id);
      }
      await api.put(`/api/files/${fileId}/tags`, { tagIds });
      return textResult({ fileId, tags });
    }
  );

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

  return server;
}

const transports = {};

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.mcpToken - 全局 MCP_TOKEN（可为空，此时必须有用户级 Token）
 * @param {string} opts.mcpIp
 * @param {string} opts.protocol
 * @param {function} opts.authenticateRequest - async (tokenValue) => boolean，验证 Bearer token
 */
function mountMcpServer(app, { port, mcpToken, mcpIp, protocol, authenticateRequest }) {
  if (!mcpToken && !authenticateRequest) {
    logger.info({ type: 'app', message: 'MCP_TOKEN 未设置且无 Token 验权，MCP 端点 /mcp 已禁用' });
    return;
  }

  function getServer(callerToken) {
    const api = buildApiClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: callerToken || mcpToken,
    });
    return createMcpServer({ port, api, mcpIp, protocol });
  }

  const bearerAuth = async (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'MCP 鉴权失败' });
    }
    const tokenValue = auth.slice(7);

    // 旧 MCP_TOKEN 向后兼容
    if (mcpToken && tokenValue === mcpToken) {
      return next();
    }

    // 用户级 Token 验证
    if (authenticateRequest) {
      const valid = await authenticateRequest(tokenValue).catch(() => false);
      if (valid) return next();
    }

    return res.status(401).json({ error: 'MCP 鉴权失败' });
  };

  const mcpPostHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    try {
      let transport;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) delete transports[sid];
        };
        const callerToken = req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : mcpToken;
        const server = getServer(callerToken);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: 缺少有效 mcp-session-id 或 initialize 请求' },
          id: null,
        });
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      logger.error({ type: 'app', message: 'MCP POST 错误', error: e.message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: e.message || 'Internal server error' },
          id: null,
        });
      }
    }
  };

  const mcpGetHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
      return res.status(400).send('Invalid or missing mcp-session-id');
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  };

  const mcpDeleteHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
      return res.status(400).send('Invalid or missing mcp-session-id');
    }
    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (e) {
      logger.error({ type: 'app', message: 'MCP DELETE 错误', error: e.message });
      if (!res.headersSent) res.status(500).send('Error processing session termination');
    }
  };

  app.post('/mcp', bearerAuth, mcpPostHandler);
  app.get('/mcp', bearerAuth, mcpGetHandler);
  app.delete('/mcp', bearerAuth, mcpDeleteHandler);

  logger.info({ type: 'app', message: 'MCP 端点已挂载', url: `${protocol}://${mcpIp}:${port}/mcp` });
}

async function closeMcpTransports() {
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid].close();
    } catch (e) {
      logger.error({ type: 'app', message: '关闭 MCP transport 失败', sessionId: sid, error: e.message });
    }
    delete transports[sid];
  }
}

module.exports = { mountMcpServer, closeMcpTransports };
