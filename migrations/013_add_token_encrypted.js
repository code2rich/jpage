module.exports = {
  name: 'add_token_encrypted',
  async up(db, { dbRun, dbAll }) {
    // 幂等：先检查列是否已存在
    const cols = await dbAll(db, 'PRAGMA table_info(tokens)');
    const colNames = new Set(cols.map(c => c.name));

    // 新增 token_enc 列：存 AES-256-GCM 密文，可逆，使明文可后续查看/复制。
    // 旧 token 留 NULL（不可查看，但鉴权不受影响）。
    if (!colNames.has('token_enc')) {
      await dbRun(db, 'ALTER TABLE tokens ADD COLUMN token_enc TEXT');
    }
  }
};
