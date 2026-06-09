---
name: content-template
description: 当用户要生成 HTML/Markdown 内容时，先从模板市场查找风格样例，参照样例的风格生成新内容。适用于用户要求生成页面、报告、仪表板等，且希望有特定风格参考的场景。
---

# 核心规则

当用户要求生成 HTML 或 Markdown 内容时，先判断是否需要风格参考。如果用户指定了风格或类型（如「仪表板」「报告」「深色风格」），先查询模板市场获取样例。

# 触发场景

- 用户说「参照模板生成…」「用模板风格生成…」
- 用户要求生成特定类型的内容（仪表板、报告、简历等）
- 用户提到具体风格关键词（深色、极简、科技感等）
- 用户说「从模板市场找一个…」
- 用户要求生成美观的页面但未指定具体样式

# 工作流

## 场景一：用户指定模板或风格

用户明确要求参照某个模板或某种风格。

```
1. 调 list_content_templates 查询模板市场
   - 如果用户指定了场景类型（如「仪表板」），设置 scene 参数
   - 如果用户指定了风格关键词，设置 keyword 参数
2. 向用户展示匹配的模板列表（标题、场景、描述）
3. 用户选择一个模板后，调 get_content_template(id=选择的模板id) 获取完整样例
4. 学习样例的以下特征：
   - 整体布局结构（header/main/footer/sidebar 等区域划分）
   - 色彩方案（主色、辅色、背景色、文字色）
   - 排版风格（字体大小、间距、对齐方式）
   - 交互元素（按钮样式、卡片样式、表格样式）
   - 使用的 CSS 技术（Grid/Flexbox/absolute 等）
   - 特殊效果（渐变、阴影、动画等）
5. 根据用户的具体内容需求，生成风格一致但内容全新的 HTML/Markdown
6. 调 upload_file 上传到即页，返回预览链接
```

## 场景二：自动推荐模板

用户没有指定模板，但要求生成特定类型的内容。

```
1. 根据用户需求判断可能的场景类型
2. 调 list_content_templates(scene=场景类型, sort="use_count", limit=3)
3. 如果有匹配模板，向用户推荐：
   「我找到了几个相关模板，是否参照某个模板的风格？还是直接生成？」
4. 用户选择后，按场景一的流程继续
5. 如果用户选择直接生成，则不使用模板，正常生成
```

## 场景三：上传样例到模板市场

用户有一段好看的 HTML/Markdown，想保存为模板供以后参考。

```
1. 调 POST /api/content-templates 上传模板
   - title: 模板名称
   - content: 完整的 HTML/Markdown 内容
   - scene: 使用场景（dashboard/report/resume/landing/note/other）
   - description: 风格描述
   - styleTags: 风格标签（逗号分隔）
   - fileType: html 或 markdown
2. 告知用户模板已上传到市场
```

# 场景与关键词对照

| 用户可能说的 | scene 参数 |
|---|---|
| 仪表板、数据看板、Dashboard、监控面板 | dashboard |
| 报告、周报、月报、分析报告 | report |
| 简历、CV、名片、个人主页 | resume |
| 落地页、Landing Page、产品页、活动页 | landing |
| 笔记、文档、会议纪要、技术文档 | note |
| 卡片、海报、Banner、封面 | card |
| 演示、PPT、幻灯片 | presentation |
| 邮件、Email、Newsletter | email |
| 其他未分类 | other |

# 风格学习原则

AI 拿到样例后应学习的维度（按优先级）：

1. **布局结构** — 区域划分、内容组织方式
2. **色彩方案** — 主色调、配色关系
3. **字体排版** — 字号层级、行间距、字重
4. **组件样式** — 卡片、按钮、表格、图表容器
5. **视觉装饰** — 圆角、阴影、渐变、边框

**重要**：学习风格，不复制内容。生成的必须是全新的原创内容，仅保持视觉风格一致。

# MCP 工具

- `list_content_templates` — 查询模板列表（支持 scene/keyword/fileType 筛选）
- `get_content_template` — 获取模板完整内容（自动记录使用次数）
