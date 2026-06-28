// 为内容模板市场增加查看次数统计，用于在市场列表/详情展示热度。
// 与 020 迁移删除的旧 view_count 语义相同，因当时功能未落地；现在重新启用。

module.exports = {
  name: 'template_view_count',

  async up(db, { dbRun, dbAll }) {
    const cols = await dbAll(db, 'PRAGMA table_info(content_templates)');
    const colNames = new Set(cols.map(c => c.name));

    if (!colNames.has('view_count')) {
      await dbRun(db, 'ALTER TABLE content_templates ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0');
    }

    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_content_templates_view_count ON content_templates(view_count)');
  }
};
