// 进程内请求分发：让 MCP tool 不再走 fetch('http://127.0.0.1:port/...') 自调用，
// 而是直接调用同一个 Express app 的路由栈，绕过 TCP 序列化 + 二次鉴权 DB 查询。
//
// 接口与 buildApiClient 完全一致：{ get, post, put, del }，path 以 /api/... 开头，
// 返回 Promise<解析后的 JSON>，失败抛 Error（与 fetch 路径相同：`REST <method> <path> -> <status> <msg>`）。
//
// 实现要点：
//   - 用 net.Socket 作为 req 的 connection/socket，保证流的销毁生命周期正常；
//   - 合成 IncomingMessage（method/url/headers/body），模拟一次 HTTP 请求；
//   - 合成 ServerResponse，缓存 write/end 的字节，结束后解析 JSON；
//   - 通过 app.handle(req, res) 走完整中间件链（含 requireAuth、限流、审计），保证行为与 HTTP 一致；
//   - 认证靠 Authorization: Bearer <token> 头，复用现有 requireAuth 逻辑。
const http = require('http');
const net = require('net');

function makeSocket() {
  // 一个未连接的真实 net.Socket：满足 Node 流销毁对 connection 类型的要求。
  const socket = new net.Socket({ handle: undefined });
  socket.remoteAddress = '127.0.0.1';
  socket.destroy = () => {};
  return socket;
}

function createDispatcher(app, { token }) {
  function call(method, path, body) {
    return new Promise((resolve, reject) => {
      const headers = { host: '127.0.0.1' };
      if (token) headers.authorization = 'Bearer ' + token;
      let payloadBuf = null;
      if (body !== undefined) {
        payloadBuf = Buffer.from(JSON.stringify(body), 'utf8');
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(payloadBuf.length);
      }

      // 合成请求（基于真实 socket）
      const socket = makeSocket();
      const req = new http.IncomingMessage(socket);
      req.method = method.toUpperCase();
      req.url = path;
      req.headers = headers;
      req.httpVersion = '1.1';
      req.httpVersionMajor = 1;
      req.httpVersionMinor = 1;
      if (payloadBuf) req.push(payloadBuf);
      req.push(null);

      // 合成响应
      const res = new http.ServerResponse(req);
      const chunks = [];
      res.write = function (chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; };
      let _headers = {};
      res.writeHead = function (status, h) { res.statusCode = status; if (h) Object.assign(_headers, h); return this; };
      res.setHeader = function (k, v) { _headers[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v); return this; };
      res.getHeader = function (k) { return _headers[String(k).toLowerCase()]; };
      res.removeHeader = function (k) { delete _headers[String(k).toLowerCase()]; return this; };
      const finished = () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
        const status = res.statusCode || 200;
        if (status < 200 || status >= 300) {
          const msg = (data && data.error) || ('HTTP ' + status) || 'unknown error';
          const err = new Error('REST ' + method.toUpperCase() + ' ' + path + ' -> ' + status + ' ' + msg);
          err.status = status;
          return reject(err);
        }
        resolve(data);
      };
      let ended = false;
      res.end = function (chunk) {
        if (ended) return this;
        ended = true;
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        finished();
        return this;
      };

      // 走完整 Express 中间件链
      try {
        app.handle(req, res, () => {
          // 未匹配任何路由 → 404
          if (!ended) {
            res.statusCode = 404;
            chunks.push(Buffer.from(JSON.stringify({ error: 'Not Found' })));
            finished();
          }
        });
      } catch (e) {
        if (!ended) reject(e);
      }
    });
  }
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
    del: (path) => call('DELETE', path),
  };
}

module.exports = { createDispatcher };
