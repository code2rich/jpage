// 落地页：产品介绍（纯静态展示）。
// 模板展示功能已迁移至独立的 /market 页面，本页不再调用模板 API。

import { state, navigate } from '../app.js';

function renderLanding(container) {
  if (state.currentUser) { navigate('/'); return; }
  const tmpl = document.getElementById('landing-template');
  container.innerHTML = '';
  container.appendChild(tmpl.content.cloneNode(true));

  const el = container.querySelector('.landing-page');
  if (!el) return;

  // 导航栏滚动吸顶效果
  const nav = el.querySelector('.landing-nav');
  if (!nav) return;
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

export { renderLanding };
