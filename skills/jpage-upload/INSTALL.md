# 安装 jpage-upload Skill

这个 Skill 让 Claude Code / Claude Desktop 通过 jpage MCP server 把 HTML / Markdown 直接上传到本机的即页服务，得到可分享的预览链接。

## 1. 启动 jpage 并启用 MCP 端点

```bash
MCP_TOKEN=你的token \
ADMIN_USER=admin \
ADMIN_PASSWORD=你的密码 \
SESSION_SECRET=随机32位hex \
npm start
```

启动日志应包含：

```
[即页] MCP 端点已挂载: http://localhost:8858/mcp (Bearer auth)
```

未看到这一行说明 `MCP_TOKEN` 没设置或设置错误，MCP 端点未启用。

## 2. 安装 Skill

下载本页的 `jpage-upload.zip`，解压后是一个 `jpage-upload/` 目录（内含 `SKILL.md`）。把这个目录放到 `~/.claude/skills/` 下：

```bash
unzip jpage-upload.zip -d ~/.claude/skills/
ls ~/.claude/skills/jpage-upload/
# 应输出: SKILL.md
```

或建软链（方便升级时 `git pull` 后自动同步）：

```bash
ln -s "$(pwd)/skills/jpage-upload" ~/.claude/skills/jpage-upload
```

## 3. 配置 MCP 客户端

### Claude Code

在仓库根放 `.mcp.json`（项目级只在该项目生效），或在 `~/.claude.json`（用户级全局生效）：

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

`${env.MCP_TOKEN}` 会从启动 Claude Code 的 shell 环境里读，所以 Claude Code 启动前要 `export MCP_TOKEN=...`。

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "jpage": {
      "type": "http",
      "url": "http://localhost:8858/mcp",
      "headers": {
        "Authorization": "Bearer 你的token"
      }
    }
  }
}
```

桌面客户端不解析 `${env.MCP_TOKEN}`，需要把 token 直接写进配置。

## 4. 验证

启动 jpage → 启动 Claude Code → 在对话中让它"把 `<h1>hi</h1>` 上传到 jpage"。

预期行为：
1. Claude 调用 `upload_file` 工具
2. 工具返回包含 `url` 字段，例如 `http://127.0.0.1:8858/api/files/1/render`
3. Claude 把这个 URL 渲染成 markdown 链接展示给你
4. 点击链接可在浏览器看到该 HTML

如果 Claude 看不到 jpage 工具列表：在 Claude Code 里 `/mcp` 命令查看连接状态，确认 `jpage` server 是 connected。

## 5. 升级

`skills/jpage-upload/SKILL.md` 内容会随 jpage 升级而更新。重新从 web 页面下载 zip 并解压覆盖，或更新软链指向的目录。重启 Claude Code 让新版本生效。

## 6. 卸载

```bash
rm -rf ~/.claude/skills/jpage-upload
# 同时从 .mcp.json 或 claude_desktop_config.json 删除 jpage 项
```
