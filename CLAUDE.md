# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

**Three-module backend**:
- `server.js` (~660 lines) — Express app, REST API, auth (session + bcrypt), multer upload, SQLite, Markdown 渲染增强（marked + highlight.js + KaTeX + Mermaid）
- `mcp-server.js` (~350 lines) — MCP Streamable HTTP server. Exports `mountMcpServer(app, {port, mcpToken})` and `closeMcpTransports()`. 6 tools + 2 resources; tools call the REST API via loopback fetch with the same Bearer token.
- `migrations.js` (~65 lines) — Migration runner，启动时自动执行 `migrations/` 目录下未应用的 migration，记录到 `_migrations` 表。
- `skills-registry.js` (~130 lines) — 自动扫描 `skills/*/SKILL.md`，解析 YAML frontmatter，提供 skill 列表/详情/ZIP 打包下载。

**Storage**（均自动创建）：
- `data/database.sqlite` — 业务表（files、users 等）+ `_migrations` 版本追踪表
- `data/sessions.sqlite` — express-session store (connect-sqlite3)
- `data/uploads/` — 上传文件内容，命名 `<timestamp>-<random><ext>`

**Database schema**:
- `_migrations(id, name UNIQUE, applied_at)` — 记录已执行的 migration
- `files(id, original_name, stored_name, file_type, size, created_at, is_public, uploaded_by, share_key, updated_at, category_id, is_bundle, entry_path)` — `is_public=1` means anonymous can read; `uploaded_by` references `users.id`; `share_key` is 8-char URL-safe random string for short links
- `users(id, username UNIQUE, password_hash, role, created_at)`
- `file_versions(id, file_id, version, stored_name, size, created_at, uploaded_by)` — 文件版本历史
- `tokens(id, user_id, name, token_hash, token_prefix, last_used_at, created_at)` — API token
- `tags(id, name UNIQUE, created_at)` — 标签词典
- `file_tags(file_id, tag_id)` — 文件-标签多对多
- `starred_files(user_id, file_id, created_at)` — 收藏
- `categories(id, name, user_id, created_at)` — 分类

**REST API**:
- `GET /api/auth/me` — 当前用户
- `POST /api/auth/login` — `{username, password}`，设置 `jpage.sid` cookie，限流 10/15min
- `POST /api/auth/logout` — 销毁 session
- `GET /api/files` — 列出文件（需登录）
- `POST /api/files/upload` — multipart 上传（需登录，50/15min，50MB，.html/.htm/.md/.markdown）
- `POST /api/files/upload-json` — JSON `{name, content, isPublic?}`（需登录，MCP 使用）
- `PUT /api/files/:id` — `{name?, isPublic?}`（至少一个）
- `DELETE /api/files/:id` — 删除数据库记录和磁盘文件
- `GET /api/files/:id/content` — 返回原始文件文本 JSON（公开文件无需登录）
- `GET /api/files/:id/render` — 返回渲染 HTML（Markdown 使用 marked + highlight.js + KaTeX + Mermaid）
- `GET /s/:key` — 短链接渲染页面（通过 share_key 查找文件并渲染，公开文件无需登录）
- `GET /api/files/:id/download` — 流式下载文件
- `GET /api/skills` — 列出已安装的 skill 包（需登录）
- `GET /api/skills/:name` — skill 详情（含 SKILL.md 内容和文件列表）
- `GET /api/skills/:name/download` — ZIP 下载整个 skill 目录

**Skills registry** — `skills-registry.js` 自动发现 `skills/*/SKILL.md`，解析 YAML frontmatter（`name`, `description`, `version`, `author`）。Web UI 首页展示 Skills 区块，管理员可查看详情（弹窗）和下载 ZIP。ZIP 包与磁盘目录结构一致，可直接解压到 `~/.claude/skills/`。

**MCP endpoint**（仅当 `MCP_TOKEN` 环境变量设置时挂载）：
- `POST`/`GET`/`DELETE /mcp` — Streamable HTTP transport
- Bearer auth via `Authorization: Bearer ${MCP_TOKEN}`
- Tools（6 个）：`list_files`, `upload_file`, `get_file_content`, `delete_file`, `rename_file`, `get_file_url`
- Resources（2 个）：`jpage://files`（列表）, `jpage://file/{id}`（内容，≤ 256KB）

**Static + SPA fallback** — `public/` served by `express.static`; `/s/:key` short link route renders files directly; catch-all `app.get('*')` returns `public/index.html` for client-side routing between home and preview views.

**Frontend** — `public/index.html` 定义两个 `<template>` 块（home / preview）；`public/js/app.js` 是单文件 vanilla-JS 控制器，基于 URL hash 切换视图。无构建、无打包器、无框架。CSS 在 `public/css/style.css`，支持系统深色模式。Markdown 渲染增强使用 marked + highlight.js + KaTeX + Mermaid。

## Conventions & Gotchas

- **默认端口 8858**（非 3000）。通过 `PORT` 环境变量可配置。`Dockerfile`、`docker-compose.yml`、`README.md` 均引用 8858，保持同步。
- **Multer 文件名编码** — `decodeFilename` 辅助函数（`Buffer.from(name, 'latin1').toString('utf8')`）是必需的，因为 multer 以 latin1 存储 `originalname`。不要移除。
- **catch-all 路由必须在所有 API 路由、`/s/:key` 和 MCP 挂载之后** — Express 按顺序匹配，提前放置会遮蔽 API、短链接或 `/mcp`。
- **数据库共享** — 单个 `db` 连接复用于所有请求。Promise 封装 `dbRun`/`dbGet`/`dbAll` 保持调用简洁。
- **上传限流** — `express-rate-limit` 仅应用于 `POST /api/files/upload` 和 `POST /api/files/upload-json`，按 IP 限流。
- **HTML 渲染端点** — 故意不清理 HTML，因为在用户自己的 iframe 沙箱中（`sandbox="allow-scripts allow-same-origin"`）。修改此 CSP 需谨慎。
- **容器端口映射** — `docker-compose.yml` 映射 host 8858 → container 8858。反向代理后可不发布端口。
- **`.dockerignore` 排除 `data/`** — 上传文件不烘焙进镜像；compose 中的 `data/` volume 持久化状态。
- **鉴权模型** — `requireAuth` 接受 `req.session.userId` 或 `Authorization: Bearer ${MCP_TOKEN}`。MCP token 使用时，`req.session.userId` 设置为第一个 `users.id`，`uploaded_by` 记录管理员用户。`loadFileWithPrivacy` 应用相同双重检查。
- **`MCP_TOKEN` 是可选的** — 未设置时，`mountMcpServer` 打印消息并返回，不添加 `/mcp` 路由。REST API 不受影响。
- **`uploaded_by` 从 `req.session.userId` 设置** — MCP 上传时为管理员用户 id，非 MCP 客户端。不添加 per-MCP-client 身份。
- **Markdown 渲染增强** — marked + highlight.js（代码高亮）+ KaTeX（数学公式 `$...$` / `$$...$$`）+ Mermaid（图表，支持深色/浅色主题）。渲染代码在 `server.js` 的 `renderMarkdown` 函数。

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
mcp-server.js            # MCP Streamable HTTP server (POST/GET/DELETE /mcp)
migrations.js            # Migration runner，启动时自动执行
migrations/              # Migration 文件目录（按文件名排序执行）
  001_init_schema.js
  002_add_share_key.js
  003_add_roles_and_tokens.js
  004_add_version_history.js
  005_tags_starred_categories.js
  006_zip_bundle.js
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
  js/app.js              # 单文件 vanilla JS 控制器（hash 路由）
data/                    # gitignore — SQLite DB, sessions, uploads（运行时自动创建）
docs/screenshot-home.png
```
