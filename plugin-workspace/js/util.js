// 即页 uTools 插件 · 前端工具函数（全局挂在 window.JP）

window.JP = {
  // ---- 文本/格式化 ----
  escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  formatSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  },

  formatDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const now = new Date();
    const diff = now - d;
    const min = 60 * 1000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diff < min) return '刚刚';
    if (diff < hour) return Math.floor(diff / min) + ' 分钟前';
    if (diff < day) return Math.floor(diff / hour) + ' 小时前';
    if (diff < 7 * day) return Math.floor(diff / day) + ' 天前';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${dd} ${hh}:${mm}`;
  },

  initialOf(name) {
    if (!name) return '?';
    const ch = name.trim().charAt(0);
    return ch.toUpperCase();
  },

  fileTypeLabel(type) {
    if (type === 'markdown') return 'MD';
    if (type === 'html') return 'HTML';
    return (type || 'FILE').slice(0, 4).toUpperCase();
  },

  // ---- 提示 ----
  toast(msg, duration = 2000) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
  },

  // ---- 模态框 ----
  modal({ title, bodyHtml, footerHtml, onMount, wide }) {
    const root = document.getElementById('modal-root');
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" ${wide ? 'style="max-width:720px"' : ''}>
        <div class="modal-header">
          <h3>${this.escapeHtml(title)}</h3>
          <button class="btn btn-icon btn-ghost jp-close" title="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="modal-body">${bodyHtml || ''}</div>
        ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
      </div>`;
    root.appendChild(mask);

    const close = () => {
      mask.remove();
      document.removeEventListener('keydown', onEsc);
    };
    const onEsc = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onEsc);
    mask.addEventListener('click', (e) => {
      if (e.target === mask || e.target.closest('.jp-close')) close();
    });

    if (onMount) onMount(mask, close);
    return { close, el: mask };
  },

  confirm({ title, message, danger, confirmText }) {
    return new Promise((resolve) => {
      this.modal({
        title: title || '确认',
        bodyHtml: `<p style="font-size:14px;line-height:1.6;color:var(--text-soft)">${this.escapeHtml(message)}</p>`,
        footerHtml: `
          <button class="btn jp-no">取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} jp-yes">${this.escapeHtml(
          confirmText || '确定'
        )}</button>`,
        onMount: (mask, close) => {
          mask.querySelector('.jp-no').onclick = () => {
            close();
            resolve(false);
          };
          mask.querySelector('.jp-yes').onclick = () => {
            close();
            resolve(true);
          };
        },
      });
    });
  },

  // ---- 错误提示 ----
  showError(err) {
    const msg = (err && err.message) || String(err);
    this.toast('❌ ' + msg, 3500);
    console.error('[即页]', err);
  },
};
