// 文件加载与归属校验中间件。
// loadFileWithPrivacy：按权限（admin/所有者/公开）加载文件到 req.fileRecord。
// checkFileOwnership：判断当前用户是否拥有该文件（admin 拥有一切）。
// 从 server.js 提取，行为保持不变。

const { dbGet } = require('../db');

function loadFileWithPrivacy(req, res, next) {
  dbGet('SELECT * FROM files WHERE id = ?', [req.params.id]).then(file => {
    if (!file) return res.status(404).json({ error: '文件不存在' });
    const userId = req.userId;
    const role = req.userRole;

    // admin 可访问一切
    if (role === 'admin') {
      req.fileRecord = file;
      return next();
    }
    // 普通用户：公开文件 或 自己的文件
    if (userId && (file.is_public || file.uploaded_by === userId)) {
      req.fileRecord = file;
      return next();
    }
    // 未登录：仅公开文件
    if (!userId && file.is_public) {
      req.fileRecord = file;
      return next();
    }
    if (!userId) return res.status(401).json({ error: '未登录' });
    return res.status(403).json({ error: '无权访问此文件' });
  }).catch(() => {
    res.status(500).json({ error: '读取失败' });
  });
}

function checkFileOwnership(req, file) {
  if (req.userRole === 'admin') return true;
  if (file.uploaded_by === req.userId) return true;
  return false;
}

module.exports = { loadFileWithPrivacy, checkFileOwnership };
