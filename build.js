#!/usr/bin/env node
// 前端构建：esbuild 打包 + 代码分割 + minify（JS）+ minify（CSS）
//
// 产出 public/dist/：
//   - app.[hash].js          入口（路由 + 全局状态/主题）
//   - chunks/*.[hash].js     路由级懒加载 chunk（landing/login/home/preview + 共享 chunk）
//   - style.[hash].css       压缩后的样式
//   - manifest.json          原始名 -> 带哈希文件名 的映射，供 index.html 引用
//
// 用法：node build.js        （生产：minify + 哈希）
//       node build.js --dev  （开发：不 minify、不哈希，便于调试）
//
// 设计原则：不改变"无构建即可开发"的约定——public/js 与 public/css 仍是源文件，
// 可直接被浏览器加载（开发模式 server.js 仍可跑源文件）。本脚本仅用于生产打包到 public/dist。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PUBLIC = path.join(__dirname, 'public');
const DIST = path.join(PUBLIC, 'dist');
const isDev = process.argv.includes('--dev');

// 清理 dist
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

function runEsbuild(args) {
  // 用 npx 调 esbuild（devDependency），保证跨环境一致
  execFileSync('npx', ['esbuild', ...args], { stdio: 'inherit', cwd: __dirname });
}

// --- 1. JS：打包 app.js，代码分割 ---
const entryNames = isDev ? '[name]' : '[name]-[hash]';
const jsArgs = [
  path.join(PUBLIC, 'js', 'app.js'),
  '--bundle', '--format=esm',
  '--splitting',
  '--outdir=' + path.join(DIST),
  '--outbase=' + path.join(PUBLIC, 'js'),
  '--entry-names=' + entryNames,
  '--chunk-names=chunks/' + entryNames,
  '--metafile=' + path.join(DIST, 'meta.json'),
];
if (!isDev) jsArgs.push('--minify', '--target=es2020');
runEsbuild(jsArgs);

// --- 2. CSS：minify style.css ---
const cssSrc = path.join(PUBLIC, 'css', 'style.css');
const cssArgs = [
  cssSrc,
  '--outfile=' + path.join(DIST, isDev ? 'style.css' : 'style.css'),
];
if (!isDev) cssArgs.push('--minify');
// esbuild 对单文件 css 用 --outfile；但我们要带哈希名 → 先输出再改名
runEsbuild([cssSrc, '--outfile=' + path.join(DIST, 'style.tmp.css'), ...(isDev ? [] : ['--minify'])]);

// --- 3. 生成 manifest + 重命名 CSS 带哈希 ---
const meta = JSON.parse(fs.readFileSync(path.join(DIST, 'meta.json'), 'utf8'));
const manifest = {};

// JS outputs：从 metafile 提取（path 是绝对/相对，统一取 basename）
for (const outPath of Object.keys(meta.outputs)) {
  const base = path.basename(outPath);
  // app*.js -> app.js；chunk 在 chunks/ 下保留
  const inChunks = outPath.includes('chunks/');
  if (base.startsWith('app-') || base === 'app.js') {
    manifest['app.js'] = inChunks ? 'chunks/' + base : base;
  }
  // 其余按 basename 记录（landing/login/home/preview + chunk）
  // 不显式登记，index.html 只需引用 app.js 入口
}
fs.unlinkSync(path.join(DIST, 'meta.json'));

// CSS 重命名带哈希（用内容 hash）
const cssContent = fs.readFileSync(path.join(DIST, 'style.tmp.css'));
let cssName = 'style.css';
if (!isDev) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1').update(cssContent).digest('hex').slice(0, 8);
  cssName = `style-${h}.css`;
}
fs.writeFileSync(path.join(DIST, cssName), cssContent);
fs.unlinkSync(path.join(DIST, 'style.tmp.css'));
manifest['style.css'] = cssName;

// 找到 app 入口实际文件名（dist 根目录下 app*.js，不在 chunks/）
const appFile = fs.readdirSync(DIST).find(f => /^app(-[a-z0-9]+)?\.js$/i.test(f));
manifest['app.js'] = appFile;

fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));

// --- 4. 汇总报告 ---
const files = [];
function walk(dir, rel = '') {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    const r = rel ? rel + '/' + f : f;
    if (fs.statSync(full).isDirectory()) walk(full, r);
    else files.push({ name: r, size: fs.statSync(full).size });
  }
}
walk(DIST);
const gzip = (s) => Math.round(s / 3); // gzip 对 JS/CSS 经验压缩比 ~3x（仅粗略估计）

console.log('\n=== 构建完成：public/dist/ ===');
console.log('manifest:', JSON.stringify(manifest));
console.log('\n文件清单：');
for (const f of files.sort((a, b) => b.size - a.size)) {
  console.log(`  ${f.name.padEnd(40)} ${(f.size / 1024).toFixed(2).padStart(8)} KB  (gzip ~${(gzip(f.size) / 1024).toFixed(2)} KB)`);
}
const total = files.reduce((a, f) => a + f.size, 0);
console.log(`\n合计：${(total / 1024).toFixed(2)} KB (gzip ~${(gzip(total) / 1024).toFixed(2)} KB)`);
