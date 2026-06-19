// tags 命令：查看/添加/替换/清空文件的标签。
//
// 后端语义：PUT /api/files/:id/tags { tagIds:[] } 是「全量替换」，且只收 tag id（数字），
// 没有「按名字追加」端点。CLI 在客户端封装出更友好的命令：
//
//   jpage tags <id>               列出当前标签
//   jpage tags <id> add a,b,c     把这些标签追加到现有标签（缺失的标签自动创建）
//   jpage tags <id> set a,b       全量替换为这些标签（缺失的自动创建）
//   jpage tags <id> clear         清空标签
//
// 标签名 → id：GET /api/tags 拿全表按 name 精确匹配；缺失的 POST /api/tags {name} 建。

const { out } = require('./_shared');

async function run(client, args) {
  const id = args.sub;
  if (!id) {
    const e = new Error('用法：jpage tags <id> [add|set|clear] [标签名,标签名,...]');
    e.name = 'UsageError';
    throw e;
  }

  const action = args.positional[2]; // add / set / clear，或空（查询）
  const namesArg = args.positional[3];

  // 无 action → 列出
  if (!action) {
    return listTags(client, id);
  }

  if (action === 'clear') {
    await client.put(`/api/files/${id}/tags`, { tagIds: [] });
    out(`✓ 已清空 #${id} 的标签\n`);
    return;
  }

  if (action !== 'add' && action !== 'set') {
    const e = new Error(`未知操作：${action}。支持：add / set / clear`);
    e.name = 'UsageError';
    throw e;
  }

  if (!namesArg) {
    const e = new Error(`用法：jpage tags ${id} ${action} <标签名,标签名,...>`);
    e.name = 'UsageError';
    throw e;
  }

  const names = namesArg.split(',').map((s) => s.trim()).filter(Boolean);

  // add：先拿现有标签，合并去重；set：直接用新的
  let targetNames = names;
  if (action === 'add') {
    const file = await client.get(`/api/files/${id}`);
    const existing = (file.tags || []).map((t) => t.name);
    targetNames = [...new Set([...existing, ...names])];
  }

  // 名字 → id（缺失的创建）
  const tagIds = await resolveOrCreateTagIds(client, targetNames);
  await client.put(`/api/files/${id}/tags`, { tagIds });
  out(
    `✓ 已${action === 'add' ? '追加' : '设置'} #${id} 的标签：${targetNames.join(', ')}\n`
  );
}

async function listTags(client, id) {
  const file = await client.get(`/api/files/${id}`);
  const tags = file.tags || [];
  if (tags.length === 0) {
    out(`文件 #${id} 没有标签\n`);
    return;
  }
  out(`文件 #${id} 的标签：\n`);
  for (const t of tags) {
    out(`  ${t.name} (#${t.id})\n`);
  }
}

// 把标签名数组解析为 id 数组；缺失的标签通过 POST /api/tags 创建。
async function resolveOrCreateTagIds(client, names) {
  const all = await client.get('/api/tags');
  const byName = new Map((all.tags || []).map((t) => [t.name, t.id]));
  const ids = [];
  for (const name of names) {
    if (byName.has(name)) {
      ids.push(byName.get(name));
      continue;
    }
    const created = await client.post('/api/tags', { name });
    byName.set(name, created.id);
    ids.push(created.id);
  }
  return ids;
}

module.exports = { run };
