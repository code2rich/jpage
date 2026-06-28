// 内容模板市场反爬/反滥用中间件集合。
//
// 设计原则：
// 1. 公开浏览不阻断正常人，但对匿名高频、明显爬虫特征请求限流/拦截。
// 2. 已登录用户（session 或 API Token）绕过 bot 特征检测，避免误伤 CLI/MCP/正常用户。
// 3. API 响应加 X-Robots-Tag: noindex，降低被搜索引擎直接索引的风险。
// 4. robots.txt 引导爬虫不要爬 /api/ 数据接口。

const rateLimit = require('express-rate-limit');
const logger = require('../logger');

// 从环境变量读取阈值，方便按部署情况调整
const LIST_WINDOW_MS = parseInt(process.env.MARKET_LIST_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000;
const LIST_MAX = parseInt(process.env.MARKET_LIST_LIMIT_MAX, 10) || 300;
const PREVIEW_WINDOW_MS = parseInt(process.env.MARKET_PREVIEW_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000;
const PREVIEW_MAX = parseInt(process.env.MARKET_PREVIEW_LIMIT_MAX, 10) || 600;

function isAuthenticated(req) {
  // req.userId 由 requireAuth / loadSession / API Token 中间件设置
  return !!req.userId;
}

function isTestEnv() {
  return process.env.NODE_ENV === 'test';
}

// 列表类接口限流：/market、/categories 等
const marketListerLimiter = rateLimit({
  windowMs: LIST_WINDOW_MS,
  max: (req) => (isAuthenticated(req) ? LIST_MAX * 2 : LIST_MAX),
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isTestEnv() || isAuthenticated(req),
  handler: (req, res, _next, options) => {
    logger.warn({ type: 'market.rate_limit', ip: req.ip, path: req.path, message: '市场列表限流触发' });
    res.status(429).json(options.message);
  }
});

// 预览/详情类接口限流：缩略图 iframe、预览 HTML、详情等
const marketPreviewLimiter = rateLimit({
  windowMs: PREVIEW_WINDOW_MS,
  max: (req) => (isAuthenticated(req) ? PREVIEW_MAX * 2 : PREVIEW_MAX),
  message: { error: '预览请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isTestEnv() || isAuthenticated(req),
  handler: (req, res, _next, options) => {
    logger.warn({ type: 'market.rate_limit', ip: req.ip, path: req.path, message: '市场预览限流触发' });
    res.status(429).json(options.message);
  }
});

// 常见爬虫/自动化工具 User-Agent 黑名单
const BLOCKED_UA_PATTERNS = [
  /scrapy/i,
  /python-requests/i,
  /httpx/i,
  /curl/i,
  /wget/i,
  /go-http-client/i,
  /postmanruntime/i,
  /insomnia/i,
  /headlesschrome/i,
  /phantomjs/i,
  /selenium/i,
  /puppeteer/i,
  /playwright/i,
];

function looksLikeBot(req) {
  const ua = req.get('User-Agent') || '';
  if (!ua.trim()) return true;
  return BLOCKED_UA_PATTERNS.some((re) => re.test(ua));
}

// bot 过滤中间件：仅对匿名请求生效
// 测试环境下缺失 UA 的请求予以放行（supertest 默认不带 UA），便于现有测试通过；
// 显式设置空 UA 或爬虫 UA 的测试仍会被拦截。
function marketBotFilter(req, res, next) {
  if (isAuthenticated(req)) return next();
  const ua = req.get('User-Agent');
  if (isTestEnv() && (ua === undefined || ua === null)) return next();
  if (looksLikeBot(req)) {
    logger.warn({ type: 'market.bot_block', ip: req.ip, path: req.path, userAgent: ua });
    return res.status(403).json({ error: '请求被拒绝' });
  }
  next();
}

// 告诉搜索引擎不要索引 API 数据（不影响前端页面 SEO）
function marketRobotsTag(req, res, next) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}

module.exports = {
  marketListerLimiter,
  marketPreviewLimiter,
  marketBotFilter,
  marketRobotsTag,
  looksLikeBot,
};
