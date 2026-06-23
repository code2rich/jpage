// 用户管理弹窗：列表 / 创建 / 编辑（资料/角色/密码）/ 删除
// 依赖后端契约：GET/POST /api/users，PUT/DELETE /api/users/:id

import { api } from '../api.js';
import { toast } from './toast.js';
import { dialogModal } from './dialog.js';
import { escapeHtml, esc, formatDate, openModal, closeModal } from '../utils.js';
import { state } from '../app.js';

const usersModal = {
  open() {
    const modal = document.getElementById('users-modal');
    openModal(modal);
    this._load();
    modal.querySelector('#users-modal-close').onclick = () => { closeModal(modal); };
    modal.querySelector('#users-modal-dismiss').onclick = () => { closeModal(modal); };
    modal.querySelector('#btn-create-user').onclick = () => this._create();
    if (!modal.dataset.bound) {
      modal.dataset.bound = '1';
      modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal); });
    }
  },

  async _load() {
    const wrap = document.getElementById('users-table-wrap');
    try {
      const data = await api('/api/users');
      const users = data.users || [];
      wrap.innerHTML = '<table class="users-table"><thead><tr><th>ID</th><th>用户名</th><th>邮箱</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' +
        users.map(u => `<tr>
        <td>${u.id}</td>
        <td>${esc(u.username)}</td>
        <td>${u.email ? esc(u.email) : '<span style="color:var(--text-muted)">-</span>'}</td>
        <td><span class="role-badge role-${u.role}">${u.role === 'admin' ? '管理员' : '用户'}</span></td>
        <td>${formatDate(u.created_at)}</td>
        <td class="users-actions">
          <button class="btn btn-small btn-edit-user" data-id="${u.id}" data-username="${escapeHtml(u.username)}" data-role="${u.role}" data-email="${u.email ? escapeHtml(u.email) : ''}">编辑</button>
          ${u.id !== state.currentUser.id ? `<button class="btn btn-small btn-danger-outline btn-delete-user" data-id="${u.id}" data-username="${escapeHtml(u.username)}">删除</button>` : ''}
        </td></tr>`).join('') +
        '</tbody></table>';
      wrap.querySelectorAll('.btn-edit-user').forEach(btn => {
        btn.addEventListener('click', () => this._edit(+btn.dataset.id, btn.dataset.username, btn.dataset.role, btn.dataset.email));
      });
      wrap.querySelectorAll('.btn-delete-user').forEach(btn => {
        btn.addEventListener('click', () => this._delete(+btn.dataset.id, btn.dataset.username));
      });
    } catch (e) {
      wrap.innerHTML = '<p class="login-error">加载失败: ' + esc(e.message) + '</p>';
    }
  },

  async _create() {
    const username = await dialogModal.prompt({ title: '创建用户', label: '用户名', placeholder: '输入用户名' });
    if (!username) return;
    const email = await dialogModal.prompt({ title: '创建用户', label: '邮箱（可选）', placeholder: 'user@example.com' });
    const password = await dialogModal.prompt({ title: '创建用户', label: '密码（至少 8 位）', placeholder: '输入密码' });
    if (!password || password.length < 8) { if (password) toast('密码至少 8 位', 'error'); return; }
    const role = await dialogModal.prompt({ title: '创建用户', label: '角色 (admin/user)', value: 'user' });
    if (!role) return;
    try {
      const body = { username, password, role: role || 'user' };
      if (email) body.email = email;
      await api('/api/users', { method: 'POST', body });
      toast('用户已创建');
      this._load();
    } catch (e) { toast(e.message, 'error'); }
  },

  async _edit(id, username, role, email) {
    const choice = await dialogModal.confirm({
      title: '编辑用户: ' + username,
      message: '请选择操作',
      confirmText: '修改资料',
      cancelText: '更多操作…'
    });

    if (choice) {
      // 修改资料
      const newUsername = await dialogModal.prompt({ title: '修改用户名', label: '用户名', value: username });
      if (!newUsername) return;
      const newEmail = await dialogModal.prompt({ title: '修改邮箱', label: '邮箱（留空清除）', value: email || '' });
      try {
        await api('/api/users/' + id, { method: 'PUT', body: { username: newUsername, email: newEmail || '' } });
        toast('资料已更新');
        this._load();
      } catch (e) { toast(e.message, 'error'); }
    } else {
      // 更多操作：修改角色或重置密码
      const changeRole = await dialogModal.confirm({ title: '更多操作', message: '选择操作', confirmText: '修改角色', cancelText: '重置密码' });
      if (changeRole) {
        const newRole = await dialogModal.prompt({ title: '修改角色', label: '新角色 (admin/user)', value: role });
        if (!newRole) return;
        try {
          await api('/api/users/' + id, { method: 'PUT', body: { role: newRole } });
          toast('角色已更新');
          this._load();
        } catch (e) { toast(e.message, 'error'); }
      } else {
        const pwd = await dialogModal.prompt({ title: '重置密码', label: '新密码（至少 8 位）' });
        if (!pwd) return;
        if (pwd.length < 8) { toast('密码至少 8 位', 'error'); return; }
        try {
          await api('/api/users/' + id, { method: 'PUT', body: { password: pwd } });
          toast('密码已重置');
        } catch (e) { toast(e.message, 'error'); }
      }
    }
  },

  async _delete(id, username) {
    const ok = await dialogModal.confirm({ title: '删除用户', message: `确定删除用户 <strong>${escapeHtml(username)}</strong>？其文件将转交给管理员。`, danger: true });
    if (!ok) return;
    try {
      await api('/api/users/' + id, { method: 'DELETE' });
      toast('用户已删除');
      this._load();
    } catch (e) { toast(e.message, 'error'); }
  },
};

function openUsersModal() {
  usersModal.open();
}

export { openUsersModal };
