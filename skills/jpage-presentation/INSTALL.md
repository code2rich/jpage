# 安装 jpage-presentation Skill

本 Skill 适用于支持 **SKILL.md 开放标准** 的 AI 客户端（Claude Code、Claude Desktop、OpenAI Codex CLI、Cursor 等）。

## 前置条件

- AI 客户端已配置即页的 MCP 端点（`/mcp`），且 `upload_file` 工具可用
- 若要用 curl multipart 上传（推荐）：运行环境有 Bash 能力

## 方式一：从即页 Web UI 下载 ZIP（最简单）

1. 打开即页首页，找到 Skills 区块
2. 点击 `jpage-presentation` → 下载 ZIP
3. 解压到客户端的 skills 目录（见下方各客户端路径）

## 方式二：从仓库直接复制

```bash
cp -r /path/to/jpage/skills/jpage-presentation ~/.claude/skills/
```

## 各客户端 skills 目录

| 客户端 | 路径 |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/skills/` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\skills\` |

## 验证安装

1. 重启 AI 客户端（让它重新扫描 skills 目录）
2. 对 AI 说：「做一个关于 X 的 5 页 PPT，商务风格」
3. AI 应触发本 Skill，生成 reveal.js 幻灯片并上传到即页

## assets 目录说明

本 Skill 的 `assets/` 目录已随包下发 reveal.js 5.x 引擎、基础 CSS、四套主题、notes/highlight 插件骨架。生成幻灯片时，AI 会把这些文件复制到目标 `deck/assets/`，**不需要额外下载**（除非要用代码高亮，见 SKILL.md「highlight.js 按需获取」）。

## 更新 reveal.js

`assets/reveal.js` 和 `assets/reveal-base.css` 是 reveal.js 5.2.1 的官方产物。升级时：

```bash
npm pack reveal.js@5
tar -xzf reveal.js-5.*.tgz --strip-components=1 -C assets package/dist/reveal.js package/dist/reveal.css
mv assets/reveal.css assets/reveal-base.css
```

插件同理，从 `package/plugin/` 复制对应文件。
