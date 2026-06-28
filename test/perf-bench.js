// 性能基准：量化优化的实际收益
// 用法: node test/perf-bench.js [PORT]
// 测量项：
//   1) Markdown 渲染冷/热延迟（P0-3 渲染缓存）
//   2) 文件列表延迟（P1-6 分类缓存）
//   3) 静态资源缓存头（P0-2）
//   4) 短链渲染并发吞吐（P0-1 WAL）
const http = require('http');

const PORT = parseInt(process.argv[2] || process.env.PORT || '8890', 10);
const HOST = '127.0.0.1';

function req(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { host: HOST, port: PORT, method, path, headers: { ...headers } };
    const payload = body !== undefined ? JSON.stringify(body) : null;
    if (payload) opts.headers['Content-Type'] = 'application/json', opts.headers['Content-Length'] = Buffer.byteLength(payload);
    const start = process.hrtime.bigint();
    const r = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8'), ms });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function login() {
  const r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'testpassword123' } });
  const cookie = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  return { Cookie: cookie };
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p)] || s[s.length - 1];
}
function stats(arr) {
  const sum = arr.reduce((a, b) => a + b, 0);
  return { n: arr.length, mean: (sum / arr.length).toFixed(2), p50: pct(arr, 0.5).toFixed(2), p95: pct(arr, 0.95).toFixed(2), min: Math.min(...arr).toFixed(2), max: Math.max(...arr).toFixed(2) };
}

async function run() {
  console.log(`\n=== jpage 性能基准 (port ${PORT}) ===\n`);
  const auth = await login();

  // 上传一篇含代码块+公式的 Markdown（渲染开销大）
  const md = Array.from({ length: 60 }, (_, i) =>
    `## 章节 ${i}\n\n\`\`\`js\nfunction f${i}(x){ return x*${i}; }\n\`\`\`\n\n公式 $E=mc^2$，块级 $$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n`
  ).join('\n');
  let r = await req('POST', '/api/files/upload-json', { headers: auth, body: { name: 'bench.md', content: md, isPublic: true } });
  const fileId = JSON.parse(r.text).id;

  // --- 1) 渲染冷/热延迟 ---
  // 先覆盖一次让缓存失效（cold），再连续测 warm
  await req('POST', `/api/files/${fileId}/overwrite-json`, { headers: auth, body: { content: md + '\n<!-- cold -->' } });
  const coldSamples = [];
  for (let i = 0; i < 5; i++) {
    // 每次覆盖以清缓存，测冷启动
    await req('POST', `/api/files/${fileId}/overwrite-json`, { headers: auth, body: { content: md + `\n<!-- ${i} -->` } });
    coldSamples.push((await req('GET', `/api/files/${fileId}/render`, { headers: auth })).ms);
  }
  // 热路径：不再覆盖，连续命中缓存
  const warmSamples = [];
  for (let i = 0; i < 50; i++) warmSamples.push((await req('GET', `/api/files/${fileId}/render`, { headers: auth })).ms);

  console.log('1) Markdown 渲染延迟 (ms):');
  console.log('   冷渲染 (每次新内容, 无缓存):', stats(coldSamples));
  console.log('   热渲染 (命中缓存):          ', stats(warmSamples));
  const coldMean = +stats(coldSamples).mean, warmMean = +stats(warmSamples).mean;
  if (coldMean > 0) console.log(`   → 缓存带来 ${(100 * (1 - warmMean / coldMean)).toFixed(1)}% 延迟下降\n`);

  // --- 2) 文件列表延迟 ---
  // 预置一些文件让列表有数据
  for (let i = 0; i < 10; i++) {
    await req('POST', '/api/files/upload-json', { headers: auth, body: { name: `list-fill-${i}.md`, content: '# x' } });
  }
  const listSamples = [];
  for (let i = 0; i < 50; i++) listSamples.push((await req('GET', '/api/files?limit=20', { headers: auth })).ms);
  console.log('2) 文件列表延迟 (ms):', stats(listSamples), '\n');

  // --- 3) 静态资源缓存头 ---
  r = await req('GET', '/css/style.css?v=1.6.5');
  console.log('3) 静态资源 Cache-Control:', JSON.stringify(r.headers['cache-control']));
  console.log('   包含 immutable:', (r.headers['cache-control'] || '').includes('immutable'), '\n');

  // --- 4) 短链渲染并发吞吐（WAL 下读写不互斥）---
  const shareKey = (JSON.parse((await req('GET', `/api/files/${fileId}`, { headers: auth })).text)).share_key;
  const N = 60;
  const t0 = process.hrtime.bigint();
  await Promise.all(Array.from({ length: N }, () => req('GET', `/s/${shareKey}`)));
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`4) 短链 /s/:key 并发 ${N} 次总耗时 ${elapsedMs.toFixed(1)}ms (并发吞吐 ~${(N / elapsedMs * 1000).toFixed(0)} req/s)\n`);

  // 清理
  for (let i = 0; i < 10; i++) await req('DELETE', `/api/files/${fileId + 1 + i}`, { headers: auth }).catch(() => {});
  await req('DELETE', `/api/files/${fileId}`, { headers: auth }).catch(() => {});

  console.log('=== 基准完成 ===');
  process.exit(0);
}

run().catch(e => { console.error('bench 异常:', e); process.exit(2); });
