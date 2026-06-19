// mv 命令：修改文件名（original_name）。后端：PUT /api/files/:id { name }。

const { out } = require('./_shared');

async function run(client, args) {
  const id = args.sub;
  const newName = args.positional[2];
  if (!id || !newName) {
    const e = new Error('用法：jpage mv <id> <新文件名>');
    e.name = 'UsageError';
    throw e;
  }
  const body = { name: newName };
  if (args.opts.public !== undefined) body.isPublic = true;
  if (args.opts.private !== undefined) body.isPublic = false;
  await client.put(`/api/files/${id}`, body);
  out(`✓ 已更新 #${id}\n`);
}

module.exports = { run };
