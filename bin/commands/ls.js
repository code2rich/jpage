// ls 命令：列出文件。
// 后端：GET /api/files（支持 page/limit/sort/order/keyword/category/tag）。

const { formatSize, formatTime, out } = require('./_shared');

async function run(client, args) {
  const o = args.opts;
  const params = new URLSearchParams();
  if (o.page) params.set('page', o.page);
  if (o.limit) params.set('limit', o.limit);
  if (o.sort) params.set('sort', o.sort);
  if (o.order) params.set('order', o.order);
  if (o.kw || o.keyword) params.set('keyword', o.kw || o.keyword);
  if (o.cat || o.category) params.set('category', o.cat || o.category);
  if (o.tag) params.set('tag', o.tag);
  const qs = params.toString();

  const data = await client.get('/api/files' + (qs ? '?' + qs : ''));
  const files = data.files || [];
  const pg = data.pagination || {};

  if (files.length === 0) {
    out('（无文件）\n');
    return;
  }

  // 对齐表格：id / 类型 / 公开 / 大小 / 更新时间 / 文件名 / 短链 / 标签
  for (const f of files) {
    const pub = f.is_public ? 'pub' : 'pri';
    const tags = (f.tags || []).map((t) => t.name).join(',');
    const bundle = f.is_bundle ? ' 📦' : '';
    const short = f.share_key ? `  /s/${f.share_key}` : '';
    out(
      `#${f.id}  [${f.file_type || '?'} ${pub}]  ${formatSize(f.size).padEnd(7)}  ` +
        `${formatTime(f.updated_at)}  ${f.original_name}${bundle}` +
        short +
        (tags ? `  {${tags}}` : '') +
        '\n'
    );
  }
  out(
    `\n第 ${pg.page || 1} / ${pg.totalPages || 1} 页，共 ${pg.total || files.length} 个\n`
  );
}

module.exports = { run };
