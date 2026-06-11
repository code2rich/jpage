// 内容模板市场：浏览、上传、详情

import { api, API_BASE } from '../api.js';
import { toast } from '../components/toast.js';
import { dialogModal } from '../components/dialog.js';
import { escapeHtml, relativeTime, openModal, closeModal } from '../utils.js';
import { state } from '../app.js';

const SCENE_LABELS = { dashboard: '仪表板', report: '报告', resume: '简历', landing: '落地页', note: '笔记', presentation: '演示', card: '卡片', email: '邮件', other: '其他' };

let ctState = { scene: '', keyword: '', page: 1, templates: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 1 }, currentId: null, editing: false };

const loadedThumbs = new Set();
let activeThumbLoads = 0;
const MAX_CONCURRENT_THUMBS = 3;
const pendingThumbQueue = [];
const thumbObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const card = entry.target;
    thumbObserver.unobserve(card);
    enqueueThumbLoad(card);
  });
}, { rootMargin: '200px' });

function enqueueThumbLoad(card) {
  if (activeThumbLoads < MAX_CONCURRENT_THUMBS) {
    activeThumbLoads++;
    loadThumb(card).finally(() => {
      activeThumbLoads--;
      if (pendingThumbQueue.length > 0) {
        enqueueThumbLoad(pendingThumbQueue.shift());
      }
    });
  } else {
    pendingThumbQueue.push(card);
  }
}

async function loadThumb(card) {
  const id = parseInt(card.dataset.id);
  if (loadedThumbs.has(id)) return;
  loadedThumbs.add(id);
  const loadingEl = card.querySelector('.ct-card-thumb-loading');
  const iframe = card.querySelector('.ct-thumb-iframe');
  if (!iframe) return;
  try {
    const data = await api(`/api/content-templates/${id}/content`);
    if (data.file_type === 'markdown') {
      iframe.srcdoc = `<pre style="padding:24px;font-size:14px;white-space:pre-wrap;word-break:break-word;margin:0">${escapeHtml(data.content)}</pre>`;
    } else {
      iframe.srcdoc = data.content;
    }
    iframe.onload = () => { if (loadingEl) loadingEl.remove(); };
  } catch {
    if (loadingEl) loadingEl.remove();
  }
}

let marketEventsBound = false;

export function openContentTemplateMarket() {
  const modal = document.getElementById('ct-market-modal');
  if (!modal) return;
  openModal(modal);
  ctState.scene = '';
  ctState.keyword = '';
  ctState.page = 1;
  loadedThumbs.clear();
  if (!marketEventsBound) {
    bindMarketEvents(modal);
    marketEventsBound = true;
  }
  // 重置场景筛选 UI
  const chips = modal.querySelectorAll('#ct-scene-chips .filter-chip');
  chips.forEach(c => c.classList.toggle('active', !c.dataset.scene));
  loadTemplates();
}

function bindMarketEvents(modal) {
  // 关闭
  const close = () => { closeModal(modal); };
  modal.querySelector('#ct-market-close').onclick = close;
  modal.querySelector('#ct-market-dismiss').onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  // 场景筛选
  const chips = modal.querySelectorAll('#ct-scene-chips .filter-chip');
  chips.forEach(chip => {
    chip.onclick = () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      ctState.scene = chip.dataset.scene;
      ctState.page = 1;
      loadTemplates();
    };
  });

  // 搜索
  const searchInput = modal.querySelector('#ct-search');
  let searchTimer;
  searchInput.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      ctState.keyword = searchInput.value.trim();
      ctState.page = 1;
      loadTemplates();
    }, 300);
  };

  // 上传按钮
  modal.querySelector('#ct-market-upload').onclick = () => openUploadModal();
}

async function loadTemplates() {
  const grid = document.getElementById('ct-grid');
  if (!grid) return;
  loadedThumbs.clear();
  grid.innerHTML = '<div class="ct-loading">加载中...</div>';

  const params = new URLSearchParams();
  params.set('page', ctState.page);
  params.set('limit', '12');
  if (ctState.scene) params.set('scene', ctState.scene);
  if (ctState.keyword) params.set('keyword', ctState.keyword);
  params.set('sort', 'use_count');

  try {
    const data = await api('/api/content-templates?' + params.toString());
    ctState.templates = data.templates || [];
    ctState.pagination = data.pagination || { page: 1, limit: 12, total: 0, totalPages: 1 };
    renderGrid(grid);
  } catch (e) {
    grid.innerHTML = '<div class="ct-empty">加载失败</div>';
  }
}

function renderGrid(grid) {
  if (ctState.templates.length === 0) {
    grid.innerHTML = '<div class="ct-empty">暂无模板，点击右上角「+ 上传模板」添加</div>';
    return;
  }

  grid.innerHTML = ctState.templates.map(t => {
    const sceneLabel = SCENE_LABELS[t.scene] || t.scene || '';
    const typeClass = t.file_type === 'markdown' ? 'ct-badge-md' : 'ct-badge-html';
    const typeLabel = t.file_type === 'markdown' ? 'MD' : 'HTML';
    const isOwner = state.currentUser && (state.currentUser.id === t.uploaded_by || state.currentUser.role === 'admin');
    return `<div class="ct-card" data-id="${t.id}" data-file-type="${t.file_type}">
      <div class="ct-card-thumb">
        <div class="ct-card-thumb-wrap"><iframe class="ct-thumb-iframe" sandbox="allow-scripts"></iframe></div>
        <div class="ct-card-thumb-loading"></div>
      </div>
      <div class="ct-card-header">
        <span class="ct-card-title">${escapeHtml(t.title)}</span>
        <span class="ct-badge ${typeClass}">${typeLabel}</span>
      </div>
      ${sceneLabel ? `<span class="ct-badge ct-badge-scene">${sceneLabel}</span>` : ''}
      <p class="ct-card-desc">${escapeHtml(t.description || '').slice(0, 100)}</p>
      <div class="ct-card-footer">
        <span class="ct-use-count">使用 ${t.use_count} 次</span>
        <span class="ct-card-time">${relativeTime(t.created_at)}</span>
        ${isOwner ? '<span class="ct-owner-mark">我的</span>' : ''}
      </div>
    </div>`;
  }).join('');

  // 分页
  const pg = ctState.pagination;
  if (pg.totalPages > 1) {
    grid.innerHTML += `<div class="ct-pagination">
      <button class="btn btn-small" id="ct-prev" ${pg.page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="ct-page-info">${pg.page} / ${pg.totalPages}</span>
      <button class="btn btn-small" id="ct-next" ${pg.page >= pg.totalPages ? 'disabled' : ''}>下一页</button>
    </div>`;
    grid.querySelector('#ct-prev')?.addEventListener('click', () => { ctState.page = Math.max(1, ctState.page - 1); loadTemplates(); });
    grid.querySelector('#ct-next')?.addEventListener('click', () => { ctState.page = Math.min(pg.totalPages, ctState.page + 1); loadTemplates(); });
  }

  // 卡片点击
  grid.querySelectorAll('.ct-card').forEach(card => {
    card.onclick = () => openDetailModal(parseInt(card.dataset.id));
    thumbObserver.observe(card);
  });
}

function openUploadModal(prefill) {
  const modal = document.getElementById('ct-upload-modal');
  if (!modal) return;
  openModal(modal);

  const titleEl = modal.querySelector('#ct-upload-title');
  const sceneEl = modal.querySelector('#ct-upload-scene');
  const descEl = modal.querySelector('#ct-upload-desc');
  const tagsEl = modal.querySelector('#ct-upload-tags');
  const contentEl = modal.querySelector('#ct-upload-content');
  const filetypeEl = modal.querySelector('#ct-upload-filetype');

  if (prefill) {
    titleEl.value = prefill.title || '';
    sceneEl.value = prefill.scene || '';
    descEl.value = prefill.description || '';
    tagsEl.value = prefill.style_tags || '';
    contentEl.value = prefill.content || '';
    filetypeEl.value = prefill.file_type || 'html';
  } else {
    titleEl.value = '';
    sceneEl.value = '';
    descEl.value = '';
    tagsEl.value = '';
    contentEl.value = '';
    filetypeEl.value = 'html';
  }

  const close = () => { closeModal(modal); };
  modal.querySelector('#ct-upload-close').onclick = close;
  modal.querySelector('#ct-upload-cancel').onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  modal.querySelector('#ct-upload-submit').onclick = async () => {
    const title = titleEl.value.trim();
    const content = contentEl.value;
    if (!title) return toast('请填写模板标题', 'error');
    if (!content) return toast('请填写样例内容', 'error');
    if (Buffer_byteLength(content) > 512000) return toast('样例内容不能超过 500KB', 'error');

    try {
    const body = {
      title,
      description: descEl.value.trim() || undefined,
      scene: sceneEl.value || undefined,
      styleTags: tagsEl.value.trim() || undefined,
      content,
      fileType: filetypeEl.value,
      isPublic: modal.querySelector('#ct-upload-public').checked,
    };
    if (prefill?.id) {
      await api(`/api/content-templates/${prefill.id}`, { method: 'PUT', body });
    } else {
      await api('/api/content-templates', { method: 'POST', body });
    }
      toast('模板上传成功');
      close();
      loadTemplates();
    } catch (e) {
      toast(e.message || '上传失败', 'error');
    }
  };
}

function Buffer_byteLength(str) {
  return new TextEncoder().encode(str).length;
}

async function openDetailModal(id) {
  const modal = document.getElementById('ct-detail-modal');
  if (!modal) return;
  openModal(modal);
  ctState.currentId = id;
  ctState.editing = false;

  const close = () => { closeModal(modal); };
  modal.querySelector('#ct-detail-close').onclick = close;
  modal.querySelector('#ct-detail-dismiss').onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  try {
    const [meta, contentData] = await Promise.all([
      api(`/api/content-templates/${id}`),
      api(`/api/content-templates/${id}/content`),
    ]);

    modal.querySelector('#ct-detail-title').textContent = meta.title;

    // 元数据
    const metaEl = modal.querySelector('#ct-detail-meta');
    const sceneLabel = SCENE_LABELS[meta.scene] || meta.scene || '';
    const isOwner = state.currentUser && (state.currentUser.id === meta.uploaded_by || state.currentUser.role === 'admin');
    metaEl.innerHTML = `
      <div class="ct-meta-row">
        ${sceneLabel ? `<span class="ct-badge ct-badge-scene">${sceneLabel}</span>` : ''}
        <span class="ct-badge ${meta.file_type === 'markdown' ? 'ct-badge-md' : 'ct-badge-html'}">${meta.file_type === 'markdown' ? 'Markdown' : 'HTML'}</span>
        ${meta.style_tags ? meta.style_tags.split(',').map(t => `<span class="ct-badge ct-badge-tag">${escapeHtml(t.trim())}</span>`).join('') : ''}
      </div>
      ${meta.description ? `<p class="ct-desc">${escapeHtml(meta.description)}</p>` : ''}
      <div class="ct-meta-info">使用 ${meta.use_count} 次 · ${meta.uploader_name || '系统内置'} · ${relativeTime(meta.created_at)}</div>
    `;

    // 预览
    const iframe = modal.querySelector('#ct-detail-iframe');
    if (contentData.file_type === 'html') {
      iframe.srcdoc = contentData.content;
    } else {
      iframe.srcdoc = `<pre style="padding:16px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0">${escapeHtml(contentData.content)}</pre>`;
    }

    // 按钮权限
    const editBtn = modal.querySelector('#ct-detail-edit');
    const delBtn = modal.querySelector('#ct-detail-delete');
    editBtn.style.display = isOwner ? '' : 'none';
    delBtn.style.display = isOwner ? '' : 'none';

    // 复制
    modal.querySelector('#ct-detail-copy').onclick = () => {
      navigator.clipboard.writeText(contentData.content).then(() => toast('已复制到剪贴板'));
    };

    // 编辑
    editBtn.onclick = () => {
      closeModal(modal);
      openUploadModal({ ...meta, content: contentData.content });
    };

    // 删除
    delBtn.onclick = async () => {
      const ok = await dialogModal('确定删除此模板？', '此操作不可撤销。', '删除');
      if (!ok) return;
      try {
        await api(`/api/content-templates/${id}`, { method: 'DELETE' });
        toast('模板已删除');
        close();
        loadTemplates();
      } catch (e) {
        toast('删除失败', 'error');
      }
    };
  } catch (e) {
    toast('加载模板详情失败', 'error');
  }
}
