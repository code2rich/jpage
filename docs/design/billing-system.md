# 即页计费体系设计文档

> 版本：v2.0 | 日期：2026-06-10 | 状态：设计中
>
> v2.0 变更：移除在线支付集成，改为激活码（赞助解锁）模式。零资质门槛，验证付费需求后再接入正式支付。

## 1. 概述

为即页引入多层级套餐体系，通过 **存储容量、文件数量、API 调用量、功能权限** 等维度区分 Free / Pro / Max 三个套餐。当前采用 **激活码** 模式——管理员生成激活码，用户输入后解锁对应套餐，以此验证付费需求，后续再接入在线支付。

### 1.1 设计目标

- **零资质门槛**：激活码模式无需商户资质，立刻可用
- **验证需求**：通过激活码分发数量观察真实付费意愿
- **低门槛体验**：Free 版足够个人体验，降低获客成本
- **渐进演进**：激活码模式的数据结构和配额检查机制可无缝迁移到在线支付

### 1.2 名词定义

| 术语 | 含义 |
|------|------|
| Plan（套餐） | Free / Pro / Max 三档，定义各类配额上限 |
| Activation Code（激活码） | 管理员生成的一次性兑换码，用户输入后升级套餐 |
| Quota（配额） | 某维度的使用量上限（如存储 50MB） |
| Usage（用量） | 用户在某周期内的实际消耗量 |

---

## 2. 套餐定义

### 2.1 价格（参考价，激活码模式不实际收费）

| 套餐 | 参考月价 | 参考年价（约 8 折） | 说明 |
|------|---------|-------------------|------|
| **Free** | 免费 | 免费 | 注册即得 |
| **Pro** | ¥9/月 | ¥86/年 | 激活码兑换，有效期按码设定 |
| **Max** | ¥29/月 | ¥278/年 | 激活码兑换，有效期按码设定 |

### 2.2 配额对比

| 维度 | Free | Pro | Max |
|------|------|-----|-----|
| 存储容量 | 50 MB | 500 MB | 10 GB |
| 文件个数 | 20 | 500 | 不限 |
| 单文件大小 | 2 MB | 10 MB | 50 MB |
| 版本历史（每文件） | 2 个 | 10 个 | 30 个 |
| MCP/API 日调用量 | 100 次 | 1,000 次 | 10,000 次 |
| 上传频率（15 min 窗口） | 10 次 | 30 次 | 100 次 |
| API Token 数 | 1 | 5 | 20 |
| 批量操作（单次上限） | 不支持 | 20 个 | 100 个 |
| ZIP 上传 | 不支持 | 支持 | 支持 |
| 全文搜索 | 不支持 | 支持 | 支持 |

### 2.3 功能对比

| 功能 | Free | Pro | Max |
|------|------|-----|-----|
| HTML / Markdown 预览 | ✓ | ✓ | ✓ |
| 短链接分享 | ✓（随机 8 位） | ✓（可自定义别名） | ✓（可自定义别名） |
| 公开 / 私有控制 | ✓ | ✓ | ✓ |
| 标签 / 分类 / 收藏 | ✓ | ✓ | ✓ |
| 在线编辑 + 实时预览 | ✓ | ✓ | ✓ |
| Markdown 渲染增强（代码高亮 / KaTeX / Mermaid） | ✓ | ✓ | ✓ |
| 渲染模板 | 仅 default | 4 种内置模板 | 内置 + 自定义上传模板 |
| 内容模板市场 | 只读使用 | 可上传私有模板 | 可上传 + 市场管理 |
| 分享链接有效期 | 永久 | 可设过期时间 | 可设过期时间 + 密码保护 |
| 自定义域名 | ✗ | ✗ | ✓ |
| 数据备份 / 恢复 | ✗ | 导出自己的文件 | 全量备份 / 恢复 |
| 访问统计 | 近 7 天概览 | 近 30 天详情 | 近 90 天详情 + CSV 导出 |
| 子账号 | ✗ | ✗ | 最多 5 人 |
| 优先支持 | ✗ | ✗ | 优先工单 |

---

## 3. 数据库设计

### 3.1 新增表

#### `plans` — 套餐定义表

```sql
CREATE TABLE IF NOT EXISTS plans (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT UNIQUE NOT NULL,           -- 'free', 'pro', 'max'
  display_name          TEXT NOT NULL,                   -- '免费版', 'Pro', 'Max'
  price_monthly         INTEGER NOT NULL DEFAULT 0,     -- 参考月价（单位：分）
  price_yearly          INTEGER NOT NULL DEFAULT 0,     -- 参考年价（单位：分）
  storage_mb            INTEGER NOT NULL,               -- 存储上限 MB
  max_files             INTEGER,                        -- 文件数上限（NULL = 不限）
  max_file_size_mb      INTEGER NOT NULL,               -- 单文件上限 MB
  max_versions          INTEGER,                        -- 版本数上限（NULL = 不限）
  max_api_calls_daily   INTEGER NOT NULL,               -- API 日调用量上限
  max_upload_rate       INTEGER NOT NULL,               -- 15 min 上传次数上限
  max_tokens            INTEGER NOT NULL,               -- API Token 数上限
  max_batch_ops         INTEGER NOT NULL DEFAULT 0,     -- 批量操作上限（0 = 不支持）
  allow_zip             INTEGER NOT NULL DEFAULT 0,     -- ZIP 上传
  allow_search          INTEGER NOT NULL DEFAULT 0,     -- 全文搜索
  allow_custom_template INTEGER NOT NULL DEFAULT 0,     -- 自定义渲染模板
  allow_custom_domain   INTEGER NOT NULL DEFAULT 0,     -- 自定义域名
  allow_share_expiry    INTEGER NOT NULL DEFAULT 0,     -- 分享链接有效期
  allow_share_password  INTEGER NOT NULL DEFAULT 0,     -- 分享链接密码
  allow_template_upload INTEGER NOT NULL DEFAULT 0,     -- 上传内容模板
  allow_template_manage INTEGER NOT NULL DEFAULT 0,     -- 管理内容模板市场
  allow_backup          INTEGER NOT NULL DEFAULT 0,     -- 数据备份
  stats_days            INTEGER NOT NULL DEFAULT 7,     -- 统计天数
  max_sub_accounts      INTEGER NOT NULL DEFAULT 0,     -- 子账号数上限
  created_at            TEXT DEFAULT (datetime('now'))
);
```

**初始数据**：

```sql
INSERT INTO plans (name, display_name, price_monthly, price_yearly,
  storage_mb, max_files, max_file_size_mb, max_versions,
  max_api_calls_daily, max_upload_rate, max_tokens, max_batch_ops,
  allow_zip, allow_search, allow_custom_template, allow_custom_domain,
  allow_share_expiry, allow_share_password, allow_template_upload,
  allow_template_manage, allow_backup, stats_days, max_sub_accounts)
VALUES
  ('free', '免费版', 0, 0,
    50, 20, 2, 2,
    100, 10, 1, 0,
    0, 0, 0, 0,
    0, 0, 0,
    0, 0, 7, 0),
  ('pro', 'Pro', 900, 8600,
    500, 500, 10, 10,
    1000, 30, 5, 20,
    1, 1, 0, 0,
    1, 0, 1,
    0, 1, 30, 0),
  ('max', 'Max', 2900, 27800,
    10240, NULL, 50, 30,
    10000, 100, 20, 100,
    1, 1, 1, 1,
    1, 1, 1,
    1, 1, 90, 5);
```

#### `activation_codes` — 激活码表

```sql
CREATE TABLE IF NOT EXISTS activation_codes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT UNIQUE NOT NULL,               -- 激活码（如 'JP-A1B2C3D4E5'）
  plan_id         INTEGER NOT NULL REFERENCES plans(id),
  duration_days   INTEGER NOT NULL,                   -- 有效天数（30=月, 365=年）
  status          TEXT NOT NULL DEFAULT 'active',     -- active / used / expired / revoked
  created_by      INTEGER REFERENCES users(id),       -- 创建者（admin）
  used_by         INTEGER REFERENCES users(id),       -- 使用者
  used_at         TEXT,                                -- 使用时间
  expires_at      TEXT,                                -- 激活码本身过期时间（未使用则作废）
  note            TEXT,                                -- 备注（如「张三 赞助 Pro 年付」）
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_activation_codes_code ON activation_codes(code);
CREATE INDEX idx_activation_codes_status ON activation_codes(status);
```

#### `user_plans` — 用户套餐记录表

```sql
CREATE TABLE IF NOT EXISTS user_plans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  plan_id         INTEGER NOT NULL REFERENCES plans(id),
  source          TEXT NOT NULL,                       -- 'activation_code' / 'admin_grant' / 'payment'
  source_id       INTEGER,                             -- activation_codes.id 或 payments.id
  status          TEXT NOT NULL DEFAULT 'active',      -- active / expired
  activated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,                       -- 套餐到期时间
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_user_plans_user ON user_plans(user_id, status);
```

#### `usage_daily` — 日用量追踪表

```sql
CREATE TABLE IF NOT EXISTS usage_daily (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  date         TEXT NOT NULL,                -- '2026-06-10'
  api_calls    INTEGER NOT NULL DEFAULT 0,   -- 当日 API 调用次数
  upload_count INTEGER NOT NULL DEFAULT 0,   -- 当日上传次数
  UNIQUE(user_id, date)
);

CREATE INDEX idx_usage_daily_user_date ON usage_daily(user_id, date);
```

#### `usage_storage` — 存储用量快照

```sql
CREATE TABLE IF NOT EXISTS usage_storage (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER UNIQUE NOT NULL REFERENCES users(id),
  total_bytes  INTEGER NOT NULL DEFAULT 0,   -- 当前已用存储字节数
  file_count   INTEGER NOT NULL DEFAULT 0,   -- 当前文件数
  updated_at   TEXT DEFAULT (datetime('now'))
);
```

### 3.2 修改现有表

#### `users` 表新增字段

```sql
ALTER TABLE users ADD COLUMN plan_id INTEGER NOT NULL DEFAULT 1 REFERENCES plans(id);
ALTER TABLE users ADD COLUMN plan_expires_at TEXT;             -- 套餐到期时间（NULL=永不过期，free 用户为 NULL）
ALTER TABLE users ADD COLUMN storage_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN file_count INTEGER NOT NULL DEFAULT 0;
```

> `plan_id` 和 `plan_expires_at` 冗余到 users 表，方便快速判断当前套餐，无需每次 JOIN。注册时默认 `plan_id = 1`（free）、`plan_expires_at = NULL`。

---

## 4. 激活码机制

### 4.1 整体流程

```
用户看到定价页 → 点击「赞助解锁」→ 引导联系管理员（显示联系方式/二维码）
       ↓
用户完成赞助 → 管理员在后台生成激活码（指定套餐 + 有效期）
       ↓
管理员将激活码发送给用户
       ↓
用户在「兑换激活码」页面输入 → 验证 → 升级套餐
```

### 4.2 激活码格式

```
JP-{10位大写字母数字}
```

示例：`JP-A1B2C3D4E5`

生成规则：`'JP-' + crypto.randomBytes(6).toString('hex').toUpperCase()`

### 4.3 兑换逻辑

```
POST /api/activation/redeem   { code: 'JP-A1B2C3D4E5' }
  1. 查找激活码（status=active）
  2. 检查激活码是否过期（expires_at）
  3. 检查用户当前套餐是否低于目标套餐（不允许降级兑换）
  4. 更新 activation_codes: status=used, used_by=userId, used_at=now
  5. 创建 user_plans 记录
  6. 更新 users: plan_id, plan_expires_at
  7. 返回套餐信息
```

### 4.4 套餐到期与续期

| 场景 | 处理 |
|------|------|
| 激活码到期 | 定时任务检测 `plan_expires_at < now()`，降级为 free |
| 激活码叠加（已有 Pro，再兑 Pro） | 新到期时间 = max(当前到期时间, now) + duration_days |
| 升级兑换（已有 Pro，兑 Max） | 立即升级，新到期时间 = now + duration_days（Pro 剩余时间不折算） |
| 降级兑换（已有 Max，兑 Pro） | 拒绝，提示「当前套餐已高于目标套餐」 |

### 4.5 降级处理

降级为 free 时：
- **不删除文件**，超限文件标记为 `read_only`（可下载，不可编辑/覆盖）
- **API Token 保留前 1 个**，多余的禁用（不删除）
- **版本历史保留前 2 个**，多余的标记归档
- 用户可随时兑换新激活码恢复

---

## 5. 配额检查机制

### 5.1 检查流程

```
用户发起操作（上传 / API 调用 / Token 创建 …）
       ↓
  quota.check(userId, dimension)
       ↓
  ┌─ 读取 users.plan_id → JOIN plans 获取配额上限
  │  （套餐信息缓存在内存，plan_id 变更时刷新）
  │
  ├─ 检查 users.plan_expires_at（过期则先降级）
  │
  ├─ 读取当前用量（usage_daily / usage_storage）
  │
  └─ 比较：用量 < 配额？
       ↓
  是 → 放行，用量 +1
  否 → 返回 403 QuotaExceeded + 提示升级
```

### 5.2 检查维度与时机

| 维度 | 检查时机 | 数据来源 |
|------|---------|---------|
| 存储容量 | 文件上传前 | `usage_storage.total_bytes` + 新文件 size |
| 文件个数 | 文件上传前 | `usage_storage.file_count` |
| 单文件大小 | 文件上传前 | `request.file.size` vs `plans.max_file_size_mb` |
| API 日调用 | 每次 MCP/API 调用 | `usage_daily.api_calls` WHERE date=today |
| 上传频率 | 上传请求时 | `usage_daily.upload_count` WHERE date=today |
| 版本数 | 覆盖上传前 | `SELECT COUNT(*) FROM file_versions` |
| Token 数 | 创建 Token 前 | `SELECT COUNT(*) FROM tokens WHERE user_id=?` |
| 功能权限 | 功能入口 | `plans.allow_*` 字段直接判断 |

### 5.3 用量更新策略

| 指标 | 更新方式 |
|------|---------|
| API 调用计数 | 内存缓冲 + 每 60 秒批量 flush 到 `usage_daily` |
| 上传计数 | 上传成功后 `usage_daily.upload_count + 1` |
| 存储用量 | 增量更新：上传成功 `+size`，删除文件 `-size` |
| 文件计数 | 增量更新：上传成功 +1，删除文件 -1 |
| 日用量清理 | 保留 90 天，超期记录定时删除 |

> API 调用计数使用内存缓冲，避免每次请求都写 SQLite。Node 进程重启时会丢失当批未 flush 的计数（可接受，最多少算 60 秒的调用量）。

### 5.4 quota 模块 API 设计

```js
// quota.js
module.exports = {
  async check(userId, dimension, extra = {}),
  async increment(userId, dimension, value = 1),
  async getUsageOverview(userId),
};
```

支持的 `dimension` 值：

| dimension | 说明 |
|-----------|------|
| `storage` | 存储容量（extra: { bytesToAdd }） |
| `files` | 文件个数 |
| `file_size` | 单文件大小（extra: { fileSize }) |
| `api_calls` | API 日调用 |
| `upload_rate` | 上传频率 |
| `versions` | 版本数（extra: { fileId }) |
| `tokens` | Token 数 |
| `feature:zip` | ZIP 上传权限 |
| `feature:search` | 全文搜索权限 |
| `feature:custom_domain` | 自定义域名权限 |

---

## 6. REST API 新增

### 6.1 套餐与用量

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/plans` | 列出所有套餐及参考价 | 无 |
| GET | `/api/plans/current` | 当前用户的套餐 + 各维度用量 | 登录 |

**`GET /api/plans/current` 响应示例**：

```json
{
  "plan": {
    "name": "pro",
    "displayName": "Pro",
    "storageMb": 500,
    "maxFiles": 500
  },
  "usage": {
    "storageMb": 120.5,
    "fileCount": 87,
    "apiCallsToday": 156,
    "tokens": 3
  },
  "expiresAt": "2026-07-10T00:00:00.000Z"
}
```

### 6.2 激活码（用户端）

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/activation/redeem` | 兑换激活码 | 登录 |

**请求体**：`{ "code": "JP-A1B2C3D4E5" }`

**响应**：

```json
{
  "success": true,
  "plan": { "name": "pro", "displayName": "Pro" },
  "expiresAt": "2026-07-10T00:00:00.000Z"
}
```

### 6.3 激活码管理（管理员）

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/admin/codes` | 列出所有激活码（分页、筛选状态） | admin |
| POST | `/api/admin/codes` | 批量生成激活码 | admin |
| POST | `/api/admin/codes/revoke/:id` | 撤销激活码（未使用的） | admin |
| GET | `/api/admin/codes/stats` | 激活码统计（已用/未用/过期数） | admin |

**`POST /api/admin/codes` 请求体**：

```json
{
  "planId": 2,
  "durationDays": 30,
  "count": 5,
  "expiresInDays": 90,
  "note": "张三 赞助 Pro 月付"
}
```

> `count` 批量生成数量（1-50）；`expiresInDays` 激活码本身的有效期（未使用则作废）。

**响应**：

```json
{
  "codes": [
    { "code": "JP-A1B2C3D4E5", "planId": 2, "durationDays": 30 },
    { "code": "JP-F6G7H8I9J0", "planId": 2, "durationDays": 30 }
  ]
}
```

### 6.4 管理员直接授权

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/admin/grant` | 直接给用户授权套餐 | admin |

**请求体**：

```json
{
  "userId": 5,
  "planId": 2,
  "durationDays": 365,
  "note": "内测用户赠送"
}
```

> 用于内测用户、合作伙伴赠送等场景，不经过激活码。

---

## 7. 前端改动

### 7.1 新增页面

#### 定价页（`#/pricing`）

- 三栏对比表格（Free / Pro / Max）
- Pro/Max 的操作按钮为「赞助解锁」，点击弹出联系方式（微信二维码 / 邮箱）
- 底部「已有激活码？点此兑换」链接

#### 兑换激活码弹窗

- 输入框 + 兑换按钮
- 成功/失败提示
- 显示新的套餐信息和到期时间

#### 订阅管理（用户设置内）

- 当前套餐显示 + 各维度用量进度条
- 到期时间倒计时
- 「兑换激活码」按钮
- 套餐历史记录列表

### 7.2 管理员新增

#### 激活码管理（Settings 内）

- 生成激活码表单（选套餐、选时长、数量、备注）
- 激活码列表（状态筛选：未用/已用/过期/已撤销）
- 撤销操作
- 统计概览

### 7.3 修改页面

| 页面 | 改动 |
|------|------|
| **主页** | 超限时上传按钮灰化 + tooltip 提示升级；右上角显示当前套餐 badge |
| **上传** | 超限文件上传返回 403 时弹出升级引导 |
| **预览页** | 版本历史超出配额时提示；统计图表按套餐显示天数 |
| **设置** | Token 创建超限时提示；新增「套餐管理」入口 |
| **落地页** | Header 新增「定价」链接；CTA 按钮引导注册 |

---

## 8. 定时任务

| 任务 | 频率 | 说明 |
|------|------|------|
| 套餐过期检查 | 每小时 | `users.plan_expires_at < now() AND plan_id > 1` → 降级为 free |
| 激活码过期 | 每小时 | `activation_codes.status=active AND expires_at < now()` → 标记 expired |
| API 用量 flush | 每 60 秒 | 内存缓冲的 API 调用计数写入 `usage_daily` |
| 日用量清理 | 每天 1 次 | 删除 90 天前的 `usage_daily` 记录 |
| 存储用量校准 | 每天 1 次 | 重新计算 `usage_storage`（防止增量误差累积） |

---

## 9. 配额超限响应格式

所有配额超限返回统一格式：

```json
{
  "error": "QuotaExceeded",
  "message": "存储空间不足",
  "dimension": "storage",
  "current": {
    "usedMb": 50.2,
    "limitMb": 50
  },
  "upgradeHint": {
    "plan": "pro",
    "displayName": "Pro",
    "priceMonthly": "¥9"
  }
}
```

HTTP 状态码统一使用 **403 Forbidden**（非 429，429 用于速率限制）。

---

## 10. 安全考虑

| 风险 | 措施 |
|------|------|
| 激活码暴力枚举 | 格式 `JP-` + 10 位（36^10 = 3.6 万亿种），接口限流 5 次/分钟 |
| 激活码重复使用 | `status=used` 后不可再用，数据库 UNIQUE 约束 |
| 配额绕过 | 所有文件操作入口（REST API + MCP tool）统一经过 `quota.check()` |
| 并发超额 | 存储用量使用 SQLite 事务保证原子性 |
| Token 滥用 | MCP tool 调用同样计入 API 调用配额 |
| 管理员接口泄露 | 激活码管理 API 强制 `requireAdmin` |

---

## 11. 向在线支付迁移

当激活码模式验证了付费需求后，迁移到在线支付只需：

1. **新增 `payments` 表**（订单号、金额、支付方式、状态）
2. **`user_plans.source` 新增 `'payment'`** 值，`source_id` 指向 payments 记录
3. **新增支付相关 API**（创建订单、回调通知）
4. **激活码机制保留**，作为促销/赠品渠道

现有表结构（plans / user_plans / usage_daily / usage_storage）和 quota 模块无需改动。

---

## 12. 分期实施计划

### Phase 1：配额体系（约 2-3 天）

1. 创建 migration：plans / activation_codes / user_plans / usage_daily / usage_storage 表 + users 新字段
2. 实现 `quota.js` 模块（含内存缓冲的 API 调用计数）
3. 在现有 API 入口插入配额检查（上传、Token 创建、MCP tool）
4. 前端配额超限提示（通用 toast）

### Phase 2：激活码（约 2-3 天）

1. 管理员激活码生成/管理 API
2. 用户兑换激活码 API + 到期降级定时任务
3. 前端定价页 + 兑换弹窗 + 管理员后台
4. 用量可视化（进度条）

### Phase 3：完善体验（约 2 天）

1. 降级处理（超限文件只读）
2. 激活码叠加/升级逻辑
3. 管理员直接授权
4. 前端套餐管理页

---

## 13. 文件结构（新增/修改）

```
quota.js                        # 配额检查模块
migrations/
  007_plans_and_billing.js      # 套餐/激活码/用量表
public/
  js/pages/pricing.js           # 定价页
public/js/app.js                # 新增路由 + 配额提示
public/index.html               # 新增 template（定价页）
public/css/style.css            # 定价页样式
```

> 现有文件改动：`server.js`（新增路由 + 配额中间件）、`mcp-server.js`（MCP tool 配额检查）。
