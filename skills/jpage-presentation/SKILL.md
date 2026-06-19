---
name: jpage-presentation
description: 当用户要"生成 PPT""做幻灯片""演示文稿""做一个 deck""答辩 slides"时，生成基于 reveal.js 的自包含幻灯片网站包（Bundle）并上传到即页，返回分享链接。支持商务/学术/创意/极简四套主题。区别于普通 HTML：必须用 Bundle 模式（ZIP 含 index.html + assets/），不要单文件内联 reveal.js。
version: 1.0.0
author: jpage
---

# 核心规则

用户要幻灯片 / PPT / 演示文稿时，按下面的 **Bundle 工作流**生成并上传，不要生成单文件 HTML。

# 触发场景

- 用户说"生成 PPT""做幻灯片""演示文稿""做一个 deck"
- 用户说"Q3 汇报""产品发布""答辩 slides""培训课件"
- 用户给一份文档/笔记，要求"转成幻灯片""做成 PPT"

# Bundle 工作流（必须遵守）

reveal.js 引擎 ~85KB，单文件内联会让每个 PPT 膨胀。即页有 **Bundle 机制**（ZIP 解压成目录，资源共用，离线可预览），必须走这条路。

## 1. 规划结构

先规划幻灯片结构，再动手生成。常见结构：

- **简单式**：封面 → N 张内容 → 总结
- **章节式**：封面 → 章节分隔页 → 内容页（可垂直堆叠）→ 下一章节分隔 → 内容 → 总结

结构语法（可选，用于脚手架脚本）：`1` = 单张水平页，`N` = N 张垂直堆叠，`d` = 居中大字的分隔页。
例：`1,d,3,d,2,d,1` = 封面 / 分隔 / 3 页内容 / 分隔 / 2 页内容 / 分隔 / 总结。

## 2. 选主题

根据用户语气选主题（用户没指定时默认**商务**）：

| 用户说 | 主题 | 主色 |
|---|---|---|
| 商务 / 汇报 / 正式 / 提案 / 季度 / 年终 | 商务 (business) | 深蓝 #0a4d8c + 白底 |
| 学术 / 论文 / 答辩 / 研究 | 学术 (academic) | 深灰 + 米白，衬线标题 |
| 创意 / 产品 / 发布 / 活泼 / 设计 | 创意 (creative) | 高饱和渐变 |
| 极简 / 简约 / keynote 风 / 苹果风 | 极简 (minimal) | 黑白 + 一个强调色 |

## 3. 生成多文件网站包

写到磁盘，目录结构推荐如下（**根级直接是 index.html + assets/**，即 flat 结构）：

> 💡 实测：套顶层目录（如 `deck/index.html`）也能正确识别为 bundle 并渲染，但 flat 结构更简洁，推荐。

```
deck/
├── index.html          # reveal.js 容器，<div class="reveal"><div class="slides">...</div></div>
├── assets/
│   ├── reveal.css      # 从本 Skill 的 assets/themes/<主题>.css 取（已下发）
│   ├── reveal.js       # reveal.js 引擎（见下文"获取 reveal.js"）
│   └── plugin/         # markdown / highlight / notes 插件（按需，见下文）
```

### index.html 必须满足

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>幻灯片标题</title>
  <link rel="stylesheet" href="assets/reveal-base.css">   <!-- reveal.js 基础布局（必须） -->
  <link rel="stylesheet" href="assets/theme.css">          <!-- 选定的主题（覆盖 CSS 变量） -->
  <link rel="stylesheet" href="assets/plugin/highlight/monokai.css">  <!-- 代码高亮主题，按需 -->
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
  <script src="assets/plugin/highlight/highlight.js"></script>
  <script>
    Reveal.initialize({
      embedded: true,        // ★ 必须 true：iframe 内兼容，依赖容器聚焦而非全局键盘
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
- ⚠️ `Reveal.initialize` 必须设 **`embedded: true`**——即页预览在 iframe 里，父页面会抢方向键/空格，`embedded:true` 让 reveal 依赖容器点击聚焦，避免抢键冲突。
- ⚠️ **不要引用任何 CDN**（jsdelivr/unpkg/cdnjs 都不行）。即页核心卖点是离线可预览，走 CDN 会让内网/断网用户看到空白。所有 reveal.js 资源必须打进 `assets/`。
- ⚠️ 每页 `<section>` 内容精简。reveal.js **不自动滚动**，内容溢出会被裁切。一张幻灯片讲一个要点。
- 中文字体用系统栈：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`。

## 4. 获取 reveal.js 资源

reveal.js 引擎 + 基础 CSS + 4 套主题 + notes/highlight 插件骨架**已随本 Skill 包下发**（`assets/` 目录，~312KB）。生成幻灯片时直接复制这些文件到目标 `deck/assets/`：

```bash
# 假设本 Skill 已安装到 ~/.claude/skills/jpage-presentation/
SKILL=~/.claude/skills/jpage-presentation

mkdir -p deck/assets/plugin/notes deck/assets/plugin/highlight
cp "$SKILL/assets/reveal.js"           deck/assets/
cp "$SKILL/assets/reveal-base.css"     deck/assets/        # reveal.js 基础布局（必须）
cp "$SKILL/assets/themes/business.css" deck/assets/theme.css  # 选定主题，见第 2 步
cp "$SKILL/assets/plugin/notes/notes.js" deck/assets/plugin/notes/   # 演讲者备注，可选
cp "$SKILL/assets/plugin/highlight/plugin.js" deck/assets/plugin/highlight/  # 代码高亮加载器
cp "$SKILL/assets/plugin/highlight/monokai.css" deck/assets/plugin/highlight/ # 高亮主题
```

**必须引入的两个 CSS**：`reveal-base.css`（reveal.js 基础布局）+ `theme.css`（四套主题之一，覆盖 CSS 变量）。顺序：base 在前，theme 在后。

### highlight.js 按需获取（可选）

本 Skill 默认**不含** highlight.js 全量文件（940KB，太重）。若幻灯片需要代码高亮：
```bash
npm pack highlight.js@11 && tar -xzf highlight.js-*.tgz --strip-components=1 -C deck/assets/plugin/highlight package/es/highlight.min.js package/styles/monokai.css
```
不需要代码高亮时，不要引入，省体积。

### 找不到本 Skill 包时

若运行环境没有本 Skill 的 `assets/`（如只贴了 SKILL.md），从 npm 拿稳定版：
```bash
npm pack reveal.js@5
tar -xzf reveal.js-5.*.tgz --strip-components=1 -C deck/assets package/dist/reveal.js package/dist/reveal.css package/plugin/
mv deck/assets/reveal.css deck/assets/reveal-base.css
# 主题则用本 SKILL.md 里第 5 节的 CSS 变量自定义，或参照 themes/ 目录手写
```

## 5. 上传（Bundle 模式）

打包 ZIP 并上传。推荐 **flat 结构**（ZIP 根级直接是 index.html + assets/）。

### 有 Bash（Claude Code）→ curl multipart（推荐，快）

```bash
TOKEN=$(grep -E '^MCP_TOKEN=' .env 2>/dev/null | cut -d= -f2-)
[ -z "$TOKEN" ] && TOKEN=$(grep -oE 'Bearer [A-Za-z0-9_]+' .mcp.json 2>/dev/null | head -1 | awk '{print $2}')
BASE="${JPAGE_BASE:-http://localhost:8858}"

# 打 ZIP：优先系统 zip 命令（flat 结构，根级直接 index.html）
if command -v zip >/dev/null 2>&1; then
  ( cd deck && zip -rq ../deck.zip index.html assets/ )
else
  # 无 zip 命令时用 Node + JSZip（即页已依赖 jszip）
  node -e '
    const JSZip=require("jszip"),fs=require("fs"),path=require("path");
    (async()=>{
      const z=new JSZip();
      (function add(root,base=""){for(const n of fs.readdirSync(root)){const a=path.join(root,n),r=base?base+"/"+n:n;
        if(fs.statSync(a).isDirectory())add(a,r);else z.file(r,fs.readFileSync(a));}})(process.cwd()+"/deck");
      fs.writeFileSync("deck.zip",await z.generateAsync({type:"nodebuffer"}));
    })();
  '
fi

curl -sS -X POST "$BASE/api/files/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@deck.zip" \
  -F "isPublic=true"
```

服务端自动判定为 bundle（根级有 index.html + assets 子目录），返回 `{id, share_key, ...}`。
（套了顶层目录的 ZIP 也能识别为 bundle，但 flat 更简洁。）

### 纯 MCP（Claude Desktop 无 Bash）→ upload_file base64

```python
upload_file(
  name="ai-trends-deck.zip",
  content="<ZIP 的 base64>",   # base64(文件二进制)
  isPublic=True
)
```

⚠️ 体积提示：reveal.js ~85KB 经 base64 约 113KB，作为 tool 参数流经模型 token 流，比 curl multipart 慢且费 token。有 Bash 就别走这条。

## 6. 返回并提示翻页方式

上传成功后向用户展示 `/s/<share_key>` 链接，并附一句提示：

> 幻灯片打开后，**点击幻灯片区域聚焦**，再用 ← → 翻页（或点右下角控件）。若键盘不响应，点预览页右上角"新窗口打开"按钮全屏查看。

# 内容规范

- **封面页**：大标题 + 副标题 + 作者/日期。用 `class="fit-text"` 或 `<h1>` 默认样式。
- **分隔页**：居中大字，标识新章节。`<section><h2 class="r-fit-text">章节名</h2></section>`。
- **内容页**：一个要点 + 3-5 条要点列表或一张图。不要堆字。
- **代码页**：用 `<pre><code class="language-js">...</code></pre>`，配 highlight 插件。
- **图表**：用 Mermaid（`<pre class="mermaid">...</pre>` 需引入 mermaid 插件）或内联 SVG。避免引入 Chart.js（增加体积）。
- **结尾页**：感谢 + 联系方式 / Q&A。

# 风格学习（可选）

若用户说"参照某风格"，先 `list_content_templates(scene="presentation")` 取样例，学习其：
1. 配色方案 → 映射到四套主题之一或微调 CSS 变量
2. 版式（标题大小、留白） → 调 `--r-heading-font-size` 等
3. 装饰元素（分隔线、页码样式）

**学风格，不抄内容**。

# 常见坑

| 现象 | 原因 | 解决 |
|---|---|---|
| 上传后被当成多个独立文件（batch）而非一个幻灯片包 | ZIP 里没有 index.html，或有多个并列 HTML 且无共享资源目录 | 确保根级有 index.html + assets/ 子目录；只一个 HTML 时也会判 bundle |
| 幻灯片打开是空白 | 引用了 CDN 的 reveal.js | 所有资源必须本地 `assets/`，禁止 CDN URL |
| 翻页键不响应 | iframe 父页面抢键 | 已用 `embedded:true` 规避；提示用户先点击聚焦，或用新窗口打开 |
| 文字被裁切 | 一页内容太多 | 拆页，每页一个要点 |
| 主题样式没生效 | 只引入了 theme.css 没引入 reveal-base.css，或顺序反了 | 必须 `<link href="assets/reveal-base.css">` 在前，`<link href="assets/theme.css">` 在后，两者都在 reveal.js 之前 |

# 复用

上传环节**统一走 `jpage-upload` 的 `upload_file` 工具**，本 Skill 不另造上传逻辑。
