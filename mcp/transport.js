// MCP transport 层：会话生命周期 + Express 路由挂载 + 关闭钩子。
// 从 mcp-server.js 提取，行为保持不变。
//
// 持有模块级状态（transports / sessionActivity / sweep timer），
// 每次 session initialize 时通过 getServer(callerToken) 重建 server + dispatcher，
// 把调用者 token 绑进后续所有进程内 API 调用。

const { randomUUID } = require('node:crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const logger = require('../logger');
const { createDispatcher } = require('../lib/dispatch');
const { createMcpServer } = require('./server');

// 历史：早期 MCP tool 用 fetch('http://127.0.0.1:port/...') 自调用 REST（buildApiClient）。
// 现已改为进程内 dispatcher（lib/dispatch.js），绕过 TCP + 二次鉴权 DB 查询，
// 单次调用延迟降 ~80%。原 buildApiClient 已无人引用，本次拆分时移除。

// --- 模块级 session 状态 ---
const transports = {};
const sessionActivity = {};
const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_SWEEP_MS = 10 * 60 * 1000;
let sessionSweepTimer = null;

function touchSession(sid) {
  if (sid) sessionActivity[sid] = Date.now();
}

function sweepSessions() {
  const now = Date.now();
  for (const sid of Object.keys(transports)) {
    const last = sessionActivity[sid] || 0;
    if (now - last > SESSION_TTL_MS) {
      logger.info({ type: 'app', message: 'MCP session 超时清理', sessionId: sid, idleMs: now - last });
      try { transports[sid].close(); } catch (e) {
        logger.error({ type: 'app', message: '关闭超时 session 失败', sessionId: sid, error: e.message });
      }
      delete transports[sid];
      delete sessionActivity[sid];
    }
  }
}

/**
 * 挂载 MCP Streamable HTTP 端点（POST/GET/DELETE /mcp）。
 * @param {object} app - Express app
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

  if (!sessionSweepTimer) {
    sessionSweepTimer = setInterval(sweepSessions, SESSION_SWEEP_MS);
    if (typeof sessionSweepTimer.unref === 'function') sessionSweepTimer.unref();
  }

  function getServer(callerToken) {
    // 进程内直调：绕过 fetch('http://127.0.0.1:port/...') 自调用，
    // 消除 TCP 序列化 + 二次鉴权 DB 查询（MCP 端到端延迟降 50-70%）。
    const api = createDispatcher(app, { token: callerToken || mcpToken });
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
        touchSession(sessionId);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
            touchSession(sid);
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
        return res.status(404).json({
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
      return res.status(404).send('Invalid or missing mcp-session-id');
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  };

  const mcpDeleteHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
      return res.status(404).send('Invalid or missing mcp-session-id');
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
  if (sessionSweepTimer) { clearInterval(sessionSweepTimer); sessionSweepTimer = null; }
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid].close();
    } catch (e) {
      logger.error({ type: 'app', message: '关闭 MCP transport 失败', sessionId: sid, error: e.message });
    }
    delete transports[sid];
    delete sessionActivity[sid];
  }
}

module.exports = { mountMcpServer, closeMcpTransports };
