// CLI 配置解析：token 与 base（服务地址）的来源优先级。
//
// 不引入 dotenv。.env 文件按 KEY=VALUE 简单行解析（兼容带引号、注释、空行）。
//
// 优先级（高 → 低）：
//   --token  >  JPAGE_TOKEN env  >  MCP_TOKEN env（环境 + .env 文件）
//   --base   >  JPAGE_BASE  env  >  默认 http://localhost:8858
//
// 设计：让 jpage 能「无参跑通本地默认实例」，同时支持远程/CI 场景显式指定。

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = 'http://localhost:8858';

// 解析 .env 文件为对象。仅支持最简语法：KEY=VALUE，值可带引号，# 开头为注释。
// 失败（文件不存在/读错）返回空对象，由调用方决定是否报错。
function parseEnvFile(filePath) {
  const result = {};
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return result;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// 从当前目录向上查找 .env（最多 5 层），合并所有命中文件。
// 这模仿 MCP/SKILL.md 里「项目根 .env」的惯例。
function loadEnvUp(startDir) {
  const merged = {};
  let dir = path.resolve(startDir);
  for (let i = 0; i < 5; i++) {
    const envPath = path.join(dir, '.env');
    const parsed = parseEnvFile(envPath);
    Object.assign(merged, parsed);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return merged;
}

/**
 * 解析最终配置。
 * @param {object} opts - 来自 args.parse 的 opts 对象（含 --token/--base 等）
 * @param {object} [env] - 环境变量（默认 process.env，测试可注入）
 * @param {string} [cwd] - .env 查找起点（默认 process.cwd()）
 * @returns {{token: string|null, base: string}}
 */
function resolveConfig(opts, env = process.env, cwd = process.cwd()) {
  const dotEnv = loadEnvUp(cwd);

  const token =
    opts.token ||
    env.JPAGE_TOKEN ||
    dotEnv.JPAGE_TOKEN ||
    env.MCP_TOKEN ||
    dotEnv.MCP_TOKEN ||
    null;

  const base = (opts.base || env.JPAGE_BASE || dotEnv.JPAGE_BASE || DEFAULT_BASE)
    .replace(/\/+$/, ''); // 去尾部斜杠，避免拼接出 //

  return { token, base };
}

module.exports = { resolveConfig, parseEnvFile, loadEnvUp, DEFAULT_BASE };
