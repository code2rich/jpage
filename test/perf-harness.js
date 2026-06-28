// 端到端验证套件：覆盖鉴权、上传、列表、渲染、搜索、短链、版本、MCP、缓存头
// 用法: node test/perf-harness.js [PORT]
// 退出码 0 = 全部通过, 非 0 = 有失败
const http = require('http');

const PORT = parseInt(process.argv[2] || process.env.PORT || '8890', 10);
const HOST = '127.0.0.1';
const ADMIN = 'admin';
const PASS = 'testpassword123';

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' :: ' + detail : ''}`); }
}

function req(method, path, { body, headers = {}, raw, formData } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { host: HOST, port: PORT, method, path, headers: { ...headers } };
    let payload = null;
    if (raw !== undefined) { payload = raw; if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json'; }
    else if (body !== undefined) { payload = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    else if (formData !== undefined) { payload = formData.body; Object.assign(opts.headers, formData.headers); }
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);
    const r = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8') });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// 多部分表单：单字段 file
async function run() {
  console.log(`\n=== jpage 验证套件 (port ${PORT}) ===\n`);

  // 1. 健康检查
  let r = await req('GET', '/health');
  check('GET /health 200', r.status === 200, `status=${r.status}`);
  check('health 报告 db ok', (() => { try { return JSON.parse(r.text).db === true; } catch { return false; } })());

  // 2. 未登录访问受保护端点 → 401
  r = await req('GET', '/api/auth/me');
  check('未登录 GET /api/auth/me → 401', r.status === 401, `status=${r.status}`);

  // 3. 登录
  r = await req('POST', '/api/auth/login', { body: { username: ADMIN, password: PASS } });
  check('登录 admin → 200', r.status === 200, `status=${r.status}`);
  const cookie = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  check('登录返回 cookie', !!cookie);
  const auth = { Cookie: cookie };
  let me;
  try { me = JSON.parse(r.text); } catch { me = {}; }
  check('登录响应含 id/username/role', !!me.id && !!me.username && me.role === 'admin', JSON.stringify(me));

  // 4. /api/auth/me
  r = await req('GET', '/api/auth/me', { headers: auth });
  check('GET /api/auth/me → 200 (带 cookie)', r.status === 200, `status=${r.status}`);

  // 5. 上传 Markdown (JSON)
  const mdContent = '# 标题\n\n```js\nconsole.log("hi");\n```\n\n行内公式 $a^2+b^2=c^2$\n\n搜索关键词 jpage_unique_token_alpha';
  r = await req('POST', '/api/files/upload-json', { headers: auth, body: { name: 'perf-test.md', content: mdContent, isPublic: true } });
  check('upload-json markdown → 200', r.status === 200, `status=${r.status} ${r.text}`);
  let upload = {};
  try { upload = JSON.parse(r.text); } catch {}
  check('上传返回 id + share_key', !!upload.id && !!upload.share_key, r.text);
  const fileId = upload.id;
  const shareKey = upload.share_key;

  // 6. 列表
  r = await req('GET', '/api/files', { headers: auth });
  check('GET /api/files → 200', r.status === 200, `status=${r.status}`);
  let list = {};
  try { list = JSON.parse(r.text); } catch {}
  check('列表含刚上传文件', Array.isArray(list.files) && list.files.some(f => f.id === fileId), r.text.slice(0, 200));
  check('列表文件含 tags 数组', list.files.some(f => Array.isArray(f.tags)), '');
  check('列表含 pagination', !!list.pagination, '');

  // 7. 文件详情
  r = await req('GET', `/api/files/${fileId}`, { headers: auth });
  check(`GET /api/files/${fileId} → 200`, r.status === 200, `status=${r.status}`);

  // 8. 内容
  r = await req('GET', `/api/files/${fileId}/content`, { headers: auth });
  check(`GET /api/files/${fileId}/content → 200`, r.status === 200, `status=${r.status}`);

  // 9. 渲染
  r = await req('GET', `/api/files/${fileId}/render`, { headers: auth });
  check(`render → 200`, r.status === 200, `status=${r.status}`);
  check('render 返回 html 且含高亮/katex', r.text.includes('<code') || r.text.includes('katex'), r.text.slice(0, 120));

  // 10. 搜索（FTS）
  await new Promise(res => setTimeout(res, 400)); // 等 FTS 异步索引
  r = await req('GET', `/api/files/search?q=${encodeURIComponent('jpage_unique_token_alpha')}`, { headers: auth });
  check('FTS 搜索 → 200', r.status === 200, `status=${r.status}`);
  let search = {};
  try { search = JSON.parse(r.text); } catch {}
  check('FTS 搜索命中目标文件', Array.isArray(search.files) && search.files.some(f => f.id === fileId), r.text.slice(0, 200));

  // 11. 覆盖上传（版本）
  r = await req('POST', `/api/files/${fileId}/overwrite-json`, { headers: auth, body: { content: '# v2\n\n更新内容' } });
  check('overwrite-json → 200', r.status === 200, `status=${r.status} ${r.text}`);
  r = await req('GET', `/api/files/${fileId}/versions`, { headers: auth });
  check('版本列表 → 200', r.status === 200, `status=${r.status}`);

  // 12. 短链 /s/:key
  r = await req('GET', `/s/${shareKey}`);
  check(`短链 /s/${shareKey} → 200`, r.status === 200, `status=${r.status}`);
  check('短链渲染含 html', r.text.includes('<html') || r.text.includes('<!DOCTYPE'), r.text.slice(0, 80));

  // 13. 标签 / 分类（含分类名称缓存验证）
  r = await req('POST', '/api/tags', { headers: auth, body: { name: 'perf-tag' } });
  check('创建标签 → 200/201', r.status === 200 || r.status === 201, `status=${r.status}`);
  r = await req('PUT', `/api/files/${fileId}/tags`, { headers: auth, body: { tagIds: [1] } });
  check('给文件打标签 → 200', r.status === 200, `status=${r.status}`);
  r = await req('POST', '/api/categories', { headers: auth, body: { name: '缓存验证分类' } });
  check('创建分类 → 200', r.status === 200, `status=${r.status}`);
  let createdCat = {};
  try { createdCat = JSON.parse(r.text); } catch {}
  if (createdCat.id) {
    r = await req('PUT', `/api/files/${fileId}/category`, { headers: auth, body: { categoryId: createdCat.id } });
    check('给文件设置分类 → 200', r.status === 200, `status=${r.status}`);
    // 列表应通过分类缓存返回正确的 category_name
    r = await req('GET', '/api/files?keyword=perf-test.md', { headers: auth });
    let withCat = {};
    try { withCat = JSON.parse(r.text); } catch {}
    const target = (withCat.files || []).find(f => f.id === fileId);
    check('列表 category_name 由缓存正确填充', !!target && target.category_name === '缓存验证分类',
      target ? `got category_name="${target.category_name}"` : 'file not found in list');
    // 重命名后缓存应失效，列表反映新名
    r = await req('PUT', `/api/categories/${createdCat.id}`, { headers: auth, body: { name: '重命名后的分类' } });
    check('重命名分类 → 200', r.status === 200, `status=${r.status}`);
    r = await req('GET', '/api/files?keyword=perf-test.md', { headers: auth });
    let renamed = {};
    try { renamed = JSON.parse(r.text); } catch {}
    const target2 = (renamed.files || []).find(f => f.id === fileId);
    check('分类重命名后列表反映新名称（缓存失效）', !!target2 && target2.category_name === '重命名后的分类',
      target2 ? `got category_name="${target2.category_name}"` : 'file not found');
  }
  r = await req('GET', '/api/categories', { headers: auth });
  check('GET /api/categories → 200', r.status === 200, `status=${r.status}`);

  // 14. 静态资源缓存头（优化后应为长缓存）
  r = await req('GET', '/css/style.css?v=1.6.1');
  check('GET /css/style.css → 200', r.status === 200, `status=${r.status}`);
  const cssCache = r.headers['cache-control'] || '';
  console.log(`    (css cache-control: "${cssCache}")`);

  // 15. 删除文件
  r = await req('DELETE', `/api/files/${fileId}`, { headers: auth });
  check('删除文件 → 200', r.status === 200, `status=${r.status}`);

  // 16. 二次渲染（缓存路径，若启用）
  // 重新上传一个用于短链热路径
  r = await req('POST', '/api/files/upload-json', { headers: auth, body: { name: 'cache-target.md', content: '# C\n\n缓存验证', isPublic: true } });
  let c2 = {};
  try { c2 = JSON.parse(r.text); } catch {}
  if (c2.id) {
    const t1 = process.hrtime.bigint();
    r = await req('GET', `/api/files/${c2.id}/render`, { headers: auth });
    const t2 = process.hrtime.bigint();
    const ms1 = Number(t2 - t1) / 1e6;
    const t3 = process.hrtime.bigint();
    r = await req('GET', `/api/files/${c2.id}/render`, { headers: auth });
    const t4 = process.hrtime.bigint();
    const ms2 = Number(t4 - t3) / 1e6;
    console.log(`    (render cold=${ms1.toFixed(2)}ms, warm=${ms2.toFixed(2)}ms)`);
    check('二次渲染同样成功', r.status === 200, `status=${r.status}`);
    await req('DELETE', `/api/files/${c2.id}`, { headers: auth });
  }

  // 17. 不存在的资源 id → 404（非 500）
  r = await req('GET', '/api/files/99999/render', { headers: auth });
  check('render 不存在文件 → 404', r.status === 404, `status=${r.status}`);

  console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
  if (fail > 0) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

run().catch(e => { console.error('套件异常:', e); process.exit(2); });
