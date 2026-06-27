#!/usr/bin/env bash
# 即页 uTools 插件打包脚本
#
# 用法：
#   ./pack.sh            # 打包成 dist/jpage-utools-<version>.upx
#   ./pack.sh --dir      # 只输出 dist/jpage/ 目录（便于 uTools 开发者工具直接加载）
#
# 说明：uTools 插件包（.upx）本质就是 zip。uTools 开发者工具也支持
#      直接「加载未打包插件目录」做开发调试，开发期建议用 --dir。

set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(node -pe "require('./plugin.json').version")
NAME="jpage-utools"
DIST="dist"
DIR="$DIST/$NAME"

# 清理旧的
rm -rf "$DIR" "$DIR-$VERSION.upx" 2>/dev/null || true
mkdir -p "$DIR"

echo "▸ 复制插件文件…"
# 插件运行所需文件（排除 dist/、pack.sh、README 等）
for item in plugin.json preload.js logo.png index.html css js; do
  [ -e "$item" ] && cp -R "$item" "$DIR/"
done

if [ "${1:-}" = "--dir" ]; then
  echo "✓ 已输出插件目录：$(pwd)/$DIR"
  echo "  在 uTools 开发者工具中「加载未打包插件」选择该目录即可。"
  exit 0
fi

echo "▸ 打包 .upx（zip）…"
if command -v zip >/dev/null 2>&1; then
  ( cd "$DIST" && zip -rq "$NAME-$VERSION.upx" "$NAME" )
else
  # 无 zip 时用 node
  node -e '
    const JSZip = (() => { try { return require("jszip"); } catch { return null; } })();
    const fs = require("fs"), path = require("path");
    const root = process.argv[1], base = process.argv[2];
    const walk = (d, r = "") => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const abs = path.join(d, e.name), rel = r ? r + "/" + e.name : e.name;
      if (e.isDirectory()) walk(abs, rel); else zip.file(rel, fs.readFileSync(abs));
    });
    let zip;
    if (JSZip) {
      zip = new JSZip(); walk(root);
      zip.generateNodeStream().pipe(fs.createWriteStream(base)).on("finish", () => console.log("done"));
    } else {
      console.error("需要 zip 命令或 jszip 包");
      process.exit(1);
    }
  ' "$DIR" "$DIST/$NAME-$VERSION.upx"
fi

echo "✓ 打包完成：$(pwd)/$DIST/$NAME-$VERSION.upx"
echo "  双击 .upx 即可安装到 uTools；或在 uTools 开发者工具中开发调试。"
