// 落地页：产品介绍（纯静态展示）+ 粘贴试用（免登录生成临时页面）。
// 模板展示功能已迁移至独立的 /market 页面，本页不再调用模板 API。

import { state, navigate } from '../app.js';
import { api } from '../api.js';
import { copyToClipboard } from '../utils.js';

function renderLanding(container) {
  if (state.currentUser) { navigate('/'); return; }
  const tmpl = document.getElementById('landing-template');
  container.innerHTML = '';
  container.appendChild(tmpl.content.cloneNode(true));

  const el = container.querySelector('.landing-page');
  if (!el) return;

  // 导航栏滚动吸顶效果
  const nav = el.querySelector('.landing-nav');
  if (nav) {
    const onScroll = () => {
      if (window.scrollY > 40) {
        nav.classList.add('scrolled');
      } else {
        nav.classList.remove('scrolled');
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // 滚动渐入动画
  const reveals = el.querySelectorAll('.reveal');
  if (reveals.length && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach((r) => observer.observe(r));
  } else {
    reveals.forEach((r) => r.classList.add('is-visible'));
  }

  // 特性卡片聚光灯效果（跟随鼠标更新 CSS 变量 --x --y）
  el.querySelectorAll('.landing-feature-card').forEach((card) => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--x', `${e.clientX - rect.left}px`);
      card.style.setProperty('--y', `${e.clientY - rect.top}px`);
    });
  });

  bindTryPaste(el);
  bindFeedback(el);
}

// 问题反馈：落地页页脚「问题反馈」入口，动态加载组件（不进首屏 chunk）。
function bindFeedback(el) {
  const link = el.querySelector('#landing-feedback-link');
  if (!link) return;
  link.addEventListener('click', async () => {
    const { openFeedbackModal } = await import('../components/feedback-modal.js');
    openFeedbackModal();
  });
}

// 粘贴试用：免登录将 HTML/Markdown 生成 10 分钟临时页面。
function bindTryPaste(el) {
  const box = el.querySelector('.try-paste-box');
  if (!box) return;

  const tabs = box.querySelectorAll('.try-paste-tab');
  const editor = box.querySelector('.try-paste-editor');
  const submitBtn = box.querySelector('.try-paste-submit');
  const resultEl = box.querySelector('.try-paste-result');
  const urlInput = box.querySelector('.try-paste-url-input');
  const copyBtn = box.querySelector('.try-paste-copy');
  const openLink = resultEl?.querySelector('a');
  const countdownEl = box.querySelector('.try-paste-countdown');
  const errorEl = box.querySelector('.try-paste-error');

  let selectedMode = 'auto';
  let countdownTimer = null;

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function hideError() {
    if (!errorEl) return;
    errorEl.hidden = true;
  }

  function setLoading(loading) {
    if (!submitBtn) return;
    submitBtn.disabled = loading;
    submitBtn.innerHTML = loading
      ? '<span class="spinner"></span> 生成中...'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> 生成临时页面';
  }

  function detectType(content) {
    const trimmed = content.trim();
    if (/^\s*</.test(trimmed)) return 'html';
    return 'markdown';
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      selectedMode = tab.dataset.mode;
      const placeholderMap = {
        auto: '在此粘贴 HTML 或 Markdown 内容...',
        html: '在此粘贴 HTML 内容...',
        markdown: '在此粘贴 Markdown 内容...'
      };
      editor.placeholder = placeholderMap[selectedMode];
    });
  });

  function startCountdown(expiresAt) {
    if (countdownTimer) clearInterval(countdownTimer);
    const end = new Date(expiresAt + 'Z').getTime();
    const tick = () => {
      const remaining = Math.max(0, Math.floor((end - Date.now()) / 1000));
      const m = Math.floor(remaining / 60).toString().padStart(2, '0');
      const s = (remaining % 60).toString().padStart(2, '0');
      if (countdownEl) countdownEl.textContent = `剩余有效期 ${m}:${s}`;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        if (countdownEl) countdownEl.textContent = '链接已过期';
      }
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function resetResult() {
    if (resultEl) resultEl.hidden = true;
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  submitBtn?.addEventListener('click', async () => {
    const raw = editor.value || '';
    const trimmed = raw.trim();
    if (!trimmed) {
      showError('请先粘贴内容');
      return;
    }
    hideError();
    resetResult();
    setLoading(true);

    try {
      const fileType = selectedMode === 'auto' ? detectType(raw) : selectedMode;
      // 后端会根据 content 再次判断类型；这里显式传 mode 仅作为提示（未来可扩展）。
      const data = await api('/api/public/try-paste', {
        method: 'POST',
        body: { content: raw, mode: fileType }
      });
      const fullUrl = `${window.location.origin}${data.url}`;
      if (urlInput) urlInput.value = fullUrl;
      if (openLink) openLink.href = data.url;
      if (resultEl) resultEl.hidden = false;
      startCountdown(data.expires_at);
      editor.value = '';
    } catch (e) {
      showError(e.message || '生成失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  });

  copyBtn?.addEventListener('click', async () => {
    const ok = await copyToClipboard(urlInput.value);
    if (ok) {
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 2000);
    }
  });

  editor?.addEventListener('input', () => {
    hideError();
  });
}

export { renderLanding };
