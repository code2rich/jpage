// 文件路由聚合器：创建单个 router，按**原始注册顺序**调用各子模块的 register。
//
// 为什么要保持顺序：Express 路由按声明顺序匹配。静态路径（/、/search、/upload、
// /upload-json、/upload-zip-base64、/batch）必须先于 /:id 注册，否则会被 /:id 吞掉。
// 这里用「共享 router」模式（而非子 router.use）正是为了把所有路由挂到同一个 router
// 上、由聚合器统一管控顺序，避免拆分后路由匹配语义漂移。
//
// 外部入口仍是 routes/files.js（re-export 本文件），server.js 的 require 路径不变。

const express = require('express');
const { registerList } = require('./list');
const { registerUpload } = require('./upload');
const { registerCrud } = require('./crud');
const { registerDetailServe } = require('./detail-serve');
const { registerOverwrite } = require('./overwrite');
const { registerVersions } = require('./versions');
const { registerAssociations } = require('./associations');

const router = express.Router();

// 注册顺序 = routes/files.js 原始顺序，行为零差异：
//   1. list          : GET /, GET /search              （静态路径，最先）
//   2. upload        : POST /upload, /upload-json, /upload-zip-base64, POST /batch
//                      注意：batch 在 crud 里，紧跟 upload 之后（原文件即如此）
//   3. crud          : PUT /:id, DELETE /:id, POST /batch
//   4. detail-serve  : GET /:id, /:id/content, /:id/asset/*, /:id/render, /:id/download
//   5. overwrite     : POST /:id/overwrite, /:id/overwrite-json
//   6. versions      : GET /:id/versions, ...content/render/restore, DELETE version
//   7. associations  : PUT /:id/tags, star/unstar, /:id/category, GET /:id/stats
registerList(router);
registerUpload(router);
registerCrud(router);          // 含 POST /batch（在 PUT/DELETE /:id 之间，与原文件一致）
registerDetailServe(router);
registerOverwrite(router);
registerVersions(router);
registerAssociations(router);

module.exports = router;
