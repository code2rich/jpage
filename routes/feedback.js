// 用户问题反馈：免登录公开接口（参照 routes/public.js 的 try-paste 模式）。
// 设计约束：
//   - 严格 IP 级限流，避免被滥用为垃圾邮件投递通道。
//   - 内容长度限制在 5000 字符以内。
//   - 即使 SMTP 未配置，也写库不丢数据；配置后才补发邮件（email_sent 标记投递结果）。
//   - 收件邮箱优先级：FEEDBACK_EMAIL → 首个 admin 用户邮箱 → SMTP_FROM；均无则跳过发信。
//
// 反馈数据写入 feedback 表；邮件通过 sendMailBackground 后台投递，不阻塞请求。

const express = require('express');
const rateLimit = require('express-rate-limit');
const { dbRun, dbGet } = require('../lib/db');
const { now, clientIp } = require('../lib/util');
const { loadSession } = require('../lib/middleware/auth');
const { sendMailBackground, getAppUrl, isMailerConfigured } = require('../mailer');
const logger = require('../logger');

const router = express.Router();

// IP 级限流：15 分钟内最多 10 次反馈，防止滥用。
const feedbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '反馈提交过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

const CONTENT_MAX_LENGTH = 5000;
const FIELD_MAX_LENGTH = 100;
const VALID_CATEGORIES = ['feature', 'bug', 'other'];
const CATEGORY_LABELS = { feature: '功能建议', bug: '问题反馈', other: '其他' };

// 反馈邮件收件地址解析（按优先级回退）：
//   1. 环境变量 FEEDBACK_EMAIL（显式配置，推荐）
//   2. 首个 admin 用户邮箱（管理员自助部署场景）
//   3. SMTP_FROM（发件地址兜底）
// 返回 null 表示无可投递地址，调用方应跳过发信但仍写库。
async function resolveFeedbackEmail() {
  if (process.env.FEEDBACK_EMAIL) return process.env.FEEDBACK_EMAIL;
  try {
    const admin = await dbGet("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND email != '' ORDER BY id ASC LIMIT 1");
    if (admin && admin.email) return admin.email;
  } catch (e) {
    logger.error({ type: 'app', message: '解析管理员邮箱失败', error: e.message });
  }
  const from = process.env.SMTP_FROM;
  return from || null;
}

// 邮件正文（内联样式，与验证邮件风格一致）
function buildFeedbackHtml({ name, contact, category, content, userId, ip }) {
  const appUrl = getAppUrl();
  const label = CATEGORY_LABELS[category] || '其他';
  const row = (th, td) => `<tr><td style="color:#888;padding:4px 12px 4px 0;vertical-align:top;white-space:nowrap">${th}</td><td style="color:#333;padding:4px 0">${td}</td></tr>`;
  return `<div style="max-width:560px;margin:0 auto;font-family:system-ui,-apple-system,sans-serif;padding:24px">
    <h2 style="margin:0 0 16px;font-size:20px;color:#111">新的用户反馈</h2>
    <table style="border-collapse:collapse;font-size:14px;margin-bottom:16px">
      ${row('类型', label)}
      ${name ? row('称呼', escapeHtmlText(name)) : ''}
      ${contact ? row('联系方式', escapeHtmlText(contact)) : ''}
      ${userId ? row('用户ID', userId) : row('身份', '匿名访客')}
      ${ip ? row('来源 IP', escapeHtmlText(ip)) : ''}
      ${row('提交时间', now())}
    </table>
    <p style="margin:0 0 8px;color:#555;font-size:14px">反馈内容：</p>
    <pre style="background:#f6f8fa;border-radius:6px;padding:14px 16px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:#24292f;margin:0">${escapeHtmlText(content)}</pre>
    <p style="margin:16px 0 0;color:#888;font-size:12px">来自即页 jpage ${appUrl}</p>
  </div>`;
}

function escapeHtmlText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// POST /api/feedback
// Body: { content: string, category?: 'feature'|'bug'|'other', name?: string, contact?: string }
router.post('/', feedbackLimiter, loadSession, async (req, res) => {
  try {
    const { content, category, name, contact } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: '反馈内容不能为空' });
    }
    if (content.length > CONTENT_MAX_LENGTH) {
      return res.status(400).json({ error: `反馈内容不能超过 ${CONTENT_MAX_LENGTH} 字` });
    }
    const cat = VALID_CATEGORIES.includes(category) ? category : 'feature';
    const trimmedName = typeof name === 'string' ? name.trim().slice(0, FIELD_MAX_LENGTH) : '';
    const trimmedContact = typeof contact === 'string' ? contact.trim().slice(0, FIELD_MAX_LENGTH) : '';
    const ip = clientIp(req);
    const userId = req.userId || null;

    const result = await dbRun(
      `INSERT INTO feedback (name, contact, content, category, user_id, ip, email_sent, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'new', ?)`,
      [trimmedName || null, trimmedContact || null, content.trim(), cat, userId, ip, now()]
    );
    const feedbackId = result.lastID;

    // 发信：后台异步，不阻塞请求。成功后回填 email_sent。
    const to = await resolveFeedbackEmail();
    if (to && isMailerConfigured()) {
      sendMailBackground(to, `[即页反馈] ${CATEGORY_LABELS[cat]}`, buildFeedbackHtml({
        name: trimmedName, contact: trimmedContact, category: cat, content: content.trim(), userId, ip
      })).then(() => {
        dbRun('UPDATE feedback SET email_sent = 1 WHERE id = ?', [feedbackId]).catch(e => {
          logger.error({ type: 'app', message: '回填 email_sent 失败', feedbackId, error: e.message });
        });
      }).catch(e => {
        logger.error({ type: 'app', message: '发送反馈邮件失败', to, feedbackId, error: e.message });
      });
    }

    logger.audit('feedback.submit', { feedbackId, category: cat, userId, ip });
    res.json({ success: true, id: feedbackId });
  } catch (e) {
    logger.error({ type: 'app', action: 'feedback.submit', error: e.message });
    res.status(500).json({ error: '提交反馈失败' });
  }
});

module.exports = router;
module.exports.resolveFeedbackEmail = resolveFeedbackEmail;
module.exports.CONTENT_MAX_LENGTH = CONTENT_MAX_LENGTH;
