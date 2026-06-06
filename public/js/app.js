const API_BASE = '';
let currentUser = null;

async function api(path, opts = {}) {
  const url = API_BASE + path;
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ---------- Auth ----------
async function fetchCurrentUser() {
  try {
    const data = await api('/api/auth/me');
    currentUser = data;
    return data;
  } catch (e) {
    if (e.status === 401) {
      currentUser = null;
      return null;
    }
    throw e;
  }
}

function navigate(path) {
  location.hash = path;
  route();
}

function route() {
  const hash = location.hash.replace('#', '') || '/';

  if (hash === '/login') {
    renderLogin(document.getElementById('app'));
    return;
  }

  if (hash.startsWith('/view/')) {
    renderPreview(document.getElementById('app'), hash);
    return;
  }

  if (currentUser) {
    renderHome(document.getElementById('app'));
  } else {
    renderLogin(document.getElementById('app'));
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('load', async () => {
  await fetchCurrentUser();
  route();
});

// ---------- Login Page ----------
function renderLogin(container) {
  if (currentUser) { navigate('/'); return; }
  const tmpl = document.getElementById('login-template');
  container.innerHTML = '';
  container.appendChild(tmpl.content.cloneNode(true));

  const form = container.querySelector('#login-form');
  const errEl = container.querySelector('#login-error');
  const submit = container.querySelector('#login-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = container.querySelector('#login-username').value.trim();
    const password = container.querySelector('#login-password').value;
    if (!username || !password) return;
    errEl.hidden = true;
    submit.disabled = true;
    const origText = submit.textContent;
    submit.textContent = '登录中…';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: { username, password }
      });
      currentUser = data;
      toast('登录成功');
      navigate('/');
    } catch (e) {
      errEl.textContent = e.message || '登录失败';
      errEl.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = origText;
    }
  });
}

// ---------- Home Page ----------
function renderHome(container) {
  const tmpl = document.getElementById('home-template');
  container.innerHTML = '';
  container.appendChild(tmpl.content.cloneNode(true));

  const userEl = container.querySelector('#header-user');
  if (currentUser) userEl.textContent = currentUser.username;

  const logoutBtn = container.querySelector('#btn-logout');
  logoutBtn.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (_) {}
    currentUser = null;
    toast('已退出');
    navigate('/');
  });

  setupUpload(container);
  loadFiles(container);
  loadSkills(container);
  setupSkillModal();
}

function setupUpload(container) {
  const area = container.querySelector('#upload-area');
  const input = container.querySelector('#file-input');

  area.addEventListener('click', () => input.click());
  area.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('dragover'); });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', e => {
    e.preventDefault();
    area.classList.remove('dragover');
    if (e.dataTransfer.files.length) uploadFile(container, e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => {
    if (input.files.length) uploadFile(container, input.files[0]);
  });
}

async function uploadFile(container, file) {
  const allowed = ['.html', '.htm', '.md', '.markdown'];
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!allowed.includes(ext)) {
    toast('仅支持 HTML 和 Markdown 文件', 'error');
    return;
  }
  const area = container.querySelector('#upload-area');
  const prevPointer = area.style.pointerEvents;
  area.style.pointerEvents = 'none';
  const fd = new FormData();
  fd.append('file', file);
  const isPublicEl = container.querySelector('#upload-is-public');
  fd.append('isPublic', isPublicEl && isPublicEl.checked ? 'true' : 'false');
  try {
    await fetch(API_BASE + '/api/files/upload', {
      method: 'POST',
      body: fd,
      credentials: 'same-origin'
    }).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      return data;
    });
    toast('上传成功');
    container.querySelector('#file-input').value = '';
    loadFiles(container);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    area.style.pointerEvents = prevPointer;
  }
}

async function loadFiles(container) {
  const list = container.querySelector('#file-list');
  const empty = container.querySelector('#empty-state');
  const count = container.querySelector('#file-count');

  list.setAttribute('aria-busy', 'true');
  list.classList.add('is-loading');
  list.textContent = '正在加载…';
  empty.style.display = 'none';
  count.textContent = '';

  try {
    const data = await api('/api/files');
    list.classList.remove('is-loading');
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = '';

    count.textContent = `共 ${data.files.length} 个文件`;

    if (!data.files.length) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    data.files.forEach(f => {
      const el = document.createElement('div');
      el.className = 'file-item';
      const size = formatSize(f.size);
      const date = new Date(f.created_at).toLocaleString('zh-CN');
      const iconClass = f.file_type === 'markdown' ? 'md' : 'html';
      const iconText = f.file_type === 'markdown' ? 'MD' : 'HTML';
      const safeName = escapeHtml(f.original_name);
      const isPublic = !!f.is_public;
      const lockBadge = isPublic ? '' : '<span class="file-lock" title="私有文件" aria-label="私有文件">🔒</span>';

      el.innerHTML = `
        <div class="file-info" data-id="${f.id}" role="button" tabindex="0">
          <div class="file-icon ${iconClass}" aria-hidden="true">${iconText}</div>
          <div class="file-meta">
            <div class="file-name">${lockBadge}${safeName}</div>
            <div class="file-detail">${size} · ${date}</div>
          </div>
        </div>
        <div class="file-actions">
          <button type="button" class="btn btn-small btn-privacy" data-id="${f.id}" data-public="${isPublic}">${isPublic ? '设为私有' : '设为公开'}</button>
          <button type="button" class="btn btn-small btn-rename" data-id="${f.id}">重命名</button>
          <button type="button" class="btn btn-small btn-danger btn-delete" data-id="${f.id}">删除</button>
        </div>
      `;

      const info = el.querySelector('.file-info');
      info.setAttribute('aria-label', `打开 ${f.original_name}`);
      const openPreview = () => navigate('/view/' + f.id);
      info.addEventListener('click', openPreview);
      info.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openPreview();
        }
      });
      el.querySelector('.btn-privacy').addEventListener('click', e => {
        e.stopPropagation();
        doSetPrivacy(container, f.id, isPublic);
      });
      el.querySelector('.btn-rename').addEventListener('click', e => {
        e.stopPropagation();
        doRename(container, f.id, f.original_name);
      });
      el.querySelector('.btn-delete').addEventListener('click', e => {
        e.stopPropagation();
        doDelete(container, f.id);
      });
      list.appendChild(el);
    });
  } catch (e) {
    list.classList.remove('is-loading');
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = '';
    if (e.status === 401) {
      currentUser = null;
      navigate('/');
      return;
    }
    toast(e.message, 'error');
  }
}

async function doRename(container, id, currentName) {
  const name = prompt('请输入新文件名:', currentName);
  if (!name || name === currentName) return;
  try {
    await api(`/api/files/${id}`, {
      method: 'PUT',
      body: { name }
    });
    toast('重命名成功');
    loadFiles(container);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function doSetPrivacy(container, id, currentPublic) {
  try {
    await api(`/api/files/${id}`, {
      method: 'PUT',
      body: { isPublic: !currentPublic }
    });
    toast(currentPublic ? '已设为私有' : '已设为公开');
    loadFiles(container);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function doDelete(container, id) {
  if (!confirm('确定要删除这个文件吗？')) return;
  try {
    await api(`/api/files/${id}`, { method: 'DELETE' });
    toast('删除成功');
    loadFiles(container);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- Preview Page ----------
const PREVIEW_HEADER_COLLAPSED_KEY = 'htmlwebsite_preview_header_collapsed';
const PREVIEW_TOOLBAR_COMPACT_KEY = 'htmlwebsite_preview_toolbar_compact';

function syncPreviewHeaderState(layout, expandFloatingBtn, toggleHeaderBtn) {
  const collapsed = layout.classList.contains('preview-header-collapsed');
  if (toggleHeaderBtn) {
    toggleHeaderBtn.setAttribute('aria-expanded', String(!collapsed));
    toggleHeaderBtn.setAttribute('aria-label', collapsed ? '展开顶栏' : '收起顶栏');
    toggleHeaderBtn.title = collapsed ? '展开顶栏' : '收起顶栏';
  }
  if (expandFloatingBtn) {
    expandFloatingBtn.tabIndex = collapsed ? 0 : -1;
    expandFloatingBtn.setAttribute('aria-hidden', collapsed ? 'false' : 'true');
  }
  try {
    sessionStorage.setItem(PREVIEW_HEADER_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch (_) {}
}

function syncToolbarCompact(layout, titleStrip, fileName) {
  const compact = layout.classList.contains('preview-toolbar-compact');
  const titleSpan = titleStrip.querySelector('#preview-title');
  const name = (typeof fileName === 'string' && fileName.length > 0)
    ? fileName
    : (titleSpan ? titleSpan.textContent.trim() : '');
  titleStrip.setAttribute('aria-expanded', String(!compact));
  titleStrip.setAttribute('aria-label', compact ? `展开完整工具栏${name ? '：' + name : ''}` : '仅显示标题');
  try {
    sessionStorage.setItem(PREVIEW_TOOLBAR_COMPACT_KEY, compact ? '1' : '0');
  } catch (_) {}
}

function renderPreview(container, hash) {
  const id = hash.split('/').pop();
  if (!id) return navigate('/');

  const tmpl = document.getElementById('preview-template');
  container.innerHTML = '';
  container.appendChild(tmpl.content.cloneNode(true));

  const layout = container.querySelector('#preview-layout-root');
  const expandFloatingBtn = container.querySelector('#btn-preview-expand-floating');
  const titleStrip = container.querySelector('#preview-title-expand');
  const toggleHeaderBtn = container.querySelector('#btn-toggle-preview-header');
  const compactBtn = container.querySelector('#btn-preview-compact-only');
  const iframe = container.querySelector('#preview-iframe');
  const source = container.querySelector('#preview-source');
  const code = container.querySelector('#source-code');
  const toggles = container.querySelectorAll('.view-toggle .btn');

  let fileName;

  function setViewMode(mode) {
    if (mode === 'render') {
      iframe.style.display = 'block';
      source.classList.remove('active');
    } else {
      iframe.style.display = 'none';
      source.classList.add('active');
    }
    toggles.forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  try {
    if (sessionStorage.getItem(PREVIEW_HEADER_COLLAPSED_KEY) === '1') {
      layout.classList.add('preview-header-collapsed');
    }
    if (sessionStorage.getItem(PREVIEW_TOOLBAR_COMPACT_KEY) === '1') {
      layout.classList.add('preview-toolbar-compact');
    }
  } catch (_) {}

  syncPreviewHeaderState(layout, expandFloatingBtn, toggleHeaderBtn);
  syncToolbarCompact(layout, titleStrip, fileName);

  titleStrip.addEventListener('click', () => {
    layout.classList.remove('preview-toolbar-compact');
    syncToolbarCompact(layout, titleStrip, fileName);
  });

  compactBtn.addEventListener('click', e => {
    e.stopPropagation();
    layout.classList.add('preview-toolbar-compact');
    syncToolbarCompact(layout, titleStrip, fileName);
  });

  toggleHeaderBtn.addEventListener('click', e => {
    e.stopPropagation();
    layout.classList.toggle('preview-header-collapsed');
    syncPreviewHeaderState(layout, expandFloatingBtn, toggleHeaderBtn);
  });

  expandFloatingBtn.addEventListener('click', () => {
    layout.classList.remove('preview-header-collapsed');
    syncPreviewHeaderState(layout, expandFloatingBtn, toggleHeaderBtn);
  });

  container.querySelector('#btn-back').addEventListener('click', () => navigate('/'));

  toggles.forEach(btn => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
  });

  container.querySelector('#btn-download').addEventListener('click', () => {
    const w = window.open(API_BASE + `/api/files/${id}/download`, '_blank');
    if (w) w.opener = null;
  });

  api(`/api/files/${id}/content`).then(data => {
    fileName = data.original_name;
    const lockPrefix = data.is_public ? '' : '<span class="file-lock" title="私有文件" aria-label="私有文件">🔒 </span>';
    container.querySelector('#preview-title').innerHTML = lockPrefix + escapeHtml(data.original_name);
    container.querySelector('#preview-heading').innerHTML = lockPrefix + escapeHtml(data.original_name);
    expandFloatingBtn.title = `展开顶栏 · ${data.original_name}`;
    expandFloatingBtn.setAttribute('aria-label', `展开顶栏 · ${data.original_name}`);
    syncToolbarCompact(layout, titleStrip, fileName);
    code.textContent = data.content;
    iframe.src = API_BASE + `/api/files/${id}/render`;
  }).catch(e => {
    toast(e.message, 'error');
    navigate('/');
  });
}

// ---------- Utils ----------
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Skills ----------
async function loadSkills(container) {
  const list = container.querySelector('#skills-list');
  const empty = container.querySelector('#skills-empty');
  const count = container.querySelector('#skills-count');
  if (!list) return;
  list.setAttribute('aria-busy', 'true');
  list.classList.add('is-loading');
  list.textContent = '正在加载…';
  empty.style.display = 'none';
  count.textContent = '';
  try {
    const data = await api('/api/skills');
    list.classList.remove('is-loading');
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = '';
    count.textContent = `共 ${data.skills.length} 个 Skill`;
    if (!data.skills.length) {
      empty.style.display = 'block';
      return;
    }
    data.skills.forEach(s => {
      const el = document.createElement('div');
      el.className = 'skill-card';
      const desc = s.description || '（无描述）';
      el.innerHTML = `
        <div class="skill-card-info">
          <div class="skill-card-title">
            <span class="skill-name">${escapeHtml(s.title || s.name)}</span>
            <span class="skill-version">${escapeHtml(s.version || '')}</span>
          </div>
          <p class="skill-card-desc">${escapeHtml(desc)}</p>
          <div class="skill-card-meta">${s.fileCount} 个文件 · ${formatSize(s.totalSize)}</div>
        </div>
        <div class="skill-card-actions">
          <button type="button" class="btn btn-small skill-view" data-name="${escapeHtml(s.name)}">查看详情</button>
          <button type="button" class="btn btn-small skill-download" data-name="${escapeHtml(s.name)}">下载 .zip</button>
        </div>
      `;
      el.querySelector('.skill-view').addEventListener('click', () => openSkillModal(s.name));
      el.querySelector('.skill-download').addEventListener('click', () => downloadSkill(s.name));
      list.appendChild(el);
    });
  } catch (e) {
    list.classList.remove('is-loading');
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = '';
    if (e.status === 401) {
      currentUser = null;
      navigate('/');
      return;
    }
    toast(e.message, 'error');
  }
}

let skillModalCurrent = null;

function setupSkillModal() {
  const modal = document.getElementById('skill-modal');
  if (!modal || modal.dataset.bound) return;
  modal.dataset.bound = '1';
  modal.querySelector('#skill-modal-close').addEventListener('click', closeSkillModal);
  modal.querySelector('#skill-modal-dismiss').addEventListener('click', closeSkillModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeSkillModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) closeSkillModal();
  });
}

function openSkillModal(name) {
  api('/api/skills/' + encodeURIComponent(name)).then(skill => {
    skillModalCurrent = skill.name;
    document.getElementById('skill-modal-title').textContent = skill.title || skill.name;
    const meta = document.getElementById('skill-modal-meta');
    meta.innerHTML = `
      <div><strong>名称：</strong>${escapeHtml(skill.title || skill.name)}</div>
      <div><strong>目录：</strong><code>${escapeHtml(skill.name)}</code></div>
      ${skill.version ? `<div><strong>版本：</strong>${escapeHtml(skill.version)}</div>` : ''}
      ${skill.author ? `<div><strong>作者：</strong>${escapeHtml(skill.author)}</div>` : ''}
      <div><strong>文件数：</strong>${skill.fileCount} · <strong>大小：</strong>${formatSize(skill.totalSize)}</div>
      ${skill.description ? `<div><strong>描述：</strong>${escapeHtml(skill.description)}</div>` : ''}
    `;
    const files = document.getElementById('skill-modal-files');
    files.innerHTML = skill.files.map(f => `<li>${escapeHtml(f)}</li>`).join('');
    document.getElementById('skill-modal-source').textContent = skill.body || '（SKILL.md 正文为空）';
    const modal = document.getElementById('skill-modal');
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  }).catch(e => toast(e.message, 'error'));
}

function closeSkillModal() {
  const modal = document.getElementById('skill-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  skillModalCurrent = null;
}

function downloadSkill(name) {
  const w = window.open(API_BASE + '/api/skills/' + encodeURIComponent(name) + '/download', '_blank');
  if (w) w.opener = null;
}

document.addEventListener('click', e => {
  const btn = e.target.closest && e.target.closest('#skill-modal-download');
  if (!btn) return;
  if (skillModalCurrent) downloadSkill(skillModalCurrent);
});
