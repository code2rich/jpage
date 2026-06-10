const nodemailer = require('nodemailer');
const logger = require('./logger');

let transporter = null;
let fromAddress = '';
let appUrl = '';

function initMailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_URL } = process.env;
  if (!SMTP_HOST) return false;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT) || 465,
    secure: SMTP_SECURE !== 'false',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  fromAddress = SMTP_FROM || SMTP_USER || 'noreply@jpage.local';
  appUrl = APP_URL || 'http://localhost:8858';
  logger.info({ type: 'app', message: 'SMTP 已配置', host: SMTP_HOST, port: SMTP_PORT || 465 });
  return true;
}

async function sendMail(to, subject, html) {
  if (!transporter) throw new Error('SMTP 未配置');
  const info = await transporter.sendMail({ from: fromAddress, to, subject, html });
  logger.info({ type: 'app', message: '邮件已发送', to, subject, messageId: info.messageId });
  return info;
}

function getAppUrl() { return appUrl || process.env.APP_URL || 'http://localhost:8858'; }
function isMailerConfigured() { return !!transporter; }

module.exports = { initMailer, sendMail, getAppUrl, isMailerConfigured };
