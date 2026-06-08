const { randomUUID } = require('node:crypto');
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');

const RESOURCE_MAX_BYTES = 256 * 1024;

function decodeFilename(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

const ALLOWED_EXTS = ['.html', '.htm', '.md', '.markdown'];

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

function createMcpServer({ port, api, mcpIp, protocol }) {
  const server = new McpServer(
    { name: 'jpage', version: '1.0.0' },
    { capabilities: {} }
  );

  server.registerTool(
    'list_files',
    {
      title: 'List Files',
      description: '列出 jpage 中存储的所有 HTML/Markdown 文件元数据。适用于查看已上传文件列表、确认上传结果、或决定后续操作目标。',
      inputSchema: {},
    },
    async () => {
      const data = await api.get('/api/files');
      return textResult(data.files);
    }
  );

  server.registerTool(
    'upload_file',
    {
      title: 'Upload File',
      description:
        '上传 HTML 或 Markdown 文件到 jpage，用于生成页面并获取预览链接。文件类型按扩展名自动识别（html/htm→html, md/markdown→markdown）。' +
        '返回的 url 字段是可公开访问的预览地址。适用于将生成的报告、笔记、可视化页面等内容上传分享。',
      inputSchema: {
        name: z.string().describe('文件名，需带扩展名，例如 "report.html" 或 "note.md"'),
        content: z.string().describe('文件正文，UTF-8 字符串'),
        isPublic: z
          .boolean()
          .optional()
          .describe('是否公开可访问（无需登录）。默认 true。'),
      },
    },
    async ({ name, content, isPublic }) => {
      const decoded = decodeFilename(name);
      const ext = (decoded.match(/\.[^.]+$/) || [''])[0].toLowerCase();
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
      const data = await api.post('/api/files/upload-json', {
        name: decoded,
        content,
        isPublic: isPublic ?? true,
      });
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

  return server;
}

const transports = {};

function mountMcpServer(app, { port, mcpToken, mcpIp, protocol }) {
  if (!mcpToken) {
    console.log('[即页] MCP_TOKEN 未设置，MCP 端点 /mcp 已禁用（设置 MCP_TOKEN 后重启生效）');
    return;
  }
  // Note: we don't gate on adminUserId here — server.js resolves it asynchronously
  // after bootstrapAdmin. requireAuth reads the current adminUserId at request time,
  // so by the time an MCP client connects the token check will work.

  const api = buildApiClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token: mcpToken,
  });

  function getServer() {
    return createMcpServer({ port, api, mcpIp, protocol });
  }

  const bearerAuth = (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== mcpToken) {
      return res.status(401).json({ error: 'MCP 鉴权失败' });
    }
    next();
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
        const server = getServer();
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
      console.error('[即页] MCP POST 错误:', e);
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
      console.error('[即页] MCP DELETE 错误:', e);
      if (!res.headersSent) res.status(500).send('Error processing session termination');
    }
  };

  app.post('/mcp', bearerAuth, mcpPostHandler);
  app.get('/mcp', bearerAuth, mcpGetHandler);
  app.delete('/mcp', bearerAuth, mcpDeleteHandler);

  console.log(`[即页] MCP 端点已挂载: ${protocol}://${mcpIp}:${port}/mcp (Bearer auth)`);
}

async function closeMcpTransports() {
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid].close();
    } catch (e) {
      console.error(`[即页] 关闭 MCP transport ${sid} 失败:`, e);
    }
    delete transports[sid];
  }
}

module.exports = { mountMcpServer, closeMcpTransports };
