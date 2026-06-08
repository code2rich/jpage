# 013 — 文件版本历史

> 状态：设计完成，待实现
> 关联：问题 21（版本历史）
> 复杂度：★★★★★（DB + API + JS + CSS）

---

## 一、目标

为每个文件维护版本链。上传同名文件自动覆盖并保留历史版本；支持查看、恢复、删除历史版本。

---

## 二、数据库变更

### 2.1 `files` 表新增 `updated_at`

```sql
ALTER TABLE files ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;
```

回填：`UPDATE files SET updated_at = created_at WHERE updated_at IS NULL;`

语义：
- `created_at` = 首次上传时间，创建后不变
- `updated_at` = 最后一次覆盖上传的时间，每次覆盖刷新

文件列表排序改为 `ORDER BY updated_at DESC`。

### 2.2 新增 `file_versions` 表

```sql
CREATE TABLE IF NOT EXISTS file_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  uploaded_by INTEGER,
  UNIQUE(file_id, version),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_fv_file_ver ON file_versions(file_id, version DESC);
```

规则：
- `files.stored_name` 始终指向**当前版本**文件
- 覆盖上传时，先把旧 `stored_name` 写入 `file_versions`，再更新 `files` 主记录
- `version` 从 1 递增，不设上限
- 删除文件时 CASCADE 清理版本记录 + 遍历删磁盘文件

### 2.3 迁移策略

在 `db.serialize()` 块中顺序执行：

```
1. PRAGMA table_info(files) → 检查并 ADD COLUMN updated_at
2. 回填 updated_at
3. CREATE TABLE IF NOT EXISTS file_versions
4. CREATE INDEX IF NOT EXISTS idx_fv_file_ver
```

无需数据迁移，对现有文件透明。

---

## 三、同名文件自动覆盖逻辑

### 3.1 触发条件

`POST /api/files/upload` 和 `POST /api/files/upload-json` 中，写入数据库前检查：

```js
const existing = await dbGet(
  'SELECT id, stored_name, size, uploaded_by FROM files WHERE original_name = ?',
  [decodedName]
);
```

- **存在同名文件** → 执行覆盖流程（§3.2）
- **不存在** → 保持原有新建逻辑不变

### 3.2 覆盖流程

```
1. 计算 version 号：
   SELECT COALESCE(MAX(version), 0) + 1 FROM file_versions WHERE file_id = existing.id
   → nextVer

2. 备份当前版本到 file_versions：
   INSERT INTO file_versions (file_id, version, stored_name, size, uploaded_by)
   VALUES (existing.id, nextVer, existing.stored_name, existing.size, existing.uploaded_by)

3. 新文件写入磁盘（新 stored_name）

4. 更新 files 主记录：
   UPDATE files SET stored_name = ?, size = ?, updated_at = CURRENT_TIMESTAMP
   WHERE id = existing.id

5. 返回覆盖结果（含 version 信息）
```

**响应变化**：覆盖时返回 `{ overwritten: true, id, version: nextVer + 1, ... }`，前端据此提示「已更新为第 N 版」而非「上传成功」。

### 3.3 文件类型校验

同名覆盖时仍需校验扩展名一致。如果同名但扩展名不同（如已有 `a.html` 又上传 `a.md`），拒绝覆盖并提示「文件类型不匹配」，走新建流程。

---

## 四、API 设计

### 4.1 新增端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/files/:id/versions` | 需登录 | 列出版本历史 |
| `GET` | `/api/files/:id/versions/:ver/content` | 需登录 | 获取历史版本原文 |
| `GET` | `/api/files/:id/versions/:ver/render` | 需登录 | 渲染历史版本 |
| `POST` | `/api/files/:id/versions/:ver/restore` | 需登录 | 恢复到指定版本 |
| `DELETE` | `/api/files/:id/versions/:ver` | 需登录 | 删除指定历史版本 |

### 4.2 修改现有端点

| 端点 | 变更 |
|---|---|
| `POST /api/files/upload` | 上传前查同名 → 覆盖流程 |
| `POST /api/files/upload-json` | 上传前查同名 → 覆盖流程 |
| `GET /api/files` | 返回字段增加 `version_count`；排序改为 `updated_at DESC` |
| `DELETE /api/files/:id` | 删除前清理 `file_versions` 及对应磁盘文件 |

### 4.3 响应格式

**`GET /api/files/:id/versions`**

```json
{
  "file_id": 42,
  "current": {
    "stored_name": "1749...html",
    "size": 1234,
    "updated_at": "2026-06-08T14:30:00Z"
  },
  "versions": [
    {
      "id": 7,
      "version": 1,
      "size": 1000,
      "created_at": "2026-06-07T10:00:00Z"
    },
    {
      "id": 8,
      "version": 2,
      "size": 1100,
      "created_at": "2026-06-08T09:00:00Z"
    }
  ]
}
```

**覆盖上传响应**

```json
{
  "id": 42,
  "overwritten": true,
  "version": 3,
  "original_name": "report.html",
  "file_type": "html",
  "size": 1234,
  "is_public": 1,
  "share_key": "abc12345"
}
```

### 4.4 恢复版本流程

`POST /api/files/:id/versions/:ver/restore`

```
1. 从 file_versions 取目标版本的 stored_name
2. 读目标版本文件内容
3. 写入新磁盘文件（新 stored_name）
4. 当前版本备份到 file_versions（nextVer）
5. 更新 files.stored_name / size / updated_at 指向新文件
6. 返回成功
```

注意：restore 时复制文件内容到新 stored_name，这样 `file_versions` 中的记录可安全删除不影响当前版本。

### 4.5 删除版本流程

`DELETE /api/files/:id/versions/:ver`

```
1. 查 file_versions 获取 stored_name
2. 删除磁盘文件
3. DELETE FROM file_versions
```

---

## 五、文件列表页变更

### 5.1 SQL 查询

```sql
SELECT f.*,
  (SELECT COUNT(*) FROM file_versions WHERE file_id = f.id) AS version_count
FROM files f
ORDER BY f.updated_at DESC
```

### 5.2 列表项展示

`file-subline` 增加版本信息：

```
HTML | 公开 | 12.3 KB · v3 · 2 分钟前更新
```

- `v1` 不显示（无历史版本）
- `v2+` 显示版本号

### 5.3 前端变量

`allFiles` 中每个文件对象增加 `version_count` 字段，`renderFileList()` 中根据 `version_count > 0` 决定是否渲染版本 badge。

---

## 六、预览页 — 版本历史面板

### 6.1 布局

在预览页顶栏扩展行新增两个按钮：

```
[上传新版本]  [历史 v3 ▾]
```

点击「历史」按钮，右侧滑出面板：

```
┌──────────────────────────────────────────────────────┐
│ ← 返回  文件名.html  [渲染|源码] [下载] [上传新版本] [历史 v3 ▾] │
├──────────────────────────────────┬───────────────────┤
│                                  │ 版本历史           │
│                                  │                   │
│          iframe 预览              │ ● 当前 (v3)       │
│                                  │   12.3 KB · 刚刚   │
│                                  │                   │
│                                  │ ○ v2              │
│                                  │   10.1 KB · 2h前   │
│                                  │   [查看] [恢复] [删除]│
│                                  │                   │
│                                  │ ○ v1              │
│                                  │   8.2 KB · 昨天    │
│                                  │   [查看] [恢复] [删除]│
└──────────────────────────────────┴───────────────────┘
```

### 6.2 面板交互

| 操作 | 行为 |
|---|---|
| **查看** | iframe 加载 `/api/files/:id/versions/:ver/render`，面板保持打开 |
| **恢复** | 二次确认 → `POST /versions/:ver/restore` → 刷新版本列表 + iframe |
| **删除** | 二次确认 → `DELETE /versions/:ver` → 从列表移除该行 |
| **上传新版本** | 触发文件选择器 → 调用 `POST /api/files/:id/overwrite` → 刷新 |
| **关闭面板** | 点击遮罩 / Escape / 再次点击「历史」按钮 |

### 6.3 预览页「上传新版本」

预览页增加隐藏 `<input type="file">`，点击「上传新版本」触发。

调用新的 `POST /api/files/:id/overwrite` 端点（multipart），流程与首页上传类似，但目标是覆盖而非新建。

---

## 七、MCP 工具扩展

### 7.1 修改现有工具

`upload_file` 增加可选参数 `overwriteFileId`：

- 提供 `overwriteFileId` → 调用覆盖上传 API
- 不提供 → 保持原行为（同名自动覆盖逻辑在服务端生效，MCP JSON 上传也会触发）

### 7.2 新增工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_file_versions` | `fileId: number` | 列出版本历史 |
| `restore_file_version` | `fileId: number, version: number` | 恢复到指定版本 |

---

## 八、实现步骤

| 步骤 | 内容 | 涉及文件 |
|---|---|---|
| 1 | 数据库迁移（`updated_at` + `file_versions` 表） | `server.js` |
| 2 | 覆盖上传逻辑（同名自动覆盖 + `/overwrite` 端点） | `server.js` |
| 3 | 版本 CRUD API（列表/内容/渲染/恢复/删除） | `server.js` |
| 4 | 修改删除文件端点（清理版本） | `server.js` |
| 5 | 修改文件列表 API（`version_count` + `updated_at` 排序） | `server.js` |
| 6 | 前端：文件列表显示版本号 | `app.js` |
| 7 | 前端：预览页版本面板 UI + 交互 | `app.js`, `index.html`, `style.css` |
| 8 | MCP 工具扩展 | `mcp-server.js` |

---

## 九、边界情况

| 场景 | 处理 |
|---|---|
| 同名文件但扩展名不同 | 拒绝覆盖，提示「文件类型不匹配」 |
| 版本面板查看历史版本时又上传新版本 | 刷新版本列表，iframe 回到当前版本 |
| 恢复已被删除的版本 | 404 |
| 删除所有历史版本 | 面板显示「仅有当前版本」 |
| 并发覆盖同一文件 | SQLite 写锁串行化，后到者基于最新版本号递增，不会丢版本 |
| MCP 上传同名文件 | 与 Web 上传走同一套自动覆盖逻辑 |
