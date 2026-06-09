module.exports = {
  name: 'add_fts5_full_text_search',
  async up(db, { dbRun }) {
    await dbRun(db, `CREATE VIRTUAL TABLE IF NOT EXISTS file_contents_fts USING fts5(content, file_id UNINDEXED, tokenize='porter unicode61')`);
  }
};
