// 市场反爬中间件单元测试
const test = require('node:test');
const assert = require('node:assert');
const { looksLikeBot } = require('../../lib/market-guard');

test('looksLikeBot：空 UA 视为 bot', () => {
  assert.strictEqual(looksLikeBot({ get: () => '' }), true);
  assert.strictEqual(looksLikeBot({ get: () => '   ' }), true);
});

test('looksLikeBot：常见浏览器 UA 不视为 bot', () => {
  assert.strictEqual(looksLikeBot({ get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }), false);
  assert.strictEqual(looksLikeBot({ get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15' }), false);
});

test('looksLikeBot：常见爬虫/自动化工具视为 bot', () => {
  const bots = [
    'python-requests/2.31.0',
    'Scrapy/2.11.0 (+https://scrapy.org)',
    'curl/8.4.0',
    'Wget/1.21.4',
    'Go-http-client/1.1',
    'PostmanRuntime/7.35.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0.0.0 Safari/537.36',
  ];
  for (const ua of bots) {
    assert.strictEqual(looksLikeBot({ get: () => ua }), true, ua);
  }
});
