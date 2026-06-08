# --- builder：装编译工具链，编译 native 模块（sqlite3 等） ---
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 py3-setuptools make g++

COPY package*.json ./

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

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://localhost:8858/ || exit 1

CMD ["node", "server.js"]
