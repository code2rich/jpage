module.exports = {
  name: 'add_file_type_and_uploaded_by_indexes',
  async up(db, { dbRun }) {
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_files_file_type ON files(file_type)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_files_uploaded_by ON files(uploaded_by)');
  }
};
