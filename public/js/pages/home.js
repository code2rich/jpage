// 首页：文件列表、上传、筛选、批量操作、标签/分类管理、Skills/MCP/用户/令牌弹窗

import { api, API_BASE } from '../api.js';
import { toast } from '../components/toast.js';
import { dialogModal } from '../components/dialog.js';
import { escapeHtml, formatSize, relativeTime, esc, buildSkeletonCards, openModal, closeModal, copyToClipboard } from '../utils.js';
import { state, navigate } from '../app.js';
import { openShareSettings } from './share-settings.js';
import { openUsersModal } from '../components/users-modal.js';
import { openTokensModal } from '../components/tokens-modal.js';

// ---------- 模块级状态 ----------
let allFiles = [];
let pagination = { page: 1, limit: 20, total: 0, totalPages: 1 };
const filterState = { query: '', filter: 'all', tagId: null, categoryId: null };
let allTags = [];
let allCategories = [];
const selectedFileIds = new Set();
let lastCheckedIndex = -1;
let skillModalCurrent = null;
let searchResults = null;

// ---------- 视图模式（列表 / 卡片） ----------
const FILE_VIEW_KEY = 'jpage-file-view';
let viewMode = (() => { try { return localStorage.getItem(FILE_VIEW_KEY) === 'card' ? 'card' : 'list'; } catch { return 'list'; } })();
function setViewMode(mode) {
  viewMode = mode;
  try { localStorage.setItem(FILE_VIEW_KEY, mode); } catch {}
}

// 上传来源徽章文案映射（后端 upload_source: web/cli/mcp）
const UPLOAD_SOURCE_LABELS = { web: '网页', cli: 'CLI', mcp: 'MCP' };
function sourceBadge(source) {
  const label = UPLOAD_SOURCE_LABELS[source];
  return label ? `<span class="file-badge file-badge-source" title="上传方式">${label}</span>` : '';
}
function uploaderBadge(name) {
  return name ? `<span class="file-badge file-badge-uploader" title="上传者">👤 ${escapeHtml(name)}</span>` : '';
}

// 卡片缩略图懒加载管线（镜像 content-templates.js 的 thumbObserver：rootMargin 预加载 + 最多 3 并发）
// 注意：不能用 file-id Set 去重——翻页/筛选时 list.innerHTML='' 会销毁并重建卡片 DOM，
// 新卡片是全新元素，必须重新挂 iframe（会命中浏览器/渲染缓存，开销小）。
// 去重改为按「该卡片是否已有 iframe」判断，避免切回已访问过的页时缩略图卡在灰色占位。
let cardThumbObserver = null;
let cardThumbActive = 0;
const CARD_THUMB_MAX = 3;
const cardThumbQueue = [];
function ensureCardThumbObserver() {
  if (cardThumbObserver) return cardThumbObserver;
  cardThumbObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const card = entry.target;
      cardThumbObserver.unobserve(card);
      enqueueCardThumb(card);
    });
  }, { rootMargin: '200px' });
  return cardThumbObserver;
}
function enqueueCardThumb(card) {
  if (cardThumbActive < CARD_THUMB_MAX) {
    cardThumbActive++;
    loadCardThumb(card).finally(() => {
      cardThumbActive--;
      if (cardThumbQueue.length) enqueueCardThumb(cardThumbQueue.shift());
    });
  } else {
    cardThumbQueue.push(card);
  }
}
// iframe.src 直接指向已有的 /api/files/:id/render —— HTML / Markdown / ZIP bundle 入口页均可渲染；
// 同源 iframe 默认携带 session cookie，用户自己的私有文件也能正常加载（loadFileWithPrivacy 放行 uploaded_by === userId）。
function loadCardThumb(card) {
  const thumb = card.querySelector('.file-card-thumb');
  // 已有 iframe（正在加载或已加载）则跳过，防止同一卡片重复挂载
  if (!thumb || thumb.querySelector('.file-card-thumb-iframe')) return Promise.resolve();
  // 注意：不加 loading="lazy" —— 懒加载已由上面的 IntersectionObserver 负责。
  // 浏览器对 lazy iframe 的判定依赖 iframe 的显式 width/height，而本卡片 iframe 只有 CSS 尺寸，
  // 导致首屏卡片也被判定为"折叠以下"而延迟拉取 /render，iframe 的 load 事件迟迟不触发，
  // .file-card-thumb-loading 灰色脉冲占位一直盖在上面（用户报告的"卡片首次打开渲染异常"）。
  thumb.innerHTML = '<div class="file-card-thumb-wrap"><iframe class="file-card-thumb-iframe" title="预览"></iframe></div>';
  const wrap = thumb.querySelector('.file-card-thumb-wrap');
  const iframe = thumb.querySelector('.file-card-thumb-iframe');
  let timer = null;
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      wrap.classList.add('loaded');
      resolve();
    };
    // 兜底超时：即使 load 事件因任何原因未触发（如缓存/被中断），8s 后也揭开占位，避免永久卡灰
    timer = setTimeout(finish, 8000);
    iframe.addEventListener('load', finish, { once: true });
    iframe.addEventListener('error', finish, { once: true });
    iframe.src = API_BASE + '/api/files/' + card.dataset.fileId + '/render';
  });
}

// ---------- Home Page ----------
function renderHome(container) {
  const tmpl = document.getElementById('home-template');
  container.innerHTML = '';
  container.appendChild(tmpl.content.cloneNode(true));

  const userEl = container.querySelector('#header-user');
  if (state.currentUser) {
    const roleBadge = state.currentUser.role === 'admin' ? '' : ' <small style="color:var(--text-secondary);font-weight:400">(用户)</small>';
    userEl.innerHTML = escapeHtml(state.currentUser.username) + roleBadge;
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
    location.hash = '#/';
    location.reload();
  });

  // 邮箱验证提示条
  const verifyBanner = container.querySelector('#email-verify-banner');
  const resendBtn = container.querySelector('#btn-resend-verify');
  if (verifyBanner && state.currentUser && !state.currentUser.emailVerified) {
    api('/api/auth/smtp-status').then(data => {
      if (data.configured) verifyBanner.hidden = false;
    }).catch(() => {});
    if (resendBtn) {
      resendBtn.addEventListener('click', async () => {
        resendBtn.disabled = true;
        try {
          await api('/api/auth/resend-verification', { method: 'POST' });
          toast('验证邮件已发送');
          let remain = 60;
          resendBtn.textContent = remain + 's';
          const t = setInterval(() => {
            remain--;
            if (remain <= 0) { clearInterval(t); resendBtn.disabled = false; resendBtn.textContent = '重新发送验证邮件'; }
            else resendBtn.textContent = remain + 's';
          }, 1000);
        } catch (e) {
          toast(e.message || '发送失败');
          resendBtn.disabled = false;
        }
      });
    }
  }

  setupUpload(container);
  setupFileFilter(container);
  setupViewToggle(container);
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
        categorySelect.innerHTML = '<option value="" disabled selected>移动到分类…</option><option value="0">未分类</option>';
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
      if (isOpen) {
        const firstItem = settingsMenu.querySelector('.settings-menu-item');
        if (firstItem) firstItem.focus();
      }
    });

    // 点击菜单项后关闭
    settingsDropdown.querySelector('#menu-item-skills').addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      openSkillsListModal();
    });
    settingsDropdown.querySelector('#menu-item-content-templates').addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      navigate('/market');
    });
    settingsDropdown.querySelector('#menu-item-mcp').addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      openMcpConfigModal();
    });
    settingsDropdown.querySelector('#menu-item-cli').addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      openCliConfigModal();
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
    settingsDropdown.querySelector('#menu-item-profile')?.addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      openProfileModal();
    });
    settingsDropdown.querySelector('#menu-item-market-admin')?.addEventListener('click', () => {
      settingsDropdown.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      navigate('/market/admin');
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
      if (btn) {
        btn.setAttribute('aria-expanded', 'false');
        btn.focus();
      }
    }
    // 关闭文件项更多菜单
    document.querySelectorAll('.file-more-dropdown.open').forEach(d => {
      if (!d.contains(e.target)) {
        d.classList.remove('open');
        const t = d.querySelector('.file-more-trigger');
        if (t) t.setAttribute('aria-expanded', 'false');
      }
    });
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
          const failed = Array.isArray(data.failed) ? data.failed : [];
          if (failed.length > 0) {
            // 有失败项：弹窗列出每个文件的成功/失败明细
            const rows = failed.map(f =>
              `<li class="batch-result-item batch-result-fail">
                <span class="batch-result-name">${escapeHtml(f.name)}</span>
                <span class="batch-result-error">${escapeHtml(f.error || '失败')}</span>
              </li>`
            ).join('');
            dialogModal.alert({
              title: '批量上传完成',
              message: `<p>成功 ${data.count} 个，失败 ${failed.length} 个。</p>
                        <ul class="batch-result-list">${rows}</ul>`,
              confirmText: '知道了',
            });
          } else {
            toast('批量上传成功，共 ' + data.count + ' 个文件');
          }
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
  list.innerHTML = buildSkeletonCards(Math.min(pagination.limit, 5), viewMode);
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
  if (viewMode === 'card') {
    renderCardList(container, list, files);
    return;
  }
  list.classList.remove('view-card'); // 列表视图，恢复单列布局
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
          <div class="file-subline">${typeBadge}${privacyBadge}${versionBadge}${tagBadges}${categoryBadge}${viewBadge}${sourceBadge(f.upload_source)}${uploaderBadge(f.uploader_name)}<span class="file-detail">${size} · ${timeStr}</span></div>
        </div>
      </div>
      <div class="file-actions">
        <button type="button" class="btn btn-small btn-star ${f.starred ? 'starred' : ''}" data-id="${f.id}">${f.starred ? '★' : '☆'}</button>
        <button type="button" class="btn btn-small btn-copy-link" data-id="${f.id}" title="复制链接" aria-label="复制链接"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
        <div class="file-more-dropdown">
          <button type="button" class="btn btn-small file-more-trigger" title="更多操作">⋯</button>
          <div class="file-more-menu">
            <button type="button" class="file-more-item btn-privacy" data-id="${f.id}" data-public="${isPublic}">${isPublic ? '设为私有' : '设为公开'}</button>
            <button type="button" class="file-more-item btn-share-settings" data-id="${f.id}">分享设置</button>
            <button type="button" class="file-more-item btn-tags" data-id="${f.id}">编辑标签</button>
            <button type="button" class="file-more-item btn-category" data-id="${f.id}">移动分类</button>
            ${!f.is_bundle ? `<button type="button" class="file-more-item btn-publish-market" data-id="${f.id}">上架到市场</button>` : ''}
            ${f.file_type === 'markdown' ? `<button type="button" class="file-more-item btn-template" data-id="${f.id}">切换模板</button>` : ''}
            <button type="button" class="file-more-item btn-rename" data-id="${f.id}">重命名</button>
            <button type="button" class="file-more-item btn-download" data-id="${f.id}">下载</button>
            <hr class="file-more-divider">
            <button type="button" class="file-more-item file-more-danger btn-delete" data-id="${f.id}">删除</button>
          </div>
        </div>
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
    // 更多菜单展开/收起
    const moreDropdown = el.querySelector('.file-more-dropdown');
    const moreTrigger = el.querySelector('.file-more-trigger');
    moreTrigger.addEventListener('click', e => {
      e.stopPropagation();
      // 关闭其他已打开的菜单
      document.querySelectorAll('.file-more-dropdown.open').forEach(d => {
        if (d !== moreDropdown) {
          d.classList.remove('open');
          const t = d.querySelector('.file-more-trigger');
          if (t) t.setAttribute('aria-expanded', 'false');
        }
      });
      const isOpen = moreDropdown.classList.toggle('open');
      moreTrigger.setAttribute('aria-expanded', String(isOpen));
    });

    el.querySelector('.btn-privacy').addEventListener('click', e => {
      e.stopPropagation();
      moreDropdown.classList.remove('open');
      doSetPrivacy(container, f.id, isPublic);
    });
    el.querySelector('.btn-share-settings').addEventListener('click', e => {
      e.stopPropagation();
      moreDropdown.classList.remove('open');
      openShareSettings(f.id, f, () => loadFiles(container));
    });
    el.querySelector('.btn-rename').addEventListener('click', e => {
      e.stopPropagation();
      moreDropdown.classList.remove('open');
      doRename(container, f.id, f.original_name);
    });
    el.querySelector('.btn-download').addEventListener('click', e => {
      e.stopPropagation();
      moreDropdown.classList.remove('open');
      window.open(API_BASE + '/api/files/' + f.id + '/download', '_blank');
    });
    el.querySelector('.btn-delete').addEventListener('click', e => {
      e.stopPropagation();
      moreDropdown.classList.remove('open');
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
      moreDropdown.classList.remove('open');
      openTagEditor(container, f.id, f.tags);
    });
    el.querySelector('.btn-category').addEventListener('click', e => {
      e.stopPropagation();
      moreDropdown.classList.remove('open');
      openCategorySelect(container, f.id, f.category_id);
    });
    const btnPubMarket = el.querySelector(".btn-publish-market");
    if (btnPubMarket) {
      btnPubMarket.addEventListener("click", e => {
        e.stopPropagation();
        moreDropdown.classList.remove("open");
        openPublishMarket(container, f.id, f);
      });
    }
    const btnTpl = el.querySelector('.btn-template');
    if (btnTpl) {
      btnTpl.addEventListener('click', e => {
        e.stopPropagation();
        moreDropdown.classList.remove('open');
        openTemplateSelect(container, f.id, f.template_id);
      });
    }
    list.appendChild(el);
  });
}

// 卡片视图：每张卡片含一个实时 iframe 缩略图（懒加载）+ 文件名 + 标签 + 状态。
function renderCardList(container, list, files) {
  // 切换容器为网格布局
  list.classList.add('view-card');
  // 卡片视图不支持全选（空间小），隐藏表头的全选 checkbox
  const selectAllCb = container.querySelector('#select-all-checkbox');
  if (selectAllCb) selectAllCb.checked = false;
  const observer = ensureCardThumbObserver();

  files.forEach((f) => {
    const el = document.createElement('div');
    el.className = 'file-card';
    el.dataset.fileId = f.id;
    if (selectedFileIds.has(f.id)) el.classList.add('selected');
    const safeName = escapeHtml(f.original_name);
    const isPublic = !!f.is_public;
    const iconText = f.is_bundle ? 'ZIP' : (f.file_type === 'markdown' ? 'MD' : 'HTML');
    const privacyBadge = isPublic
      ? '<span class="file-badge file-badge-public">公开</span>'
      : '<span class="file-badge file-badge-private">私有</span>';
    const versionBadge = f.version_count > 0
      ? `<span class="file-badge file-badge-version">v${f.version_count + 1}</span>` : '';
    const tagBadges = (f.tags || []).slice(0, 3).map(t =>
      `<span class="file-badge file-badge-tag" data-tag-id="${t.id}">${escapeHtml(t.name)}</span>`).join('');
    const size = formatSize(f.size);
    const timeStr = relativeTime(f.updated_at || f.created_at);

    el.innerHTML = `
      <div class="file-card-thumb" aria-hidden="true">
        <div class="file-card-thumb-loading"></div>
      </div>
      <button type="button" class="file-card-icon-btn file-card-star ${f.starred ? 'starred' : ''}" data-id="${f.id}" aria-label="收藏" title="收藏">${f.starred ? '★' : '☆'}</button>
      <button type="button" class="file-card-icon-btn file-card-copy" data-id="${f.id}" aria-label="复制链接" title="复制链接"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
      <div class="file-card-name" title="${safeName}">${safeName}</div>
      <div class="file-card-badges"><span class="file-badge file-badge-type">${iconText}</span>${privacyBadge}${versionBadge}${tagBadges}${sourceBadge(f.upload_source)}${uploaderBadge(f.uploader_name)}</div>
      <div class="file-card-footer"><span>${size}</span><span>${timeStr}</span></div>
    `;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `打开 ${f.original_name}`);

    // 整张卡片点击 → 预览（星标按钮单独拦截）
    const openPreview = () => navigate('/view/' + f.id);
    el.addEventListener('click', openPreview);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(); } });
    el.querySelector('.file-card-star').addEventListener('click', async e => {
      e.stopPropagation();
      await toggleStar(f.id, f.starred);
      loadFiles(container);
    });
    el.querySelector('.file-card-copy').addEventListener('click', e => {
      e.stopPropagation();
      doCopyLink(f.share_key);
    });
    el.querySelectorAll('.file-badge-tag').forEach(badge => {
      badge.addEventListener('click', e => {
        e.stopPropagation();
        filterState.tagId = parseInt(badge.dataset.tagId);
        renderFilterDropdowns(container);
        loadFiles(container, 1);
      });
    });

    // 注册懒加载：卡片滚到可视区附近才挂 iframe
    observer.observe(el);
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

function setupViewToggle(container) {
  const buttons = container.querySelectorAll('.view-toggle-btn');
  const selectAllWrap = container.querySelector('.select-all-wrap'); // 卡片视图无单卡 checkbox，隐藏全选
  const syncAllSelect = () => { if (selectAllWrap) selectAllWrap.hidden = (viewMode === 'card'); };
  // 根据 viewMode 同步按钮的 active 态（首次进入 / 刷新后恢复持久化选择）
  buttons.forEach(b => b.classList.toggle('active', b.dataset.view === viewMode));
  syncAllSelect();
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (viewMode === btn.dataset.view) return;
      // 切换前断开旧 observer，避免卡片 DOM 已销毁仍持有引用造成泄漏
      if (cardThumbObserver) { cardThumbObserver.disconnect(); }
      cardThumbQueue.length = 0;
      cardThumbActive = 0;
      setViewMode(btn.dataset.view);
      buttons.forEach(b => b.classList.toggle('active', b === btn));
      syncAllSelect();
      applyFilters(container); // 复用现有重渲染流，重建列表/卡片
    });
  });
}

function setupFileFilter(container) {
  const searchInput = container.querySelector('#search-input');
  const searchClear = container.querySelector('#search-clear');
  const searchKbd = container.querySelector('#search-kbd');
  const chips = container.querySelectorAll('.filter-chip');
  let searchTimer;

  searchInput.addEventListener('input', () => {
    filterState.query = searchInput.value.trim();
    searchClear.hidden = !filterState.query;
    if (searchKbd) searchKbd.style.display = filterState.query ? 'none' : '';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadFiles(container, 1), 300);
  });

  searchInput.addEventListener('focus', () => {
    if (searchKbd) searchKbd.style.display = 'none';
  });

  searchInput.addEventListener('blur', () => {
    if (searchKbd && !filterState.query) searchKbd.style.display = '';
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      filterState.query = '';
      searchClear.hidden = true;
      if (searchKbd) searchKbd.style.display = '';
      searchInput.blur();
      clearTimeout(searchTimer);
      loadFiles(container, 1);
    }
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    filterState.query = '';
    searchClear.hidden = true;
    if (searchKbd) searchKbd.style.display = '';
    searchInput.focus();
    clearTimeout(searchTimer);
    loadFiles(container, 1);
  });

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filterState.filter = chip.dataset.filter;
      if (chip.dataset.filter === 'all') {
        filterState.tagId = null;
        filterState.categoryId = null;
      }
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
      if (/[/\\]/.test(v)) return '文件名不能包含 / 或 \\';
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
      // 多 MCP 客户端 Tab：共用同一份标准 JSON，差异仅在目标文件路径/说明文字。
      // CLI 不在此弹窗内——它走独立的「CLI 工具」菜单 + /api/cli/guide。
      const configs = (data.configs && data.configs.length > 0)
        ? data.configs
        : [{ id: 'generic', label: '通用', path: '', config: data.config }];
      let activeConfigJson = JSON.stringify(configs[0].config, null, 2);
      detailEl.innerHTML = `
        <h3>客户端配置</h3>
        <p class="mcp-config-hint">选择客户端，复制配置粘贴到对应文件中。请根据实际部署环境调整 URL。</p>
        <div class="mcp-tabs" role="tablist">
          ${configs.map((c, i) => `
            <button type="button" class="mcp-tab${i === 0 ? ' active' : ''}" role="tab"
                    data-idx="${i}" id="mcp-tab-${escapeHtml(c.id)}">${escapeHtml(c.label)}</button>
          `).join('')}
        </div>
        <p class="mcp-config-hint mcp-config-path"><code></code></p>
        <div class="mcp-config-block">
          <button type="button" class="btn btn-small mcp-copy-btn" id="mcp-copy-config">复制</button>
          <pre class="mcp-config-code"><code>${escapeHtml(activeConfigJson)}</code></pre>
        </div>
      `;
      const codeEl = detailEl.querySelector('.mcp-config-code code');
      const pathEl = detailEl.querySelector('.mcp-config-path code');
      const setConfig = (idx) => {
        const c = configs[idx];
        if (!c) return;
        // MCP 客户端 tab：显示 JSON
        activeConfigJson = JSON.stringify(c.config, null, 2);
        codeEl.textContent = activeConfigJson;
        pathEl.textContent = c.path || '';
        detailEl.querySelectorAll('.mcp-tab').forEach((t, i) => {
          t.classList.toggle('active', i === idx);
        });
      };
      setConfig(0);
      detailEl.querySelectorAll('.mcp-tab').forEach((t, i) => {
        t.addEventListener('click', () => setConfig(i));
      });
      const copyBtn = document.getElementById('mcp-copy-config');
      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          // PR #9：navigator.clipboard 优先，不支持/失败时回退 execCommand（copyToClipboard）
          const ok = await copyToClipboard(activeConfigJson);
          if (ok) {
            toast('已复制到剪贴板');
            copyBtn.textContent = '已复制';
            setTimeout(() => { copyBtn.textContent = '复制'; }, 2000);
          } else {
            toast('复制失败', 'error');
          }
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

// ---------- CLI Config Modal ----------
// CLI 与 MCP 是并列的两个客户端入口，各自独立弹窗。这里只渲染 CLI 用法文档。
function openCliConfigModal() {
  const modal = document.getElementById('cli-config-modal');
  if (!modal) return;

  if (!modal.dataset.bound) {
    modal.dataset.bound = '1';
    modal.querySelector('#cli-config-close').addEventListener('click', closeCliConfigModal);
    modal.querySelector('#cli-config-dismiss').addEventListener('click', closeCliConfigModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeCliConfigModal(); });
  }

  const detailEl = document.getElementById('cli-detail');
  detailEl.textContent = '加载中…';

  api('/api/cli/guide').then(data => {
    // 渲染富文本用法文档；缓存纯文本供「复制文档」按钮使用
    detailEl.innerHTML = data.guideHtml || '<p>（无文档）</p>';
    const copyBtn = document.getElementById('cli-copy-guide');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        const ok = await copyToClipboard(data.guideText || '');
        if (ok) {
          toast('已复制到剪贴板');
          copyBtn.textContent = '已复制';
          setTimeout(() => { copyBtn.textContent = '复制文档'; }, 2000);
        } else {
          toast('复制失败', 'error');
        }
      };
    }
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  }).catch(e => {
    detailEl.innerHTML = `<p style="color:var(--danger)">加载失败: ${escapeHtml(e.message)}</p>`;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  });
}

function closeCliConfigModal() {
  const modal = document.getElementById('cli-config-modal');
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

// 用户管理、API 令牌管理已抽至 components/users-modal.js 和 components/tokens-modal.js

// ---------- 修改密码弹窗 ----------
function openPasswordModal() {
  const modal = document.getElementById('password-modal');
  openModal(modal);
  modal.querySelector('#current-password').value = '';
  modal.querySelector('#new-password').value = '';
  modal.querySelector('#confirm-password').value = '';
  const errorEl = modal.querySelector('#password-error');
  errorEl.hidden = true;

  modal.querySelector('#password-modal-close').onclick = () => { closeModal(modal); };
  modal.querySelector('#password-modal-cancel').onclick = () => { closeModal(modal); };
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
      closeModal(modal);
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.hidden = false;
    }
  };
  if (!modal.dataset.bound) { modal.dataset.bound = '1'; modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal); }); }
}

// ---------- 个人资料弹窗 ----------
function openProfileModal() {
  const modal = document.getElementById('profile-modal');
  openModal(modal);
  const u = state.currentUser || {};
  modal.querySelector('#profile-username').value = u.username || '';
  modal.querySelector('#profile-email').value = u.email || '';
  const errorEl = modal.querySelector('#profile-error');
  errorEl.hidden = true;

  modal.querySelector('#profile-modal-close').onclick = () => { closeModal(modal); };
  modal.querySelector('#profile-modal-cancel').onclick = () => { closeModal(modal); };
  modal.querySelector('#profile-modal-submit').onclick = async () => {
    const username = modal.querySelector('#profile-username').value.trim();
    const email = modal.querySelector('#profile-email').value.trim();
    errorEl.hidden = true;
    if (!username) { errorEl.textContent = '用户名不能为空'; errorEl.hidden = false; return; }
    try {
      const body = { username };
      if (email !== (u.email || '')) body.email = email || '';
      const data = await api('/api/auth/profile', { method: 'POST', body });
      // 更新本地状态
      if (data.username) state.currentUser.username = data.username;
      state.currentUser.email = data.email || null;
      state.currentUser.emailVerified = data.emailVerified;
      // 更新 header 显示
      const headerUser = document.getElementById('header-user');
      if (headerUser) headerUser.textContent = data.username || u.username;
      toast('资料已更新');
      closeModal(modal);
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.hidden = false;
    }
  };
  if (!modal.dataset.bound) {
    modal.dataset.bound = '1';
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal); });
  }
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

  const hideModal = () => { closeModal(modal); };
  modal.querySelector('#backup-modal-close').onclick = hideModal;
  modal.querySelector('#backup-modal-dismiss').onclick = hideModal;
  if (!modal.dataset.bound) { modal.dataset.bound = '1'; modal.addEventListener('click', e => { if (e.target === modal) hideModal(); }); }

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


// 上架文件到内容市场：快照文件当前内容，填关键信息后提交审核。
// 一文件一模板：同文件再次进入=编辑现有模板+重新审核。
async function openPublishMarket(container, fileId, file) {
  // 拉取当前上架状态 + 市场分类
  let status, cats;
  try {
    [status, cats] = await Promise.all([
      api(`/api/content-templates/by-file/${fileId}`),
      api('/api/content-templates/categories').catch(() => ({ categories: [] })),
    ]);
  } catch (e) {
    return toast(e.message || '加载失败', 'error');
  }
  const categories = cats.categories || [];
  const isPublished = status.published;
  const action = isPublished ? '更新并重新审核' : '提交审核';

  const STATUS_LABEL = {
    draft: '草稿', pending: '审核中', approved: '已通过',
    rejected: '已拒绝', archived: '已归档',
  };

  // 动态构建模态 DOM（不依赖 index.html 静态结构，规避并发修改）
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.hidden = false;
  backdrop.setAttribute('aria-hidden', 'false');
  backdrop.innerHTML = `
    <div class="modal-panel modal-panel-sm">
      <div class="modal-header">
        <h2>${isPublished ? '市场设置' : '上架到市场'}</h2>
        <button type="button" class="btn btn-small modal-close" id="pub-close" aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <p class="pub-source">源文件：<strong>${escapeHtml(file.original_name)}</strong></p>
        ${isPublished ? `<p class="pub-current">当前状态：${escapeHtml(STATUS_LABEL[status.status] || status.status)}${status.status === 'rejected' && status.review_note ? '（' + escapeHtml(status.review_note) + '）' : ''}</p>` : ''}
        <div class="market-form-row">
          <label class="market-form-label">标题 *</label>
          <input type="text" id="pub-title" class="market-input" value="${escapeHtml(status.title || file.original_name)}">
        </div>
        <div class="market-form-row">
          <label class="market-form-label">分类 *</label>
          <select id="pub-category" class="market-select">
            <option value="">请选择分类</option>
            ${categories.map(c => `<option value="${c.id}" ${status.categoryId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="market-form-row">
          <label class="market-form-label">描述</label>
          <textarea id="pub-desc" class="market-textarea" rows="3" placeholder="风格关键词、适合内容、借鉴模块…"></textarea>
        </div>
        <p class="market-form-hint">提交后快照文件当前内容，进入待审核状态，管理员审核通过并设为展示后才出现在市场。</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-small" id="pub-cancel">取消</button>
        <button type="button" class="btn btn-small btn-primary" id="pub-submit">${action}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector('#pub-close').onclick = close;
  backdrop.querySelector('#pub-cancel').onclick = close;
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#pub-submit').onclick = async () => {
    const title = backdrop.querySelector('#pub-title').value.trim();
    const categoryId = parseInt(backdrop.querySelector('#pub-category').value);
    const description = backdrop.querySelector('#pub-desc').value.trim();
    if (!title) return toast('请填写标题', 'error');
    if (!categoryId) return toast('请选择分类', 'error');

    const submitBtn = backdrop.querySelector('#pub-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = '提交中…';
    try {
      await api('/api/content-templates/from-file', {
        method: 'POST',
        body: { fileId, title, description: description || undefined, categoryId },
      });
      toast(isPublished ? '已更新，重新进入审核' : '已提交，等待审核');
      close();
    } catch (e) {
      toast(e.message || '操作失败', 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = action;
    }
  };
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
const TEMPLATE_VISUALS = {
  'default':   { bg: '#ffffff', text: '#57606a', heading: '#1f2328', code: '#f6f8fa', border: '#d0d7de' },
  'github':    { bg: '#ffffff', text: '#57606a', heading: '#1f2328', code: '#f6f8fa', border: '#d0d7de' },
  'academic':  { bg: '#fefcf3', text: '#3b3b3b', heading: '#1a1a1a', code: '#f5f1e8', border: '#d4c9a8' },
  'dark-pro':  { bg: '#1e1e2e', text: '#a6adc8', heading: '#f0f6fc', code: '#313244', border: '#45475a' },
};
let templateSelectBound = false;
async function openTemplateSelect(container, fileId, currentTemplateId) {
  const modal = document.getElementById('template-select-modal');
  if (!modal) return;
  const list = document.getElementById('template-select-list');
  list.innerHTML = '<div class="loading">加载中…</div>';
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');

  // 关闭按钮必须在任何异步加载之前绑定：否则加载失败提前 return 时，
  // 弹窗会因没有关闭入口而卡死（回归）。
  if (!templateSelectBound) {
    document.getElementById('template-select-close').addEventListener('click', closeTemplateSelect);
    document.getElementById('template-select-cancel').addEventListener('click', closeTemplateSelect);
    templateSelectBound = true;
  }

  let allTemplates;
  try {
    const data = await api('/api/templates');
    allTemplates = data.templates || [];
  } catch (e) {
    list.innerHTML = '<div class="empty-state">加载失败</div>';
    return;
  }

  const defaultTpl = allTemplates.find(t => t.name === 'default');
  const isSelected = (t) => t.id === currentTemplateId || (!currentTemplateId && t.name === 'default');

  list.innerHTML = allTemplates.map(t => {
    const v = TEMPLATE_VISUALS[t.name] || TEMPLATE_VISUALS['default'];
    const sel = isSelected(t);
    return `<div class="tpl-card ${sel ? 'selected' : ''}" data-tpl-id="${t.id}">
      <div class="tpl-preview" style="background:${v.bg};border-bottom:1px solid ${v.border}">
        <div class="tpl-preview-heading" style="background:${v.heading}"></div>
        <div class="tpl-preview-line" style="background:${v.text};opacity:.45"></div>
        <div class="tpl-preview-line" style="background:${v.text};opacity:.3"></div>
        <div class="tpl-preview-code" style="background:${v.code};border:1px solid ${v.border}"></div>
      </div>
      <div class="tpl-card-label">
        <span>${t.description || t.name}</span>
        <span class="tpl-card-check">✓</span>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.tpl-card').forEach(item => {
    item.addEventListener('click', async () => {
      const tplId = parseInt(item.dataset.tplId);
      try {
        await api(`/api/files/${fileId}`, {
          method: 'PUT',
          body: { templateId: tplId === defaultTpl?.id ? null : tplId }
        });
      } catch (e) { toast(e.message || '切换模板失败', 'error'); }
      closeTemplateSelect();
      renderHome(container);
    });
  });
}

function closeTemplateSelect() {
  const modal = document.getElementById('template-select-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

export { renderHome, closeTemplateSelect };
