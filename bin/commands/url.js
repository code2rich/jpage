// url 命令：打印文件的公开预览短链。
// 后端：GET /api/files/:id（取 share_key，拼 /s/:key）。

const { shareUrl, out, err } = require('./_shared');

async function run(client, args, { base, exit }) {
  const id = args.sub;
  if (!id) {
    const e = new Error('用法：jpage url <id>');
    e.name = 'UsageError';
    throw e;
  }
  const data = await client.get(`/api/files/${id}`);
  const url = shareUrl(base, data);
  if (!url) {
    err(
      `文件 #${id} 没有公开短链（私有文件）。用 \`jpage mv ${id} --public\` 设为公开后再获取链接。\n`
    );
    (exit || ((c) => { process.exitCode = c; }))(1);
    return;
  }
  out(url + '\n');
}

module.exports = { run };
