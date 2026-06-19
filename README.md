# 即页

> 拖入文件，即刻成页。

[![CI](https://github.com/code2rich/jpage/actions/workflows/ci.yml/badge.svg)](https://github.com/code2rich/jpage/actions/workflows/ci.yml)

[English](README_EN.md) | 中文

**即页**是一个零配置的 HTML / Markdown 即时预览与分享工具。把写好的文档拖进来，立刻获得一个干净的在线页面——无需部署流程，无需服务器知识。特别适合 AI 生成内容的一键分享。

---

## 功能特性

### 核心能力

- **即时预览** — 上传 HTML 或 Markdown 文件，秒级生成在线渲染页面
- **Markdown 增强渲染** — 代码高亮（highlight.js）、数学公式（KaTeX）、Mermaid 图表，深色/浅色主题自动切换
- **源码查看** — 渲染 / 源码双模式切换，方便对照
- **短链接** — 每个文件自动生成 8 位短链（`/s/xxxxxxxx`），分享更简洁
- **文件管理** — 重命名、删除、下载、公开/私有切换，操作简单直观
- **拖拽上传** — 支持点击选择和拖拽两种方式，单文件最大 50MB
- **版本历史** — 覆盖上传自动保留历史版本，可随时回滚
- **响应式设计** — 桌面端与移动端自适应，深色模式自动跟随系统

### 组织与发现

- **标签系统** — 为文件打标签，多维度分类检索
- **分类管理** — 创建分类归属文件，层级清晰
- **收藏功能** — 一键收藏常用文件，快速访问

### 安全与权限

- **多用户支持** — admin 可创建和管理多个用户，普通用户只能访问自己的文件和公开文件
- **开放注册** — 通过 `ALLOW_REGISTRATION=true` 开放用户自助注册，配合 SMTP 实现邮箱验证
- **会话鉴权** — Cookie + bcrypt 密码哈希
- **API Token** — 每用户可创建多个 API Token，适合脚本和 AI 工具调用
- **公开/私有文件** — 上传时可选是否公开，私有文件仅文件所有者和 admin 可访问
- **API 限流** — 登录和上传接口均有频率限制，防止暴力破解和滥用

### AI 集成

- **MCP 协议支持** — 内置 MCP Streamable HTTP 端点，AI 工具可直接调用
- **Skills 管理** — 自动发现 `skills/` 目录下的 Claude Code/Desktop 技能包
- **JSON 上传接口** — `/api/files/upload-json` 支持程序化上传，适合 AI 工作流

### 部署

- **零依赖运行** — 单容器即可启动，SQLite 内置存储
- **Docker 一键部署** — 多阶段构建，环境变量配置，数据卷持久化
- **数据库迁移** — 自动执行 schema 迁移，升级无需手动操作

## 技术栈

- **后端**: Node.js + Express + express-session（SQLite 会话存储），按域拆分的 Router 架构（routes/ + lib/ 共享层）
- **数据库**: SQLite3（零配置，自动迁移）
- **前端**: 原生 JavaScript（无框架依赖）
- **渲染**: marked.js + highlight.js + KaTeX + Mermaid
- **安全**: helmet + 分级 CSP（管理界面严格策略，渲染页 iframe sandbox 隔离 + 内容分级 CSP）
- **协议**: MCP Streamable HTTP（@modelcontextprotocol/sdk）
- **测试**: node:test + supertest（单元 + 集成），GitHub Actions CI
- **容器**: Docker / Docker Compose

## 快速开始

### Docker 部署（推荐）

```bash
git clone https://github.com/code2rich/jpage.git
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

### 开发与测试

```bash
npm test            # 单元 + 集成测试（node:test + supertest）
npm run test:unit   # 仅单元测试
npm run build       # 构建前端产物（esbuild → public/dist）
```

端到端 / 性能基准（需先 `=8000# npm start= 起服务）：

```bash
node test/perf-harness.js 8858   # 核心流程 e2e（登录/上传/渲染/短链/标签）
node test/mcp-harness.js 8858    # MCP 端点
node test/perf-bench.js 8858     # 渲染/列表/缓存延迟基准
```

### CLI 工具（npm 包已发布）

即页随包提供 `jpage` 命令行工具，可通过 REST API 上传 / 列出 / 管理文件，对大文件和 ZIP 走 multipart 二进制流式上传（比 MCP 的 base64 进 token 流更快更省）：

```bash
npm install -g @code2rich/jpage
jpage upload ./report.html --public --token <你的 token>
jpage ls --kw 季度
jpage cat 8
jpage --help
```

`jpage` 与 MCP 是对称的两个客户端入口，都架在同一套 REST API 之上。详见 `jpage --help`。

### 发版

维护者发版指南（含 GitHub Actions 自动发版配置、token 轮换、故障排查）见 [`docs/RELEASING.md`](docs/RELEASING.md)。

## 鉴权与安全

即页支持多用户体系。admin 可管理全部用户和文件，普通用户只能操作自己的文件和公开文件。

**内容安全（CSP）**：通过 helmet + 分级策略加固——管理界面下发严格 CSP（仅放行同源 script），用户内容渲染页用 iframe sandbox（无 `allow-same-origin`，阻断对父窗口的访问）隔离，其中 Markdown 页套严格 CSP（内联 mermaid 脚本靠 nonce 放行），HTML 页用宽松 CSP + sandbox 兜底（用户 HTML 常含合法 script）。分享链接（`/api/files/:id/render`、`/s/:key`、下载、源码）在文件标记为公开时可匿名访问；上传时取消勾选「公开访问」可让该文件仅所有者和 admin 可见。

### 认证方式

API 和 MCP 端点支持三种认证方式：

1. **Session Cookie** — 登录后获得 `jpage.sid`，适合浏览器访问
2. **API Token** — 用户在设置中创建 `jp_` 前缀的 Token，适合脚本调用
3. **MCP Token** — 环境变量 `MCP_TOKEN`，适合 AI 工具连接（向后兼容）

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ADMIN_USER` | 否 | 首次启动、users 表为空时使用的管理员用户名；留空默认 `admin` |
| `ADMIN_PASSWORD` | 否 | 首次启动、users 表为空时使用的管理员密码（≥8 位）；留空则自动生成 16 位随机密码并打到启动日志 |
| `SESSION_SECRET` | 生产必填 | 加密会话 Cookie；缺失时开发模式自动生成临时密钥，重启会失效 |
| `NODE_ENV` | 否 | `production` 时 Cookie 仅 HTTPS 下发送，SESSION_SECRET 缺失会拒绝启动 |
| `PORT` | 否 | 默认 8858 |
| `MCP_TOKEN` | 否 | `/mcp` 端点的全局 Bearer token（向后兼容）；未设置时仍可用用户级 API Token（`jp_` 前缀）访问 MCP |
| `ALLOW_REGISTRATION` | 否 | 设为 `true` 开放用户自助注册；默认关闭，仅 admin 可创建用户 |
| `SMTP_HOST` | 否 | SMTP 服务器地址（如 `smtp.qq.com`），配置后支持邮箱验证 |
| `SMTP_PORT` | 否 | SMTP 端口（如 `465`） |
| `SMTP_SECURE` | 否 | 是否使用 SSL（`true`/`false`） |
| `SMTP_USER` | 否 | SMTP 登录用户名 |
| `SMTP_PASS` | 否 | SMTP 登录密码或授权码 |
| `SMTP_FROM` | 否 | 发件人地址（如 `"即页 <user@example.com>"`） |
| `APP_URL` | 否 | 应用外部访问地址，用于拼接验证链接（如 `https://jpage.cn`） |

如果 `ADMIN_USER` 和 `ADMIN_PASSWORD` 都留空启动，启动日志会输出：

```
[即页] 已创建初始管理员: admin
[即页] 初始密码（请妥善保存）: 7Hk2mN9pq4rTv8wX
[即页] ⚠️  首次登录后请立即修改密码
```

复制日志里的密码登录即可。

`SESSION_SECRET` 推荐生成方式：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 重置或修改密码

所有用户登录后可在设置中修改密码。admin 可在用户管理中重置其他用户密码。

手动方式（SQLite 命令行）：

```bash
node -e "console.log(require('bcryptjs').hashSync('新密码', 10))"
sqlite3 data/database.sqlite "UPDATE users SET password_hash='<上面生成的hash>' WHERE username='admin';"
```

## 项目结构

```
jpage/
├── server.js           # 入口：app 装配 + 中间件 + 启动编排（业务逻辑已拆分）
├── routes/             # 按域拆分的 Express Router
│   ├── auth.js         # 登录/注册/邮箱验证
│   ├── users.js        # 用户管理（admin）
│   ├── tokens.js       # API Token
│   ├── files.js        # 文件 CRUD/上传/渲染/版本/标签/收藏/统计
│   ├── tags.js         # 标签
│   ├── categories.js   # 分类 + 模板元数据
│   ├── content-templates.js  # 内容模板市场
│   ├── admin.js        # 备份导出/导入/统计
│   └── skills.js       # Skills + MCP 配置
├── lib/                # 共享层（被 routes 复用）
│   ├── db.js           # SQLite 访问（dbRun/dbGet/dbAll + PRAGMA）
│   ├── paths.js        # 数据/上传目录常量
│   ├── util.js         # now/shareKey/clientIp/decodeFilename 等纯函数
│   ├── csp.js          # 分级 CSP 策略 + nonce
│   ├── auth-state.js   # adminUserId 共享状态
│   ├── templates.js    # 模板系统 + marked/hljs/KaTeX 渲染管线
│   ├── render.js       # 文件 → HTML 渲染（含 CSP 下发）
│   ├── render-cache.js # 渲染结果 LRU 缓存
│   ├── fts.js          # FTS5 全文索引
│   ├── categories.js   # 分类名内存缓存
│   ├── view-counts.js  # 浏览数缓冲批量回写
│   ├── zip.js          # ZIP 上传（安全校验/解压/分类）
│   ├── dispatch.js     # MCP 进程内请求分发（绕过 TCP 自调用）
│   └── middleware/     # 鉴权 + 文件加载中间件
├── logger.js           # 结构化 JSON Lines 日志
├── mailer.js           # SMTP 邮件（验证码/验证链接）
├── mcp-server.js       # MCP Streamable HTTP 端点（/mcp）
├── migrations.js       # 数据库迁移 runner
├── migrations/         # 按序执行的 schema 迁移文件（001-012）
├── skills-registry.js  # 扫描 skills/ 目录，提供 skill 列表/详情/zip 打包
├── templates/          # Markdown 渲染样式模板（default/github/academic/dark-pro）
├── package.json
├── build.js            # esbuild 打包前端 → public/dist
├── Dockerfile
├── docker-compose.yml
├── .env.example        # 环境变量示例
├── .mcp.json           # MCP 客户端配置示例
├── docs/
│   ├── api.md          # REST API 完整参考
│   └── design/         # 设计文档
├── skills/
│   └── jpage-upload/   # Claude Code / Desktop skill
│       └── SKILL.md
├── test/               # 单元 + 集成测试（node:test + supertest）+ e2e harness
├── data/               # SQLite 数据库、上传文件与会话存储（运行时自动创建）
└── public/             # 前端静态资源
    ├── index.html
    ├── css/style.css
    ├── js/             # 按页拆分的 ES 模块
    └── dist/           # 构建产物（npm run build 生成，git 忽略）
```

## REST API

端口 `8858`（`PORT` 可覆盖）。所有写入端点要求登录或 Bearer token。完整参考见 [docs/api.md](docs/api.md)。

### 鉴权

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/auth/me` | GET | 当前登录信息（返回 `{id, username, email, emailVerified, role}`） |
| `/api/auth/login` | POST | 登录（`{account, password}` 或 `{username, password}`，自动识别用户名或邮箱） |
| `/api/auth/register` | POST | 注册（需 `ALLOW_REGISTRATION=true`） |
| `/api/auth/logout` | POST | 登出 |
| `/api/auth/change-password` | POST | 修改密码（所有用户可用） |
| `/api/auth/profile` | POST | 编辑个人资料（用户名/邮箱） |
| `/api/auth/send-register-code` | POST | 发送注册验证码（需开放注册） |
| `/api/auth/verify-email` | GET | 验证邮箱 token |
| `/api/auth/smtp-status` | GET | SMTP 是否已配置 |
| `/api/auth/registration-status` | GET | 注册是否开放 |

### 用户管理（仅 admin）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/users` | GET | 列出所有用户 |
| `/api/users` | POST | 创建用户 |
| `/api/users/:id` | PUT | 更新角色或重置密码 |
| `/api/users/:id` | DELETE | 删除用户，文件转交 admin |

### API Token

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/tokens` | GET | 列出自己的 Token |
| `/api/tokens` | POST | 创建 Token（明文仅返回一次） |
| `/api/tokens/:id` | DELETE | 删除 Token |

### 文件管理

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/files` | GET | 列出文件（admin 看全部，普通用户看自己的 + 公开的） |
| `/api/files/search` | GET | 全文 + 文件名搜索（分页、过滤） |
| `/api/files/upload` | POST | multipart 上传（支持 `.html`/`.htm`/`.md`/`.markdown`/`.zip`，50MB） |
| `/api/files/upload-json` | POST | JSON 上传（`{name, content, isPublic?}`） |
| `/api/files/batch` | POST | 批量操作（删除/公开/私有/分类，≤200） |
| `/api/files/:id` | GET | 单文件元数据 |
| `/api/files/:id` | PUT | 重命名或切换公开/私有 |
| `/api/files/:id` | DELETE | 删除文件 |
| `/api/files/:id/content` | GET | 返回原始文本 |
| `/api/files/:id/render` | GET | 返回渲染后 HTML |
| `/api/files/:id/download` | GET | 流式下载文件（Bundle 以 ZIP 下载） |
| `/api/files/:id/asset/*` | GET | Bundle 资源文件访问 |
| `/api/files/:id/overwrite` | POST | 覆盖上传（自动版本备份） |
| `/api/files/:id/versions` | GET | 版本历史列表 |
| `/api/files/:id/versions/:ver/restore` | POST | 恢复到指定版本 |
| `/api/files/:id/stats` | GET | 访问统计（viewCount/daily7/daily30） |
| `/s/:key` | GET | 短链接渲染页面 |

### 标签

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/tags` | GET | 列出所有标签（含 file_count） |
| `/api/tags` | POST | 创建标签 |
| `/api/tags/:id` | DELETE | 删除标签 |
| `/api/files/:id/tags` | PUT | 替换文件的标签列表 |

### 收藏

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/files/:id/star` | POST | 收藏文件 |
| `/api/files/:id/star` | DELETE | 取消收藏 |

### 分类

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/categories` | GET | 列出分类（含 file_count） |
| `/api/categories` | POST | 创建分类 |
| `/api/categories/:id` | PUT | 重命名分类（仅 admin） |
| `/api/categories/:id` | DELETE | 删除分类（仅 admin） |
| `/api/files/:id/category` | PUT | 设置文件分类 |

### 内容模板

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/content-templates/public` | GET | 公开模板列表（无需登录） |
| `/api/content-templates` | GET | 当前用户模板列表 |
| `/api/content-templates` | POST | 创建模板 |
| `/api/content-templates/:id` | PUT/DELETE | 更新/删除模板（仅所有者） |
| `/api/content-templates/:id/use` | POST | 基于模板创建文件 |
| `/api/templates` | GET | 样式模板（渲染皮肤） |

### 管理后台（仅 admin）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/admin/export` | GET | 导出数据库备份 |
| `/api/admin/import` | POST | 导入备份 |
| `/api/admin/stats` | GET | 系统统计 |

### Skills

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/skills` | GET | 列出已安装的 skill 包 |
| `/api/skills/:name` | GET | skill 详情 |
| `/api/skills/:name/download` | GET | ZIP 下载整个 skill 目录 |

完整 API 文档见 [docs/api.md](docs/api.md)。

## MCP / AI 集成

即页内置 [MCP Streamable HTTP](https://modelcontextprotocol.io) 端点，让 Claude Code、Claude Desktop 等 AI 工具能够直接上传、管理文件。

### 启用

设置全局 `MCP_TOKEN` 环境变量，或使用任意用户级 API Token（`jp_` 前缀）即可启用 `/mcp`。两者二选一：

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

**Tools**（15 个）：

| 工具 | 用途 |
|---|---|
| `upload_file` | 上传 HTML 或 Markdown，返回预览链接 |
| `list_files` | 列出所有文件 |
| `get_file_content` | 读取文件原文 |
| `get_file_url` | 获取文件预览 URL |
| `rename_file` | 重命名文件 |
| `delete_file` | 删除文件 |
| `list_file_versions` | 查看文件版本历史 |
| `restore_file_version` | 回滚到指定版本 |
| `list_tags` | 列出标签 |
| `add_tags_to_file` | 为文件添加标签 |
| `star_file` | 收藏文件 |
| `unstar_file` | 取消收藏 |
| `list_categories` | 列出分类 |
| `create_category` | 创建分类 |
| `set_file_category` | 设置文件分类 |

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

## 使用场景

- **AI 生成内容分享** — Claude Code、Cursor 等工具生成的 HTML 报告、可视化页面，一键上传获得可分享链接
- **技术文档协作** — Markdown 笔记、会议纪要、项目报告，上传后自动渲染代码高亮、数学公式、流程图
- **静态页面托管** — 单页 HTML Demo、原型、落地页，无需配置服务器
- **临时文件分享** — 任何 HTML/Markdown 文件，拖入即得链接，无需注册账号
- **版本管理** — 迭代更新的文档自动保留历史版本，随时回滚

## 为什么做这个

现有的方案要么太重（需要配置服务器、域名、CI），要么太封闭（绑定特定平台）。

即页只想做一件事：让静态内容的分享回归简单。拖入文件，得到一个链接。支持可选的多用户体系，但默认开箱即用——拖入文件即得链接，匿名也能分享公开文件，无需注册。

## 协议

MIT
