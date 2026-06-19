# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: 即页 (jpage)

零配置 HTML / Markdown 即时预览与分享工具。Express 服务（`server.js`）+ MCP server 模块（`mcp-server.js`）+ Skills 注册模块（`skills-registry.js`）。SQLite 存元数据与用户表，磁盘 `data/uploads/` 存原始文件，session 存 `data/sessions.sqlite`。多用户 + 角色体系（admin / 普通用户），bcrypt 密码哈希，可选开放注册（邮箱验证）。支持 Markdown 增强渲染（代码高亮、KaTeX 公式、Mermaid 图表）。

## Commands

**推荐使用 Docker Compose 部署**（本地和生产均适用）：

1. 复制 `.env.example` 或自行创建 `.env`，填入 `SESSION_SECRET`、`ADMIN_PASSWORD`、`MCP_TOKEN` 等
2. `docker-compose up -d` — 构建镜像并启动容器，`./data` 目录 bind-mount 持久化数据库和上传文件
3. `docker-compose logs -f` — 查看启动日志（首次会打印自动生成的管理员密码，如未在 `.env` 指定）
4. `docker-compose down` — 停止容器

**本地开发**（不用 Docker）：

- `npm install` — 安装依赖
- `npm run dev` — nodemon 热重载开发模式（**开发无需构建**：直接加载 `public/js`、`public/css` 源文件）
- `npm start` — 直接运行（需自行配置 `.env` 或环境变量）
- `npm run build` — 生产构建：esbuild 打包 + 代码分割 + minify，产出 `public/dist/`（带哈希文件名 + manifest.json）。构建后 server 自动改用 dist 产物（落地页首屏 ~64KB/gzip ~21KB，比源文件全量 ~152KB 降 58%）
- `npm run build:dev` — 不 minify、不哈希的构建（调试用）

**前端构建（可选，生产用）**：`public/js` 与 `public/css` 是源文件，开发模式直接被浏览器加载。`npm run build` 用 esbuild 把 `public/js/app.js` 打包到 `public/dist/`，路由级代码分割（landing/login/home/preview 各为独立懒加载 chunk），CSS minify。server 的 SPA 兜底读 `public/dist/manifest.json` 把 `index.html` 里的 `/css/style.css?v=` 与 `/js/app.js?v=` 替换为 `/dist/<hash>.css|.js`；**无 dist 时自动回退源文件路径**，故不构建也能跑。`public/dist/` 是构建产物，已 gitignore；Docker 构建时在 `frontend` 阶段执行 `npm run build` 并 COPY 进运行镜像。

环境变量说明见 `.env` 文件注释。`MCP_TOKEN` 或用户级 API Token 任一即可挂载 `/mcp` 端点。

**自动化测试**：`npm test` 跑单元 + 集成测试（node:test + supertest，覆盖 `lib/` 纯函数与 `routes/` 鉴权/上传/渲染流程，70+ 用例）。`npm run test:unit` 仅单元测试。GitHub Actions CI（`.github/workflows/ci.yml`）在 Node 20/22 矩阵上跑 `npm test` + `npm run build`。

**手动验证**：用浏览器打开 http://localhost:8858 加载 UI、直接打 API，或 `npx @modelcontextprotocol/inspector http://localhost:8858/mcp` 调试 MCP。`test/` 目录下还有 e2e / 性能 harness（`perf-harness.js`、`mcp-harness.js`、`browser-harness.js`、`dispatch-bench.js`）和 `run-server.sh`，需先起服务后手动跑。

## Architecture

**模块化后端架构**（`server.js` 已从 3174 行精简为 ~360 行，业务逻辑全部拆入 `lib/` 与 `routes/`）:
- `server.js` (~360 lines) — 仅 app 装配、中间件（helmet/CSP/session/morgan）、路由挂载、MCP/静态/catch-all、全局错误处理、启动编排（迁移/模板加载/管理员引导/定时备份）、SIGINT/SIGTERM 钩子。
- `logger.js` (~16 lines) — 结构化 JSON Lines 日志工具，导出 `info`/`warn`/`error`/`audit` 方法，error 输出到 stderr，其余到 stdout。
- `mcp-server.js` (re-export 入口，~30 行) — MCP Streamable HTTP server 的外部入口，re-export `mcp/transport.js`。Exports `mountMcpServer(app, {port, mcpToken, mcpIp, protocol, authenticateRequest})` and `closeMcpTransports()`. 17 tools + 2 resources; tools call the REST API **in-process via `lib/dispatch.js`** (no TCP loopback fetch), carrying the same Bearer token. 实际实现已按职责拆分到 `mcp/` 目录：`transport.js`（会话生命周期 + `/mcp` 路由 + 关闭钩子）、`server.js`（createMcpServer 工厂）、`tools-files.js`/`tools-versions.js`/`tools-tags.js`/`tools-categories.js`/`tools-content-templates.js`、`resources.js`、`util.js`、`constants.js`。
- `lib/dispatch.js` — 进程内请求分发器 `createDispatcher(app, {token})`，返回 `{get,post,put,del}`。合成 IncomingMessage/ServerResponse 走 `app.handle()`，绕过 TCP 序列化与二次鉴权 DB 查询（单次调用快 ~80%）。**仅 `mcp/transport.js` 引用此模块**（原 `mcp-server.js` 的逻辑已迁移）。
- `migrations.js` (~65 lines) — Migration runner，启动时自动执行 `migrations/` 目录下未应用的 migration，记录到 `_migrations` 表。同时导出 `dbRun`/`dbGet`/`dbAll` Promise 封装供 `server.js` 使用。
- `mailer.js` (~34 lines) — SMTP 邮件发送模块（nodemailer），导出 `initMailer`/`sendMail`/`getAppUrl`/`isMailerConfigured`。
- `lib/crypto.js` — Token 明文可逆加密（AES-256-GCM）。导出 `encryptToken(plain)`/`decryptToken(enc)`/`reloadKey()`。密钥来自 `TOKEN_ENCRYPTION_KEY` 环境变量，未设置时自动生成持久化文件 `data/token-key.key`。仅 `routes/tokens.js` 引用（鉴权链路不依赖此模块）。
- `skills-registry.js` (~135 lines) — 自动扫描 `skills/*/SKILL.md`，解析 YAML frontmatter，提供 skill 列表/详情/ZIP 打包下载。

> ✅ **模块化已完成**：`server.js` 已 require 全部 `lib/`（`db.js`/`paths.js`/`util.js`/`csp.js`/`auth-state.js`/`templates.js`/`render.js`/`render-cache.js`/`fts.js`/`categories.js`/`view-counts.js`/`zip.js`/`dispatch.js`/`crypto.js` 及 `lib/middleware/auth.js`、`lib/middleware/files.js`）与 `routes/`（`auth.js`/`users.js`/`tokens.js`/`files.js`/`tags.js`/`categories.js`/`content-templates.js`/`admin.js`/`skills.js`）。**改 bug 或加端点时，改对应 `routes/*.js` 与 `lib/*.js`，`server.js` 只管装配**。

**Storage**（均自动创建）：
- `data/database.sqlite` — 业务表（files、users 等）+ `_migrations` 版本追踪表
- `data/sessions.sqlite` — express-session store (connect-sqlite3)
- `data/uploads/` — 上传文件内容，命名 `<timestamp>-<random><ext>`

**Database schema**:
- `_migrations(id, name UNIQUE, applied_at)` — 记录已执行的 migration
- `files(id, original_name, stored_name, file_type, size, created_at, is_public, uploaded_by, share_key, updated_at, category_id, is_bundle, entry_path, view_count, template_id)` — `is_public=1` means anonymous can read; `uploaded_by` references `users.id`; `share_key` is 8-char URL-safe random string for short links; `is_bundle=1` 为解压后的网站包；`view_count` 由短链访问批量回写；`template_id` 绑定样式模板
- `users(id, username UNIQUE, email UNIQUE, email_verified, password_hash, role, created_at)` — `email` 可为 NULL；`email_verified` 0/1
- `file_versions(id, file_id, version, stored_name, size, created_at, uploaded_by)` — 文件版本历史
- `tokens(id, user_id, name, token_hash, token_prefix, token_enc, last_used_at, created_at)` — API token。`token_hash` 为 SHA-256（鉴权用，不可逆）；`token_enc` 为 AES-256-GCM 密文（可选，使明文可在界面后续查看/复制，旧令牌为 NULL）
- `tags(id, name UNIQUE, created_at)` — 标签词典
- `file_tags(file_id, tag_id)` — 文件-标签多对多
- `starred_files(user_id, file_id, created_at)` — 收藏
- `categories(id, name, user_id, created_at)` — 分类
- `email_verifications(id, user_id, token_hash, token_prefix, type, new_email, expires_at, created_at)` — 邮箱验证 token（含 `type='register_code'` 注册验证码）
- `link_visits(id, file_id, share_key, ip_hash, user_agent, visited_at)` — 短链访问明细（去重统计）
- `templates(id, name UNIQUE, description, file_path, is_builtin, created_at)` — 样式模板（内置 default/github/academic/dark-pro）
- `content_templates(id, title, description, file_type, scene, style_tags, content, uploaded_by, use_count, is_public, created_at, updated_at)` — 内容模板（公开库 + 用户自建）
- `file_contents_fts` — FTS5 虚拟表（`content`, `file_id UNINDEXED`），全文搜索索引

**REST API**:
- `GET /api/auth/me` — 当前用户（返回 `{id, username, email, emailVerified, role}`）
- `POST /api/auth/login` — `{account, password}` 或 `{username, password}`（统一入口，自动识别用户名或邮箱），设置 `jpage.sid` cookie，限流 10/15min
- `POST /api/auth/register` — `{email?, username?, password, confirmPassword}`（至少提供 email 或 username，邮箱注册自动生成用户名）
- `POST /api/auth/logout` — 销毁 session
- `POST /api/auth/change-password` — `{currentPassword, newPassword}`，所有用户可用
- `POST /api/auth/profile` — `{username?, email?}` 编辑个人资料（需登录）
- `GET /api/auth/verify-email?token=...` — 验证邮箱 token，重定向前端页面
- `POST /api/auth/resend-verification` — 重发验证邮件（需登录），限流 5/h
- `POST /api/auth/send-register-code` — `{email}` 发送 6 位注册验证码（需 `ALLOW_REGISTRATION=true`，10 分钟有效）
- `GET /api/auth/smtp-status` — 返回 `{configured: bool}` SMTP 是否配置
- `GET /api/auth/registration-status` — 返回 `{enabled: bool}` 注册是否开放
- `GET /api/users` — 列出用户含 email（仅 admin）
- `POST /api/users` — 创建用户 `{username, password, role, email?}`（仅 admin）
- `PUT /api/users/:id` — 更新用户名、邮箱、角色或重置密码（仅 admin）
- `DELETE /api/users/:id` — 删除用户，文件转交 admin（仅 admin，不可删自己）
- `GET /api/tokens` — 列出自己的 API Token（含 `viewable` 标记，表示是否有可查看的加密明文）
- `POST /api/tokens` — 创建 Token `{name}`，返回明文（同时存 AES-256-GCM 密文供后续查看）
- `POST /api/tokens/:id/reveal` — 查看指定 Token 的明文（旧令牌无密文则 409）
- `DELETE /api/tokens/:id` — 删除 Token（自己的或 admin 删任意）
- `GET /api/files` — 列出文件（admin 看全部，普通用户看自己的+公开的）
- `GET /api/files/search` — FTS5 + 文件名 LIKE 合并搜索（带 snippet、分页、过滤）
- `POST /api/files/upload` — multipart 上传（需登录，50/15min，50MB，支持 .html/.htm/.md/.markdown/.zip）
- `POST /api/files/upload-json` — JSON `{name, content, isPublic?}`（需登录，同名自动覆盖）
- `POST /api/files/upload-zip-base64` — MCP 使用的 ZIP base64 上传入口（largeJson）
- `POST /api/files/batch` — 批量操作 `{action, ids, data?}`（delete/setPublic/setPrivate/setCategory，≤200）
- `GET /api/files/:id` — 单文件元数据（`loadFileWithPrivacy` 校验所有权/公开性）
- `PUT /api/files/:id` — `{name?, isPublic?, templateId?}`（admin 或文件所有者）
- `DELETE /api/files/:id` — 删除数据库记录和磁盘文件（admin 或文件所有者）
- `GET /api/files/:id/content` — 返回原始文件文本 JSON（公开文件无需登录）
- `GET /api/files/:id/render` — 返回渲染 HTML（Markdown 使用 marked + highlight.js + KaTeX + Mermaid；Bundle 注入 `<base>` 标签）
- `GET /api/files/:id/download` — 流式下载文件（Bundle 以 ZIP 形式下载）
- `GET /api/files/:id/asset/*` — Bundle 资源文件访问（路径穿越校验）
- `POST /api/files/:id/overwrite` — multipart 覆盖上传（预览页专用，自动版本备份）
- `POST /api/files/:id/overwrite-json` — JSON 覆盖上传（MCP 使用，自动版本备份）
- `GET /api/files/:id/versions` — 版本历史列表
- `GET /api/files/:id/versions/:ver/content` — 历史版本原文
- `GET /api/files/:id/versions/:ver/render` — 渲染历史版本
- `POST /api/files/:id/versions/:ver/restore` — 恢复到指定版本
- `DELETE /api/files/:id/versions/:ver` — 删除指定历史版本
- `GET /api/files/:id/stats` — 返回 `{viewCount, daily7, daily30}`（viewCount 含未回写缓冲值）
- `GET /s/:key` — 短链接渲染页面（通过 share_key 查找文件并渲染，公开文件无需登录，访问计数 30s 批量回写）
- `GET /api/tags` — 列出所有标签（含 file_count）
- `POST /api/tags` — `{name}` 创建标签（已存在则返回现有）
- `DELETE /api/tags/:id` — 删除标签
- `PUT /api/files/:id/tags` — `{tagIds: [1,2,3]}` 替换文件的标签
- `POST /api/files/:id/star` — 收藏文件
- `DELETE /api/files/:id/star` — 取消收藏
- `GET /api/categories` — 列出分类（含 file_count）
- `POST /api/categories` — `{name}` 创建分类
- `PUT /api/categories/:id` — `{name}` 重命名分类（**仅 admin**）
- `DELETE /api/categories/:id` — 删除分类（文件变未分类，**仅 admin**）
- `PUT /api/files/:id/category` — `{categoryId: number|null}` 设置文件分类（admin 或文件所有者）
- `GET /api/templates` — 样式模板列表（含内置 default/github/academic/dark-pro）
- `GET /api/content-templates/public` — 公开内容模板列表（无需登录）
- `GET /api/content-templates/public/:id/preview` — 公开模板预览
- `GET /api/content-templates` — 当前用户内容模板列表
- `GET /api/content-templates/scenes` — 模板场景分类
- `GET /api/content-templates/:id` / `/:id/content` — 模板详情 / 原文
- `POST /api/content-templates` / `PUT /api/content-templates/:id` / `DELETE /api/content-templates/:id` — 创建/更新/删除（仅所有者）
- `POST /api/content-templates/:id/use` — 基于模板创建文件
- `GET /api/admin/export` — 导出数据库备份（仅 admin）
- `POST /api/admin/import` — 导入备份（替换连接后重新 `configureDatabase()`，仅 admin）
- `GET /api/admin/stats` — 系统统计（仅 admin）
- `GET /api/skills` — 列出已安装的 skill 包（需登录）
- `GET /api/skills/:name` — skill 详情（含 SKILL.md 内容、文件列表、INSTALL.md 渲染）
- `GET /api/skills/:name/download` — ZIP 下载整个 skill 目录
- `GET /api/mcp/config` — 返回 MCP 连接配置（URL、Token 列表、多客户端 mcpServers JSON 片段；仅 MCP 客户端）
- `GET /api/cli/guide` — 返回 `jpage` CLI 用法指南（baseUrl、渲染后的 guideHtml、纯文本 guideText）；CLI 与 MCP 是并列的两个客户端入口，各自独立端点

**Skills registry** — `skills-registry.js` 自动发现 `skills/*/SKILL.md`，解析 YAML frontmatter（`name`, `description`, `version`, `author`）。Web UI 首页展示 Skills 区块，管理员可查看详情（弹窗）和下载 ZIP。ZIP 包与磁盘目录结构一致，可直接解压到 `~/.claude/skills/`。

**MCP endpoint**（`MCP_TOKEN` 或用户级 Token 二选一即可挂载）：
- `POST`/`GET`/`DELETE /mcp` — Streamable HTTP transport
- Bearer auth: 全局 `MCP_TOKEN`（向后兼容）或用户级 API Token
- Tools（15 个）：
  - 文件管理：`list_files`, `upload_file`（支持 ZIP base64/覆盖/标签/分类）, `get_file_content`, `delete_file`, `rename_file`, `get_file_url`
  - 版本管理：`list_file_versions`, `restore_file_version`
  - 标签管理：`list_tags`, `add_tags_to_file`
  - 收藏管理：`star_file`, `unstar_file`
  - 分类管理：`list_categories`, `create_category`, `set_file_category`
- Resources（2 个）：`jpage://files`（列表）, `jpage://file/{id}`（内容，≤ 256KB）

**Static + SPA fallback** — `public/` served by `express.static`; `/s/:key` short link route renders files directly; catch-all `app.get('*')` returns `public/index.html` for client-side routing between home and preview views.

**Frontend** — `public/index.html` 定义两个 `<template>` 块（home / preview）；`public/js/app.js` 是 vanilla-JS（ESM）控制器，基于 URL hash 切换视图，**各路由模块用动态 `import()` 按需加载**（landing/login/home/preview）。无框架。CSS 在 `public/css/style.css`，支持系统深色模式。Markdown 渲染增强使用 marked + highlight.js + KaTeX + Mermaid。生产可选构建（`npm run build`，esbuild 代码分割 + minify 到 `public/dist/`）；开发无需构建，直接加载源文件。

## Conventions & Gotchas

- **默认端口 8858**（非 3000）。通过 `PORT` 环境变量可配置。`Dockerfile`、`docker-compose.yml`、`README.md` 均引用 8858，保持同步。
- **Multer 文件名编码** — `decodeFilename` 辅助函数（`Buffer.from(name, 'latin1').toString('utf8')`）是必需的，因为 multer 以 latin1 存储 `originalname`。不要移除。
- **catch-all 路由必须在所有 API 路由、`/s/:key` 和 MCP 挂载之后** — Express 按顺序匹配，提前放置会遮蔽 API、短链接或 `/mcp`。
- **SPA 兜底 + 构建产物注入** — `public/` 的 `express.static` 设 `index:false`（不让 static 自动把 `/` 映射到 index.html），由 `app.get('*')` 的 `getIndexHtml()` 返回 index.html 并按 `public/dist/manifest.json` 把 `/css/style.css?v=` 与 `/js/app.js?v=` 替换为 `/dist/<hash>.css|.js`。无 dist 时回退源文件路径。新增 SPA 路由 hash 时，注意它在 catch-all 之前由前端 `route()` 处理。
- **数据库共享** — 单个 `db` 连接复用于所有请求。Promise 封装 `dbRun`/`dbGet`/`dbAll` 保持调用简洁。
- **SQLite 性能 PRAGMA** — `configureDatabase()` 在 `app.listen` 内、migration 之前执行：`journal_mode=WAL`（读写不互斥）、`synchronous=NORMAL`、`busy_timeout=5000`、`cache_size=-20000`、`temp_store=MEMORY`、`mmap_size`。WAL 会生成 `database.sqlite-wal` / `-shm` 文件，属正常。`admin/import` 替换连接后会重新调用 `configureDatabase()`。
- **数据目录可配置** — `JPAGE_DATA_DIR` 环境变量（可选，默认 `./data`）。docker-compose 已把 `./data` 挂载到 `/app/data`，通常无需设置。
- **时间统一存 UTC** — `now()` 返回 UTC `YYYY-MM-DD HH:MM:SS`，与 SQLite 的 `CURRENT_TIMESTAMP` / `datetime('now')` 一致。展示层负责转本地时区。不要再改回北京时区字符串。
- **Markdown 渲染缓存** — `RENDER_CACHE` 以 `${fileId}:${stored_name}:${updated_at}:...` 为 key 缓存渲染结果（LRU，上限 256）。覆盖上传/恢复版本会改 `updated_at`/`stored_name` 自动失效；删除文件调 `invalidateRenderCache(id)`。历史版本渲染传入 `{ ...file, stored_name: ver.stored_name }`，故 key 必须含 `stored_name`。
- **分类名称内存缓存** — `categoryNameCache`（id→name）在启动时 `reloadCategoryNameCache()` 加载，分类增/删/改名/import 后失效重建。`/api/files` 与搜索经 `getCategoryName(id)` 取名，不再每次扫 `categories` 表。
- **view_count 批量回写** — 短链 `/s/:key` 的访问计数累积到 `VIEW_COUNT_BUFFER`，每 30s 或进程退出时 `flushViewCounts()` 批量写库。`/api/files/:id/stats` 返回时把缓冲值加上，保证读一致。
- **大 body 端点专用解析** — 全局 `express.json` 限 1MB；`upload-json` / `upload-zip-base64` / `overwrite-json` 用 `largeJson`（50MB）。新增大 body 端点时挂 `largeJson`。
- **静态资源长缓存** — `express.static` 统一带 `STATIC_OPTS`（30d + immutable）。前端 CSS/JS 引用带 `?v=x.y.z`，改资源后务必 bump 版本号以失效缓存。
- **MCP 进程内分发** — MCP tool 不再走 `fetch('http://127.0.0.1:port/...')` 自调用，改用 `lib/dispatch.js` 的 `createDispatcher(app, {token})` 直接调 `app.handle()`。新增 MCP tool 时用传入的 `api` 对象（`api.get/post/put/del`），接口与 fetch 版一致；鉴权靠 `Authorization: Bearer <token>` 头走 `requireAuth`，行为与 HTTP 完全相同（权限、限流、审计都生效）。
- **CLI 与 MCP 双客户端入口必须同步** — `bin/commands/*.js`（CLI 命令）与 `mcp/tools-*.js`（MCP tool）是两个对等的客户端入口，都构建在同一套 REST API（`routes/`）之上。**新增或修改任一端的功能时，另一端必须同步实现对应能力**：CLI 加命令就同时给 MCP 加 tool，反之亦然，避免两边能力漂移。功能域与文件对应：文件管理 → `commands/{upload,ls,cat,url,mv,rm,star,tags}.js` ↔ `mcp/tools-files.js`；标签 → `commands/tags.js` ↔ `mcp/tools-tags.js`；版本 → `mcp/tools-versions.js`（CLI 待补）；分类 → `mcp/tools-categories.js`（CLI 待补）。
- **模板预编译** — `loadTemplates()` 把每个模板经 `compileTemplate()` 编为函数存入 `templateCache`（静态 vendor URL 占位符在加载时一次替换，运行时仅 title/content/hljs_theme 三个 `split/join`）。`templateCache[name]` 是**函数**而非字符串，`applyTemplate(tplFn, ...)` 直接调用。
- **marked.parse 同步** — 所有 `marked.parse(...)` 显式带 `async: false`（v12 默认同步，显式声明防止未来升级开启 async 返回 Promise 被当字符串拼接）。
- **搜索 UNION 合并** — `/api/files/search` 用 `UNION` 合并 FTS 全文命中（带 `snippet`）与文件名 LIKE 命中（snippet 为 NULL），一次往返替代旧的两查询+内存去重，分页准确。注意 FTS5 的 `MATCH` 不能与普通列在 `LEFT JOIN + OR` 中混用（SQLite 报 "unable to use function MATCH"）。
- **上传限流** — `express-rate-limit` 应用于 `POST /api/files/upload`、`POST /api/files/upload-json`、`POST /api/files/:id/overwrite`、`POST /api/files/:id/overwrite-json`，按 IP 限流。
- **HTML 渲染端点** — 故意不清理 HTML，因为在用户自己的 iframe 沙箱中（`sandbox="allow-scripts allow-same-origin"`）。修改此 CSP 需谨慎。
- **容器环境变量必须与 `.env` 保持一体** — 任何在 `server.js` 中通过 `process.env` 读取的环境变量，必须同时出现在 `.env`（或 `.env.example`）和 `docker-compose.yml` 的 `environment` 中。新增或修改环境变量时，三者同步更新，否则容器内读不到该变量。
- **容器端口映射** — `docker-compose.yml` 映射 host 8858 → container 8858。反向代理后可不发布端口。
- **`.dockerignore` 排除 `data/`** — 上传文件不烘焙进镜像；compose 中的 `data/` volume 持久化状态。
- **鉴权模型** — `requireAuth` 是异步中间件，接受三种认证方式：(1) session cookie，(2) 旧 `MCP_TOKEN` 环境变量（向后兼容），(3) 用户级 API Token（`tokens` 表）。中间件设置 `req.userId` 和 `req.userRole` 供下游使用。`requireAdmin` 检查 `req.userRole === 'admin'`。`loadFileWithPrivacy` 强制文件所有权：admin 可访问一切，普通用户仅可访问自己的文件和公开文件。
- **角色系统** — `users.role` 列，值为 `admin` 或 `user`。admin 可管理用户、查看所有文件。普通用户只能操作自己的文件。`bootstrapAdmin()` 创建时显式设置 `role='admin'`。
- **开放注册** — `ALLOW_REGISTRATION=true` 时允许用户自助注册，默认关闭。注册端点 `POST /api/auth/register`，支持邮箱或用户名注册。配合 SMTP 配置实现邮箱验证。环境变量必须在 `.env`、`docker-compose.yml`、`server.js` 三处同步。
- **API Token** — 每用户最多 10 个，格式 `jp_` + 32 位 base62。DB 存 SHA-256 哈希（鉴权用，不可逆）+ 前 8 位前缀 + AES-256-GCM 密文（`token_enc`，使明文可后续查看/复制，旧令牌为 NULL）。加密密钥来自环境变量 `TOKEN_ENCRYPTION_KEY`，未设置时自动在数据目录生成 `token-key.key` 文件（持久化）。鉴权链路仅用哈希，与密文相互独立。
- **`MCP_TOKEN` 是可选的** — 未设置时仍可通过用户级 Token 访问 MCP。`mountMcpServer` 接受 `authenticateRequest` 函数验证 Token。
- **`uploaded_by` 从 `req.userId` 设置** — 文件归属隔离：admin 看全部文件，普通用户看自己的 + 公开的。`PUT`/`DELETE` 增加所有权检查（`checkFileOwnership`）。
- **Markdown 渲染增强** — marked + highlight.js（代码高亮）+ KaTeX（数学公式 `$...$` / `$$...$$`）+ Mermaid（图表，支持深色/浅色主题）。渲染代码在 `server.js` 的 `renderMarkdown` 函数。
- **ZIP 上传与 Bundle** — `POST /api/files/upload` 支持 `.zip` 文件。ZIP 分两种模式：(1) 网站包（含 index.html + 资源目录），存储为解压后的目录，`is_bundle=1`，渲染时注入 `<base>` 标签使相对路径指向 `/api/files/:id/asset/`；(2) 批量上传（多个独立 HTML/MD），各自创建文件记录。MCP 的 `upload_file` tool 通过 base64 编码调用 `POST /api/files/upload-zip-base64`。
- **同名自动覆盖** — `upload` 和 `upload-json` 端点遇到同名文件时自动覆盖（备份当前版本到 `file_versions` 表），非报错。MCP 可通过 `overwriteFileId` 显式指定覆盖目标。
- **版本历史** — 每次覆盖上传（同名覆盖或显式 overwrite）都会将旧版本存入 `file_versions`。版本 API 支持列出、查看、渲染、恢复、删除历史版本。

## Logging

**结构化 JSON Lines 日志**，输出到 stdout/stderr（12-factor 做法），Docker 自动捕获，`docker compose logs` 查看。

**三个模块**：
- `logger.js` — 日志工具，导出 `logger.info(obj)` / `logger.warn(obj)` / `logger.error(obj)` / `logger.audit(action, details)`
- `morgan` — HTTP 请求日志（自定义 JSON 格式，跳过静态资源），挂载在 session 中间件之后以获取 userId
- 各模块直接调用 `logger.*` — 应用日志和审计日志

**三种日志类型**（`type` 字段区分）：
- `http` — morgan 自动记录，含 method、url、status、responseTime、userId 等
- `audit` — 通过 `logger.audit(action, details)` 记录关键操作（login、logout、file.upload、file.update、file.delete、file.overwrite、file.restore 等）
- `app` — 应用事件（启动、警告、错误等）

**日志级别**：`info` → stdout，`error` → stderr，`warn` → stdout

**新增代码的日志原则**：
- **禁止使用 `console.log/error/warn`**，统一使用 `const logger = require('./logger')`
- HTTP 请求由 morgan 自动记录，路由处理中不要再手动记录请求日志
- 关键写操作（增删改）必须添加审计日志：`logger.audit('action.name', { fileId, ip: clientIp(req), ... })`
- `logger.audit` 的 `details` 应包含操作目标标识（如 fileId、fileName）和 `ip: clientIp(req)`
- 错误日志只记 `error: e.message`，不传原始 Error 对象（JSON.stringify(Error) 结果为 `{}`）
- 不要记录静态资源请求（morgan 的 skip 已配置），不要记录高频只读操作（如 GET /api/auth/me）

## Database Migrations

### 机制

- `migrations.js` 导出 `runMigrations(db)`，在 `app.listen` 回调中 `await` 调用
- `_migrations` 表记录已执行的 migration（按 `name` 去重）
- `migrations/` 目录下按文件名排序执行，跳过已记录的
- 每个 migration 文件导出 `{ name, up(db, helpers) }`，`helpers` 提供 `{ dbRun, dbGet, dbAll }`
- 启动日志 `[migration] Running/Done: xxx` 确认执行情况

### 新增 migration 步骤

1. 在 `migrations/` 目录创建文件，命名格式 `{序号}_{描述}.js`，序号接续当前最大值
2. 文件内容模板：

```js
module.exports = {
  name: '描述（唯一标识，用下划线分隔）',
  async up(db, { dbRun, dbGet, dbAll }) {
    // 写 SQL
  }
};
```

3. 新增列时**必须幂等**：先 `PRAGMA table_info` 检查列是否存在，不存在再 `ALTER TABLE ADD COLUMN`
4. 新建表用 `CREATE TABLE IF NOT EXISTS`
5. **SQLite 限制**：`ALTER TABLE ADD COLUMN` 不支持 `DEFAULT CURRENT_TIMESTAMP` 等非恒定默认值，需先加列（无默认或恒定默认），再 `UPDATE` 回填
6. 同步更新此文件中的 **Database schema** 描述

## File layout

```
server.js                # Express + REST API + auth + Markdown 渲染增强
logger.js                # 结构化 JSON Lines 日志工具（info/warn/error/audit）
mailer.js                # SMTP 邮件发送模块（nodemailer，用于邮箱验证）
mcp-server.js            # MCP Streamable HTTP server (POST/GET/DELETE /mcp)
migrations.js            # Migration runner，启动时自动执行
migrations/              # Migration 文件目录（按文件名排序执行）
  001_init_schema.js
  002_add_share_key.js
  003_add_roles_and_tokens.js
  004_add_version_history.js
  005_tags_starred_categories.js
  006_zip_bundle.js
  007_add_file_type_uploaded_by_indexes.js
  008_add_fts5.js
  009_add_link_visits.js
  010_add_templates_system.js
  011_content_templates.js
  012_add_email_and_verification.js
skills-registry.js       # 扫描 skills/ 目录，解析 SKILL.md，提供列表/详情/ZIP 打包
package.json             # 依赖: @modelcontextprotocol/sdk, zod, archiver, marked, highlight.js, katex, mermaid 等
Dockerfile               # node:20-alpine, EXPOSE 8858
docker-compose.yml       # port 8858, ./data:/app/data volume
.env.example             # 环境变量模板
.mcp.json                # Claude Code / Desktop MCP 客户端配置示例
docs/api.md              # REST API 完整参考
skills/jpage-upload/     # Claude Code / Desktop skill
  SKILL.md
public/
  index.html             # 两个 <template>: home + preview
  css/style.css          # 样式 + 深色模式
  js/app.js              # vanilla JS（ESM）控制器（hash 路由 + 动态 import 各页面）
  dist/                  # gitignore — npm run build 产物（带哈希的 JS/CSS + manifest.json）
data/                    # gitignore — SQLite DB, sessions, uploads（运行时自动创建）
docs/screenshot-home.png
```
