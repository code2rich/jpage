// upload 命令：上传本地文件到即页。
//
// 后端契约（routes/files/upload.js）：
//   POST /api/files/upload          multipart，field=file，可选 isPublic=true
//                                  （同名自动覆盖，含 version 备份）
//   POST /api/files/:id/overwrite   multipart，field=file（按 id 覆盖，仅 file 一个 field）
//
// 性能：用全局 FormData + Blob 构造 multipart，二进制流式，
// 不把内容 base64 塞进任何 token 流（这正是 CLI 相对 MCP upload_file 的核心优势）。

const fs = require('fs');
const path = require('path');
const { formatSize, out } = require('./_shared');

async function run(client, args, { base }) {
  const filePath = args.sub; // 第一个位置参数（cmd=upload，sub=文件路径）
  if (!filePath) {
    throw new UsageError('用法：jpage upload <文件路径> [--public] [--overwrite ID]');
  }

  const abs = path.resolve(filePath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new UsageError(`文件不存在或无法读取：${filePath}`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`不是文件：${filePath}`);
  }

  const buf = fs.readFileSync(abs);
  const name = path.basename(abs);
  const blob = new Blob([buf]);
  const overwriteId = args.opts.overwrite;

  const form = new FormData();
  form.append('file', blob, name);
  // multipart 默认私有；--public 才公开（与 routes/files/upload.js:28 一致）
  if (args.opts.public) form.append('isPublic', 'true');

  let endpoint;
  if (overwriteId) {
    endpoint = `/api/files/${overwriteId}/overwrite`;
  } else {
    endpoint = '/api/files/upload';
  }

  const data = await client.postForm(endpoint, form);
  printResult(data, base);
}

function printResult(data, base) {
  // 批量上传（ZIP 含多个独立文件）
  if (data.type === 'batch') {
    out(`✓ 批量上传 ${data.count} 个文件\n`);
    for (const f of data.files) {
      const url = f.share_key ? `${base}/s/${f.share_key}` : '-';
      out(`  #${f.id}  ${f.original_name}  →  ${url}\n`);
    }
    return;
  }

  // 单文件 / bundle
  const url = data.share_key ? `${base}/s/${data.share_key}` : '-';
  out(`✓ 上传成功 #${data.id}  ${data.original_name}  (${formatSize(data.size)})\n`);
  if (data.overwritten) {
    out(`  覆盖已有文件，版本 v${data.version}\n`);
  }
  if (data.is_bundle) {
    out(`  网站包（bundle），入口：${data.entry_path || 'index.html'}\n`);
  }
  out(`  预览：${url}\n`);
}

// 命令层专用的用法错误（区别于 HTTP/网络错误），bin/jpage.js 据此打印帮助并退出 2
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

module.exports = { run, UsageError };
