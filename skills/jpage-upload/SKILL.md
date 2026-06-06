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

# 工作流

## 上传

1. 根据用户需求生成完整的 HTML 或 Markdown 内容
2. 调 `upload_file`，传 `name`（带扩展名，如 `report.html`）、`content`（完整正文）、`isPublic`（默认 `true`）
3. 成功后展示返回的 `url` 链接，告知用户可直接访问

## 列表

调 `list_files` 查看已上传文件。

## 读取

先 `list_files` 拿 id，再 `get_file_content` 或 `get_file_url`。

## 删除

调 `delete_file`，需先向用户确认。

## 更新

如需更新已有文件：先 `list_files` 找到 id，调 `get_file_content` 读取旧内容，修改后用 `delete_file` 删除旧文件，再 `upload_file` 上传新版本（保留相同文件名）。
