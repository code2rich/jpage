# 补齐加载状态（骨架屏/进度条/spinner）

## 背景

当前前端为纯 vanilla JS，无框架无构建。部分场景有基础的加载提示（如文件列表显示"正在加载…"），但体验粗糙且不统一。需要在所有异步操作中补齐加载状态，统一视觉风格，提升用户感知。

## 现状分析

| 场景 | 当前行为 | 问题 |
|------|---------|------|
| 文件列表加载 | `list.textContent = '正在加载…'` 纯文字 | 无视觉节奏感，与卡片列表布局差距大 |
| Skills 列表加载 | 同上，纯文字 | 同上 |
| 文件上传 | 无进度反馈，仅禁用上传区 | 大文件上传时用户无感知 |
| 预览页 iframe 加载 | 无任何提示，iframe 空白 | 用户看到长时间白屏 |
| 预览页源码加载 | 无提示，直接填充 | 极端情况短暂空白 |
| 登录提交 | `submit.textContent = '登录中…'` | 文字替换，可接受 |
| 删除/重命名确认后 | 按钮 `disabled`，无额外反馈 | 可接受 |
| Skill 详情弹窗 | 先弹窗再加载内容，有闪烁 | 内容区域无加载占位 |
| MCP 配置弹窗 | `statusEl.innerHTML = '加载中…'` 纯文字 | 与弹窗风格不搭 |
| 页面初始化（`fetchCurrentUser`） | 无任何提示 | 白屏直到路由完成 |

## 设计方案

### 统一加载组件

新增 3 个可复用的 CSS 组件，全部纯 CSS 实现（无额外 JS 依赖）：

#### 1. 骨架屏（Skeleton）

用于**列表类内容**的加载占位，模拟最终布局形状。

```html
<!-- 文件列表骨架示例 -->
<div class="skeleton skeleton-card" aria-hidden="true">
  <div class="skeleton-avatar"></div>
  <div class="skeleton-lines">
    <div class="skeleton-line skeleton-line-lg"></div>
    <div class="skeleton-line skeleton-line-sm"></div>
  </div>
</div>
```

```css
/* 基础 */
.skeleton {
  background: var(--border);
  border-radius: var(--radius-sm);
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}
@keyframes skeleton-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

/* 文件卡片骨架 */
.skeleton-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
}
.skeleton-avatar {
  width: 40px; height: 40px;
  border-radius: var(--radius-sm);
}
.skeleton-lines { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.skeleton-line { height: 12px; width: 100%; }
.skeleton-line-lg { width: 60%; }
.skeleton-line-sm { width: 40%; }
```

#### 2. 条形进度条（Progress Bar）

用于**文件上传**等有明确进度的操作。HTML 中已有 `#upload-progress` 容器，补充 CSS 动画即可。

```css
.upload-progress {
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
  position: relative;
}
.upload-progress-bar {
  height: 100%;
  background: var(--primary);
  border-radius: 2px;
  transition: width 0.2s ease;
}
```

JS 侧使用 `XMLHttpRequest` 替代当前 `fetch` 上传，监听 `progress` 事件获取百分比。

#### 3. Spinner（旋转指示器）

用于**页面级加载**和**弹窗内容加载**。

```html
<div class="spinner-container" role="status" aria-label="加载中">
  <div class="spinner"></div>
</div>
```

```css
.spinner {
  width: 28px; height: 28px;
  border: 3px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.spinner-container {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 32px;
}
```

### 各场景实施方案

#### S1. 文件列表加载 → 骨架屏

**改动文件**: `app.js` → `loadFiles()`

```
- list.textContent = '正在加载…';
+ list.innerHTML = buildSkeletonCards(5);  // 生成 5 个骨架卡片
```

`buildSkeletonCards(n)` 返回 n 个 `.skeleton-card` 的 HTML 字符串。数据返回后替换为真实卡片。

#### S2. Skills 列表加载 → 骨架屏

**改动文件**: `app.js` → `loadSkillsForModal()`

同样使用 `buildSkeletonCards(3)` 替换纯文字。

#### S3. 文件上传 → 进度条

**改动文件**: `app.js` → `uploadFile()`

- 将 `fetch` 替换为 `XMLHttpRequest`
- 监听 `xhr.upload.onprogress`，计算百分比更新 `#upload-progress-bar` 宽度和 `#upload-progress-text`
- 上传开始时 `display: block` 显示进度条，完成后隐藏
- 进度条 HTML 已存在于 `index.html:68-71`

#### S4. 预览页 iframe 加载 → Spinner 覆盖层

**改动文件**: `index.html`（preview-template 内）、`app.js` → `renderPreview()`、`style.css`

在 `.preview-container` 内新增 spinner 覆盖层：

```html
<div class="preview-loading" id="preview-loading">
  <div class="spinner"></div>
  <p>正在加载预览…</p>
</div>
```

CSS 使其绝对定位覆盖 iframe 区域。iframe `load` 事件触发后移除覆盖层。

#### S5. Skill 详情弹窗 → Spinner

**改动文件**: `app.js` → `openSkillModal()`

弹窗 body 区域先渲染 spinner，数据返回后替换为真实内容。解决当前"先弹窗后加载"的闪烁问题。

#### S6. MCP 配置弹窗 → Spinner

**改动文件**: `app.js` → `openMcpConfigModal()`

`statusEl` 初始内容改为 spinner + "加载中…"，替代纯文字。

#### S7. 页面初始化 → 全屏 Spinner（可选）

**改动文件**: `index.html`、`app.js`

在 `#app` 内放置初始 spinner，`fetchCurrentUser` + `route()` 完成后替换。优先级低（通常 < 200ms），可视情况省略。

### 不改动的场景

| 场景 | 原因 |
|------|------|
| 登录按钮 `登录中…` | 文字替换已足够，按钮有 disabled 状态 |
| 删除/重命名确认后 | 按钮 disabled + toast 提示已足够 |
| 预览页源码加载 | 与 iframe 加载同步，不会单独白屏 |

## CSS 深色模式适配

骨架屏和 spinner 使用 CSS 变量（`--border`、`--primary`），深色模式下自动适配，无需额外 media query。进度条同理。

## 无障碍

- 骨架屏标记 `aria-hidden="true"`（装饰性）
- Spinner 容器标记 `role="status"` + `aria-label="加载中"`
- 文件列表保持 `aria-busy="true"` 属性
- 进度条使用 `aria-valuenow`、`aria-valuemin`、`aria-valuemax`

## 改动范围汇总

| 文件 | 改动内容 |
|------|---------|
| `public/css/style.css` | 新增 skeleton / spinner / progress bar 样式（~60 行） |
| `public/js/app.js` | `loadFiles`、`loadSkillsForModal`、`uploadFile`、`renderPreview`、`openSkillModal`、`openMcpConfigModal` 中替换加载逻辑（~80 行改动） |
| `public/index.html` | preview-template 内新增 `#preview-loading` 覆盖层（~4 行） |

无新增依赖，无构建步骤变更，不影响后端。
