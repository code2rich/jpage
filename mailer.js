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
    // 连接池：复用连接，避免每次发信重新 TCP/TLS 握手
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    // 显式超时：SMTP 无响应时快速失败，而不是沿用 nodemailer
    // 默认值（建连 2min / greeting 30s / 闲置 10min）导致请求长时间挂起
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    dnsTimeout: 10000,
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

// 后台异步发信：不阻塞调用方（HTTP 请求路径），失败仅记录日志
function sendMailBackground(to, subject, html) {
  if (!transporter) return;
  sendMail(to, subject, html).catch(e => {
    logger.error({ type: 'app', message: '后台发送邮件失败', to, subject, error: e.message });
  });
}

// 关闭 SMTP 连接池（进程退出前调用）
function closeMailer() {
  if (transporter && typeof transporter.close === 'function') transporter.close();
}

function getAppUrl() { return appUrl || process.env.APP_URL || 'http://localhost:8858'; }
function isMailerConfigured() { return !!transporter; }

module.exports = { initMailer, sendMail, sendMailBackground, closeMailer, getAppUrl, isMailerConfigured };
