// 分享设置弹窗：重新生成短链 / 自定义别名 / 过期时间 / 访问密码 + 状态总览。
// 独立模块，避免与首页/预览页耦合；由两者「更多」菜单共用。
//
// 入参 current：打开时传入的文件元数据快照（含 share_key/is_public/share_expires_at/has_share_password）。
// onUpdated(snap)：可选回调，操作成功后通知调用方刷新其本地数据（列表重渲染 / 预览刷新）。

import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { dialogModal } from '../components/dialog.js';
import { escapeHtml, openModal, closeModal, copyToClipboard } from '../utils.js';

async function openShareSettings(fileId, current, onUpdated) {
  const modal = document.getElementById('share-settings-modal');
  if (!modal) return;
  // 本地快照：随操作实时更新，避免界面与后端不同步
  const snap = {
    share_key: current.share_key,
    is_public: !!current.is_public,
    share_expires_at: current.share_expires_at || null,
    has_share_password: !!current.has_share_password,
  };

  const el = (id) => modal.querySelector('#' + id);
  const linkInput = el('share-link-input');
  const aliasInput = el('share-alias-input');
  const expiresInput = el('share-expires-input');
  const passwordInput = el('share-password-input');
  const passwordToggle = el('share-password-toggle');

  // 密码显隐切换
  if (passwordToggle) {
    passwordToggle.addEventListener('click', () => {
      const isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
      passwordToggle.querySelector('.icon-eye').style.display = isPassword ? 'none' : '';
      passwordToggle.querySelector('.icon-eye-off').style.display = isPassword ? '' : 'none';
      passwordToggle.setAttribute('aria-label', isPassword ? '隐藏密码' : '显示密码');
      passwordToggle.title = isPassword ? '隐藏密码' : '显示密码';
    });
  }

  // 把本地快照刷新到界面（链接、状态徽标、别名输入框回显、过期时间回显）
  function refresh() {
    linkInput.value = snap.share_key ? `${location.origin}/s/${snap.share_key}` : '';
    aliasInput.value = '';
    passwordInput.value = '';
    // 过期时间回显：UTC 'YYYY-MM-DD HH:MM:SS' → 本地时区 datetime-local 值
    if (snap.share_expires_at) {
      const d = new Date(snap.share_expires_at.replace(' ', 'T') + 'Z');
      if (!isNaN(d.getTime())) {
        const pad = (n) => String(n).padStart(2, '0');
        expiresInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      } else {
        expiresInput.value = '';
      }
    } else {
      expiresInput.value = '';
    }
    // 状态徽标：公开/私有 · 密码保护 · 过期时间
    const badges = [];
    badges.push(snap.is_public
      ? '<span class="file-badge file-badge-public">公开</span>'
      : '<span class="file-badge file-badge-private">私有</span>');
    if (snap.has_share_password) badges.push('<span class="file-badge file-badge-share-lock">🔒 密码保护</span>');
    if (snap.share_expires_at) {
      const d = new Date(snap.share_expires_at.replace(' ', 'T') + 'Z');
      const label = isNaN(d.getTime()) ? snap.share_expires_at : d.toLocaleString();
      badges.push(`<span class="file-badge file-badge-share-expire">⏰ ${escapeHtml(label)} 过期</span>`);
    }
    el('share-status-badges').innerHTML = badges.join(' ');
  }

  refresh();
  openModal(modal);

  const close = () => closeModal(modal);
  el('share-settings-close').onclick = close;
  el('share-settings-done').onclick = close;

  // 复制链接
  el('share-link-copy').onclick = async () => {
    if (await copyToClipboard(linkInput.value)) toast('链接已复制');
    else toast('复制失败，请手动复制', 'error');
  };

  // 保存自定义别名（或清空回到随机）
  el('share-alias-save').onclick = async () => {
    const alias = aliasInput.value.trim();
    if (alias && !/^[a-zA-Z0-9_-]{3,32}$/.test(alias)) {
      toast('别名仅支持字母、数字、下划线、连字符，3~32 位', 'error');
      return;
    }
    try {
      const data = await api(`/api/files/${fileId}/share`, {
        method: 'PUT', body: { alias }
      });
      snap.share_key = data.share_key;
      snap.share_expires_at = data.share_expires_at;
      snap.has_share_password = data.has_share_password;
      refresh();
      toast('别名已更新');
      if (onUpdated) onUpdated(snap);
    } catch (e) { toast(e.message || '保存别名失败', 'error'); }
  };

  // 重新生成链接（撤销旧链）—— 需二次确认，因为旧链接立即失效
  el('share-regenerate').onclick = async () => {
    const ok = await dialogModal.confirm({
      title: '重新生成链接',
      message: '当前链接将<strong>立即失效</strong>，所有持有旧链接的人将无法访问。确定继续？',
      confirmText: '重新生成', danger: true,
    });
    if (!ok) return;
    try {
      const data = await api(`/api/files/${fileId}/share/regenerate`, { method: 'POST' });
      snap.share_key = data.share_key;
      refresh();
      toast('已生成新链接，旧链接已失效');
      if (onUpdated) onUpdated(snap);
    } catch (e) { toast(e.message || '重新生成失败', 'error'); }
  };

  // 保存过期时间
  el('share-expires-save').onclick = async () => {
    const val = expiresInput.value;
    // datetime-local 是本地时区值，转 ISO 再交给后端（后端转 UTC 存储）
    const iso = val ? new Date(val).toISOString() : null;
    try {
      const data = await api(`/api/files/${fileId}/share`, {
        method: 'PUT', body: { expiresAt: iso }
      });
      snap.share_expires_at = data.share_expires_at;
      snap.share_key = data.share_key;
      snap.has_share_password = data.has_share_password;
      refresh();
      toast('过期时间已保存');
      if (onUpdated) onUpdated(snap);
    } catch (e) { toast(e.message || '保存过期时间失败', 'error'); }
  };

  // 永不过期（清空）
  el('share-expires-clear').onclick = async () => {
    try {
      const data = await api(`/api/files/${fileId}/share`, {
        method: 'PUT', body: { expiresAt: null }
      });
      snap.share_expires_at = data.share_expires_at;
      refresh();
      toast('已设为永不过期');
      if (onUpdated) onUpdated(snap);
    } catch (e) { toast(e.message || '操作失败', 'error'); }
  };

  // 保存密码（空串→清除）
  el('share-password-save').onclick = async () => {
    try {
      const data = await api(`/api/files/${fileId}/share`, {
        method: 'PUT', body: { password: passwordInput.value }
      });
      snap.has_share_password = data.has_share_password;
      snap.share_key = data.share_key;
      snap.share_expires_at = data.share_expires_at;
      refresh();
      toast(snap.has_share_password ? '访问密码已设置' : '访问密码已清除');
      if (onUpdated) onUpdated(snap);
    } catch (e) { toast(e.message || '保存密码失败', 'error'); }
  };

  // 清除密码
  el('share-password-clear').onclick = async () => {
    try {
      const data = await api(`/api/files/${fileId}/share`, {
        method: 'PUT', body: { password: null }
      });
      snap.has_share_password = data.has_share_password;
      refresh();
      toast('访问密码已清除');
      if (onUpdated) onUpdated(snap);
    } catch (e) { toast(e.message || '清除密码失败', 'error'); }
  };
}

export { openShareSettings };
