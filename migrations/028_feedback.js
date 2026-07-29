// 用户问题反馈：功能建议 / 问题反馈 / 其他。
// 反馈同时写库（不丢数据）并发送邮件给管理员；本表仅建结构，发信逻辑在 routes/feedback.js。
//
// 字段说明：
//   name        提交者称呼（可选）
//   contact     联系方式：邮箱 / 微信等（可选）
//   content     反馈正文（必填）
//   category    类型白名单：feature / bug / other（默认 other）
//   user_id     已登录用户则记录，匿名为 NULL（与匿名粘贴文件一致）
//   ip          提交者 IP（审计与反滥用排查）
//   email_sent  邮件是否投递成功：0=未发或失败，1=成功（SMTP 未配置时仍存库，值为 0）
//   status      处理状态：new / read（预留管理后台，本期未使用）
//
// 幂等：CREATE TABLE 用 IF NOT EXISTS。

module.exports = {
  name: 'feedback',

  async up(db, { dbRun }) {
    await dbRun(db, `CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      contact TEXT,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'other',
      user_id INTEGER,
      ip TEXT,
      email_sent INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }
};
