// 落地页：产品介绍、模板展示

import { api } from '../api.js';
import { state, navigate } from '../app.js';

function renderLanding(container, openModal) {
  if (state.currentUser) { navigate('/'); return; }
  const tmpl = document.getElementById('landing-template');
  container.innerHTML = '';
  container.appendChild(tmpl.content.cloneNode(true));

  const el = container.querySelector('.landing-page');

  // 模板展示
  const grid = el.querySelector('#landing-template-grid');
  const emptyEl = el.querySelector('#landing-template-empty');
  const filters = el.querySelectorAll('.scene-filter');
  let currentScene = '';

  filters.forEach(btn => {
    btn.addEventListener('click', () => {
      filters.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentScene = btn.dataset.scene;
      loadTemplates();
    });
  });

  async function loadTemplates() {
    try {
      const params = new URLSearchParams({ limit: '8' });
      if (currentScene) params.set('scene', currentScene);
      const data = await api('/api/content-templates/public?' + params);
      renderTemplateGrid(data.templates);
    } catch {
      renderTemplateGrid([]);
    }
  }

  function renderTemplateGrid(templates) {
    if (!templates || templates.length === 0) {
      grid.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    grid.innerHTML = templates.map(t => {
      const sceneLabels = { dashboard: '仪表板', report: '报告', resume: '简历', landing: '落地页', note: '笔记', presentation: '演示', card: '卡片', email: '邮件', other: '其他' };
      const sceneLabel = sceneLabels[t.scene] || t.scene;
      return `
        <div class="landing-template-card" data-id="${t.id}" data-file-type="${t.file_type}">
          <div class="landing-template-thumb">
            <div class="ct-card-thumb-wrap"><iframe class="ct-thumb-iframe" sandbox="allow-scripts"></iframe></div>
            <div class="ct-card-thumb-loading"></div>
            <div class="landing-template-thumb-placeholder">${t.title.charAt(0)}</div>
          </div>
          <div class="landing-template-info">
            <h4>${escapeHtml(t.title)}</h4>
            <div class="landing-template-meta">
              <span class="ct-badge ct-badge-scene">${sceneLabel}</span>
              <span class="ct-badge ct-badge-type">${t.file_type.toUpperCase()}</span>
              ${t.use_count > 0 ? `<span class="landing-template-uses">${t.use_count} 次使用</span>` : ''}
            </div>
          </div>
        </div>`;
    }).join('');

    const landingThumbObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const card = entry.target;
        landingThumbObserver.unobserve(card);
        loadLandingThumb(card);
      });
    }, { rootMargin: '200px' });

    grid.querySelectorAll('.landing-template-card').forEach(card => {
      card.addEventListener('click', () => openTemplatePreview(parseInt(card.dataset.id)));
      landingThumbObserver.observe(card);
    });
  }

  async function loadLandingThumb(card) {
    const id = parseInt(card.dataset.id);
    const loadingEl = card.querySelector('.ct-card-thumb-loading');
    const placeholder = card.querySelector('.landing-template-thumb-placeholder');
    const iframe = card.querySelector('.ct-thumb-iframe');
    if (!iframe) return;
    try {
      const data = await api(`/api/content-templates/public/${id}/preview`);
      if (data.file_type === 'markdown') {
        iframe.srcdoc = `<pre style="padding:24px;font-size:14px;white-space:pre-wrap;word-break:break-word;margin:0">${escapeHtml(data.content)}</pre>`;
      } else {
        iframe.srcdoc = data.content;
      }
      iframe.onload = () => {
        if (loadingEl) loadingEl.remove();
        if (placeholder) placeholder.style.display = 'none';
      };
    } catch {
      if (loadingEl) loadingEl.remove();
    }
  }

  // 模板预览弹窗
  const previewModal = el.querySelector('#template-preview-modal');
  const previewTitle = el.querySelector('#template-preview-title');
  const previewMeta = el.querySelector('#template-preview-meta');
  const previewIframe = el.querySelector('#template-preview-iframe');

  el.querySelector('#template-preview-close').addEventListener('click', () => { previewModal.hidden = true; });
  previewModal.addEventListener('click', (e) => { if (e.target === previewModal) previewModal.hidden = true; });

  async function openTemplatePreview(id) {
    previewTitle.textContent = '加载中…';
    previewMeta.innerHTML = '';
    previewIframe.srcdoc = '';
    previewModal.hidden = false;
    try {
      const data = await api(`/api/content-templates/public/${id}/preview`);
      previewTitle.textContent = data.title;
      previewMeta.innerHTML = `<span class="ct-badge ct-badge-type">${(data.file_type || 'html').toUpperCase()}</span>`;
      if (data.file_type === 'markdown') {
        previewIframe.srcdoc = `<pre style="padding:24px;font-size:14px;white-space:pre-wrap;">${escapeHtml(data.content)}</pre>`;
      } else {
        previewIframe.srcdoc = data.content;
      }
    } catch {
      previewTitle.textContent = '加载失败';
    }
  }

  // 初始加载模板
  loadTemplates();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export { renderLanding };
