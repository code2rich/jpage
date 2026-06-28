// 为已上架但 view_count 为 0 的模板回填初始热度，
// 避免市场列表页在启用 view_count 后出现大量 "0 次查看"。
// 回填规则：view_count = use_count + 实际实例化次数，仅对 view_count = 0 的模板执行一次。

module.exports = {
  name: 'backfill_template_view_count',

  async up(db, { dbRun, dbAll, dbGet }) {
    const rows = await dbAll(
      db,
      `SELECT ct.id, ct.use_count
       FROM content_templates ct
       WHERE ct.view_count = 0`
    );

    for (const row of rows) {
      const installs = await dbGet(
        db,
        'SELECT COUNT(*) AS count FROM content_template_installs WHERE template_id = ?',
        [row.id]
      );
      const newCount = (row.use_count || 0) + (installs ? installs.count : 0);
      if (newCount > 0) {
        await dbRun(
          db,
          'UPDATE content_templates SET view_count = ? WHERE id = ? AND view_count = 0',
          [newCount, row.id]
        );
      }
    }
  }
};
