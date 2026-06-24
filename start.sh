#!/usr/bin/env bash
# jpage 一键启动脚本
#
# 功能：前置检查（node_modules/.env）→ 端口占用处理 → 可选前端构建 → 启动服务。
# 支持 dev（前台 nodemon）/ 生产（后台 nohup）两种模式。
#
# 用法：
#   ./start.sh                      生产模式启动（后台，若端口占用则提示）
#   ./start.sh --dev                开发模式（前台 nodemon 热重载，不构建）
#   ./start.sh --build              启动前先构建前端到 public/dist/
#   ./start.sh --restart            先停掉同端口的旧进程再启动（生产模式）
#   ./start.sh --port 9000          指定端口（覆盖 .env 的 PORT）
#   ./start.sh --build --restart    构建后重启（部署常用组合）
#   ./start.sh --help               查看帮助
#
# 说明：
#   - 端口取值优先级：--port 参数 > .env 的 PORT > 默认 8858。
#   - 若本服务由 systemd 管理（jpage.service），建议改用 `sudo systemctl restart jpage`，
#     本脚本的 --restart 仅处理"裸进程"占用，不动 systemd 单元。

set -euo pipefail

# ---------- 颜色输出 ----------
if [ -t 1 ]; then
  C_RESET='\033[0m'; C_INFO='\033[36m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_DIM='\033[2m'
else
  C_RESET=''; C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''
fi
log()  { printf "${C_INFO}▶${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}✓${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}!${C_RESET} %s\n" "$*" >&2; }
err()  { printf "${C_ERR}✗${C_RESET} %s\n" "$*" >&2; }
dim()  { printf "${C_DIM}  %s${C_RESET}\n" "$*"; }

# ---------- 参数解析 ----------
MODE="prod"          # prod | dev
DO_BUILD=false
DO_RESTART=false
CUSTOM_PORT=""

print_help() {
  # 打印脚本顶部连续的注释行（含 #! 与空 # 行），遇到第一条非注释语句即停
  awk 'NR==1 && /^#!/ {next}       # 跳过 shebang
       /^#/ {sub(/^#[[:space:]]?/,""); print; next}
       /^$/ {next}                  # 跳过注释块内的空行
       {exit}' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dev)        MODE="dev"; shift ;;
    --build)      DO_BUILD=true; shift ;;
    --restart)    DO_RESTART=true; shift ;;
    --port)       CUSTOM_PORT="${2:-}"; [ -z "$CUSTOM_PORT" ] && { err "--port 需要参数"; exit 2; }; shift 2 ;;
    --help|-h)    print_help ;;
    *)            err "未知参数：$1"; err "运行 ./start.sh --help 查看用法"; exit 2 ;;
  esac
done

cd "$(dirname "$(readlink -f "$0")")"
PROJECT_DIR="$(pwd)"

# ---------- 1. 前置检查 ----------
log "前置检查"

# 1a. Node.js
if ! command -v node >/dev/null 2>&1; then
  err "未找到 node，请先安装 Node.js（建议 18+）"
  exit 1
fi
NODE_VER=$(node -v)
ok "Node.js：$NODE_VER"

# 1b. node_modules
if [ ! -d "node_modules" ]; then
  warn "node_modules 不存在，开始安装依赖…"
  if command -v npm >/dev/null 2>&1; then
    npm install --omit=dev >/dev/null 2>&1 || npm install >/dev/null 2>&1 || { err "依赖安装失败"; exit 1; }
    ok "依赖安装完成"
  else
    err "未找到 npm，无法自动安装依赖。请先运行 npm install"
    exit 1
  fi
else
  ok "node_modules 就绪"
fi

# 1c. .env（可选，缺失则用环境变量 / 默认值）
if [ ! -f ".env" ]; then
  warn ".env 不存在，将使用环境变量或默认值（参考 .env.example）"
else
  ok ".env 就绪"
fi

# 1d. server.js 存在
if [ ! -f "server.js" ]; then
  err "未找到 server.js，当前目录不是 jpage 项目根目录：$PROJECT_DIR"
  exit 1
fi

# ---------- 2. 端口 ----------
# 取值优先级：--port > .env 的 PORT > 默认 8858
if [ -n "$CUSTOM_PORT" ]; then
  PORT="$CUSTOM_PORT"
elif [ -f ".env" ]; then
  PORT=$(grep -E "^PORT=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]' || true)
  [ -z "$PORT" ] && PORT=8858
else
  PORT=8858
fi
ok "端口：$PORT"

# ---------- 3. 端口占用处理 ----------
# 检测占用 8858 的进程（裸进程，非 systemd）
port_pid() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | grep ":$1 " | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2
  elif command -v lsof >/dev/null 2>&1; then
    lsof -t -i :"$1" -sTCP:LISTEN 2>/dev/null | head -1
  fi
}

OLD_PID=$(port_pid "$PORT" || true)
if [ -n "$OLD_PID" ]; then
  OLD_CMD=$(ps -o comm= -p "$OLD_PID" 2>/dev/null || echo "?")
  if [ "$DO_RESTART" = true ]; then
    warn "端口 $PORT 被占用（PID $OLD_PID / $OLD_CMD），--restart 模式下停止它…"
    kill "$OLD_PID" 2>/dev/null || true
    # 等待最多 10s 优雅退出
    for i in $(seq 1 20); do
      [ -z "$(port_pid "$PORT" || true)" ] && break
      sleep 0.5
    done
    # 仍未退出则强杀
    if [ -n "$(port_pid "$PORT" || true)" ]; then
      warn "进程未响应，发送 SIGKILL…"
      kill -9 "$OLD_PID" 2>/dev/null || true
      sleep 1
    fi
    ok "旧进程已停止"
  else
    err "端口 $PORT 已被占用（PID $OLD_PID / $OLD_CMD）"
    dim "若要重启旧实例，加 --restart 参数；或用 --port 指定其他端口"
    dim "若由 systemd 管理，请改用：sudo systemctl restart jpage"
    exit 1
  fi
fi

# ---------- 4. 前端构建（可选）----------
if [ "$DO_BUILD" = true ]; then
  log "构建前端（node build.js）…"
  if [ "$MODE" = "dev" ]; then
    node build.js --dev
  else
    node build.js
  fi
  ok "前端构建完成 → public/dist/"
else
  dim "跳过构建（生产模式下服务会自动用 public/dist/；dev 模式直接用源文件）"
fi

# ---------- 5. 启动 ----------
# 加载 .env 到环境（若存在），与 systemd EnvironmentFile 行为一致。
# 关键：先记住解析出的端口，source 后强制还原——否则 .env 的 PORT= 会覆盖 --port 参数。
RESOLVED_PORT="$PORT"
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
export PORT="$RESOLVED_PORT"

if [ "$MODE" = "dev" ]; then
  # 开发模式：前台 nodemon 热重载（不后台化，Ctrl+C 退出）
  log "开发模式启动（nodemon 前台）…"
  dim "Ctrl+C 停止。修改代码自动重启。"
  if command -v npx >/dev/null 2>&1; then
    exec npx nodemon server.js
  else
    warn "未找到 npx，回退为 node 直接运行（无热重载）"
    exec node server.js
  fi
fi

# 生产模式：后台 nohup，日志写 server.log
LOG_FILE="$PROJECT_DIR/server.log"
log "生产模式启动（后台）…"
dim "日志：tail -f $LOG_FILE"

# nohup + disown，脱离当前 shell
nohup node server.js >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
disown 2>/dev/null || true

# 等待端口就绪（最多 ~15s）
READY=false
for i in $(seq 1 30); do
  if [ -n "$(port_pid "$PORT" || true)" ]; then READY=true; break; fi
  # 进程中途退出也算失败
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    err "进程已退出，检查日志：tail -50 $LOG_FILE"
    tail -20 "$LOG_FILE" 2>/dev/null || true
    exit 1
  fi
  sleep 0.5
done

if [ "$READY" = true ]; then
  # 取实际监听 PID（可能是 nohup 派生的子进程）
  LISTEN_PID=$(port_pid "$PORT" || echo "$NEW_PID")
  ok "服务已启动 🚀"
  dim "PID：$LISTEN_PID"
  dim "地址：http://localhost:$PORT"
  dim "停止：kill $LISTEN_PID"
else
  err "服务在 15s 内未监听端口 $PORT，检查日志：tail -50 $LOG_FILE"
  exit 1
fi
