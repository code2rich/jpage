---
name: jpage-upload
description: 当用户希望"把 HTML / Markdown 字符串做成可访问的预览页面"、"生成可分享链接"、"上传到 jpage"、或询问"我上传了哪些文件 / 那个文件的链接"时，调用 jpage MCP server 的对应工具。
---

# 工作流

## 上传文件

调 `upload_file`：

- `name`：建议 `<title>.html` 或语义化命名（如 `weekly-report.html`）
- `content`：完整 HTML 或 Markdown 字符串
- `isPublic`：默认 `true`（生成可分享链接）；仅当用户明确要求"不公开 / 私有"时设为 `false`

成功后将返回的 `url` 字段以 markdown 链接形式呈现给用户，例如：

> 已上传：[demo.html](http://127.0.0.1:8858/api/files/42/render)

## 检索与读取

- "我有哪些文件 / jpage 上有什么" → `list_files`，简表呈现
- "那个 XXX 的内容" → 先 `list_files` 找 id，再 `get_file_content`
- "XXX 的链接 / 分享地址" → 先 `list_files` 找 id，再 `get_file_url`

## 修改

- 改文件名 → `rename_file`（仅在用户明确要求时；不要主动改）
- 删除文件 → `delete_file`（**必须先确认**，默认拒绝）

# 约定

- 返回的 `url` host 是 loopback（`127.0.0.1:8858`），仅本机可访问；jpage 部署在远端时需替换 host
- 单文件 50MB 上限；超过应先告知用户
- 用户没指定公开/私有时，遵循 `isPublic: true` 默认
- 工具返回失败时，把 `error` 字段原样回显，不要包装
