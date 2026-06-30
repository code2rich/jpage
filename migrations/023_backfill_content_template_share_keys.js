// Migration 022: 为所有 content_templates 补全 share_key。
// 市场公开端点后续将改用 share_key 作为唯一标识，不再暴露内部自增 ID。
const { generateShareKey } = require('../lib/util');

module.exports = {
  name: 'backfill_content_template_share_keys',
  async up(db, { dbRun, dbAll }) {
    const rows = await dbAll(db, 'SELECT id FROM content_templates WHERE share_key IS NULL');
    for (const row of rows) {
      let key;
      for (let i = 0; i < 10; i++) {
        const candidate = generateShareKey();
        const clash = await dbAll(db, 'SELECT 1 FROM content_templates WHERE share_key = ?', [candidate]);
        if (!clash || clash.length === 0) {
          key = candidate;
          break;
        }
      }
      if (!key) {
        throw new Error(`无法为 content_template id=${row.id} 生成唯一 share_key`);
      }
      await dbRun(db, 'UPDATE content_templates SET share_key = ? WHERE id = ?', [key, row.id]);
    }
  },
};
