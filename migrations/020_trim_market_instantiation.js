// 精简 019 引入的死字段：019 建了「实例化」相关 schema 但功能未落地，部分字段从未使用。
//
// 保留（实例化追溯要用）：
//   - files.source_asset_id         实例化文件标记来源模板
//   - files.created_from            标记 'market' 等来源
//   - content_template_installs     实例化记录表（用户↔模板↔文件）
//   - content_templates.version     模板版本号
//   - idx_files_source_asset        按来源模板查实例化记录的索引
//
// 删除（确认为死代码，前后端零引用）：
//   - files.source_asset_version / forked_from_page_id / instantiation_variables
//   - content_templates.view_count / instantiation_count（实例化数改由 installs 表实时统计）
//   - content_template_events 表（事件流从未使用）
//   - idx_files_created_from / idx_ct_events_template（被删列/表的索引）
//
// 幂等：所有删除操作先查 PRAGMA/表存在性再执行，已删则跳过。

module.exports = {
  name: 'trim_market_instantiation',

  async up(db, { dbRun, dbAll }) {
    // 安全 DROP：列存在才删，DROP COLUMN 不支持 IF EXISTS，故先查 PRAGMA
    async function dropColumn(table, col) {
      const cols = await dbAll(db, `PRAGMA table_info(${table})`);
      if (!cols.some(c => c.name === col)) return;
      await dbRun(db, `ALTER TABLE ${table} DROP COLUMN ${col}`);
    }

    // files 死列
    await dropColumn('files', 'source_asset_version');
    await dropColumn('files', 'forked_from_page_id');
    await dropColumn('files', 'instantiation_variables');

    // content_templates 死列（实例化数改由 installs 表子查询统计）
    await dropColumn('content_templates', 'view_count');
    await dropColumn('content_templates', 'instantiation_count');

    // 死表
    const tables = await dbAll(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='content_template_events'");
    if (tables.length) await dbRun(db, 'DROP TABLE content_template_events');

    // 死索引（IF EXISTS 安全）
    await dbRun(db, 'DROP INDEX IF EXISTS idx_files_created_from');
    await dbRun(db, 'DROP INDEX IF EXISTS idx_ct_events_template');
  }
};
