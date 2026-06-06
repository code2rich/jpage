# --- builder：装编译工具链，编译 native 模块（sqlite3 等） ---
FROM node:20-alpine AS builder

WORKDIR /app

# python3/make/g++ 用于 node-gyp 本地编译；预编译二进制下载失败时也能回退成功
RUN apk add --no-cache python3 make g++

COPY package*.json ./

# 优先用 lockfile 安装；预编译下载超时则回退本地编译
RUN npm ci --omit=dev

# --- runner：纯运行环境，不带编译工具链，镜像保持小体积 ---
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN mkdir -p data/uploads

ENV NODE_ENV=production
ENV PORT=8858

EXPOSE 8858

CMD ["node", "server.js"]
