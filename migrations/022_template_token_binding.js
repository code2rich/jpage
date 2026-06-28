module.exports = {
  name: 'template_token_binding',

  async up(db, { dbRun, dbAll }) {
    const cols = await dbAll(db, 'PRAGMA table_info(content_template_installs)');
    const colNames = new Set(cols.map(c => c.name));

    if (!colNames.has('source')) {
      await dbRun(db, "ALTER TABLE content_template_installs ADD COLUMN source TEXT");
    }
    if (!colNames.has('token_prefix')) {
      await dbRun(db, "ALTER TABLE content_template_installs ADD COLUMN token_prefix TEXT");
    }
    if (!colNames.has('token_hash_prefix')) {
      await dbRun(db, "ALTER TABLE content_template_installs ADD COLUMN token_hash_prefix TEXT");
    }
  }
};
