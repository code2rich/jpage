// skills 命令：列出 / 查看 / 下载 Skill 包。
// 后端：GET /api/skills、GET /api/skills/:name、GET /api/skills/:name/download（zip 流）。

const fs = require('fs');
const path = require('path');
const { out } = require('./_shared');

async function run(client, args, { base }) {
  const sub = args.sub; // ls / get / download
  if (!sub || sub === 'ls' || sub === 'list') {
    return listSkills(client);
  }
  const name = args.positional[2];
  if (!name) {
    const e = new Error('用法：jpage skills get <name> | jpage skills download <name>');
    e.name = 'UsageError';
    throw e;
  }
  if (sub === 'get') {
    return getSkill(client, name);
  }
  if (sub === 'download') {
    return downloadSkill(client, name, args, { base });
  }
  const e = new Error(`未知子命令：${sub}。支持：ls / get / download`);
  e.name = 'UsageError';
  throw e;
}

async function listSkills(client) {
  const data = await client.get('/api/skills');
  const skills = data.skills || [];
  if (skills.length === 0) {
    out('（无 Skill）\n');
    return;
  }
  for (const s of skills) {
    out(`${s.name}  v${s.version || '-'}  (${s.fileCount || 0} 文件)\n`);
    if (s.description) {
      out(`  ${s.description}\n`);
    }
  }
}

async function getSkill(client, name) {
  const s = await client.get(`/api/skills/${name}`);
  out(`${s.title || s.name}  v${s.version || '-'}  作者：${s.author || '-'}\n`);
  if (s.description) out(`\n${s.description}\n`);
  out(`\n文件（${s.fileCount || (s.files || []).length}）：\n`);
  for (const f of s.files || []) {
    out(`  ${f}\n`);
  }
}

async function downloadSkill(client, name, args, _ctx) {
  const res = await client.raw(`/api/skills/${name}/download`);
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '');
    const e = new Error(`下载失败：HTTP ${res.status} ${text}`);
    e.name = 'HttpError';
    e.status = res.status;
    throw e;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const outFile = args.opts.out || `${name}.zip`;
  fs.writeFileSync(path.resolve(outFile), buf);
  out(`✓ 已下载 ${name} → ${outFile} (${buf.length} 字节)\n`);
}

module.exports = { run };
