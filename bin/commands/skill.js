// skill 命令：将本 npm 包内置的 jpage Skill 安装到 Claude / 类似客户端的 skills 目录。
//
//   jpage skill install [--dir <路径>]
//   jpage skill update                    （install 的别名）
//   jpage skill uninstall [--dir <路径>]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { out } = require('./_shared');

// Skill 源目录：npm 包内的 skills/jpage/
const SOURCE_SKILL_DIR = path.resolve(__dirname, '..', '..', 'skills', 'jpage');

// 常见 skills 目录候选（按优先级）
function candidateDirs() {
  const home = os.homedir();
  return [
    process.env.JPAGE_SKILL_DIR,
    path.join(home, '.claude', 'skills', 'jpage'),
    path.join(home, '.claude-code', 'skills', 'jpage'),
    path.join(home, '.agents', 'skills', 'jpage'),
  ].filter(Boolean);
}

function detectTargetDir(explicitDir) {
  if (explicitDir) return path.resolve(explicitDir);

  const candidates = candidateDirs();
  // 优先使用父目录已存在的候选（说明用户确实在该客户端下使用过 skills）
  for (const c of candidates) {
    if (fs.existsSync(path.dirname(c))) return c;
  }
  // 都没有则默认 ~/.claude/skills/jpage
  return candidates[0];
}

function ensureSource() {
  if (!fs.existsSync(SOURCE_SKILL_DIR)) {
    throw new Error(`未找到内置 Skill 目录：${SOURCE_SKILL_DIR}。请确认 jpage 安装完整。`);
  }
}

async function installSkill(explicitDir) {
  ensureSource();
  const target = detectTargetDir(explicitDir);

  fs.mkdirSync(path.dirname(target), { recursive: true });

  // 先清空旧版本，避免残留文件
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }

  fs.cpSync(SOURCE_SKILL_DIR, target, { recursive: true, preserveTimestamps: true });

  const pkg = require('../../package.json');
  out(`✓ 已安装 jpage Skill v${pkg.version} → ${target}\n`);
  out(`  使用方式：在 Claude Code / Desktop 的 skills 设置中确认已加载「jpage」\n`);
  out(`  如需指定目录：jpage skill install --dir /path/to/skills/jpage\n`);
}

async function uninstallSkill(explicitDir) {
  const target = detectTargetDir(explicitDir);
  if (!fs.existsSync(target)) {
    out(`（Skill 未安装于 ${target}）\n`);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  out(`✓ 已移除 jpage Skill：${target}\n`);
}

async function run(client, args) {
  const sub = args.sub || 'install';
  const explicitDir = args.opts.dir;

  if (sub === 'install' || sub === 'update') {
    return installSkill(explicitDir);
  }
  if (sub === 'uninstall') {
    return uninstallSkill(explicitDir);
  }

  const e = new Error(`未知子命令：${sub}。支持：install / update / uninstall`);
  e.name = 'UsageError';
  throw e;
}

module.exports = { run };
