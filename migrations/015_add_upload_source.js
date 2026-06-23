// 记录文件的上传来源：web（网页）/ cli（CLI）/ mcp（MCP）。
//
// 认证 token 无法区分来源（CLI 会回退用 MCP_TOKEN，MCP/CLI 都可用用户级 token），
// 故改由客户端在请求头 X-Upload-Source 显式标记，后端读取后落库。
// 历史文件无法还原真实来源，统一回填为 'web'。
//
// files.upload_source        —— 文件当前（最近一次）上传来源，覆盖上传时刷新。
// file_versions.upload_source —— 该历史版本被写入时的来源，创建后不再变。
module.exports = {
  name: 'add_upload_source',

  async up(db, { dbRun, dbAll }) {
    // files 主表
    const fileCols = await dbAll(db, 'PRAGMA table_info(files)');
    const fileNames = new Set(fileCols.map(c => c.name));
    if (!fileNames.has('upload_source')) {
      await dbRun(db, "ALTER TABLE files ADD COLUMN upload_source TEXT");
      await dbRun(db, "UPDATE files SET upload_source = 'web' WHERE upload_source IS NULL");
    }

    // file_versions 历史版本表
    const verCols = await dbAll(db, 'PRAGMA table_info(file_versions)');
    const verNames = new Set(verCols.map(c => c.name));
    if (!verNames.has('upload_source')) {
      await dbRun(db, "ALTER TABLE file_versions ADD COLUMN upload_source TEXT");
      await dbRun(db, "UPDATE file_versions SET upload_source = 'web' WHERE upload_source IS NULL");
    }
  }
};
