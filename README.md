# 即页

> 拖入文件，即刻成页。

**[>>> 查看即页产品介绍 <<<](http://jpage.code2rich.com/api/files/4/render)**

**即页**是一个零配置的 HTML / Markdown 即时预览与分享工具。把写好的文档拖进来，立刻获得一个干净的在线页面——无需部署流程，无需服务器知识。特别适合 AI 生成内容的一键分享。

---

## 功能特性

### 核心能力

- **即时预览** — 上传 HTML 或 Markdown 文件，秒级生成在线渲染页面
- **Markdown 增强渲染** — 代码高亮（highlight.js）、数学公式（KaTeX）、Mermaid 图表，深色/浅色主题自动切换
- **源码查看** — 渲染 / 源码双模式切换，方便对照
- **文件管理** — 重命名、删除、下载、公开/私有切换，操作简单直观
- **拖拽上传** — 支持点击选择和拖拽两种方式，单文件最大 50MB
- **响应式设计** — 桌面端与移动端自适应，深色模式自动跟随系统

### 安全与权限

- **单管理员鉴权** — 会话 Cookie + bcrypt 密码哈希，登录后可管理全部文件
- **公开/私有文件** — 上传时可选是否公开，私有文件仅管理员可访问
- **API 限流** — 登录和上传接口均有频率限制，防止暴力破解和滥用

### AI 集成

- **MCP 协议支持** — 内置 MCP Streamable HTTP 端点，AI 工具可直接调用
- **Skills 管理** — 自动发现 `skills/` 目录下的 Claude Code/Desktop 技能包
- **JSON 上传接口** — `/api/files/upload-json` 支持程序化上传，适合 AI 工作流

### 部署

- **零依赖运行** — 单容器即可启动，SQLite 内置存储
- **Docker 一键部署** — 多阶段构建，环境变量配置，数据卷持久化

## 技术栈

- **后端**: Node.js + Express + express-session（SQLite 会话存储）
- **数据库**: SQLite3（零配置，开箱即用）
- **前端**: 原生 JavaScript（无框架依赖）
- **渲染**: marked.js + highlight.js + KaTeX + Mermaid
- **协议**: MCP Streamable HTTP（@modelcontextprotocol/sdk）
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

即页内置 [MCP Streamable HTTP](https://modelcontextprotocol.io) 端点，让 Claude Code、Claude Desktop 等 AI 工具能够直接上传、管理文件。

### 启用

设置 `MCP_TOKEN` 环境变量即可启用：

```bash
MCP_TOKEN=your-secret-token
```

### 客户端配置

**Claude Code** — 把以下配置放到项目根 `.mcp.json` 或合并到 `~/.claude.json`：

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

**Claude Desktop** — 把 `mcpServers` 块合并到 `~/Library/Application Support/Claude/claude_desktop_config.json`。

### 能力

**Tools**（6 个）：

| 工具 | 用途 |
|---|---|
| `upload_file` | 上传 HTML 或 Markdown，返回预览链接 |
| `list_files` | 列出所有文件 |
| `get_file_content` | 读取文件原文 |
| `get_file_url` | 获取文件预览 URL |
| `rename_file` | 重命名文件 |
| `delete_file` | 删除文件 |

**Resources**（2 个）：

| URI | 说明 |
|---|---|
| `jpage://files` | 所有文件元数据（JSON 列表） |
| `jpage://file/{id}` | 单文件正文（≤ 256KB） |

### 配套 Skill

仓库内 `skills/jpage-upload/SKILL.md` 是 Claude Code / Desktop 的开箱即用技能。安装后，AI 生成 HTML、Markdown、报告、可视化等内容时会自动上传到即页并返回预览链接。

```bash
ln -s "$(pwd)/skills/jpage-upload" ~/.claude/skills/jpage-upload
```

### Web 管理

登录后首页底部有 **AI 技能 (Skills)** 区块，可查看详情、下载 zip 包。新增 Skill 只需在 `skills/<name>/SKILL.md` 编写 frontmatter，重启服务即可自动发现。

### 调试

```bash
npx -y @modelcontextprotocol/inspector http://localhost:8858/mcp
```

完整 API 文档见 [docs/api.md](docs/api.md)。

## 使用场景

- **AI 生成内容分享** — Claude Code、Cursor 等工具生成的 HTML 报告、可视化页面，一键上传获得可分享链接
- **技术文档协作** — Markdown 笔记、会议纪要、项目报告，上传后自动渲染代码高亮、数学公式、流程图
- **静态页面托管** — 单页 HTML Demo、原型、落地页，无需配置服务器
- **临时文件分享** — 任何 HTML/Markdown 文件，拖入即得链接，无需注册账号

## 为什么做这个

现有的方案要么太重（需要配置服务器、域名、CI），要么太封闭（绑定特定平台）。

即页只想做一件事：让静态内容的分享回归简单。拖入文件，得到一个链接。没有账户体系，没有学习成本，打开即用。

## 协议

MIT
