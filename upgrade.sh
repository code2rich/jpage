#!/usr/bin/env bash
# jpage 一键升级脚本
#
# 功能：拉取最新代码 → 安装依赖 → 构建前端 → 重启 systemd 服务。
# 用法：
#   ./upgrade.sh              # 从 origin/main 拉取并升级
#   ./upgrade.sh --branch x   # 切换到指定分支并升级
#   ./upgrade.sh --no-pull    # 不拉代码，只构建并重启
#   ./upgrade.sh --help       # 查看帮助

set -euo pipefail

PROJECT_DIR="/home/jpage/jpage"
SERVICE="jpage"
USER="jpage"
BRANCH=""
DO_PULL=true

print_help() {
  sed -n '/^# jpage 一键升级脚本/,/^$/p' "$0" | sed 's/^# //'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --branch)    BRANCH="${2:-}"; [ -z "$BRANCH" ] && { echo "--branch 需要参数"; exit 2; }; shift 2 ;;
    --no-pull)   DO_PULL=false; shift ;;
    --help|-h)   print_help ;;
    *)           echo "未知参数：$1"; echo "运行 ./upgrade.sh --help 查看用法"; exit 2 ;;
  esac
done

# 需要 root 权限重启服务
if [ "$(id -u)" -ne 0 ]; then
  echo "本脚本需要 root 权限来重启 systemd 服务，请用 sudo 运行。"
  exit 1
fi

cd "$PROJECT_DIR"

run_as_user() {
  sudo -u "$USER" -H "$@"
}

if [ "$DO_PULL" = true ]; then
  echo "==> 拉取最新代码..."
  if [ -n "$BRANCH" ]; then
    run_as_user git fetch origin
    run_as_user git checkout "$BRANCH"
    run_as_user git pull origin "$BRANCH"
  else
    run_as_user git pull origin main
  fi
fi

echo "==> 安装依赖..."
run_as_user npm install

echo "==> 构建前端..."
run_as_user npm run build

echo "==> 重启 ${SERVICE} 服务..."
systemctl restart "$SERVICE"

echo "==> 等待服务就绪..."
for i in $(seq 1 30); do
  if ss -tln 2>/dev/null | grep -q ":8858 "; then
    break
  fi
  sleep 0.5
done

echo "==> 服务状态："
systemctl status "$SERVICE" --no-pager

echo ""
echo "==> 首页测试："
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8858/

echo ""
echo "✓ 升级完成"
