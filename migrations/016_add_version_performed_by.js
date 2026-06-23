// 历史版本记录"谁触发了本次覆盖/恢复"（操作者），用于事后审计。
//
// 注意：file_versions.uploaded_by 记录的是「被归档那一版内容的原始上传者」
// （语义为内容归属），并非操作者。当 admin 或 owner 之外的角色触发版本创建时，
// uploaded_by 与操作者可能不同——本次新增 performed_by 独立记录操作者，避免歧义。
// 历史行无法还原真实操作者，统一回填为 NULL（表示"未知/历史数据"）。
module.exports = {
  name: 'add_version_performed_by',

  async up(db, { dbRun, dbAll }) {
    const cols = await dbAll(db, 'PRAGMA table_info(file_versions)');
    const names = new Set(cols.map(c => c.name));
    if (!names.has('performed_by')) {
      await dbRun(db, 'ALTER TABLE file_versions ADD COLUMN performed_by INTEGER');
      // 旧行保持 NULL，不回填——历史数据无法准确还原操作者。
    }
  }
};
