// 预览页：渲染、源码/编辑切换、版本历史、统计、模板选择

import { api, API_BASE } from '../api.js';
import { toast } from '../components/toast.js';
import { dialogModal } from '../components/dialog.js';
import { escapeHtml, formatSize, relativeTime, buildSkeletonCards } from '../utils.js';
import { state, navigate } from '../app.js';
import { closeTemplateSelect } from './home.js';

// ---------- Preview Header State ----------
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

    const menu = container.querySelector('#menu-version-history');
    if (menu) menu.textContent = `历史 v${_versionPanelState.currentVer}`;
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
  const input = container.querySelector('#version-file-input');
  if (!input) return;

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

// ---------- Stats Dialog ----------
async function openStatsDialog(fileId, container) {
  closeVersionPanel(container);
  try {
    const stats = await api(`/api/files/${fileId}/stats`);
    const html = buildStatsHtml(stats);
    dialogModal.alert({ title: '访问统计', message: html, confirmText: '关闭' });
  } catch (e) {
    toast(e.message || '获取统计失败', 'error');
  }
}

function buildStatsHtml(stats) {
  const max7 = Math.max(1, ...stats.daily7.map(d => d.count));
  const max30 = Math.max(1, ...stats.daily30.map(d => d.count));
  const barChart = (data, maxVal) => {
    if (!data.length) return '<div class="stats-empty">暂无数据</div>';
    return '<div class="stats-chart">' + data.map(d => {
      const pct = Math.max(2, Math.round(d.count / maxVal * 100));
      const label = d.date.slice(5);
      return `<div class="stats-bar-group"><div class="stats-bar" style="height:${pct}%"></div><div class="stats-bar-val">${d.count}</div><div class="stats-bar-label">${label}</div></div>`;
    }).join('') + '</div>';
  };
  return `<div class="stats-summary"><span class="stats-total">总浏览量：<strong>${stats.viewCount}</strong></span></div>`
    + `<div class="stats-section"><h4>近 7 天</h4>${barChart(stats.daily7, max7)}</div>`
    + `<div class="stats-section"><h4>近 30 天</h4>${barChart(stats.daily30, max30)}</div>`;
}

// --- 模板选择（预览页） ---
const TEMPLATE_VISUALS = {
  'default':   { bg: '#ffffff', text: '#57606a', heading: '#1f2328', code: '#f6f8fa', border: '#d0d7de' },
  'github':    { bg: '#ffffff', text: '#57606a', heading: '#1f2328', code: '#f6f8fa', border: '#d0d7de' },
  'academic':  { bg: '#fefcf3', text: '#3b3b3b', heading: '#1a1a1a', code: '#f5f1e8', border: '#d4c9a8' },
  'dark-pro':  { bg: '#1e1e2e', text: '#a6adc8', heading: '#f0f6fc', code: '#313244', border: '#45475a' },
};

async function openTemplateSelectForPreview(container, fileId, currentTemplateId) {
  const modal = document.getElementById('template-select-modal');
  if (!modal) return;
  const list = document.getElementById('template-select-list');
  list.innerHTML = '<div class="loading">加载中…</div>';
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');

  let allTemplates;
  try {
    const res = await authFetch('/api/templates');
    const data = await res.json();
    allTemplates = data.templates || [];
  } catch (e) {
    list.innerHTML = '<div class="empty-state">加载失败</div>';
    return;
  }

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
        await authFetch(`/api/files/${fileId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateId: tplId })
        });
        const iframe = container.querySelector('#preview-iframe');
        if (iframe) iframe.src = iframe.src;
      } catch (e) { /* ignore */ }
      closeTemplateSelect();
    });
  });

  document.getElementById('template-select-close').onclick = closeTemplateSelect;
  document.getElementById('template-select-cancel').onclick = closeTemplateSelect;
}

// ---------- Preview Page ----------
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
  const editBtn = container.querySelector('#btn-edit');
  const editorContainer = container.querySelector('#editor-container');
  const editorTextarea = container.querySelector('#editor-textarea');
  const editorGutter = container.querySelector('#editor-gutter');
  const editorStatusbar = container.querySelector('#editor-statusbar');
  const editorSaveBtn = container.querySelector('#btn-editor-save');
  const editorCancelBtn = container.querySelector('#btn-editor-cancel');
  const menuDownload = container.querySelector('#menu-download');
  const menuUploadVersion = container.querySelector('#menu-upload-version');
  const menuVersionHistory = container.querySelector('#menu-version-history');
  const moreDropdown = container.querySelector('#preview-more-dropdown');
  const moreBtn = container.querySelector('#btn-preview-more');
  let fileContent = '';
  let editorOriginalContent = '';

  iframe.addEventListener('load', () => {
    if (spinner) spinner.style.display = 'none';
  });

  let fileName;

  function updateEditorLines() {
    const lines = editorTextarea.value.split('\n').length;
    let nums = '';
    for (let i = 1; i <= lines; i++) nums += i + '\n';
    editorGutter.textContent = nums;
    editorStatusbar.textContent = `${lines} 行 · ${editorTextarea.value.length} 字符`;
  }

  function exitEditMode(mode) {
    if (editorTextarea.value !== editorOriginalContent) {
      return dialogModal.confirm({
        title: '放弃编辑',
        message: '内容已修改但未保存，确定要放弃吗？',
        confirmText: '放弃',
      }).then(ok => ok ? setViewMode(mode) : undefined);
    }
    setViewMode(mode);
  }

  function setViewMode(mode) {
    const isEdit = mode === 'edit';
    if (mode === 'render') {
      iframe.style.display = 'block';
      source.classList.remove('active');
    } else if (mode === 'source') {
      iframe.style.display = 'none';
      source.classList.add('active');
    } else if (isEdit) {
      iframe.style.display = 'none';
      source.classList.remove('active');
      editorTextarea.value = fileContent;
      editorOriginalContent = fileContent;
      updateEditorLines();
      setTimeout(() => editorTextarea.focus(), 0);
    }
    editorContainer.hidden = !isEdit;
    editorSaveBtn.hidden = !isEdit;
    editorCancelBtn.hidden = !isEdit;
    if (moreDropdown) moreDropdown.style.display = isEdit ? 'none' : '';
    toggles.forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  try {
    layout.classList.add('preview-header-collapsed', 'preview-toolbar-compact');
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
    btn.addEventListener('click', () => {
      const target = btn.dataset.mode;
      if (!editorContainer.hidden && target !== 'edit') {
        exitEditMode(target);
      } else {
        setViewMode(target);
      }
    });
  });

  // Editor: Tab key, Ctrl+S, Escape, scroll sync, line numbers
  editorTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = editorTextarea.selectionStart;
      const end = editorTextarea.selectionEnd;
      editorTextarea.value = editorTextarea.value.substring(0, start) + '  ' + editorTextarea.value.substring(end);
      editorTextarea.selectionStart = editorTextarea.selectionEnd = start + 2;
      updateEditorLines();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      doEditorSave();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      exitEditMode('render');
    }
  });
  editorTextarea.addEventListener('input', updateEditorLines);
  editorTextarea.addEventListener('scroll', () => {
    editorGutter.scrollTop = editorTextarea.scrollTop;
  });

  async function doEditorSave() {
    const content = editorTextarea.value;
    editorSaveBtn.disabled = true;
    editorSaveBtn.textContent = '保存中…';
    try {
      await api(`/api/files/${id}/overwrite-json`, {
        method: 'POST',
        body: { name: fileName, content }
      });
      toast('保存成功');
      fileContent = content;
      code.textContent = content;
      if (spinner) spinner.style.display = 'flex';
      iframe.src = API_BASE + `/api/files/${id}/render`;
      loadVersions(container, id);
      setViewMode('render');
    } catch (e) {
      toast(e.message || '保存失败', 'error');
    } finally {
      editorSaveBtn.disabled = false;
      editorSaveBtn.textContent = '保存';
    }
  }

  editorSaveBtn.addEventListener('click', doEditorSave);
  editorCancelBtn.addEventListener('click', () => exitEditMode('render'));

  // Download via menu
  if (menuDownload) {
    menuDownload.addEventListener('click', () => {
      closeMoreDropdown();
      const w = window.open(API_BASE + `/api/files/${id}/download`, '_blank');
      if (w) w.opener = null;
    });
  }

  // Version history panel
  const closeVersionBtn = container.querySelector('#btn-close-version-panel');
  const versionPanel = container.querySelector('#version-panel');

  setupVersionUpload(container, id);

  function toggleVersionPanel() {
    if (versionPanel && !versionPanel.hidden && versionPanel.classList.contains('open')) {
      closeVersionPanel(container);
    } else {
      loadVersions(container, id);
      openVersionPanel(container);
    }
  }

  if (menuVersionHistory) {
    menuVersionHistory.addEventListener('click', () => { closeMoreDropdown(); toggleVersionPanel(); });
  }

  if (closeVersionBtn) {
    closeVersionBtn.addEventListener('click', () => closeVersionPanel(container));
  }

  // Escape key closes version panel
  document.addEventListener('keydown', function versionEscHandler(e) {
    if (e.key === 'Escape' && versionPanel && !versionPanel.hidden && versionPanel.classList.contains('open')) {
      closeVersionPanel(container);
    }
  });

  // More dropdown: toggle + menu item delegation
  function closeMoreDropdown() {
    if (moreDropdown) {
      moreDropdown.classList.remove('open');
      moreBtn.setAttribute('aria-expanded', 'false');
    }
  }
  if (moreBtn) {
    moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = moreDropdown.classList.toggle('open');
      moreBtn.setAttribute('aria-expanded', String(isOpen));
    });
    if (menuUploadVersion) menuUploadVersion.addEventListener('click', () => { closeMoreDropdown(); container.querySelector('#version-file-input')?.click(); });
    if (menuVersionHistory && !menuVersionHistory._bound) { menuVersionHistory._bound = true; } // already bound above
    // Close on outside click
    document.addEventListener('click', function moreOutsideHandler(e) {
      if (moreDropdown && !moreDropdown.contains(e.target)) closeMoreDropdown();
    });
  }

  api(`/api/files/${id}/content`).then(data => {
    fileName = data.original_name;
    fileContent = data.content;
    const lockPrefix = data.is_public ? '' : '<span class="file-lock" title="私有文件" aria-label="私有文件">🔒 </span>';
    container.querySelector('#preview-title').innerHTML = lockPrefix + escapeHtml(data.original_name);
    container.querySelector('#preview-heading').innerHTML = lockPrefix + escapeHtml(data.original_name);
    expandFloatingBtn.title = `展开顶栏 · ${data.original_name}`;
    expandFloatingBtn.setAttribute('aria-label', `展开顶栏 · ${data.original_name}`);
    syncToolbarCompact(layout, titleStrip, fileName);
    code.textContent = data.content;
    if (spinner) spinner.style.display = 'flex';
    iframe.src = API_BASE + `/api/files/${id}/render`;
    // 模板菜单项：仅 Markdown 文件且为所有者/admin 可见
    const menuTemplate = container.querySelector('#menu-template');
    if (menuTemplate && data.file_type === 'markdown' && state.currentUser && (state.currentUser.id == data.uploaded_by || state.currentUser.role === 'admin')) {
      menuTemplate.hidden = false;
      menuTemplate.addEventListener('click', () => {
        closeMoreDropdown();
        openTemplateSelectForPreview(container, id, data.template_id);
      });
    }
    // Show edit button only for owner or admin, and not for bundles
    if (state.currentUser && !data.is_bundle && (state.currentUser.id == data.uploaded_by || state.currentUser.role === 'admin')) {
      editBtn.hidden = false;
    }
    // 统计菜单项：仅文件所有者或 admin 可见
    const menuStats = container.querySelector('#menu-stats');
    if (menuStats && state.currentUser && (state.currentUser.role === 'admin' || state.currentUser.id == data.uploaded_by)) {
      menuStats.hidden = false;
      menuStats.addEventListener('click', () => { closeMoreDropdown(); openStatsDialog(id, container); });
    }
  }).catch(e => {
    toast(e.message, 'error');
    navigate('/');
  });
}

export { renderPreview };
