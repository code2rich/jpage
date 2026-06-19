// whoami 命令：校验当前 token 是否有效（纯客户端，不动后端）。
//
// 后端没有 token→用户名的解析端点（GET /api/auth/me 只认 session，不认 Bearer）。
// 故用 GET /api/files?limit=1 探测：200=有效，401=无效。无法显示用户名。

const { out, err } = require('./_shared');

async function run(client, _args, { base, token, exit }) {
  try {
    await client.get('/api/files?limit=1');
    out(`✓ token 有效，可访问 ${base}\n`);
    if (token) {
      // 只显示前缀，避免在终端泄露完整 token
      const prefix = token.length > 8 ? token.slice(0, 8) + '…' : token;
      out(`  token：${prefix}\n`);
    }
  } catch (e) {
    if (e.status === 401) {
      err(
        '✗ token 无效或未设置。用 --token <TOKEN>、JPAGE_TOKEN 环境变量、或 .env 的 MCP_TOKEN 提供。\n'
      );
      (exit || ((c) => { process.exitCode = c; }))(1);
      return;
    }
    throw e;
  }
}

module.exports = { run };
