# --- builder：装编译工具链，编译 native 模块（sqlite3 等） ---
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 py3-setuptools make g++

COPY package*.json ./

RUN npm ci --omit=dev

# --- frontend builder：装 devDeps（esbuild）并打包前端到 public/dist ---
FROM node:20-alpine AS frontend

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY public ./public
COPY build.js ./
RUN npm run build

# --- runner：纯运行环境，不带编译工具链，镜像保持小体积 ---
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY . .
# 用 frontend 阶段打包好的 dist 覆盖（runner 的 COPY . . 可能带入本地 dist，这里以构建产物为准）
COPY --from=frontend /app/public/dist ./public/dist

RUN mkdir -p data/uploads

ENV NODE_ENV=production
ENV PORT=8858

EXPOSE 8858

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://localhost:8858/ || exit 1

CMD ["node", "server.js"]
