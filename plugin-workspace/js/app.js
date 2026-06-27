// 即页 uTools 插件 · 主应用逻辑（列表/搜索/分页/筛选 + 入口编排）

(function () {
  const state = {
    page: 1,
    limit: 30,
    keyword: '',
    sort: 'updated_at',
    order: 'desc',
    tag: '',
    category: '',
    starred: '',
    allTags: [],
    allCategories: [],
    entering: false, // enterMain 并发保护
    pendingUploadFiles: null, // 拖拽进入时暂存的待上传文件路径数组
  };

  const els = {};

  function cacheEls() {
    els.list = document.getElementById('file-list');
    els.empty = document.getElementById('empty-state');
    els.pagination = document.getElementById('pagination');
    els.count = document.getElementById('result-count');
    els.search = document.getElementById('search-input');
    els.sort = document.getElementById('filter-sort');
    els.tag = document.getElementById('filter-tag');
    els.category = document.getElementById('filter-category');
    els.starred = document.getElementById('filter-starred');
    els.userName = document.getElementById('user-name');
    els.userAvatar = document.getElementById('user-avatar');
  }

  function renderUser(user) {
    if (!user) return;
    els.userName.textContent = user.username + (user.role === 'admin' ? ' · 管理员' : '');
    els.userAvatar.textContent = JP.initialOf(user.username);
  }

  // ---- 文件列表渲染 ----
  function renderFileItem(f) {
    const iconClass = f.is_bundle ? 'zip' : f.file_type;
    const tagsHtml = (f.tags || [])
      .map((t) => `<span class="meta-tag">${JP.escapeHtml(t.name)}</span>`)
      .join('');
    const bundleBadge = f.is_bundle
      ? '<span class="meta-tag">📦 bundle</span>'
      : '';
    const visBadge = f.is_public ? '' : '<span class="badge-private">私有</span>';
    const versionBadge =
      f.version_count > 0 ? `<span class="meta-tag">⏱ ${f.version_count} 历史</span>` : '';
    const star = f.starred ? '★' : '';

    return `
      <div class="file-item" data-id="${f.id}">
        <div class="file-icon ${iconClass}">${JP.fileTypeLabel(f.is_bundle ? 'zip' : f.file_type)}</div>
        <div class="file-main">
          <div class="file-name">
            <span class="name-text">${JP.escapeHtml(f.original_name)}</span>
            ${visBadge}
            ${star ? `<span class="star-on">${star}</span>` : ''}
          </div>
          <div class="file-meta">
            <span>${JP.formatSize(f.size)}</span>
            <span>更新于 ${JP.formatDate(f.updated_at)}</span>
            <span>👁 ${f.view_count || 0}</span>
            ${bundleBadge}
            ${versionBadge}
            ${tagsHtml}
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-icon btn-ghost act-open" title="打开预览">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </button>
          <button class="btn btn-icon btn-ghost act-copy" title="复制链接">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="btn btn-icon btn-ghost act-star" title="${f.starred ? '取消收藏' : '收藏'}">
            ${f.starred
              ? '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'}
          </button>
        </div>
      </div>`;
  }

  function renderList(data) {
    const files = data.files || [];
    els.count.textContent =
      (data.pagination && data.pagination.total != null)
        ? `共 ${data.pagination.total} 个文件`
        : '';
    if (!files.length) {
      els.list.innerHTML = '';
      els.empty.classList.remove('hidden');
      els.pagination.innerHTML = '';
      return;
    }
    els.empty.classList.add('hidden');
    els.list.innerHTML = files.map(renderFileItem).join('');
    renderPagination(data.pagination);
    bindItemEvents();
  }

  function renderPagination(p) {
    if (!p || p.totalPages <= 1) {
      els.pagination.innerHTML = '';
      return;
    }
    const { page, totalPages } = p;
    els.pagination.innerHTML = `
      <button class="btn btn-sm ${page <= 1 ? 'btn-disabled' : ''}" data-act="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span style="font-size:13px;color:var(--text-soft)">${page} / ${totalPages}</span>
      <button class="btn btn-sm ${page >= totalPages ? '' : ''}" data-act="next" ${page >= totalPages ? 'disabled' : ''}>下一页</button>`;
    els.pagination.querySelector('[data-act=prev]').onclick = () => {
      if (page > 1) {
        state.page = page - 1;
        load();
      }
    };
    els.pagination.querySelector('[data-act=next]').onclick = () => {
      if (page < totalPages) {
        state.page = page + 1;
        load();
      }
    };
  }

  function bindItemEvents() {
    els.list.querySelectorAll('.file-item').forEach((item) => {
      const id = Number(item.getAttribute('data-id'));
      // 整行点击 → 打开详情
      item.addEventListener('click', (e) => {
        if (e.target.closest('.file-actions')) return;
        openDetail(id);
      });
      const f = currentFiles.find((x) => x.id === id);
      if (!f) return;
      item.querySelector('.act-open').onclick = (e) => {
        e.stopPropagation();
        window.jpage.openExternal(window.jpage.getShareUrl(f.share_key));
      };
      item.querySelector('.act-copy').onclick = (e) => {
        e.stopPropagation();
        window.jpage.copyText(window.jpage.getShareUrl(f.share_key));
        JP.toast('✓ 已复制分享链接');
      };
      item.querySelector('.act-star').onclick = async (e) => {
        e.stopPropagation();
        try {
          if (f.starred) await window.jpage.unstarFile(id);
          else await window.jpage.starFile(id);
          f.starred = !f.starred;
          load();
        } catch (err) {
          JP.showError(err);
        }
      };
    });
  }

  let currentFiles = [];

  async function openDetail(id) {
    try {
      const [detail] = await Promise.all([window.jpage.getFile(id)]);
      await Detail.open(detail, state.allTags, state.allCategories);
    } catch (err) {
      JP.showError(err);
    }
  }

  // ---- 数据加载 ----
  async function load() {
    els.list.innerHTML =
      '<div class="loading"><span class="spinner"></span><div>加载中…</div></div>';
    els.empty.classList.add('hidden');
    try {
      // 搜索框有输入时，按文件名过滤（listFiles 的 keyword 走 LIKE 匹配文件名），
      // 不走全文搜索 searchFiles（后者会混入正文内容匹配，且中文分词不准）。
      // 这样还能保留排序/分类/标签筛选的联动。
      const data = await window.jpage.listFiles({
        page: state.page,
        limit: state.limit,
        sort: state.sort,
        order: state.order,
        keyword: state.keyword.trim() || undefined,
        category: state.category || undefined,
        tag: state.tag || undefined,
      });
      // 客户端收藏筛选（服务端列表接口没有 starred 过滤）
      let files = data.files || [];
      if (state.starred) files = files.filter((f) => f.starred);
      currentFiles = files;
      renderList({ ...data, files });
    } catch (err) {
      els.list.innerHTML = '';
      els.empty.classList.remove('hidden');
      els.empty.querySelector('h3').textContent = '加载失败';
      els.empty.querySelector('p').textContent = err.message;
      // 401：会话失效，回登录页
      if (err.code === 'UNAUTHORIZED' || err.status === 401) {
        Login.show();
      }
    }
  }

  async function loadFilters() {
    try {
      const [tagRes, catRes] = await Promise.all([
        window.jpage.listTags(),
        window.jpage.listCategories(),
      ]);
      state.allTags = tagRes.tags || [];
      state.allCategories = catRes.categories || [];
      // 渲染标签下拉
      els.tag.innerHTML =
        '<option value="">所有标签</option>' +
        state.allTags
          .map(
            (t) =>
              `<option value="${t.id}" ${String(t.id) === state.tag ? 'selected' : ''}>${JP.escapeHtml(
                t.name
              )} (${t.file_count || 0})</option>`
          )
          .join('');
      els.category.innerHTML =
        '<option value="">所有分类</option><option value="uncategorized">未分类</option>' +
        state.allCategories
          .map(
            (c) =>
              `<option value="${c.id}" ${String(c.id) === state.category ? 'selected' : ''}>${JP.escapeHtml(
                c.name
              )} (${c.file_count || 0})</option>`
          )
          .join('');
    } catch (err) {
      console.warn('加载标签/分类失败', err);
    }
  }

  // ---- 进入主界面 ----
  // 进入主界面：渲染用户 + 隐藏登录页 + 加载数据。
  // 事件监听器已在 DOMContentLoaded 时注册（bindEvents 在启动阶段就调用），
  // 这里只负责界面切换与数据加载，不再 bindEvents。
  async function enterMain(user) {
    if (state.entering) return; // 防止重复进入（登录事件 + onPluginEnter 可能并发触发）
    state.entering = true;
    try {
      renderUser(user || window.jpage.getConfig().user);
      Login.hide();
      await loadFilters();
      await load();
    } catch (err) {
      // 任何加载错误都不应白屏：展示主界面骨架 + 错误提示 + 重试
      console.error('[即页] enterMain 加载失败', err);
      Login.hide();
      try {
        els.list.innerHTML =
          '<div class="empty"><h3>加载失败</h3><p>' + JP.escapeHtml(err.message || err) +
          '</p><p style="margin-top:8px"><button class="btn" onclick="location.reload()">重试</button></p></div>';
      } catch {}
    } finally {
      state.entering = false;
    }
  }

  // ---- 事件绑定 ----
  function bindEvents() {
    // 搜索（防抖）
    let timer;
    els.search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.keyword = els.search.value;
        state.page = 1;
        load();
      }, 300);
    });

    // 快捷键：/ 聚焦搜索，Esc 清空
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        els.search.focus();
      }
      if (e.key === 'Escape' && document.activeElement === els.search) {
        els.search.value = '';
        state.keyword = '';
        state.page = 1;
        load();
        els.search.blur();
      }
    });

    // 排序
    els.sort.addEventListener('change', () => {
      const [sort, order] = els.sort.value.split(':');
      state.sort = sort;
      state.order = order;
      state.page = 1;
      load();
    });

    // 标签/分类/收藏筛选
    els.tag.addEventListener('change', () => {
      state.tag = els.tag.value;
      state.page = 1;
      load();
    });
    els.category.addEventListener('change', () => {
      state.category = els.category.value;
      state.page = 1;
      load();
    });
    els.starred.addEventListener('change', () => {
      state.starred = els.starred.value;
      state.page = 1;
      load();
    });

    // 顶栏按钮
    document.getElementById('btn-upload').onclick = () => Upload.openFilePicker();
    document.getElementById('btn-new').onclick = () => Upload.openTextEditor();
    document.getElementById('btn-settings').onclick = openSettings;

    // 插件内部拖放上传：拖文件到文件列表区域直接上传
    setupInternalDrop();

    // 登录成功 → 进入主界面，若有拖拽暂存的待上传文件则随后弹上传框
    document.addEventListener('jpage:logged-in', async (e) => {
      await enterMain(e.detail);
      if (state.pendingUploadFiles && state.pendingUploadFiles.length) {
        const files = state.pendingUploadFiles;
        state.pendingUploadFiles = null;
        handleDraggedFiles(files);
      }
    });

    // 刷新
    document.addEventListener('jpage:refresh', () => {
      loadFilters();
      load();
    });

    // uTools 进入插件
    if (window.utools) {
      window.utools.onPluginEnter(async (action) => {
        // action.type: 'text' | 'files' | 'regex' | ...
        // 拖拽文件进入：action.type === 'files'，action.payload = [{name, path}, ...]
        if (action.type === 'files' && action.payload && action.payload.length) {
          // 收集拖进来的文件路径（payload 元素是 {name, path, ...}）
          const filePaths = action.payload.map((f) => f.path).filter(Boolean);
          state.pendingUploadFiles = filePaths;
        }

        // 尝试恢复会话
        const cfg = window.jpage.getConfig();
        if (cfg.base && cfg.hasSession) {
          try {
            const user = await window.jpage.me();
            await enterMain(user);
            // 若是拖拽进入且有待上传文件，进主界面后直接弹上传框
            if (state.pendingUploadFiles && state.pendingUploadFiles.length) {
              const files = state.pendingUploadFiles;
              state.pendingUploadFiles = null;
              // 单个文件直接弹上传确认；多个文件逐个上传
              handleDraggedFiles(files);
            }
            return;
          } catch {
            // 会话失效，落到登录页
          }
        }
        Login.show();
      });
    }
  }

  // ---- 拖拽文件处理 ----
  // 拖进来的文件直接弹上传框；多个文件则依次上传。
  async function handleDraggedFiles(filePaths) {
    if (!filePaths || !filePaths.length) return;
    if (filePaths.length === 1) {
      Upload.openWithFile(filePaths[0]);
    } else {
      // 多文件：确认后批量上传
      Upload.openBatch(filePaths);
    }
  }

  // ---- 插件内部拖放上传 ----
  // 拖文件到 .content 区域（文件列表）直接弹上传框。
  // 浏览器默认会用自身打开文件，必须 preventDefault 才能接管。
  function setupInternalDrop() {
    const content = document.querySelector('#main-view .content');
    if (!content) return;

    // dragenter/dragover 必须阻止默认行为，否则 drop 不触发
    content.addEventListener('dragenter', (e) => {
      e.preventDefault();
      content.classList.add('dragover');
    });
    content.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    content.addEventListener('dragleave', (e) => {
      // dragleave 在移到子元素时也会触发，用 relatedTarget 判断是否真的离开
      if (!content.contains(e.relatedTarget)) {
        content.classList.remove('dragover');
      }
    });
    content.addEventListener('drop', async (e) => {
      e.preventDefault();
      content.classList.remove('dragover');
      // 从 DataTransfer 拿文件路径
      // uTools/Electron 环境下 File 对象有 path 属性（本地完整路径）
      const files = Array.from(e.dataTransfer.files || []);
      const paths = files.map((f) => f.path).filter(Boolean);
      if (!paths.length) {
        JP.toast('未获取到文件路径');
        return;
      }
      // 校验扩展名（只接受即页支持的格式）
      const allowed = /\.(html?|md|markdown|zip)$/i;
      const valid = paths.filter((p) => allowed.test(p));
      const skipped = paths.length - valid.length;
      if (skipped > 0) {
        JP.toast(`已忽略 ${skipped} 个不支持的文件`);
      }
      if (!valid.length) {
        JP.toast('没有可上传的文件（仅支持 html/md/zip）');
        return;
      }
      handleDraggedFiles(valid);
    });
  }

  // ---- 设置弹窗 ----
  function openSettings() {
    const cfg = window.jpage.getConfig();
    const theme = cfg.theme || 'auto';
    const themeLabel = { auto: '跟随系统', dark: '深色', light: '浅色' };
    JP.modal({
      title: '设置 / 账号',
      bodyHtml: `
        <div class="detail-grid">
          <div class="label">服务器</div>
          <div class="value">${JP.escapeHtml(cfg.base || '未配置')}</div>
          <div class="label">当前账户</div>
          <div class="value">${cfg.user ? JP.escapeHtml(cfg.user.username) : '-'}</div>
          <div class="label">外观</div>
          <div class="value">
            <select id="setting-theme" class="select" style="max-width:140px">
              <option value="auto" ${theme === 'auto' ? 'selected' : ''}>跟随系统</option>
              <option value="dark" ${theme === 'dark' ? 'selected' : ''}>深色</option>
              <option value="light" ${theme === 'light' ? 'selected' : ''}>浅色</option>
            </select>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn jp-switch">切换账号 / 服务器</button>
          <button class="btn jp-logout">退出登录</button>
          <button class="btn jp-reload">刷新列表</button>
        </div>`,
      onMount: (mask, close) => {
        mask.querySelector('#setting-theme').onchange = (e) => {
          window.jpage.setTheme(e.target.value);
          JP.toast('主题已切换为 ' + themeLabel[e.target.value]);
        };
        mask.querySelector('.jp-switch').onclick = () => {
          close();
          Login.show();
        };
        mask.querySelector('.jp-logout').onclick = async () => {
          await window.jpage.logout();
          close();
          JP.toast('已退出登录');
          Login.show();
        };
        mask.querySelector('.jp-reload').onclick = () => {
          close();
          loadFilters();
          load();
        };
      },
    });
  }

  // ---- 启动 ----
  // 事件监听器必须在首屏就绑定好（无论当前在登录页还是主界面），
  // 否则会出现「登录成功发出 jpage:logged-in 事件时，监听器还没注册」的死锁：
  //   首次进入无 session → 只显示登录页 → bindEvents 不会被调用 →
  //   登录事件无人接收 → 主界面永不启动。
  // 因此 bindEvents 在启动阶段立即执行，enterMain 只管数据和界面。
  function bootstrap() {
    // 防御：preload 未注入时不白屏，登录页会给出明确提示
    if (!window.jpage) {
      console.error('[即页] window.jpage 未注入，preload 可能未加载');
      Login.init();
      return;
    }
    // 应用主题
    try {
      window.jpage.setTheme(window.jpage.getTheme());
    } catch (e) {
      console.warn('[即页] 应用主题失败', e);
    }
    cacheEls();
    bindEvents(); // ★ 立即绑定所有事件（含 jpage:logged-in 监听）
    Login.init();

    // onPluginEnter 驱动首屏（uTools 环境）；无 onPluginEnter 时（浏览器调试）走兜底
    if (window.utools && window.utools.onPluginEnter) {
      // onPluginEnter 已在 bindEvents 中注册
    } else {
      const cfg = window.jpage.getConfig();
      if (cfg.base && cfg.hasSession) {
        window.jpage
          .me()
          .then((u) => enterMain(u))
          .catch(() => Login.show());
      } else {
        Login.show();
      }
    }
  }

  // 关键：脚本在 <body> 末尾加载，DOMContentLoaded 可能已经触发过，
  // 只注册事件监听会错过它导致页面卡死。这里按 readyState 分流：
  //   loading → 还没好，等事件
  //   interactive/complete → DOM 已就绪，立即执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
