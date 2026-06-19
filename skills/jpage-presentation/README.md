# jpage-presentation

用自然语言生成基于 [reveal.js](https://revealjs.com/) 的自包含幻灯片，上传到即页后返回分享链接。

支持四套主题：

| 主题 | 文件 | 主色 | 适用场景 |
|---|---|---|---|
| 商务 | `assets/themes/business.css` | 深蓝 + 白底 | 季度汇报、商业提案、年终总结 |
| 学术 | `assets/themes/academic.css` | 深灰 + 米白、衬线标题 | 论文答辩、学术分享、研究报告 |
| 创意 | `assets/themes/creative.css` | 高饱和深底渐变 | 产品发布、创意提案、活动 keynote |
| 极简 | `assets/themes/minimal.css` | 黑白 + 蓝色强调 | 极简主义、keynote/苹果风 |

## 为什么用 Bundle 模式

reveal.js 引擎 ~112KB。若内联进每个幻灯片 HTML，10 个 PPT 就要重复 10 份引擎代码。即页的 **Bundle 机制**（ZIP 解压成目录 + `<base>` 注入）让 reveal.js 作为公共资源放一次，多张幻灯片复用，且**离线可预览**（不依赖 CDN）。

## 工作流

```
用户："做一个 Q3 汇报 PPT，商务风格"
  ↓
1. 选商务主题
2. 规划结构（封面 / 内容 / 分隔 / 总结）
3. 生成 deck/（index.html + assets/，assets 含 reveal.js + 主题 CSS）
4. 打 ZIP 上传到即页（bundle 自动识别）
5. 返回 /s/<share_key>
```

## 目录结构

```
jpage-presentation/
├── SKILL.md                    # AI 工作流指令（核心）
├── README.md                   # 本文件
├── INSTALL.md                  # 安装说明
└── assets/                     # 随包下发的 reveal.js 资源
    ├── reveal.js               # reveal.js 5.x 引擎（112KB）
    ├── reveal-base.css         # reveal.js 基础布局（54KB，必须）
    ├── themes/
    │   ├── business.css        # 商务主题（CSS 变量驱动）
    │   ├── academic.css        # 学术主题
    │   ├── creative.css        # 创意主题
    │   └── minimal.css         # 极简主题
    └── plugin/
        ├── highlight/          # 代码高亮（monokai 主题 + 加载器；highlight.js 按需获取）
        └── notes/              # 演讲者备注
```

## 关键技术决策

- **`embedded: true`**：reveal.js 必须配置此项，适配即页预览的 iframe 沙箱（父页面会抢方向键/空格，`embedded` 让 reveal 依赖容器点击聚焦）。
- **禁用 CDN**：所有资源打进 `assets/`，保证内网/断网可预览。
- **两个 CSS**：`reveal-base.css`（基础布局，必须）+ `theme.css`（四选一，覆盖 CSS 变量）。顺序：base 在前，theme 在后。
- **上传通道**：有 Bash 时走 curl multipart（二进制流式，快）；纯 MCP 走 `upload_file` 的 base64（体积大时慢且费 token）。

## 验证状态

| 验证项 | 结果 |
|---|---|
| Bundle 分类（flat 结构）| ✅ 通过（根级 index.html + assets/ 判为 bundle）|
| Bundle 分类（wrapped 结构）| ✅ 通过（套顶层目录也能判 bundle）|
| `<base>` 注入 + 资源 200 | ✅ 通过（reveal.js / theme.css / reveal-base.css 全 200）|
| wrapped 包资源 404 bug | ✅ 已修复（`<base>` 指向 entry 所在目录而非 bundle 根）|
| 测试套件回归 | ✅ 173/173 通过 |
| iframe 内 embedded 翻页 | ⏳ 需浏览器实测（设计上 `embedded:true` 规避抢键）|

## 致谢

- [reveal.js](https://revealjs.com/) by Hakim El Hattab（MIT 许可）—— 幻灯片引擎
- [ryanbbrown/revealjs-skill](https://github.com/ryanbbrown/revealjs-skill) —— 脚手架思路与结构语法的灵感来源
