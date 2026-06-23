// 内容模板市场：独立路由页面。
// 子路由：#/market（首页）/ :id（详情）/ submit（提交）/ my（我的上架）/ admin（管理）。

import { api } from '../api.js';
import { state } from '../app.js';
import { toast } from '../components/toast.js';
import { dialogModal } from '../components/dialog.js';
import { escapeHtml, relativeTime, copyToClipboard } from '../utils.js';

const MAX_SIZE = 512000; // 500KB

// 缩略图懒加载（从旧 content-templates.js 迁移，复用 .ct-thumb-iframe 容器）
const loadedThumbs = new Set();
let activeThumbLoads = 0;
const MAX_CONCURRENT_THUMBS = 3;
const pendingThumbQueue = [];
let thumbObserver = null;

function ensureThumbObserver() {
  if (thumbObserver) return thumbObserver;
  thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const card = entry.target;
      thumbObserver.unobserve(card);
      enqueueThumbLoad(card);
    });
  }, { rootMargin: '200px' });
  return thumbObserver;
}

function resetThumbCache() {
  loadedThumbs.clear();
  pendingThumbQueue.length = 0;
  activeThumbLoads = 0;
}

function enqueueThumbLoad(card) {
  if (activeThumbLoads < MAX_CONCURRENT_THUMBS) {
    activeThumbLoads++;
    loadThumb(card).finally(() => {
      activeThumbLoads--;
      if (pendingThumbQueue.length > 0) enqueueThumbLoad(pendingThumbQueue.shift());
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
    const data = await api(`/api/content-templates/market/${id}/preview`);
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

// ============================================================
// 入口：根据子路由分发
// ============================================================

export function renderMarket(container, hash, navigate) {
  const path = hash.replace(/^#/, '') || '/market';

  // /market/:id 详情（排除 /market/submit、/market/my、/market/admin 这些保留段）
  const detailMatch = path.match(/^\/market\/(\d+)$/);
  if (detailMatch) {
    renderDetail(container, parseInt(detailMatch[1]), navigate);
    return;
  }
  if (path === '/market/submit') { renderSubmit(container, null, navigate); return; }
  if (path === '/market/my')     { renderMine(container, navigate); return; }
  if (path === '/market/admin') {
    if (!state.currentUser || state.currentUser.role !== 'admin') {
      toast('需要管理员权限', 'error');
      navigate('/market');
      return;
    }
    renderAdmin(container, navigate);
    return;
  }
  // 默认：市场首页
  renderHome(container, navigate);
}

// ============================================================
// 共享：市场头部导航（分类 Tabs 之外的顶部栏）
// ============================================================

function renderMarketShell(container, { active }) {
  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  container.innerHTML = `
    <div class="market-page">
      <header class="market-header">
        <div class="market-header-left">
          <a href="#/" class="market-back" aria-label="返回首页">← 首页</a>
          <h1 class="market-title">内容市场</h1>
        </div>
        <nav class="market-nav">
          <a href="#/market" class="market-nav-item ${active === 'home' ? 'active' : ''}">市场</a>
          <a href="#/market/submit" class="market-nav-item ${active === 'submit' ? 'active' : ''}">提交模板</a>
          <a href="#/market/my" class="market-nav-item ${active === 'my' ? 'active' : ''}">我的上架</a>
          ${isAdmin ? '<a href="#/market/admin" class="market-nav-item admin-only ' + (active === 'admin' ? 'active' : '') + '">市场管理</a>' : ''}
        </nav>
      </header>
      <div class="market-body" id="market-body"></div>
    </div>
  `;
  return container.querySelector('#market-body');
}

// ============================================================
// 市场首页
// ============================================================

const homeState = { category: '', keyword: '', sort: '', page: 1 };

function renderHome(container, navigate) {
  const body = renderMarketShell(container, { active: 'home', navigate });
  body.innerHTML = `
    <div class="market-toolbar">
      <div class="market-search-wrap">
        <input type="search" id="market-search" class="search-input" placeholder="搜索模板标题或描述" value="${escapeHtml(homeState.keyword)}">
      </div>
      <div class="market-sort">
        <select id="market-sort" class="market-select">
          <option value="">热门优先</option>
          <option value="created_at" ${homeState.sort === 'created_at' ? 'selected' : ''}>最新发布</option>
          <option value="featured" ${homeState.sort === 'featured' ? 'selected' : ''}>精选优先</option>
        </select>
      </div>
    </div>
    <div class="filter-chips" id="market-category-chips"></div>
    <div id="market-grid" class="ct-grid"></div>
  `;

  // 搜索（防抖）
  const searchInput = body.querySelector('#market-search');
  let searchTimer;
  searchInput.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      homeState.keyword = searchInput.value.trim();
      homeState.page = 1;
      loadHomeList(body, navigate);
    }, 300);
  };

  // 排序
  body.querySelector('#market-sort').onchange = (e) => {
    homeState.sort = e.target.value;
    homeState.page = 1;
    loadHomeList(body, navigate);
  };

  // 分类条（异步加载）
  loadCategoryChips(body, navigate).then(() => loadHomeList(body, navigate));
}

async function loadCategoryChips(body, navigate) {
  const chipsEl = body.querySelector('#market-category-chips');
  try {
    const data = await api('/api/content-templates/categories');
    const cats = data.categories || [];
    const all = `<button class="filter-chip ${!homeState.category ? 'active' : ''}" data-category="">全部</button>`;
    const items = cats.map(c =>
      `<button class="filter-chip ${homeState.category === c.slug ? 'active' : ''}" data-category="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</button>`
    ).join('');
    chipsEl.innerHTML = all + items;
    chipsEl.querySelectorAll('.filter-chip').forEach(chip => {
      chip.onclick = () => {
        homeState.category = chip.dataset.category;
        homeState.page = 1;
        chipsEl.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        loadHomeList(body, navigate);
      };
    });
  } catch {
    chipsEl.innerHTML = '';
  }
}

async function loadHomeList(body, navigate) {
  const grid = body.querySelector('#market-grid');
  if (!grid) return;
  resetThumbCache();
  grid.innerHTML = '<div class="ct-loading">加载中...</div>';

  const params = new URLSearchParams();
  params.set('page', homeState.page);
  params.set('limit', '12');
  if (homeState.category) params.set('category', homeState.category);
  if (homeState.keyword) params.set('keyword', homeState.keyword);
  if (homeState.sort) params.set('sort', homeState.sort);

  try {
    const data = await api('/api/content-templates/market?' + params.toString());
    renderHomeGrid(grid, data.templates || [], data.pagination, navigate);
  } catch {
    grid.innerHTML = '<div class="ct-empty">加载失败</div>';
  }
}

function renderHomeGrid(grid, templates, pg, navigate) {
  if (!templates.length) {
    grid.innerHTML = '<div class="ct-empty">暂无模板。点击「提交模板」上架你的作品。</div>';
    return;
  }
  grid.innerHTML = templates.map(t => {
    const typeClass = t.file_type === 'markdown' ? 'ct-badge-md' : 'ct-badge-html';
    const typeLabel = t.file_type === 'markdown' ? 'MD' : 'HTML';
    const cat = t.category_name ? `<span class="ct-badge ct-badge-scene">${escapeHtml(t.category_name)}</span>` : '';
    const featured = t.featured ? '<span class="ct-badge ct-badge-featured">精选</span>' : '';
    return `<div class="ct-card" data-id="${t.id}" data-file-type="${t.file_type}">
      <div class="ct-card-thumb">
        <div class="ct-card-thumb-wrap"><iframe class="ct-thumb-iframe" sandbox="allow-scripts"></iframe></div>
        <div class="ct-card-thumb-loading"></div>
      </div>
      <div class="ct-card-header">
        <span class="ct-card-title">${escapeHtml(t.title)}</span>
        <span class="ct-badge ${typeClass}">${typeLabel}</span>
      </div>
      ${cat}${featured}
      <p class="ct-card-desc">${escapeHtml(t.description || '').slice(0, 100)}</p>
      <div class="ct-card-footer">
        <span class="ct-use-count">使用 ${t.use_count} 次</span>
        <span class="ct-card-time">${relativeTime(t.published_at || t.created_at)}</span>
      </div>
    </div>`;
  }).join('');

  // 分页
  if (pg && pg.totalPages > 1) {
    grid.innerHTML += `<div class="ct-pagination">
      <button class="btn btn-small" id="ct-prev" ${pg.page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="ct-page-info">${pg.page} / ${pg.totalPages}</span>
      <button class="btn btn-small" id="ct-next" ${pg.page >= pg.totalPages ? 'disabled' : ''}>下一页</button>
    </div>`;
    grid.querySelector('#ct-prev')?.addEventListener('click', () => { homeState.page = Math.max(1, homeState.page - 1); loadHomeList(grid.closest('#market-body'), navigate); });
    grid.querySelector('#ct-next')?.addEventListener('click', () => { homeState.page = Math.min(pg.totalPages, homeState.page + 1); loadHomeList(grid.closest('#market-body'), navigate); });
  }

  // 卡片点击 → 详情
  const obs = ensureThumbObserver();
  grid.querySelectorAll('.ct-card').forEach(card => {
    card.onclick = () => navigate(`/market/${card.dataset.id}`);
    obs.observe(card);
  });
}

// ============================================================
// 详情页
// ============================================================

function renderDetail(container, id, navigate) {
  const body = renderMarketShell(container, { active: 'home', navigate });
  body.innerHTML = '<div class="ct-loading">加载中...</div>';

  loadDetail(body, id, navigate);
}

async function loadDetail(body, id, navigate) {
  try {
    const [meta, contentData] = await Promise.all([
      api(`/api/content-templates/market/${id}`),
      api(`/api/content-templates/market/${id}/preview`),
    ]);

    const isOwner = state.currentUser && (state.currentUser.id === meta.uploaded_by);
    const isAdmin = state.currentUser && state.currentUser.role === 'admin';
    const typeLabel = meta.file_type === 'markdown' ? 'Markdown' : 'HTML';
    const cat = meta.category_name ? `<span class="ct-badge ct-badge-scene">${escapeHtml(meta.category_name)}</span>` : '';
    const featured = meta.featured ? '<span class="ct-badge ct-badge-featured">精选</span>' : '';

    body.innerHTML = `
      <div class="market-detail">
        <div class="market-detail-preview">
          <iframe class="market-detail-iframe" sandbox="allow-scripts"></iframe>
        </div>
        <aside class="market-detail-meta">
          <h2 class="market-detail-title">${escapeHtml(meta.title)}</h2>
          <div class="ct-meta-row">
            ${cat}
            <span class="ct-badge ${meta.file_type === 'markdown' ? 'ct-badge-md' : 'ct-badge-html'}">${typeLabel}</span>
            ${featured}
          </div>
          ${meta.description ? `<p class="ct-desc">${escapeHtml(meta.description)}</p>` : ''}
          <div class="ct-meta-info">
            作者：${escapeHtml(meta.uploader_name || '匿名')} · 使用 ${meta.use_count} 次 · ${relativeTime(meta.published_at || meta.created_at)}
          </div>
          <div class="market-detail-actions">
            <button class="btn btn-primary" id="detail-copy">复制内容</button>
            <button class="btn" id="detail-use">使用此模板</button>
            ${isOwner || isAdmin ? `<button class="btn btn-small" id="detail-edit">编辑</button>` : ''}
          </div>
        </aside>
      </div>
    `;

    const iframe = body.querySelector('.market-detail-iframe');
    if (contentData.file_type === 'markdown') {
      iframe.srcdoc = `<pre style="padding:24px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0">${escapeHtml(contentData.content)}</pre>`;
    } else {
      iframe.srcdoc = contentData.content;
    }

    body.querySelector('#detail-copy').onclick = async () => {
      const ok = await copyToClipboard(contentData.content);
      toast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : 'error');
    };
    body.querySelector('#detail-use').onclick = async () => {
      try {
        await api(`/api/content-templates/${id}/use`, { method: 'POST' });
        toast('已记录使用');
        loadDetail(body, id, navigate);
      } catch (e) {
        toast(e.message || '操作失败', 'error');
      }
    };
    if (isOwner || isAdmin) {
      body.querySelector('#detail-edit').onclick = () => navigate('/market/my');
    }
  } catch (e) {
    body.innerHTML = '<div class="ct-empty">加载失败或模板未上架</div>';
  }
}

// ============================================================
// 提交页
// ============================================================

async function renderSubmit(container, prefill, navigate) {
  const body = renderMarketShell(container, { active: 'submit', navigate });
  // 加载分类
  let cats = [];
  try {
    const data = await api('/api/content-templates/categories');
    cats = data.categories || [];
  } catch { /* ignore */ }

  body.innerHTML = `
    <div class="market-form">
      <div class="market-form-row">
        <label class="market-form-label">分类 *</label>
        <select id="submit-category" class="market-select">
          <option value="">请选择分类</option>
          ${cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="market-form-row">
        <label class="market-form-label">文件类型 *</label>
        <select id="submit-filetype" class="market-select">
          <option value="html">HTML</option>
          <option value="markdown">Markdown</option>
        </select>
      </div>
      <div class="market-form-row">
        <label class="market-form-label">标题 *</label>
        <input type="text" id="submit-title" class="market-input" placeholder="如：商务路演 PPT">
      </div>
      <div class="market-form-row">
        <label class="market-form-label">描述</label>
        <textarea id="submit-desc" class="market-textarea" rows="3" placeholder="链接：...&#10;风格关键词：...&#10;适合内容：..."></textarea>
      </div>
      <div class="market-form-row">
        <label class="market-form-label">内容 *</label>
        <textarea id="submit-content" class="market-textarea market-textarea-code" rows="14" placeholder="粘贴 HTML 或 Markdown 内容"></textarea>
      </div>
      <div class="market-form-preview">
        <label class="market-form-label">实时预览</label>
        <iframe class="market-form-preview-iframe" id="submit-preview" sandbox="allow-scripts"></iframe>
      </div>
      <div class="market-form-actions">
        <button class="btn" id="submit-cancel">取消</button>
        <button class="btn btn-primary" id="submit-go">提交审核</button>
      </div>
      <p class="market-form-hint">提交后进入待审核状态，管理员审核通过并设为展示后才会出现在市场。</p>
    </div>
  `;

  const titleEl = body.querySelector('#submit-title');
  const descEl = body.querySelector('#submit-desc');
  const contentEl = body.querySelector('#submit-content');
  const filetypeEl = body.querySelector('#submit-filetype');
  const previewIframe = body.querySelector('#submit-preview');

  if (prefill) {
    titleEl.value = prefill.title || '';
    descEl.value = prefill.description || '';
    contentEl.value = prefill.content || '';
    filetypeEl.value = prefill.file_type || 'html';
  }

  // 实时预览
  let previewTimer;
  const updatePreview = () => {
    const content = contentEl.value;
    if (filetypeEl.value === 'markdown') {
      previewIframe.srcdoc = `<pre style="padding:16px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0">${escapeHtml(content)}</pre>`;
    } else {
      previewIframe.srcdoc = content || '<div style="padding:24px;color:#999">预览区</div>';
    }
  };
  contentEl.addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 400); });
  filetypeEl.addEventListener('change', updatePreview);
  updatePreview();

  body.querySelector('#submit-cancel').onclick = () => navigate('/market');
  body.querySelector('#submit-go').onclick = async () => {
    const title = titleEl.value.trim();
    const content = contentEl.value;
    const categoryId = parseInt(body.querySelector('#submit-category').value);
    if (!title) return toast('请填写标题', 'error');
    if (!content) return toast('请填写内容', 'error');
    if (!categoryId) return toast('请选择分类', 'error');
    if (new TextEncoder().encode(content).length > MAX_SIZE) return toast('内容不能超过 500KB', 'error');

    try {
      await api('/api/content-templates', {
        method: 'POST',
        body: {
          title,
          description: descEl.value.trim() || undefined,
          fileType: filetypeEl.value,
          categoryId,
          content,
        },
      });
      toast('已提交，等待审核');
      navigate('/market/my');
    } catch (e) {
      toast(e.message || '提交失败', 'error');
    }
  };
}

// ============================================================
// 我的上架
// ============================================================

const mineState = { status: '', page: 1 };

function renderMine(container, navigate) {
  const body = renderMarketShell(container, { active: 'my', navigate });
  body.innerHTML = `
    <div class="filter-chips" id="mine-tabs">
      <button class="filter-chip ${!mineState.status ? 'active' : ''}" data-status="">全部</button>
      <button class="filter-chip ${mineState.status === 'pending' ? 'active' : ''}" data-status="pending">审核中</button>
      <button class="filter-chip ${mineState.status === 'approved' ? 'active' : ''}" data-status="approved">已上架</button>
      <button class="filter-chip ${mineState.status === 'rejected' ? 'active' : ''}" data-status="rejected">被拒</button>
      <button class="filter-chip ${mineState.status === 'draft' ? 'active' : ''}" data-status="draft">草稿</button>
    </div>
    <div id="mine-list" class="market-list"></div>
  `;

  body.querySelectorAll('#mine-tabs .filter-chip').forEach(chip => {
    chip.onclick = () => {
      mineState.status = chip.dataset.status;
      mineState.page = 1;
      body.querySelectorAll('#mine-tabs .filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      loadMineList(body, navigate);
    };
  });

  loadMineList(body, navigate);
}

async function loadMineList(body, navigate) {
  const list = body.querySelector('#mine-list');
  if (!list) return;
  list.innerHTML = '<div class="ct-loading">加载中...</div>';

  const params = new URLSearchParams();
  params.set('page', mineState.page);
  if (mineState.status) params.set('status', mineState.status);

  try {
    const data = await api('/api/content-templates/mine?' + params.toString());
    renderMineList(list, data.templates || [], data.pagination, navigate);
  } catch (e) {
    list.innerHTML = '<div class="ct-empty">加载失败</div>';
  }
}

function renderMineList(list, templates, pg, navigate) {
  if (!templates.length) {
    list.innerHTML = '<div class="ct-empty">暂无模板。点击「提交模板」上架你的作品。</div>';
    return;
  }
  list.innerHTML = templates.map(t => {
    const statusBadge = STATUS_BADGE[t.status] || '';
    const reviewNote = t.status === 'rejected' && t.review_note
      ? `<div class="mine-review-note">审核意见：${escapeHtml(t.review_note)}</div>` : '';
    const cat = t.category_name ? `<span class="ct-badge ct-badge-scene">${escapeHtml(t.category_name)}</span>` : '';
    const typeLabel = t.file_type === 'markdown' ? 'MD' : 'HTML';
    return `<div class="mine-item" data-id="${t.id}">
      <div class="mine-item-main">
        <div class="mine-item-title">${escapeHtml(t.title)} ${statusBadge}</div>
        <div class="mine-item-meta">${cat}<span class="ct-badge ${t.file_type === 'markdown' ? 'ct-badge-md' : 'ct-badge-html'}">${typeLabel}</span> · ${relativeTime(t.submitted_at || t.created_at)}</div>
        ${reviewNote}
      </div>
      <div class="mine-item-actions">
        ${t.status !== 'archived' ? `<button class="btn btn-small" data-act="edit">编辑</button>` : ''}
        ${t.status !== 'archived' ? `<button class="btn btn-small btn-danger" data-act="archive">归档</button>` : ''}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.mine-item').forEach(item => {
    const id = parseInt(item.dataset.id);
    item.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = async () => {
        const act = btn.dataset.act;
        if (act === 'archive') {
          const ok = await dialogModal.confirm({ message: '确定归档此模板？归档后将从市场移除。', confirmText: '归档', danger: true });
          if (!ok) return;
          try {
            await api(`/api/content-templates/${id}`, { method: 'DELETE' });
            toast('已归档');
            loadMineList(list.closest('#market-body'), navigate);
          } catch (e) { toast(e.message || '操作失败', 'error'); }
        } else if (act === 'edit') {
          // 跳提交页编辑（简化：加载内容后预填）—— 第一版用重新提交语义
          try {
            const [meta, content] = await Promise.all([
              api(`/api/content-templates/${id}`),
              api(`/api/content-templates/${id}/content`),
            ]);
            editExisting(list.closest('#market-body'), { ...meta, content }, navigate);
          } catch (e) { toast(e.message || '加载失败', 'error'); }
        }
      };
    });
  });
}

// 编辑现有模板：在 body 内就地渲染编辑表单（复用提交表单结构，但走 PUT）
async function editExisting(body, data, navigate) {
  let cats = [];
  try {
    const c = await api('/api/content-templates/categories');
    cats = c.categories || [];
  } catch { /* ignore */ }

  body.innerHTML = `
    <div class="market-form">
      <h3 class="market-form-title">编辑模板（保存后重新进入审核）</h3>
      <div class="market-form-row">
        <label class="market-form-label">分类 *</label>
        <select id="edit-category" class="market-select">
          <option value="">请选择分类</option>
          ${cats.map(c => `<option value="${c.id}" ${c.id === data.category_id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="market-form-row">
        <label class="market-form-label">文件类型 *</label>
        <select id="edit-filetype" class="market-select">
          <option value="html" ${data.file_type === 'html' ? 'selected' : ''}>HTML</option>
          <option value="markdown" ${data.file_type === 'markdown' ? 'selected' : ''}>Markdown</option>
        </select>
      </div>
      <div class="market-form-row">
        <label class="market-form-label">标题 *</label>
        <input type="text" id="edit-title" class="market-input" value="${escapeHtml(data.title || '')}">
      </div>
      <div class="market-form-row">
        <label class="market-form-label">描述</label>
        <textarea id="edit-desc" class="market-textarea" rows="3">${escapeHtml(data.description || '')}</textarea>
      </div>
      <div class="market-form-row">
        <label class="market-form-label">内容 *</label>
        <textarea id="edit-content" class="market-textarea market-textarea-code" rows="14">${escapeHtml(data.content || '')}</textarea>
      </div>
      <div class="market-form-actions">
        <button class="btn" id="edit-cancel">取消</button>
        <button class="btn btn-primary" id="edit-save">保存（重新审核）</button>
      </div>
    </div>
  `;

  body.querySelector('#edit-cancel').onclick = () => renderMine(body.closest('#app').querySelector('#market-body') || body, navigate);
  body.querySelector('#edit-cancel').onclick = () => { navigate('/market/my'); };
  body.querySelector('#edit-save').onclick = async () => {
    const title = body.querySelector('#edit-title').value.trim();
    const content = body.querySelector('#edit-content').value;
    const categoryId = parseInt(body.querySelector('#edit-category').value);
    if (!title) return toast('请填写标题', 'error');
    if (!content) return toast('请填写内容', 'error');
    if (!categoryId) return toast('请选择分类', 'error');
    try {
      await api(`/api/content-templates/${data.id}`, {
        method: 'PUT',
        body: {
          title,
          description: body.querySelector('#edit-desc').value.trim() || undefined,
          fileType: body.querySelector('#edit-filetype').value,
          categoryId,
          content,
        },
      });
      toast('已保存，重新进入审核');
      navigate('/market/my');
    } catch (e) {
      toast(e.message || '保存失败', 'error');
    }
  };
}

const STATUS_BADGE = {
  draft: '<span class="ct-status-badge ct-status-draft">草稿</span>',
  pending: '<span class="ct-status-badge ct-status-pending">审核中</span>',
  approved: '<span class="ct-status-badge ct-status-approved">已通过</span>',
  rejected: '<span class="ct-status-badge ct-status-rejected">被拒</span>',
  archived: '<span class="ct-status-badge ct-status-archived">已归档</span>',
};

// ============================================================
// 管理页
// ============================================================

const adminState = { status: 'pending', page: 1 };

function renderAdmin(container, navigate) {
  const body = renderMarketShell(container, { active: 'admin', navigate });
  body.innerHTML = `
    <div class="market-admin">
      <div class="market-admin-tabs">
        <div class="filter-chips" id="admin-tabs">
          <button class="filter-chip ${adminState.status === 'pending' ? 'active' : ''}" data-status="pending">待审核</button>
          <button class="filter-chip ${adminState.status === 'approved' ? 'active' : ''}" data-status="approved">已上架</button>
          <button class="filter-chip ${adminState.status === 'rejected' ? 'active' : ''}" data-status="rejected">已拒绝</button>
          <button class="filter-chip ${adminState.status === 'archived' ? 'active' : ''}" data-status="archived">已归档</button>
          <button class="filter-chip ${!adminState.status ? 'active' : ''}" data-status="">全部</button>
        </div>
        <button class="btn btn-small" id="admin-category-mgr">分类管理</button>
      </div>
      <div id="admin-list" class="market-list"></div>
    </div>
  `;

  body.querySelectorAll('#admin-tabs .filter-chip').forEach(chip => {
    chip.onclick = () => {
      adminState.status = chip.dataset.status;
      adminState.page = 1;
      body.querySelectorAll('#admin-tabs .filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      loadAdminList(body, navigate);
    };
  });

  body.querySelector('#admin-category-mgr').onclick = () => openCategoryManager(body, navigate);

  loadAdminList(body, navigate);
}

async function loadAdminList(body, navigate) {
  const list = body.querySelector('#admin-list');
  if (!list) return;
  list.innerHTML = '<div class="ct-loading">加载中...</div>';

  const params = new URLSearchParams();
  params.set('page', adminState.page);
  params.set('limit', '20');
  if (adminState.status) params.set('status', adminState.status);

  try {
    const data = await api('/api/content-templates/admin/list?' + params.toString());
    renderAdminList(list, data.templates || [], data.pagination, navigate, body);
  } catch (e) {
    list.innerHTML = '<div class="ct-empty">加载失败</div>';
  }
}

function renderAdminList(list, templates, pg, navigate, body) {
  if (!templates.length) {
    list.innerHTML = '<div class="ct-empty">暂无模板</div>';
    return;
  }
  list.innerHTML = templates.map(t => {
    const statusBadge = STATUS_BADGE[t.status] || '';
    const cat = t.category_name ? escapeHtml(t.category_name) : '未分类';
    const reviewNote = t.review_note ? `<div class="mine-review-note">审核意见：${escapeHtml(t.review_note)}</div>` : '';
    return `<div class="mine-item admin-item" data-id="${t.id}">
      <div class="mine-item-main">
        <div class="mine-item-title">${escapeHtml(t.title)} ${statusBadge} ${t.featured ? '<span class="ct-badge ct-badge-featured">精选</span>' : ''}</div>
        <div class="mine-item-meta">${cat} · 作者：${escapeHtml(t.uploader_name || '-')} · 使用 ${t.use_count} 次</div>
        ${reviewNote}
      </div>
      <div class="mine-item-actions">
        <button class="btn btn-small" data-act="preview">预览</button>
        ${t.status === 'pending' ? `<button class="btn btn-small btn-primary" data-act="approve">通过</button>` : ''}
        ${t.status === 'pending' ? `<button class="btn btn-small btn-danger" data-act="reject">拒绝</button>` : ''}
        ${t.status === 'approved' ? `<button class="btn btn-small" data-act="toggle-vis">${t.visibility === 'visible' ? '隐藏' : '展示'}</button>` : ''}
        ${t.status === 'approved' ? `<button class="btn btn-small" data-act="feature">${t.featured ? '取消精选' : '精选'}</button>` : ''}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.admin-item').forEach(item => {
    const id = parseInt(item.dataset.id);
    item.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = async () => {
        const act = btn.dataset.act;
        try {
          if (act === 'preview') {
            const data = await api(`/api/content-templates/admin/${id}/content`);
            previewInDialog(data);
          } else if (act === 'approve') {
            const vis = await dialogModal.confirm({ message: '通过后是否展示到市场？', confirmText: '展示', cancelText: '通过但不展示' });
            // confirm=true → 展示；cancel(=false) → 通过但隐藏
            await api(`/api/content-templates/${id}/review`, {
              method: 'POST',
              body: { status: 'approved', visibility: vis ? 'visible' : 'hidden', reviewNote: '审核通过' },
            });
            toast(vis ? '已通过并展示' : '已通过（隐藏）');
            loadAdminList(body, navigate);
          } else if (act === 'reject') {
            const note = await dialogModal.prompt({ message: '请填写拒绝原因', label: '审核意见', confirmText: '拒绝' });
            if (note === null) return;
            await api(`/api/content-templates/${id}/review`, {
              method: 'POST', body: { status: 'rejected', reviewNote: note || '未通过' },
            });
            toast('已拒绝');
            loadAdminList(body, navigate);
          } else if (act === 'toggle-vis') {
            const vis = btn.textContent.trim() === '隐藏' ? 'hidden' : 'visible';
            await api(`/api/content-templates/${id}/admin`, { method: 'PATCH', body: { visibility: vis } });
            toast(vis === 'hidden' ? '已隐藏' : '已展示');
            loadAdminList(body, navigate);
          } else if (act === 'feature') {
            const featured = btn.textContent.includes('取消精选');
            await api(`/api/content-templates/${id}/admin`, { method: 'PATCH', body: { featured: !featured } });
            toast(!featured ? '已设为精选' : '已取消精选');
            loadAdminList(body, navigate);
          }
        } catch (e) {
          toast(e.message || '操作失败', 'error');
        }
      };
    });
  });
}

function previewInDialog(data) {
  const win = window.open('', '_blank');
  if (!win) { toast('请允许弹窗以预览', 'error'); return; }
  if (data.file_type === 'markdown') {
    win.document.write(`<pre style="padding:24px;font-size:14px;white-space:pre-wrap;word-break:break-word">${escapeHtml(data.content)}</pre>`);
  } else {
    win.document.write(data.content);
  }
  win.document.close();
}

// ---- 分类管理（内嵌面板） ----

async function openCategoryManager(body, navigate) {
  let cats = [];
  try {
    const data = await api('/api/content-templates/admin/categories');
    cats = data.categories || [];
  } catch (e) { toast(e.message || '加载失败', 'error'); return; }

  body.innerHTML = `
    <div class="market-cat-mgr">
      <div class="market-cat-mgr-head">
        <h3 class="market-form-title">分类管理</h3>
        <button class="btn btn-small" id="cat-back">返回</button>
      </div>
      <div class="market-cat-add">
        <input type="text" id="cat-slug" class="market-input" placeholder="slug（如 html-doc）">
        <input type="text" id="cat-name" class="market-input" placeholder="名称（如 HTML-DOC）">
        <input type="number" id="cat-order" class="market-input market-input-narrow" placeholder="排序" value="0">
        <button class="btn btn-primary btn-small" id="cat-add">新增</button>
      </div>
      <div id="cat-list" class="market-list">
        ${cats.map(c => `
          <div class="mine-item" data-id="${c.id}">
            <div class="mine-item-main">
              <div class="mine-item-title">${escapeHtml(c.name)} ${c.is_enabled ? '' : '<span class="ct-status-badge ct-status-archived">已停用</span>'}</div>
              <div class="mine-item-meta">slug: ${escapeHtml(c.slug)} · 排序 ${c.sort_order} · ${c.template_count} 个模板</div>
              ${c.description ? `<div class="mine-review-note">${escapeHtml(c.description)}</div>` : ''}
            </div>
            <div class="mine-item-actions">
              <button class="btn btn-small" data-act="toggle">${c.is_enabled ? '停用' : '启用'}</button>
              <button class="btn btn-small btn-danger" data-act="del">删除</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  body.querySelector('#cat-back').onclick = () => renderAdmin(body.closest('#app').querySelector('#market-body') || body, navigate);
  body.querySelector('#cat-back').onclick = () => { adminState.status = adminState.status || 'pending'; navigate('/market/admin'); };

  body.querySelector('#cat-add').onclick = async () => {
    const slug = body.querySelector('#cat-slug').value.trim();
    const name = body.querySelector('#cat-name').value.trim();
    const sortOrder = parseInt(body.querySelector('#cat-order').value) || 0;
    if (!slug || !name) return toast('slug 和名称必填', 'error');
    try {
      await api('/api/content-templates/admin/categories', { method: 'POST', body: { slug, name, sortOrder } });
      toast('已新增');
      openCategoryManager(body, navigate);
    } catch (e) { toast(e.message || '新增失败', 'error'); }
  };

  body.querySelectorAll('#cat-list .mine-item').forEach(item => {
    const id = item.dataset.id;
    item.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = async () => {
        const act = btn.dataset.act;
        try {
          if (act === 'toggle') {
            const enable = btn.textContent.trim() === '启用';
            await api(`/api/content-templates/admin/categories/${id}`, { method: 'PUT', body: { isEnabled: enable } });
            toast(enable ? '已启用' : '已停用');
            openCategoryManager(body, navigate);
          } else if (act === 'del') {
            const ok = await dialogModal.confirm({ message: '确定删除此分类？若分类下有模板将改为停用。', confirmText: '删除', danger: true });
            if (!ok) return;
            const res = await api(`/api/content-templates/admin/categories/${id}`, { method: 'DELETE' });
            toast(res.disabled ? '分类下有模板，已停用' : '已删除');
            openCategoryManager(body, navigate);
          }
        } catch (e) { toast(e.message || '操作失败', 'error'); }
      };
    });
  });
}
