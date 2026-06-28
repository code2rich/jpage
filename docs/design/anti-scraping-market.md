# 内容模板市场反爬方案

## 目标

创作市场（内容模板市场）的模板内容本身需要被潜在用户浏览，但又要防止被批量爬虫低价复制。本方案在「不阻断正常匿名浏览」和「提高批量抓取成本」之间取平衡。

## 当前威胁

- 直接调 `/api/content-templates/market` 分页拉取全部模板元数据。
- 调 `/api/content-templates/market/:id/preview-html` 批量抓取渲染后的 HTML 内容。
- 用 `python-requests`、`curl`、`Scrapy` 等工具无头抓取。

## 防御层

### 1. 请求层限流（已落地）

| 端点类型 | 限流器 | 默认阈值 | 说明 |
|---|---|---|---|
| 列表/分类 | `marketListerLimiter` | 15 分钟 300 请求 / IP | `/market`、`/categories`、`/use-guide` |
| 预览/详情 | `marketPreviewLimiter` | 15 分钟 600 请求 / IP | `/market/:id`、`*preview*` |

- 已登录用户（session 或 API Token）阈值翻倍，避免误伤正常用户。
- 测试环境（`NODE_ENV=test`）自动跳过限流，避免集成测试被限流误伤。
- 环境变量可调：`MARKET_LIST_LIMIT_WINDOW_MS`、`MARKET_LIST_LIMIT_MAX`、`MARKET_PREVIEW_LIMIT_WINDOW_MS`、`MARKET_PREVIEW_LIMIT_MAX`。

### 2. Bot 特征过滤（已落地）

`marketBotFilter` 对匿名请求做 User-Agent 检查：

- 空 UA 直接拦截。
- 命中黑名单模式直接拦截：
  - `Scrapy`、`python-requests`、`httpx`、`curl`、`wget`、`go-http-client`
  - `PostmanRuntime`、`Insomnia`
  - `HeadlessChrome`、`PhantomJS`、`Selenium`、`Puppeteer`、`Playwright`
- 已登录用户绕过该检测。

### 3. 反索引（已落地）

- 所有市场 API 响应带 `X-Robots-Tag: noindex, nofollow`。
- `/robots.txt` 禁止爬虫进入 `/api/` 和 `/mcp`。

### 4. 业务层限制（已有）

- 市场仅展示 `approved + visible + 分类启用` 的模板。
- 下载原文件（`/download`）、收藏、生成公开短链等写操作仍需登录。
- 「使用模板」实例化必须通过 Token（CLI/MCP），Web 端只展示引导。

## 未纳入的更强措施（按需求再开）

| 措施 | 效果 | 代价 | 建议 |
|---|---|---|---|
| 图形验证码 / Cloudflare Turnstile | 强抗机器抓取 | 影响用户体验，增加依赖 | 仅在遭受明显攻击时启用 |
| 动态分页 token（继续令牌） | 阻止无状态爬虫翻页 | 前端实现复杂 | 当前限流足够 |
| 内容水印 / 指纹 | 追踪泄露源 | 对 HTML/MD 效果有限 | 暂缓 |
| 按模板 ID 访问频率单独限流 | 防止单模板被刷 | 需 Redis 共享状态 | 多实例部署后考虑 |
| IP 信誉 / WAF | 拦截已知恶意 IP | 需外部服务或规则维护 | 生产可前置 Nginx/Cloudflare WAF |

## 部署建议

1. 生产环境前置 Nginx/Cloudflare，设置更严格的全局速率限制和 Bot Management。
2. 监控 `type: market.bot_block` 和 `type: market.rate_limit` 日志，发现异常 IP 及时封禁。
3. 如业务扩展至多实例，将 `express-rate-limit` 替换为 Redis store，保证跨进程限流一致。
