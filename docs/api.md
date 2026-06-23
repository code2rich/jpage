# 即页 REST API 参考

端口 `8858`（`PORT` 可覆盖）。所有写入类端点要求登录（session cookie `jpage.sid`）或 Bearer token。

## 通用说明

| 项 | 值 |
|---|---|
| Base URL | `http://localhost:8858` |
| 内容类型 | 除 `POST /api/files/upload`（multipart）外均为 `application/json` |
| 鉴权 | 三选一：session cookie `jpage.sid`（登录后获得）**或** 用户级 API Token（`Authorization: Bearer jp_xxx`）**或** 全局 `MCP_TOKEN`（向后兼容） |
| 字符集 | UTF-8 |
| 文件大小上限 | 50 MB |
| 允许扩展名（上传） | `.html` `.htm` `.md` `.markdown` `.zip` |
| 上传限流 | 50 req / 15 min / IP（`/api/files/upload`、`/api/files/upload-json`、`/api/files/:id/overwrite`、`/api/files/:id/overwrite-json`） |
| 登录限流 | 10 req / 15 min / IP（`POST /api/auth/login`） |

> **权限模型**：admin 可访问全部文件与用户；普通用户只能操作自己的文件与公开文件。下方各端点标注「需登录」表示三种鉴权方式任一即可，额外标注「仅 admin」的还需 admin 角色。

---

## 鉴权

### `GET /api/auth/me`

当前登录信息。返回 `{id, username, email, emailVerified, role}` 或 401。

```bash
curl -b jpage.sid=<cookie> http://localhost:8858/api/auth/me
```

### `POST /api/auth/login`

登录。Body: `{account, password}` 或 `{username, password}`（统一入口，自动识别用户名或邮箱）。成功后写入 session cookie。

```bash
curl -c jpage.sid -X POST http://localhost:8858/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin1234"}'
```

### `POST /api/auth/register`

注册（需 `ALLOW_REGISTRATION=true`）。Body: `{email?, username?, password, confirmPassword}`，至少提供 email 或 username。邮箱注册会自动生成用户名，并发送验证邮件。

### `POST /api/auth/logout`

销毁 session，清除 cookie。

### `POST /api/auth/change-password`

修改当前用户密码。Body: `{currentPassword, newPassword}`。所有用户可用。

### `POST /api/auth/profile`

编辑个人资料（需登录）。Body: `{username?, email?}`。

### `GET /api/auth/verify-email?token=...`

验证邮箱 token，重定向前端页面。

### `POST /api/auth/resend-verification`

重发验证邮件（需登录，限流 5/h）。

### `POST /api/auth/send-register-code`

发送注册验证码（需 `ALLOW_REGISTRATION=true`）。Body: `{email}`，向该邮箱发送 6 位数字验证码（10 分钟有效）。

### `GET /api/auth/smtp-status`

返回 `{configured: bool}`，SMTP 是否已配置。

### `GET /api/auth/registration-status`

返回 `{enabled: bool}`，注册是否开放。

---

## 文件管理

### `GET /api/files`

列出全部文件（按 `created_at DESC`）。返回 `{files: [...]}`。

```json
{
  "files": [
    {
      "id": 1,
      "original_name": "report.html",
      "file_type": "html",
      "size": 1234,
      "is_public": 1,
      "created_at": "2026-06-06 12:00:00"
    }
  ]
}
```

### `GET /api/files/search`

全文/文件名搜索（FTS5 + LIKE 合并，一次往返，带分页）。查询参数：`q`（关键词）、`page`、`pageSize`、`tagId`、`categoryId`、`starred` 等过滤项。需登录。

### `POST /api/files/upload` — multipart

传统上传（`multipart/form-data`）。字段：
- `file` — 二进制文件（必填，支持 `.html`/`.htm`/`.md`/`.markdown`/`.zip`）
- `isPublic` — `true` / `false`（可选，默认 `true`）

```bash
curl -b jpage.sid -X POST http://localhost:8858/api/files/upload \
  -F "file=@report.html" \
  -F "isPublic=true"
```

返回 `{id, original_name, file_type, size, is_public}`。

`.zip` 走两种模式：(1) **网站包 Bundle**（含 `index.html` + 资源目录），存为解压目录，`is_bundle=1`；(2) **批量上传**（多个独立 HTML/MD），各自建文件记录。同名文件自动覆盖（旧版本备份到 `file_versions`）。

### `POST /api/files/upload-json` — JSON

**MCP server 调用的入口**，避免构造 multipart。Body:

```json
{
  "name": "report.html",
  "content": "<!doctype html><h1>Hello</h1>",
  "isPublic": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✓ | 文件名（含扩展名） |
| `content` | string | ✓ | UTF-8 文本内容 |
| `isPublic` | boolean | ✗ | 默认 `true` |

返回同 multipart 端点。`uploaded_by` 自动取 session 用户 id。同名文件自动覆盖（备份旧版本到 `file_versions`）。

```bash
curl -b jpage.sid -X POST http://localhost:8858/api/files/upload-json \
  -H "Content-Type: application/json" \
  -d '{"name":"hello.html","content":"<h1>hi</h1>"}'
```

### `POST /api/files/upload-zip-base64` — JSON

MCP `upload_file` 调用的 ZIP 入口。Body: `{name, content(base64), ...}`，内部复用 ZIP 解包逻辑。

### `PUT /api/files/:id`

更新文件名或公开性。Body:
- `{name}` — 重命名（trim 后非空）
- `{isPublic}` — 切换公开/私有
- `{templateId}` — 绑定样式模板 id（可选）

至少传一个字段。仅 admin 或文件所有者。

```bash
curl -b jpage.sid -X PUT http://localhost:8858/api/files/1 \
  -H "Content-Type: application/json" \
  -d '{"name":"new-name.html"}'
```

### `DELETE /api/files/:id`

删除文件（DB + 磁盘）。返回 `{success: true}`。仅 admin 或文件所有者。

### `POST /api/files/batch`

批量操作。Body: `{action, ids: [...], data?}`，`action` ∈ `delete`/`setPublic`/`setPrivate`/`setCategory`，单次最多 200 个文件。

### `GET /api/files/:id`

单个文件元数据（经 `loadFileWithPrivacy` 做所有权/公开性校验）。

### `GET /api/files/:id/content`

返回原始文本。公开文件无需登录，私有文件需 session/token。**网站包（bundle，`is_bundle=1`）不支持此端点**，返回 `400`，请改用 `/api/files/:id/render` 预览或 `/api/files/:id/download` 下载。

```json
{ "id": 1, "original_name": "r.html", "file_type": "html", "is_public": 1, "content": "..." }
```

### `GET /api/files/:id/render`

返回渲染后的 HTML。Markdown 文件走 `marked` 转换并加样式模板；HTML 文件原样返回（自动注入 `<meta charset="UTF-8">`）；Bundle 注入 `<base>` 标签使相对路径指向 `/api/files/:id/asset/`。公开/私有访问规则同上。

### `GET /api/files/:id/download`

文件流式下载，`Content-Disposition` 含 UTF-8 文件名。Bundle 以 ZIP 形式下载。

### `GET /api/files/:id/asset/*`

Bundle 资源文件访问（带路径穿越校验）。

### `POST /api/files/:id/overwrite` — multipart

预览页专用覆盖上传，自动把旧版本备份到 `file_versions`。

### `POST /api/files/:id/overwrite-json` — JSON

MCP 使用的 JSON 覆盖上传，自动版本备份。

### `GET /api/files/:id/stats`

返回文件访问统计：`{viewCount, daily7, daily30}`。`viewCount` 含未回写的缓冲值，保证读一致。

### `GET /s/:key`

短链接渲染页面。通过 `share_key` 查找文件并渲染，公开文件无需登录。访问计数累积到内存缓冲，每 30s 批量回写。

### 版本历史

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/files/:id/versions` | GET | 版本历史列表 |
| `/api/files/:id/versions/:ver/content` | GET | 历史版本原文 |
| `/api/files/:id/versions/:ver/render` | GET | 渲染历史版本 |
| `/api/files/:id/versions/:ver/restore` | POST | 恢复到指定版本 |
| `/api/files/:id/versions/:ver` | DELETE | 删除指定历史版本 |

---

## 标签

### `GET /api/tags`

列出所有标签及其关联文件数量。需登录。

```json
{ "tags": [{ "id": 1, "name": "报告", "file_count": 3 }] }
```

### `POST /api/tags`

创建标签。若同名标签已存在则返回现有记录。需登录。

- Body: `{ "name": "Q3" }`
- 返回: `{ "id": 2, "name": "Q3" }`

### `DELETE /api/tags/:id`

删除标签（同时清除所有文件的该标签关联）。需登录。

### `PUT /api/files/:id/tags`

替换文件的标签列表。需登录。

- Body: `{ "tagIds": [1, 2, 3] }`
- 返回: `{ "success": true, "tags": [{ "id": 1, "name": "报告" }] }`

---

## 收藏

### `POST /api/files/:id/star`

收藏文件。需登录。重复收藏不报错。

### `DELETE /api/files/:id/star`

取消收藏。需登录。

---

## 分类

### `GET /api/categories`

列出当前用户的分类及其文件数量。需登录。

```json
{ "categories": [{ "id": 1, "name": "工作", "file_count": 5 }] }
```

### `POST /api/categories`

创建分类。需登录。

- Body: `{ "name": "学习" }`
- 返回: `{ "id": 2, "name": "学习" }`

### `PUT /api/categories/:id`

重命名分类。**仅 admin**。

- Body: `{ "name": "新名称" }`

### `DELETE /api/categories/:id`

删除分类。文件自动变为未分类（`category_id = NULL`）。**仅 admin**。

### `PUT /api/files/:id/category`

设置文件的分类。需登录（仅 admin 或文件所有者）。

- Body: `{ "categoryId": 1 }` 或 `{ "categoryId": null }`（移除分类）

---

## 用户管理（仅 admin）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/users` | GET | 列出所有用户（含 email） |
| `/api/users` | POST | 创建用户 `{username, password, role, email?}` |
| `/api/users/:id` | PUT | 更新用户名/邮箱/角色或重置密码 |
| `/api/users/:id` | DELETE | 删除用户（不可删自己，文件转交 admin） |

## API Token

每用户最多 10 个，格式 `jp_` + 32 位 base62，DB 存 SHA-256 哈希 + 前 8 位前缀，明文仅创建时返回一次。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/tokens` | GET | 列出自己的 Token |
| `/api/tokens` | POST | 创建 Token `{name}`（明文仅返回一次） |
| `/api/tokens/:id` | DELETE | 删除 Token（自己的或 admin 删任意） |

## 内容模板（Content Templates）

内容模板市场：用户上架 HTML/Markdown 作品 → 管理员审核 → 审核通过且展示的模板才进入市场。

| 端点 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/content-templates/market` | GET | 匿名 | 市场列表（仅 approved+visible+分类启用）。支持 category/keyword/fileType/sort/page/limit |
| `/api/content-templates/market/:id` | GET | 匿名 | 市场详情（仅 approved+visible） |
| `/api/content-templates/market/:id/preview` | GET | 匿名 | 市场预览内容（iframe 缩略图/详情页） |
| `/api/content-templates/categories` | GET | 匿名 | 启用中的分类列表 |
| `/api/content-templates/mine` | GET | 登录 | 我的模板（所有状态）。支持 status/page/limit |
| `/api/content-templates` | POST | 登录 | 提交模板（默认进入 pending 审核） |
| `/api/content-templates/:id` | GET | 登录 | 模板详情（作者/管理员，或 approved+visible） |
| `/api/content-templates/:id/content` | GET | 登录 | 模板原文（作者/管理员，或 approved+visible） |
| `/api/content-templates/:id` | PUT | 登录 | 编辑模板（作者；approved/rejected 编辑后回退 pending） |
| `/api/content-templates/:id` | DELETE | 登录 | 归档模板（软删除为 archived，作者或管理员） |
| `/api/content-templates/:id/use` | POST | 登录 | 使用计数（仅 approved+visible 生效） |
| `/api/content-templates/:id/review` | POST | admin | 审核（status=approved/rejected + 可选 visibility + reviewNote） |
| `/api/content-templates/:id/admin` | PATCH | admin | 运营配置（categoryId/visibility/featured/sortOrder） |
| `/api/content-templates/admin/list` | GET | admin | 全量查询（支持 status/visibility/categoryId/keyword/uploaderId） |
| `/api/content-templates/admin/:id/content` | GET | admin | 任意状态模板内容 |
| `/api/content-templates/admin/categories` | GET/POST | admin | 分类列表（含禁用）/ 新增分类 |
| `/api/content-templates/admin/categories/:id` | PUT/DELETE | admin | 编辑分类 / 删除（有模板则改为停用） |

模板状态：`draft` / `pending`（待审核）/ `approved`（通过）/ `rejected`（拒绝）/ `archived`（归档）。
市场展示条件：`status='approved' AND visibility='visible' AND 分类 is_enabled=1`。

> 另有 `GET /api/templates`（样式模板，渲染皮肤），区别于本内容模板市场。

## 管理后台（仅 admin）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/admin/export` | GET | 导出数据库为备份 |
| `/api/admin/import` | POST | 导入备份（替换连接后重新 `configureDatabase()`） |
| `/api/admin/stats` | GET | 系统统计 |

---

## Skills（AI 技能包）

技能包是与 jpage MCP server 配套的 [Claude Code / Claude Desktop Skill](https://modelcontextprotocol.io) 仓库。Web UI 的"AI 技能"区域支持浏览与下载。

- `GET /api/skills` — 列出 `skills/*/SKILL.md` 中的所有 skill
- `GET /api/skills/:name` — 返回 skill 详情（含 SKILL.md 正文 + 文件清单）
- `GET /api/skills/:name/download` — 打包整个 skill 目录为 zip 返回

| 项 | 值 |
|---|---|
| 鉴权 | session cookie **或** Bearer token（与 `/mcp` 共享 `MCP_TOKEN`） |
| 数据源 | 仓库内 `skills/<name>/SKILL.md` 及其同目录文件 |
| SKILL.md 解析 | 读取 YAML frontmatter（`name` / `description` / `version` / `author`），缺失 `name` 时回退到目录名 |
| zip 库 | `archiver@7`（流式打包） |

### `GET /api/skills`

```bash
curl -b jpage.sid http://localhost:8858/api/skills
```

```json
{
  "skills": [
    {
      "name": "jpage-upload",
      "title": "jpage-upload",
      "description": "将 HTML / Markdown 字符串上传到本地 jpage 服务…",
      "version": "",
      "author": "",
      "fileCount": 1,
      "totalSize": 3094
    }
  ]
}
```

### `GET /api/skills/:name`

```bash
curl -b jpage.sid http://localhost:8858/api/skills/jpage-upload
```

返回：`{name, title, description, version, author, fileCount, totalSize, files: [...], body: "<SKILL.md 正文 markdown>"}`

### `GET /api/skills/:name/download`

```bash
curl -b jpage.sid -OJ http://localhost:8858/api/skills/jpage-upload/download
```

下载 `jpage-upload.zip`，解压后是完整的 skill 目录（顶层目录名为 skill 名），可直接复制到 `~/.claude/skills/`。

---

## MCP 端点（`/mcp`）

独立的 MCP Streamable HTTP 端点。**全局 `MCP_TOKEN` 或用户级 API Token 任一即可挂载**（未配置任何 Token 时 `/mcp` 禁用）。

| 项 | 值 |
|---|---|
| 路径 | `POST`/`GET`/`DELETE` `/mcp` |
| 鉴权 | `Authorization: Bearer <MCP_TOKEN>`（全局，向后兼容）**或** 用户级 API Token（`jp_xxx`） |
| 协议 | MCP Streamable HTTP（最新规范） |
| 工具（15 个） | `list_files` / `upload_file` / `get_file_content` / `delete_file` / `rename_file` / `get_file_url` / `list_file_versions` / `restore_file_version` / `list_tags` / `add_tags_to_file` / `star_file` / `unstar_file` / `list_categories` / `create_category` / `set_file_category` |
| 资源 | `jpage://files` / `jpage://file/{id}`（≤ 256KB） |

工具和资源**不走 `fetch('http://127.0.0.1:port/...')` 自调用**，而是通过 `lib/dispatch.js` 的进程内分发器直接调用 `app.handle()`，复用同一 Bearer token。绕过 TCP 序列化与二次鉴权 DB 查询（单次调用约快 80%），同时权限、限流、审计与 HTTP 完全一致。

完整 schema 可在 Claude Desktop / Claude Code 连接后查看，或通过 `npx @modelcontextprotocol/inspector http://localhost:8858/mcp` 调试。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8858` | HTTP 监听端口 |
| `NODE_ENV` | `development` | `production` 时强制要求 `SESSION_SECRET`，Cookie 仅 HTTPS 下发送 |
| `SESSION_SECRET` | 随机生成（开发） | session 签名密钥。生产必设 |
| `JPAGE_DATA_DIR` | `./data` | 数据目录（数据库、会话、上传文件） |
| `ADMIN_USER` | `admin` | 启动时若 users 表为空，自动创建该用户名的管理员 |
| `ADMIN_PASSWORD` | — | 管理员密码（≥ 8 位）。留空则自动生成 16 位随机密码并打到启动日志 |
| `MCP_TOKEN` | — | 全局 `/mcp` Bearer token（可选）。**未设置时仍可用用户级 API Token 访问 `/mcp`** |
| `MCP_IP` | `localhost` | `/mcp` 对外暴露的 IP/主机名（用于启动日志和 `.mcp.json` 中的 URL） |
| `ALLOW_REGISTRATION` | `false` | 设为 `true` 开放用户自助注册 |
| `SMTP_HOST` 等 | — | SMTP 配置（`SMTP_HOST/PORT/SECURE/USER/PASS/FROM`），用于邮箱验证 |
| `APP_URL` | `http://localhost:8858` | 应用外部访问地址，用于拼接验证链接 |
