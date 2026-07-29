// 让 file_versions 能描述目录型 bundle 历史版本。

const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('../lib/paths');

module.exports = {
  name: 'zip_bundle_versions',

  async up(db, { dbRun, dbAll }) {
    const columns = await dbAll(db, 'PRAGMA table_info(file_versions)');
    const names = new Set(columns.map(column => column.name));

    if (!names.has('is_bundle')) {
      await dbRun(db, 'ALTER TABLE file_versions ADD COLUMN is_bundle INTEGER NOT NULL DEFAULT 0');
    }
    if (!names.has('entry_path')) {
      await dbRun(db, 'ALTER TABLE file_versions ADD COLUMN entry_path TEXT');
    }
    if (!names.has('file_type')) {
      await dbRun(db, 'ALTER TABLE file_versions ADD COLUMN file_type TEXT');
    }

    await dbRun(db, `
      UPDATE file_versions
         SET file_type = COALESCE(
           file_type,
           (SELECT files.file_type FROM files WHERE files.id = file_versions.file_id),
           'html'
         )
    `);

    // 旧代码不会正常创建 bundle 历史；若通用 overwrite 曾错误用于 bundle，
    // 历史 stored_name 可能已经是目录。按磁盘实态回填，保留可恢复的数据。
    const versions = await dbAll(db, `
      SELECT fv.id, fv.stored_name, f.entry_path
        FROM file_versions fv
        JOIN files f ON f.id = fv.file_id
       WHERE COALESCE(fv.is_bundle, 0) = 0
    `);
    for (const version of versions) {
      try {
        const stat = await fs.promises.stat(path.join(UPLOAD_DIR, version.stored_name));
        if (stat.isDirectory()) {
          await dbRun(
            db,
            'UPDATE file_versions SET is_bundle = 1, entry_path = ? WHERE id = ?',
            [version.entry_path || 'index.html', version.id]
          );
        }
      } catch (e) {
        if (!e || e.code !== 'ENOENT') throw e;
      }
    }
  }
};
