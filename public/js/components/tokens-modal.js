// API 令牌管理弹窗：列表 / 创建 / 查看（明文）/ 复制 / 删除
// 依赖后端契约：GET/POST /api/tokens，POST /api/tokens/:id/reveal，DELETE /api/tokens/:id

import { api } from '../api.js';
import { toast } from './toast.js';
import { dialogModal } from './dialog.js';
import { esc, formatDate, openModal, closeModal, copyToClipboard } from '../utils.js';

const tokensModal = {
  open() {
    const modal = document.getElementById('tokens-modal');
    openModal(modal);
    this._load();
    modal.querySelector('#tokens-modal-close').onclick = () => { closeModal(modal); };
    modal.querySelector('#tokens-modal-dismiss').onclick = () => { closeModal(modal); };
    modal.querySelector('#btn-create-token').onclick = () => this._create();
    if (!modal.dataset.bound) {
      modal.dataset.bound = '1';
      modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal); });
    }
  },

  async _load() {
    const listEl = document.getElementById('tokens-list');
    try {
      const data = await api('/api/tokens');
      const tokens = data.tokens || [];
      if (tokens.length === 0) {
        listEl.innerHTML = '<p class="modal-hint">暂无令牌，点击上方按钮创建。</p>';
        return;
      }
      listEl.innerHTML = tokens.map(t => `<div class="token-item">
      <div class="token-info">
        <strong>${esc(t.name)}</strong>
        <code class="token-prefix">${esc(t.token_prefix)}…</code>
        <span class="token-time">创建于 ${formatDate(t.created_at)}${t.last_used_at ? ' · 最后使用 ' + formatDate(t.last_used_at) : ''}</span>
      </div>
      <div class="token-actions">
        <button class="btn btn-small" data-token-reveal="${t.id}" data-token-name="${esc(t.name)}" ${t.viewable ? '' : 'disabled title="此令牌创建于功能启用前，无法查看，请删除后重建"'}>查看/复制</button>
        <button class="btn btn-small btn-danger-outline" data-token-id="${t.id}" data-token-name="${esc(t.name)}">删除</button>
      </div>
    </div>`).join('');
      listEl.querySelectorAll('[data-token-id]').forEach(btn => {
        btn.addEventListener('click', () => this._delete(parseInt(btn.dataset.tokenId), btn.dataset.tokenName));
      });
      listEl.querySelectorAll('[data-token-reveal]').forEach(btn => {
        if (btn.disabled) return;
        btn.addEventListener('click', () => this._reveal(parseInt(btn.dataset.tokenReveal), btn.dataset.tokenName));
      });
    } catch (e) {
      listEl.innerHTML = '<p class="login-error">加载失败: ' + esc(e.message) + '</p>';
    }
  },

  async _reveal(id, name) {
    let data;
    try {
      data = await api('/api/tokens/' + id + '/reveal', { method: 'POST' });
    } catch (e) { toast(e.message, 'error'); return; }

    const modal = document.getElementById('token-reveal-modal');
    const input = modal.querySelector('#token-reveal-modal-input');
    modal.querySelector('#token-reveal-modal-name').textContent = '令牌「' + name + '」的明文：';
    input.value = data.token;
    openModal(modal);

    const closeBtn = modal.querySelector('#token-reveal-modal-close');
    const dismissBtn = modal.querySelector('#token-reveal-modal-dismiss');
    const copyBtn = modal.querySelector('#token-reveal-modal-copy');
    const close = () => closeModal(modal);
    closeBtn.onclick = close;
    dismissBtn.onclick = close;
    copyBtn.onclick = async () => {
      const ok = await copyToClipboard(data.token);
      if (ok) {
        copyBtn.textContent = '已复制';
        toast('令牌已复制');
        setTimeout(() => { copyBtn.textContent = '复制'; }, 2000);
      } else {
        input.focus();
        input.select();
        toast('复制失败，请手动选中复制', 'error');
      }
    };
    if (!modal.dataset.bound) {
      modal.dataset.bound = '1';
      modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal); });
    }
    // 延迟聚焦，等待弹窗显示动画结束
    setTimeout(() => { input.focus(); input.select(); }, 0);
  },

  async _create() {
    const name = await dialogModal.prompt({ title: '创建令牌', label: '令牌名称', placeholder: '例如: My CI Token' });
    if (!name) return;
    try {
      const data = await api('/api/tokens', { method: 'POST', body: { name } });
      await dialogModal.alert({ title: '令牌已创建', message: '请妥善保存以下令牌。也可稍后在列表中点击「查看/复制」再次获取：\n\n' + esc(data.token) });
      this._load();
    } catch (e) { toast(e.message, 'error'); }
  },

  async _delete(id, name) {
    const ok = await dialogModal.confirm({
      title: '删除令牌',
      message: `确定删除令牌「${name}」？使用此令牌的应用将失去访问权限。`,
      confirmText: '删除',
    });
    if (!ok) return;
    try {
      await api('/api/tokens/' + id, { method: 'DELETE' });
      toast('令牌已删除');
      this._load();
    } catch (e) { toast(e.message, 'error'); }
  },
};

function openTokensModal() {
  tokensModal.open();
}

export { openTokensModal };
