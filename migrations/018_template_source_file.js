// 内容模板市场：记录模板来源文件，支持「文件列表上架」流程。
//
// - source_file_id：模板快照自哪个 file.id（上架时记录，可空兼容旧数据）。
// - 防重逻辑放应用层（一文件一模板），故本迁移只加列+索引，不加 UNIQUE 约束
//   （SQLite UNIQUE 对 NULL 不生效，且应用层校验更灵活）。

module.exports = {
  name: 'template_source_file',

  async up(db, { dbRun, dbAll }) {
    const cols = await dbAll(db, 'PRAGMA table_info(content_templates)');
    const names = new Set(cols.map(c => c.name));
    if (!names.has('source_file_id')) {
      await dbRun(db, 'ALTER TABLE content_templates ADD COLUMN source_file_id INTEGER');
    }
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_ct_source_file ON content_templates(source_file_id)');
  }
};
