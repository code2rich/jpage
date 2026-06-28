# 即页（jpage）内容生产能力扩展 —— Skill 集成设计方案

> 基于调研报告《开源 Skill 项目探索与即页集成方案》审阅后制定。
> 本文档是**设计稿**，不含实现代码；审阅通过后再分阶段落地。
> 评审焦点：**可实现、易扩展、好落地**。

---

## 0. TL;DR（一句话方案）

在即页现有的「**Skill 编排 → MCP 工具 → REST/DB 沉淀**」三层插件位上，**以 Skill（SKILL.md）为主载体扩展内容生产纵深**。当前已将 `jpage-upload`、`jpage-presentation`、`jpage-content-template` 合并为统一 `jpage` Skill；后续新增能力（editorial / clone-ui）作为该 Skill 的章节或模板双轨增量。`jpage-chart`（与 Mermaid 重叠）和 Phase 3 的外部市场对接列为「暂缓」。

报告整体方向正确，但有三处技术判断需修正，本方案已据此调整。

---

## 1. 对调研报告的审阅结论

### 1.1 报告判断正确、可直接采纳的部分

| 结论 | 评价 |
|---|---|
| 三条路径（Fork&Adapt / Inspire&Build / Market&Extend） | ✅ 准确，优先级合理 |
| revealjs-skill 位于第一象限（高价值 × 低难度） | ✅ 正确，与即页定位契合 |
| 现有基础设施够用（自动发现/YAML 解析/ZIP 打包/Web UI） | ✅ 属实，加 Skill 几乎零代码 |
| Phase 3 外部市场对接（Composio/agentskills.so）投入大、收益远 | ✅ 同意，列为暂缓 |

### 1.2 报告需修正的三处技术判断

**① reveal.js 在 iframe 里的键盘导航没有报告说的那么乐观（报告 6.1）**

报告说「sandbox 已允许 JS 执行，键盘事件可在 iframe 内处理」。现实是：

- reveal.js 依赖 `keydown`，但即页预览页是 SPA，父页面有全局键盘监听（方向键翻历史等），会和 iframe 抢键。
- 方向键/空格在父页面被消费时，iframe 内的 reveal.js 收不到，表现为「按键没反应」。

**正解**：reveal.js 配置 `embedded: true`（依赖容器内点击聚焦）+ 预览页提供「在新窗口打开 / 全屏」兜底按钮。不假设键盘事件能自动透传。

**② 「自包含化」被低估，且漏了现成的 Bundle 机制（报告 6.2）**

报告在「reveal.js 库内联 / 通过 CDN」二选一里纠结，但**即页已有 `is_bundle` 机制**（ZIP 解压成目录 + `<base>` 注入相对路径）。这是第三条、也是最优解：

| 策略 | 体积 | 离线可预览 | 实现成本 | 缺点 |
|---|---|---|---|---|
| CDN | 小 | ❌ 断网/内网看不到 | 最低 | 破坏即页核心卖点 |
| 全内联 | 每文件 200KB+ | ✅ | 中 | 生成 10 个 PPT 就 2MB+ |
| **Bundle**（本方案采用） | reveal.js 一份共用 | ✅ | 中 | 必须走 ZIP 上传 |

**③ `jpage-chart` 是伪需求，建议砍掉**

即页 Markdown 渲染**已支持 Mermaid**（流程图/时序图/甘特图），内容模板市场已有 `dashboard` 场景（内含 Chart.js 模板）。单独的 chart Skill 与现有能力重叠，且静态 HTML 写死数据不如让 AI 直接写 Mermaid。

**建议**：砍掉 `jpage-chart` Skill；若要增强图表能力，扩 `dashboard`/`report` 场景模板即可，零新代码。

### 1.3 报告工作量需如实标注

Phase 1「1-2 周」含 3-5 套 reveal.js 主题——reveal.js 主题是 **30+ CSS 变量驱动的整套系统**（`--r-main-color`、`--r-link-color`、`--r-heading-font`…），不是写几个 CSS 文件。做出「商务/学术/创意/极简」四套**视觉差异明显**的主题，纯设计调色排版就 3-5 天。本方案把这部分明确标为「含 UI 设计工时」。

---

## 2. 设计总原则

### 2.1 扩展位分层与职责边界

即页已经为内容生产预留了清晰的三层插件位。本方案严格沿用，**不新增框架**：

```
┌─────────────────────────────────────────────────────────────┐
│  Skill 层  (skills/*/SKILL.md)         ← 本方案主载体          │
│  职责：教 AI「怎么做」——编排工作流、触发场景、风格规范           │
│  扩展方式：加目录 + SKILL.md，零代码（registry 自动发现）       │
├─────────────────────────────────────────────────────────────┤
│  MCP 工具层 (mcp/tools-*.js)           ← 复用为主，极少新增     │
│  职责：给 AI「手段」——upload_file / list_content_templates…   │
│  扩展方式：新增 tools-xxx.js + server.js 工厂一行注册          │
├─────────────────────────────────────────────────────────────┤
│  REST/DB 层 (routes/*.js + migrations) ← 按需小幅扩展          │
│  职责：让产物「可沉淀」——内容模板市场、scene 枚举、use 计数     │
│  扩展方式：migration + route                                  │
└─────────────────────────────────────────────────────────────┘
```

**关键设计决策：能靠 SKILL.md 解决的，绝不写代码。**

报告里把 presentation/editorial/clone-ui 都列为「新增 Skill」是对的，但它们的「能力」其实**已经存在**——`upload_file` + `list_content_templates`。新 Skill 的价值是**编排**（教 AI 先查模板、再仿风格、最后走 bundle 上传），不是新增后端能力。这把实现成本压到最低。

### 2.2 Skill 间协作：单一上传中枢

所有生产型能力**统一复用 `jpage` Skill 中的上传中枢**，不各自实现：

```
用户："做个 Q3 汇报 PPT"
  │
  ▼
jpage Skill（编排：规划结构 → 生成 reveal.js HTML → 组装 ZIP）
  │  复用
  ▼
upload_file（上传 ZIP → 自动判 bundle → 返回 /s/:key）
```

Skill 之间不直接调用，而是**通过共同的工具层间接协作**。这保证任一 Skill 可独立增删，不影响其他。

### 2.3 「场景模板」与「Skill」双轨

报告里两套东西容易混，本方案明确区分：

| 维度 | 内容模板（content_templates 表） | Skill（skills/ 目录） |
|---|---|---|
| 本质 | **样例 HTML/MD**（AI 仿其风格） | **工作流指令**（教 AI 怎么做） |
| 存储 | DB，运行时可增删 | 文件系统，随版本发布 |
| 扩展 | migration 预置 / 用户上传 | 加 SKILL.md 目录 |
| 触发 | `list_content_templates` | AI 读 SKILL.md 自动匹配 |

一个能力（如「编辑风格」）可以**双轨存在**：Skill 教工作流，模板提供样例。两者互补，不互斥。

---

## 3. 目标 Skill 架构（Phase 1 + Phase 2）

```
skills/
└── jpage/                      # 统一技能：上传中枢 + 内容生成 + 幻灯片 + 模板市场
    ├── SKILL.md                # 主技能文档
    └── assets/                 # reveal.js 引擎、主题、插件
```

**砍掉 `jpage-chart`**（与 Mermaid + dashboard 模板重叠）。

### 3.1 各 Skill 职责与触发词

| 能力 | 职责 | 触发词 | 落地阶段 |
|---|---|---|---|
| **jpage（统一 Skill）** | 上传、生成 HTML/Markdown、reveal.js 幻灯片、查模板市场仿风格 | "上传到即页""生成链接""生成 PPT""参照模板" | 已完成 |
| editorial（Skill 章节或独立指令） | 编辑/杂志风格排版 | "编辑风格""杂志排版""新闻稿" | Phase 2 |
| clone-ui（Skill 章节或独立指令） | 克隆网站/UI 风格 | "克隆这个网站""参考这个风格" | Phase 2 |

---

## 4. Phase 1 详细设计：jpage Skill 中的幻灯片能力

这是本轮最高优先级，设计要落到可执行颗粒度。该能力已并入统一 `jpage` Skill。

### 4.1 工作流（Bundle 模式）

```
用户："做一个关于 AI 趋势的 10 页 PPT，商务风格"
  │
  ▼
1. [可选] list_content_templates(scene="presentation", keyword="商务")
   → 若有匹配模板，获取 reveal.js 主题样例，学习配色/排版
  │
  ▼
2. 规划幻灯片结构（封面 / 章节分隔 / 内容 / 总结）
   结构语法沿用 revealjs-skill：1=水平页, N=垂直堆叠, d=分隔页
  │
  ▼
3. 生成多文件站点（写到磁盘）：
   presentation/
   ├── index.html          # reveal.js 容器 + <div class="slides">...</div>
   ├── assets/
   │   ├── reveal.css      # 选定主题（商务/学术/创意/极简）
   │   ├── reveal.js       # reveal.js 引擎（min，~85KB）
   │   └── plugin/         # markdown/highlight/notes 插件（按需）
   └── (无外部 CDN)
  │
  ▼
4. 关键配置：
   - Reveal.initialize({ embedded: true, hash: true, controls: true, ... })
   - <base> 由即页 bundle 渲染自动注入，资源相对路径指向 /api/files/:id/asset/
  │
  ▼
5. 上传（二选一，按客户端能力）：
   5a. 有 Bash（Claude Code）：Write 写盘 → zip -r → curl multipart POST /api/files/upload
       （二进制流式，reveal.js 不进 token 流，快）
   5b. 纯 MCP（Claude Desktop）：upload_file(name="presentation.zip", content=<base64>)
       （ZIP 自动判 bundle，返回 /s/:key；体积大时慢且费 token）
  │
  ▼
6. 返回 /s/:key，并提示用户「幻灯片翻页：iframe 内点击聚焦后用方向键，
   或点预览页"新窗口打开"按钮全屏查看」
```

### 4.2 与现有 Bundle 机制的契合点（无需改后端）

即页已有能力，**Phase 1 后端零改动**：

- `POST /api/files/upload`（multipart）和 `POST /api/files/upload-zip-base64`（MCP）都已支持 ZIP。
- 服务端按 ZIP 内容**自动判定**：含 `index.html` + 资源目录 → `is_bundle=1`，解压成目录存储。
- 渲染时自动注入 `<base href="/api/files/:id/asset/">`，reveal.js 的相对路径（`assets/reveal.js`）自然指向解压后的资源。
- 短链 `/s/:key` 直接渲染 bundle 入口。

**唯一需要确认的兼容点**（实现时验证，非阻塞）：

1. **iframe 键盘事件**：reveal.js `embedded: true` 让其依赖容器聚焦而非全局键盘；预览页加「新窗口打开」兜底。
2. **Bundle 的 `entry_path`**：需确认服务端把 ZIP 根的 `index.html` 识别为入口（看 `routes/files.js` 的 `extractBundle` 逻辑）。若 ZIP 内有顶层目录包裹，要保证 entry 指向该目录下的 index.html。

### 4.3 reveal.js 主题系统（成本在这里）

reveal.js 主题 = 30+ CSS 变量。四套主题的差异化全靠调这些变量 + 字体栈：

```css
/* 商务主题示例（变量驱动，非完整文件） */
:root {
  --r-background-color: #ffffff;
  --r-main-color: #1a1a1a;
  --r-heading-color: #0a4d8c;       /* 商务深蓝 */
  --r-link-color: #0a4d8c;
  --r-heading-font: 'PingFang SC', -apple-system, sans-serif;
  --r-main-font: -apple-system, 'Segoe UI', sans-serif;
  --r-code-font: 'SF Mono', Menlo, monospace;
  --r-section-number-color: #0a4d8c;
}
```

四套主题的**视觉差异定位**：

| 主题 | 主色基调 | 字体倾向 | 适用 |
|---|---|---|---|
| 商务 | 深蓝 + 白底 | 无衬线稳重 | 季度汇报、商业提案 |
| 学术 | 深灰 + 米白 | 衬线标题 | 论文答辩、学术分享 |
| 创意 | 高饱和渐变 | 几何无衬线 | 产品发布、创意提案 |
| 极简 | 黑白 + 一个强调色 | 大字号留白 | 极简主义、keynote 风 |

**工时如实标注**：每套主题（调色 + 排版 + 至少 3 种版式验证）≈ 1 天，四套 ≈ 4 天纯设计。

### 4.4 jpage Skill 中幻灯片章节骨架

```markdown
---
name: jpage
description: 即页统一技能：生成 HTML/Markdown 内容、制作 reveal.js 幻灯片、
  使用内容模板市场风格、上传到即页并管理文件。
version: 1.0.0
author: jpage
---

# 核心规则

用户要幻灯片/PPT/演示文稿时：
1. 先问/判断主题风格（默认商务），可选 list_content_templates(scene="presentation")
2. 规划结构（封面 → 章节分隔 → 内容页 → 总结）
3. 生成 reveal.js 网站包（index.html + assets/，embedded:true，无 CDN）
4. 打包 ZIP 上传（优先 curl multipart，退回 upload_file base64）
5. 返回 /s/:key，提示翻页方式

# 触发场景
- "生成 PPT""做幻灯片""演示文稿""做一个 deck"
- "Q3 汇报""产品发布""答辩 slides"

# 关键约束（区别于普通 HTML）
- 必须用 Bundle 模式（ZIP 含 index.html + assets/），不要单文件内联 reveal.js
- Reveal.initialize 必须设 embedded:true（iframe 兼容）
- 主题用 CSS 变量驱动，从商务/学术/创意/极简四套里选
- 每页 <section> 内容精简，避免溢出（reveal.js 不自动滚动）

# 主题选择对照
| 用户说 | 主题 |
|---|---|
| 商务/汇报/正式/提案 | 商务 |
| 学术/论文/答辩 | 学术 |
| 创意/产品/发布/活泼 | 创意 |
| 极简/简约/keynote 风 | 极简 |

# 上传方式（性能关键）
- 有 Bash：Write 写盘 → `zip -r deck.zip deck/` → curl multipart POST /api/files/upload
- 纯 MCP：upload_file(name="deck.zip", content=<base64>)（体积大时慢）

# 复用
- 上传环节统一走 jpage Skill 中的 upload_file 工具，不另造
```

### 4.5 Phase 1 改动清单（审阅用）

| 文件 | 改动 | 类型 |
|---|---|---|
| `skills/jpage/SKILL.md` | 新增 / 合并 | Skill |
| `skills/jpage/assets/themes/*.css` | 新增 4 套主题 | 资源（随 Skill ZIP 下发） |
| `skills/jpage/assets/reveal.js` | reveal.js 引擎 | 资源 |
| `migrations/013_add_presentation_scene.js` | content_templates 的 scene 预置 'presentation' 样例 | migration（可选） |
| 预览页前端 | 加「新窗口打开」按钮（iframe 键盘兜底） | 小改（可选，Phase 1.5） |
| 后端 routes/lib | **零改动** | — |

> 注：scene 枚举在 `routes/content-templates.js` 的 `CONTENT_TEMPLATE_SCENES` 数组里，加 `'presentation'` 是一行改动（非 migration）。

---

## 5. Phase 2 设计概要（editorial + clone-ui）

Phase 1 验证「Bundle Skill + 模板双轨」模式跑通后，Phase 2 按同模式增量。

### 5.1 editorial（编辑风格）

**启发**：iharnoor/html-everything（Archivo Black 标题 + Inter Tight 正文 + JetBrains Mono 数字）。

**落地选择**：**双轨**——
- 渲染模板 `templates/editorial.html`（第 5 套 Markdown 渲染模板，用户上传 MD 时可选）
- `jpage` Skill 新增「编辑风格」章节（编排：任意输入 → 编辑风格 HTML → 上传）

**改动**：
- `templates/editorial.html` 新增（注意：当前 `lib/templates.js` 的 `loadTemplates()` 自动扫描 `templates/*.html`，加文件即生效）
- `BUILTIN_TEMPLATE_THEMES` 加一行映射
- `skills/jpage/SKILL.md` 新增 editorial 章节
- 字体策略：Google Fonts CDN（编辑风格强依赖特定字体），或降级系统字体栈。**注意**：这破坏离线自包含，需在 SKILL.md 注明权衡。

### 5.2 clone-ui（UI 风格克隆）

**启发**：santowilem/skills 的 7 阶段反幻觉工作流。

**关键约束（决定能否落地）**：
- 原版输出 React/Vue 多文件项目 → 即页只收单文件 HTML。**Skill 指令必须强制纯 HTML 输出**。
- 原版依赖 Playwright 截图对比 → 即页运行环境无 Playwright。**移除验证阶段**，降级为「AI 自检 + 用户反馈迭代」。
- 原版的「学习系统」（lessons log）→ 简化为 Skill 内的「风格特征清单」。

**落地**：在 `skills/jpage/SKILL.md` 中新增 clone-ui 章节，零后端改动。输出单文件 HTML 走 `upload_file`。

---

## 6. 暂缓项（报告建议但本方案不纳入本轮）

| 报告建议 | 本方案态度 | 理由 |
|---|---|---|
| `jpage-chart` Skill | ❌ 砍掉 | 与 Mermaid + dashboard 模板重叠，伪需求 |
| 对接 Composio（800+ Skill） | ⏸ 暂缓 | 依赖 Composio 平台（Rube MCP 等），解耦成本高，收益远 |
| 对接 agentskills.so 市场 | ⏸ 暂缓 | 需 API 集成 + 动态加载安全模型，属 Phase 3 |
| 用户自定义 Skill 上传 | ⏸ 暂缓 | 需沙箱执行模型，安全风险大，单独立项 |
| Skill 评分/推荐系统 | ⏸ 暂缓 | 依赖前两项的数据积累 |

---

## 7. 实施路线图（已按报告修正）

### Phase 1（核心能力补齐，预计 1.5-2 周）

| 任务 | 工时 | 说明 |
|---|---|---|
| 验证 Bundle 渲染 reveal.js | 0.5 天 | 用一个手写 reveal.js ZIP 走 `/api/files/upload`，确认 `<base>` 注入 + 资源加载正常 |
| 4 套 reveal.js 主题 CSS | 4 天 | **含 UI 设计**：商务/学术/创意/极简，CSS 变量驱动 |
| `jpage` Skill SKILL.md（含幻灯片、模板市场、上传章节） | 1 天 | 触发词 + Bundle 工作流 + 上传方式 + iframe 注意事项 |
| presentation 场景模板预置 | 1 天 | scene 数组加项 + 1-2 个内置样例 |
| 预览页「新窗口打开」按钮 | 0.5 天 | iframe 键盘兜底（可选，Phase 1.5） |
| 端到端测试 | 1.5 天 | 4 主题 × MCP/curl 两通道 |

### Phase 2（风格多样化，Phase 1 验收后启动，2-3 周）

| 任务 | 工时 |
|---|---|
| `templates/editorial.html` + 主题映射 | 2 天 |
| `jpage` Skill 新增 editorial 章节 | 1 天 |
| `jpage` Skill 新增 clone-ui 章节（纯指令，限单文件输出） | 2 天 |
| 扩充内容模板至 15+（覆盖新 scene） | 3 天 |
| 文档更新（README、CLAUDE.md、docs/api.md） | 1 天 |

### Phase 3（生态对接，暂缓，待 Phase 2 数据积累后评估）

仅记录方向，不排期：外部 Skill 市场对接、用户自定义 Skill、评分推荐。

---

## 8. 风险与验证清单

落地前需逐项验证（实现阶段的 Definition of Done）：

| # | 验证点 | 方法 | 阻塞性 |
|---|---|---|---|
| 1 | ZIP 含顶层目录时 entry_path 是否正确 | 手写带包裹目录的 reveal.js ZIP 上传，看渲染 | 🔴 高（若错，Bundle 模式不可用） |
| 2 | reveal.js `embedded:true` 在即页 iframe 内翻页是否可用 | 浏览器实测方向键/空格 | 🟡 中（不可用则强依赖新窗口按钮） |
| 3 | `<base>` 注入后 reveal.js 插件相对路径加载正常 | 打开 DevTools Network 看资源 200 | 🔴 高 |
| 4 | upload_file 的 base64 ZIP 在 ~200KB reveal.js 体积下耗时 | 实测 token 流耗时 | 🟡 中（决定是否主推 curl 通道） |
| 5 | 四套主题在深色/浅色系统模式下都不崩 | 切系统主题逐套看 | 🟢 低 |

**建议**：Phase 1 开工第一件事是验证 #1 和 #3（半小时手写一个最小 reveal.js ZIP 跑通），若 Bundle 对 reveal.js 不兼容，回退到 CDN 模式（牺牲离线卖点但不阻塞）。

---

## 9. 开放问题（需你拍板，非阻塞）

1. **reveal.js 资源分发**：Phase 1 是否接受「reveal.js 随每个 Skill ZIP 下发一份」（~85KB × 多 Skill 重复）？还是抽到 `skills/_shared/`？后者要改 registry。
2. **editorial 字体**：Google Fonts CDN（破坏离线）vs 系统字体栈（风格打折）？倾向 CDN + SKILL.md 注明权衡。
3. **clone-ui 的 Playwright 验证**：是否值得在 Phase 2 给即页加可选的 Playwright 校验能力（显著增加复杂度）？倾向不加，靠 AI 自检。
