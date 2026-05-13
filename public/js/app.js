const API_BASE = '';

async function api(path, opts = {}) {
  const url = API_BASE + path;
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const res = await fetch(url, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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

// ---------- Router ----------
const routes = {
  '/': renderHome,
  '/view': renderPreview,
};

function navigate(path) {
  location.hash = path;
  route();
}

function route() {
  const hash = location.hash.replace('#', '') || '/';

  let matched = null;
  for (const [p, handler] of Object.entries(routes)) {
    if (hash === p || hash.startsWith(p + '/')) {
      matched = handler;
      break;
    }
  }
  if (!matched) matched = renderHome;

  const app = document.getElementById('app');
  app.innerHTML = '';
  matched(app, hash);
}

window.addEventListener('hashchange', route);
window.addEventListener('load', route);

// ---------- Home Page ----------
function renderHome(container) {
  const tmpl = document.getElementById('home-template');
  container.appendChild(tmpl.content.cloneNode(true));

  setupUpload(container);
  loadFiles(container);
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
  try {
    await fetch(API_BASE + '/api/files/upload', {
      method: 'POST',
      body: fd
    }).then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
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

      el.innerHTML = `
        <div class="file-info" data-id="${f.id}" role="button" tabindex="0">
          <div class="file-icon ${iconClass}" aria-hidden="true">${iconText}</div>
          <div class="file-meta">
            <div class="file-name">${safeName}</div>
            <div class="file-detail">${size} · ${date}</div>
          </div>
        </div>
        <div class="file-actions">
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
    toast(e.message, 'error');
  }
}

async function doRename(container, id, currentName) {
  const name = prompt('请输入新文件名:', currentName);
  if (!name || name === currentName) return;
  try {
    await api(`/api/files/${id}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ name })
    });
    toast('重命名成功');
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
function renderPreview(container, hash) {
  const id = hash.split('/').pop();
  if (!id) return navigate('/');

  const tmpl = document.getElementById('preview-template');
  container.appendChild(tmpl.content.cloneNode(true));

  const iframe = container.querySelector('#preview-iframe');
  const source = container.querySelector('#preview-source');
  const code = container.querySelector('#source-code');
  const toggles = container.querySelectorAll('.view-toggle .btn');

  container.querySelector('#btn-back').addEventListener('click', () => navigate('/'));

  toggles.forEach(btn => {
    btn.addEventListener('click', () => {
      toggles.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      if (mode === 'render') {
        iframe.style.display = 'block';
        source.classList.remove('active');
      } else {
        iframe.style.display = 'none';
        source.classList.add('active');
      }
    });
  });

  container.querySelector('#btn-download').addEventListener('click', () => {
    const w = window.open(API_BASE + `/api/files/${id}/download`, '_blank');
    if (w) w.opener = null;
  });

  api(`/api/files/${id}/content`).then(data => {
    container.querySelector('#preview-title').textContent = data.original_name;
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
