// template 命令：浏览内容模板市场并使用模板实例化文件。
//
//   jpage template ls [--category <slug>] [--file-type html|markdown] [--kw <词>] [--limit N]
//   jpage template get <shareKey>
//   jpage template use <shareKey> [--name <文件名>] [--public]
//
// 市场公开端点使用 share_key 作为标识，不再暴露内部自增 id。

const { out } = require('./_shared');

async function run(client, args) {
  const sub = args.sub;
  if (!sub || sub === 'ls' || sub === 'list') {
    return listTemplates(client, args.opts);
  }

  const shareKey = args.positional[2];
  if (!shareKey) {
    const e = new Error('用法：jpage template get <shareKey> | jpage template use <shareKey> [--name ...] [--public]');
    e.name = 'UsageError';
    throw e;
  }

  if (sub === 'get') {
    return getTemplate(client, shareKey);
  }
  if (sub === 'use') {
    return useTemplate(client, shareKey, args.opts);
  }

  const e = new Error(`未知子命令：${sub}。支持：ls / get / use`);
  e.name = 'UsageError';
  throw e;
}

async function listTemplates(client, opts) {
  const params = new URLSearchParams();
  if (opts.category) params.set('category', opts.category);
  if (opts.fileType) params.set('fileType', opts.fileType);
  if (opts.kw) params.set('keyword', opts.kw);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const data = await client.get('/api/content-templates/market' + (qs ? '?' + qs : ''));
  const templates = data.templates || [];
  if (templates.length === 0) {
    out('（市场暂无模板）\n');
    return;
  }
  for (const t of templates) {
    const typeLabel = t.file_type === 'markdown' ? 'MD' : 'HTML';
    out(`${t.share_key} [${typeLabel}] ${t.title}\n`);
    if (t.description) out(`  ${t.description}\n`);
  }
}

async function getTemplate(client, shareKey) {
  const t = await client.get(`/api/content-templates/market/${shareKey}/preview`);
  out(`${t.share_key || shareKey} ${t.title}\n`);
  out(`类型：${t.file_type}\n`);
  if (t.description) out(`描述：${t.description}\n`);
  out(`\n使用此模板：jpage template use ${shareKey}\n`);
}

async function useTemplate(client, shareKey, opts) {
  const body = {};
  if (opts.name) body.originalName = opts.name;
  if (opts.public) body.isPublic = true;

  const data = await client.post(`/api/content-templates/${shareKey}/instantiate`, body);
  out(`✓ 已使用模板 ${data.templateShareKey || shareKey} 创建文件 #${data.fileId}\n`);
}

module.exports = { run };
