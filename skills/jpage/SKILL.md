---
name: jpage
description: 即页（jpage）统一技能：生成 HTML/Markdown 内容、制作 reveal.js 幻灯片、使用内容模板市场风格、上传到即页并管理文件。所有内容生产与文件管理操作都通过本技能完成。
version: 1.6.0
author: jpage
---

# 核心规则

当用户要求：

- 生成 HTML 页面、Markdown 文档、报告、仪表板、简历、可视化等可预览内容
- 制作 PPT / 幻灯片 / 演示文稿 / deck
- 参照模板市场风格生成内容
- 上传到即页、获取预览链接、管理已上传文件

**统一走本技能的工作流**。

> 内容生成后必须调用 `upload_file` 上传到即页，返回预览链接；不要只输出代码块让用户自己复制。
> 大段 base64 上传很慢且费 token，本地已有的大文件 / ZIP 优先用 CLI 或 curl multipart 上传。

---

# 安装 CLI

本 Skill 推荐配合 **jpage CLI** 使用。只要当前环境有 Node.js ≥ 20，就可以全局安装：

```bash
npm install -g @code2rich/jpage
```

安装后验证：

```bash
jpage --version
```

配置 Token（三选一即可）：

```bash
# 1. 环境变量
export JPAGE_TOKEN="jp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 2. 当前目录 .env
# echo 'JPAGE_TOKEN=jp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' > .env

# 3. 临时命令参数
jpage whoami --token jp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> 没有 npm / 无法安装 CLI / 没有 Bash 能力的纯 MCP 客户端，直接调用下方的 MCP 工具即可，无需安装。

## 同步 Skill 到 Claude

CLI 安装好后，把本 Skill 同步到 Claude Code / Desktop 的 skills 目录：

```bash
# 自动安装到默认 skills 目录（按 ~/.claude/skills → ~/.claude-code/skills → ~/.agents/skills 顺序检测）
jpage skill install

# 或指定目录
jpage skill install --dir ~/.claude/skills/jpage
```

后续升级 jpage 后，用同一条命令覆盖更新：

```bash
jpage skill update
```

> 该命令会把 npm 包内置的 `skills/jpage/` 完整复制到目标目录，包括 SKILL.md 和 assets/ 资源。

---

# 入口优先级：CLI 优先，MCP 兜底

本 Skill 同时对应 **jpage CLI（命令行）** 与 **MCP 工具** 两套入口。执行上传、模板实例化、批量管理等任何操作时：

1. **优先使用 jpage CLI**。只要当前环境能调用 `jpage` 命令（或可通过 npm/pnpm 安装），就先走 CLI：二进制流式上传、base64 不进模型、速度最快、token 消耗最少。
2. **CLI 不可用时，再调用 MCP 工具**。纯 MCP 客户端（无 Bash、无法执行命令、无法安装 CLI）才通过 `upload_file`、`instantiate_content_template` 等 tool 完成。

> 判断标准：能否在当前环境执行 `jpage --version` 并成功返回版本号？能 → CLI；不能 → MCP。

---

# 触发场景

- 「上传到即页」「发到即页」「生成链接」
- 生成 HTML 页面、网页、落地页、仪表板、报告、邮件模板
- 生成 Markdown 笔记、文档、README
- 创建简历、名片、个人主页、作品展示页
- 生成数据可视化、图表页面、SVG 画布
- 将代码片段转为可预览的 HTML 展示页
- 生成 PPT / 幻灯片 / 演示文稿 / deck / 答辩 slides
- 「参照模板生成…」「用模板风格生成…」「从模板市场找一个…」
- 管理即页文件：列表、查看、修改、标签、分类、版本、删除、分享链接

---

# 内容生成规范

## 默认：单个自包含 HTML

除非用户要的是**幻灯片 / PPT / 演示文稿**（必须走 Bundle 模式），否则**一律生成单个自包含 HTML 文件**：

- CSS 用 `<style>` 内联
- JS 用 `<script>` 内联
- 图片用 data URI 或在线 URL
- 全部塞进一个 `.html` 里

不要把普通页面拆成 `index.html + style.css + app.js` 再打 ZIP——单文件在即页里预览最稳、分享最简单。

### HTML 文件必须包含

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>标题</title>
  <style>
    /* 内联 CSS */
  </style>
</head>
<body>
  <!-- 内容 -->
  <script>
    // 内联 JS
  </script>
</body>
</html>
```

- 中文字体使用系统字体栈：`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif`
- 公共 CDN 库（如 Tailwind、Chart.js、D3、KaTeX 等）可用，但离线场景需谨慎

### Markdown 文件

即页 Markdown 渲染引擎支持：

- 代码高亮（highlight.js）
- 数学公式：行内 `$...$`，块级 `$$...$$`（KaTeX）
- Mermaid 图表：` ```mermaid `
- GFM 扩展：表格、任务列表、删除线、自动链接

---

# 幻灯片 / PPT 工作流（Bundle 模式）

reveal.js 引擎 ~85KB，单文件内联会让每个 PPT 膨胀。即页有 **Bundle 机制**（ZIP 解压成目录，资源共用），必须走这条路。

## 1. 规划结构

常见结构：

- **简单式**：封面 → N 张内容 → 总结
- **章节式**：封面 → 章节分隔页 → 内容页（可垂直堆叠）→ 下一章节分隔 → 内容 → 总结

结构语法：`1` = 单张水平页，`N` = N 张垂直堆叠，`d` = 居中大字分隔页。
例：`1,d,3,d,2,d,1` = 封面 / 分隔 / 3 页内容 / 分隔 / 2 页内容 / 分隔 / 总结。

## 2. 选主题

| 用户说 | 主题 | 主色 |
|---|---|---|
| 商务 / 汇报 / 正式 / 提案 / 季度 / 年终 | business | 深蓝 #0a4d8c + 白底 |
| 学术 / 论文 / 答辩 / 研究 | academic | 深灰 + 米白，衬线标题 |
| 创意 / 产品 / 发布 / 活泼 / 设计 | creative | 高饱和渐变 |
| 极简 / 简约 / keynote 风 / 苹果风 | minimal | 黑白 + 一个强调色 |

用户没指定时默认 **business**。

## 3. 生成多文件网站包

目录结构（推荐 flat，根级直接是 index.html + assets/）：

```
deck/
├── index.html
├── assets/
│   ├── reveal.js          # reveal.js 引擎
│   ├── reveal-base.css    # 基础布局（必须）
│   ├── theme.css          # 选定的主题 CSS
│   └── plugin/
│       ├── highlight/
│       │   ├── plugin.js
│       │   └── monokai.css
│       └── notes/notes.js
```

### index.html 关键要求

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>幻灯片标题</title>
  <link rel="stylesheet" href="assets/reveal-base.css">
  <link rel="stylesheet" href="assets/theme.css">
  <link rel="stylesheet" href="assets/plugin/highlight/monokai.css">
</head>
<body>
  <div class="reveal">
    <div class="slides">
      <section><h1>标题</h1><p>副标题</p></section>
      <section>水平页</section>
      <section>
        <section>垂直堆叠页 1</section>
        <section>垂直堆叠页 2</section>
      </section>
    </div>
  </div>
  <script src="assets/reveal.js"></script>
  <script src="assets/plugin/highlight/plugin.js"></script>
  <script>
    Reveal.initialize({
      embedded: true,   // ★ iframe 内兼容，必须 true
      hash: true,
      controls: true,
      progress: true,
      slideNumber: true,
      transition: 'slide',
      plugins: [RevealHighlight]
    });
  </script>
</body>
</html>
```

**关键约束**：

- `Reveal.initialize` 必须设 **`embedded: true`**，避免 iframe 父页面抢方向键。
- **不要引用任何 CDN**（jsdelivr/unpkg/cdnjs）。所有 reveal.js 资源必须打进 `assets/`。
- 每页 `<section>` 内容精简；reveal.js 不自动滚动，溢出会被裁切。
- 中文字体用系统栈。

## 4. 获取 reveal.js 资源

reveal.js 引擎 + 基础 CSS + 4 套主题 + notes/highlight 插件骨架**已随本 Skill 包下发**（`assets/` 目录）。生成幻灯片时直接复制：

```bash
SKILL=~/.claude/skills/jpage

mkdir -p deck/assets/plugin/notes deck/assets/plugin/highlight
cp "$SKILL/assets/reveal.js"              deck/assets/
cp "$SKILL/assets/reveal-base.css"        deck/assets/
cp "$SKILL/assets/themes/business.css"    deck/assets/theme.css   # 按需换主题
cp "$SKILL/assets/plugin/notes/notes.js"  deck/assets/plugin/notes/
cp "$SKILL/assets/plugin/highlight/plugin.js"  deck/assets/plugin/highlight/
cp "$SKILL/assets/plugin/highlight/monokai.css" deck/assets/plugin/highlight/
```

**必须引入的两个 CSS**：`reveal-base.css`（基础布局）+ `theme.css`（主题变量）。顺序：base 在前，theme 在后。

### highlight.js 按需获取（可选）

本 Skill 默认**不含** highlight.js 全量文件（940KB，太重）。若幻灯片需要代码高亮：

```bash
npm pack highlight.js@11 && tar -xzf highlight.js-*.tgz --strip-components=1 -C deck/assets/plugin/highlight package/es/highlight.min.js package/styles/monokai.css
```

不需要代码高亮时，不要引入。

### 找不到本 Skill 包时

若运行环境没有本 Skill 的 `assets/`（如只贴了 SKILL.md），从 npm 拿稳定版：

```bash
npm pack reveal.js@5
tar -xzf reveal.js-5.*.tgz --strip-components=1 -C deck/assets package/dist/reveal.js package/dist/reveal.css package/plugin/
mv deck/assets/reveal.css deck/assets/reveal-base.css
# 主题用本 SKILL.md 里 CSS 变量自定义，或手写 theme.css
```

## 5. 打包上传

有 Bash 能力时，优先用 CLI 或 curl multipart 上传 ZIP，二进制流式上传、不进模型 token 流：

```bash
# 打 ZIP（flat 结构）
cd deck && zip -rq ../deck.zip index.html assets/ && cd ..

# 用 jpage CLI 上传（推荐）
jpage upload deck.zip --public

# 或 curl multipart
curl -sS -X POST "$BASE/api/files/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@deck.zip" \
  -F "isPublic=true"
```

纯 MCP 客户端（无 Bash）才退回 `upload_file`：

```python
upload_file(
  name="ai-trends-deck.zip",
  content="<ZIP 的 base64>",
  isPublic=True
)
```

> 体积提示：reveal.js ~85KB 经 base64 约 113KB，作为 tool 参数流经模型 token 流，比 curl multipart 慢且费 token。有 Bash 就别走这条。

## 6. 返回并提示翻页

上传成功后向用户展示 `/s/<share_key>` 链接，并提示：

> 幻灯片打开后，**点击幻灯片区域聚焦**，再用 ← → 翻页（或点右下角控件）。若键盘不响应，点预览页右上角「新窗口打开」按钮全屏查看。

---

# 内容模板市场工作流

当用户要求生成 HTML/Markdown 内容时，先判断是否需要风格参考。如果用户指定了风格或类型，先查询模板市场获取样例。

## 场景一：用户指定模板或风格

```
1. 调 list_content_templates 查询模板市场
   - 如果用户指定了分类类型（如「PPT」「书稿」），设置 category 参数
   - 如果用户指定了风格关键词，设置 keyword 参数
2. 向用户展示匹配的模板列表（标题、分类、描述）
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

```
1. 根据用户需求判断可能的分类类型
2. 调 list_content_templates(category=分类, sort="use_count", limit=3)
3. 如果有匹配模板，向用户推荐：
   「我找到了几个相关模板，是否参照某个模板的风格？还是直接生成？」
4. 用户选择后，按场景一的流程继续
5. 如果用户选择直接生成，则不使用模板，正常生成
```

## 场景三：上架文件到模板市场

用户有一个好看的 HTML/Markdown 文件，想上架到市场供以后参考。

```
1. 告知用户：上架后会快照文件当前内容，进入审核，管理员审核通过且设为展示后才出现在市场
2. 调 POST /api/content-templates/from-file
   - fileId: 源文件 ID（必填）
   - title: 模板名称（可选，默认用文件名）
   - categoryId: 分类 ID（必填，先用 GET /api/content-templates/categories 获取）
   - description: 风格描述（可选，建议包含：链接、风格关键词、适合内容、借鉴模块）
3. 一文件一模板：同文件再次上架会更新现有模板并重新进入审核
4. 告知用户已提交，等待审核
```

## 场景四：使用模板市场模板（直接实例化出文件）

当用户说「使用这个模板」「按这个模板生成一份」「把这个模板给我用」时，表示要在当前账户下创建一份基于模板内容的文件。该操作**必须通过 Token 完成**，Web 端按钮只能查看命令引导。

**有 CLI 时优先走 CLI**（速度最快、token 消耗最少）：

```bash
# 查看市场模板列表
jpage template ls --category html-book --limit 5

# 使用指定模板实例化（默认私有）
jpage template use 42 --name "我的报告.html" --public
```

**CLI 不可用时，再调用 MCP 工具**：

```python
instantiate_content_template(
  id=42,
  originalName="我的报告.html",
  isPublic=True
)
```

> 注意：
> - `instantiate_content_template` 需要有效的 API Token（`jp_...`）或 `MCP_TOKEN`，Session Cookie 会被拒绝。
> - 实例化成功后会在用户账户下创建一个真实文件，返回 `url` 可直接分享。

## 分类与关键词对照

| 用户可能说的 | category 参数 | 说明 |
|---|---|---|
| PPT、演示、幻灯片、路演、商务演示 | html-ppt | 适合演示型 HTML |
| 书稿、文档、教程、手册、协议规范、开发者文档 | html-book | 适合阅读型 HTML |

> 旧 scene 参数（dashboard/report/resume/landing/note/presentation/card/email/other）仍可传入作为兼容，工具会自动映射到对应分类。建议改用 category 参数。

## 风格学习原则

AI 拿到样例后应学习的维度（按优先级）：

1. **布局结构** — 区域划分、内容组织方式
2. **色彩方案** — 主色调、配色关系
3. **字体排版** — 字号层级、行间距、字重
4. **组件样式** — 卡片、按钮、表格、图表容器
5. **视觉装饰** — 圆角、阴影、渐变、边框

**重要**：学习风格，不复制内容。生成的必须是全新的原创内容，仅保持视觉风格一致。

---

# 上传工作流

## 场景一：新建内容并上传

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

## 场景二：读取已有文件 → 修改 → 覆盖更新

```
1. 调 list_files 查看文件列表，找到目标文件 id
2. 调 get_file_content(id=目标id) 读取当前内容
3. 根据用户要求修改内容
4. 调 upload_file(name=原文件名, content=修改后内容, overwriteFileId=目标id)
5. 告知用户已更新
```

> 使用 `overwriteFileId` 会自动将旧版本存入版本历史，无需先删除再上传。

## 场景三：查看已上传文件

```
1. 调 list_files 返回文件列表
2. 向用户展示文件摘要（文件名、类型、大小、公开/私有）
```

---

# 文件组织与管理

## 标签与分类

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

## 版本历史

```
# 查看版本历史
list_file_versions(fileId=42)
→ 返回当前版本信息 + 所有历史版本列表

# 恢复到指定版本
restore_file_version(fileId=42, version=3)
→ 当前版本自动备份，版本3的内容成为新当前版本
```

## 分享链接

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

---

# ⚡ 上传性能（大文件 / ZIP 必看）

`upload_file` 的 `content` 是字符串参数，ZIP 时是整包 base64。把大段 base64 当 tool 参数传会流经模型 token 流，**极慢且昂贵**。按内容来源选上传方式：

## 本地已有文件（尤其 ZIP 或 >1MB）→ CLI / curl multipart

有 Bash 时，直接走 REST multipart，二进制流式上传，base64 完全不进模型：

```bash
# 推荐：jpage CLI
jpage upload ./site.zip --public
jpage upload ./report.html --public
jpage upload ./x.html --overwrite 42

# 或 curl multipart
curl -sS -X POST "$BASE/api/files/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./site.zip" \
  -F "isPublic=true"
```

> token 三选一：`.env` 里的 `MCP_TOKEN`、`.mcp.json` 里的 Bearer、用户给的 `jp_` 用户 token。

## 模型现场生成的多文件站点 → Write 写盘 → zip → 上传

不要把每个资源 base64 塞进 `upload_file`。先用 Write 工具把文件写到磁盘、Bash 打包，再上传：

```bash
zip -r site.zip index.html assets/
jpage upload site.zip --public
```

## 模型刚生成的 HTML/MD（含大文件）→ 直接 upload_file

内容本就在模型输出里，`upload_file` 让这些 token 只发一遍——返回值不含 content，不会回灌进上下文。

判断标准：内容是「此刻生成、已在上下文」还是「磁盘上已存在的文件」——前者用 `upload_file`，后者用 CLI / curl。

---

# 常见错误处理

| 错误信息 | 原因 | 处理方式 |
|---|---|---|
| `不支持的文件扩展名` | 文件名后缀不在允许列表中 | 确保文件名为 `.html`、`.htm`、`.md` 或 `.markdown` |
| `文件过大` | 内容超过 50MB | 拆分内容或压缩 |
| `文件不存在` | 使用了无效的文件 ID | 重新 list_files 获取有效 ID |
| `无权操作此文件` | 非所有者且非 admin | 告知用户权限不足 |
| 上传后被当成多个独立文件（batch）而非一个幻灯片包 | ZIP 里没有 index.html，或有多个并列 HTML 且无共享资源目录 | 确保根级有 index.html + assets/ 子目录 |
| 幻灯片打开是空白 | 引用了 CDN 的 reveal.js | 所有资源必须本地 `assets/`，禁止 CDN URL |
| 翻页键不响应 | iframe 父页面抢键 | 已用 `embedded:true` 规避；提示用户先点击聚焦，或用新窗口打开 |
| 文字被裁切 | 一页内容太多 | 拆页，每页一个要点 |
| 主题样式没生效 | 只引入了 theme.css 没引入 reveal-base.css，或顺序反了 | base 在前，theme 在后 |

---

# MCP 工具

- `upload_file` — 上传 HTML/Markdown/ZIP 文件
- `list_files` — 列出文件
- `get_file_content` — 读取文件内容
- `delete_file` — 删除文件
- `rename_file` — 改名 / 改公开性
- `get_file_url` — 获取分享链接
- `star_file` / `unstar_file` — 收藏
- `list_file_versions` / `restore_file_version` — 版本历史
- `list_tags` / `add_tags_to_file` — 标签
- `list_categories` / `create_category` / `set_file_category` — 分类
- `list_content_templates` — 查询内容模板市场
- `get_content_template` — 获取模板完整内容（学习风格用）
- `instantiate_content_template` — 用模板实例化文件（CLI 不可用时兜底）
