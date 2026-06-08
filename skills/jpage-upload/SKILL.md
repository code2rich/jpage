---
name: jpage-upload
description: 当用户要"上传到即页"、"生成预览链接"、"查看已上传文件"，或要求生成 HTML/Markdown 页面、报告、可视化、笔记等内容时，生成后自动上传到即页并返回预览链接。
---

# 核心规则

凡是用户要求生成 HTML 或 Markdown 内容（页面、报告、笔记、简历、可视化、文档等），**一律生成完整内容后调用 `upload_file` 上传到即页**，返回预览 URL。不要只输出代码块让用户自己复制。

# 触发场景

以下场景均应生成内容并上传到即页：

- 用户明确说"上传到即页"、"发到即页"、"生成链接"
- 用户要求生成 HTML 页面、网页、落地页、仪表板、报告
- 用户要求生成 Markdown 笔记、文档、README
- 用户要求抓取网页并生成 HTML/Markdown 保存
- 用户要求创建简历、名片、个人主页、作品展示页
- 用户要求生成数据可视化、图表页面、SVG 画布
- 用户要求将代码片段转为可预览的 HTML 展示页
- 用户要求创建测试页面、Demo 页、原型页
- 用户要求生成邮件模板、通知模板
- 用户要求生成任何形式的可在线预览的文档

# 内容生成规范

## HTML 文件

生成的 HTML 必须**完全自包含**（单个文件，无外部依赖），以确保在即页预览中正确渲染：

- 必须包含 `<!DOCTYPE html>`、`<html>`、`<head>`、`<body>` 完整结构
- 必须包含 `<meta charset="UTF-8">` 和 `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
- CSS 使用 `<style>` 内联，不引用外部样式表（Tailwind CDN 等公共 CDN 可用）
- JS 使用 `<script>` 内联，不引用外部脚本（公共 CDN 库如 Chart.js、D3 等可用）
- 图片使用 data URI 或在线图片 URL，不依赖本地文件
- 中文字体使用系统字体栈：`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif`

## Markdown 文件

即页的 Markdown 渲染引擎支持以下增强特性，可放心使用：

- **代码高亮**：所有语言的代码块均自动高亮（highlight.js）
- **数学公式**：行内 `$...$`，块级 `$$...$$`（KaTeX）
- **Mermaid 图表**：` ```mermaid ` 代码块自动渲染为流程图/时序图等
- **GFM 扩展**：表格、任务列表、删除线、自动链接

# 工作流

## 场景一：新建内容并上传

最常用的流程——用户要求生成内容，直接上传。

```
1. 根据用户需求生成完整的 HTML 或 Markdown 内容
2. 调用 upload_file:
   - name: 带扩展名的文件名（如 "data-report.html"、"meeting-notes.md"）
   - content: 完整正文（UTF-8 字符串）
   - isPublic: 默认 true（除非用户明确要求私有）
3. 向用户展示返回的 url 链接
```

**upload_file 返回结构**：
```json
{
  "id": 42,
  "original_name": "data-report.html",
  "file_type": "html",
  "size": 12345,
  "is_public": 1,
  "share_key": "abc12345",
  "url": "http://jpage.example.com/s/abc12345"
}
```

**示例对话**：
- 用户："帮我做一个销售数据仪表板"
- AI：生成完整 HTML → 调 `upload_file(name="sales-dashboard.html", content=...)` → 展示 URL

## 场景二：读取已有文件 → 修改 → 覆盖更新

用户要求修改已上传的文件。

```
1. 调 list_files 查看文件列表，找到目标文件 id
2. 调 get_file_content(id=目标id) 读取当前内容
3. 根据用户要求修改内容
4. 调 upload_file(name=原文件名, content=修改后内容, overwriteFileId=目标id)
5. 告知用户已更新
```

**注意**：使用 `overwriteFileId` 会自动将旧版本存入版本历史，无需先删除再上传。

## 场景三：查看已上传文件

用户想看即页上有什么文件。

```
1. 调 list_files 返回文件列表
2. 向用户展示文件摘要（文件名、类型、大小、公开/私有）
```

**list_files 返回结构**（每个文件）：
```json
{
  "id": 42,
  "original_name": "report.html",
  "file_type": "html",
  "size": 12345,
  "is_public": 1,
  "created_at": "2026-06-08T10:30:00.000Z",
  "share_key": "abc12345",
  "starred": false,
  "category_id": 1
}
```

## 场景四：管理标签与分类

用户要求对文件进行组织管理。

```
# 查看现有标签/分类
调 list_tags → 展示所有标签及文件数
调 list_categories → 展示所有分类及文件数

# 上传时直接打标签
upload_file(name="Q3报告.html", content=..., tags=["报告", "Q3", "财务"])

# 给已有文件设置标签
add_tags_to_file(fileId=42, tags=["重要", "待审核"])

# 创建分类并归档文件
create_category(name="2026年报告") → 拿到 categoryId
set_file_category(fileId=42, categoryId=分类id)
```

## 场景五：版本历史管理

用户想查看或恢复文件的历史版本。

```
# 查看版本历史
list_file_versions(fileId=42)
→ 返回当前版本信息 + 所有历史版本列表

# 恢复到指定版本
restore_file_version(fileId=42, version=3)
→ 当前版本自动备份，版本3的内容成为新当前版本
```

## 场景六：获取分享链接

用户想获取文件的分享链接。

```
调 get_file_url(id=42)
→ 返回 { id: 42, url: "http://jpage.example.com/s/abc12345" }
```

短链接格式 `/s/:key` 是最佳分享方式，公开文件无需登录即可访问。

## 删除文件

```
调 delete_file(id=42)
```

**必须先向用户确认再执行删除**，此操作不可撤销。

# 常见错误处理

| 错误信息 | 原因 | 处理方式 |
|---|---|---|
| `不支持的文件扩展名` | 文件名后缀不在允许列表中 | 确保文件名为 `.html`、`.htm`、`.md` 或 `.markdown` |
| `文件过大` | 内容超过 50MB | 拆分内容或压缩 |
| `文件不存在` | 使用了无效的文件 ID | 重新 list_files 获取有效 ID |
| `无权操作此文件` | 非所有者且非 admin | 告知用户权限不足 |

# 文件命名建议

AI 生成文件名时，遵循以下原则：
- 使用有意义的中文名或英文命（如 `销售报告-Q3.html`、`meeting-notes-2026-06.md`）
- 必须带正确的扩展名（`.html` / `.md`）
- 避免特殊字符（`/`、`\`、`:`、`*`、`?`）
