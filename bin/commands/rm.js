// rm 命令：删除文件。后端：DELETE /api/files/:id。不可撤销。

const { out, err } = require('./_shared');

async function run(client, args, { exit }) {
  const id = args.sub;
  if (!id) {
    const e = new Error('用法：jpage rm <id>');
    e.name = 'UsageError';
    throw e;
  }
  // 简单防误删：--yes 才跳过确认（非交互环境默认会提示）
  if (!args.opts.yes && process.stdin.isTTY) {
    err(`将删除文件 #${id}，此操作不可撤销。加 --yes 跳过确认。\n`);
    (exit || ((c) => { process.exitCode = c; }))(1);
    return;
  }
  await client.del(`/api/files/${id}`);
  out(`✓ 已删除 #${id}\n`);
}

module.exports = { run };
