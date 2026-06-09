# 即页虚拟主机（Virtual Hosting）方案可行性分析

> 分析日期：基于即页当前代码库（server.js v1.0.0，Node.js + Express + SQLite3）

---

## 一、当前架构快照

| 维度 | 现状 |
|------|------|
| **技术栈** | Node.js 20 + Express 4 + SQLite3 |
| **部署方式** | Docker 单容器，端口 8858 |
| **当前访问** | 内网 `36.138.227.105:8858` |
| **路由结构** | `/s/:key` 通过 `share_key` 查 `files` 表渲染 |
| **数据库** | SQLite 单文件，`files` / `users` / `tokens` / `tags` / `categories` |
| **多租户** | ❌ 无，当前是单实例单用户群 |
| **自定义域名** | ❌ 无支持 |
| **SSL** | ❌ 当前内网 HTTP，无证书管理 |

---

## 二、方案可行性结论

### ✅ 总体判断：技术上完全可行，但需要分阶段实施

你描述的 **基于 HTTP Host 头部的虚拟主机** 确实是现代 SaaS 的标准做法。即页当前是 Express 单体应用，改造成本可控，不需要推翻重来。

**但有一个关键前提需要明确：**

> 当前即页部署在内网 IP（`36.138.227.105:8858`），**自定义域名方案要求服务必须暴露在公网**（或至少有一个公网入口），否则企业的 CNAME 无法解析到你的服务器。

---

## 三、具体可行性拆解

### 3.1 技术适配度：高 ✅

Express 原生支持读取 `req.headers.host`，改造只需增加一个中间件：

```javascript
// 新增：虚拟主机识别中间件（放在所有路由之前）
app.use(async (req, res, next) => {
  const host = req.headers.host?.split(':')[0]; // 去掉端口
  
  // 跳过平台自有域名和 API 路由
  if (host === 'jpage.code2rich.com' || host === 'localhost' || req.path.startsWith('/api/')) {
    return next();
  }
  
  // 查自定义域名表
  const domain = await dbGet(
    'SELECT d.*, u.username FROM custom_domains d JOIN users u ON d.user_id = u.id WHERE d.domain = ? AND d.verified = 1',
    [host]
  );
  
  if (domain) {
    req.tenant = {
      userId: domain.user_id,
      username: domain.username,
      domain: host
    };
  }
  
  next();
});
```

### 3.2 数据库改造：小 ✅

只需新增一张表（migration 即可）：

```javascript
// migrations/008_add_custom_domains.js
module.exports = {
  name: 'add_custom_domains',
  async up(db, { dbRun }) {
    await dbRun(db, `CREATE TABLE IF NOT EXISTS custom_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      domain TEXT UNIQUE NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      ssl_status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_custom_domains_domain ON custom_domains(domain)');
  }
};
```

### 3.3 路由改造：中 ⚠️

**核心矛盾：** 当前 `/s/:key` 是全局唯一的短链，虚拟主机方案下需要决定：

| 方案 | URL 示例 | 说明 |
|------|---------|------|
| A. 保留 `/s/:key`，Host 只影响品牌 | `www.jpage.com/s/AmeAQDsZ` | 最简单，Host 只决定渲染时是否显示白标 |
| B. Host + 路径双重路由 | `www.jpage.com/s/AmeAQDsZ` 或 `www.jpage.com/about` | 需要企业可配置路径映射，复杂度上升 |
| C. 纯 Host 路由（放弃短链） | `www.jpage.com/` → 企业首页 | 每个域名绑定一个「主文件」，其他文件走子路径 |

**推荐即页现阶段采用方案 A**：
- 自定义域名访问 `/s/:key` 时，正常渲染文件
- 但页面去掉即页 Logo/导航，显示企业品牌（White-label）
- 企业后台可配置：域名绑定、页面标题、Logo URL、主题色

### 3.4 SSL 证书：中 ⚠️

这是最大的工程点。你有三个选择：

| 方案 | 复杂度 | 成本 | 说明 |
|------|--------|------|------|
| **Cloudflare CDN 代理** | 低 | 免费 | 企业 CNAME 到 Cloudflare，Cloudflare 自动处理 SSL，你的源站保持 HTTP |
| **Caddy 自动 HTTPS** | 中 | 免费 | Caddy 内置 Let's Encrypt 自动颁发，替换 Nginx 即可 |
| **手动 Let's Encrypt** | 高 | 免费 | 需要 certbot + 定时续期脚本，维护负担重 |

**推荐：Cloudflare 方案**（见下文架构图）。

### 3.5 部署环境：需要调整 ⚠️

当前内网 IP 无法接收公网 CNAME 流量。需要：

1. **公网入口**：云服务器 + 公网 IP，或内网穿透（frp/ngrok，不推荐生产）
2. **域名解析**：平台需要一个「平台域名」供企业 CNAME 指向，如 `cname.jpage.code2rich.com`
3. **防火墙**：开放 80/443，当前 8858 是内部端口

---

## 四、推荐架构（分阶段）

### 阶段一：MVP 白标（最小可行）

```
┌─────────────────┐     CNAME      ┌─────────────────────────────┐
│  www.jpage.com  │ ──────────────→ │  Cloudflare (CDN + SSL 终止)  │
│  (企业自定义域名)  │                │  自动证书 + Host 头部透传      │
└─────────────────┘                └─────────────────────────────┘
                                                  │
                                                  ▼
                                    ┌─────────────────────────────┐
                                    │  云服务器 (ECS/轻量应用)       │
                                    │  ─────────────────────────   │
                                    │  Caddy/Nginx (反向代理)      │
                                    │    → Host 头部透传给 Express │
                                    │  ─────────────────────────   │
                                    │  Docker: jpage:8858         │
                                    │    → SQLite 数据持久化       │
                                    └─────────────────────────────┘
```

**阶段一能力：**
- 企业添加 CNAME → `cname.jpage.code2rich.com`
- Cloudflare 自动处理 SSL
- 即页读取 Host，渲染时去掉平台品牌，显示企业名称
- 无需改路由结构，`/s/:key` 继续工作

### 阶段二：完整多租户（未来）

- 每个用户独立文件空间
- 企业可配置「主页面」（域名根路径 `/` 显示指定文件）
- 子路径路由 `/about`、 `/contact` 等
- 独立访问统计

---

## 五、具体代码实现（阶段一）

### 5.1 新增 Migration

```javascript
// migrations/008_add_custom_domains.js
module.exports = {
  name: 'add_custom_domains',
  async up(db, { dbRun }) {
    await dbRun(db, `CREATE TABLE IF NOT EXISTS custom_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      domain TEXT UNIQUE NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      page_title TEXT,
      logo_url TEXT,
      theme_color TEXT DEFAULT '#2563eb',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_custom_domains_domain ON custom_domains(domain)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_custom_domains_user ON custom_domains(user_id)');
  }
};
```

### 5.2 新增虚拟主机中间件

```javascript
// 在 server.js 中，session 中间件之后添加

const PLATFORM_DOMAINS = new Set([
  'jpage.code2rich.com',
  'localhost',
  '127.0.0.1'
]);

// 从环境变量读取，方便配置
if (process.env.PLATFORM_DOMAIN) {
  PLATFORM_DOMAINS.add(process.env.PLATFORM_DOMAIN);
}

app.use(async (req, res, next) => {
  const host = req.headers.host?.split(':')[0]?.toLowerCase();
  
  // 跳过平台域名、IP、API/MCP/静态资源路由
  if (!host || PLATFORM_DOMAINS.has(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return next();
  }
  if (req.path.startsWith('/api/') || req.path.startsWith('/mcp') || req.path.startsWith('/vendor/')) {
    return next();
  }
  
  try {
    const domain = await dbGet(
      `SELECT d.*, u.username 
       FROM custom_domains d 
       JOIN users u ON d.user_id = u.id 
       WHERE d.domain = ? AND d.verified = 1`,
      [host]
    );
    
    if (domain) {
      req.tenant = domain;
      req.isCustomDomain = true;
    }
  } catch (e) {
    logger.error({ type: 'virtualhost', message: e.message, host });
  }
  
  next();
});
```

### 5.3 改造 `/s/:key` 路由支持白标

```javascript
// 修改现有的 /s/:key 路由
app.get('/s/:key', async (req, res) => {
  try {
    const file = await dbGet('SELECT * FROM files WHERE share_key = ?', [req.params.key]);
    if (!file) {
      return res.status(404).send(render404(req.tenant));
    }
    
    // 自定义域名下：只能访问该租户自己的文件或公开文件
    if (req.isCustomDomain) {
      const isOwner = file.uploaded_by === req.tenant.user_id;
      const isPublic = file.is_public === 1;
      if (!isOwner && !isPublic) {
        return res.status(403).send(render403(req.tenant, '此页面未公开'));
      }
    } else {
      // 平台域名下：保持原有逻辑
      if (!file.is_public && !currentUserId(req)) return res.redirect('/');
    }
    
    await renderFile(res, file, req.tenant); // 传入 tenant 做白标渲染
  } catch (e) {
    res.status(500).json({ error: '渲染失败' });
  }
});
```

### 5.4 改造 `renderFile` 函数支持白标

当前 `renderFile` 需要修改，在生成 HTML 时根据 `tenant` 替换品牌元素：

```javascript
// 在 renderFile 中，生成 HTML 模板时：
function buildPageHtml(content, file, tenant = null) {
  const brandTitle = tenant?.page_title || '即页';
  const brandLogo = tenant?.logo_url || '/assets/logo.svg';
  const themeColor = tenant?.theme_color || '#2563eb';
  const showPlatformNav = !tenant; // 自定义域名下隐藏平台导航
  
  return `<!DOCTYPE html>
<html>
<head>
  <title>${file.original_name} - ${brandTitle}</title>
  <meta name="theme-color" content="${themeColor}">
  ${tenant ? `<link rel="icon" href="${brandLogo}">` : ''}
  <!-- ... 其余 head ... -->
</head>
<body>
  ${showPlatformNav ? `<nav class="platform-nav">...</nav>` : ''}
  ${tenant ? `<header class="tenant-brand"><img src="${brandLogo}" alt="${brandTitle}"></header>` : ''}
  <main>${content}</main>
</body>
</html>`;
}
```

### 5.5 新增管理 API

```javascript
// GET /api/custom-domains — 列出当前用户的自定义域名
app.get('/api/custom-domains', requireAuth, async (req, res) => {
  try {
    const domains = await dbAll(
      'SELECT id, domain, verified, page_title, logo_url, theme_color, created_at FROM custom_domains WHERE user_id = ?',
      [req.userId]
    );
    res.json(domains);
  } catch (e) {
    res.status(500).json({ error: '查询失败' });
  }
});

// POST /api/custom-domains — 添加自定义域名
app.post('/api/custom-domains', requireAuth, async (req, res) => {
  const { domain, page_title, logo_url, theme_color } = req.body || {};
  if (!domain || !/^[a-z0-9][-a-z0-9]*\.[a-z]{2,}$/i.test(domain)) {
    return res.status(400).json({ error: '域名格式不正确' });
  }
  
  try {
    // 检查是否已被占用
    const existing = await dbGet('SELECT user_id FROM custom_domains WHERE domain = ?', [domain]);
    if (existing && existing.user_id !== req.userId) {
      return res.status(409).json({ error: '该域名已被其他用户绑定' });
    }
    
    const result = await dbRun(
      `INSERT INTO custom_domains (user_id, domain, page_title, logo_url, theme_color) 
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET 
         page_title = excluded.page_title,
         logo_url = excluded.logo_url,
         theme_color = excluded.theme_color`,
      [req.userId, domain, page_title || null, logo_url || null, theme_color || '#2563eb']
    );
    
    res.json({ id: result.lastID, domain, message: '请添加 CNAME 记录指向 cname.jpage.code2rich.com' });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

// DELETE /api/custom-domains/:id
app.delete('/api/custom-domains/:id', requireAuth, async (req, res) => {
  try {
    const domain = await dbGet('SELECT user_id FROM custom_domains WHERE id = ?', [req.params.id]);
    if (!domain) return res.status(404).json({ error: '不存在' });
    if (domain.user_id !== req.userId && req.userRole !== 'admin') {
      return res.status(403).json({ error: '无权操作' });
    }
    await dbRun('DELETE FROM custom_domains WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败' });
  }
});
```

### 5.6 Caddy 配置（替代 Nginx，自动 HTTPS）

如果用 Caddy 作为反向代理（比 Nginx + certbot 简单）：

```caddyfile
# Caddyfile
{
    auto_https off  # 由 Cloudflare 处理 HTTPS，源站只接 HTTP
}

# 平台域名
jpage.code2rich.com {
    reverse_proxy localhost:8858
}

# 通配：捕获所有自定义域名，透传 Host 头部
:80 {
    reverse_proxy localhost:8858 {
        header_up Host {host}
    }
}
```

**更简单的方案：Cloudflare Tunnel（无需公网 IP！）**

如果暂时没有公网服务器，可以用 Cloudflare Tunnel：

```bash
# 在内网服务器上安装 cloudflared
cloudflared tunnel create jpage
cloudflared route dns jpage cname.jpage.code2rich.com
# 配置 tunnel 指向 localhost:8858
```

这样企业 CNAME 到 `cname.jpage.code2rich.com`，流量通过 Cloudflare Tunnel 直达你的内网服务器，**不需要公网 IP、不需要开放端口**。

---

## 六、工作量评估

| 任务 | 预估工时 | 优先级 |
|------|---------|--------|
| 数据库 migration（custom_domains 表） | 0.5h | P0 |
| 虚拟主机中间件 + tenant 注入 | 1h | P0 |
| 改造 `/s/:key` 路由支持白标 | 1h | P0 |
| 改造 `renderFile` 支持品牌替换 | 2h | P0 |
| 管理 API（CRUD 自定义域名） | 1.5h | P0 |
| 前端设置页（域名绑定 UI） | 3h | P1 |
| Cloudflare 配置 / Caddy 部署 | 2h | P0 |
| 域名验证逻辑（检查 CNAME 是否生效） | 2h | P1 |
| **总计（MVP）** | **~10-13h** | |

---

## 七、风险与建议

### 7.1 当前最大瓶颈：部署环境

| 问题 | 现状 | 解决建议 |
|------|------|---------|
| 内网 IP | `36.138.227.105` 是内网 | 确认是否有公网 IP；如无，用 Cloudflare Tunnel |
| 端口 8858 | 非标准端口 | 生产环境应走 80/443，Caddy/Cloudflare 处理 |
| HTTP  only | 无 SSL | Cloudflare CDN 层终止 SSL，源站可保持 HTTP |

### 7.2 域名合规

境内托管自定义域名需要：
- 平台域名备案（`jpage.code2rich.com` 若使用国内 CDN）
- 企业自定义域名**不需要**你备案，由企业自己负责
- 如果用 Cloudflare（海外 CDN），备案要求宽松

### 7.3 与「数字员工成长系统」的协同

这个虚拟主机方案可以自然延伸为「数字员工成长系统」的**培训材料托管层**：
- 每个企业绑定自己的域名
- 上传培训教材（HTML/Markdown）到即页
- 通过自定义域名分享，形成品牌闭环

---

## 八、一句话总结

> **技术上完全可行，Express + SQLite 改造 10 小时可出 MVP。当前最大卡点不是代码，是部署环境（需要公网入口或 Cloudflare Tunnel）。建议先上 Cloudflare + Tunnel 方案，零成本验证，再逐步完善白标功能。**

---

## 九、下一步行动建议

1. **立即**：确认 `36.138.227.105` 是否有公网 IP，或测试 Cloudflare Tunnel 连通性
2. **本周**：实现 `custom_domains` 表 + 虚拟主机中间件 + `/s/:key` 白标渲染
3. **下周**：前端设置页 + 域名绑定 UI
4. **后续**：根据使用反馈，决定是否升级到「完整多租户」（独立文件空间、子路径路由等）
