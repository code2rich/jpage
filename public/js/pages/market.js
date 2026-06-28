// 内容模板市场：独立路由页面。
// 子路由：#/market（首页）/ :id（详情）/ submit（提交）/ my（我的上架）/ admin（管理）。

import { api } from '../api.js';
import { state } from '../app.js';
import { toast } from '../components/toast.js';
import { dialogModal } from '../components/dialog.js';
import { escapeHtml, relativeTime, copyToClipboard, openModal, closeModal } from '../utils.js';


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
  iframe.onload = () => { if (loadingEl) loadingEl.remove(); };
  iframe.onerror = () => { if (loadingEl) loadingEl.remove(); };
  iframe.src = `/api/content-templates/market/${id}/preview-html`;
}

// ============================================================
// 通用 UI：加载 / 空态 / 错误（带重试）
// ============================================================

function renderLoading(container, { overlay = false, list = false } = {}) {
  if (overlay) {
    const el = document.createElement('div');
    el.className = 'ct-loading-overlay';
    return el;
  }
  const cls = list ? 'ct-list-loading' : 'ct-loading';
  container.innerHTML = `<div class="${cls}">加载中…</div>`;
}

function renderEmpty(container, { title, desc = '', actionHtml = '', list = false } = {}) {
  const cls = list ? 'ct-list-empty' : 'ct-empty';
  container.innerHTML = `<div class="${cls}"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(desc)}</span>${actionHtml}</div>`;
}

function renderError(container, { message, retry, list = false } = {}) {
  const cls = list ? 'ct-list-error' : 'ct-error';
  const id = 'ct-retry-' + Math.random().toString(36).slice(2, 8);
  container.innerHTML = `<div class="${cls}"><strong>${escapeHtml(message || '加载失败')}</strong><span>请检查网络后重试</span><div class="${list ? 'ct-list-empty-action' : 'ct-empty-action'}"><button class="btn btn-small" id="${id}">重试</button></div></div>`;
  container.querySelector('#' + id)?.addEventListener('click', retry);
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
  if (path === '/market/submit') {
    const body = renderMarketShell(container, { active: 'my', navigate });
    body.innerHTML = '<div class="ct-empty">上架入口已移至文件列表。请在首页文件列表对某个文件点「⋯ → 上架到市场」。</div>';
    return;
  }
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

function renderMarketShell(container, { active, navigate }) {
  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  const go = typeof navigate === 'function' ? navigate : (path) => { location.hash = path; };
  container.innerHTML = `
    <div class="market-page mw-market-page">
      <aside class="mw-sidebar">
        <a href="#/" class="mw-brand" aria-label="返回首页">
          <img class="mw-brand-mark" src="/jpage_logo/jpage-app-icon.svg" alt="即页">
          <span class="mw-brand-text">JPage<br><strong>Market</strong></span>
        </a>
        <nav class="mw-side-nav">
          <a href="#/market" class="${active === 'home' ? 'active' : ''}">首页</a>
          <div id="mw-side-cats"></div>
        </nav>
        <div class="mw-side-section">
          <div class="mw-side-title">管理</div>
          <a href="#/market/my" class="${active === 'my' ? 'active' : ''}">我的上架</a>
          ${isAdmin ? '<a href="#/market/admin" class="' + (active === 'admin' ? 'active admin-only' : 'admin-only') + '">市场管理</a>' : ''}
        </div>
        <div class="mw-side-footer">
          <a href="#/">返回我的页面</a>
        </div>
      </aside>
      <main class="mw-main" id="market-body"></main>
    </div>
  `;
  const body = container.querySelector('#market-body');
  // 侧边栏分类异步加载（数据驱动，不再写死）
  loadSideCategories(container, go);
  return body;
}

// 侧边栏分类：从 /categories 拉取真实分类，点击设筛选并回到首页。
// 当前选中分类用 homeState.category 高亮，与首页顶部分类 chips 共享状态。
async function loadSideCategories(container, go) {
  const wrap = container.querySelector('#mw-side-cats');
  if (!wrap) return;
  try {
    const data = await api('/api/content-templates/categories');
    const cats = data.categories || [];
    const all = `<button type="button" class="${!homeState.category ? 'active' : ''}" data-side-category="">全部作品</button>`;
    const items = cats.map(c =>
      `<button type="button" class="${homeState.category === c.slug ? 'active' : ''}" data-side-category="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</button>`
    ).join('');
    wrap.innerHTML = all + items;
    wrap.querySelectorAll('[data-side-category]').forEach(btn => {
      btn.addEventListener('click', () => {
        homeState.category = btn.dataset.sideCategory || '';
        homeState.page = 1;
        saveHomeState();
        go('/market');
      });
    });
  } catch {
    // 拉取失败仅置空，不阻塞页面（首页顶部分类条仍可独立加载）
    wrap.innerHTML = '';
  }
}

// ============================================================
// 市场首页
// ============================================================

const homeState = { category: '', keyword: '', sort: '', fileType: '', page: 1 };
let currentHomeRequest = null;
let homeScrollObserver = null;
let marketShortcutBound = false;

function saveHomeState() {
  try { sessionStorage.setItem('marketHomeState', JSON.stringify(homeState)); } catch (_) {}
}

function restoreHomeState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('marketHomeState') || '{}');
    if (saved.category !== undefined) homeState.category = saved.category;
    if (saved.keyword !== undefined) homeState.keyword = saved.keyword;
    if (saved.sort !== undefined) homeState.sort = saved.sort;
    if (saved.fileType !== undefined) homeState.fileType = saved.fileType;
    if (saved.page !== undefined) homeState.page = saved.page;
  } catch (_) {}
}

function hasActiveFilters() {
  return !!(homeState.keyword || homeState.category || homeState.sort || homeState.fileType);
}

function renderSkeletonCards(n) {
  let html = '<div class="ct-skeleton-grid">';
  for (let i = 0; i < n; i++) {
    html += '<div class="ct-skeleton-card">'
      + '<div class="ct-skeleton-thumb"></div>'
      + '<div class="ct-skeleton-lines">'
      + '<div class="ct-skeleton-line w70"></div>'
      + '<div class="ct-skeleton-line w40"></div>'
      + '</div></div>';
  }
  html += '</div>';
  return html;
}

function renderHome(container, navigate) {
  restoreHomeState();
  const go = navigate || ((path) => { location.hash = path; });
  const body = renderMarketShell(container, { active: 'home', navigate });
  body.innerHTML = `
    <div class="mw-filter-bar">
      <div class="mw-search-wrap">
        <span aria-hidden="true">⌕</span>
        <input type="search" id="market-search" autocomplete="off" placeholder="搜索页面、工作流、主题、创作者" value="${escapeHtml(homeState.keyword)}">
        <button type="button" id="market-search-clear" class="mw-search-clear hidden" aria-label="清空搜索">×</button>
      </div>
      <div class="mw-top-actions">
        <div class="mw-segmented-tabs" id="market-sort-tabs" role="tablist" aria-label="排序">
          <button type="button" data-sort="" class="${homeState.sort === '' ? 'active' : ''}">热门优先</button>
          <button type="button" data-sort="created_at" class="${homeState.sort === 'created_at' ? 'active' : ''}">最新发布</button>
          <button type="button" data-sort="featured" class="${homeState.sort === 'featured' ? 'active' : ''}">精选优先</button>
        </div>
        <div class="mw-type-chips" id="market-type-chips" role="group" aria-label="文件类型">
          <button type="button" data-type="" class="${homeState.fileType === '' ? 'active' : ''}">全部</button>
          <button type="button" data-type="html" class="${homeState.fileType === 'html' ? 'active' : ''}">HTML</button>
          <button type="button" data-type="markdown" class="${homeState.fileType === 'markdown' ? 'active' : ''}">MD</button>
        </div>
        <button type="button" id="market-clear-filters" class="btn btn-small mw-clear-filters hidden">清除全部</button>
        <a href="#/market/my" class="btn btn-small">我的上架</a>
      </div>
    </div>
    <div class="mw-category-scroll" id="market-category-scroll">
      <button type="button" class="mw-cat-scroll-btn left hidden" id="market-cat-left" aria-label="向左滚动">‹</button>
      <div class="mw-category-row" id="market-category-chips"></div>
      <button type="button" class="mw-cat-scroll-btn right hidden" id="market-cat-right" aria-label="向右滚动">›</button>
    </div>
    <section class="mw-feed-head">
      <div>
        <h1>推荐作品</h1>
        <p>浏览、筛选和创建可复用页面资产。</p>
      </div>
      <span id="mw-result-count" aria-live="polite" aria-atomic="true">-</span>
    </section>
    <div id="market-grid" class="ct-grid mw-grid"></div>
    <div class="mw-load-more-wrap" id="market-load-more"></div>
    <button type="button" class="mw-back-to-top hidden" id="market-back-to-top" aria-label="回到顶部">↑</button>
  `;

  const searchInput = body.querySelector('#market-search');
  const searchClear = body.querySelector('#market-search-clear');
  let searchTimer;
  function updateSearchClear() {
    searchClear.classList.toggle('hidden', !searchInput.value);
  }
  updateSearchClear();

  searchInput.addEventListener('input', () => {
    updateSearchClear();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      homeState.keyword = searchInput.value.trim();
      saveHomeState();
      loadHomeList(body, go, { reset: true });
    }, 300);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    updateSearchClear();
    searchInput.focus();
    homeState.keyword = '';
    saveHomeState();
    loadHomeList(body, go, { reset: true });
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (searchInput.value) {
        searchInput.value = '';
        updateSearchClear();
        homeState.keyword = '';
        saveHomeState();
        loadHomeList(body, go, { reset: true });
      }
    }
  });

  body.querySelectorAll('#market-sort-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      const sort = btn.dataset.sort;
      homeState.sort = sort;
      saveHomeState();
      body.querySelectorAll('#market-sort-tabs button').forEach(b => b.classList.toggle('active', b.dataset.sort === sort));
      loadHomeList(body, go, { reset: true });
    });
  });

  body.querySelectorAll('#market-type-chips button').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      homeState.fileType = type;
      saveHomeState();
      body.querySelectorAll('#market-type-chips button').forEach(b => b.classList.toggle('active', b.dataset.type === type));
      loadHomeList(body, go, { reset: true });
    });
  });

  body.querySelector('#market-clear-filters').addEventListener('click', () => {
    clearAllFilters(body, go);
  });

  const backToTop = body.querySelector('#market-back-to-top');
  function onScroll() {
    const y = window.scrollY || window.pageYOffset;
    backToTop.classList.toggle('hidden', y < 600);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  backToTop.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  onScroll();

  if (!marketShortcutBound) {
    marketShortcutBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        const input = document.getElementById('market-search');
        if (!input) return;
        e.preventDefault();
        input.focus();
      }
    });
  }

  loadCategoryChips(body, go).then(() => loadHomeList(body, go, { reset: true }));
}

function clearAllFilters(body, navigate) {
  homeState.keyword = '';
  homeState.category = '';
  homeState.sort = '';
  homeState.fileType = '';
  homeState.page = 1;
  saveHomeState();
  const searchInput = body.querySelector('#market-search');
  if (searchInput) {
    searchInput.value = '';
    const clear = body.querySelector('#market-search-clear');
    if (clear) clear.classList.add('hidden');
  }
  body.querySelectorAll('#market-sort-tabs button').forEach(b => b.classList.toggle('active', b.dataset.sort === ''));
  body.querySelectorAll('#market-type-chips button').forEach(b => b.classList.toggle('active', b.dataset.type === ''));
  updateCategoryChipsActive(body);
  loadHomeList(body, navigate, { reset: true });
}

function updateCategoryChipsActive(body) {
  const chipsEl = body.querySelector('#market-category-chips');
  if (chipsEl) {
    chipsEl.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.category === homeState.category));
  }
  const side = document.querySelector('#mw-side-cats');
  if (side) {
    side.querySelectorAll('[data-side-category]').forEach(b => b.classList.toggle('active', b.dataset.sideCategory === homeState.category));
  }
}

function setupCategoryScroll(body) {
  const wrap = body.querySelector('#market-category-scroll');
  const row = body.querySelector('#market-category-chips');
  const leftBtn = body.querySelector('#market-cat-left');
  const rightBtn = body.querySelector('#market-cat-right');
  if (!wrap || !row || !leftBtn || !rightBtn || row.dataset.scrollBound) return;
  row.dataset.scrollBound = '1';
  function updateShadows() {
    const max = row.scrollWidth - row.clientWidth;
    wrap.classList.toggle('show-left', row.scrollLeft > 0);
    wrap.classList.toggle('show-right', row.scrollLeft < max - 1);
    leftBtn.classList.toggle('hidden', row.scrollLeft <= 0);
    rightBtn.classList.toggle('hidden', row.scrollLeft >= max - 1);
  }
  row.addEventListener('scroll', updateShadows, { passive: true });
  leftBtn.addEventListener('click', () => { row.scrollBy({ left: -200, behavior: 'smooth' }); });
  rightBtn.addEventListener('click', () => { row.scrollBy({ left: 200, behavior: 'smooth' }); });
  window.addEventListener('resize', updateShadows, { passive: true });
  updateShadows();
}

async function loadCategoryChips(body, navigate) {
  const chipsEl = body.querySelector('#market-category-chips');
  if (!chipsEl) return;
  try {
    const data = await api('/api/content-templates/categories');
    const cats = data.categories || [];
    const all = `<button type="button" class="filter-chip ${!homeState.category ? 'active' : ''}" data-category="">推荐</button>`;
    const items = cats.map(c =>
      `<button type="button" class="filter-chip ${homeState.category === c.slug ? 'active' : ''}" data-category="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</button>`
    ).join('');
    chipsEl.innerHTML = all + items;
    chipsEl.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        homeState.category = chip.dataset.category;
        saveHomeState();
        updateCategoryChipsActive(body);
        loadHomeList(body, navigate, { reset: true });
      });
    });
    setupCategoryScroll(body);
  } catch {
    chipsEl.innerHTML = '';
  }
}

async function loadHomeList(body, navigate, { reset = false } = {}) {
  const grid = body.querySelector('#market-grid');
  const loadMoreWrap = body.querySelector('#market-load-more');
  if (!grid) return;

  if (currentHomeRequest) {
    currentHomeRequest.abort();
    currentHomeRequest = null;
  }
  const controller = new AbortController();
  currentHomeRequest = controller;

  if (reset) {
    homeState.page = 1;
    resetThumbCache();
    grid.innerHTML = renderSkeletonCards(12);
    if (loadMoreWrap) loadMoreWrap.innerHTML = '';
    updateClearFilters(body);
  }

  const hasContent = !reset && grid.querySelectorAll('.ct-card').length > 0;
  let overlay = null;
  if (hasContent) {
    grid.style.position = 'relative';
    overlay = renderLoading(grid, { overlay: true });
    grid.appendChild(overlay);
  } else if (!reset) {
    grid.innerHTML = renderSkeletonCards(12);
  }

  const params = new URLSearchParams();
  params.set('page', homeState.page);
  params.set('limit', '12');
  if (homeState.category) params.set('category', homeState.category);
  if (homeState.keyword) params.set('keyword', homeState.keyword);
  if (homeState.sort) params.set('sort', homeState.sort);
  if (homeState.fileType) params.set('fileType', homeState.fileType);

  try {
    const data = await api('/api/content-templates/market?' + params.toString(), { signal: controller.signal });
    if (controller.signal.aborted) return;
    currentHomeRequest = null;
    const countEl = body.querySelector('#mw-result-count');
    if (countEl && data.pagination) countEl.textContent = `${data.pagination.total || 0} 个结果`;
    renderHomeGrid(grid, data.templates || [], data.pagination, navigate, { append: !reset });
    updateClearFilters(body);
  } catch (e) {
    if (e.name === 'AbortError') return;
    currentHomeRequest = null;
    if (overlay) overlay.remove();
    if (reset) {
      const title = homeState.keyword
        ? `搜索「${homeState.keyword}」失败`
        : (homeState.category ? '分类加载失败' : '加载失败');
      renderError(grid, {
        message: e.message || title,
        retry: () => loadHomeList(body, navigate, { reset: true }),
      });
    } else {
      toast(e.message || '加载失败', 'error');
      renderLoadMore(loadMoreWrap, navigate, body, true);
    }
  } finally {
    if (overlay) overlay.remove();
  }
}

function createTemplateCard(t) {
  const typeClass = t.file_type === 'markdown' ? 'ct-badge-md' : 'ct-badge-html';
  const typeLabel = t.file_type === 'markdown' ? 'MD' : 'HTML';
  const cat = t.category_name ? `<span class="ct-badge ct-badge-scene">${escapeHtml(t.category_name)}</span>` : '';
  const featured = t.featured ? '<span class="ct-badge ct-badge-featured">精选</span>' : '';
  const isLoggedIn = !!state.currentUser;
  return `<div class="ct-card mw-card" data-id="${t.id}" data-file-type="${t.file_type}" data-title="${escapeHtml(t.title)}" data-share-key="${escapeHtml(t.share_key || '')}" tabindex="0">
    <div class="ct-card-thumb">
      <div class="ct-card-thumb-wrap"><iframe class="ct-thumb-iframe" sandbox="allow-scripts"></iframe></div>
      <div class="ct-card-thumb-loading"></div>
      <div class="mw-card-top-actions">
        <button type="button" class="mw-icon-btn" data-act="copy" data-tip="复制链接" aria-label="复制链接" ${!isLoggedIn ? 'hidden' : ''}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </button>
      </div>
      <div class="mw-card-actions">
        <button type="button" data-act="preview">查看详情</button>
        <button type="button" data-act="use">使用模板</button>
      </div>
    </div>
    <div class="mw-card-meta-row">${cat}${featured}<span class="ct-badge ${typeClass}">${typeLabel}</span></div>
    <div class="ct-card-header">
      <span class="ct-card-title">${escapeHtml(t.title)}</span>
    </div>
    <p class="ct-card-desc">${escapeHtml(t.description || '').slice(0, 100)}</p>
    <div class="mw-card-author">${escapeHtml(t.uploader_name || '匿名创作者')}</div>
    <div class="ct-card-footer">
      <span class="ct-use-count">${t.instantiation_count || 0} 次使用</span>
    </div>
  </div>`;
}

async function showTemplateUseGuide({ id, title }) {
  try {
    const guide = await api(`/api/content-templates/${id}/use-guide`);

    dialogModal.alert({
      title: `使用《${title}》`,
      message: `
        <div class="use-template-dialog">
          <p class="use-template-tip">「使用模板」会创建一个可编辑文件到您的账户。该操作需通过 CLI 或 MCP 用 Token 完成，Web 端仅作引导。</p>
          <div class="use-template-field">
            <div class="use-template-field-header">
              <label>CLI 命令</label>
              <button type="button" id="btn-copy-cli" class="btn btn-small btn-copy-prompt">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2z"/><path d="M4 15V5a2 2 0 0 1 2-2h8"/></svg>
                <span>复制</span>
              </button>
            </div>
            <textarea id="use-template-cli" class="use-template-textarea" readonly>${escapeHtml(guide.cliWithName || guide.cli)}</textarea>
          </div>
          <div class="use-template-field">
            <div class="use-template-field-header">
              <label>MCP 工具</label>
              <button type="button" id="btn-copy-mcp" class="btn btn-small btn-copy-prompt">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2z"/><path d="M4 15V5a2 2 0 0 1 2-2h8"/></svg>
                <span>复制参数</span>
              </button>
            </div>
            <textarea id="use-template-mcp" class="use-template-textarea" readonly>${escapeHtml(JSON.stringify(guide.mcp, null, 2))}</textarea>
          </div>
          <p class="use-template-hint">${escapeHtml(guide.hint || '')}</p>
        </div>
      `,
      confirmText: '关闭'
    });

    setTimeout(() => {
      const cliBtn = document.getElementById('btn-copy-cli');
      const mcpBtn = document.getElementById('btn-copy-mcp');
      const cliTa = document.getElementById('use-template-cli');
      const mcpTa = document.getElementById('use-template-mcp');
      if (cliBtn && cliTa) {
        cliBtn.addEventListener('click', async () => {
          const ok = await copyToClipboard(cliTa.value);
          toast(ok ? 'CLI 命令已复制' : '复制失败', ok ? 'success' : 'error');
        });
        cliTa.addEventListener('focus', () => cliTa.select());
      }
      if (mcpBtn && mcpTa) {
        mcpBtn.addEventListener('click', async () => {
          const ok = await copyToClipboard(mcpTa.value);
          toast(ok ? 'MCP 参数已复制' : '复制失败', ok ? 'success' : 'error');
        });
        mcpTa.addEventListener('focus', () => mcpTa.select());
      }
    }, 0);
  } catch (err) {
    toast(err.message || '获取使用引导失败', 'error');
  }
}

function setupCardInteractions(grid, navigate) {
  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('.ct-card');
    if (btn && card) {
      const id = card.dataset.id;
      const title = card.dataset.title || '该模板';
      const act = btn.dataset.act;
      e.stopPropagation();
      if (act === 'use') {
        await showTemplateUseGuide({ id, title });
        return;
      }
      if (act === 'copy') {
        if (!state.currentUser) {
          toast('请先登录后复制链接', 'error');
          return;
        }
        try {
          const data = await api(`/api/content-templates/${id}/share`, { method: 'POST' });
          const url = `${location.origin}/t/${data.key}`;
          const ok = await copyToClipboard(url);
          toast(ok ? '已复制公开链接' : '复制失败', ok ? 'success' : 'error');
        } catch (err) {
          toast(err.message || '复制链接失败', 'error');
        }
        return;
      }
      if (act === 'preview') {
        try { sessionStorage.setItem('marketScrollY', String(window.scrollY)); } catch (_) {}
        navigate(`/market/${id}`);
        return;
      }
    }
    if (card) {
      e.stopPropagation();
      try { sessionStorage.setItem('marketScrollY', String(window.scrollY)); } catch (_) {}
      navigate(`/market/${card.dataset.id}`);
    }
  });

  grid.querySelectorAll('.ct-card').forEach(card => {
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        try { sessionStorage.setItem('marketScrollY', String(window.scrollY)); } catch (_) {}
        navigate(`/market/${card.dataset.id}`);
      }
    });
  });
}

function renderLoadMore(wrap, navigate, body, error = false, pg = null) {
  if (!wrap) return;
  if (error) {
    wrap.innerHTML = '<button type="button" class="mw-load-more-btn" id="market-retry">加载失败，点击重试</button>';
    wrap.querySelector('#market-retry').addEventListener('click', () => loadHomeList(body, navigate, { reset: false }));
    return;
  }
  if (!pg || pg.page >= pg.totalPages) {
    if (pg && pg.totalPages > 1) {
      wrap.innerHTML = '<div class="mw-end-msg">没有更多了</div>';
    } else {
      wrap.innerHTML = '';
    }
    const sentinel = body?.querySelector('#market-scroll-sentinel');
    if (sentinel && homeScrollObserver) homeScrollObserver.unobserve(sentinel);
    return;
  }
  wrap.innerHTML = '<button type="button" class="mw-load-more-btn" id="market-load-more-btn">加载更多</button>';
  const btn = wrap.querySelector('#market-load-more-btn');
  btn.addEventListener('click', () => {
    homeState.page++;
    saveHomeState();
    loadHomeList(body, navigate, { reset: false });
  });
  setupInfiniteScroll(body);
}

function setupInfiniteScroll(body) {
  const sentinel = body?.querySelector('#market-scroll-sentinel');
  if (!sentinel) return;
  if (!homeScrollObserver) {
    homeScrollObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const btn = document.getElementById('market-load-more-btn');
        if (btn && !btn.disabled) btn.click();
      });
    }, { rootMargin: '400px' });
  }
  homeScrollObserver.observe(sentinel);
}

function updateClearFilters(body) {
  const btn = body.querySelector('#market-clear-filters');
  if (btn) btn.classList.toggle('hidden', !hasActiveFilters());
}

function renderHomeGrid(grid, templates, pg, navigate, { append = false } = {}) {
  const body = grid.closest('#market-body');
  const loadMoreWrap = body?.querySelector('#market-load-more');

  if (!templates.length && !append) {
    let title = '当前没有已审核公开作品';
    let desc = '你可以回到首页文件列表，在文件的「⋯」菜单中选择「上架到市场」，审核通过后会展示在这里。';
    if (homeState.keyword) {
      title = `未找到「${homeState.keyword}」相关模板`;
      desc = '换个关键词试试，或清除搜索条件浏览全部作品。';
    } else if (homeState.category) {
      title = '该分类下暂无作品';
      desc = '看看其他分类，或成为第一个上传该分类作品的创作者。';
    } else if (homeState.sort === 'featured') {
      title = '暂无精选作品';
      desc = '管理员标记精选后，这里会展示优质模板。';
    } else if (homeState.fileType) {
      title = '该类型下暂无作品';
      desc = '看看其他类型，或成为第一个上传该类型作品的创作者。';
    }
    const actionHtml = hasActiveFilters()
      ? '<div class="ct-empty-action"><button class="btn btn-small" id="ct-clear-filter">清除筛选</button></div>'
      : '';
    renderEmpty(grid, { title, desc, actionHtml });
    grid.querySelector('#ct-clear-filter')?.addEventListener('click', () => {
      clearAllFilters(body, navigate);
    });
    if (loadMoreWrap) loadMoreWrap.innerHTML = '';
    return;
  }

  const html = templates.map(t => createTemplateCard(t)).join('');
  if (append) {
    const sentinel = grid.querySelector('#market-scroll-sentinel');
    const temp = document.createElement('div');
    temp.innerHTML = html;
    while (temp.firstChild) {
      grid.insertBefore(temp.firstChild, sentinel);
    }
  } else {
    grid.innerHTML = html + '<div id="market-scroll-sentinel" class="mw-end-msg"></div>';
  }

  const obs = ensureThumbObserver();
  grid.querySelectorAll('.ct-card').forEach(card => {
    if (!card.dataset.thumbBound) {
      card.dataset.thumbBound = '1';
      obs.observe(card);
    }
  });

  setupCardInteractions(grid, navigate);
  renderLoadMore(loadMoreWrap, navigate, body, false, pg);

  const savedY = (() => { try { return sessionStorage.getItem('marketScrollY'); } catch { return null; } })();
  if (savedY) {
    try { sessionStorage.removeItem('marketScrollY'); } catch (_) {}
    requestAnimationFrame(() => { window.scrollTo(0, parseInt(savedY, 10) || 0); });
  }
}

// ============================================================
// 详情页
// ============================================================

function renderDetail(container, id, navigate) {
  const body = renderMarketShell(container, { active: 'home', navigate });
  body.innerHTML = '<div class="ct-loading">加载中...</div>';

  loadDetail(body, id, navigate);
}

async function loadDetail(body, id, _navigate) {
  try {
    const meta = await api(`/api/content-templates/market/${id}`);

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
            作者：${escapeHtml(meta.uploader_name || '匿名')} · ${meta.instantiation_count || 0} 次使用 · ${relativeTime(meta.published_at || meta.created_at)}
          </div>
          <div class="market-detail-actions mw-icon-actions">
            <button class="btn btn-small btn-primary" id="detail-use-template">使用此模板</button>
            <button class="mw-icon-btn" id="detail-star" data-tip="收藏" aria-label="收藏" data-starred="${meta.starred ? '1' : '0'}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6L12 2z"/></svg>
            </button>
            <button class="mw-icon-btn" id="detail-download" data-tip="下载" aria-label="下载">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a1 1 0 011 1v9.6l3.3-3.3a1 1 0 011.4 1.4l-5 5a1 1 0 01-1.4 0l-5-5a1 1 0 111.4-1.4L11 13.6V4a1 1 0 011-1zM5 19a1 1 0 011-1h12a1 1 0 110 2H6a1 1 0 01-1-1z"/></svg>
            </button>
            <button class="mw-icon-btn" id="detail-copy-url" data-tip="复制公开链接" aria-label="复制公开链接">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 13.4a1 1 0 010-1.4l3-3a1 1 0 011.4 1.4l-1.3 1.3 1.4 1.4 1.3-1.3a3 3 0 10-4.2-4.2l-3 3a3 3 0 000 4.2 1 1 0 001.4-1.4zM13.4 10.6a1 1 0 010 1.4l-3 3a1 1 0 01-1.4-1.4l1.3-1.3-1.4-1.4-1.3 1.3a3 3 0 104.2 4.2l3-3a1 1 0 000-1.4 1 1 0 00-1.4 0z"/></svg>
            </button>
            <button class="mw-icon-btn" id="detail-view-public" data-tip="查看公链" aria-label="查看公链">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
            </button>
          </div>
        </aside>
      </div>
    `;

    const iframe = body.querySelector('.market-detail-iframe');
    iframe.src = `/api/content-templates/market/${id}/preview-html`;

    // 使用此模板：Web 端仅展示 CLI/MCP 引导，实际实例化需通过 Token 客户端完成
    body.querySelector('#detail-use-template').onclick = async () => {
      await showTemplateUseGuide({ id, title: meta.title });
    };

    // 收藏（toggle）
    body.querySelector('#detail-star').onclick = async () => {
      try {
        const data = await api(`/api/content-templates/${id}/star`, { method: 'POST' });
        const btn = body.querySelector('#detail-star');
        btn.dataset.starred = data.starred ? '1' : '0';
        const prefix = meta.title ? `《${meta.title}》` : '该模板';
        toast(data.starred ? `已收藏 ${prefix}` : `已取消收藏 ${prefix}`);
      } catch (e) {
        toast(e.status === 401 ? '请先登录' : (e.message || '操作失败'), 'error');
      }
    };

    // 下载
    body.querySelector('#detail-download').onclick = () => {
      window.open(`/api/content-templates/${id}/download`, '_blank');
    };

    // 复制公开短链（首次生成，之后复用）
    body.querySelector('#detail-copy-url').onclick = async () => {
      try {
        const data = await api(`/api/content-templates/${id}/share`, { method: 'POST' });
        const url = `${location.origin}/t/${data.key}`;
        const ok = await copyToClipboard(url);
        toast(ok ? `已复制公开链接：${url}` : '复制失败，请手动复制', ok ? 'success' : 'error');
      } catch (e) {
        toast(e.message || '生成链接失败', 'error');
      }
    };

    // 跳转：打开 /t/:key 公开页
    body.querySelector('#detail-view-public').onclick = async () => {
      try {
        let key = meta.share_key;
        if (!key) {
          const data = await api(`/api/content-templates/${id}/share`, { method: 'POST' });
          key = data.key;
        }
        if (key) {
          window.open(`${location.origin}/t/${key}`, '_blank');
        } else {
          toast('未找到公开链接', 'error');
        }
      } catch (e) {
        toast(e.message || '打开公链失败', 'error');
      }
    };

  } catch (e) {
    body.innerHTML = '<div class="ct-empty">加载失败或模板未上架</div>';
  }
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
  const hasContent = list.querySelectorAll('.mine-item').length > 0;
  let overlay = null;
  if (hasContent) {
    list.style.position = 'relative';
    overlay = renderLoading(list, { overlay: true });
    list.appendChild(overlay);
  } else {
    renderLoading(list, { list: true });
  }

  const params = new URLSearchParams();
  params.set('page', mineState.page);
  if (mineState.status) params.set('status', mineState.status);

  try {
    const data = await api('/api/content-templates/mine?' + params.toString());
    renderMineList(list, data.templates || [], data.pagination, navigate);
  } catch (e) {
    renderError(list, { message: e.message || '加载失败', retry: () => loadMineList(body, navigate), list: true });
  } finally {
    if (overlay) overlay.remove();
  }
}

function renderMineList(list, templates, pg, navigate) {
  if (!templates.length) {
    list.innerHTML = '<div class="ct-empty mw-empty"><strong>暂无上架作品</strong><span>请回到首页文件列表，在文件「⋯」菜单中选择「上架到市场」。</span></div>';
    return;
  }
  list.innerHTML = templates.map(t => {
    const statusBadge = STATUS_BADGE[t.status] || '';
    const reviewNote = t.status === 'rejected' && t.review_note
      ? `<div class="mine-review-note">审核意见：${escapeHtml(t.review_note)}</div>` : '';
    const cat = t.category_name ? `<span class="ct-badge ct-badge-scene">${escapeHtml(t.category_name)}</span>` : '';
    const typeLabel = t.file_type === 'markdown' ? 'MD' : 'HTML';
    const source = t.source_file_id ? `<span class="mine-source-file">来自：<a href="#/view/${t.source_file_id}">${escapeHtml(t.source_file_name || '文件#' + t.source_file_id)}</a></span>` : '';
    return `<div class="mine-item" data-id="${t.id}" data-title="${escapeHtml(t.title)}">
      <div class="mine-item-main">
        <div class="mine-item-title">${escapeHtml(t.title)} ${statusBadge}</div>
        <div class="mine-item-meta">${cat}<span class="ct-badge ${t.file_type === 'markdown' ? 'ct-badge-md' : 'ct-badge-html'}">${typeLabel}</span> · ${relativeTime(t.submitted_at || t.created_at)}${source ? ' · ' + source : ''}</div>
        ${reviewNote}
      </div>
      <div class="mine-item-actions">
        ${t.status !== 'archived' ? `<button class="btn btn-small" data-act="edit">编辑</button>` : ''}
        ${t.status !== 'archived' ? `<button class="btn btn-small btn-danger" data-act="archive">删除</button>` : ''}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.mine-item').forEach(item => {
    const id = parseInt(item.dataset.id);
    const title = item.dataset.title || '该模板';
    item.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = async () => {
        const act = btn.dataset.act;
        if (act === 'archive') {
          const ok = await dialogModal.confirm({ message: `确定删除《${title}》？删除后将从市场移除。`, confirmText: '删除', danger: true });
          if (!ok) return;
          try {
            await api(`/api/content-templates/${id}`, { method: 'DELETE' });
            toast(`《${title}》已删除`);
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
      toast(`《${title}》已保存，重新进入审核`);
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
  archived: '<span class="ct-status-badge ct-status-archived">已删除</span>',
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
          <button class="filter-chip ${adminState.status === 'archived' ? 'active' : ''}" data-status="archived">已删除</button>
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
  const hasContent = list.querySelectorAll('.admin-item').length > 0;
  let overlay = null;
  if (hasContent) {
    list.style.position = 'relative';
    overlay = renderLoading(list, { overlay: true });
    list.appendChild(overlay);
  } else {
    renderLoading(list, { list: true });
  }

  const params = new URLSearchParams();
  params.set('page', adminState.page);
  params.set('limit', '20');
  if (adminState.status) params.set('status', adminState.status);

  try {
    const data = await api('/api/content-templates/admin/list?' + params.toString());
    renderAdminList(list, data.templates || [], data.pagination, navigate, body);
  } catch (e) {
    renderError(list, { message: e.message || '加载失败', retry: () => loadAdminList(body, navigate), list: true });
  } finally {
    if (overlay) overlay.remove();
  }
}

function renderAdminList(list, templates, pg, navigate, body) {
  if (!templates.length) {
    list.innerHTML = '<div class="ct-empty mw-empty"><strong>暂无待处理作品</strong><span>当前筛选条件下没有市场作品。</span></div>';
    return;
  }
  list.innerHTML = templates.map(t => {
    const statusBadge = STATUS_BADGE[t.status] || '';
    const cat = t.category_name ? escapeHtml(t.category_name) : '未分类';
    const reviewNote = t.review_note ? `<div class="mine-review-note">审核意见：${escapeHtml(t.review_note)}</div>` : '';
    const source = t.source_file_id ? `<span class="mine-source-file">来自：<a href="#/view/${t.source_file_id}">${escapeHtml(t.source_file_name || '文件#' + t.source_file_id)}</a></span>` : '';
    return `<div class="mine-item admin-item" data-id="${t.id}" data-title="${escapeHtml(t.title)}">
      <div class="mine-item-main">
        <div class="mine-item-title">${escapeHtml(t.title)} ${statusBadge} ${t.featured ? '<span class="ct-badge ct-badge-featured">精选</span>' : ''}</div>
        <div class="mine-item-meta">${cat} · 作者：${escapeHtml(t.uploader_name || '-')} · 使用 ${t.use_count} 次${source ? ' · ' + source : ''}</div>
        ${reviewNote}
      </div>
      <div class="mine-item-actions">
        <button class="btn btn-small" data-act="preview">预览</button>
        ${t.status === 'pending' ? `<button class="btn btn-small btn-primary" data-act="approve">通过</button>` : ''}
        ${t.status === 'pending' ? `<button class="btn btn-small btn-danger" data-act="reject">拒绝</button>` : ''}
        ${t.status === 'approved' ? `<button class="btn btn-small" data-act="toggle-vis">${t.visibility === 'visible' ? '隐藏' : '展示'}</button>` : ''}
        ${t.status === 'approved' ? `<button class="btn btn-small" data-act="feature">${t.featured ? '取消精选' : '精选'}</button>` : ''}
        ${t.status !== 'archived' ? `<button class="btn btn-small btn-danger" data-act="delete">删除</button>` : ''}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.admin-item').forEach(item => {
    const id = parseInt(item.dataset.id);
    const title = item.dataset.title || '该模板';
    item.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = async () => {
        const act = btn.dataset.act;
        try {
          if (act === 'preview') {
            const data = await api(`/api/content-templates/admin/${id}/content`);
            previewInDialog(data);
          } else if (act === 'approve') {
            const vis = await dialogModal.confirm({ message: `《${title}》：通过后是否展示到市场？`, confirmText: '展示', cancelText: '通过但不展示' });
            // confirm=true → 展示；cancel(=false) → 通过但隐藏
            await api(`/api/content-templates/${id}/review`, {
              method: 'POST',
              body: { status: 'approved', visibility: vis ? 'visible' : 'hidden', reviewNote: '审核通过' },
            });
            toast(vis ? `《${title}》已通过并展示` : `《${title}》已通过（隐藏）`);
            loadAdminList(body, navigate);
          } else if (act === 'reject') {
            const note = await dialogModal.prompt({ message: `拒绝《${title}》：请填写拒绝原因`, label: '审核意见', confirmText: '拒绝' });
            if (note === null) return;
            if (!note.trim()) {
              toast('请填写拒绝原因', 'error');
              return;
            }
            await api(`/api/content-templates/${id}/review`, {
              method: 'POST', body: { status: 'rejected', reviewNote: note.trim() },
            });
            toast(`《${title}》已拒绝`);
            loadAdminList(body, navigate);
          } else if (act === 'toggle-vis') {
            const vis = btn.textContent.trim() === '隐藏' ? 'hidden' : 'visible';
            await api(`/api/content-templates/${id}/admin`, { method: 'PATCH', body: { visibility: vis } });
            toast(vis === 'hidden' ? `《${title}》已隐藏` : `《${title}》已展示`);
            loadAdminList(body, navigate);
          } else if (act === 'feature') {
            const featured = btn.textContent.includes('取消精选');
            await api(`/api/content-templates/${id}/admin`, { method: 'PATCH', body: { featured: !featured } });
            toast(!featured ? `《${title}》已设为精选` : `《${title}》已取消精选`);
            loadAdminList(body, navigate);
          } else if (act === 'delete') {
            const ok = await dialogModal.confirm({ message: `确定删除《${title}》？删除后将从市场移除。`, confirmText: '删除', danger: true });
            if (!ok) return;
            await api(`/api/content-templates/${id}`, { method: 'DELETE' });
            toast(`《${title}》已删除`);
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

// ---- 分类管理（内嵌面板：列表 + 拖拽排序 + 弹窗新增/编辑） ----

async function openCategoryManager(body, navigate) {
  let cats = [];
  try {
    const data = await api('/api/content-templates/admin/categories');
    cats = data.categories || [];
  } catch (e) { toast(e.message || '加载失败', 'error'); return; }

  body.innerHTML = `
    <div class="market-cat-mgr">
      <div class="market-cat-mgr-head">
        <h3 class="market-form-title">分类管理 <span class="market-cat-hint">（拖动行可排序）</span></h3>
        <div class="market-cat-head-actions">
          <button class="btn btn-primary btn-small" id="cat-add">+ 新增分类</button>
          <button class="btn btn-small" id="cat-back">返回</button>
        </div>
      </div>
      <div id="cat-list" class="market-list market-cat-list">
        ${cats.length === 0 ? '<div class="ct-empty">暂无分类，点击「+ 新增分类」创建。</div>' : cats.map(c => `
          <div class="mine-item cat-row" data-id="${c.id}" draggable="true">
            <span class="cat-drag-handle" title="拖动排序" aria-hidden="true">⠿</span>
            <div class="mine-item-main">
              <div class="mine-item-title">${escapeHtml(c.name)} ${c.is_enabled ? '' : '<span class="ct-status-badge ct-status-archived">已停用</span>'}</div>
              <div class="mine-item-meta">slug: ${escapeHtml(c.slug)} · 排序 ${c.sort_order} · ${c.template_count} 个模板</div>
              ${c.description ? `<div class="mine-review-note">${escapeHtml(c.description)}</div>` : ''}
            </div>
            <div class="mine-item-actions">
              <button class="btn btn-small" data-act="edit">编辑</button>
              <button class="btn btn-small" data-act="toggle">${c.is_enabled ? '停用' : '启用'}</button>
              <button class="btn btn-small btn-danger" data-act="del">删除</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  body.querySelector('#cat-back').onclick = () => { adminState.status = adminState.status || 'pending'; navigate('/market/admin'); };
  body.querySelector('#cat-add').onclick = () => openCatModal(null, body, navigate);

  body.querySelectorAll('#cat-list .cat-row').forEach(item => {
    const id = item.dataset.id;
    const cat = cats.find(c => String(c.id) === String(id)) || null;
    item.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = async () => {
        const act = btn.dataset.act;
        try {
          if (act === 'edit') {
            openCatModal(cat, body, navigate);
          } else if (act === 'toggle') {
            const enable = btn.textContent.trim() === '启用';
            await api(`/api/content-templates/admin/categories/${id}`, { method: 'PUT', body: { isEnabled: enable } });
            toast(enable ? `分类「${cat.name}」已启用` : `分类「${cat.name}」已停用`);
            openCategoryManager(body, navigate);
          } else if (act === 'del') {
            const ok = await dialogModal.confirm({ message: `确定删除分类「${cat.name}」？若分类下有模板将改为停用。`, confirmText: '删除', danger: true });
            if (!ok) return;
            const res = await api(`/api/content-templates/admin/categories/${id}`, { method: 'DELETE' });
            toast(res.disabled ? `分类「${cat.name}」下有模板，已停用` : `分类「${cat.name}」已删除`);
            openCategoryManager(body, navigate);
          }
        } catch (e) { toast(e.message || '操作失败', 'error'); }
      };
    });
  });

  // 拖拽排序（纯前端 DOM 移动 + 调 reorder API；每次 mutation 后 re-render 会重绑监听）
  setupCategoryDragSort(body.querySelector('#cat-list'), body, navigate);
}

// 拖拽排序：拖动行到另一行上下方，松手后按新顺序批量写入 sort_order
function setupCategoryDragSort(list, body, navigate) {
  if (!list) return;
  let dragSrc = null;
  list.querySelectorAll('.cat-row').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragSrc = row;
      row.classList.add('cat-dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox 需要 setData 才能触发 dragover
      try { e.dataTransfer.setData('text/plain', row.dataset.id); } catch (_) { /* ignore */ }
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrc && dragSrc !== row) row.classList.add('cat-drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('cat-drag-over'));
    row.addEventListener('drop', async e => {
      e.preventDefault();
      row.classList.remove('cat-drag-over');
      if (!dragSrc || dragSrc === row) return;
      // 按光标在目标行的上/下半区决定插入位置
      const rect = row.getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) row.after(dragSrc);
      else row.before(dragSrc);
      const ids = [...list.querySelectorAll('.cat-row')].map(r => parseInt(r.dataset.id));
      try {
        await api('/api/content-templates/admin/categories/reorder', { method: 'PUT', body: { order: ids } });
        toast('排序已更新');
      } catch (err) {
        toast(err.message || '排序失败', 'error');
      } finally {
        // re-render 同步 sort_order 显示 & 重绑监听（失败则回滚到服务端真实顺序）
        openCategoryManager(body, navigate);
      }
    });
    row.addEventListener('dragend', () => {
      list.querySelectorAll('.cat-drag-over').forEach(r => r.classList.remove('cat-drag-over'));
      if (dragSrc) dragSrc.classList.remove('cat-dragging');
      dragSrc = null;
    });
  });
}

// 新增/编辑分类弹窗（cat=null → 新增；cat=对象 → 编辑）
function openCatModal(cat, body, navigate) {
  const modal = document.getElementById('market-cat-modal');
  const isEdit = !!cat;
  document.getElementById('market-cat-modal-title').textContent = isEdit ? '编辑分类' : '新增分类';
  const slugEl = document.getElementById('market-cat-slug');
  const nameEl = document.getElementById('market-cat-name');
  const descEl = document.getElementById('market-cat-desc');
  const orderEl = document.getElementById('market-cat-order');
  const enabledEl = document.getElementById('market-cat-enabled');
  const errorEl = document.getElementById('market-cat-error');
  errorEl.hidden = true;

  // 填充：新增用默认值；编辑用现有数据
  slugEl.value = isEdit ? cat.slug : '';
  slugEl.readOnly = isEdit;          // slug 是唯一键，编辑时只读
  slugEl.placeholder = isEdit ? '（slug 创建后不可修改）' : 'html-doc（小写字母/数字/连字符）';
  nameEl.value = isEdit ? cat.name : '';
  descEl.value = isEdit ? (cat.description || '') : '';
  orderEl.value = isEdit ? cat.sort_order : 0;
  enabledEl.checked = isEdit ? !!cat.is_enabled : true;

  openModal(modal);

  const closeBtn = document.getElementById('market-cat-modal-close');
  const cancelBtn = document.getElementById('market-cat-modal-cancel');
  const submitBtn = document.getElementById('market-cat-modal-submit');
  const close = () => closeModal(modal);
  closeBtn.onclick = close;
  cancelBtn.onclick = close;
  submitBtn.onclick = async () => {
    const name = nameEl.value.trim();
    const description = descEl.value.trim();
    const sortOrder = parseInt(orderEl.value) || 0;
    const isEnabled = enabledEl.checked;
    if (!name) { errorEl.textContent = '分类名称不能为空'; errorEl.hidden = false; return; }
    if (!isEdit) {
      const slug = slugEl.value.trim();
      if (!slug) { errorEl.textContent = 'slug 不能为空'; errorEl.hidden = false; return; }
      if (!/^[a-z0-9-]+$/.test(slug)) { errorEl.textContent = 'slug 只能包含小写字母、数字和连字符'; errorEl.hidden = false; return; }
    }
    try {
      if (isEdit) {
        await api(`/api/content-templates/admin/categories/${cat.id}`, {
          method: 'PUT', body: { name, description: description || null, sortOrder, isEnabled },
        });
        toast('已保存');
      } else {
        await api('/api/content-templates/admin/categories', {
          method: 'POST', body: { slug: slugEl.value.trim(), name, description: description || null, sortOrder },
        });
        toast('已新增');
      }
      closeModal(modal);
      openCategoryManager(body, navigate);
    } catch (e) {
      errorEl.textContent = e.message || '保存失败';
      errorEl.hidden = false;
    }
  };
  if (!modal.dataset.bound) {
    modal.dataset.bound = '1';
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal); });
  }
  setTimeout(() => nameEl.focus(), 0);
}
