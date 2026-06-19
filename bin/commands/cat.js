// cat 命令：输出文件原始内容到 stdout。
// 后端：GET /api/files/:id/content（owner/admin 限定）。
// bundle（is_bundle=1）不支持取「整个内容」，后端会返回入口文件内容，此处原样输出。

const { out } = require('./_shared');

async function run(client, args) {
  const id = args.sub;
  if (!id) {
    const e = new Error('用法：jpage cat <id>');
    e.name = 'UsageError';
    throw e;
  }
  const data = await client.get(`/api/files/${id}/content`);
  if (typeof data.content === 'string') {
    out(data.content);
    if (!data.content.endsWith('\n')) out('\n');
  } else {
    out(JSON.stringify(data, null, 2) + '\n');
  }
}

module.exports = { run };
