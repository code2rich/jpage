#!/usr/bin/env node
// jpage CLI 入口：解析 argv → 解析配置 → 创建 client → dispatch 到命令。
//
// 分层：
//   args.js     argv → {cmd, sub, opts, positional}
//   config.js   opts + env + .env → {token, base}
//   client.js   createClient({base, token, fetchImpl})
//   commands/*  每个命令导出 async run(client, args, ctx)
//
// 错误处理集中在此：
//   UsageError  → 打印用法到 stderr，退出 2
//   HttpError   → 打印 API 错误到 stderr，401 额外提示 token，退出 1
//   NetworkError→ 打印连接错误，退出 1
//
// 导出 run(argv, {fetchImpl}) 供测试调用（不依赖 process.argv、不退出进程）。

const { parse } = require('./args');
const { resolveConfig } = require('./config');
const { createClient, HttpError } = require('./client');
const { setIo, resetIo } = require('./commands/_shared');

const COMMANDS = {
  upload: () => require('./commands/upload'),
  ls: () => require('./commands/ls'),
  cat: () => require('./commands/cat'),
  url: () => require('./commands/url'),
  mv: () => require('./commands/mv'),
  rm: () => require('./commands/rm'),
  star: () => require('./commands/star'),
  unstar: () => require('./commands/star'),
  tags: () => require('./commands/tags'),
  skills: () => require('./commands/skills'),
  skill: () => require('./commands/skill'),
  template: () => require('./commands/template'),
  version: () => require('./commands/version'),
  whoami: () => require('./commands/whoami'),
  update: () => require('./commands/update'),
};

// 这些命令纯本地执行（不调后端 API），不强制要求 token。
const NO_TOKEN = new Set(['update', 'skill', 'version']);

const HELP = `jpage —— 即页命令行

用法：
  jpage <命令> [参数] [选项]

命令：
  upload <路径> [--public] [--overwrite ID]   上传文件（multipart，ZIP 自动判 bundle/batch）
  ls [--page N --limit N --sort 字段 --order asc|desc --kw 词 --cat 分类 --tag 标签]
                                              列出文件
  cat <id>                                    输出文件原始内容
  url <id>                                    打印文件公开预览链接 /s/:key
  mv <id> <新名> [--public|--private]          改名 / 改公开性
  rm <id> [--yes]                             删除文件（--yes 跳过确认）
  star <id> / unstar <id>                     收藏 / 取消收藏
  tags <id> [add|set|clear] [名,名,...]        查看 / 追加 / 替换 / 清空标签
  skills ls | get <名> | download <名> [--out 文件]
                                              列出 / 查看 / 下载 Skill（服务器端 skills）
  skill install [--dir <路径>]                安装本包内置的 jpage Skill 到 Claude
  skill update                                更新本地 jpage Skill（install 别名）
  skill uninstall [--dir <路径>]              卸载本地 jpage Skill
  version bump [--type patch|minor|major] [--target x.y.z] [--yes] [--dry-run]
                                              交互式升级项目版本号并同步所有文件
  template ls [--category <slug> --file-type html|markdown --kw <词> --limit N]
                                              浏览内容模板市场
  template get <id>                           查看模板完整内容
  template use <id> [--name <文件名>] [--public]
                                              使用模板创建文件
  whoami                                      校验 token 是否有效
  update [--registry <url>] [--check]         自更新到最新版（不需 token）

通用选项：
  --token <TOKEN>        鉴权 token（jp_ 用户 token 或 MCP_TOKEN）
  --base <URL>           服务地址（默认 https://jpage.cn）
  --help, -h             显示本帮助

token 优先级：--token > JPAGE_TOKEN 环境变量 > MCP_TOKEN 环境变量 > .env 里的同名变量
base  优先级：--base  > JPAGE_BASE  环境变量 > 默认 https://jpage.cn

支持的环境变量：JPAGE_TOKEN、JPAGE_BASE、MCP_TOKEN（JPAGE_BASE 可替代 --base）

示例：
  jpage upload ./report.html --public
  jpage upload ./site.zip --public
  jpage upload ./x.html --overwrite 12
  jpage ls --kw 季度 --limit 5
  jpage cat 8
  jpage tags 8 add 季度,财报
  jpage skills download jpage
  jpage template use 12 --name 季度汇报.html --public

详细文档：https://github.com/code2rich/jpage`;

/**
 * 运行 CLI。供入口和测试共用。
 * @param {string[]} argv - 去掉 node/脚本名后的参数
 * @param {object} [inject] - 测试注入：{ fetchImpl, env, cwd, stdout, stderr, exit }
 * @returns {Promise<void>} 失败时设置 exit 状态（默认 process.exitCode，测试可注入）
 */
async function run(argv, inject = {}) {
  // 注入 I/O：默认走 process.stdout/stderr + process.exitCode。
  // 测试注入 { stdout, stderr, exit } 用内存 sink + 计数器，避免污染 node:test 输出。
  const stdout = inject.stdout || process.stdout;
  const stderr = inject.stderr || process.stderr;
  const exit = inject.exit || ((code) => { process.exitCode = code; });

  // 把命令模块的 out()/err() 重定向到同一组流
  setIo({ stdout, stderr });

  const parsed = parse(argv);
  const { cmd, opts } = parsed;

  if (opts.version) {
    const pkg = require('../package.json');
    stdout.write(pkg.version + '\n');
    return;
  }

  if (opts.help || opts.h || !cmd) {
    stdout.write(HELP + '\n');
    return;
  }

  if (!COMMANDS[cmd]) {
    stderr.write(`未知命令：${cmd}\n\n${HELP}\n`);
    exit(2);
    return;
  }

  const { token, base } = resolveConfig(opts, inject.env, inject.cwd);
  if (!token && !NO_TOKEN.has(cmd)) {
    stderr.write(
      '未提供 token。用 --token <TOKEN>、JPAGE_TOKEN 环境变量、或 .env 的 MCP_TOKEN 设置。\n'
    );
    exit(2);
    return;
  }

  const client = createClient({ base, token, fetchImpl: inject.fetchImpl });
  const ctx = { base, token, exit, npmExec: inject.npmExec };
  const mod = COMMANDS[cmd]();

  try {
    await mod.run(client, parsed, ctx);
  } catch (e) {
    handleError(e, { stderr, exit });
  }
}

function handleError(e, { stderr, exit }) {
  if (e.name === 'UsageError') {
    stderr.write(e.message + '\n');
    exit(2);
    return;
  }
  if (e instanceof HttpError) {
    stderr.write(`✗ ${e.message}\n`);
    if (e.status === 401) {
      stderr.write('  token 无效或已失效。检查 --token / JPAGE_TOKEN / .env 的 MCP_TOKEN。\n');
    }
    if (e.status === 429) {
      stderr.write('  请求过于频繁（如上传 50 次/15 分钟）。稍后再试。\n');
    }
    exit(1);
    return;
  }
  if (e.name === 'NetworkError') {
    stderr.write(`✗ ${e.message}\n`);
    exit(1);
    return;
  }
  // 兜底
  stderr.write(`✗ ${e.message || e}\n`);
  exit(1);
}

// 直接执行（node bin/jpage.js ...）
if (require.main === module) {
  const argv = process.argv.slice(2);
  run(argv).catch((e) => {
    process.stderr.write(`✗ ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  }).finally(() => {
    resetIo();
  });
}

module.exports = { run, HELP, COMMANDS, handleError };
