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
}

export { renderLanding };
