# jpage（即页）品牌视觉资产包

## 品牌概述

| 属性 | 说明 |
|------|------|
| **品牌名** | 即页 / jpage |
| **品牌色** | 深蓝 `#2563EB` → 青色 `#06B6D4` 渐变 |
| **辅助色** | 深炭 `#1E293B`（文字）、白色 `#FFFFFF` |
| **品牌标语** | 拖入文件，即刻成页 |
| **设计风格** | 现代科技、简洁扁平、代码文档融合 |

---

## 图标资产清单

### 核心图标

| 文件名 | 尺寸 | 背景 | 用途 |
|--------|------|------|------|
| `jpage_logo_main.png` | 1:1 方形 | 透明 | **主Logo**，用于网站导航栏、About页面、GitHub头像、产品展示 |
| `jpage_logo_horizontal.png` | 3:2 横向 | 白色 | **中文品牌Logo**，含「即页」文字，用于网站Header、文档页头 |
| `jpage_logo_en_horizontal.png` | 3:2 横向 | 白色 | **英文品牌Logo**，含「jpage」文字，用于英文文档、npm页面、国际化场景 |

### 场景适配变体

| 文件名 | 尺寸 | 背景 | 用途 |
|--------|------|------|------|
| `jpage_icon_pwa_circle.png` | 1:1 圆形 | 透明 | **PWA/App图标**，用于 manifest.json、添加到主屏幕图标、iOS touch icon |
| `jpage_logo_darkmode.png` | 1:1 方形 | 透明 | **暗色模式Logo**，用于深色主题Header、暗色背景展示，更高亮度对比 |
| `jpage_logo_white.png` | 1:1 方形 | 透明 | **单色白版本**，用于深色背景叠加、水印、打印材料、Footer |

### 营销与展示

| 文件名 | 尺寸 | 背景 | 用途 |
|--------|------|------|------|
| `jpage_og_banner.png` | 16:9 宽屏 | 渐变 | **OG分享图**，用于 Twitter/X、微信、Facebook 等社交分享时的预览卡片 |
| `jpage_hero_bg.png` | 16:9 宽屏 | 渐变 | **落地页Hero背景**，用于网站首屏大背景，营造产品氛围 |

---

## HTML 集成代码

### Favicon 完整配置

在 `public/index.html` 的 `<head>` 中添加：

```html
<!-- 标准 Favicon -->
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">

<!-- Apple Touch Icon -->
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">

<!-- PWA Manifest -->
<link rel="manifest" href="/site.webmanifest">

<!-- Safari Pinned Tab -->
<link rel="mask-icon" href="/safari-pinned-tab.svg" color="#2563EB">

<!-- MS Tile Color -->
<meta name="msapplication-TileColor" content="#2563EB">
<meta name="theme-color" content="#2563EB">
```

### Open Graph 社交分享

```html
<meta property="og:title" content="即页 jpage — 零配置 HTML/Markdown 即时预览与分享">
<meta property="og:description" content="拖入文件，即刻成页。零配置的文档即时预览与分享工具，支持 Markdown 增强渲染、代码高亮、数学公式、Mermaid 图表。">
<meta property="og:image" content="https://your-domain.com/jpage_og_banner.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:type" content="website">

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://your-domain.com/jpage_og_banner.png">
```

### 网站 Header Logo

```html
<!-- 亮色模式 -->
<a href="/" class="logo">
  <img src="/jpage_logo_horizontal.png" alt="即页 jpage" width="140" height="93">
</a>

<!-- 暗色模式切换 -->
<a href="/" class="logo dark">
  <img src="/jpage_logo_darkmode.png" alt="即页 jpage" width="40" height="40">
  <span class="brand-text">即页</span>
</a>
```

### PWA Manifest 配置

```json
{
  "name": "即页 jpage",
  "short_name": "即页",
  "description": "零配置 HTML/Markdown 即时预览与分享工具",
  "icons": [
    {
      "src": "/jpage_icon_pwa_circle.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ],
  "theme_color": "#2563EB",
  "background_color": "#F0F9FF",
  "display": "standalone",
  "start_url": "/"
}
```

---

## 文件放置建议

```
public/
├── favicon.ico              ← 从 jpage_logo_main.png 转换的 ico 文件
├── favicon-16x16.png        ← jpage_logo_main.png 缩放
├── favicon-32x32.png        ← jpage_logo_main.png 缩放
├── apple-touch-icon.png     ← jpage_icon_pwa_circle.png 缩放至 180x180
├── safari-pinned-tab.svg    ← 从 jpage_logo_white.png 矢量化转换
├── jpage_logo_main.png      ← 主Logo（原始尺寸）
├── jpage_logo_horizontal.png
├── jpage_logo_en_horizontal.png
├── jpage_logo_darkmode.png
├── jpage_logo_white.png
├── jpage_icon_pwa_circle.png
├── jpage_og_banner.png
├── jpage_hero_bg.png
└── site.webmanifest
```

---

## CSS 使用参考

```css
/* 品牌色变量 */
:root {
  --jpage-primary: #2563EB;
  --jpage-secondary: #06B6D4;
  --jpage-gradient: linear-gradient(135deg, #2563EB 0%, #06B6D4 100%);
  --jpage-text: #1E293B;
  --jpage-bg-light: #F0F9FF;
}

/* Logo 尺寸规范 */
.logo-main { width: 40px; height: 40px; }
.logo-header { width: 120px; height: auto; }
.logo-hero { width: 160px; height: auto; }

/* Hero 背景 */
.hero-section {
  background: url('/jpage_hero_bg.png') center/cover no-repeat;
  background-color: #F0F9FF;
}
```

---

## 注意事项

1. **缩放规范**：主图标在小尺寸（< 32px）时，建议直接使用 `jpage_logo_white.png` 的剪影效果或预先生成专用小图标
2. **暗色模式**：`jpage_logo_darkmode.png` 已针对暗色背景优化了亮度和对比度，请勿在亮色背景下使用
3. **透明背景**：所有 PNG 均为透明背景，可安全叠加到任何颜色背景上
4. **打印场景**：打印时建议使用 `jpage_logo_white.png` 的单色版本，确保黑白打印效果清晰
5. **版权声明**：本品牌资产基于 MIT 许可证发布，与 jpage 项目许可证一致
