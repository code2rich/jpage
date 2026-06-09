// 首页：文件列表、上传、筛选、批量操作、标签/分类管理、Skills/MCP/用户/令牌弹窗

import { api, API_BASE } from '../api.js';
import { toast } from '../components/toast.js';
import { dialogModal } from '../components/dialog.js';
import { escapeHtml, formatSize, relativeTime, esc, buildSkeletonCards, formatDate } from '../utils.js';
import { state, navigate } from '../app.js';

// ---------- 模块级状态 ----------
let allFiles = [];
let pagination = { page: 1, limit: 20, total: 0, totalPages: 1 };
let filterState = { query: '', filter: 'all', tagId: null, categoryId: null };
let allTags = [];
let allCategories = [];
let selectedFileIds = new Set();
let lastCheckedIndex = -1;
let skillModalCurrent = null;
let allTemplates = [];
let searchResults = null;

// ---------- Home Page ----------
function renderHome(container) {
  const tmpl = document.getElementById('home-template');
  container.innerHTML = '';
  container.appendChild(tmpl.content.cloneNode(true));

  const userEl = container.querySelector('#header-user');
  if (state.currentUser) {
    const roleBadge = state.currentUser.role === 'admin' ? '' : ' <small style="color:var(--text-secondary);font-weight:400">(用户)</small>';
    userEl.innerHTML = state.currentUser.username + roleBadge;
  }

  // 根据角色显示/隐藏 admin-only 元素
  const adminEls = container.querySelectorAll('.admin-only');
  adminEls.forEach(el => { el.style.display = state.currentUser.role === 'admin' ? 'block' : 'none'; });

  const logoutBtn = container.querySelector('#btn-logout');
  logoutBtn.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (_) {}
    state.currentUser = null;
    toast('已退出');
    navigate('/');
  });

  setupUpload(container);
  setupFileFilter(container);
  loadTagsAndCategories(container);
  loadFiles(container);
  setupSkillModal();

  // 批量操作工具栏事件
  const batchToolbar = container.querySelector('#batch-toolbar');
  if (batchToolbar) {
    batchToolbar.querySelector('#batch-delete').addEventListener('click', async () => {
      const count = selectedFileIds.size;
      const ok = await dialogModal.confirm({
        title: '确认批量删除',
        message: `确定删除 <strong>${count}</strong> 个文件吗？此操作不可撤销。`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      doBatchAction(container, 'delete');
    });
    batchToolbar.querySelector('#batch-set-public').addEventListener('click', () => {
      doBatchAction(container, 'setPublic');
    });
    batchToolbar.querySelector('#batch-set-private').addEventListener('click', () => {
      doBatchAction(container, 'setPrivate');
    });
    const categorySelect = batchToolbar.querySelector('#batch-category-select');
    if (categorySelect) {
      // 填充分类选项
      const updateCategoryOptions = () => {
        categorySelect.innerHTML = '<option value="">移动到分类…</option><option value="0">未分类</option>';
        allCategories.forEach(c => {
          categorySelect.innerHTML += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
        });
      };
      updateCategoryOptions();
      categorySelect.addEventListener('change', () => {
        const val = categorySelect.value;
        if (!val) return;
        doBatchAction(container, 'setCategory', { categoryId: parseInt(val) });
        categorySelect.value = '';
      });
    }
    batchToolbar.querySelector('#batch-cancel').addEventListener('click', () => {
      clearSelection(container);
    });
  }

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
    settingsDropdown.querySelector('#menu-item-backup')?.addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      openBackupModal();
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

// ---------- Upload ----------
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

// ---------- File List ----------
async function loadFiles(container, page) {
  const list = container.querySelector('#file-list');
  const empty = container.querySelector('#empty-state');
  const countEl = container.querySelector('#file-count');

  if (page) pagination.page = page;

  list.setAttribute('aria-busy', 'true');
  list.classList.add('is-loading');
  list.innerHTML = buildSkeletonCards(Math.min(pagination.limit, 5));
  empty.style.display = 'none';
  countEl.textContent = '';

  try {
    let data;
    if (filterState.query) {
      const params = new URLSearchParams({ q: filterState.query, page: pagination.page, limit: pagination.limit });
      data = await api('/api/files/search?' + params.toString());
      searchResults = data.files;
      allFiles = data.files;
    } else {
      searchResults = null;
      const params = new URLSearchParams({ page: pagination.page, limit: pagination.limit });
      if (filterState.categoryId) params.set('category', filterState.categoryId);
      if (filterState.tagId) params.set('tag', filterState.tagId);
      data = await api('/api/files?' + params.toString());
      allFiles = data.files;
    }

    list.classList.remove('is-loading');
    list.setAttribute('aria-busy', 'false');

    pagination = data.pagination;
    applyFilters(container);
  } catch (e) {
    list.classList.remove('is-loading');
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = '';
    if (e.status === 401) {
      state.currentUser = null;
      navigate('/');
      return;
    }
    toast(e.message, 'error');
  }
}

function applyFilters(container) {
  const list = container.querySelector('#file-list');
  const empty = container.querySelector('#empty-state');
  const countEl = container.querySelector('#file-count');

  let filtered = searchResults || allFiles;

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

  const hasFilter = filterState.query || filterState.filter !== 'all' || filterState.tagId || filterState.categoryId;
  countEl.textContent = hasFilter
    ? `${filtered.length} / ${pagination.total} 个文件`
    : `共 ${pagination.total} 个文件`;

  list.innerHTML = '';

  if (!filtered.length) {
    if (!allFiles.length && pagination.total === 0) {
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
    renderPagination(container);
    return;
  }

  empty.style.display = 'none';
  renderFileList(container, list, filtered);
  renderPagination(container);
}

// ---------- Batch Selection ----------
function updateBatchToolbar(container) {
  const toolbar = container.querySelector('#batch-toolbar');
  if (!toolbar) return;
  const count = selectedFileIds.size;
  toolbar.hidden = count === 0;
  const deleteBtn = toolbar.querySelector('#batch-delete');
  if (deleteBtn) deleteBtn.textContent = `删除（${count}）`;
}

function toggleFileCheckbox(fileId, el, isChecked) {
  if (isChecked) {
    selectedFileIds.add(fileId);
    el.classList.add('selected');
  } else {
    selectedFileIds.delete(fileId);
    el.classList.remove('selected');
  }
  updateBatchToolbar(el.closest('[id="app"]') || document.getElementById('app'));
}

function clearSelection(container) {
  selectedFileIds.clear();
  lastCheckedIndex = -1;
  container.querySelectorAll('.file-checkbox').forEach(cb => {
    cb.checked = false;
    cb.closest('.file-item').classList.remove('selected');
  });
  const selectAll = container.querySelector('#select-all-checkbox');
  if (selectAll) selectAll.checked = false;
  updateBatchToolbar(container);
}

async function doBatchAction(container, action, data) {
  try {
    const ids = Array.from(selectedFileIds);
    const result = await api('/api/files/batch', {
      method: 'POST',
      body: { action, ids, data }
    });
    toast(`操作成功，影响 ${result.affected} 个文件`);
    clearSelection(container);
    loadFiles(container);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderFileList(container, list, files) {
  const selectAllCb = container.querySelector('#select-all-checkbox');
  if (selectAllCb) {
    selectAllCb.checked = false;
    selectAllCb.onchange = () => {
      const checked = selectAllCb.checked;
      files.forEach(f => {
        const cb = list.querySelector(`.file-checkbox[data-id="${f.id}"]`);
        if (cb) {
          cb.checked = checked;
          toggleFileCheckbox(f.id, cb.closest('.file-item'), checked);
        }
      });
    };
  }

  files.forEach((f, index) => {
    const el = document.createElement('div');
    el.className = 'file-item';
    el.dataset.fileId = f.id;
    if (selectedFileIds.has(f.id)) el.classList.add('selected');
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
    const viewBadge = (f.view_count > 0) ? `<span class="file-badge file-badge-views">👁 ${f.view_count}</span>` : '';
    const snippetHtml = f.snippet ? `<div class="file-snippet">${f.snippet}</div>` : '';

    el.innerHTML = `
      <label class="file-checkbox-wrap">
        <input type="checkbox" class="file-checkbox" data-id="${f.id}" data-index="${index}">
        <span class="file-checkbox-visual"></span>
      </label>
      <div class="file-info" data-id="${f.id}" role="button" tabindex="0">
        <div class="file-icon ${iconClass}" aria-hidden="true">${iconText}</div>
        <div class="file-meta">
          <div class="file-name">${safeName}</div>
          ${snippetHtml}
          <div class="file-subline">${typeBadge}${privacyBadge}${versionBadge}${tagBadges}${categoryBadge}${viewBadge}<span class="file-detail">${size} · ${timeStr}</span></div>
        </div>
      </div>
      <div class="file-actions">
        <button type="button" class="btn btn-small btn-star ${f.starred ? 'starred' : ''}" data-id="${f.id}">${f.starred ? '★' : '☆'}</button>
        <button type="button" class="btn btn-small btn-copy-link" data-id="${f.id}">复制链接</button>
        <button type="button" class="btn btn-small btn-privacy" data-id="${f.id}" data-public="${isPublic}">${isPublic ? '设为私有' : '设为公开'}</button>
        <button type="button" class="btn btn-small btn-tags" data-id="${f.id}">标签</button>
        <button type="button" class="btn btn-small btn-category" data-id="${f.id}">分类</button>
        ${f.file_type === 'markdown' ? `<button type="button" class="btn btn-small btn-template" data-id="${f.id}">模板</button>` : ''}
        <button type="button" class="btn btn-small btn-rename" data-id="${f.id}">重命名</button>
        <button type="button" class="btn btn-small btn-danger btn-delete" data-id="${f.id}">删除</button>
      </div>
    `;

    // checkbox 事件（含 Shift 连选）
    const cb = el.querySelector('.file-checkbox');
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', e => {
      if (e.shiftKey && lastCheckedIndex >= 0) {
        const start = Math.min(lastCheckedIndex, index);
        const end = Math.max(lastCheckedIndex, index);
        for (let i = start; i <= end; i++) {
          const targetCb = list.querySelector(`.file-checkbox[data-index="${i}"]`);
          if (targetCb) {
            targetCb.checked = cb.checked;
            toggleFileCheckbox(parseInt(targetCb.dataset.id), targetCb.closest('.file-item'), cb.checked);
          }
        }
      } else {
        toggleFileCheckbox(f.id, el, cb.checked);
      }
      if (cb.checked) lastCheckedIndex = index;
    });

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
        renderFilterDropdowns(container);
        loadFiles(container, 1);
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
    const btnTpl = el.querySelector('.btn-template');
    if (btnTpl) {
      btnTpl.addEventListener('click', e => {
        e.stopPropagation();
        openTemplateSelect(container, f.id, f.template_id);
      });
    }
    list.appendChild(el);
  });
}

function renderPagination(container) {
  let wrap = container.querySelector('#pagination');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'pagination';
    wrap.className = 'pagination';
    container.querySelector('#file-list').after(wrap);
  }
  wrap.innerHTML = '';

  if (pagination.totalPages <= 1) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';

  const { page, totalPages } = pagination;

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'pagination-btn';
  prevBtn.textContent = '上一页';
  prevBtn.disabled = page <= 1;
  prevBtn.addEventListener('click', () => loadFiles(container, page - 1));
  wrap.appendChild(prevBtn);

  const pageNumbers = buildPageNumbers(page, totalPages);
  pageNumbers.forEach(p => {
    if (p === '...') {
      const span = document.createElement('span');
      span.className = 'pagination-ellipsis';
      span.textContent = '...';
      wrap.appendChild(span);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pagination-btn' + (p === page ? ' active' : '');
      btn.textContent = p;
      btn.addEventListener('click', () => loadFiles(container, p));
      wrap.appendChild(btn);
    }
  });

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'pagination-btn';
  nextBtn.textContent = '下一页';
  nextBtn.disabled = page >= totalPages;
  nextBtn.addEventListener('click', () => loadFiles(container, page + 1));
  wrap.appendChild(nextBtn);
}

function buildPageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [];
  if (current <= 4) {
    for (let i = 1; i <= 5; i++) pages.push(i);
    pages.push('...', total);
  } else if (current >= total - 3) {
    pages.push(1, '...');
    for (let i = total - 4; i <= total; i++) pages.push(i);
  } else {
    pages.push(1, '...', current - 1, current, current + 1, '...', total);
  }
  return pages;
}

function setupFileFilter(container) {
  const searchInput = container.querySelector('#search-input');
  const searchClear = container.querySelector('#search-clear');
  const chips = container.querySelectorAll('.filter-chip');
  let searchTimer;

  searchInput.addEventListener('input', () => {
    filterState.query = searchInput.value.trim();
    searchClear.hidden = !filterState.query;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadFiles(container, 1), 300);
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      filterState.query = '';
      searchClear.hidden = true;
      searchInput.blur();
      clearTimeout(searchTimer);
      loadFiles(container, 1);
    }
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    filterState.query = '';
    searchClear.hidden = true;
    searchInput.focus();
    clearTimeout(searchTimer);
    loadFiles(container, 1);
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

// ---------- Skills ----------
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
        ${data.globalToken ? `<div class="mcp-info-row">
          <span class="mcp-label">全局 Token</span>
          <code class="mcp-value">${escapeHtml(data.globalToken)}</code>
        </div>` : ''}
        ${data.tokens && data.tokens.length > 0 ? `<div class="mcp-info-row">
          <span class="mcp-label">用户 Token</span>
          <code class="mcp-value">${data.tokens.map(t => esc(t.token_prefix) + '…').join(', ')}</code>
        </div>` : ''}
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
      state.currentUser = null;
      navigate('/');
      return;
    }
    toast(e.message, 'error');
  });
}

// ---------- 用户管理弹窗 ----------
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
          ${u.id !== state.currentUser.id ? `<button class="btn btn-small btn-danger-outline" onclick="deleteUserConfirm(${u.id},'${esc(u.username)}')">删除</button>` : ''}
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

// 需要挂到 window 上因为 users table 用了 inline onclick
window.editUserDialog = async function(id, username, role) {
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
};

window.deleteUserConfirm = async function(id, username) {
  if (!confirm('确定删除用户 ' + username + '？其文件将转交给管理员。')) return;
  try {
    await api('/api/users/' + id, { method: 'DELETE' });
    toast('用户已删除');
    loadUsersList();
  } catch (e) { toast(e.message, 'error'); }
};

// ---------- API 令牌弹窗 ----------
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

window.deleteTokenConfirm = async function(id, name) {
  if (!confirm('确定删除令牌 "' + name + '"？使用此令牌的应用将失去访问权限。')) return;
  try {
    await api('/api/tokens/' + id, { method: 'DELETE' });
    toast('令牌已删除');
    loadTokensList();
  } catch (e) { toast(e.message, 'error'); }
};

// ---------- 修改密码弹窗 ----------
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

// ---------- 数据管理弹窗 ----------
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function openBackupModal() {
  const modal = document.getElementById('backup-modal');
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  const statsEl = modal.querySelector('#backup-stats');
  statsEl.innerHTML = '<p style="color:var(--text-secondary)">加载中...</p>';

  try {
    const stats = await api('/api/admin/stats');
    statsEl.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;font-size:14px">' +
      '<span style="color:var(--text-secondary)">文件数量</span><span>' + stats.fileCount + '</span>' +
      '<span style="color:var(--text-secondary)">数据库大小</span><span>' + formatBytes(stats.dbSize) + '</span>' +
      '<span style="color:var(--text-secondary)">上传文件大小</span><span>' + formatBytes(stats.uploadsSize) + '</span>' +
      '<span style="color:var(--text-secondary)">总大小</span><span style="font-weight:600">' + formatBytes(stats.totalSize) + '</span>' +
      '</div>';
  } catch (e) {
    statsEl.innerHTML = '<p class="login-error">加载统计失败: ' + esc(e.message) + '</p>';
  }

  const closeModal = () => { modal.hidden = true; modal.setAttribute('aria-hidden', 'true'); };
  modal.querySelector('#backup-modal-close').onclick = closeModal;
  modal.querySelector('#backup-modal-dismiss').onclick = closeModal;
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  modal.querySelector('#btn-export-backup').onclick = () => {
    window.location.href = '/api/admin/export';
    toast('备份下载已开始');
  };

  const fileInput = modal.querySelector('#import-file-input');
  modal.querySelector('#btn-import-backup').onclick = () => { fileInput.click(); };
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileInput.value = '';

    const ok = await dialogModal.confirm({
      title: '警告：数据恢复',
      message: '导入将<strong style="color:var(--danger)">覆盖当前所有数据</strong>，此操作不可撤销！<br><br>当前数据会先备份到 data-backup-* 目录。',
      confirmText: '我已了解风险，继续',
      danger: true
    });
    if (!ok) return;

    const confirmText = await dialogModal.prompt({
      title: '二次确认',
      label: '请输入 CONFIRM 以确认导入',
      placeholder: 'CONFIRM',
      validate: (v) => v !== 'CONFIRM' ? '请输入 CONFIRM 以确认' : null
    });
    if (confirmText !== 'CONFIRM') return;

    const formData = new FormData();
    formData.append('file', file);
    try {
      const resp = await fetch('/api/admin/import', { method: 'POST', body: formData, credentials: 'same-origin' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '导入失败');
      await dialogModal.alert({ title: '导入成功', message: data.message });
      window.location.reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
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
        renderFilterDropdowns(container);
        loadFiles(container, 1);
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
        renderFilterDropdowns(container);
        loadFiles(container, 1);
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

// --- 模板选择（首页） ---
async function openTemplateSelect(container, fileId, currentTemplateId) {
  const modal = document.getElementById('template-select-modal');
  if (!modal) return;
  const list = document.getElementById('template-select-list');
  list.innerHTML = '<div class="loading">加载中…</div>';
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');

  try {
    const res = await authFetch('/api/templates');
    const data = await res.json();
    allTemplates = data.templates || [];
  } catch (e) {
    list.innerHTML = '<div class="empty-state">加载失败</div>';
    return;
  }

  list.innerHTML = allTemplates.map(t => `
    <div class="category-item ${t.id === currentTemplateId || (!currentTemplateId && t.name === 'default') ? 'selected' : ''}" data-tpl-id="${t.id}">
      <span class="category-name">${t.description || t.name}</span>
    </div>
  `).join('');

  list.querySelectorAll('.category-item').forEach(item => {
    item.addEventListener('click', async () => {
      const tplId = parseInt(item.dataset.tplId);
      try {
        await authFetch(`/api/files/${fileId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateId: tplId === allTemplates.find(t => t.name === 'default').id ? null : tplId })
        });
      } catch (e) { /* ignore */ }
      closeTemplateSelect();
      renderHome(container);
    });
  });

  document.getElementById('template-select-close').onclick = closeTemplateSelect;
  document.getElementById('template-select-cancel').onclick = closeTemplateSelect;
}

function closeTemplateSelect() {
  const modal = document.getElementById('template-select-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

export { renderHome, closeTemplateSelect };
