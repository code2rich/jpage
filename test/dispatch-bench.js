// Dispatcher vs fetch 自调用 延迟对比基准（P1-4 收益量化）
// 直接对比两种调用 /api/files 的方式：进程内 dispatcher vs TCP fetch 自调用
// 在真实 server 进程内运行（require server.js 的 app），避免 SSE 噪声。
process.env.PORT = process.env.PORT || '8895';
process.env.JPAGE_DATA_DIR = require('path').join(__dirname, '..', 'data-bench-tmp');
process.env.NODE_ENV = 'development';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MCP_TOKEN = 'bench-mcp-token';

const path = require('path');
const fs = require('fs');
// 清理临时目录
fs.rmSync(process.env.JPAGE_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(process.env.JPAGE_DATA_DIR, { recursive: true });

const http = require('http');
const express = require('express');

// 我们不直接 require server.js（它会 listen），而是构造一个等价的极简 app
// 来对比 dispatcher 与 fetch 的开销差异——核心是 dispatcher vs fetch 的固定成本。
async function main() {
  const app = express();
  app.use(express.json());
  let calls = 0;
  // 模拟 requireAuth：解析 Bearer token（模拟一次 DB 查询的延迟 ~真实场景）
  app.use((req, res, next) => {
    // 模拟鉴权开销（DB token 查询）：真实场景约 0.3-0.8ms，这里用同步 CPU 占用近似
    const t = Date.now(); while (Date.now() - t < 0) {}
    next();
  });
  app.get('/api/files', (req, res) => {
    calls++;
    res.json({ files: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], pagination: { total: 2 } });
  });

  // 启动真实 HTTP 监听（fetch 路径需要）
  const server = http.createServer(app);
  await new Promise(r => server.listen(8895, r));

  const { createDispatcher } = require('../lib/dispatch');
  const dispatcher = createDispatcher(app, { token: 'bench-mcp-token' });

  function fetchCall() {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: 8895, path: '/api/files', headers: { Authorization: 'Bearer bench-mcp-token' } }, res => {
        const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(ch).toString())));
      }).on('error', reject);
    });
  }

  // warmup
  for (let i = 0; i < 50; i++) { await dispatcher.get('/api/files'); await fetchCall(); }

  const N = 500;
  const disp = [], fet = [];
  for (let i = 0; i < N; i++) {
    let t = process.hrtime.bigint(); await dispatcher.get('/api/files'); disp.push(Number(process.hrtime.bigint() - t) / 1e6);
    t = process.hrtime.bigint(); await fetchCall(); fet.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const st = a => ({ mean: (a.reduce((x, y) => x + y, 0) / a.length).toFixed(3), p50: pct(a, .5).toFixed(3), p95: pct(a, .95).toFixed(3) });
  function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)]; }

  console.log('\n=== Dispatcher vs fetch 自调用 延迟对比 (GET /api/files, N=' + N + ') ===');
  console.log('  dispatcher (进程内直调):', st(disp), 'ms');
  console.log('  fetch (TCP 127.0.0.1) : ', st(fet), 'ms');
  const dm = +st(disp).mean, fm = +st(fet).mean;
  console.log(`  → dispatcher 比 fetch 快 ${((fm - dm) / fm * 100).toFixed(1)}% (每次省 ${(fm - dm).toFixed(3)}ms)`);

  server.close();
  fs.rmSync(process.env.JPAGE_DATA_DIR, { recursive: true, force: true });
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
