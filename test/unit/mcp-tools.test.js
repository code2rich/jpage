// MCP 工具 handler 单元测试：直接调用 server._registeredTools[name].handler，
// 注入 mock api（{get,post,put,del}），断言调用路径、参数与返回结构。
// 覆盖全部 17 个工具的核心路径与错误分支，不依赖 DB/Express。

const test = require('node:test');
const assert = require('node:assert');
const { createMcpServer } = require('../../mcp/server');

// 构造 mock api：记录所有调用，按方法返回预设值或抛错。
// stubs 形如 { 'GET /api/files': {...} }，支持通配 '*<path-prefix>'（忽略 method，按路径前缀匹配）兜底。
function makeMockApi(stubs = {}) {
  const calls = [];
  const api = {};
  for (const method of ['get', 'post', 'put', 'del']) {
    const verb = method === 'del' ? 'DELETE' : method.toUpperCase();
    api[method] = async (path, body) => {
      calls.push({ method: verb, path, body });
      const key = `${verb} ${path}`;
      // 精确匹配优先
      let stub = stubs[key];
      if (stub === undefined) {
        // 通配：'*<path-prefix>'，按路径前缀匹配（忽略 method）
        for (const [k, v] of Object.entries(stubs)) {
          if (k.startsWith('*') && path.startsWith(k.slice(1))) { stub = v; break; }
        }
      }
      if (stub === undefined) stub = { ok: true };
      if (stub instanceof Error) throw stub;
      if (typeof stub === 'function') return stub({ path, body });
      return stub;
    };
  }
  api._calls = calls;
  return api;
}

function makeServer(stubs) {
  const api = makeMockApi(stubs);
  const server = createMcpServer({ port: 3000, api, mcpIp: 'localhost', protocol: 'http' });
  return { server, api };
}

function handler(server, name) {
  const t = server._registeredTools[name];
  assert.ok(t && typeof t.handler === 'function', `工具 ${name} 未注册或无 handler`);
  return t.handler;
}

// 解析 textResult 的 text 字段为 JSON（工具返回对象时）
function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

// ====================== list_files ======================

test('list_files：无参数 → GET /api/files（无 query）', async () => {
  const { server, api } = makeServer({ 'GET /api/files': { files: [], pagination: { total: 0 } } });
  await handler(server, 'list_files')({});
  assert.strictEqual(api._calls[0].path, '/api/files');
});

test('list_files：带参数 → querystring 按序拼接，limit 被 clamp 到 100', async () => {
  const { server, api } = makeServer({ 'GET /api/files': { files: [], pagination: {} } });
  await handler(server, 'list_files')({ page: 2, limit: 500, sort: 'size', order: 'asc', keyword: 'k', category: '1', tag: '2' });
  assert.strictEqual(api._calls[0].path, '/api/files?page=2&limit=100&sort=size&order=asc&keyword=k&category=1&tag=2');
});

test('list_files：返回 { files, pagination } 结构', async () => {
  const { server } = makeServer({ 'GET /api/files': { files: [{ id: 1 }], pagination: { total: 1 } } });
  const result = await handler(server, 'list_files')({});
  const parsed = parseResult(result);
  assert.strictEqual(parsed.files.length, 1);
  assert.strictEqual(parsed.pagination.total, 1);
});

// ====================== upload_file ======================

test('upload_file：Markdown → POST /api/files/upload-json，返回含 url', async () => {
  const { server, api } = makeServer({
    'POST /api/files/upload-json': { id: 10, share_key: 'ABC123', file_type: 'markdown' },
  });
  const result = await handler(server, 'upload_file')({ name: 'a.md', content: '# hi' });
  assert.strictEqual(api._calls[0].path, '/api/files/upload-json');
  assert.strictEqual(api._calls[0].body.name, 'a.md');
  assert.strictEqual(api._calls[0].body.isPublic, true); // 默认 true
  const parsed = parseResult(result);
  assert.strictEqual(parsed.url, 'http://localhost:3000/s/ABC123');
});

test('upload_file：isPublic=false → 透传', async () => {
  const { server, api } = makeServer({ 'POST /api/files/upload-json': { id: 1, share_key: 'k' } });
  await handler(server, 'upload_file')({ name: 'a.md', content: 'x', isPublic: false });
  assert.strictEqual(api._calls[0].body.isPublic, false);
});

test('upload_file：overwriteFileId → 走 /overwrite-json 路径', async () => {
  const { server, api } = makeServer({ 'POST /api/files/5/overwrite-json': { id: 5, share_key: 'k' } });
  await handler(server, 'upload_file')({ name: 'a.md', content: 'x', overwriteFileId: 5 });
  assert.strictEqual(api._calls[0].path, '/api/files/5/overwrite-json');
});

test('upload_file：HTML → POST /api/files/upload-json', async () => {
  const { server, api } = makeServer({ 'POST /api/files/upload-json': { id: 1, share_key: 'k' } });
  await handler(server, 'upload_file')({ name: 'a.html', content: '<p/>' });
  assert.strictEqual(api._calls[0].path, '/api/files/upload-json');
});

test('upload_file：不支持扩展名 → isError', async () => {
  const { server } = makeServer({});
  const result = await handler(server, 'upload_file')({ name: 'a.txt', content: 'x' });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /不支持的文件扩展名/);
});

test('upload_file：非 zip 超 50MB → isError', async () => {
  const { server } = makeServer({});
  const huge = 'x'.repeat(50 * 1024 * 1024 + 1);
  const result = await handler(server, 'upload_file')({ name: 'a.md', content: huge });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /文件过大/);
});

test('upload_file：ZIP bundle → POST upload-zip-base64，返回含 url', async () => {
  const { server, api } = makeServer({
    'POST /api/files/upload-zip-base64': { id: 7, share_key: 'ZIPK', is_bundle: 1 },
  });
  const result = await handler(server, 'upload_file')({ name: 's.zip', content: 'UEsDBA==' });
  assert.strictEqual(api._calls[0].path, '/api/files/upload-zip-base64');
  const parsed = parseResult(result);
  assert.strictEqual(parsed.url, 'http://localhost:3000/s/ZIPK');
});

test('upload_file：ZIP batch → 对每个文件调用 applyTagsAndCategory', async () => {
  const { server, api } = makeServer({
    'POST /api/files/upload-zip-base64': { type: 'batch', count: 2, files: [{ id: 1 }, { id: 2 }] },
    'GET /api/tags': { tags: [{ id: 9, name: 't1' }] },  // resolveTagIds 依赖
  });
  const result = await handler(server, 'upload_file')({ name: 's.zip', content: 'UEsDBA==', tags: ['t1'] });
  const parsed = parseResult(result);
  assert.strictEqual(parsed.type, 'batch');
  // tags 非空 → 触发 resolveTagIds（GET /api/tags）+ PUT /api/files/:id/tags 各两次
  const tagPuts = api._calls.filter(c => c.method === 'PUT' && c.path.includes('/tags'));
  assert.strictEqual(tagPuts.length, 2);
});

test('upload_file：ZIP 超 50MB → isError', async () => {
  const { server } = makeServer({});
  // base64 解码后需 >50MB：每 4 字符解码 3 字节，70M 字符 ≈ 52.5MB
  const huge = 'A'.repeat(70 * 1000 * 1000);
  const result = await handler(server, 'upload_file')({ name: 's.zip', content: huge });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /ZIP 文件过大/);
});

test('upload_file：ZIP 上传抛错 → 捕获返回 isError', async () => {
  const { server } = makeServer({
    'POST /api/files/upload-zip-base64': Object.assign(new Error('boom'), { status: 500 }),
  });
  const result = await handler(server, 'upload_file')({ name: 's.zip', content: 'UEsDBA==' });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /ZIP 上传失败/);
});

test('upload_file：带 tags + categoryId → 调用 applyTagsAndCategory', async () => {
  const { server, api } = makeServer({
    'POST /api/files/upload-json': { id: 1, share_key: 'k' },
    'GET /api/tags': { tags: [{ id: 9, name: 'exist' }] },
    'PUT /api/files/1/category': { success: true },
  });
  await handler(server, 'upload_file')({ name: 'a.md', content: 'x', tags: ['exist', 'new'], categoryId: 5 });
  // categoryId 非空 → PUT /category
  const catCall = api._calls.find(c => c.path === '/api/files/1/category');
  assert.ok(catCall);
  assert.deepStrictEqual(catCall.body, { categoryId: 5 });
});

// ====================== get_file_content ======================

test('get_file_content：返回 id/name/type/size/content', async () => {
  const { server } = makeServer({
    'GET /api/files/3/content': { id: 3, original_name: 'x.md', file_type: 'markdown', content: 'hello' },
  });
  const result = await handler(server, 'get_file_content')({ id: 3 });
  const parsed = parseResult(result);
  assert.strictEqual(parsed.content, 'hello');
  assert.strictEqual(parsed.size, 5);
  assert.strictEqual(parsed.file_type, 'markdown');
});

// ====================== delete_file ======================

test('delete_file：DELETE /api/files/:id，返回含 id', async () => {
  const { server, api } = makeServer({ 'DELETE /api/files/4': { success: true } });
  const result = await handler(server, 'delete_file')({ id: 4 });
  assert.strictEqual(api._calls[0].method, 'DELETE');
  const parsed = parseResult(result);
  assert.strictEqual(parsed.id, 4);
});

// ====================== rename_file ======================

test('rename_file：PUT /api/files/:id {name}，返回含新 name', async () => {
  const { server, api } = makeServer({ 'PUT /api/files/5': { success: true } });
  const result = await handler(server, 'rename_file')({ id: 5, name: 'new.md' });
  assert.deepStrictEqual(api._calls[0].body, { name: 'new.md' });
  const parsed = parseResult(result);
  assert.strictEqual(parsed.name, 'new.md');
});

// ====================== get_file_url ======================

test('get_file_url：有 share_key → 返回 /s/:key 短链', async () => {
  const { server } = makeServer({ '*/api/files/': { share_key: 'KEY' } });
  const result = await handler(server, 'get_file_url')({ id: 6 });
  const parsed = parseResult(result);
  assert.strictEqual(parsed.url, 'http://localhost:3000/s/KEY');
  assert.strictEqual(parsed.share_key, 'KEY');
});

test('get_file_url：无 share_key → 返回 render 路径', async () => {
  const { server } = makeServer({ '*/api/files/': { share_key: null } });
  const result = await handler(server, 'get_file_url')({ id: 6 });
  const parsed = parseResult(result);
  assert.match(parsed.url, /\/api\/files\/6\/render$/);
  assert.strictEqual(parsed.share_key, null);
});

// ====================== star_file / unstar_file ======================

test('star_file：POST /api/files/:id/star，返回 starred:true', async () => {
  const { server, api } = makeServer({ '*/star': { success: true } });
  const result = await handler(server, 'star_file')({ fileId: 7 });
  assert.strictEqual(api._calls[0].path, '/api/files/7/star');
  const parsed = parseResult(result);
  assert.strictEqual(parsed.starred, true);
});

test('unstar_file：DELETE /api/files/:id/star，返回 starred:false', async () => {
  const { server, api } = makeServer({ '*/star': { success: true } });
  const result = await handler(server, 'unstar_file')({ fileId: 7 });
  assert.strictEqual(api._calls[0].path, '/api/files/7/star');
  const parsed = parseResult(result);
  assert.strictEqual(parsed.starred, false);
});

// ====================== list_file_versions / restore_file_version ======================

test('list_file_versions：格式化为多行文本', async () => {
  const { server } = makeServer({
    'GET /api/files/8/versions': {
      current: { size: 1024, updated_at: '2026-01-01T00:00:00Z' },
      versions: [{ version: 1, size: 512, created_at: '2025-12-31T00:00:00Z' }],
    },
  });
  const result = await handler(server, 'list_file_versions')({ fileId: 8 });
  const text = result.content[0].text;
  assert.match(text, /文件 #8 版本历史/);
  assert.match(text, /当前版本/);
  assert.match(text, /v1:/);
  assert.match(text, /1\.0 KB/);
});

test('restore_file_version：POST restore，返回合并字段', async () => {
  const { server, api } = makeServer({
    'POST /api/files/8/versions/1/restore': { success: true, version: 2 },
  });
  const result = await handler(server, 'restore_file_version')({ fileId: 8, version: 1 });
  assert.strictEqual(api._calls[0].path, '/api/files/8/versions/1/restore');
  const parsed = parseResult(result);
  assert.strictEqual(parsed.restoredVersion, 1);
  assert.strictEqual(parsed.version, 2);
});

// ====================== list_tags / add_tags_to_file ======================

test('list_tags：返回 tags 数组', async () => {
  const { server } = makeServer({ 'GET /api/tags': { tags: [{ id: 1, name: 'a' }] } });
  const result = await handler(server, 'list_tags')({});
  const parsed = parseResult(result);
  assert.strictEqual(parsed.length, 1);
});

test('add_tags_to_file：已有标签复用，新标签自动创建', async () => {
  const { server, api } = makeServer({
    'GET /api/tags': { tags: [{ id: 1, name: 'exist' }] },
    'POST /api/tags': { id: 2, name: 'new' },
    'PUT /api/files/9/tags': { success: true },
  });
  await handler(server, 'add_tags_to_file')({ fileId: 9, tags: ['exist', 'new'] });
  // exist 命中，new 创建
  const tagPost = api._calls.find(c => c.method === 'POST' && c.path === '/api/tags');
  assert.deepStrictEqual(tagPost.body, { name: 'new' });
  const putCall = api._calls.find(c => c.method === 'PUT' && c.path === '/api/files/9/tags');
  assert.deepStrictEqual(putCall.body, { tagIds: [1, 2] });
});

// ====================== list_categories / create_category / set_file_category ======================

test('list_categories：返回 categories 数组', async () => {
  const { server } = makeServer({ 'GET /api/categories': { categories: [{ id: 1 }] } });
  const result = await handler(server, 'list_categories')({});
  const parsed = parseResult(result);
  assert.strictEqual(parsed.length, 1);
});

test('create_category：POST /api/categories {name}', async () => {
  const { server, api } = makeServer({ 'POST /api/categories': { id: 1, name: '工作' } });
  const result = await handler(server, 'create_category')({ name: '工作' });
  assert.deepStrictEqual(api._calls[0].body, { name: '工作' });
  const parsed = parseResult(result);
  assert.strictEqual(parsed.id, 1);
});

test('set_file_category：传 categoryId → PUT category {categoryId}', async () => {
  const { server, api } = makeServer({ 'PUT /api/files/1/category': { success: true } });
  await handler(server, 'set_file_category')({ fileId: 1, categoryId: 5 });
  assert.deepStrictEqual(api._calls[0].body, { categoryId: 5 });
});

test('set_file_category：不传 categoryId → PUT category {categoryId: null}', async () => {
  const { server, api } = makeServer({ 'PUT /api/files/1/category': { success: true } });
  await handler(server, 'set_file_category')({ fileId: 1 });
  assert.deepStrictEqual(api._calls[0].body, { categoryId: null });
});

// ====================== list_content_templates / get_content_template ======================

test('list_content_templates：querystring 拼接 + limit clamp 到 20', async () => {
  const { server, api } = makeServer({ 'GET /api/content-templates': { templates: [] } });
  await handler(server, 'list_content_templates')({ scene: 'report', fileType: 'html', keyword: 'k', sort: 'use_count', limit: 50 });
  assert.strictEqual(api._calls[0].path, '/api/content-templates?scene=report&fileType=html&keyword=k&sort=use_count&limit=20');
});

test('list_content_templates：无参数 → 无 query', async () => {
  const { server, api } = makeServer({ 'GET /api/content-templates': { templates: [] } });
  await handler(server, 'list_content_templates')({});
  assert.strictEqual(api._calls[0].path, '/api/content-templates');
});

test('get_content_template：返回内容 + hint，并 fire-and-forget 调 /use', async () => {
  const { server, api } = makeServer({
    'GET /api/content-templates/1/content': { id: 1, title: 'T', file_type: 'html', content: '<p/>' },
    'POST /api/content-templates/1/use': { success: true },
  });
  const result = await handler(server, 'get_content_template')({ id: 1 });
  const parsed = parseResult(result);
  assert.strictEqual(parsed.title, 'T');
  assert.match(parsed.hint, /风格一致/);
  const useCall = api._calls.find(c => c.method === 'POST' && c.path === '/api/content-templates/1/use');
  assert.ok(useCall, '应调用 /use 增加使用计数');
});

test('get_content_template：/use 失败不影响主流程（fire-and-forget）', async () => {
  const { server } = makeServer({
    'GET /api/content-templates/1/content': { id: 1, title: 'T', file_type: 'html', content: '<p/>' },
    'POST /api/content-templates/1/use': Object.assign(new Error('boom'), { status: 500 }),
  });
  const result = await handler(server, 'get_content_template')({ id: 1 });
  // 不抛错，正常返回
  assert.ok(result.content[0].text.includes('T'));
});

// ====================== mcp/util 纯函数 ======================

test('formatSize：B / KB / MB 边界', () => {
  const { formatSize } = require('../../mcp/util');
  assert.strictEqual(formatSize(512), '512 B');
  assert.strictEqual(formatSize(1024), '1.0 KB');
  assert.strictEqual(formatSize(1048576), '1.0 MB');
});

test('formatTime：falsy → 未知时间；ISO → YYYY-MM-DD HH:mm', () => {
  const { formatTime } = require('../../mcp/util');
  assert.strictEqual(formatTime(null), '未知时间');
  assert.match(formatTime('2026-06-19T08:30:00Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('textResult：字符串原样，对象 JSON.stringify，isError 标记', () => {
  const { textResult } = require('../../mcp/util');
  assert.strictEqual(textResult('hi').content[0].text, 'hi');
  assert.ok(!textResult('hi').isError);
  const obj = textResult({ a: 1 });
  assert.strictEqual(obj.content[0].text, '{\n  "a": 1\n}');
  assert.strictEqual(textResult('err', { isError: true }).isError, true);
});
