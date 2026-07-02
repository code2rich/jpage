# 即页 uTools 插件

在 uTools 中登录即页服务器，直接管理你的 HTML / Markdown 文件——搜索、上传、预览、分享、版本历史、标签分类。

## 功能

| 分类 | 能力 |
|---|---|
| 🔐 登录 | 配置远程服务器地址 + 账号密码登录（用户名或邮箱），默认服务器 `https://jpage.cn`，session 自动持久化，下次进入免登录 |
| 📋 文件列表 | 分页、按更新/创建时间/名称/大小排序、按标签/分类/收藏筛选 |
| 🔍 搜索 | 文件名 + 全文内容搜索（走即页 FTS5 全文索引） |
| ⬆ 上传 | 选择本地 `.html`/`.md`/`.zip` 文件上传；或粘贴 HTML/Markdown 文本新建 |
| 👁 文件操作 | 预览（短链 `/s/:key`）、复制分享链接、下载、重命名、切换公开/私有、删除（带确认） |
| ⭐ 收藏 | 一键收藏/取消收藏 |
| ⏱ 版本历史 | 查看历史版本、恢复到任意历史版本（自动备份当前版本） |
| 🏷 标签 | 查看全部标签、给文件打标签、新建标签 |
| 📁 分类 | 查看分类、给文件归类 |

## 鉴权说明

插件使用**用户名/密码登录**走即页的 **session-cookie 鉴权**（cookie 名 `jpage.sid`，7 天有效），与网页端登录完全一致。

> **不使用 token**：token（`MCP_TOKEN` / 用户级 API Token）是给 AI / MCP 用的另一条独立鉴权链路，插件不涉及。

**为什么所有网络请求都在 `preload.js`（Node 侧）发出？**
即页服务端的 CORS 设置是 `Access-Control-Allow-Origin: *`，但**没有** `Access-Control-Allow-Credentials: true`，浏览器侧 `fetch` 无法跨域携带 cookie。而 session 鉴权必须带 cookie，所以请求统一由 preload 用 Node 原生 `http`/`https` + 自带 cookie jar 发出，绕开浏览器 CORS 限制。

## 项目结构

```
plugin-workspace/
├── plugin.json          # uTools 插件清单（features / main / preload）
├── preload.js           # Node 侧 API 客户端 + cookie jar + 会话持久化
├── logo.png             # 插件图标
├── index.html           # 单页应用（登录视图 + 主视图）
├── css/style.css        # 样式（跟随系统深浅色）
├── js/
│   ├── util.js          # 工具函数（格式化 / toast / 模态框 / 确认框）
│   ├── login.js         # 登录 / 服务器配置逻辑
│   ├── upload.js        # 上传弹窗（本地文件 / 粘贴文本）
│   ├── detail.js        # 文件详情弹窗（版本 / 标签 / 分类 / 删除）
│   └── app.js           # 主逻辑（列表 / 搜索 / 分页 / 筛选 + 入口编排）
├── pack.sh              # 打包脚本
└── dist/                # 打包产物（pack.sh 生成）
```

**零第三方依赖**：`preload.js` 只用 Node 内置模块（`http`/`https`/`url`/`fs`/`path`），打包成 `.upx` 无需 bundle `node_modules`。

## 开发调试

### 方式一：加载未打包目录（推荐，支持热改）

1. 打开 **uTools 开发者工具**（uTools 内右键 → 开发者工具，或单独下载）
2. 新建插件 → 「加载未打包插件」→ 选择 `dist/jpage-utools/` 目录（先跑一次 `./pack.sh --dir` 生成）
3. 开发时直接改源文件，在开发者工具里点「刷新」即可生效

```bash
./pack.sh --dir    # 生成 dist/jpage-utools/ 目录
```

### 方式二：安装打包好的 .upx

```bash
./pack.sh          # 生成 dist/jpage-utools-<version>.upx
```

双击 `.upx` 即可安装到 uTools。

## 使用

1. 在 uTools 主搜索框输入 **「即页」**（或 `jpage`）进入插件
2. 首次使用：服务器地址默认已填 `https://jpage.cn`（可修改），输入**账号** + **密码** → 登录
3. 之后进入插件会自动恢复登录态；会话过期（7 天）会自动跳回登录页
4. 需要清空本地缓存（服务器地址、账号、登录状态）时，在登录页点击「清空缓存」
5. 在主界面搜索、上传、管理文件

## 调用即页的 API

插件通过 `window.jpage`（preload 注入）调用以下接口（全部 `/api` 前缀，session 鉴权）：

| 域 | 端点 |
|---|---|
| 认证 | `auth/login`, `auth/me`, `auth/logout`, `auth/change-password`, `auth/profile` |
| 配置 | `jpage.getConfig`, `jpage.setBase`, `jpage.clearCache` |
| 文件 | `files`（列表/搜索/分页）, `files/upload`（multipart）, `files/upload-json`, `files/:id`（详情/改/删）, `files/:id/content`, `files/:id/overwrite`, `files/:id/versions`, `files/:id/tags`, `files/:id/star`, `files/:id/category` |
| 标签 | `tags`（增/查）, `tags/:id`（删） |
| 分类 | `categories`（增/查）, `categories/:id`（改/删） |

## 配套的即页服务器

插件需要一个运行中的即页服务器。部署见即页主项目（`@code2rich/jpage`）。本地开发可快速起一个：

```bash
ADMIN_USER=admin ADMIN_PASSWORD=admin12345 \
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
PORT=8858 node node_modules/@code2rich/jpage/server.js
```
