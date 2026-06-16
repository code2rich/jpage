// MCP 端到端验证：通过 /mcp 端点验证 tool 调用（走进程内 dispatcher，非 fetch 自调用）
// 覆盖 list_files / upload_file / get_file_content / rename_file / get_file_url / delete_file
// 以及资源 jpage://files
const http = require('http');

const PORT = parseInt(process.argv[2] || process.env.PORT || '8890', 10);
const HOST = '127.0.0.1';
const TOKEN = 'test-mcp-token-abc';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' :: ' + detail : ''}`); }
}

function rawReq(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { host: HOST, port: PORT, method, path, headers: { ...headers } };
    let payload = body !== undefined ? JSON.stringify(body) : null;
    if (payload) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// 从 SSE event-stream 文本里提取 data: {...} 的 JSON（按事件分组，拼接多行 data）
function parseSseResult(text, id) {
  const events = text.split(/\n\n/);
  for (const ev of events) {
    const dataLines = ev.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
    if (!dataLines.length) continue;
    try {
      const obj = JSON.parse(dataLines.join('\n'));
      if (obj.id === id) return obj;
    } catch {}
  }
  return null;
}

let _callId = 100;
async function callTool(headers, sessionId, name, args) {
  const id = ++_callId;
  const r = await rawReq('POST', '/mcp', {
    headers: { ...headers, 'mcp-session-id': sessionId, 'Accept': 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  const obj = parseSseResult(r.text, id);
  return { status: r.status, obj, text: r.text };
}

async function run() {
  console.log(`\n=== MCP 端到端验证 (port ${PORT}) ===\n`);
  const headers = { Authorization: 'Bearer ' + TOKEN };

  // 1. initialize 握手
  let r = await rawReq('POST', '/mcp', {
    headers: { ...headers, Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
  });
  check('initialize → 200', r.status === 200, `status=${r.status}`);
  const initObj = parseSseResult(r.text, 1);
  check('initialize 返回 serverInfo', !!(initObj && initObj.result && initObj.result.serverInfo), r.text.slice(0, 200));
  const sessionId = r.headers['mcp-session-id'];
  check('返回 mcp-session-id', !!sessionId, JSON.stringify(r.headers).slice(0, 200));
  if (!sessionId) { console.log('无法继续：无 session'); process.exit(1); }

  // notifications/initialized（规范要求）
  await rawReq('POST', '/mcp', {
    headers: { ...headers, 'mcp-session-id': sessionId, Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });

  // 2. tools/list
  r = await rawReq('POST', '/mcp', {
    headers: { ...headers, 'mcp-session-id': sessionId, Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  });
  const toolsObj = parseSseResult(r.text, 2);
  const toolNames = (toolsObj && toolsObj.result && toolsObj.result.tools || []).map(t => t.name);
  check('tools/list 返回工具', toolNames.length >= 10, `got ${toolNames.length}: ${toolNames.join(',')}`);
  check('含 list_files/upload_file/get_file_content', ['list_files', 'upload_file', 'get_file_content'].every(n => toolNames.includes(n)), toolNames.join(','));

  // 3. upload_file（dispatcher 直调 upload-json）
  const content = '# MCP 测试\n\n```js\nconsole.log("dispatcher");\n```\n\nmcp_unique_token_xyz';
  r = await callTool(headers, sessionId, 'upload_file', { name: 'mcp-test.md', content, isPublic: true });
  let uploadPayload = null;
  try { uploadPayload = JSON.parse(r.obj.result.content[0].text); } catch {}
  check('upload_file 成功', !!(uploadPayload && uploadPayload.id), r.text.slice(0, 300));
  const fileId = uploadPayload && uploadPayload.id;
  check('upload_file 返回 url', !!(uploadPayload && uploadPayload.url && uploadPayload.url.includes('/s/')), JSON.stringify(uploadPayload).slice(0, 200));

  // 4. list_files（dispatcher 直调 /api/files）
  r = await callTool(headers, sessionId, 'list_files', { limit: 100 });
  let listPayload = null;
  try { listPayload = JSON.parse(r.obj.result.content[0].text); } catch {}
  check('list_files 成功', !!(listPayload && Array.isArray(listPayload.files)), r.text.slice(0, 200));
  check('list_files 含刚上传文件', !!(listPayload && listPayload.files.some(f => f.id === fileId)), JSON.stringify(listPayload).slice(0, 200));

  // 5. get_file_content（dispatcher 直调 /api/files/:id/content）
  r = await callTool(headers, sessionId, 'get_file_content', { id: fileId });
  let contentPayload = null;
  try { contentPayload = JSON.parse(r.obj.result.content[0].text); } catch {}
  check('get_file_content 返回内容', !!(contentPayload && contentPayload.content && contentPayload.content.includes('mcp_unique_token_xyz')), r.text.slice(0, 200));

  // 6. rename_file（dispatcher 直调 PUT /api/files/:id）
  r = await callTool(headers, sessionId, 'rename_file', { id: fileId, name: 'mcp-renamed.md' });
  check('rename_file 成功', !!(r.obj && r.obj.result), r.text.slice(0, 200));

  // 7. get_file_url（dispatcher 直调 GET /api/files/:id）
  r = await callTool(headers, sessionId, 'get_file_url', { id: fileId });
  let urlPayload = null;
  try { urlPayload = JSON.parse(r.obj.result.content[0].text); } catch {}
  check('get_file_url 返回短链', !!(urlPayload && urlPayload.url && urlPayload.url.includes('/s/')), JSON.stringify(urlPayload).slice(0, 200));

  // 8. create_category + set_file_category（dispatcher）
  r = await callTool(headers, sessionId, 'create_category', { name: 'mcp-cat' });
  let catPayload = null;
  try { catPayload = JSON.parse(r.obj.result.content[0].text); } catch {}
  check('create_category 成功', !!(catPayload && catPayload.id), r.text.slice(0, 200));
  if (catPayload && catPayload.id) {
    r = await callTool(headers, sessionId, 'set_file_category', { fileId, categoryId: catPayload.id });
    check('set_file_category 成功', !!(r.obj && r.obj.result), r.text.slice(0, 200));
  }

  // 9. delete_file（dispatcher 直调 DELETE）
  r = await callTool(headers, sessionId, 'delete_file', { id: fileId });
  check('delete_file 成功', !!(r.obj && r.obj.result), r.text.slice(0, 200));
  // 确认真的删了
  r = await callTool(headers, sessionId, 'get_file_content', { id: fileId });
  check('删除后 get_file_content 失败（isError 或无内容）', !!(r.obj && (r.obj.result.isError || (r.obj.error))), r.text.slice(0, 200));

  // 10. 资源 jpage://files
  r = await rawReq('POST', '/mcp', {
    headers: { ...headers, 'mcp-session-id': sessionId, Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 99, method: 'resources/read', params: { uri: 'jpage://files' } },
  });
  const resObj = parseSseResult(r.text, 99);
  check('resources/read jpage://files 成功', !!(resObj && resObj.result && resObj.result.contents), r.text.slice(0, 200));

  console.log(`\n=== MCP 结果: ${pass} 通过, ${fail} 失败 ===`);
  if (fail > 0) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

run().catch(e => { console.error('MCP 套件异常:', e); process.exit(2); });
