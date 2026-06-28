# 内容市场「使用模板」与系统 Token 绑定设计方案

## 背景

当前内容模板市场（`/market`）的「使用此模板」按钮直接走浏览器 Session Cookie 鉴权，仅做两件事：

1. 调用 `POST /api/content-templates/:id/use` 给 `use_count` +1。
2. 调用 `POST /api/content-templates/:id/share` 生成 `/t/:key` 公开短链，弹出提示词让用户复制给 AI。

这个流程存在三个问题：

- **没有真正使用**：没有生成用户可编辑的文件，只是复制了一段提示词。
- **没有 Token 绑定**：Session Cookie 不是系统级 Token（`jp_...` / `MCP_TOKEN`），无法与 MCP、CLI 的调用链关联。
- **MCP/CLI 不对称**：MCP 只能查看模板，CLI 完全没有内容模板命令，两者都无法把模板落地成用户文件。

本方案把「使用模板」重新定义为：**通过已认证的 API Token 或 MCP_TOKEN，在调用者账户下实例化出一个可编辑文件**。Web UI 不再直接实例化，而是引导用户通过 MCP 或 CLI 完成绑定后的使用。

---

## 设计目标

1. **无 Token 不可用**：未携带有效 Bearer token 时，不能将模板实例化为文件。
2. **与现有 Token 体系绑定**：复用 `jp_...` 用户 API Token 与全局 `MCP_TOKEN`，不引入新 Token 类型。
3. **MCP / CLI 对称**：两端都支持「列出模板、查看模板、使用模板（实例化）」。
4. **Web UI 转为引导入口**：市场页面仍允许匿名浏览/预览，但「使用」按钮改为复制 CLI/MCP 命令，不再直接创建文件。
5. **可追溯**：记录每次实例化使用的 Token 前缀、来源（mcp/cli/web）、产生的文件 ID，便于审计与热度统计。

---

## 核心语义变更

| 概念 | 旧语义 | 新语义 |
|------|--------|--------|
| 「使用模板」 | 给 `use_count` +1，复制提示词 | 通过 Token 鉴权，实例化出用户文件 |
| `/use` 端点 | 计数器 | **废弃**，由 `/instantiate` 统一承接（热度 +1 作为副作用） |
| 热度指标 | `use_count` | `instantiation_count` 为主，`use_count` 保留为「被查看/引用」次数字段 |
| 实例化入口 | Web UI 弹窗 | MCP tool / CLI 子命令 / Web UI 仅复制命令 |

---

## 数据模型变更

### 1. `content_template_installs` 增加 Token 绑定字段

新增迁移 `migrations/022_template_token_binding.js`：

```js
const cols = await dbAll(db, 'PRAGMA table_info(content_template_installs)');
const colNames = new Set(cols.map(c => c.name));

if (!colNames.has('source')) {
  await dbRun(db, "ALTER TABLE content_template_installs ADD COLUMN source TEXT");
}
if (!colNames.has('token_prefix')) {
  await dbRun(db, "ALTER TABLE content_template_installs ADD COLUMN token_prefix TEXT");
}
if (!colNames.has('token_hash_prefix')) {
  await dbRun(db, "ALTER TABLE content_template_installs ADD COLUMN token_hash_prefix TEXT");
}
```

字段含义：

- `source`：实例化来源，`'mcp'` / `'cli'` / `'web'`（预留）。
- `token_prefix`：用户级 API Token 的明文前缀（如 `jp_a3f9...` 前 8 位）；`MCP_TOKEN` 时记 `'mcp'`。
- `token_hash_prefix`：用于匿名化审计，取 SHA-256(tokenValue) 前 16 位，既能追溯又避免暴露完整 token。

> 原 `UNIQUE(template_id, user_id)` 保留，表示「同用户对同模板只保留最近一次实例化记录」。如果业务上需要保留历史多次实例化，应去掉该唯一约束；本方案按现有语义保留。

### 2. `content_template_events` 保留事件流

`019_market_instantiation.js` 已创建 `content_template_events`，新增事件类型：

- `instantiate`：实例化成功。
- `instantiate_fail`：实例化失败（可选）。

该表用于审计与明细统计，与 `content_template_installs` 的「最新状态」互补。

### 3. `files` 来源标记细化

`files.upload_source` 在实例化时写为：

- `'market-mcp'`：通过 MCP 实例化。
- `'market-cli'`：通过 CLI 实例化。
- 保留 `'market'`：预留 Web 直接实例化（本方案默认不使用）。

`files.created_from` 仍记 `'market'`，`files.source_asset_id` 记模板 ID，`files.source_asset_version` 记模板版本。

---

## 后端 API 变更

### 1. 废弃 `POST /api/content-templates/:id/use`

- 移除该路由或返回 `410 Gone`，提示客户端改用 `/instantiate`。
- MCP `get_content_template` 中移除自动调用 `/use` 的逻辑（查看 ≠ 使用）。

### 2. 强化 `POST /api/content-templates/:id/instantiate`

该端点已存在，改造点：

1. **Token 来源识别**：
   - 若认证走的是 `MCP_TOKEN`，`req.tokenSource = 'mcp'`。
   - 若认证走的是用户级 `jp_...`，`req.tokenSource = 'cli'`（HTTP 调用时也按此标记，但 CLI 会显式带 `X-Upload-Source: cli`）。
   - 可通过新增中间件或直接在 `requireAuth` 中设置 `req.tokenPrefix` / `req.tokenHashPrefix`。

2. **接收可选请求体**：
   ```json
   {
     "originalName": "自定义文件名.html",
     "isPublic": false
   }
   ```
   不传时默认用模板标题 + 扩展名，私有文件。

3. **记录绑定信息**：
   ```js
   await dbRun(
     `INSERT INTO content_template_installs
      (template_id, user_id, file_id, source_version, source, token_prefix, token_hash_prefix)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(template_id, user_id) DO UPDATE SET
        file_id = excluded.file_id,
        source_version = excluded.source_version,
        source = excluded.source,
        token_prefix = excluded.token_prefix,
        token_hash_prefix = excluded.token_hash_prefix,
        created_at = datetime('now')`,
     [req.params.id, req.userId, fileId, t.version, req.tokenSource,
      req.tokenPrefix, req.tokenHashPrefix]
   );
   ```

4. **热度统计**：`instantiation_count + 1`，`use_count + 1` 作为兼容字段同步 +1。

5. **审计日志**：
   ```js
   logger.audit('content_template.instantiate', {
     templateId: parseInt(req.params.id),
     fileId,
     userId: req.userId,
     source: req.tokenSource,
     tokenHashPrefix: req.tokenHashPrefix,
     ip: clientIp(req)
   });
   ```

6. **限流**：实例化端点挂载上传/覆盖同级别的限流器（50 req / 15 min / IP），防止刷热度。

### 3. 新增 `GET /api/content-templates/:id/use-guide`

**公开端点**，无需登录。返回该模板对应的 CLI/MCP 使用命令，供 Web UI「使用此模板」按钮展示。

响应示例：

```json
{
  "templateId": 12,
  "title": "季度汇报 HTML-PPT",
  "fileType": "html",
  "cli": "jpage template use 12",
  "cliWithName": "jpage template use 12 --name 季度汇报.html --public",
  "mcp": {
    "tool": "instantiate_content_template",
    "args": { "id": 12 }
  }
}
```

这样 Web UI 不再直接调用创建接口，而是让用户复制命令到自己熟悉的 Token 客户端执行。

---

## MCP 变更（`mcp/tools-content-templates.js`）

### 现有工具调整

- `list_content_templates`：保持不变，继续调用公开市场端点。
- `get_content_template`：移除 `await api.post(.../use).catch(...)`；仅返回模板内容作为风格参考。

### 新增工具：`instantiate_content_template`

```js
server.registerTool(
  'instantiate_content_template',
  {
    title: 'Instantiate Content Template',
    description: '使用指定内容模板在当前 Token 所属用户下创建一个新文件。调用会消耗用户存储空间。',
    inputSchema: {
      id: z.number().int().positive().describe('模板 ID'),
      originalName: z.string().optional().describe('实例化后的文件名，默认使用模板标题'),
      isPublic: z.boolean().optional().describe('是否设为公开文件，默认 false'),
    },
  },
  async ({ id, originalName, isPublic }) => {
    const data = await api.post(`/api/content-templates/${id}/instantiate`, {
      originalName,
      isPublic,
    });
    return textResult({
      success: true,
      fileId: data.fileId,
      templateId: data.templateId,
      url: `${protocol}://${mcpIp}:${port}/s/${data.shareKey || data.fileId}`,
      hint: '文件已创建到您的文件列表，可直接编辑或分享。',
    });
  }
);
```

> `api` 是进程内 dispatcher，会自动带上 MCP 连接建立时的 Bearer token，因此 `/instantiate` 的 `requireAuth` 与 Token 绑定自然生效。

MCP server 注册工具数从 17 变为 18，需同步更新 `mcp/server.js` 注释与任何文档中的数字。

---

## CLI 变更（`bin/commands/`）

新增 `bin/commands/template.js`，并在 `bin/jpage.js` 的 `COMMANDS` 中注册 `template`。

### 命令设计

```text
jpage template ls [--category <slug>] [--file-type html|markdown] [--kw <词>] [--limit N]
  列出市场模板（公开端点，不需要 token）。

jpage template get <id>
  查看模板完整内容（公开端点）。

jpage template use <id> [--name <文件名>] [--public]
  使用模板创建文件（需要 token）。
```

### `jpage template use` 实现要点

```js
async function run(client, parsed) {
  const id = parsed.positional[1];
  if (!id) throw new UsageError('用法：jpage template use <id> [--name <文件名>] [--public]');

  const body = {};
  if (parsed.opts.name) body.originalName = parsed.opts.name;
  if (parsed.opts.public) body.isPublic = true;

  const data = await client.post(`/api/content-templates/${id}/instantiate`, body);
  out(`✓ 已使用模板 #${data.templateId} 创建文件 #${data.fileId}`);
  out(`  ${client.base}/s/${data.shareKey || data.fileId}`);
}
```

CLI 客户端 `createClient` 的 `source` 默认为 `'cli'`，因此 `files.upload_source` 会记录为 `'market-cli'`（后端 `/instantiate` 读取 `X-Upload-Source` 头）。

---

## 前端变更（`public/js/pages/market.js`）

### 首页卡片与详情页按钮

将「使用此模板」按钮行为改为：

1. **未登录用户**：点击后弹窗提示「请通过 CLI 或 MCP 使用模板」，展示命令，不调用任何创建接口。
2. **已登录用户**：同样弹窗展示 CLI/MCP 命令，可一键复制；不再直接 `POST /instantiate`。

原因：如果 Web UI 仍用 Session Cookie 直接实例化，就绕过了「必须与 Token 绑定」的要求。Web 端只能作为发现与引导入口。

### 新增弹窗 `showTemplateUseGuide({ templateId, title, fileType })`

调用 `GET /api/content-templates/:id/use-guide` 获取命令文本，渲染：

```text
使用此模板（将在您的账户下创建文件）

CLI:
  jpage template use 12 --name 季度汇报.html

MCP:
  调用工具 instantiate_content_template，参数 { "id": 12 }

[复制 CLI 命令]  [复制 MCP 参数]  [关闭]
```

原有「复制公开链接」「收藏」「下载」按钮保留，因为它们不涉及实例化。

---

## 认证与 Token 绑定细节

### 1. `requireAuth` 扩展

在 `lib/middleware/auth.js` 中，认证成功后补充以下字段：

```js
// Session Cookie
if (req.session && req.session.userId) {
  req.tokenSource = 'web';
  req.tokenPrefix = 'session';
  req.tokenHashPrefix = 'session';
}

// MCP_TOKEN
if (process.env.MCP_TOKEN && tokenValue === process.env.MCP_TOKEN) {
  req.tokenSource = 'mcp';
  req.tokenPrefix = 'mcp';
  req.tokenHashPrefix = hashPrefix(tokenValue);
}

// 用户级 API Token
if (tokenRow) {
  req.tokenSource = req.get('x-upload-source') === 'cli' ? 'cli' : 'api';
  req.tokenPrefix = tokenRow.token_prefix;      // 来自 tokens 表
  req.tokenHashPrefix = hashPrefix(tokenValue);
}
```

> `/instantiate` 应要求 `req.tokenSource !== 'web'`，即不允许 Session Cookie 直接实例化。可通过新增 `requireTokenAuth` 中间件实现，或在 `requireAuth` 后额外判断。

### 2. 新增 `requireTokenAuth` 中间件

```js
function requireTokenAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: '未登录' });
  if (req.tokenSource === 'web') {
    return res.status(403).json({ error: '请使用 API Token 通过 CLI 或 MCP 使用模板' });
  }
  next();
}
```

`/instantiate` 改为 `requireTokenAuth`。

### 3. Token 哈希前缀计算

```js
const crypto = require('crypto');
function hashPrefix(tokenValue, len = 16) {
  return crypto.createHash('sha256').update(tokenValue).digest('hex').slice(0, len);
}
```

---

## 安全与限流

1. **实例化限流**：`POST /instantiate` 使用与上传相同的限流（`uploadRateLimiter`，50 req / 15 min / IP），避免刷文件/刷热度。
2. **禁止 Web Session 直接实例化**：`requireTokenAuth` 明确拒绝 `source === 'web'`。
3. **存储空间检查**：实例化前检查用户剩余配额，避免超量创建。
4. **审计日志**：每次实例化记录 `templateId`、`fileId`、`userId`、`source`、`tokenHashPrefix`、`ip`。

---

## 实施步骤

1. **迁移**：创建 `migrations/022_template_token_binding.js`，给 `content_template_installs` 加字段。
2. **认证中间件**：扩展 `lib/middleware/auth.js`，新增 `requireTokenAuth`。
3. **后端路由**：
   - 改造 `routes/content-templates.js` 的 `/instantiate`。
   - 移除或弃用 `/use`。
   - 新增 `/use-guide`。
4. **MCP**：改造 `mcp/tools-content-templates.js`，新增 `instantiate_content_template`。
5. **CLI**：新增 `bin/commands/template.js`，注册到 `bin/jpage.js`。
6. **前端**：改造 `public/js/pages/market.js` 的按钮行为与弹窗。
7. **测试**：补充集成测试覆盖：
   - 匿名用户不能实例化。
   - Web Session 用户不能实例化（403）。
   - API Token 通过 CLI 模式可以实例化并正确记录 `source='cli'`、`token_prefix`、`token_hash_prefix`。
   - MCP_TOKEN 可以实例化并记录 `source='mcp'`。
8. **文档**：更新 `docs/api.md`、`README.md` 中的工具数量与 CLI 命令列表。

---

## 预期效果

- 未登录用户访问 `/market` 仍可浏览、预览，但「使用」只能复制命令，无法直接创建文件。
- 已登录的 Web 用户同样只能复制命令，无法绕过 Token 机制。
- CLI 用户执行 `jpage template use 12` 后，账户下出现新文件，且系统能追溯到具体 Token。
- MCP 用户在对话中调用 `instantiate_content_template`，直接生成文件并可继续编辑。
- 热度统计更准确：`instantiation_count` 只统计真正创建文件的调用。

---

## 兼容性说明

- 旧 `POST /use` 若被第三方调用，返回 `410 Gone` 或保留为 no-op；建议直接移除以保持语义清晰。
- MCP `get_content_template` 不再自动 +use_count，热度下降属于预期（真正使用才计数）。
- Web UI 旧用户会注意到「使用」按钮行为变为「复制命令」，需要在界面上明确说明。
