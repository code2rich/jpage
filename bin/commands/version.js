// version 命令：交互式升级项目版本号，自动同步所有相关文件并打 tag。
//
//   jpage version bump [--type patch|minor|major] [--yes]
//
// 默认会询问确认；--yes 用于脚本/CI 场景。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');
const { out } = require('./_shared');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// 除 package.json / package-lock.json 外，需要手动同步版本的文件
const SYNC_FILES = [
  { path: 'skills/jpage/SKILL.md', pattern: (v) => new RegExp(`^version: ${escapeRegex(v)}$`, 'm'), replacement: (v) => `version: ${v}` },
  { path: 'docs/skill-integration-design.md', pattern: (v) => new RegExp(`^version: ${escapeRegex(v)}$`, 'm'), replacement: (v) => `version: ${v}` },
  { path: 'plugin-workspace/plugin.json', pattern: (v) => new RegExp(`"version": "${escapeRegex(v)}"`, 'g'), replacement: (v) => `"version": "${v}"` },
  { path: 'public/index.html', pattern: (v) => new RegExp(`\\?v=${escapeRegex(v)}`, 'g'), replacement: (v) => `?v=${v}` },
  { path: 'public/js/app.js', pattern: (v) => new RegExp(`\\?v=${escapeRegex(v)}`, 'g'), replacement: (v) => `?v=${v}` },
  { path: 'test/perf-bench.js', pattern: (v) => new RegExp(`\\?v=${escapeRegex(v)}`, 'g'), replacement: (v) => `?v=${v}` },
  { path: 'test/perf-harness.js', pattern: (v) => new RegExp(`\\?v=${escapeRegex(v)}`, 'g'), replacement: (v) => `?v=${v}` },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bumpSemver(version, type) {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`非法版本号：${version}`);
  }
  const [major, minor, patch] = parts;
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function question(rl, q) {
  return new Promise((resolve) => {
    rl.question(q, (answer) => resolve(answer.trim()));
  });
}

async function prompt(q) {
  if (!process.stdin.isTTY) {
    throw new Error('非交互式终端，请使用 --yes 选项或在交互式 shell 中运行');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await question(rl, q);
  } finally {
    rl.close();
  }
}

function usageError(msg) {
  const e = new Error(msg || '用法：jpage version bump [--type patch|minor|major] [--yes]');
  e.name = 'UsageError';
  return e;
}

function readPkgVersion() {
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
}

function syncFiles(current, next) {
  const changed = [];
  for (const item of SYNC_FILES) {
    const filePath = path.join(REPO_ROOT, item.path);
    if (!fs.existsSync(filePath)) {
      throw new Error(`同步目标文件不存在：${item.path}`);
    }
    let content = fs.readFileSync(filePath, 'utf-8');
    const pat = item.pattern(current);
    if (!pat.test(content)) {
      throw new Error(`${item.path} 中未找到当前版本号 ${current}，请检查文件是否已手动修改`);
    }
    content = content.replace(item.pattern(current), item.replacement(next));
    fs.writeFileSync(filePath, content, 'utf-8');
    changed.push(item.path);
  }
  return changed;
}

function runCmd(cmd, opts = {}) {
  execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit', ...opts });
}

async function run(client, args) {
  const sub = args.sub;
  if (sub !== 'bump') {
    throw usageError();
  }

  const current = readPkgVersion();
  let type = args.opts.type;

  if (!type) {
    type = await prompt(`当前版本 ${current}，请选择升级类型 [patch/minor/major]： `);
  }

  if (!['patch', 'minor', 'major'].includes(type)) {
    throw usageError(`非法类型：${type}，仅支持 patch/minor/major`);
  }

  const next = bumpSemver(current, type);
  const dryRun = args.opts['dry-run'] || args.opts.dryRun;

  if (!args.opts.yes) {
    const filesList = SYNC_FILES.map((f) => `  - ${f.path}`).join('\n');
    const action = dryRun ? '（演练模式，不执行 git 操作）' : `并自动执行 commit + tag v${next}`;
    const answer = await prompt(
      `即将把版本从 ${current} 升级到 ${next}。\n` +
      `会同步更新以下文件（含 package.json / package-lock.json）：\n${filesList}\n` +
      `${action}。\n确认继续？[y/N] `
    );
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      out('已取消版本升级。\n');
      return;
    }
  }

  // 1. npm version 更新 package.json / package-lock.json
  runCmd(`npm version ${type} --no-git-tag-version`);

  // 2. 同步其他文件
  const changed = syncFiles(current, next);

  if (dryRun) {
    out(`[演练模式] 已更新文件（未提交/打 tag/推送）：\n`);
    out(`  package.json\n`);
    out(`  package-lock.json\n`);
    for (const f of changed) out(`  ${f}\n`);
    out(`版本：${current} → ${next}\n`);
    out('如需回滚：git checkout -- . && git clean -fd\n');
    return;
  }

  // 3. git add + commit
  runCmd('git add -A');
  runCmd(`git commit -m "chore(release): bump version to ${next}\n\n统一同步版本号到 ${next}。"`);

  // 4. 打 tag 并推送
  runCmd(`git tag v${next}`);
  runCmd('git push origin main');
  runCmd(`git push origin v${next}`);

  out(`✓ 已升级并推送：${current} → ${next}（tag v${next}）\n`);
  out('  若仓库已配置 NPM_TOKEN，GitHub Actions release 工作流会自动发布到 npm。\n');
}

module.exports = { run };
