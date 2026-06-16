#!/usr/bin/env bash
# 启动一个隔离的 jpage 实例用于测试
# 用法: PORT=8891 bash test/run-server.sh &   (后台)
#       bash test/run-server.sh                (前台)
set -euo pipefail
PORT="${PORT:-8890}"
DATA_DIR="${JPAGE_DATA_DIR:-$(pwd)/data-test-$PORT}"
export PORT NODE_ENV ADMIN_USER ADMIN_PASSWORD JPAGE_DATA_DIR MCP_TOKEN
NODE_ENV="${NODE_ENV:-development}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-testpassword123}"
JPAGE_DATA_DIR="$DATA_DIR"
MCP_TOKEN="${MCP_TOKEN:-test-mcp-token-abc}"
mkdir -p "$DATA_DIR"
exec node server.js
