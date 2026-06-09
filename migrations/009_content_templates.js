const BUILTIN_TEMPLATES = [
  {
    title: '深色数据仪表板',
    description: '深色主题的数据仪表板，使用 CSS Grid 布局，包含统计卡片和图表区域。适合数据可视化、监控面板。',
    file_type: 'html',
    scene: 'dashboard',
    style_tags: 'dark,grid,chart,card',
    content: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>数据仪表板</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 24px; }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 24px; color: #f1f5f9; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
  .stat-card .label { font-size: 13px; color: #94a3b8; margin-bottom: 8px; }
  .stat-card .value { font-size: 28px; font-weight: 700; color: #f1f5f9; }
  .stat-card .change { font-size: 12px; margin-top: 4px; }
  .stat-card .change.up { color: #34d399; }
  .stat-card .change.down { color: #f87171; }
  .chart-area { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
  .chart-card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; min-height: 300px; }
  .chart-card h3 { font-size: 14px; color: #94a3b8; margin-bottom: 16px; font-weight: 500; }
  .bar-chart { display: flex; align-items: flex-end; gap: 8px; height: 200px; padding-top: 16px; }
  .bar { flex: 1; border-radius: 4px 4px 0 0; min-height: 20px; transition: opacity .2s; }
  .bar:hover { opacity: 0.8; }
  .legend { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
  .legend-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #cbd5e1; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
</style>
</head>
<body>
  <h1>数据仪表板</h1>
  <div class="stats">
    <div class="stat-card">
      <div class="label">总用户数</div>
      <div class="value">12,847</div>
      <div class="change up">+12.5%</div>
    </div>
    <div class="stat-card">
      <div class="label">日活跃用户</div>
      <div class="value">3,421</div>
      <div class="change up">+8.3%</div>
    </div>
    <div class="stat-card">
      <div class="label">平均会话时长</div>
      <div class="value">4m 32s</div>
      <div class="change down">-2.1%</div>
    </div>
    <div class="stat-card">
      <div class="label">转化率</div>
      <div class="value">6.8%</div>
      <div class="change up">+0.5%</div>
    </div>
  </div>
  <div class="chart-area">
    <div class="chart-card">
      <h3>月度趋势</h3>
      <div class="bar-chart">
        <div class="bar" style="height:60%;background:#6366f1"></div>
        <div class="bar" style="height:75%;background:#6366f1"></div>
        <div class="bar" style="height:50%;background:#6366f1"></div>
        <div class="bar" style="height:90%;background:#8b5cf6"></div>
        <div class="bar" style="height:70%;background:#6366f1"></div>
        <div class="bar" style="height:85%;background:#8b5cf6"></div>
        <div class="bar" style="height:65%;background:#6366f1"></div>
        <div class="bar" style="height:95%;background:#a78bfa"></div>
        <div class="bar" style="height:80%;background:#8b5cf6"></div>
        <div class="bar" style="height:100%;background:#a78bfa"></div>
        <div class="bar" style="height:88%;background:#8b5cf6"></div>
        <div class="bar" style="height:92%;background:#a78bfa"></div>
      </div>
    </div>
    <div class="chart-card">
      <h3>来源分布</h3>
      <div class="legend">
        <div class="legend-item"><span class="legend-dot" style="background:#6366f1"></span>直接访问 35%</div>
        <div class="legend-item"><span class="legend-dot" style="background:#8b5cf6"></span>搜索引擎 28%</div>
        <div class="legend-item"><span class="legend-dot" style="background:#a78bfa"></span>社交媒体 22%</div>
        <div class="legend-item"><span class="legend-dot" style="background:#c4b5fd"></span>推荐链接 15%</div>
      </div>
    </div>
  </div>
</body>
</html>`
  },
  {
    title: '项目周报',
    description: '结构清晰的项目周报 Markdown 模板，包含本周进展、风险问题、下周计划等标准章节。',
    file_type: 'markdown',
    scene: 'report',
    style_tags: 'structured,weekly,team',
    content: `# 项目周报 — 第 24 周

> 2026-06-08 ~ 2026-06-14

## 本周概要

| 指标 | 目标 | 实际 | 状态 |
|------|------|------|------|
| 需求交付 | 5 | 4 | 🟡 进行中 |
| 缺陷修复 | 8 | 8 | ✅ 完成 |
| 代码审查 | 10 | 12 | ✅ 超额 |

## 重点工作进展

### 1. 用户认证模块重构
- **负责人**：张三
- **进度**：80%
- **完成项**：JWT 令牌签发、刷新机制、单元测试
- **待完成**：OAuth 第三方登录对接

### 2. 数据导出功能
- **负责人**：李四
- **进度**：100%
- **完成项**：CSV/Excel 导出、异步任务队列、进度通知

## 风险与问题

| # | 描述 | 影响 | 应对措施 | 负责人 |
|---|------|------|----------|--------|
| 1 | 第三方 API 响应变慢 | 中 | 增加超时重试和本地缓存 | 王五 |
| 2 | 测试环境磁盘空间不足 | 低 | 清理历史数据，申请扩容 | 运维 |

## 下周计划

1. 完成用户认证模块重构（含 OAuth）
2. 启动报表可视化需求开发
3. 组织代码规范评审会议

## 备注

本周三进行了全员安全培训，周五发布了 v1.3.0 版本。`
  },
  {
    title: '极简落地页',
    description: '现代极简风格的产品落地页，包含 Hero 区域、特性展示和 CTA 按钮。适合产品介绍、活动推广。',
    file_type: 'html',
    scene: 'landing',
    style_tags: 'minimal,gradient,modern,cta',
    content: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>产品落地页</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', sans-serif; color: #1a1a2e; background: #fff; }
  .hero { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 40px 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; }
  .hero h1 { font-size: clamp(32px, 5vw, 56px); font-weight: 800; line-height: 1.2; margin-bottom: 16px; }
  .hero p { font-size: 18px; opacity: 0.9; max-width: 560px; line-height: 1.6; margin-bottom: 32px; }
  .btn-group { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
  .btn { display: inline-block; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 600; text-decoration: none; transition: transform .2s, box-shadow .2s; cursor: pointer; border: none; }
  .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.15); }
  .btn-primary { background: #fff; color: #667eea; }
  .btn-outline { background: transparent; color: #fff; border: 2px solid rgba(255,255,255,0.6); }
  .features { padding: 80px 24px; max-width: 960px; margin: 0 auto; }
  .features h2 { text-align: center; font-size: 32px; margin-bottom: 48px; color: #1a1a2e; }
  .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 32px; }
  .feature-card { text-align: center; padding: 32px 24px; border-radius: 12px; background: #f8f9ff; }
  .feature-icon { font-size: 40px; margin-bottom: 16px; }
  .feature-card h3 { font-size: 18px; margin-bottom: 8px; }
  .feature-card p { font-size: 14px; color: #64748b; line-height: 1.6; }
  footer { text-align: center; padding: 40px 24px; color: #94a3b8; font-size: 14px; border-top: 1px solid #e2e8f0; }
</style>
</head>
<body>
  <section class="hero">
    <h1>让创作回归简单</h1>
    <p>一站式内容管理与分享平台，拖入文件即可获得预览链接。支持 HTML、Markdown，与 AI 深度集成。</p>
    <div class="btn-group">
      <a class="btn btn-primary" href="#">立即开始</a>
      <a class="btn btn-outline" href="#">了解更多</a>
    </div>
  </section>
  <section class="features">
    <h2>核心特性</h2>
    <div class="feature-grid">
      <div class="feature-card">
        <div class="feature-icon">⚡</div>
        <h3>即时预览</h3>
        <p>上传即生成预览链接，零配置，无需构建工具</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🎨</div>
        <h3>多套模板</h3>
        <p>内置多种渲染风格，一键切换外观</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🤖</div>
        <h3>AI 集成</h3>
        <p>MCP 协议原生支持，AI 直接上传和分享内容</p>
      </div>
    </div>
  </section>
  <footer>© 2026 即页 — 让创作回归简单</footer>
</body>
</html>`
  }
];

module.exports = {
  name: 'add_content_templates',
  async up(db, { dbRun, dbGet, dbAll }) {
    await dbRun(db, `CREATE TABLE IF NOT EXISTS content_templates (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      description  TEXT,
      file_type    TEXT NOT NULL DEFAULT 'html',
      scene        TEXT,
      style_tags   TEXT,
      content      TEXT NOT NULL,
      uploaded_by  INTEGER,
      use_count    INTEGER NOT NULL DEFAULT 0,
      is_public    INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_ct_scene ON content_templates(scene)`);
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_ct_use_count ON content_templates(use_count DESC)`);

    for (const t of BUILTIN_TEMPLATES) {
      await dbRun(db, `INSERT INTO content_templates (title, description, file_type, scene, style_tags, content, use_count, is_public) VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
        [t.title, t.description, t.file_type, t.scene, t.style_tags, t.content]);
    }
  }
};
