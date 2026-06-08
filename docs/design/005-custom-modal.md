# 005 — 自定义 Modal 组件替代原生 prompt/confirm

> 状态：设计完成，待实现
> 关联：分析报告问题 #8（重命名 prompt）、#9（删除 confirm）
> 优先级：P1

---

## 一、现状分析

### 1.1 当前已实现

重命名和删除**已经**使用了自定义 modal（非原生 `prompt`/`confirm`），但实现方式是「每个场景独立编写 HTML + JS」：

| Modal | HTML 行数 | JS 逻辑 | 特点 |
|---|---|---|---|
| `rename-modal` | index.html:188-206 | app.js `doRename()` ~55 行 | 输入框 + 校验 + Promise 封装 |
| `delete-modal` | index.html:209-223 | app.js `doDelete()` ~43 行 | 动态文案 + 危险操作样式 |
| `skill-modal` | index.html:127-145 | app.js ~110 行 | 展示型，无表单 |
| `mcp-config-modal` | index.html:150-165 | 少量 | 展示型，纯复制 |
| `skills-list-modal` | index.html:167-184 | 少量 | 列表型 |

### 1.2 存在的问题

1. **代码重复**：每个 modal 的 open/close/cleanup 逻辑几乎一致（事件绑定、backdrop 点击、Escape 关闭、aria 属性切换），但各写一遍
2. **无通用组件**：新增 modal 场景（如分享链接、文件上传进度）需要复制整套 boilerplate
3. **事件泄漏风险**：手动 `addEventListener` / `removeEventListener` 配对，容易遗漏
4. **样式不统一**：个别 modal 使用 inline style（`style="max-width:440px"`），而非 CSS class

---

## 二、设计目标

1. **一个通用 Modal 工具函数**，覆盖三种场景：
   - **Alert**：纯信息提示 + 确认按钮（替代未来可能的 `alert`）
   - **Confirm**：确认/取消双按钮（替代 `confirm`，如删除确认）
   - **Prompt**：输入框 + 确认/取消（替代 `prompt`，如重命名）
2. **Promise 接口**，调用方式简洁：`const name = await modal.prompt({ title, value })` 
3. **复用现有 CSS**，不新增框架依赖
4. **向后兼容**：保留 skill-modal、mcp-config-modal 等展示型 modal 不变，仅重构交互型 modal

---

## 三、API 设计

### 3.1 `modal.confirm(options)` → `Promise<boolean>`

```js
const ok = await modal.confirm({
  title: '确认删除',
  message: '确定要删除 <strong>report.html</strong> 吗？此操作不可撤销。',
  // message 支持 HTML 字符串
  confirmText: '删除',      // 默认 '确认'
  danger: true,             // 确认按钮使用红色危险样式
});
// ok === true  → 用户点了确认
// ok === false → 用户点了取消 / Escape / 点击遮罩
```

### 3.2 `modal.prompt(options)` → `Promise<string|null>`

```js
const name = await modal.prompt({
  title: '重命名文件',
  label: '文件名',          // input 上方的 label 文字
  value: 'old-name.html',  // 输入框初始值
  placeholder: '输入新文件名',
  validate: (v) => {        // 可选校验函数
    if (!v.trim()) return '文件名不能为空';
    if (/[\/\\]/.test(v)) return '文件名不能包含 / 或 \\';
    return null;             // 返回 null 表示通过
  },
  confirmText: '确认',      // 默认 '确认'
});
// name === string → 用户输入的值（已 trim）
// name === null   → 用户取消
```

### 3.3 `modal.alert(options)` → `Promise<void>`

```js
await modal.alert({
  title: '提示',
  message: '复制失败，请手动复制以下链接',
});
// 用户点确认或关闭后 resolve
```

---

## 四、实现方案

### 4.1 HTML 结构

在 `index.html` 中新增一个**通用 modal 容器**（替换现有的 `rename-modal` 和 `delete-modal`）：

```html
<!-- 通用交互 Modal -->
<div class="modal-backdrop" id="dialog-modal" hidden aria-hidden="true"
     role="dialog" aria-modal="true" aria-labelledby="dialog-modal-title">
  <div class="modal-panel modal-panel-sm">
    <div class="modal-header">
      <h2 id="dialog-modal-title"></h2>
      <button type="button" class="btn btn-small modal-close"
              id="dialog-modal-close" aria-label="关闭">×</button>
    </div>
    <div class="modal-body">
      <div class="dialog-message" id="dialog-modal-message"></div>
      <label class="login-field dialog-field" id="dialog-modal-field" hidden>
        <span id="dialog-modal-label"></span>
        <input type="text" id="dialog-modal-input" autocomplete="off">
      </label>
      <div class="login-error" id="dialog-modal-error" role="alert" hidden></div>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-small" id="dialog-modal-cancel">取消</button>
      <button type="button" class="btn btn-primary" id="dialog-modal-confirm">确认</button>
    </div>
  </div>
</div>
```

要点：
- `dialog-message`：confirm/alert 场景显示消息，prompt 场景可隐藏或共存
- `dialog-field`：仅 prompt 场景显示（通过 `hidden` 切换）
- `dialog-modal-cancel`：alert 场景隐藏该按钮（只留确认）
- 现有的 `rename-modal` 和 `delete-modal` 两个 HTML 块将被移除

### 4.2 CSS 新增

```css
/* 小尺寸 modal（prompt / confirm / alert） */
.modal-panel-sm {
  max-width: 440px;
}

/* dialog body 内的消息文字 */
.dialog-message {
  font-size: 15px;
  line-height: 1.6;
  margin: 0;
}

/* dialog 输入区域的 label+input 间距 */
.dialog-field {
  margin-top: 12px;
}
```

不再使用 inline style，统一用 `modal-panel-sm` class。

### 4.3 JS 实现

在 `app.js` 中新增 `modal` 对象（约 80 行），核心逻辑：

```js
const dialogModal = {
  el: null, input: null, error: null,
  msg: null, field: null,
  confirmBtn: null, cancelBtn: null, closeBtn: null,
  _resolve: null,
  _mode: null,       // 'alert' | 'confirm' | 'prompt'
  _validate: null,

  init() {
    // 缓存 DOM 引用，绑定一次性事件
    this.el = document.getElementById('dialog-modal');
    // ... 缓存其他元素 ...
    this.closeBtn.onclick = () => this._dismiss();
    this.cancelBtn.onclick = () => this._dismiss();
    this.el.addEventListener('click', e => {
      if (e.target === this.el) this._dismiss();
    });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._accept();
      if (e.key === 'Escape') this._dismiss();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this.el.hidden) this._dismiss();
    });
  },

  _open(mode, opts) {
    this._mode = mode;
    this._resolve = null;
    // 设置 title、message、field 可见性、按钮文案等
    // ...
    this.el.hidden = false;
    this.el.setAttribute('aria-hidden', 'false');
    if (mode === 'prompt') { this.input.focus(); this.input.select(); }
    else { this.confirmBtn.focus(); }
    return new Promise(resolve => { this._resolve = resolve; });
  },

  _accept() {
    if (this._mode === 'prompt') {
      const val = this.input.value.trim();
      if (this._validate) {
        const err = this._validate(val);
        if (err) { this.error.textContent = err; this.error.hidden = false; return; }
      }
      this._close(val);
    } else {
      this._close(true);
    }
  },

  _dismiss() {
    this._close(this._mode === 'prompt' ? null : false);
  },

  _close(result) {
    this.el.hidden = true;
    this.el.setAttribute('aria-hidden', 'true');
    this.error.hidden = true;
    this._resolve(result);
  },

  confirm(opts) { return this._open('confirm', opts); },
  prompt(opts)  { return this._open('prompt', opts);  },
  alert(opts)   { return this._open('alert', opts);   },
};

// 在 DOMContentLoaded 中调用 dialogModal.init()
```

### 4.4 调用方改造

**`doRename` 改造前（~55 行）→ 改造后（~12 行）：**

```js
async function doRename(container, id, currentName) {
  const name = await dialogModal.prompt({
    title: '重命名文件',
    label: '文件名',
    value: currentName,
    validate: v => {
      if (!v.trim()) return '文件名不能为空';
      return null;
    },
  });
  if (name === null || name === currentName) return;
  try {
    await api(`/api/files/${id}`, { method: 'PUT', body: { name } });
    toast('重命名成功');
    loadFiles(container);
  } catch (e) {
    toast(e.message, 'error');
  }
}
```

**`doDelete` 改造前（~43 行）→ 改造后（~10 行）：**

```js
async function doDelete(container, id, fileName) {
  const ok = await dialogModal.confirm({
    title: '确认删除',
    message: `确定要删除 <strong>${escapeHtml(fileName)}</strong> 吗？此操作不可撤销。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/files/${id}`, { method: 'DELETE' });
    toast('删除成功');
    loadFiles(container);
  } catch (e) {
    toast(e.message, 'error');
  }
}
```

---

## 五、影响范围

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `public/index.html` | 修改 | 移除 `rename-modal` 和 `delete-modal` 两个 HTML 块，新增通用 `dialog-modal` |
| `public/css/style.css` | 修改 | 新增 `.modal-panel-sm`、`.dialog-message`、`.dialog-field` 样式 |
| `public/js/app.js` | 修改 | 新增 `dialogModal` 对象（~80 行），精简 `doRename` / `doDelete`（共减少 ~60 行） |

**不影响的文件**：`server.js`、`mcp-server.js`、`skills-registry.js`、展示型 modal（skill / mcp-config / skills-list）

---

## 六、验收标准

1. 重命名流程：点击重命名 → 弹出 modal → 输入新名称 → 校验不通过显示错误 → 确认后调用 API → 成功 toast + 刷新列表
2. 删除流程：点击删除 → 弹出确认 modal → 确认按钮为红色 → 确认后调用 API → 成功 toast + 刷新列表
3. Escape 键 / 点击遮罩 / 点取消 → 关闭 modal，不触发任何操作
4. 回车键（prompt 场景）→ 等同于点确认
5. 无 `window.prompt` / `window.confirm` / `window.alert` 调用残留
6. 深色模式下 modal 显示正常
7. 移动端 modal 居中显示，不被截断
