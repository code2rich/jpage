// star / unstar 命令：收藏 / 取消收藏。
// 后端：POST /api/files/:id/star、DELETE /api/files/:id/star。

const { out } = require('./_shared');

async function run(client, args) {
  const id = args.sub;
  if (!id) {
    const e = new Error('用法：jpage star <id>');
    e.name = 'UsageError';
    throw e;
  }
  // cmd 本身就是 star 或 unstar
  if (args.cmd === 'unstar') {
    await client.del(`/api/files/${id}/star`);
    out(`✓ 已取消收藏 #${id}\n`);
  } else {
    await client.post(`/api/files/${id}/star`);
    out(`✓ 已收藏 #${id}\n`);
  }
}

module.exports = { run };
