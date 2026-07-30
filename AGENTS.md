# AGENTS.md

本文件为 AI 编程助手（Codex / Claude Code 等）提供即页（jpage）项目的工作指南。读者应假设对项目一无所知；所有改动请以此文件为上下文基准。

---

## 项目概述

**即页（jpage）** 是一个零配置的 HTML / Markdown 即时预览与分享工具。用户上传 `.html`、`.md`/`.markdown` 或 `.zip` 文件后，即可得到在线渲染页面与短链接（`/s/:key`），无需额外部署流程。项目同时面向 AI 工作流：内置 MCP Streamable HTTP 端点与 CLI 工具，支持通过 API Token 自动上传、管理文件。

核心能力：

- 即时预览 / 源码双模式
- Markdown 增强渲染（代码高亮、KaTeX 公式、Mermaid 图表）
- 文件版本历史与回滚
- 标签、分类、收藏
- 多用户 + admin / user 角色体系
- API Token（`jp_` 前缀）与全局 `MCP_TOKEN` 双认证
- 内容模板市场（用户上架 → 管理员审核 → 公开使用）
- Skills 注册与打包下载

---

## 技术栈

- **运行时**：Node.js ≥ 20
- **后端框架**：Express 4 + express-session（SQLite 会话存储）+ express-rate-limit
- **数据库**：SQLite3（`sqlite3`），启动自动迁移，WAL 模式
- **前端**：原生 ES Modules，无框架；`public/js/` 为源码，`public/dist/` 为 esbuild 生产产物
- **Markdown 渲染**：marked + marked-highlight + highlight.js + KaTeX + Mermaid
- **安全**：helmet（关闭内置 CSP，手写分级策略）、bcryptjs、CSP nonce
- **MCP**：`@modelcontextprotocol/sdk` Streamable HTTP
- **ZIP / 打包**：archiver、jszip、multer
- **邮件**：nodemailer（可选，用于邮箱验证）
- **测试**：Node 内置 `node:test` + supertest
- **Lint**：ESLint flat config（`eslint.config.mjs`）
- **容器**：Docker / Docker Compose，多阶段构建

---

## 目录与模块划分

```
server.js                 # 入口：app 装配、中间件、路由挂载、MCP/静态/catch-all、启动编排
logger.js                 # 结构化 JSON Lines 日志（info/warn/error/audit）
mailer.js                 # SMTP 初始化与邮件发送
mcp-server.js             # MCP 入口，re-export mcp/transport.js
migrations.js             # Migration runner + dbRun/dbGet/dbAll Promise 封装
skills-registry.js        # 扫描 skills/*/SKILL.md，提供列表/详情/ZIP 打包
build.js                  # esbuild 前端构建脚本

lib/                      # 共享层
  db.js                   # SQLite 连接与 PRAGMA 配置
  paths.js                # DATA_DIR / UPLOAD_DIR 常量
  util.js                 # now()、shareKey、clientIp、decodeFilename 等
  csp.js                  # 分级 CSP 策略与 nonce
  auth-state.js           # adminUserId 共享状态
  templates.js            # 样式模板加载 + marked/KaTeX 渲染管线
  render.js               # 文件 → HTML 渲染
  render-cache.js         # 渲染结果 LRU 缓存
  fts.js                  # FTS5 全文索引
  categories.js           # 分类名内存缓存
  view-counts.js          # 浏览数缓冲批量回写
  zip.js                  # ZIP 上传校验/解压/分类
  dispatch.js             # MCP 进程内请求分发器
  crypto.js               # API Token 明文 AES-256-GCM 加密
  usage.js                # 用户存储空间维护（增删改重算）
  middleware/
    auth.js               # requireAuth / loadSession / requireAdmin
    files.js              # loadFileWithPrivacy / checkFileOwnership
    usage.js              # /api 请求用量采集（API 调用计数 + 来源）

routes/                   # 按域拆分的 Express Router
  auth.js                 # /api/auth/*
  users.js                # /api/users/*（admin）
  tokens.js               # /api/tokens/*
  tags.js                 # /api/tags/*
  categories.js           # /api/categories、/api/templates
  admin.js                # /api/admin/*（导出/导入/统计/自动备份）
  skills.js               # /api/skills/*、/api/mcp/config
  content-templates.js    # /api/content-templates/* 与 /api/content-templates/market/*
  files/                  # /api/files/* 子路由
    index.js              # 路由装配
    crud.js               # 单文件元数据 / 更新 / 删除 / 批量
    list.js               # 列表与搜索
    upload.js             # multipart / JSON / ZIP-base64 上传
    overwrite.js          # 覆盖上传（multipart / JSON）
    versions.js           # 版本历史
    share.js              # 短链设置（别名/过期/密码）
    detail-serve.js       # content / render / download / asset
    associations.js       # tags / star / category
    _shared.js            # multer、限流、版本备份、下载头等共享常量

mcp/                      # MCP 实现
  transport.js            # /mcp 路由挂载、session 生命周期
  server.js               # McpServer 工厂，注册 17 tools + 2 resources
  tools-files.js          # 文件相关 tool
  tools-versions.js       # 版本相关 tool
  tools-tags.js           # 标签 tool
  tools-categories.js     # 分类 tool
  tools-content-templates.js # 内容模板 tool
  resources.js            # jpage://files / jpage://file/{id}
  util.js / constants.js  # 共享

bin/                      # CLI 工具（npm 包入口 `jpage`）
  jpage.js                # CLI 入口与命令分发
  args.js / config.js / client.js
  commands/               # upload、ls、cat、url、mv、rm、star、tags、skills、whoami、update

public/                   # 前端静态资源
  index.html              # SPA 模板，含 landing / home / preview / market 等模板块
  css/style.css           # 源样式（开发模式直接加载）
  js/                     # 前端 ESM 源码
    app.js                # hash 路由 + 动态 import 入口
    api.js / theme.js / utils.js
    pages/                # landing、login、home、preview、market、share-settings
    components/           # dialog、toast、users-modal、tokens-modal
  dist/                   # esbuild 产物（gitignore）

templates/                # Markdown 渲染样式模板（default/github/academic/dark-pro）
skills/                   # Claude Code / Desktop Skill 包
migrations/               # 001-021 按序执行的 schema 迁移
test/                     # 单元 + 集成测试 + e2e/性能 harness
data/                     # SQLite DB、session、上传文件（gitignore，运行期自动创建）
```

---

## 构建与运行命令

**推荐部署（Docker Compose）**：

```bash
cp .env.example .env          # 编辑 ADMIN_PASSWORD、SESSION_SECRET 等
docker-compose up -d
docker-compose logs -f
docker-compose down
```

**本地开发**：

```bash
npm install
npm run dev                   # nodemon 热重载；开发无需构建
npm start                     # 直接运行
npm run build                 # esbuild 生产打包 → public/dist/
npm run build:dev             # 不 minify、不哈希，便于调试
```

**质量与测试**：

```bash
npm run lint                  # ESLint 检查
npm run lint:fix              # 自动修复
npm test                      # node:test 单元 + 集成测试
npm run test:unit             # 仅单元测试
npm run test:integration      # 仅集成测试
```

**手动验证**：

- 浏览器访问 http://localhost:8858
- API 调试：直接 curl / supertest
- MCP 调试：`npx @modelcontextprotocol/inspector http://localhost:8858/mcp`
- 性能/e2e harness（需先启动服务）：
  ```bash
  node test/perf-harness.js 8858
  node test/mcp-harness.js 8858
  node test/perf-bench.js 8858
  ```

---

## 测试说明

测试使用 Node.js 内置 `node:test` runner + `supertest`。

- `test/unit/*.test.js`：纯函数与独立模块（util、render-cache、zip、fts、crypto、cli-args、cli-config）。
- `test/integration/*.test.js`：完整 Express app 集成测试（auth、users、tokens、files、versions、tags、categories、skills、admin、share、content-templates、cli）。
- `test/helpers/setup.js`：每个测试文件使用独立数据目录 `data-test-<pid>-<n>`，require server 前设置 `JPAGE_DATA_DIR`，避免并发污染。
- 手动 harness：`test/perf-harness.js`、`test/mcp-harness.js`、`test/perf-bench.js`、`test/browser-harness.js`、`test/dispatch-bench.js`、`test/run-server.sh`。

CI（`.github/workflows/ci.yml`）在 Node 20/22 矩阵上执行 `npm run lint`、`npm test`、`npm run build`。

---

## 代码风格与开发约定

- **模块系统**：后端纯 CommonJS（`require`/`module.exports`）；前端浏览器 ESM（`import`/`export`）。
- **Lint**：`eslint.config.mjs` flat config，启用 `@eslint/js/recommended`。
  - Error：`no-undef`、`no-redeclare`、`prefer-const`、`no-var`、`no-debugger`。
  - Warn：`no-unused-vars`（忽略 `_` 前缀与常见 catch 参数 `e/err/error/_`）。
  - Off：`no-console`、`no-inner-declarations`、`no-prototype-builtins` 等。
- **变量**：统一使用 `const`/`let`，禁止 `var`。
- **日志**：禁止使用 `console.log/error/warn`；统一 `const logger = require('./logger')`。关键写操作（增删改、登录、上传、覆盖、恢复、删除等）必须调用 `logger.audit(action, { fileId, ip: clientIp(req), ... })`。
- **时间**：统一存 UTC 字符串，`lib/util.js` 的 `now()` 返回 `YYYY-MM-DD HH:MM:SS`；展示层负责转本地时区。
- **数据库**：使用 `dbRun`/`dbGet`/`dbAll` Promise 封装；避免直接裸 `db.run`/`db.get`。
- **文件名解码**：multer 的 `originalname` 以 latin1 存储，必须使用 `decodeFilename()` 还原 UTF-8。
- **版本号**：`package.json` 的 `version` 是单一事实来源。发版时 `public/index.html` 里的 `style.css?v=`、`app.js?v=` 以及 `public/js/app.js` 中动态 import 的版本后缀应与之对齐。目前源码里存在带功能后缀的 cache-busting 串（如 `1.5.2-market-ui2`、`1.5.3-cardthumb`），发版时应统一。
- **CLI / MCP 能力对称**：`bin/commands/*` 与 `mcp/tools-*.js` 是对等的两个客户端入口，都基于同一套 REST API。新增功能时应同步考虑两端。
- **MCP 进程内分发**：MCP tool 必须走 `lib/dispatch.js` 的 `createDispatcher(app, {token})` 调用 `app.handle()`，不再使用 `fetch('http://127.0.0.1:...')` 自调用。
- **环境变量同步**：任何在 `server.js`/`routes/*.js`/`lib/*.js` 中读取的 `process.env` 变量，若用于容器部署，必须同步出现在 `.env.example`（或 `.env`）和 `docker-compose.yml` 的 `environment` 中。

---

## 架构详解

### 后端

`server.js` 负责装配，业务逻辑在 `routes/` 与 `lib/`：

1. 创建 SQLite db 实例并通过 `lib/db.setDb()` 注入。
2. helmet（关闭 CSP）、手写 CSP 中间件、全局 JSON/urlencoded（1MB）、CORS、session。
3. morgan JSON 请求日志（跳过静态资源）。
4. 挂载 `/api/*` 路由、`/s/:key` 短链、`/t/:key` 模板短链、`/mcp`、静态资源、SPA catch-all。
5. `app.listen` 回调中依次执行：
   - `configureDatabase()`（WAL、busy_timeout 等 PRAGMA）
   - `runMigrations(db)`
   - `initMailer()`
   - `loadTemplates()` / `loadTemplateNameMap()`
   - `reloadCategoryNameCache()`
   - `backfillFtsIndex()`
   - `bootstrapAdmin()`（users 表为空时创建 admin）
   - `scheduleViewCountFlush()`
   - 可选 `BACKUP_CRON` 自动备份（保留最近 7 份）

### 前端

`public/index.html` 包含多个 `<template>` 块；`public/js/app.js` 监听 hash 变化，按需 `import()` 加载 `pages/*.js`（landing/login/home/preview/market）。开发模式直接加载 `public/js` 与 `public/css` 源文件；生产构建后 `server.js` 的 `getIndexHtml()` 读取 `public/dist/manifest.json`，将 `index.html` 中的 `/css/style.css?v=` 与 `/js/app.js?v=` 替换为带哈希的 dist 路径，无 dist 时自动回退源路径。

### 数据与存储

运行时自动创建：

- `data/database.sqlite` — 业务数据与 `_migrations`
- `data/sessions.sqlite` — express-session store
- `data/uploads/` — 上传文件；命名规则 `Date.now() + '-' + Math.round(Math.random()*1e9) + ext`
- `data/token-key.key` — API Token 加密密钥（未设置 `TOKEN_ENCRYPTION_KEY` 时自动生成）
- `data/backups/` — 自动备份目录（`BACKUP_CRON` 启用时）

数据目录可通过 `JPAGE_DATA_DIR` 覆盖，默认 `./data`。

### 数据库 Schema

- `_migrations(id, name UNIQUE, applied_at)`
- `files(id, original_name, stored_name, file_type, size, created_at, updated_at, is_public, uploaded_by, share_key, category_id, is_bundle, entry_path, view_count, template_id, share_expires_at, share_password_hash, upload_source, source_asset_id, created_from)`
- `file_versions(id, file_id, version, stored_name, size, created_at, uploaded_by, upload_source, performed_by, is_bundle, entry_path, file_type)`
- `users(id, username UNIQUE, email, email_verified, password_hash, role, created_at, total_storage_bytes, api_calls_count, storage_quota_bytes)`（email 有 `WHERE email IS NOT NULL` 唯一索引）
- `api_calls(id, user_id, source, action, method, path, status, created_at)`
- `tokens(id, user_id, name, token_hash UNIQUE, token_prefix, token_enc, last_used_at, created_at)`
- `tags(id, name UNIQUE, created_at)`
- `file_tags(file_id, tag_id)`
- `starred_files(user_id, file_id, created_at)`
- `categories(id, name, user_id, created_at, UNIQUE(name, user_id))`
- `email_verifications(id, user_id, token_hash UNIQUE, token_prefix, type, new_email, expires_at, created_at)`
- `link_visits(id, file_id, share_key, ip_hash, user_agent, visited_at)`
- `templates(id, name UNIQUE, description, file_path, is_builtin, created_at)`
- `content_templates(id, title, description, file_type, scene, style_tags, content, uploaded_by, use_count, is_public, created_at, updated_at, category_id, status, visibility, review_note, reviewed_by, reviewed_at, submitted_at, published_at, featured, sort_order, source_file_id, version, share_key)`
- `template_market_categories(id, slug UNIQUE, name, description, sort_order, is_enabled, created_at, updated_at)`
- `content_template_installs(id, template_id, user_id, file_id, source_version, created_at, UNIQUE(template_id, user_id))`
- `starred_templates(user_id, template_id, created_at)`
- `feedback(id, name, contact, content, category, user_id, ip, email_sent, status, created_at)`
- `file_contents_fts` — FTS5 虚拟表 `(content, file_id UNINDEXED, tokenize='porter unicode61')`

### REST API

端口默认 `8858`（`PORT` 覆盖）。写入端点需登录或 Bearer token。完整参考见 `docs/api.md`。主要分组：

- **鉴权**：`/api/auth/me`、`/api/auth/login`、`/api/auth/register`、`/api/auth/logout`、`/api/auth/change-password`、`/api/auth/profile`、`/api/auth/verify-email`、`/api/auth/resend-verification`、`/api/auth/send-register-code`、`/api/auth/smtp-status`、`/api/auth/registration-status`、`/api/auth/github/*`、`/api/auth/wechat/*`
- **用户管理（admin）**：`/api/users`
- **个人用量**：`/api/users/me/usage`
- **API Token**：`/api/tokens`、`/api/tokens/:id/reveal`
- **文件管理**：`/api/files`、`/api/files/search`、`/api/files/upload`、`/api/files/upload-json`、`/api/files/upload-zip-base64`、`/api/files/batch`、`/api/files/:id`、`/api/files/:id/content`、`/api/files/:id/render`、`/api/files/:id/download`、`/api/files/:id/asset/*`、`/api/files/:id/overwrite`、`/api/files/:id/overwrite-json`、`/api/files/:id/overwrite-zip-base64`、`/api/files/:id/stats`
- **版本历史**：`/api/files/:id/versions`、versions content/render/download/restore/delete（bundle 历史按目录保存）
- **分享设置**：`/api/files/:id/share`（PUT 别名/过期/密码）、`/api/files/:id/share/regenerate`
- **标签**：`/api/tags`、`/api/files/:id/tags`
- **收藏**：`/api/files/:id/star`
- **分类**：`/api/categories`、`/api/files/:id/category`
- **样式模板**：`/api/templates`
- **内容模板市场**：`/api/content-templates/market/*`、`/api/content-templates/mine`、`/api/content-templates`、`/api/content-templates/:id/use`、`/api/content-templates/:id/review`（admin）、`/api/content-templates/admin/*`（admin）
- **管理后台（admin）**：`/api/admin/export`、`/api/admin/import`、`/api/admin/stats`
- **Skills**：`/api/skills`、`/api/skills/:name`、`/api/skills/:name/download`
- **短链**：`/s/:key`（文件）、`/t/:key`（市场模板）
- **MCP 配置**：`/api/mcp/config`
- **问题反馈（公开）**：`POST /api/feedback`
- **CLI 指南**：`/api/cli/guide`

### MCP 端点

- 路径：`POST`/`GET`/`DELETE /mcp`
- 鉴权：`Authorization: Bearer <MCP_TOKEN>` 或任意用户级 API Token（`jp_` 前缀）。未配置任何 token 时 `/mcp` 禁用。
- 实现：`mcp/transport.js` 管理 Streamable HTTP session；`mcp/server.js` 注册 **17 个 tools + 2 个 resources**。
- Tools 类别：
  - 文件：`list_files`、`upload_file`、`get_file_content`、`delete_file`、`rename_file`、`get_file_url`、`star_file`、`unstar_file`
  - 版本：`list_file_versions`、`restore_file_version`
  - 标签：`list_tags`、`add_tags_to_file`
  - 分类：`list_categories`、`create_category`、`set_file_category`
  - 内容模板：`list_content_templates`、`get_content_template`
- Resources：`jpage://files`、`jpage://file/{id}`（内容 ≤ 256KB）
- 内部：tool 通过 `lib/dispatch.js` 进程内调用 REST API，复用同一 Bearer token，权限/限流/审计与 HTTP 完全一致。

### CLI

`bin/jpage.js` 提供 `jpage` 命令，token 优先级：`--token` > `JPAGE_TOKEN` 环境变量 > `MCP_TOKEN` 环境变量 > `.env`。

命令：`upload`、`ls`、`cat`、`url`、`mv`、`rm`、`star`、`unstar`、`tags`、`skills`、`whoami`、`update`。

CLI 与 MCP 共用同一套 REST API，是对等的两个客户端入口。

---

## 安全与权限

- **鉴权三选一**：(1) session cookie `jpage.sid`；(2) 用户级 API Token `jp_...`；(3) 全局 `MCP_TOKEN`（向后兼容）。`requireAuth` 设置 `req.userId` 与 `req.userRole`。
- **角色**：`users.role` 为 `admin` 或 `user`。admin 可访问所有文件与用户；普通用户只能操作自己的文件和公开文件。
- **文件访问**：`loadFileWithPrivacy` 按 admin / 所有者 / 公开 / 未登录 分层校验；`checkFileOwnership` 用于写操作。
- **密码**：bcrypt 哈希（cost 10）。
- **API Token**：`jp_` + 32 位 base62；数据库存 SHA-256 哈希用于鉴权，可选 AES-256-GCM 密文（`token_enc`）用于界面查看/复制。每用户最多 10 个。
- **限流**：
  - 登录 `30 req / 15 min / IP`
  - 注册 `5 req / 15 min / IP`
  - 上传/覆盖 `50 req / 15 min / IP`
  - 短链密码提交 `20 req / 15 min / IP`
- **CSP**：管理界面严格 CSP；Markdown 渲染页使用 nonce 放行内联 mermaid 脚本；HTML 渲染页使用宽松 CSP，依赖 iframe sandbox 兜底。渲染端点通过 `X-Frame-Options: SAMEORIGIN` 与 `frame-ancestors 'self'` 仅允许同源嵌入。
- **HTML 不清理**：渲染端点故意不清理用户 HTML，因在 iframe sandbox 中运行；修改此策略需谨慎。
- **Bundle 安全**：`/api/files/:id/asset/*` 与 bundle 目录枚举均做路径穿越校验。
- **Token 加密密钥**：优先读取 `TOKEN_ENCRYPTION_KEY`，未设置时持久化生成 `data/token-key.key`。
- **Session**：`httpOnly`、`sameSite=lax`；`COOKIE_SECURE=true` 时仅 HTTPS 传输（生产推荐）。
- **Secrets**：不要把 `.env`、`.npmrc`、token 明文提交到仓库；`.gitignore` 已排除 `data/` 与 `node_modules/`。

---

## 日志

结构化 JSON Lines 日志输出到 stdout/stderr：

- `logger.info(obj)` / `logger.warn(obj)` / `logger.error(obj)` / `logger.audit(action, details)`
- `level=error` 输出到 stderr，其余到 stdout。
- morgan 自动记录 `type: http`（跳过静态资源），挂载在 session 之后以获取 userId。
- 审计日志 `type: audit` 用于关键写操作，详情应包含目标标识与 `ip: clientIp(req)`。
- 错误日志只记录 `error: e.message`，不传递原始 Error 对象。

---

## 数据库迁移

- `migrations.js` 的 `runMigrations(db)` 在启动时执行。
- `_migrations(name UNIQUE)` 记录已应用的 migration。
- `migrations/` 下文件按文件名排序执行；每个文件导出 `{ name, async up(db, { dbRun, dbGet, dbAll }) }`。
- **新增 migration 规则**：
  1. 命名格式 `{序号}_{描述}.js`，序号接续当前最大值（当前已到 027）。
  2. 新建表用 `CREATE TABLE IF NOT EXISTS`。
  3. 新增列必须幂等：先 `PRAGMA table_info` 检查是否存在，再 `ALTER TABLE ADD COLUMN`。
  4. SQLite `ALTER TABLE ADD COLUMN` 不支持非恒定默认值；需要默认值时先加列（无默认或恒定默认），再 `UPDATE` 回填。
  5. 同步更新本文件的 Database Schema 描述。

---

## 常见陷阱

- **catch-all 路由顺序**：`app.get('*')` 必须在所有 API 路由、`/s/:key`、`/t/:key`、`/mcp`、静态资源挂载之后，否则会遮蔽它们。
- **静态资源 `index: false`**：`express.static('public', { index: false })`，由 `getIndexHtml()` 统一返回 index.html 并注入 dist 哈希路径。
- **数据库单连接复用**：所有模块通过 `lib/db` 获取同一 `db` 实例。
- **大 body 端点**：全局 `express.json` 限制 1MB；`upload-json`、`upload-zip-base64`、`overwrite-json` 等使用 `largeJson`（50MB）。
- **渲染缓存失效**：缓存 key 包含 `stored_name` 与 `updated_at`；覆盖上传/恢复版本会自然失效。
- **view_count 缓冲**：短链访问计数先写入内存缓冲，每 30s 或进程退出时 `flushViewCounts()` 批量回写；`/api/files/:id/stats` 返回时合并缓冲值。
- **分类名缓存**：`lib/categories.js` 维护内存缓存，分类增删改/import 后需 `reloadCategoryNameCache()`。
- **来源标记**：CLI/MCP 上传时后端通过 `X-Upload-Source` 头（`cli`/`mcp`）写入 `files.upload_source`，认证 token 本身无法区分来源。
- **MARKDOWN 渲染同步**：调用 `marked.parse(..., { async: false })`，避免未来版本返回 Promise。
- **模板函数**：`templateCache[name]` 是编译后的函数，使用 `applyTemplate(tplFn, ...)` 调用，不是字符串。

---

## 发版与部署

- 版本号以 `package.json` 为准。
- 推荐发版：`npm version patch|minor|major` → `git push origin main` → `git push origin vX.Y.Z`，由 `.github/workflows/release.yml` 自动执行 lint、test、build、校验 tag、发布到 npm。
- Docker：`Dockerfile` 多阶段构建（builder / frontend / runner），`EXPOSE 8858`；`docker-compose.yml` 映射 host 8858 → container 8858，挂载 `./data:/app/data`。
- 环境变量完整清单（按需配置）：`PORT`、`NODE_ENV`、`JPAGE_DATA_DIR`、`ADMIN_USER`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`COOKIE_SECURE`、`MCP_TOKEN`、`MCP_IP`、`MCP_PROTOCOL`、`TOKEN_ENCRYPTION_KEY`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASS`、`SMTP_FROM`、`APP_URL`、`FEEDBACK_EMAIL`、`ALLOW_REGISTRATION`、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`WECHAT_OPEN_APP_ID`、`WECHAT_OPEN_APP_SECRET`、`MAX_FILE_VERSIONS`、`BACKUP_CRON`、`BACKUP_DIR`、`ICP_BEIAN`。

---

## 相关文档

- `README.md` — 项目简介、快速开始、完整 REST API 表格
- `docs/api.md` — REST API 详细参考
- `docs/RELEASING.md` — npm 发版与 CI 配置指南
- `docs/design/` — 历史设计文档
- `.env.example` — 环境变量模板
- `.mcp.json` — MCP 客户端配置示例
