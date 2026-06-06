---
name: jpage-upload
description: 将 HTML / Markdown 字符串上传到本地 jpage 服务，得到可分享的预览链接；当用户希望"把这段 HTML 变成可访问的页面""分享一个网页""生成预览链接"时触发。
---

# jpage-upload

通过 **jpage MCP server** 把 HTML 或 Markdown 内容上传到本机即页服务，立即得到一个可分享的渲染链接。

## 前置条件

1. **jpage 服务在运行**（`http://localhost:8858`）
2. **MCP 端点已启用**（启动时设置了 `MCP_TOKEN` 环境变量）

启动命令：

```bash
MCP_TOKEN=devtoken \
ADMIN_USER=admin \
ADMIN_PASSWORD=admin1234 \
npm start
```

> 生产部署务必使用更复杂的 `MCP_TOKEN` 与 `SESSION_SECRET`。

## 配置 MCP 客户端

### Claude Code

在仓库根或 `~/.claude.json` 添加 `.mcp.json`：

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

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "jpage": {
      "type": "http",
      "url": "http://localhost:8858/mcp",
      "headers": {
        "Authorization": "Bearer devtoken"
      }
    }
  }
}
```

## 可用工具

| 工具 | 用途 |
|---|---|
| `upload_file` | **核心**：上传 HTML/Markdown，返回 `{id, url, ...}`，其中 `url` 是可访问的预览地址 |
| `list_files` | 列出 jpage 中所有文件 |
| `get_file_content` | 读取指定 id 的原始内容 |
| `get_file_url` | 仅获取指定 id 的预览 URL（不读取内容） |
| `rename_file` | 重命名 |
| `delete_file` | 删除 |

可用资源（被动读取）：

| 资源 URI | 内容 |
|---|---|
| `jpage://files` | 所有文件元数据（JSON） |
| `jpage://file/{id}` | 单文件内容（仅 ≤ 256KB，超过请改用 `get_file_content`） |

## 典型用法

### 1. 上传一段 HTML 并返回链接

当用户说"把这段 HTML 上传到 jpage"：

```
调用工具 upload_file
参数 { name: "report.html", content: "<!doctype html><h1>Hello</h1>" }

工具返回：
{
  "id": 42,
  "original_name": "report.html",
  "file_type": "html",
  "size": 28,
  "is_public": 1,
  "url": "http://127.0.0.1:8858/api/files/42/render"
}
```

把 `url` 字段直接呈现给用户。如果是远端部署，把 host 替换为对应域名。

### 2. 写一份 Markdown 报告并发布

```
调用工具 upload_file
参数 { name: "weekly.md", content: "# 本周工作\n\n- 完成 MCP 集成\n- 写示例 skill", isPublic: true }
```

### 3. 列出已有文件并挑选一个读取

1. `list_files` 拿到 id 列表
2. 找到目标 id 后 `get_file_content` 读内容

## 约束

- 单文件大小 ≤ 50 MB
- 文件名必须带扩展名：`.html` `.htm` `.md` `.markdown` 之一
- 返回的 `url` 默认是 `http://127.0.0.1:8858/...`，**仅本机可访问**。如部署到服务器，工具调用方应自行替换 host
- `uploaded_by` 字段记为 admin 用户（即 MCP service token 对应的用户）
