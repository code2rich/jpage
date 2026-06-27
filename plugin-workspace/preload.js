/**
 * 即页 uTools 插件 · preload 脚本
 *
 * 运行在 Node 环境，通过 window.jpage 把 API 暴露给前端页面。
 *
 * 为什么所有 HTTP 都在 preload（Node 侧）做？
 *  - 即页服务端 CORS 设的是 `Access-Control-Allow-Origin: *`，但**没有**
 *    `Access-Control-Allow-Credentials: true`，浏览器 fetch 无法跨域携带 cookie。
 *  - 即页是 session/cookie 鉴权（非 token），cookie 必须随请求带上。
 *  - 所以用 Node 原生 http/https + 自带 cookie jar 发请求，绕开浏览器 CORS 限制。
 *
 * 只依赖 Node 内置模块（http/https/url/fs/path/crypto），不引第三方包，
 * 打包成 upx 时无需 bundle node_modules。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// utools 在 preload 上下文里以全局变量注入
// （部分老版本用 require('utools')，这里做兼容）

// ---------------------------------------------------------------------------
// 配置 & 会话持久化（utools.dbStorage 是同步键值存储）
// ---------------------------------------------------------------------------

const DB_KEYS = {
  base: 'jpage.base',        // 服务器地址，如 https://jpage.example.com
  account: 'jpage.account',  // 上次登录用的账号（仅用于回填输入框，不存密码）
  cookies: 'jpage.cookies',  // cookie jar（数组）
  user: 'jpage.user',        // 上次登录的用户信息
  theme: 'jpage.theme',      // 'dark' | 'light' | 'auto'
};

function getCfg(key, fallback) {
  try {
    const v = utools.dbStorage.getItem(key);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function setCfg(key, value) {
  try {
    utools.dbStorage.setItem(key, value);
  } catch (e) {
    console.error('写入 dbStorage 失败', key, e);
  }
}

function removeCfg(key) {
  try {
    utools.dbStorage.removeItem(key);
  } catch {}
}

// ---------------------------------------------------------------------------
// Cookie jar（极简实现，够用即可：只按 domain 存 Set-Cookie，发请求时回带）
// ---------------------------------------------------------------------------

function getBase() {
  let base = (getCfg(DB_KEYS.base, '') || '').trim();
  if (base.endsWith('/')) base = base.slice(0, -1);
  return base;
}

function setBase(url) {
  setCfg(DB_KEYS.base, url);
}

function domainMatches(host, cookieDomain) {
  // 安全的 domain 匹配：
  // - cookieDomain 为空 → 精确匹配 host（同源 cookie）
  // - cookieDomain 以 . 开头 → 匹配 host 本身及其子域
  // - cookieDomain 不以 . 开头 → 精确匹配
  // 避免 endsWith 导致的 attackerexample.com 匹配 example.com
  if (!cookieDomain) return true;
  const cd = cookieDomain.replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  if (h === cd) return true;
  return h.endsWith('.' + cd);
}

function getCookieString(targetUrl) {
  const cookies = getCfg(DB_KEYS.cookies, []) || [];
  if (!cookies.length) return '';
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return '';
  }
  const now = Date.now();
  const parts = [];
  for (const c of cookies) {
    // 过期判断
    if (c.expires && c.expires > 0 && c.expires <= now) continue;
    // domain 匹配
    if (c.domain && !domainMatches(target.hostname, c.domain)) continue;
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join('; ');
}

/**
 * 把响应的 set-cookie 合并进 jar。
 * 解析极简：只取 name=value 与 Max-Age/Expires。
 */
function mergeSetCookies(targetUrl, setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return;
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return;
  }
  const jar = getCfg(DB_KEYS.cookies, []) || [];
  const now = Date.now();

  for (const raw of setCookieHeaders) {
    if (!raw) continue;
    const segs = raw.split(';').map((s) => s.trim());
    const [nv, ...attrs] = segs;
    const eq = nv.indexOf('=');
    if (eq < 0) continue;
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    if (!name) continue;

    let domain = target.hostname;
    let expires = 0;
    for (const a of attrs) {
      const lower = a.toLowerCase();
      if (lower.startsWith('domain=')) {
        domain = a.slice(7).trim().replace(/^\./, '');
      } else if (lower.startsWith('max-age=')) {
        const sec = parseInt(a.slice(8).trim(), 10);
        if (!isNaN(sec)) expires = sec <= 0 ? 0 : now + sec * 1000;
      } else if (lower.startsWith('expires=')) {
        const d = Date.parse(a.slice(8).trim());
        if (!isNaN(d)) expires = d;
      }
    }

    // 删掉同 name 的旧值
    for (let i = jar.length - 1; i >= 0; i--) {
      if (jar[i].name === name) jar.splice(i, 1);
    }
    jar.push({ name, value, domain, expires });
  }

  // 清掉已过期的
  const clean = jar.filter((c) => !(c.expires && c.expires > 0 && c.expires <= now));
  setCfg(DB_KEYS.cookies, clean);
}

function clearCookies() {
  setCfg(DB_KEYS.cookies, []);
}

// ---------------------------------------------------------------------------
// 底层 HTTP 请求（带 cookie）
// ---------------------------------------------------------------------------

/**
 * 发起请求。返回 { status, headers, body, raw }
 *  - 自动带 cookie
 *  - 自动合并 set-cookie
 *  - 支持重定向（3xx，最多 5 跳）
 *  - 支持 JSON / 表单 / multipart / 纯文本
 */
function request(method, urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      headers = {},
      body = null,           // string | Buffer | null
      json = false,          // 若 true，把 body 当对象序列化并设 json content-type
      form = false,          // 若 true，把 body 当对象做 urlencoded
      multipart = null,      // { boundary, parts: [{name, filename, contentType, data}] }
      timeout = 30000,
      redirectCount = 0,
    } = options;

    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(new Error('地址格式不正确：' + urlStr));
    }

    const lib = url.protocol === 'https:' ? https : http;

    // 组装 body & content-type
    let outBody = body;
    const outHeaders = { ...headers };

    if (json && body != null) {
      outBody = JSON.stringify(body);
      if (!outHeaders['Content-Type']) outHeaders['Content-Type'] = 'application/json; charset=utf-8';
    }
    if (form && body != null && typeof body === 'object') {
      outBody = new URLSearchParams(body).toString();
      if (!outHeaders['Content-Type']) outHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (multipart) {
      outBody = buildMultipartBody(multipart);
      if (!outHeaders['Content-Type']) {
        outHeaders['Content-Type'] = `multipart/form-data; boundary=${multipart.boundary}`;
      }
    }

    // cookie
    const cookieStr = getCookieString(urlStr);
    if (cookieStr) outHeaders['Cookie'] = cookieStr;
    if (outBody != null && outBody.length != null && !outHeaders['Content-Length']) {
      outHeaders['Content-Length'] = Buffer.byteLength(outBody);
    }

    const reqOpts = {
      method: method.toUpperCase(),
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: outHeaders,
    };

    const req = lib.request(reqOpts, (res) => {
      // 重定向
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirectCount < 5
      ) {
        res.resume(); // 丢弃当前响应体
        const next = new URL(res.headers.location, urlStr).toString();
        return resolve(
          request(method, next, { ...options, redirectCount: redirectCount + 1 })
        );
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        // 合并 set-cookie（可能为单条或数组）
        const sc = res.headers['set-cookie'];
        if (sc) mergeSetCookies(urlStr, Array.isArray(sc) ? sc : [sc]);

        const buf = Buffer.concat(chunks);
        let parsed = null;
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try {
            parsed = JSON.parse(buf.toString('utf8'));
          } catch {
            parsed = null;
          }
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed !== null ? parsed : buf.toString('utf8'),
          raw: buf,
          ok: res.statusCode >= 200 && res.statusCode < 300,
        });
      });
    });

    req.on('error', (e) => reject(e));
    req.setTimeout(timeout, () => {
      req.destroy(new Error('请求超时（' + timeout + 'ms）'));
    });

    if (outBody != null) req.write(outBody);
    req.end();
  });
}

// multipart 构造
function escapeMultipartValue(s) {
  // 转义 Content-Disposition 中 name/filename 的引号与反斜杠，避免破坏 multipart 头。
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildMultipartBody(mp) {
  const { boundary, parts } = mp;
  const segs = [];
  for (const p of parts) {
    segs.push(Buffer.from(`--${boundary}\r\n`));
    let disp = `Content-Disposition: form-data; name="${escapeMultipartValue(p.name)}"`;
    if (p.filename) disp += `; filename="${escapeMultipartValue(p.filename)}"`;
    disp += '\r\n';
    if (p.contentType) disp += `Content-Type: ${p.contentType}\r\n`;
    segs.push(Buffer.from(disp + '\r\n'));
    segs.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    segs.push(Buffer.from('\r\n'));
  }
  segs.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(segs);
}

// ---------------------------------------------------------------------------
// 即页 API 封装（统一拼 base + /api/...）
// ---------------------------------------------------------------------------

function apiUrl(pathAndQuery) {
  const base = getBase();
  if (!base) throw new Error('尚未配置服务器地址，请先在「设置」中填写');
  const p = pathAndQuery.startsWith('/') ? pathAndQuery : '/' + pathAndQuery;
  return base + p;
}

/**
 * 统一业务请求：解析 { error } 并抛错，成功返回 body（若整个 body 就是数据）。
 * 对 GET query 对象做自动序列化。
 */
async function api(method, path, { query, data, json, form, multipart, timeout, headers } = {}) {
  let full = apiUrl(path);
  if (query && typeof query === 'object') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) full += (full.includes('?') ? '&' : '?') + s;
  }

  const opts = { timeout: timeout || 30000 };
  if (headers && typeof headers === 'object') opts.headers = headers;
  if (json) {
    opts.json = true;
    opts.body = data;
  } else if (form) {
    opts.form = true;
    opts.body = data;
  } else if (multipart) {
    opts.multipart = multipart;
  }

  const res = await request(method, full, opts);

  // 会话失效：清掉本地登录态，让前端跳登录
  if (res.status === 401) {
    clearLocalUser();
    const err = new Error(
      (res.body && res.body.error) || '未登录或会话已过期'
    );
    err.code = 'UNAUTHORIZED';
    err.status = 401;
    throw err;
  }

  if (res.status >= 400) {
    const msg =
      (res.body && res.body.error) ||
      (typeof res.body === 'string' ? res.body : null) ||
      `请求失败（${res.status}）`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = res.body;
    throw err;
  }

  return res.body;
}

function clearLocalUser() {
  removeCfg(DB_KEYS.user);
}

function applyTheme(theme) {
  try {
    const html = document.documentElement;
    if (!html) return;
    html.classList.remove('dark', 'light');
    if (theme === 'dark' || theme === 'light') {
      html.classList.add(theme);
    }
  } catch (e) {
    console.error('[即页] 应用主题失败', e);
  }
}

// ---------------------------------------------------------------------------
// 暴露给前端的 API：window.jpage
// ---------------------------------------------------------------------------

const jpage = {
  // ---- 配置 ----
  getConfig() {
    return {
      base: getBase(),
      account: getCfg(DB_KEYS.account, ''),
      user: getCfg(DB_KEYS.user, null),
      hasSession: !!(getCfg(DB_KEYS.cookies, []) || []).length,
      theme: getCfg(DB_KEYS.theme, 'auto'),
    };
  },
  setBase(url) {
    // 简单规范化：补协议、去末尾斜杠
    let u = (url || '').trim();
    if (!u) throw new Error('请填写服务器地址');
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    try {
      new URL(u); // 校验
    } catch {
      throw new Error('服务器地址格式不正确');
    }
    if (u.endsWith('/')) u = u.slice(0, -1);
    setBase(u);
    return u;
  },
  clearBase() {
    removeCfg(DB_KEYS.base);
  },
  getTheme() {
    return getCfg(DB_KEYS.theme, 'auto');
  },
  setTheme(theme) {
    if (!['auto', 'dark', 'light'].includes(theme)) theme = 'auto';
    setCfg(DB_KEYS.theme, theme);
    applyTheme(theme);
    return theme;
  },

  // ---- 认证 ----
  /**
   * 登录：POST /api/auth/login {account, password}
   * account 支持用户名或邮箱（服务端自动识别）。
   */
  async login({ account, password }) {
    if (!account || !password) throw new Error('请输入账号和密码');
    if (!getBase()) throw new Error('请先填写服务器地址');
    const body = await api('POST', '/api/auth/login', {
      json: true,
      data: { account, password },
    });
    setCfg(DB_KEYS.account, account);
    setCfg(DB_KEYS.user, body); // {id, username, email, emailVerified, role}
    return body;
  },

  /** 校验当前会话是否仍有效 */
  async me() {
    const body = await api('GET', '/api/auth/me');
    setCfg(DB_KEYS.user, body);
    return body;
  },

  async logout() {
    try {
      await api('POST', '/api/auth/logout');
    } catch {
      /* 忽略，本地照样清 */
    }
    clearCookies();
    clearLocalUser();
    return { success: true };
  },

  async changePassword({ currentPassword, newPassword }) {
    return api('POST', '/api/auth/change-password', {
      json: true,
      data: { currentPassword, newPassword },
    });
  },

  async updateProfile({ username, email }) {
    return api('POST', '/api/auth/profile', {
      json: true,
      data: { username, email },
    });
  },

  /** 探测目标服务器是否是即页（调 /health） */
  async ping(baseUrl) {
    let target = baseUrl || getBase();
    if (!target) throw new Error('请先填写服务器地址');
    // 规范化：补协议、去末尾斜杠（与 setBase 保持一致），
    // 否则像 "36.138.227.105:8858" 这种无协议地址会被 new URL() 当成相对路径解析失败
    target = target.trim();
    if (!/^https?:\/\//i.test(target)) target = 'http://' + target;
    target = target.replace(/\/$/, '');
    const res = await request('GET', target + '/health', {
      timeout: 8000,
    });
    if (res.status === 503) {
      throw new Error('服务器可达但状态异常（数据库或磁盘不可用）');
    }
    if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
    return res.body;
  },

  // ---- 文件 ----
  listFiles(params = {}) {
    // params: page, limit, sort, order, keyword, category, tag
    return api('GET', '/api/files', { query: params });
  },

  searchFiles(q, params = {}) {
    return api('GET', '/api/files/search', { query: { q, ...params } });
  },

  getFile(id) {
    return api('GET', `/api/files/${id}`);
  },

  getFileContent(id) {
    return api('GET', `/api/files/${id}/content`);
  },

  async getFileRenderUrl(id) {
    const f = await api('GET', `/api/files/${id}`);
    return getBase() + `/s/${f.share_key}`;
  },

  getShareUrl(shareKey) {
    if (!shareKey) throw new Error('缺少 share_key');
    return getBase() + `/s/${shareKey}`;
  },

  /**
   * 以 JSON 上传文本（HTML/Markdown）。
   * @param {string} name  文件名（必须带 .html/.htm/.md/.markdown）
   * @param {string} content  正文
   * @param {boolean} isPublic
   */
  uploadText({ name, content, isPublic = true }) {
    return api('POST', '/api/files/upload-json', {
      json: true,
      data: { name, content, isPublic },
      timeout: 60000,
      headers: { 'X-Upload-Source': 'utools' },
    });
  },

  /**
   * multipart 上传本地文件（任意类型，含 .zip bundle）。
   * @param {string} filePath 本地绝对路径
   */
  async uploadFile({ filePath, isPublic = true }) {
    if (!fs.existsSync(filePath)) throw new Error('文件不存在：' + filePath);
    const name = path.basename(filePath);
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(name).toLowerCase();
    const ct =
      ext === '.zip' ? 'application/zip' :
      ext === '.html' || ext === '.htm' ? 'text/html' :
      ext === '.md' || ext === '.markdown' ? 'text/markdown' :
      'application/octet-stream';
    const boundary = 'jpage-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
    return api('POST', '/api/files/upload', {
      multipart: {
        boundary,
        parts: [
          { name: 'isPublic', data: String(isPublic) },
          { name: 'file', filename: name, contentType: ct, data: buf },
        ],
      },
      timeout: 120000,
      headers: { 'X-Upload-Source': 'utools' },
    });
  },

  updateFile(id, { name, isPublic, templateId } = {}) {
    return api('PUT', `/api/files/${id}`, {
      json: true,
      data: { name, isPublic, templateId },
    });
  },

  deleteFile(id) {
    return api('DELETE', `/api/files/${id}`);
  },

  starFile(id) {
    return api('POST', `/api/files/${id}/star`);
  },
  unstarFile(id) {
    return api('DELETE', `/api/files/${id}/star`);
  },

  setFileCategory(id, categoryId) {
    return api('PUT', `/api/files/${id}/category`, {
      json: true,
      data: { categoryId: categoryId || null },
    });
  },

  setFileTags(id, tagIds) {
    return api('PUT', `/api/files/${id}/tags`, {
      json: true,
      data: { tagIds },
    });
  },

  listVersions(id) {
    return api('GET', `/api/files/${id}/versions`);
  },
  getVersionContent(id, version) {
    return api('GET', `/api/files/${id}/versions/${version}/content`);
  },
  restoreVersion(id, version) {
    return api('POST', `/api/files/${id}/versions/${version}/restore`);
  },

  // ---- 分享设置 ----
  updateShareSettings(id, { alias, expiresAt, password } = {}) {
    const data = {};
    if (alias !== undefined) data.alias = alias;
    if (expiresAt !== undefined) data.expiresAt = expiresAt;
    if (password !== undefined) data.password = password;
    return api('PUT', `/api/files/${id}/share`, { json: true, data });
  },
  regenerateShareKey(id) {
    return api('POST', `/api/files/${id}/share/regenerate`);
  },

  // ---- 渲染模板 ----
  listTemplates() {
    return api('GET', '/api/templates');
  },

  // ---- 标签 ----
  listTags() {
    return api('GET', '/api/tags');
  },
  createTag(name) {
    return api('POST', '/api/tags', { json: true, data: { name } });
  },
  deleteTag(id) {
    return api('DELETE', `/api/tags/${id}`);
  },

  // ---- 分类 ----
  listCategories() {
    return api('GET', '/api/categories');
  },
  createCategory(name) {
    return api('POST', '/api/categories', { json: true, data: { name } });
  },

  // ---- 工具 ----
  /** 在系统默认浏览器打开 URL */
  openExternal(url) {
    utools.shellOpenExternal(url);
  },
  /** 复制到剪贴板 */
  copyText(text) {
    utools.copyText(text);
  },
  /** 选本地文件（返回 [{filePath}] 或 null） */
  selectFile(title) {
    return utools.showOpenDialog({
      title: title || '选择文件',
      properties: ['openFile'],
      filters: [
        { name: '即页支持的文件', extensions: ['html', 'htm', 'md', 'markdown', 'zip'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
  },
  /** toast 提示 */
  toast(msg) {
    utools.showNotification ? utools.showNotification(msg) : console.log(msg);
  },
};

// 注入到渲染进程
try {
  window.jpage = jpage;
} catch (e) {
  console.error('[即页 preload] 注入 window.jpage 失败', e);
}
