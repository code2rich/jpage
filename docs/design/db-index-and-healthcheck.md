# 设计文档：DB 索引 + Docker HEALTHCHECK

> 对应分析报告问题 #32、#34
> 状态：待实现

---

## 一、背景

### 当前问题

**#32 SQLite 无索引**

`files` 表除主键 `id` 外没有任何索引。主要查询路径：

| 查询 | 位置 | 频率 | 当前性能 |
|---|---|---|---|
| `SELECT ... FROM files ORDER BY created_at DESC` | 列表接口 | 每次加载首页 | 全表排序 |
| `SELECT ... FROM files WHERE id = ?` | 单文件操作 | 高频 | ✅ 主键已覆盖 |
| `SELECT ... FROM users WHERE username = ?` | 登录 | 低频 | ✅ UNIQUE 约束已隐式索引 |

未来多用户（P0）上线后，还会增加 `WHERE uploaded_by = ?` 和 `WHERE is_public = 1` 的过滤查询。文件数超过几百条后，全表排序的开销会变得可感知。

**#34 Docker 无 HEALTHCHECK**

Dockerfile 没有定义 `HEALTHCHECK`，容器编排环境（Docker Compose、K8s、Swarm）无法自动判断服务是否健康。`restart: unless-stopped` 只能处理进程崩溃，无法检测「进程在但服务卡死」的情况。

---

## 二、设计方案

### 2.1 DB 索引

#### 新增索引

在 `db.serialize()` 块中，建表之后、`PRAGMA table_info` 之前，用 `CREATE INDEX IF NOT EXISTS` 添加：

```sql
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC);
```

**理由**：这是当前唯一的排序查询，也是频率最高的查询。`DESC` 声明让 SQLite 可以直接按索引顺序返回，避免 filesort。

**暂不添加的索引及原因**：

| 字段 | 是否添加 | 理由 |
|---|---|---|
| `uploaded_by` | ❌ 暂不 | 当前单用户，区分度为 0，索引无收益。多用户功能实现时再加 |
| `file_type` | ❌ 暂不 | 区分度极低（只有 html / markdown 两种），索引收益可忽略。搜索筛选功能实现时再评估 |
| `is_public` | ❌ 暂不 | 当前列表接口不过滤此字段。隐私过滤在应用层做（单条查询后判断） |
| `(is_public, uploaded_by)` | ❌ 暂不 | 预留给多用户 + 三态权限模型，当前无查询命中 |

**扩展策略**：后续功能（搜索、多用户）引入新查询模式时，在对应的 `db.serialize()` 迁移块中按需追加索引，与当前 `ALTER TABLE ADD COLUMN` 的模式一致。

#### 实现位置

`server.js` 第 90–117 行的 `db.serialize()` 块内，在两个 `CREATE TABLE` 之后、`PRAGMA table_info` 之前插入一行 `CREATE INDEX`：

```
db.serialize(() => {
  // CREATE TABLE files ...
  // CREATE TABLE users ...

  db.run('CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC)');  // ← 新增

  // PRAGMA table_info ... (已有迁移逻辑)
});
```

#### SQLite 注意事项

- `CREATE INDEX IF NOT EXISTS` 是幂等操作，重复执行不报错，不锁表（SQLite DDL 在 WAL 模式下不阻塞读）
- 数据量小时（< 1000 行）索引对写入有极微小的额外开销（每次 INSERT/UPDATE 需维护 B-tree），对读取提速也不明显。但提前加好是无成本的未来保障
- 不需要修改 WAL 模式——当前 SQLite 默认日志模式即可，高频写入场景是远期问题

---

### 2.2 Docker HEALTHCHECK

#### 方案选择

| 方案 | 优点 | 缺点 |
|---|---|---|
| `curl -f http://localhost:8858/api/auth/me` | 最标准 | alpine 无 curl，需额外安装 |
| `wget -q --spider http://localhost:8858/` | alpine 自带 wget | `--spider` 行为在 busybox wget 中不标准，可能误判 |
| `node -e "fetch('http://localhost:8858/').then(r => process.exit(r.ok?0:1))"` | 零依赖，Node 20 原生 fetch | 每次启动 Node 进程，开销稍大 |
| `wget -qO /dev/null http://localhost:8858/` | alpine 自带，可靠 | 会下载完整响应体（首页 HTML） |

**选择 `wget` 方案**：alpine 镜像自带 busybox wget，不增加镜像体积。用 `-qO /dev/null` 丢弃响应体，配合退出码判断健康状态。

#### 健康检查端点

使用 `/` （首页）而非 `/api/auth/me`：
- `/` 始终返回 200（无需鉴权）
- `/api/auth/me` 未登录返回 401，语义上是"正常响应"但会被 HEALTHCHECK 误判为不健康
- 如需更精确的检查，可后续添加 `/api/health` 专用端点，但当前无必要

#### Dockerfile 改动

在 `EXPOSE 8858` 之后、`CMD` 之前添加：

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://localhost:8858/ || exit 1
```

参数说明：

| 参数 | 值 | 说明 |
|---|---|---|
| `--interval` | 30s | 每 30 秒检查一次，平衡响应速度和资源消耗 |
| `--timeout` | 3s | 单次请求超时，超时视为不健康 |
| `--start-period` | 5s | 容器启动后 5 秒内的失败不计入重试次数，给 Node 启动留时间 |
| `--retries` | 3 | 连续 3 次失败才标记为 unhealthy，避免偶发抖动 |

#### docker-compose.yml 联动

`docker-compose.yml` 无需改动——Dockerfile 中定义的 `HEALTHCHECK` 会被 Compose 自动识别。`docker ps` 会显示健康状态，`restart: unless-stopped` 不会因 unhealthy 自动重启（这是 Docker 引擎的默认行为，需要手动配置或使用 `restart: on-failure` + `healthcheck` 回调）。

如需在服务不健康时自动重启，可在 `docker-compose.yml` 中添加：

```yaml
healthcheck:
  # 覆盖 Dockerfile 中的配置（可选，通常不需要）
  test: ["CMD", "wget", "-qO", "/dev/null", "http://localhost:8858/"]
  interval: 30s
  timeout: 3s
  retries: 3
  start_period: 5s
```

当前建议**不覆盖**，使用 Dockerfile 中的默认配置即可。

---

## 三、变更范围

| 文件 | 变更内容 |
|---|---|
| `server.js` | `db.serialize()` 块内新增一行 `CREATE INDEX` |
| `Dockerfile` | `EXPOSE` 和 `CMD` 之间新增 `HEALTHCHECK` 指令 |

两个改动完全独立，可同时实施。

---

## 四、验证方法

### 索引验证

```bash
# 启动服务后
sqlite3 data/database.sqlite ".indices files"
# 预期输出包含：idx_files_created_at

# 查看查询计划
sqlite3 data/database.sqlite "EXPLAIN QUERY PLAN SELECT * FROM files ORDER BY created_at DESC"
# 预期输出包含：USING INDEX idx_files_created_at
```

### HEALTHCHECK 验证

```bash
# 构建并启动
docker-compose up -d --build

# 查看健康状态（等待 30 秒后）
docker inspect --format='{{.State.Health.Status}}' jpage
# 预期输出：healthy

# 模拟服务异常，观察状态变化
docker exec jpage sh -c 'mv server.js server.js.bak && kill 1'
# 等待约 90 秒（3 × 30s retries）后再次查看
docker inspect --format='{{.State.Health.Status}}' jpage
# 预期输出：unhealthy
```
