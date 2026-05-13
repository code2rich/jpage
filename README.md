# 即页

> 拖入文件，即刻成页。

**即页**是一个零配置的 HTML / Markdown 即时预览与分享工具。把写好的文档拖进来，立刻获得一个干净的在线页面——无需部署流程，无需服务器知识。

---

## 功能特性

- **即时预览** — 上传 HTML 或 Markdown 文件，秒级生成在线渲染页面
- **源码查看** — 渲染 / 源码双模式切换，方便对照
- **文件管理** — 重命名、删除、下载，操作简单直观
- **拖拽上传** — 支持点击选择和拖拽两种方式，单文件最大 50MB
- **响应式设计** — 桌面端与移动端自适应，深色模式自动跟随系统
- **零依赖运行** — 单容器即可启动，SQLite 内置存储

## 技术栈

- **后端**: Node.js + Express
- **数据库**: SQLite3（零配置，开箱即用）
- **前端**: 原生 JavaScript（无框架依赖）
- **容器**: Docker / Docker Compose

## 快速开始

### Docker 部署（推荐）

```bash
git clone https://github.com/yourname/jpage.git
cd jpage
docker-compose up -d
```

访问 http://localhost:3000

### 本地运行

```bash
npm install
npm start
```

开发模式（热重载）：

```bash
npm run dev
```

## 项目结构

```
jpage/
├── server.js          # Express 服务端
├── package.json
├── Dockerfile
├── docker-compose.yml
├── data/              # SQLite 数据库与上传文件存储
│   ├── database.sqlite
│   └── uploads/
└── public/            # 前端静态资源
    ├── index.html
    ├── css/style.css
    └── js/app.js
```

## 使用场景

- **临时分享文档** — 写完的 Markdown 笔记、HTML 报告，拖进来就能发给同事
- **静态页面托管** — 简单的单页 HTML 演示，无需配置服务器
- **Markdown 预览** — 本地写好 .md 文件，上传后自动渲染为排版精美的页面

## 为什么做这个

现有的方案要么太重（需要配置服务器、域名、CI），要么太封闭（绑定特定平台）。

即页只想做一件事：让静态内容的分享回归简单。拖入文件，得到一个链接。没有账户体系，没有学习成本，打开即用。

## 协议

MIT
