# 即页

> 拖入文件，即刻成页。

**即页**是一个零配置的 HTML / Markdown 即时预览与分享工具。把写好的文档拖进来，立刻获得一个干净的在线页面——无需部署流程，无需服务器知识。

---

## 功能特性

- **即时预览** — 上传 HTML 或 Markdown 文件，秒级生成在线渲染页面
- **源码查看** — 渲染 / 源码双模式切换，方便对照
- **文件管理** — 重命名、删除、下载、公开/私有切换，操作简单直观
- **拖拽上传** — 支持点击选择和拖拽两种方式，单文件最大 50MB
- **响应式设计** — 桌面端与移动端自适应，深色模式自动跟随系统
- **单管理员鉴权** — 会话 Cookie + bcrypt 密码哈希，登录后可管理全部文件
- **公开/私有文件** — 上传时可选是否公开，私有文件仅管理员可访问
- **零依赖运行** — 单容器即可启动，SQLite 内置存储

## 技术栈

- **后端**: Node.js + Express + express-session（SQLite 会话存储）
- **数据库**: SQLite3（零配置，开箱即用）
- **前端**: 原生 JavaScript（无框架依赖）
- **容器**: Docker / Docker Compose

## 快速开始

### Docker 部署（推荐）

```bash
git clone https://github.com/yourname/jpage.git
cd jpage
cp .env.example .env       # 编辑 .env 填入 ADMIN_PASSWORD 和 SESSION_SECRET
docker-compose up -d
```

访问 http://localhost:8858，浏览器会跳到登录页。

### 本地运行

```bash
npm install
ADMIN_USER=admin ADMIN_PASSWORD=test1234 SESSION_SECRET=dev-secret npm start
```

开发模式（热重载）：

```bash
npm run dev
```

## 鉴权与安全

即页默认对所有管理接口（上传、删除、重命名、切换公开/私有、文件列表）要求登录。分享链接（`/api/files/:id/render`、下载、源码）在文件标记为公开时仍可匿名访问——这是「分享工具」的核心价值；上传时取消勾选「公开访问」可让该文件仅管理员可见。

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ADMIN_USER` | 否 | 首次启动、users 表为空时使用的管理员用户名；留空默认 `admin` |
| `ADMIN_PASSWORD` | 否 | 首次启动、users 表为空时使用的管理员密码（≥8 位）；留空则自动生成 16 位随机密码并打到启动日志 |
| `SESSION_SECRET` | 生产必填 | 加密会话 Cookie；缺失时开发模式自动生成临时密钥，重启会失效 |
| `NODE_ENV` | 否 | `production` 时 Cookie 仅 HTTPS 下发送，SESSION_SECRET 缺失会拒绝启动 |
| `PORT` | 否 | 默认 8858 |
| `MCP_TOKEN` | 否 | 启用 `/mcp` 端点的 Bearer token；**未设置时 MCP 端点不挂载** |

如果 `ADMIN_USER` 和 `ADMIN_PASSWORD` 都留空启动，启动日志会输出：

```
[即页] 已创建初始管理员: admin
[即页] 初始密码（请妥善保存）: 7Hk2mN9pq4rTv8wX
[即页] ⚠️  首次登录后请立即修改密码
```

复制日志里的密码登录即可。`ADMIN_PASSWORD=changeme` 这类占位符已被「留空生成」取代，部署时无需再改默认值。

`SESSION_SECRET` 推荐生成方式：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 重置或修改密码

清空 `data/database.sqlite` 中的 users 表会触发下次启动时按 `ADMIN_USER/ADMIN_PASSWORD` 重新创建（但同时会清空所有已上传文件记录）：

```bash
rm data/database.sqlite
```

仅修改密码、保留文件，参考下面手动方式（SQLite 命令行）：

```bash
# 生成新 hash
node -e "console.log(require('bcryptjs').hashSync('新密码', 10))"
sqlite3 data/database.sqlite "UPDATE users SET password_hash='<上面生成的hash>' WHERE username='admin';"
```

### 文件公开/私有

- 上传时勾选「公开访问」（默认勾选）→ 任何人可访问分享链接
- 上传时取消勾选 → 仅登录管理员可访问
- 列表项点「设为公开 / 设为私有」可随时切换

## 项目结构

```
jpage/
├── server.js          # Express 服务端（含鉴权与公开/私有判断）
├── mcp-server.js      # MCP Streamable HTTP 端点（/mcp）
├── skills-registry.js # 扫描 skills/ 目录，提供 skill 列表/详情/zip 打包
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example       # 环境变量示例
├── .mcp.json          # MCP 客户端配置示例
├── docs/
│   └── api.md         # REST API 参考
├── skills/
│   └── jpage-upload/  # Claude Code / Desktop skill
│       └── SKILL.md
├── data/              # SQLite 数据库、上传文件与会话存储
│   ├── database.sqlite
│   ├── sessions.sqlite
│   └── uploads/
└── public/            # 前端静态资源
    ├── index.html
    ├── css/style.css
    └── js/app.js
```

## MCP / AI 集成

即页在同一个 Express 进程里挂载了 [MCP Streamable HTTP](https://modelcontextprotocol.io) 端点 `/mcp`，让 Claude Code / Claude Desktop / 其他 MCP 客户端能够：

- **上传 HTML**（你的核心用例：AI 生成的 HTML 一键变成可分享的预览链接）
- 列出 / 读取 / 重命名 / 删除文件
- 浏览文件元数据（resources）

### 启用

启动时设置 `MCP_TOKEN` 即可启用端点；不设置则端点不挂载（启动日志会提示）：

```bash
MCP_TOKEN=devtoken \
ADMIN_USER=admin \
ADMIN_PASSWORD=test1234 \
SESSION_SECRET=dev-secret \
npm start
```

启动日志应包含：`[即页] MCP 端点已挂载: http://localhost:8858/mcp (Bearer auth)`

### 客户端配置

仓库根的 `.mcp.json` 是示例（已附 `_comment` 字段说明）。把它放到项目根或合并到 `~/.claude.json` 即可被 Claude Code 识别：

```json
{
  "mcpServers": {
    "jpage": {
      "type": "http",
      "url": "http://localhost:8858/mcp",
      "headers": {
        "Authorization": "Bearer ${env.MCP_TOKEN}"
      }
    }
  }
}
```

Claude Desktop 用户把 `mcpServers` 块合并到 `~/Library/Application Support/Claude/claude_desktop_config.json`。

### 暴露的能力

**Tools**（6 个）：

| 工具 | 用途 |
|---|---|
| `upload_file` | 上传 HTML 或 Markdown，返回 `{id, url, ...}`，`url` 是预览链接 |
| `list_files` | 列出所有文件 |
| `get_file_content` | 读取文件原文 |
| `get_file_url` | 仅取文件的预览 URL |
| `rename_file` | 重命名 |
| `delete_file` | 删除 |

**Resources**（2 个）：

| URI | 说明 |
|---|---|
| `jpage://files` | 所有文件元数据（JSON 列表） |
| `jpage://file/{id}` | 单文件正文（仅 ≤ 256KB，超过请改用 `get_file_content` 工具） |

### 上传 HTML 的最小示例

让 Claude（任何 MCP-aware 客户端）执行：

```
调用 upload_file
参数 { name: "demo.html", content: "<!doctype html><h1>Hello</h1>" }
```

返回：

```json
{
  "id": 42,
  "original_name": "demo.html",
  "file_type": "html",
  "size": 28,
  "is_public": 1,
  "url": "http://127.0.0.1:8858/api/files/42/render"
}
```

把 `url` 给用户即可。**注意**：该 URL 默认为 loopback，仅本机可访问；如部署到服务器，请替换 host。

### 配套 Skill

仓库内 `skills/jpage-upload/SKILL.md` 是一个开箱即用的 Claude Code / Desktop skill。安装：

```bash
ln -s "$(pwd)/skills/jpage-upload" ~/.claude/skills/jpage-upload
```

启动 Claude Code 后即会自动加载 jpage MCP 工具。

### 在 Web 页面中管理 Skill

登录 jpage 后，首页底部新增 **AI 技能 (Skills)** 区块：

- 列出 `skills/` 目录下所有可用的 Skill
- 「查看详情」打开弹窗，显示元数据、文件清单、SKILL.md 全文
- 「下载 .zip」直接下载该 Skill 目录的 zip 包

API 端点：`GET /api/skills`、`GET /api/skills/:name`、`GET /api/skills/:name/download`（均需登录或 Bearer token）。

要新增 Skill：在 `skills/<name>/SKILL.md` 创建一个目录，编写 frontmatter（`name` / `description` 可选 `version` / `author`），重启服务即可被自动发现。

### 调试

无图形客户端时，可用官方 inspector：

```bash
npx -y @modelcontextprotocol/inspector http://localhost:8858/mcp
```

会要求填 Bearer token（即 `MCP_TOKEN` 的值）。

### 完整 API 文档

见 [docs/api.md](docs/api.md)。

## 使用场景

- **临时分享文档** — 写完的 Markdown 笔记、HTML 报告，拖进来就能发给同事
- **静态页面托管** — 简单的单页 HTML 演示，无需配置服务器
- **Markdown 预览** — 本地写好 .md 文件，上传后自动渲染为排版精美的页面

## 为什么做这个

现有的方案要么太重（需要配置服务器、域名、CI），要么太封闭（绑定特定平台）。

即页只想做一件事：让静态内容的分享回归简单。拖入文件，得到一个链接。没有账户体系，没有学习成本，打开即用。

## 协议

MIT
