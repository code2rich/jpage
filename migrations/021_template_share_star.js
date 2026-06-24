// 模板分享短链 + 收藏：为市场详情页的「复制链接 / 收藏」功能建表。
//
// - content_templates.share_key：模板公开短链 key（/t/:key 渲染）。
//   仅 approved+visible 模板生成后才对外可见，但字段本身对所有模板无害。
//   NULL 表示尚未生成短链；生成时写唯一随机串。
// - starred_templates：模板级收藏（与文件收藏 starred_files 分开，语义清晰）。
//
// 幂等：ADD COLUMN 用 PRAGMA 守卫；CREATE TABLE/INDEX 用 IF NOT EXISTS。

module.exports = {
  name: 'template_share_star',

  async up(db, { dbRun, dbAll }) {
    // content_templates.share_key
    const cols = await dbAll(db, 'PRAGMA table_info(content_templates)');
    if (!cols.some(c => c.name === 'share_key')) {
      await dbRun(db, 'ALTER TABLE content_templates ADD COLUMN share_key TEXT');
    }
    await dbRun(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_ct_share_key ON content_templates(share_key) WHERE share_key IS NOT NULL');

    // 模板收藏表
    await dbRun(db, `CREATE TABLE IF NOT EXISTS starred_templates (
      user_id INTEGER NOT NULL,
      template_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, template_id)
    )`);
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_starred_tpl_user ON starred_templates(user_id)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_starred_tpl_template ON starred_templates(template_id)');
  }
};
