// CLI HTTP 客户端：基于全局 fetch 的薄封装，统一鉴权与错误处理。
//
// 接口形：{ get, post, postForm, put, del }，path 以 /api/... 开头。
// 非预期 JSON（如下载二进制）用 raw(path, init) 拿原始 Response。
//
// 测试注入：createClient 接受可选 fetchImpl 参数。集成测试注入一个打到 supertest
// app 的 fetch shim，避免起真实 TCP 端口（项目既有测试都是 in-process 模式）。
//
// 与 lib/dispatch.js 的区别：dispatch 是「服务端进程内直调」（绕过 TCP），
// 本文件是「客户端经网络调」（真 fetch），两者职责正交。

// 请求失败的统一错误类型。带 status + 可读 message，命令层据此决定退出码与提示。
class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * 创建 API 客户端。
 * @param {object} opts
 * @param {string} opts.base - 服务地址（如 http://localhost:8858），无尾斜杠
 * @param {string} [opts.token] - Bearer token；为空时不发 Authorization 头
 * @param {string} [opts.source] - 上传来源标记，写入 X-Upload-Source 头，默认 'cli'
 * @param {function} [opts.fetchImpl] - 可选 fetch 实现（测试注入）
 * @returns {object}
 */
function createClient({ base, token, source = 'cli', fetchImpl } = {}) {
  const f = fetchImpl || fetch;

  async function raw(path, init = {}) {
    const url = base + path;
    const headers = { ...(init.headers || {}) };
    if (token) headers.Authorization = 'Bearer ' + token;
    // 标记来源为 CLI：后端据此落库 upload_source（认证 token 无法区分 CLI/MCP）
    if (source) headers['x-upload-source'] = source;

    let res;
    try {
      res = await f(url, { ...init, headers });
    } catch (e) {
      // 网络层错误（ECONNREFUSED / DNS / 超时）→ 包装成可识别错误
      const err = new Error(`无法连接到 ${base}：${e.message}`);
      err.name = 'NetworkError';
      err.cause = e;
      throw err;
    }
    return res;
  }

  // JSON 请求：发 JSON body，期望 JSON 响应。失败抛 HttpError。
  async function json(method, path, body) {
    const init = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await raw(path, init);
    return parseJson(res, method, path);
  }

  async function parseJson(res, method, path) {
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = (data && data.error) || `HTTP ${res.status}`;
      throw new HttpError(res.status, `REST ${method} ${path} -> ${res.status} ${msg}`, data);
    }
    return data;
  }

  return {
    raw,
    get: (p) => json('GET', p),
    post: (p, body) => json('POST', p, body),
    put: (p, body) => json('PUT', p, body),
    del: (p) => json('DELETE', p),
    // multipart：调用方传已构造好的 FormData
    postForm: async (p, formData) => {
      const res = await raw(p, { method: 'POST', body: formData });
      return parseJson(res, 'POST', p);
    },
  };
}

module.exports = { createClient, HttpError };
