// update 命令：把 jpage 自更新到最新版（npm 全局包）。
//
// 纯客户端操作：不调后端 API，不需 token（自更新与 jpage 服务端无关）。
// 流程：npm view 查最新版本 → 与本地对比 → 有新版则 npm install -g 重装。
//
// 可注入 npmExec（形如 (args) => string）：测试时注入假执行器，避免真的跑 npm。
// 默认走 child_process.execFileSync，与 build.js 既有风格一致。

const { execFileSync } = require('child_process');
const { out, err } = require('./_shared');

const PKG_NAME = '@code2rich/jpage';
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// 默认 npm 执行器：同步拿 stdout（trim 尾部换行）。
function defaultNpmExec(args) {
  return execFileSync(npmBin, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function run(_client, args, ctx) {
  const o = args.opts;
  const exit = ctx.exit || ((c) => { process.exitCode = c; });
  const npmExec = ctx.npmExec || defaultNpmExec;

  // --registry 后面没给值时，args.js 会把它解析成 true。
  if (o.registry === true) {
    const e = new Error('用法：jpage update [--registry <url>] [--check]');
    e.name = 'UsageError';
    throw e;
  }
  const registryArgs = o.registry ? ['--registry', o.registry] : [];

  const current = require('../../package.json').version;

  // 查最新版本。
  let latest;
  try {
    latest = (npmExec(['view', PKG_NAME, 'version', ...registryArgs]) || '').trim();
  } catch (e) {
    err(`✗ 查询最新版本失败：${e.message || e}\n`);
    err('  检查网络连接，或用 --registry 指定可达的 npm 源。\n');
    exit(1);
    return;
  }

  if (latest === current) {
    out(`已是最新版 ${current}\n`);
    return;
  }

  out(`发现新版本 ${latest}（当前 ${current}），正在更新…\n`);

  if (o.check) {
    return; // 只查不更新
  }

  try {
    npmExec(['install', '-g', `${PKG_NAME}@latest`, ...registryArgs]);
  } catch (e) {
    const detail = (e.stderr || e.message || e).toString().split('\n').slice(0, 3).join('\n');
    err(`✗ 更新失败：\n${detail}\n`);
    err('  常见原因：权限不足（试 sudo）、网络中断、registry 不可达。\n');
    err('  也可手动执行：npm install -g ' + PKG_NAME + '@latest\n');
    exit(1);
    return;
  }

  out(`✓ 已更新到 ${latest}，重新运行 jpage 生效\n`);
}

module.exports = { run };
