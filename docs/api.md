# 即页 REST API 参考

端口 `8858`（`PORT` 可覆盖）。所有 `/api/files/*` 写入类端点要求登录（session cookie `jpage.sid`）或 MCP Bearer token（`MCP_TOKEN`）。

## 通用说明

| 项 | 值 |
|---|---|
| Base URL | `http://localhost:8858` |
| 内容类型 | 除 `POST /api/files/upload` 外均为 `application/json` |
| 鉴权 | session cookie `jpage.sid`（登录后获得） **或** `Authorization: Bearer ${MCP_TOKEN}`（启动时设置后启用） |
| 字符集 | UTF-8 |
| 文件大小上限 | 50 MB |
| 允许扩展名 | `.html` `.htm` `.md` `.markdown` |
| 上传限流 | 50 req / 15 min / IP（`POST /api/files/upload` 和 `POST /api/files/upload-json`） |
| 登录限流 | 10 req / 15 min / IP（`POST /api/auth/login`） |

---

## 鉴权

### `GET /api/auth/me`

当前登录信息。返回 `{username, isAdmin}` 或 401。

```bash
curl -b jpage.sid=<cookie> http://localhost:8858/api/auth/me
```

### `POST /api/auth/login`

登录。Body: `{username, password}`。成功后写入 session cookie。

```bash
curl -c jpage.sid -X POST http://localhost:8858/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin1234"}'
```

### `POST /api/auth/logout`

销毁 session，清除 cookie。

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

### `POST /api/files/upload` — multipart

传统上传（`multipart/form-data`）。字段：
- `file` — 二进制文件（必填）
- `isPublic` — `true` / `false`（可选，默认 `true`）

```bash
curl -b jpage.sid -X POST http://localhost:8858/api/files/upload \
  -F "file=@report.html" \
  -F "isPublic=true"
```

返回 `{id, original_name, file_type, size, is_public}`。

### `POST /api/files/upload-json` — JSON

新增。**MCP server 调用的入口**，避免构造 multipart。Body:

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

返回同 multipart 端点。`uploaded_by` 自动取 session 用户 id（即 MCP 调用时为 admin 用户）。

```bash
curl -b jpage.sid -X POST http://localhost:8858/api/files/upload-json \
  -H "Content-Type: application/json" \
  -d '{"name":"hello.html","content":"<h1>hi</h1>"}'
```

### `PUT /api/files/:id`

更新文件名或公开性。Body:
- `{name}` — 重命名（trim 后非空）
- `{isPublic}` — 切换公开/私有

至少传一个字段。

```bash
curl -b jpage.sid -X PUT http://localhost:8858/api/files/1 \
  -H "Content-Type: application/json" \
  -d '{"name":"new-name.html"}'
```

### `DELETE /api/files/:id`

删除文件（DB + 磁盘）。返回 `{success: true}`。

### `GET /api/files/:id/content`

返回原始文本。公开文件无需登录，私有文件需 session/token。

```json
{ "id": 1, "original_name": "r.html", "file_type": "html", "is_public": 1, "content": "..." }
```

### `GET /api/files/:id/render`

返回渲染后的 HTML。Markdown 文件走 `marked` 转换并加样式模板；HTML 文件原样返回（自动注入 `<meta charset="UTF-8">`）。公开/私有访问规则同上。

### `GET /api/files/:id/download`

文件流式下载，`Content-Disposition` 含 UTF-8 文件名。

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

独立的 MCP Streamable HTTP 端点。**仅当启动时设置了 `MCP_TOKEN` 时启用**。

| 项 | 值 |
|---|---|
| 路径 | `POST`/`GET`/`DELETE` `/mcp` |
| 鉴权 | `Authorization: Bearer ${MCP_TOKEN}` |
| 协议 | MCP Streamable HTTP（最新规范） |
| 工具 | `list_files` / `upload_file` / `get_file_content` / `delete_file` / `rename_file` / `get_file_url` |
| 资源 | `jpage://files` / `jpage://file/{id}` |

工具和资源通过 loopback `http://127.0.0.1:${PORT}/api/...` 调用 REST API，复用相同 Bearer token。

完整 schema 可在 Claude Desktop / Claude Code 连接后查看，或通过 `npx @modelcontextprotocol/inspector http://localhost:8858/mcp` 调试。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8858` | HTTP 监听端口 |
| `NODE_ENV` | `development` | `production` 时强制要求 `SESSION_SECRET` |
| `SESSION_SECRET` | 随机生成（开发） | session 签名密钥。生产必设 |
| `ADMIN_USER` | — | 启动时若 users 表为空，自动创建该用户名的管理员 |
| `ADMIN_PASSWORD` | — | 管理员密码（≥ 8 位） |
| `MCP_TOKEN` | — | 启用 `/mcp` MCP 端点的 Bearer token。**未设置时 `/mcp` 路由不挂载** |
