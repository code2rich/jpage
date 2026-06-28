# 即页模板市场设计系统

> 目标：让即页模板市场的所有 HTML 模板具备统一的视觉语言、精致的交互体验与可替换的真实内容结构。

---

## 一、设计原则

1. **统一而非单调**：所有模板共享基础设计系统（色彩、字体、间距、圆角、阴影），但允许每个模板有独特的主题色和插画风格。
2. **内容优先**：模板不是视觉壳，而是包含完整、真实、可替换的行业内容。
3. **轻交互**：在不依赖复杂 JS 的前提下，使用 CSS 实现 hover、过渡、计数、tab 切换等微交互。
4. **响应式优先**：每个模板必须在桌面端和移动端都有良好体验。
5. **无障碍**：颜色对比度符合 WCAG AA，语义化 HTML 标签。

---

## 二、色彩系统

### 基础色板

| 名称 | 变量 | 色值 | 用途 |
|---|---|---|---|
| 主色 | `--primary` | `#4f46e5` | 按钮、链接、强调 |
| 主色深 | `--primary-dark` | `#4338ca` | hover 状态 |
| 次要色 | `--secondary` | `#06b6d4` | 辅助高亮、渐变 |
| 强调色 | `--accent` | `#f59e0b` | 标签、徽章、促销 |
| 成功色 | `--success` | `#10b981` | 正向指标、完成状态 |
| 警告色 | `--warning` | `#f59e0b` | 提醒、中等风险 |
| 危险色 | `--danger` | `#ef4444` | 错误、高风险、删除 |
| 背景 | `--bg` | `#ffffff` | 页面背景 |
| 背景次 | `--bg-soft` | `#f8fafc` | 卡片、section 背景 |
| 文字主 | `--text` | `#0f172a` | 标题、正文 |
| 文字次 | `--text-muted` | `#64748b` | 说明文字、辅助信息 |
| 边框 | `--border` | `#e2e8f0` | 卡片边框、分隔线 |

### 主题色扩展

每个模板可基于基础色板选择一个主色调，通过 HSL 调整饱和度/明度生成完整的主题梯度：

```css
--theme-50: hsl(var(--theme-hue), 90%, 96%);
--theme-100: hsl(var(--theme-hue), 85%, 92%);
--theme-500: hsl(var(--theme-hue), 75%, 50%);
--theme-600: hsl(var(--theme-hue), 80%, 42%);
--theme-900: hsl(var(--theme-hue), 70%, 18%);
```

模板主题色参考：
- 商务/企业：hue 230（蓝紫）
- 科技/AI：hue 190（青）
- 金融/数据：hue 210（深蓝）
- 生活/餐饮：hue 25（暖橙）
- 婚礼/活动：hue 340（玫瑰）
- 健康/自然：hue 150（绿）
- 创意/艺术：hue 280（紫）

---

## 三、字体系统

### 字体栈

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

### 字号比例

| 级别 | 大小 | 字重 | 行高 | 用途 |
|---|---|---|---|---|
| Display | 48-64px | 800 | 1.1 | 页面主标题 |
| H1 | 36-40px | 700 | 1.2 | Section 标题 |
| H2 | 24-28px | 600 | 1.3 | 卡片标题 |
| H3 | 18-20px | 600 | 1.4 | 小标题 |
| Body | 15-16px | 400 | 1.7 | 正文 |
| Small | 13-14px | 400 | 1.5 | 辅助说明 |
| Caption | 11-12px | 500 | 1.4 | 标签、时间 |

---

## 四、间距系统

基于 4px 网格：

| Token | 值 |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 24px |
| `--space-6` | 32px |
| `--space-7` | 48px |
| `--space-8` | 64px |
| `--space-9` | 96px |

Section 垂直间距统一使用 `--space-8` 到 `--space-9`（64-96px）。

---

## 五、组件规范

### 按钮

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px 24px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 15px;
  text-decoration: none;
  transition: all 0.2s ease;
  border: none;
  cursor: pointer;
}
.btn-primary {
  background: var(--primary);
  color: white;
  box-shadow: 0 4px 14px rgba(79, 70, 229, 0.3);
}
.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 22px rgba(79, 70, 229, 0.4);
  background: var(--primary-dark);
}
```

### 卡片

```css
.card {
  background: white;
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 32px rgba(0,0,0,0.08);
}
```

### 徽章/标签

```css
.badge {
  display: inline-flex;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: var(--theme-100);
  color: var(--theme-600);
}
```

### 输入框

```css
.input {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 15px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}
```

---

## 六、动效规范

### 过渡曲线

```css
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
```

### 常用动效

| 效果 | 时长 | 用途 |
|---|---|---|
| Hover 抬升 | 0.2s | 卡片、按钮 |
| 颜色过渡 | 0.2s | 链接、按钮 |
| 数字计数 | 1.5s | KPI、统计数据 |
| Tab 内容切换 | 0.3s | 内容切换 |
| 进度条填充 | 1s | 加载、预算 |
| 淡入上移 | 0.6s | 进入视口元素 |

### 禁止过度动画

- 不使用自动播放的复杂动画
- 不使用闪烁、跑马灯等干扰性效果
- 动画必须可通过 `prefers-reduced-motion` 关闭

---

## 七、响应式断点

```css
/* Mobile first */
@media (min-width: 640px) { /* sm */ }
@media (min-width: 768px) { /* md */ }
@media (min-width: 1024px) { /* lg */ }
@media (min-width: 1280px) { /* xl */ }
```

默认布局为移动端，通过 `@media (min-width: 768px)` 切换到桌面布局。

---

## 八、视觉元素规范

### 图标

- 优先使用 inline SVG，保证清晰度和一致性
- 其次使用 emoji 作为装饰元素
- 不使用外部图标字体或图片

### 插画

- 使用 CSS 渐变、几何形状、clip-path 构建抽象插画
- 每个模板可有一组 2-3 个主题色块组成的主视觉
- 避免使用真实人物照片或复杂场景

### 数据可视化

- 使用纯 CSS 实现柱状图、折线图、饼图、进度条
- 图表必须包含坐标轴、标签、图例
- 数据使用真实合理的数值范围

---

## 九、内容真实化规范

### 文案

- 使用真实公司名、产品名、人名（可虚构但符合中文习惯）
- 数据使用合理区间，避免 123/456/789 等明显占位
- 段落至少 2-3 句完整说明，不堆砌标题

### 结构

- 专业模板必须包含行业标准章节
  - PRD：背景、目标、用户故事、功能需求、非功能需求、验收标准、里程碑
  - 仪表盘：KPI、趋势图、来源分布、TOP 列表、异常提醒
  - 落地页：Hero、痛点、方案、特性、社会证明、CTA、FAQ

### 可替换标记

- 关键可替换内容用明显的容器包裹，并在注释中标注 `<!-- 替换：公司名 -->`

---

## 十、模板检查清单

每个模板上线前必须检查：

- [ ] 使用本设计系统的基础变量
- [ ] 有明确的主题色和一致的视觉风格
- [ ] 包含 `<meta name="description">`
- [ ] 响应式，移动端体验良好
- [ ] 至少包含 2 种微交互（hover、过渡、计数、进度条等）
- [ ] 内容是真实、完整、可替换的
- [ ] 专业模板包含行业标准结构
- [ ] 不使用外部图片或字体
- [ ] 通过 W3C HTML 基本验证（无未闭合标签）
- [ ] 文件大小在 10KB-30KB 之间
