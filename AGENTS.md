# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project: 即页 (jpage)

零配置 HTML / Markdown 即时预览与分享工具。Express 服务（`server.js`）+ MCP server 模块（`mcp-server.js`）+ Skills 注册模块（`skills-registry.js`）。SQLite 存元数据与用户表，磁盘 `data/uploads/` 存原始文件，session 存 `data/sessions.sqlite`。单管理员鉴权（bcrypt）。支持 Markdown 增强渲染（代码高亮、KaTeX 公式、Mermaid 图表）。

## Commands

**推荐使用 Docker Compose 部署**（本地和生产均适用）：

1. 复制 `.env.example` 或自行创建 `.env`，填入 `SESSION_SECRET`、`ADMIN_PASSWORD`、`MCP_TOKEN` 等
2. `docker-compose up -d` — 构建镜像并启动容器，`./data` 目录 bind-mount 持久化数据库和上传文件
3. `docker-compose logs -f` — 查看启动日志（首次会打印自动生成的管理员密码，如未在 `.env` 指定）
4. `docker-compose down` — 停止容器

**本地开发**（不用 Docker）：

- `npm install` — 安装依赖
- `npm run dev` — nodemon 热重载开发模式
- `npm start` — 直接运行（需自行配置 `.env` 或环境变量）

环境变量说明见 `.env` 文件注释。`MCP_TOKEN` 设置后自动启用 `/mcp` 端点。

There is no test suite, linter, or build step. Verify changes by hitting the API, loading the UI in a browser at http://localhost:8858, or using `npx @modelcontextprotocol/inspector http://localhost:8858/mcp` to debug the MCP server.

## Architecture

**Five-module backend**:
- `server.js` (~1534 lines) — Express app, REST API, auth (session + bcrypt), multer upload, ZIP 包上传/批量处理, SQLite, Markdown 渲染增强（marked + highlight.js + KaTeX + Mermaid）
- `logger.js` (~20 lines) — 结构化 JSON Lines 日志工具，导出 info/warn/error/audit 方法，error 输出到 stderr，其余到 stdout
- `mcp-server.js` (~614 lines) — MCP Streamable HTTP server. Exports `mountMcpServer(app, {port, mcpToken, mcpIp, protocol, authenticateRequest})` and `closeMcpTransports()`. 15 tools + 2 resources; tools call the REST API via loopback fetch with the same Bearer token.
- `migrations.js` (~65 lines) — Migration runner，启动时自动执行 `migrations/` 目录下未应用的 migration，记录到 `_migrations` 表。
- `skills-registry.js` (~135 lines) — 自动扫描 `skills/*/SKILL.md`，解析 YAML frontmatter，提供 skill 列表/详情/ZIP 打包下载。

**Storage**（均自动创建）：
- `data/database.sqlite` — 业务表（files、users 等）+ `_migrations` 版本追踪表
- `data/sessions.sqlite` — express-session store (connect-sqlite3)
- `data/uploads/` — 上传文件内容，命名 `<timestamp>-<random><ext>`

**Database schema**:
- `_migrations(id, name UNIQUE, applied_at)` — 记录已执行的 migration
- `files(id, original_name, stored_name, file_type, size, created_at, is_public, uploaded_by, share_key, updated_at, category_id, is_bundle, entry_path)` — `is_public=1` means anonymous can read; `uploaded_by` references `users.id`; `share_key` is 8-char URL-safe random string for short links
- `users(id, username UNIQUE, email UNIQUE, email_verified, password_hash, role, created_at)` — `email` 可为 NULL；`email_verified` 0/1
- `file_versions(id, file_id, version, stored_name, size, created_at, uploaded_by)` — 文件版本历史
- `tokens(id, user_id, name, token_hash, token_prefix, last_used_at, created_at)` — API token
- `tags(id, name UNIQUE, created_at)` — 标签词典
- `file_tags(file_id, tag_id)` — 文件-标签多对多
- `starred_files(user_id, file_id, created_at)` — 收藏
- `categories(id, name, user_id, created_at)` — 分类
- `email_verifications(id, user_id, token_hash, token_prefix, type, new_email, expires_at, created_at)` — 邮箱验证 token

**REST API**:
- `GET /api/auth/me` — 当前用户（返回 `{id, username, email, emailVerified, role}`）
- `POST /api/auth/login` — `{account, password}` 或 `{username, password}`（统一入口，自动识别用户名或邮箱），设置 `jpage.sid` cookie，限流 10/15min
- `POST /api/auth/register` — `{email?, username?, password, confirmPassword}`（至少提供 email 或 username，邮箱注册自动生成用户名）
- `POST /api/auth/logout` — 销毁 session
- `POST /api/auth/change-password` — `{currentPassword, newPassword}`，所有用户可用
- `POST /api/auth/profile` — `{username?, email?}` 编辑个人资料（需登录）
- `GET /api/auth/verify-email?token=...` — 验证邮箱 token，重定向前端页面
- `POST /api/auth/resend-verification` — 重发验证邮件（需登录），限流 5/h
- `GET /api/auth/smtp-status` — 返回 `{configured: bool}` SMTP 是否配置
- `GET /api/users` — 列出用户含 email（仅 admin）
- `POST /api/users` — 创建用户 `{username, password, role, email?}`（仅 admin）
- `PUT /api/users/:id` — 更新用户名、邮箱、角色或重置密码（仅 admin）
- `DELETE /api/users/:id` — 删除用户，文件转交 admin（仅 admin，不可删自己）
- `GET /api/tokens` — 列出自己的 API Token
- `POST /api/tokens` — 创建 Token `{name}`，返回明文（仅一次）
- `DELETE /api/tokens/:id` — 删除 Token（自己的或 admin 删任意）
- `GET /api/files` — 列出文件（admin 看全部，普通用户看自己的+公开的）
- `POST /api/files/upload` — multipart 上传（需登录，50/15min，50MB，支持 .html/.htm/.md/.markdown/.zip）
- `POST /api/files/upload-json` — JSON `{name, content, isPublic?}`（需登录，同名自动覆盖）
- `PUT /api/files/:id` — `{name?, isPublic?}`（admin 或文件所有者）
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
- `GET /s/:key` — 短链接渲染页面（通过 share_key 查找文件并渲染，公开文件无需登录）
- `GET /api/tags` — 列出所有标签（含 file_count）
- `POST /api/tags` — `{name}` 创建标签（已存在则返回现有）
- `DELETE /api/tags/:id` — 删除标签
- `PUT /api/files/:id/tags` — `{tagIds: [1,2,3]}` 替换文件的标签
- `POST /api/files/:id/star` — 收藏文件
- `DELETE /api/files/:id/star` — 取消收藏
- `GET /api/categories` — 列出分类（含 file_count）
- `POST /api/categories` — `{name}` 创建分类
- `PUT /api/categories/:id` — `{name}` 重命名分类
- `DELETE /api/categories/:id` — 删除分类（文件变未分类）
- `PUT /api/files/:id/category` — `{categoryId: number|null}` 设置文件分类
- `GET /api/skills` — 列出已安装的 skill 包（需登录）
- `GET /api/skills/:name` — skill 详情（含 SKILL.md 内容、文件列表、INSTALL.md 渲染）
- `GET /api/skills/:name/download` — ZIP 下载整个 skill 目录
- `GET /api/mcp/config` — 返回 MCP 连接配置（URL、Token 列表、JSON 配置片段）

**Skills registry** — `skills-registry.js` 自动发现 `skills/*/SKILL.md`，解析 YAML frontmatter（`name`, `description`, `version`, `author`）。Web UI 首页展示 Skills 区块，管理员可查看详情（弹窗）和下载 ZIP。ZIP 包与磁盘目录结构一致，可直接解压到 `~/.Codex/skills/`。

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

**Frontend** — `public/index.html` 定义两个 `<template>` 块（home / preview）；`public/js/app.js` 是单文件 vanilla-JS 控制器，基于 URL hash 切换视图。无构建、无打包器、无框架。CSS 在 `public/css/style.css`，支持系统深色模式。Markdown 渲染增强使用 marked + highlight.js + KaTeX + Mermaid。

## Conventions & Gotchas

- **默认端口 8858**（非 3000）。通过 `PORT` 环境变量可配置。`Dockerfile`、`docker-compose.yml`、`README.md` 均引用 8858，保持同步。
- **Multer 文件名编码** — `decodeFilename` 辅助函数（`Buffer.from(name, 'latin1').toString('utf8')`）是必需的，因为 multer 以 latin1 存储 `originalname`。不要移除。
- **catch-all 路由必须在所有 API 路由、`/s/:key` 和 MCP 挂载之后** — Express 按顺序匹配，提前放置会遮蔽 API、短链接或 `/mcp`。
- **数据库共享** — 单个 `db` 连接复用于所有请求。Promise 封装 `dbRun`/`dbGet`/`dbAll` 保持调用简洁。
- **上传限流** — `express-rate-limit` 应用于 `POST /api/files/upload`、`POST /api/files/upload-json`、`POST /api/files/:id/overwrite`、`POST /api/files/:id/overwrite-json`，按 IP 限流。
- **HTML 渲染端点** — 故意不清理 HTML，因为在用户自己的 iframe 沙箱中（`sandbox="allow-scripts allow-same-origin"`）。修改此 CSP 需谨慎。
- **容器环境变量必须与 `.env` 保持一体** — 任何在 `server.js` 中通过 `process.env` 读取的环境变量，必须同时出现在 `.env`（或 `.env.example`）和 `docker-compose.yml` 的 `environment` 中。新增或修改环境变量时，三者同步更新，否则容器内读不到该变量。
- **容器端口映射** — `docker-compose.yml` 映射 host 8858 → container 8858。反向代理后可不发布端口。
- **`.dockerignore` 排除 `data/`** — 上传文件不烘焙进镜像；compose 中的 `data/` volume 持久化状态。
- **鉴权模型** — `requireAuth` 是异步中间件，接受三种认证方式：(1) session cookie，(2) 旧 `MCP_TOKEN` 环境变量（向后兼容），(3) 用户级 API Token（`tokens` 表）。中间件设置 `req.userId` 和 `req.userRole` 供下游使用。`requireAdmin` 检查 `req.userRole === 'admin'`。`loadFileWithPrivacy` 强制文件所有权：admin 可访问一切，普通用户仅可访问自己的文件和公开文件。
- **角色系统** — `users.role` 列，值为 `admin` 或 `user`。admin 可管理用户、查看所有文件。普通用户只能操作自己的文件。`bootstrapAdmin()` 创建时显式设置 `role='admin'`。
- **开放注册** — `ALLOW_REGISTRATION=true` 时允许用户自助注册，默认关闭。注册端点 `POST /api/auth/register`，支持邮箱或用户名注册。配合 SMTP 配置实现邮箱验证。环境变量必须在 `.env`、`docker-compose.yml`、`server.js` 三处同步。
- **API Token** — 每用户最多 10 个，格式 `jp_` + 32 位 base62。DB 存 SHA-256 哈希 + 前 8 位前缀。明文仅创建时返回一次。
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
  008_add_link_visits.js
  008_add_templates_system.js
  009_content_templates.js
  010_add_email_and_verification.js
skills-registry.js       # 扫描 skills/ 目录，解析 SKILL.md，提供列表/详情/ZIP 打包
package.json             # 依赖: @modelcontextprotocol/sdk, zod, archiver, marked, highlight.js, katex, mermaid 等
Dockerfile               # node:20-alpine, EXPOSE 8858
docker-compose.yml       # port 8858, ./data:/app/data volume
.env.example             # 环境变量模板
.mcp.json                # Codex / Desktop MCP 客户端配置示例
docs/api.md              # REST API 完整参考
skills/jpage-upload/     # Codex / Desktop skill
  SKILL.md
public/
  index.html             # 两个 <template>: home + preview
  css/style.css          # 样式 + 深色模式
  js/app.js              # 单文件 vanilla JS 控制器（hash 路由）
data/                    # gitignore — SQLite DB, sessions, uploads（运行时自动创建）
docs/screenshot-home.png
```
