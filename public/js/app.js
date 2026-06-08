const API_BASE = '';
let currentUser = null;
let allFiles = [];
let filterState = { query: '', filter: 'all', tagId: null, categoryId: null };
let allTags = [];
let allCategories = [];

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

// ---------- Dialog Modal (prompt / confirm / alert) ----------
const dialogModal = {
  el: null, input: null, error: null, msg: null, field: null,
  confirmBtn: null, cancelBtn: null, closeBtn: null,
  _resolve: null, _mode: null, _validate: null, _escHandler: null,

  init() {
    this.el = document.getElementById('dialog-modal');
    this.input = document.getElementById('dialog-modal-input');
    this.error = document.getElementById('dialog-modal-error');
    this.msg = document.getElementById('dialog-modal-message');
    this.field = document.getElementById('dialog-modal-field');
    this.confirmBtn = document.getElementById('dialog-modal-confirm');
    this.cancelBtn = document.getElementById('dialog-modal-cancel');
    this.closeBtn = document.getElementById('dialog-modal-close');
    this.titleEl = document.getElementById('dialog-modal-title');
    this.labelEl = document.getElementById('dialog-modal-label');

    this.closeBtn.addEventListener('click', () => this._dismiss());
    this.cancelBtn.addEventListener('click', () => this._dismiss());
    this.el.addEventListener('click', e => { if (e.target === this.el) this._dismiss(); });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._accept();
      if (e.key === 'Escape') this._dismiss();
    });
    this.input.addEventListener('input', () => { this.error.hidden = true; });
    this.confirmBtn.addEventListener('click', () => this._accept());
  },

  _open(mode, opts) {
    this._mode = mode;
    this._resolve = null;
    this._validate = opts.validate || null;
    this.error.hidden = true;

    this.titleEl.textContent = opts.title || '';
    this.msg.innerHTML = opts.message || '';
    this.msg.hidden = !opts.message;

    if (mode === 'prompt') {
      this.field.hidden = false;
      this.labelEl.textContent = opts.label || '';
      this.input.value = opts.value || '';
      this.input.placeholder = opts.placeholder || '';
    } else {
      this.field.hidden = true;
    }

    this.confirmBtn.textContent = opts.confirmText || '确认';
    this.confirmBtn.className = opts.danger ? 'btn btn-danger' : 'btn btn-primary';
    this.confirmBtn.disabled = false;
    this.cancelBtn.hidden = mode === 'alert';
    this.cancelBtn.textContent = opts.cancelText || '取消';

    this.el.hidden = false;
    this.el.setAttribute('aria-hidden', 'false');

    if (mode === 'prompt') {
      this.input.focus();
      this.input.select();
    } else {
      this.confirmBtn.focus();
    }

    this._escHandler = e => { if (e.key === 'Escape') this._dismiss(); };
    document.addEventListener('keydown', this._escHandler);

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
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
    const resolve = this._resolve;
    this._resolve = null;
    if (resolve) resolve(result);
  },

  confirm(opts) { return this._open('confirm', opts); },
  prompt(opts)  { return this._open('prompt', opts);  },
  alert(opts)   { return this._open('alert', opts);   },
};
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
  dialogModal.init();
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
  if (currentUser) {
    const roleBadge = currentUser.role === 'admin' ? '' : ' <small style="color:var(--text-secondary);font-weight:400">(用户)</small>';
    userEl.innerHTML = currentUser.username + roleBadge;
  }

  // 根据角色显示/隐藏 admin-only 元素
  const adminEls = container.querySelectorAll('.admin-only');
  adminEls.forEach(el => { el.style.display = currentUser.role === 'admin' ? 'block' : 'none'; });

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
  setupFileFilter(container);
  loadTagsAndCategories(container);
  loadFiles(container);
  setupSkillModal();

  // 设置下拉菜单
  const settingsBtn = container.querySelector('#btn-settings');
  const settingsDropdown = container.querySelector('#settings-dropdown');
  const settingsMenu = container.querySelector('#settings-menu');

  if (settingsBtn && settingsDropdown) {
    settingsBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = settingsDropdown.classList.toggle('open');
      settingsBtn.setAttribute('aria-expanded', String(isOpen));
    });

    // 点击菜单项后关闭
    settingsDropdown.querySelector('#menu-item-skills').addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      openSkillsListModal();
    });
    settingsDropdown.querySelector('#menu-item-mcp').addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      openMcpConfigModal();
    });
    settingsDropdown.querySelector('#menu-item-tokens')?.addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      openTokensModal();
    });
    settingsDropdown.querySelector('#menu-item-password')?.addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      openPasswordModal();
    });
    settingsDropdown.querySelector('#menu-item-users')?.addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      openUsersModal();
    });
  }

  // 点击外部关闭下拉菜单
  document.addEventListener('click', e => {
    const dd = document.querySelector('#settings-dropdown');
    if (dd && dd.classList.contains('open') && !dd.contains(e.target)) {
      dd.classList.remove('open');
      const btn = dd.querySelector('#btn-settings');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  });
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
  const allowed = ['.html', '.htm', '.md', '.markdown', '.zip'];
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!allowed.includes(ext)) {
    toast('仅支持 HTML、Markdown 和 ZIP 文件', 'error');
    return;
  }
  const area = container.querySelector('#upload-area');
  const prevPointer = area.style.pointerEvents;
  area.style.pointerEvents = 'none';

  const progressEl = container.querySelector('#upload-progress');
  const progressBar = container.querySelector('#upload-progress-bar');
  const progressText = container.querySelector('#upload-progress-text');
  if (progressEl) progressEl.style.display = 'block';
  if (progressBar) progressBar.style.width = '0%';
  if (progressText) progressText.textContent = '0%';

  const fd = new FormData();
  fd.append('file', file);
  const isPublicEl = container.querySelector('#upload-is-public');
  fd.append('isPublic', isPublicEl && isPublicEl.checked ? 'true' : 'false');

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API_BASE + '/api/files/upload');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        if (progressBar) progressBar.style.width = pct + '%';
        if (progressText) progressText.textContent = pct + '%';
      }
    };
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}');
      if (xhr.status >= 200 && xhr.status < 300) {
        if (data.overwritten) {
          toast(`已更新为第 ${data.version} 版`);
        } else if (data.type === 'batch') {
          toast('批量上传成功，共 ' + data.count + ' 个文件');
        } else if (data.type === 'bundle') {
          toast('网站包上传成功');
        } else {
          toast('上传成功');
        }
        container.querySelector('#file-input').value = '';
        loadFiles(container);
      } else {
        toast(data.error || `HTTP ${xhr.status}`, 'error');
      }
      finish();
    };
    xhr.onerror = () => {
      toast('上传失败，请检查网络', 'error');
      finish();
    };
    function finish() {
      area.style.pointerEvents = prevPointer;
      if (progressBar) progressBar.style.width = '100%';
      setTimeout(() => {
        if (progressEl) progressEl.style.display = 'none';
      }, 400);
      resolve();
    }
    xhr.send(fd);
  });
}

async function loadFiles(container) {
  const list = container.querySelector('#file-list');
  const empty = container.querySelector('#empty-state');
  const count = container.querySelector('#file-count');

  list.setAttribute('aria-busy', 'true');
  list.classList.add('is-loading');
  list.innerHTML = buildSkeletonCards(5);
  empty.style.display = 'none';
  count.textContent = '';

  try {
    const data = await api('/api/files');
    list.classList.remove('is-loading');
    list.setAttribute('aria-busy', 'false');

    allFiles = data.files;
    applyFilters(container);
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

function applyFilters(container) {
  const list = container.querySelector('#file-list');
  const empty = container.querySelector('#empty-state');
  const count = container.querySelector('#file-count');

  let filtered = allFiles;

  if (filterState.filter === 'html') {
    filtered = filtered.filter(f => f.file_type === 'html');
  } else if (filterState.filter === 'markdown') {
    filtered = filtered.filter(f => f.file_type === 'markdown');
  } else if (filterState.filter === 'public') {
    filtered = filtered.filter(f => f.is_public === 1);
  } else if (filterState.filter === 'private') {
    filtered = filtered.filter(f => f.is_public === 0);
  } else if (filterState.filter === 'starred') {
    filtered = filtered.filter(f => f.starred === true);
  }

  if (filterState.tagId) {
    filtered = filtered.filter(f => f.tags && f.tags.some(t => t.id === filterState.tagId));
  }

  if (filterState.categoryId === 'uncategorized') {
    filtered = filtered.filter(f => !f.category_id);
  } else if (filterState.categoryId) {
    filtered = filtered.filter(f => f.category_id === filterState.categoryId);
  }

  if (filterState.query) {
    const q = filterState.query.toLowerCase();
    filtered = filtered.filter(f => f.original_name.toLowerCase().includes(q));
  }

  const hasFilter = filterState.query || filterState.filter !== 'all' || filterState.tagId || filterState.categoryId;
  count.textContent = hasFilter
    ? `${filtered.length} / ${allFiles.length} 个文件`
    : `共 ${allFiles.length} 个文件`;

  list.innerHTML = '';

  if (!filtered.length) {
    if (!allFiles.length) {
      empty.style.display = 'block';
      const cta = empty.querySelector('#empty-state-cta');
      if (cta && !cta.dataset.bound) {
        cta.dataset.bound = '1';
        cta.addEventListener('click', () => {
          const input = container.querySelector('#file-input');
          if (input) input.click();
        });
      }
    } else {
      empty.style.display = 'none';
      list.innerHTML = `
        <div class="empty-state" style="padding:32px 20px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:36px;height:36px;margin-bottom:8px;opacity:.4"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <p style="color:var(--text-secondary)">无匹配文件</p>
        </div>`;
    }
    return;
  }

  empty.style.display = 'none';
  renderFileList(container, list, filtered);
}

function renderFileList(container, list, files) {
  files.forEach(f => {
    const el = document.createElement('div');
    el.className = 'file-item';
    const size = formatSize(f.size);
    const timeStr = relativeTime(f.updated_at || f.created_at);
    const iconClass = f.is_bundle ? 'zip' : (f.file_type === 'markdown' ? 'md' : 'html');
    const iconText = f.is_bundle ? 'ZIP' : (f.file_type === 'markdown' ? 'MD' : 'HTML');
    const safeName = escapeHtml(f.original_name);
    const isPublic = !!f.is_public;
    const typeBadge = `<span class="file-badge file-badge-type">${iconText}</span>`;
    const privacyBadge = isPublic
      ? '<span class="file-badge file-badge-public">公开</span>'
      : '<span class="file-badge file-badge-private">私有</span>';
    const versionBadge = f.version_count > 0
      ? `<span class="file-badge file-badge-version">v${f.version_count + 1}</span>`
      : '';
    const tagBadges = (f.tags || []).map(t =>
      `<span class="file-badge file-badge-tag" data-tag-id="${t.id}">${escapeHtml(t.name)}</span>`
    ).join('');
    const categoryBadge = f.category_name
      ? `<span class="file-badge file-badge-category">${escapeHtml(f.category_name)}</span>`
      : '';

    el.innerHTML = `
      <div class="file-info" data-id="${f.id}" role="button" tabindex="0">
        <div class="file-icon ${iconClass}" aria-hidden="true">${iconText}</div>
        <div class="file-meta">
          <div class="file-name">${safeName}</div>
          <div class="file-subline">${typeBadge}${privacyBadge}${versionBadge}${tagBadges}${categoryBadge}<span class="file-detail">${size} · ${timeStr}</span></div>
        </div>
      </div>
      <div class="file-actions">
        <button type="button" class="btn btn-small btn-star ${f.starred ? 'starred' : ''}" data-id="${f.id}">${f.starred ? '★' : '☆'}</button>
        <button type="button" class="btn btn-small btn-copy-link" data-id="${f.id}">复制链接</button>
        <button type="button" class="btn btn-small btn-privacy" data-id="${f.id}" data-public="${isPublic}">${isPublic ? '设为私有' : '设为公开'}</button>
        <button type="button" class="btn btn-small btn-tags" data-id="${f.id}">标签</button>
        <button type="button" class="btn btn-small btn-category" data-id="${f.id}">分类</button>
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
    el.querySelector('.btn-copy-link').addEventListener('click', e => {
      e.stopPropagation();
      doCopyLink(f.share_key);
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
      doDelete(container, f.id, f.original_name);
    });
    el.querySelector('.btn-star').addEventListener('click', async e => {
      e.stopPropagation();
      await toggleStar(f.id, f.starred);
      loadFiles(container);
    });
    el.querySelectorAll('.file-badge-tag').forEach(badge => {
      badge.addEventListener('click', e => {
        e.stopPropagation();
        filterState.tagId = parseInt(badge.dataset.tagId);
        applyFilters(container);
        renderFilterDropdowns(container);
      });
    });
    el.querySelector('.btn-tags').addEventListener('click', e => {
      e.stopPropagation();
      openTagEditor(container, f.id, f.tags);
    });
    el.querySelector('.btn-category').addEventListener('click', e => {
      e.stopPropagation();
      openCategorySelect(container, f.id, f.category_id);
    });
    list.appendChild(el);
  });
}

function setupFileFilter(container) {
  const searchInput = container.querySelector('#search-input');
  const searchClear = container.querySelector('#search-clear');
  const chips = container.querySelectorAll('.filter-chip');

  searchInput.addEventListener('input', () => {
    filterState.query = searchInput.value.trim();
    searchClear.hidden = !filterState.query;
    applyFilters(container);
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      filterState.query = '';
      searchClear.hidden = true;
      searchInput.blur();
      applyFilters(container);
    }
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    filterState.query = '';
    searchClear.hidden = true;
    searchInput.focus();
    applyFilters(container);
  });

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filterState.filter = chip.dataset.filter;
      applyFilters(container);
    });
  });

  container.querySelectorAll('.filter-dropdown').forEach(dd => {
    const trigger = dd.querySelector('.filter-dropdown-trigger');
    if (trigger) {
      trigger.addEventListener('click', e => {
        e.stopPropagation();
        container.querySelectorAll('.filter-dropdown.open').forEach(d => { if (d !== dd) d.classList.remove('open'); });
        dd.classList.toggle('open');
      });
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      searchInput.focus();
    }
  });
}

async function doCopyLink(shareKey) {
  const url = `${location.origin}/s/${shareKey}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制');
  } catch (_) {
    try {
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      toast('链接已复制');
    } catch (e) {
      toast('复制失败，请手动复制链接', 'error');
    }
  }
}

async function doRename(container, id, currentName) {
  const name = await dialogModal.prompt({
    title: '重命名文件',
    label: '文件名',
    value: currentName,
    validate: v => {
      if (!v.trim()) return '文件名不能为空';
      if (/[\/\\]/.test(v)) return '文件名不能包含 / 或 \\';
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

// ---------- Version History ----------
let _versionPanelState = { fileId: null, versions: null, currentVer: 0 };

function loadVersions(container, fileId) {
  const body = container.querySelector('#version-panel-body');
  if (!body) return;
  body.innerHTML = '<div class="version-empty">加载中…</div>';

  api(`/api/files/${fileId}/versions`).then(data => {
    _versionPanelState.fileId = fileId;
    _versionPanelState.versions = data.versions || [];
    _versionPanelState.currentVer = (data.versions ? data.versions.length : 0) + 1;
    renderVersionList(container, data);

    const btn = container.querySelector('#btn-version-history');
    if (btn) btn.textContent = `历史 v${_versionPanelState.currentVer}`;
  }).catch(e => {
    body.innerHTML = `<div class="version-empty">加载失败: ${escapeHtml(e.message)}</div>`;
  });
}

function renderVersionList(container, data) {
  const body = container.querySelector('#version-panel-body');
  if (!body) return;

  const versions = data.versions || [];
  const currentSize = data.current ? formatSize(data.current.size) : '';
  const currentTime = data.current ? relativeTime(data.current.updated_at) : '';

  if (versions.length === 0) {
    body.innerHTML = `
      <div class="version-item version-item-current">
        <div class="version-item-row">
          <span class="version-item-dot"></span>
          <span class="version-item-label">当前 (v1)</span>
        </div>
        <div class="version-item-meta">${currentSize} · ${currentTime}</div>
      </div>
      <div class="version-empty">仅有当前版本</div>
    `;
    return;
  }

  let html = `
    <div class="version-item version-item-current">
      <div class="version-item-row">
        <span class="version-item-dot"></span>
        <span class="version-item-label">当前 (v${versions.length + 1})</span>
      </div>
      <div class="version-item-meta">${currentSize} · ${currentTime}</div>
    </div>
  `;

  versions.forEach(v => {
    const vSize = formatSize(v.size);
    const vTime = relativeTime(v.created_at);
    html += `
      <div class="version-item" data-version="${v.version}">
        <div class="version-item-row">
          <span class="version-item-dot"></span>
          <span class="version-item-label">v${v.version}</span>
        </div>
        <div class="version-item-meta">${vSize} · ${vTime}</div>
        <div class="version-item-actions">
          <button type="button" class="btn btn-small version-view" data-version="${v.version}">查看</button>
          <button type="button" class="btn btn-small version-restore" data-version="${v.version}">恢复</button>
          <button type="button" class="btn btn-small btn-danger version-delete" data-version="${v.version}">删除</button>
        </div>
      </div>
    `;
  });

  body.innerHTML = html;

  // bind events
  body.querySelectorAll('.version-view').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const ver = btn.dataset.version;
      const iframe = container.querySelector('#preview-iframe');
      if (iframe) iframe.src = API_BASE + `/api/files/${_versionPanelState.fileId}/versions/${ver}/render`;
      const source = container.querySelector('#preview-source');
      if (source) source.classList.remove('active');
      const iframeEl = container.querySelector('#preview-iframe');
      if (iframeEl) iframeEl.style.display = 'block';
      container.querySelectorAll('.view-toggle .btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === 'render');
      });
    });
  });

  body.querySelectorAll('.version-restore').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const ver = btn.dataset.version;
      const ok = await dialogModal.confirm({
        title: '恢复版本',
        message: `确定要恢复到 <strong>v${ver}</strong> 吗？当前版本将被保存为历史记录。`,
        confirmText: '恢复',
      });
      if (!ok) return;
      try {
        await api(`/api/files/${_versionPanelState.fileId}/versions/${ver}/restore`, { method: 'POST' });
        toast(`已恢复到 v${ver}`);
        loadVersions(container, _versionPanelState.fileId);
        const iframe = container.querySelector('#preview-iframe');
        if (iframe) iframe.src = API_BASE + `/api/files/${_versionPanelState.fileId}/render`;
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  body.querySelectorAll('.version-delete').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const ver = btn.dataset.version;
      const ok = await dialogModal.confirm({
        title: '删除版本',
        message: `确定要删除 <strong>v${ver}</strong> 吗？此操作不可撤销。`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/files/${_versionPanelState.fileId}/versions/${ver}`, { method: 'DELETE' });
        toast(`已删除 v${ver}`);
        loadVersions(container, _versionPanelState.fileId);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });
}

function openVersionPanel(container) {
  const panel = container.querySelector('#version-panel');
  if (!panel) return;
  panel.hidden = false;
  // trigger reflow then add class for animation
  panel.offsetHeight;
  panel.classList.add('open');
}

function closeVersionPanel(container) {
  const panel = container.querySelector('#version-panel');
  if (!panel) return;
  panel.classList.remove('open');
  setTimeout(() => { panel.hidden = true; }, 260);
}

function setupVersionUpload(container, fileId) {
  const btn = container.querySelector('#btn-upload-version');
  const input = container.querySelector('#version-file-input');
  if (!btn || !input) return;

  btn.addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    if (!input.files.length) return;
    const file = input.files[0];
    const allowed = ['.html', '.htm', '.md', '.markdown'];
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!allowed.includes(ext)) {
      toast('仅支持 HTML 和 Markdown 文件', 'error');
      input.value = '';
      return;
    }

    const fd = new FormData();
    fd.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', API_BASE + `/api/files/${fileId}/overwrite`);
    xhr.withCredentials = true;

    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}');
      if (xhr.status >= 200 && xhr.status < 300) {
        const ver = data.version || '?';
        toast(`已更新为第 ${ver} 版`);
        const iframe = container.querySelector('#preview-iframe');
        if (iframe) iframe.src = API_BASE + `/api/files/${fileId}/render`;
        // refresh source view
        api(`/api/files/${fileId}/content`).then(cdata => {
          const code = container.querySelector('#source-code');
          if (code) code.textContent = cdata.content;
        }).catch(() => {});
        loadVersions(container, fileId);
      } else {
        toast(data.error || `HTTP ${xhr.status}`, 'error');
      }
      input.value = '';
    };
    xhr.onerror = () => {
      toast('上传失败，请检查网络', 'error');
      input.value = '';
    };
    xhr.send(fd);
  });
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
  const spinner = container.querySelector('#preview-spinner');
  const toggles = container.querySelectorAll('.view-toggle .btn');

  iframe.addEventListener('load', () => {
    if (spinner) spinner.style.display = 'none';
  });

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

  // Version history panel
  const versionHistoryBtn = container.querySelector('#btn-version-history');
  const closeVersionBtn = container.querySelector('#btn-close-version-panel');
  const versionPanel = container.querySelector('#version-panel');

  setupVersionUpload(container, id);

  versionHistoryBtn.addEventListener('click', () => {
    if (versionPanel && !versionPanel.hidden && versionPanel.classList.contains('open')) {
      closeVersionPanel(container);
    } else {
      loadVersions(container, id);
      openVersionPanel(container);
    }
  });

  if (closeVersionBtn) {
    closeVersionBtn.addEventListener('click', () => closeVersionPanel(container));
  }

  // Escape key closes version panel
  document.addEventListener('keydown', function versionEscHandler(e) {
    if (e.key === 'Escape' && versionPanel && !versionPanel.hidden && versionPanel.classList.contains('open')) {
      closeVersionPanel(container);
    }
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
    if (spinner) spinner.style.display = 'flex';
    iframe.src = API_BASE + `/api/files/${id}/render`;
  }).catch(e => {
    toast(e.message, 'error');
    navigate('/');
  });
}

// ---------- Skeleton Helper ----------
function buildSkeletonCards(n) {
  let html = '';
  for (let i = 0; i < n; i++) {
    html += '<div class="skeleton-item" aria-hidden="true">'
      + '<div class="skeleton-icon"></div>'
      + '<div class="skeleton-lines">'
      + '<div class="skeleton-line skeleton-w60"></div>'
      + '<div class="skeleton-line skeleton-w40"></div>'
      + '</div></div>';
  }
  return html;
}

// ---------- Utils ----------
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function relativeTime(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return '';
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return new Date(dateStr).toLocaleDateString('zh-CN');
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
    const installBox = document.getElementById('skill-install-rendered');
    const installHeading = document.getElementById('skill-install-heading');
    if (skill.installHtml || (skill.installBody && skill.installBody.trim())) {
      installHeading.style.display = '';
      installBox.innerHTML = skill.installHtml || renderMarkdown(skill.installBody);
    } else {
      installHeading.style.display = 'none';
      installBox.innerHTML = '';
    }
    const modal = document.getElementById('skill-modal');
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  }).catch(e => toast(e.message, 'error'));
}

function renderMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(escapeHtml(lines[i]));
        i++;
      }
      i++;
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length + 2;
      out.push(`<h${level}>${inlineMd(escapeHtml(h[2]))}</h${level}>`);
      i++;
      continue;
    }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) {
      const items = [];
      while (i < lines.length && lines[i].match(/^[-*]\s+/)) {
        items.push(`<li>${inlineMd(escapeHtml(lines[i].replace(/^[-*]\s+/, '')))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    const ol = line.match(/^(\d+)\.\s+(.*)$/);
    if (ol) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
        items.push(`<li>${inlineMd(escapeHtml(lines[i].replace(/^\d+\.\s+/, '')))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() !== ''
           && !lines[i].match(/^(#{1,4}\s|[-*]\s|\d+\.\s|```)/)) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineMd(escapeHtml(para.join(' ')))}</p>`);
  }
  return out.join('');
}

function inlineMd(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<code>$1</code>');
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

// ---------- MCP Config Modal ----------
function openMcpConfigModal() {
  const modal = document.getElementById('mcp-config-modal');
  if (!modal) return;

  // 绑定关闭事件
  if (!modal.dataset.bound) {
    modal.dataset.bound = '1';
    modal.querySelector('#mcp-config-close').addEventListener('click', closeMcpConfigModal);
    modal.querySelector('#mcp-config-dismiss').addEventListener('click', closeMcpConfigModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeMcpConfigModal(); });
  }

  // 加载配置
  const statusEl = document.getElementById('mcp-status');
  const detailEl = document.getElementById('mcp-detail');
  statusEl.innerHTML = '<p style="color:var(--text-secondary)">加载中…</p>';
  detailEl.innerHTML = '';

  api('/api/mcp/config').then(data => {
    if (data.enabled) {
      statusEl.innerHTML = `
        <div class="mcp-status-badge mcp-status-on">
          <span class="mcp-status-dot"></span> MCP 已启用
        </div>
        <div class="mcp-info-row">
          <span class="mcp-label">Endpoint</span>
          <code class="mcp-value">${escapeHtml(data.url)}</code>
        </div>
        <div class="mcp-info-row">
          <span class="mcp-label">Token</span>
          <code class="mcp-value">${escapeHtml(data.token)}</code>
        </div>
      `;
      const configJson = JSON.stringify(data.config, null, 2);
      detailEl.innerHTML = `
        <h3>客户端配置</h3>
        <p class="mcp-config-hint">将以下配置合并到 Claude Code 的 <code>.mcp.json</code> 或 Claude Desktop 的配置文件中：</p>
        <p class="mcp-config-hint">请根据实际部署环境调整 URL。</p>
        <div class="mcp-config-block">
          <button type="button" class="btn btn-small mcp-copy-btn" id="mcp-copy-config">复制</button>
          <pre class="mcp-config-code"><code>${escapeHtml(configJson)}</code></pre>
        </div>
      `;
      const copyBtn = document.getElementById('mcp-copy-config');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(configJson).then(() => {
            toast('已复制到剪贴板');
            copyBtn.textContent = '已复制';
            setTimeout(() => { copyBtn.textContent = '复制'; }, 2000);
          }).catch(() => toast('复制失败', 'error'));
        });
      }
    } else {
      statusEl.innerHTML = `
        <div class="mcp-status-badge mcp-status-off">
          <span class="mcp-status-dot"></span> MCP 未启用
        </div>
        <p class="mcp-config-hint">设置环境变量 <code>MCP_TOKEN</code> 后重启服务即可启用 MCP 端点。</p>
        <div class="mcp-config-block">
          <pre class="mcp-config-code"><code>MCP_TOKEN=your-secret-token npm start</code></pre>
        </div>
      `;
    }
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  }).catch(e => {
    statusEl.innerHTML = `<p style="color:var(--danger)">加载失败: ${escapeHtml(e.message)}</p>`;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  });
}

function closeMcpConfigModal() {
  const modal = document.getElementById('mcp-config-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

// ---------- Skills List Modal ----------
function openSkillsListModal() {
  const modal = document.getElementById('skills-list-modal');
  if (!modal) return;

  // 绑定关闭事件
  if (!modal.dataset.bound) {
    modal.dataset.bound = '1';
    modal.querySelector('#skills-list-close').addEventListener('click', closeSkillsListModal);
    modal.querySelector('#skills-list-dismiss').addEventListener('click', closeSkillsListModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeSkillsListModal(); });
  }

  // 加载 skills
  loadSkillsForModal();
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
}

function closeSkillsListModal() {
  const modal = document.getElementById('skills-list-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

function loadSkillsForModal() {
  const list = document.getElementById('skills-list');
  const empty = document.getElementById('skills-empty');
  if (!list) return;
  list.setAttribute('aria-busy', 'true');
  list.classList.add('is-loading');
  list.innerHTML = buildSkeletonCards(5);
  empty.style.display = 'none';
  api('/api/skills').then(data => {
    list.classList.remove('is-loading');
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = '';
    if (!data.skills.length) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
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
      el.querySelector('.skill-view').addEventListener('click', () => {
        closeSkillsListModal();
        openSkillModal(s.name);
      });
      el.querySelector('.skill-download').addEventListener('click', () => downloadSkill(s.name));
      list.appendChild(el);
    });
  }).catch(e => {
    list.classList.remove('is-loading');
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = '';
    if (e.status === 401) {
      currentUser = null;
      navigate('/');
      return;
    }
    toast(e.message, 'error');
  });
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// --- 用户管理弹窗 ---
function openUsersModal() {
  const modal = document.getElementById('users-modal');
  modal.hidden = false;
  loadUsersList();
  modal.querySelector('#users-modal-close').onclick = () => { modal.hidden = true; };
  modal.querySelector('#users-modal-dismiss').onclick = () => { modal.hidden = true; };
  modal.querySelector('#btn-create-user').onclick = () => createUserDialog();
  modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
}

async function loadUsersList() {
  const wrap = document.getElementById('users-table-wrap');
  try {
    const data = await api('/api/users');
    const users = data.users || [];
    wrap.innerHTML = '<table class="users-table"><thead><tr><th>ID</th><th>用户名</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' +
      users.map(u => `<tr>
        <td>${u.id}</td>
        <td>${esc(u.username)}</td>
        <td><span class="role-badge role-${u.role}">${u.role === 'admin' ? '管理员' : '用户'}</span></td>
        <td>${formatDate(u.created_at)}</td>
        <td class="users-actions">
          <button class="btn btn-small" onclick="editUserDialog(${u.id},'${esc(u.username)}','${u.role}')">编辑</button>
          ${u.id !== currentUser.id ? `<button class="btn btn-small btn-danger-outline" onclick="deleteUserConfirm(${u.id},'${esc(u.username)}')">删除</button>` : ''}
        </td></tr>`).join('') +
      '</tbody></table>';
  } catch (e) {
    wrap.innerHTML = '<p class="login-error">加载失败: ' + esc(e.message) + '</p>';
  }
}

async function createUserDialog() {
  const username = await dialogModal.prompt({ title: '创建用户', label: '用户名', placeholder: '输入用户名' });
  if (!username) return;
  const password = await dialogModal.prompt({ title: '创建用户', label: '密码（至少 8 位）', placeholder: '输入密码' });
  if (!password || password.length < 8) { if (password) toast('密码至少 8 位', 'error'); return; }
  const role = await dialogModal.prompt({ title: '创建用户', label: '角色 (admin/user)', value: 'user' });
  if (!role) return;
  try {
    await api('/api/users', { method: 'POST', body: { username, password, role: role || 'user' } });
    toast('用户已创建');
    loadUsersList();
  } catch (e) { toast(e.message, 'error'); }
}

async function editUserDialog(id, username, role) {
  const changeRole = await dialogModal.confirm({ title: '编辑用户: ' + username, message: '选择操作', confirmText: '修改角色', cancelText: '重置密码' });
  if (changeRole) {
    const newRole = await dialogModal.prompt({ title: '修改角色', label: '新角色 (admin/user)', value: role });
    if (!newRole) return;
    try {
      await api('/api/users/' + id, { method: 'PUT', body: { role: newRole } });
      toast('角色已更新');
      loadUsersList();
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

async function deleteUserConfirm(id, username) {
  if (!confirm('确定删除用户 ' + username + '？其文件将转交给管理员。')) return;
  try {
    await api('/api/users/' + id, { method: 'DELETE' });
    toast('用户已删除');
    loadUsersList();
  } catch (e) { toast(e.message, 'error'); }
}

// --- API 令牌弹窗 ---
function openTokensModal() {
  const modal = document.getElementById('tokens-modal');
  modal.hidden = false;
  loadTokensList();
  modal.querySelector('#tokens-modal-close').onclick = () => { modal.hidden = true; };
  modal.querySelector('#tokens-modal-dismiss').onclick = () => { modal.hidden = true; };
  modal.querySelector('#btn-create-token').onclick = () => createTokenDialog();
  modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
}

async function loadTokensList() {
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
      <button class="btn btn-small btn-danger-outline" onclick="deleteTokenConfirm(${t.id},'${esc(t.name)}')">删除</button>
    </div>`).join('');
  } catch (e) {
    listEl.innerHTML = '<p class="login-error">加载失败: ' + esc(e.message) + '</p>';
  }
}

async function createTokenDialog() {
  const name = await dialogModal.prompt({ title: '创建令牌', label: '令牌名称', placeholder: '例如: My CI Token' });
  if (!name) return;
  try {
    const data = await api('/api/tokens', { method: 'POST', body: { name } });
    await dialogModal.alert({ title: '令牌已创建', message: '请立即复制以下令牌，关闭后无法再次查看：\n\n' + esc(data.token) });
    loadTokensList();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteTokenConfirm(id, name) {
  if (!confirm('确定删除令牌 "' + name + '"？使用此令牌的应用将失去访问权限。')) return;
  try {
    await api('/api/tokens/' + id, { method: 'DELETE' });
    toast('令牌已删除');
    loadTokensList();
  } catch (e) { toast(e.message, 'error'); }
}

// --- 修改密码弹窗 ---
function openPasswordModal() {
  const modal = document.getElementById('password-modal');
  modal.hidden = false;
  modal.querySelector('#current-password').value = '';
  modal.querySelector('#new-password').value = '';
  modal.querySelector('#confirm-password').value = '';
  const errorEl = modal.querySelector('#password-error');
  errorEl.hidden = true;

  modal.querySelector('#password-modal-close').onclick = () => { modal.hidden = true; };
  modal.querySelector('#password-modal-cancel').onclick = () => { modal.hidden = true; };
  modal.querySelector('#password-modal-submit').onclick = async () => {
    const currentPwd = modal.querySelector('#current-password').value;
    const newPwd = modal.querySelector('#new-password').value;
    const confirmPwd = modal.querySelector('#confirm-password').value;
    if (!currentPwd || !newPwd) { errorEl.textContent = '请填写当前密码和新密码'; errorEl.hidden = false; return; }
    if (newPwd.length < 8) { errorEl.textContent = '新密码至少 8 位'; errorEl.hidden = false; return; }
    if (newPwd !== confirmPwd) { errorEl.textContent = '两次输入的新密码不一致'; errorEl.hidden = false; return; }
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { currentPassword: currentPwd, newPassword: newPwd } });
      toast('密码已修改');
      modal.hidden = true;
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.hidden = false;
    }
  };
  modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
}

// --- 辅助 ---
function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---------- Tags & Categories ----------
async function loadTagsAndCategories(container) {
  try {
    const [tagData, catData] = await Promise.all([api('/api/tags'), api('/api/categories')]);
    allTags = tagData.tags || [];
    allCategories = catData.categories || [];
    renderFilterDropdowns(container);
  } catch (e) { /* ignore */ }
}

function renderFilterDropdowns(container) {
  const tagMenu = container.querySelector('#tag-filter-menu');
  if (tagMenu) {
    let html = '<button type="button" class="filter-dropdown-item" data-tag-id="">全部标签</button>';
    allTags.forEach(t => {
      html += `<button type="button" class="filter-dropdown-item${filterState.tagId === t.id ? ' active' : ''}" data-tag-id="${t.id}">${escapeHtml(t.name)} (${t.file_count})</button>`;
    });
    tagMenu.innerHTML = html;
    tagMenu.querySelectorAll('.filter-dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        filterState.tagId = item.dataset.tagId ? parseInt(item.dataset.tagId) : null;
        const dd = container.querySelector('#tag-filter-dropdown');
        if (dd) dd.classList.remove('open');
        applyFilters(container);
        renderFilterDropdowns(container);
      });
    });
  }
  const catMenu = container.querySelector('#category-filter-menu');
  if (catMenu) {
    let html = '<button type="button" class="filter-dropdown-item" data-category-id="">全部分类</button>';
    html += '<button type="button" class="filter-dropdown-item" data-category-id="uncategorized">未分类</button>';
    allCategories.forEach(c => {
      html += `<button type="button" class="filter-dropdown-item${filterState.categoryId === c.id ? ' active' : ''}" data-category-id="${c.id}">${escapeHtml(c.name)} (${c.file_count})</button>`;
    });
    catMenu.innerHTML = html;
    catMenu.querySelectorAll('.filter-dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        const val = item.dataset.categoryId;
        filterState.categoryId = val === '' ? null : (val === 'uncategorized' ? 'uncategorized' : parseInt(val));
        const dd = container.querySelector('#category-filter-dropdown');
        if (dd) dd.classList.remove('open');
        applyFilters(container);
        renderFilterDropdowns(container);
      });
    });
  }
}

async function toggleStar(fileId, currentStarred) {
  try {
    if (currentStarred) {
      await api(`/api/files/${fileId}/star`, { method: 'DELETE' });
      toast('已取消收藏');
    } else {
      await api(`/api/files/${fileId}/star`, { method: 'POST' });
      toast('已收藏');
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

function openTagEditor(container, fileId, currentTags) {
  const modal = document.getElementById('tag-editor-modal');
  if (!modal) return;
  const input = document.getElementById('tag-editor-input');
  const selected = document.getElementById('tag-editor-selected');
  const suggestions = document.getElementById('tag-editor-suggestions');

  let selectedTags = [...(currentTags || [])];

  function renderSelected() {
    selected.innerHTML = selectedTags.map(t =>
      `<span class="tag-editor-chip" data-tag-id="${t.id}">${escapeHtml(t.name)}<span class="tag-editor-chip-remove">&times;</span></span>`
    ).join('');
    selected.querySelectorAll('.tag-editor-chip-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const chip = btn.closest('.tag-editor-chip');
        const id = parseInt(chip.dataset.tagId);
        selectedTags = selectedTags.filter(t => t.id !== id);
        renderSelected();
      });
    });
  }
  renderSelected();

  input.value = '';
  suggestions.innerHTML = '';
  suggestions.classList.remove('visible');

  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { suggestions.classList.remove('visible'); suggestions.innerHTML = ''; return; }
    const existing = allTags.filter(t => t.name.toLowerCase().includes(q) && !selectedTags.some(s => s.id === t.id));
    if (existing.length) {
      suggestions.innerHTML = existing.map(t => `<li data-tag-id="${t.id}" data-tag-name="${escapeHtml(t.name)}">${escapeHtml(t.name)}</li>`).join('') +
        `<li class="tag-create-new" data-new-name="${escapeHtml(input.value.trim())}">+ 创建 "${escapeHtml(input.value.trim())}"</li>`;
    } else {
      suggestions.innerHTML = `<li class="tag-create-new" data-new-name="${escapeHtml(input.value.trim())}">+ 创建 "${escapeHtml(input.value.trim())}"</li>`;
    }
    suggestions.classList.add('visible');
    suggestions.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => {
        if (li.dataset.tagId) {
          const tag = allTags.find(t => t.id === parseInt(li.dataset.tagId));
          if (tag && !selectedTags.some(s => s.id === tag.id)) {
            selectedTags.push({ id: tag.id, name: tag.name });
          }
        } else if (li.dataset.newName) {
          const name = li.dataset.newName;
          if (!selectedTags.some(t => t.name.toLowerCase() === name.toLowerCase())) {
            selectedTags.push({ id: null, name });
          }
        }
        input.value = '';
        suggestions.classList.remove('visible');
        renderSelected();
      });
    });
  };

  input.onkeydown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      if (!selectedTags.some(t => t.name.toLowerCase() === name.toLowerCase())) {
        const existing = allTags.find(t => t.name.toLowerCase() === name.toLowerCase());
        if (existing) {
          selectedTags.push({ id: existing.id, name: existing.name });
        } else {
          selectedTags.push({ id: null, name });
        }
      }
      input.value = '';
      suggestions.classList.remove('visible');
      renderSelected();
    }
  };

  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  input.focus();

  const closeHandler = () => closeTagEditor();
  document.getElementById('tag-editor-cancel').onclick = closeHandler;
  document.getElementById('tag-editor-close').onclick = closeHandler;
  modal.onclick = e => { if (e.target === modal) closeHandler(); };

  document.getElementById('tag-editor-save').onclick = async () => {
    try {
      const tagIds = [];
      for (const t of selectedTags) {
        if (t.id) {
          tagIds.push(t.id);
        } else {
          const created = await api('/api/tags', { method: 'POST', body: { name: t.name } });
          tagIds.push(created.id);
        }
      }
      await api(`/api/files/${fileId}/tags`, { method: 'PUT', body: { tagIds } });
      toast('标签已更新');
      closeTagEditor();
      loadTagsAndCategories(document.querySelector('#app'));
      loadFiles(container);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

function closeTagEditor() {
  const modal = document.getElementById('tag-editor-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

function openCategorySelect(container, fileId, currentCategoryId) {
  const modal = document.getElementById('category-select-modal');
  if (!modal) return;
  const list = document.getElementById('category-select-list');

  let html = `<div class="category-list-item${!currentCategoryId ? ' selected' : ''}" data-category-id="">
    <span>未分类</span>
  </div>`;
  allCategories.forEach(c => {
    html += `<div class="category-list-item${currentCategoryId === c.id ? ' selected' : ''}" data-category-id="${c.id}">
      <span>${escapeHtml(c.name)}</span>
      <div class="category-item-actions">
        <button type="button" class="btn btn-small category-rename" data-id="${c.id}" data-name="${escapeHtml(c.name)}">重命名</button>
        <button type="button" class="btn btn-small btn-danger category-delete" data-id="${c.id}">删除</button>
      </div>
    </div>`;
  });
  list.innerHTML = html;

  list.querySelectorAll('.category-list-item').forEach(item => {
    item.addEventListener('click', async e => {
      if (e.target.closest('.category-rename') || e.target.closest('.category-delete')) return;
      const val = item.dataset.categoryId;
      try {
        await api(`/api/files/${fileId}/category`, { method: 'PUT', body: { categoryId: val ? parseInt(val) : null } });
        toast('分类已更新');
        closeCategorySelect();
        loadTagsAndCategories(document.querySelector('#app'));
        loadFiles(container);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  list.querySelectorAll('.category-rename').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const name = await dialogModal.prompt({
        title: '重命名分类',
        label: '分类名',
        value: btn.dataset.name,
        validate: v => !v.trim() ? '分类名不能为空' : null,
      });
      if (!name) return;
      try {
        await api(`/api/categories/${btn.dataset.id}`, { method: 'PUT', body: { name } });
        toast('分类已重命名');
        await loadTagsAndCategories(document.querySelector('#app'));
        openCategorySelect(container, fileId, currentCategoryId);
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  list.querySelectorAll('.category-delete').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const ok = await dialogModal.confirm({
        title: '删除分类',
        message: '确定要删除该分类吗？文件将变为未分类。',
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/categories/${btn.dataset.id}`, { method: 'DELETE' });
        toast('分类已删除');
        await loadTagsAndCategories(document.querySelector('#app'));
        openCategorySelect(container, fileId, null);
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  document.getElementById('category-select-create').onclick = async () => {
    const name = await dialogModal.prompt({
      title: '新建分类',
      label: '分类名',
      placeholder: '输入分类名称',
      validate: v => !v.trim() ? '分类名不能为空' : null,
    });
    if (!name) return;
    try {
      await api('/api/categories', { method: 'POST', body: { name } });
      toast('分类已创建');
      await loadTagsAndCategories(document.querySelector('#app'));
      openCategorySelect(container, fileId, currentCategoryId);
    } catch (e) { toast(e.message, 'error'); }
  };

  const closeHandler = () => closeCategorySelect();
  document.getElementById('category-select-cancel').onclick = closeHandler;
  document.getElementById('category-select-close').onclick = closeHandler;
  modal.onclick = e => { if (e.target === modal) closeHandler(); };

  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
}

function closeCategorySelect() {
  const modal = document.getElementById('category-select-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}
