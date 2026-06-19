// 文件路由入口（re-export 聚合器）。
//
// 历史上 routes/files.js 是一个 1097 行的单体文件。已按子域拆分到 routes/files/ 目录：
//   _shared.js        上传配置 + 版本备份序列 + 下载头 + 路径守卫（共享层）
//   list.js           GET /, GET /search
//   upload.js         POST /upload, /upload-json, /upload-zip-base64
//   crud.js           PUT /:id, DELETE /:id, POST /batch
//   detail-serve.js   GET /:id, /:id/content, /:id/asset/*, /:id/render, /:id/download
//   overwrite.js      POST /:id/overwrite, /:id/overwrite-json
//   versions.js       GET /:id/versions, content/render/restore, DELETE version
//   associations.js   PUT /:id/tags, star/unstar, /:id/category, GET /:id/stats
//   index.js          聚合器（按原始顺序注册到单一 router）
//
// 此文件保留为外部入口，re-export 聚合器，使 server.js 的 require('./routes/files')
// 与挂载点 /api/files 零变化。行为与拆分前完全一致。
module.exports = require('./files/index');
