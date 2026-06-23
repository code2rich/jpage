// 内容模板市场重构：可配置分类表 + 审核/展示字段 + 默认分类 + 旧数据归档。
//
// 设计要点：
// - 新增 template_market_categories：可配置分类（slug/name/is_enabled/sort_order）。
// - content_templates 增加 status/visibility/审核字段/featured/sort_order/category_id。
// - 旧 scene 概念废弃，新逻辑只认 category_id。
// - 兼容：is_public 暂时保留，由 status+visibility 取代；本迁移不动旧字段。
// - 不改 011_content_templates.js（已发布）。所有旧模板初始 status='draft'（DEFAULT），
//   本迁移统一 UPDATE 为 archived+hidden，前台不再展示但数据保留可查。

module.exports = {
  name: 'rebuild_content_template_market',

  async up(db, { dbRun, dbAll }) {
    // 1. 分类表
    await dbRun(db, `CREATE TABLE IF NOT EXISTS template_market_categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      is_enabled  INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // 2. content_templates 加字段（SQLite 无 ADD COLUMN IF NOT EXISTS，用 PRAGMA 守卫）
    const cols = await dbAll(db, 'PRAGMA table_info(content_templates)');
    const names = new Set(cols.map(c => c.name));
    const addCol = (col, def) => dbRun(db, `ALTER TABLE content_templates ADD COLUMN ${col} ${def}`);
    if (!names.has('category_id'))  await addCol('category_id', 'INTEGER');
    if (!names.has('status'))       await addCol('status', "TEXT NOT NULL DEFAULT 'draft'");
    if (!names.has('visibility'))   await addCol('visibility', "TEXT NOT NULL DEFAULT 'hidden'");
    if (!names.has('review_note'))  await addCol('review_note', 'TEXT');
    if (!names.has('reviewed_by'))  await addCol('reviewed_by', 'INTEGER');
    if (!names.has('reviewed_at'))  await addCol('reviewed_at', 'TEXT');
    if (!names.has('submitted_at')) await addCol('submitted_at', 'TEXT');
    if (!names.has('published_at')) await addCol('published_at', 'TEXT');
    if (!names.has('featured'))     await addCol('featured', 'INTEGER NOT NULL DEFAULT 0');
    if (!names.has('sort_order'))   await addCol('sort_order', 'INTEGER NOT NULL DEFAULT 0');

    // 3. 索引
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_ct_market ON content_templates(status, visibility)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_ct_category ON content_templates(category_id)');

    // 4. 两个默认分类（slug 唯一约束保证幂等）
    await dbRun(db, `INSERT OR IGNORE INTO template_market_categories (slug, name, sort_order) VALUES ('html-ppt', 'HTML-PPT', 1)`);
    await dbRun(db, `INSERT OR IGNORE INTO template_market_categories (slug, name, sort_order) VALUES ('html-book', 'HTML-BOOK', 2)`);

    // 5. 归档所有现存模板：archived + hidden（保留数据，前台不展示）
    //    新加列默认值让旧行 status='draft'，统一置为 archived。
    await dbRun(db, `UPDATE content_templates SET status='archived', visibility='hidden' WHERE status='draft'`);
  }
};
