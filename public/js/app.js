// 入口：路由初始化、全局状态、hash change 监听
//
// 路由级代码分割：各页面（landing/login/home/preview）用动态 import() 按需加载，
// 经 esbuild splitting 产出独立 chunk，首屏只下载当前路由所需代码。

import { api } from './api.js';
import { dialogModal } from './components/dialog.js';
import { initTheme, setupThemeToggle } from './theme.js';

const state = {
  currentUser: null,
};

async function fetchCurrentUser() {
  try {
    const data = await api('/api/auth/me');
    state.currentUser = data;
    return data;
  } catch (e) {
    if (e.status === 401) {
      state.currentUser = null;
      return null;
    }
    throw e;
  }
}

function navigate(path) {
  location.hash = path;
  route();
}

// 动态加载各路由模块（esbuild 据此做代码分割，产出独立 chunk）
// 动态 import 带字面量版本串：发版时连同 index.html 里 app.js 的 ?v= 一起改，
// 让浏览器在开发模式（直接服务源文件、无内容哈希文件名）下也重新拉取各页面 chunk，
// 绕过 immutable 长缓存。字面量（非模板）能被 esbuild 正确分割。
async function loadHome() { const m = await import('./pages/home.js?v=1.6.1'); return m.renderHome; }
async function loadLogin() { const m = await import('./pages/login.js?v=1.6.1'); return m.renderLogin; }
async function loadLanding() { const m = await import('./pages/landing.js?v=1.6.1'); return m.renderLanding; }
async function loadPreview() { const m = await import('./pages/preview.js?v=1.6.1'); return m.renderPreview; }
async function loadMarket() { const m = await import('./pages/market.js?v=1.6.1'); return m.renderMarket; }

function route() {
  const hash = location.hash.replace('#', '') || '/';
  const appEl = document.getElementById('app');

  // 邮箱验证结果页（纯静态，无需加载页面模块）
  if (hash === '/email-verified' || hash === '/email-verify-failed' || hash === '/email-verify-expired') {
    const messages = {
      '/email-verified': { title: '邮箱验证成功', desc: '你的邮箱已通过验证。', ok: true },
      '/email-verify-failed': { title: '验证失败', desc: '验证链接无效，请重新发送验证邮件。', ok: false },
      '/email-verify-expired': { title: '链接已过期', desc: '验证链接已过期，请重新发送验证邮件。', ok: false },
    };
    const msg = messages[hash];
    appEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px">
      <h2>${msg.title}</h2><p>${msg.desc}</p>
      <a href="#/" class="btn btn-primary">${msg.ok ? '返回首页' : '返回'}</a>
    </div>`;
    return;
  }

  // 预览页（独立路由，动态加载）
  if (hash.startsWith('/view/')) {
    loadPreview().then((renderPreview) => {
      renderPreview(appEl, hash);
      setupThemeToggle(appEl);
    });
    return;
  }

  // 内容模板市场（独立路由，需登录）
  if (hash === '/market' || hash.startsWith('/market/')) {
    if (!state.currentUser) { navigate('/login'); return; }
    loadMarket().then((renderMarket) => {
      renderMarket(appEl, hash, navigate);
      setupThemeToggle(appEl);
    });
    return;
  }

  if (state.currentUser) {
    if (hash === '/login' || hash === '/register') { navigate('/'); return; }
    loadHome().then((renderHome) => {
      renderHome(appEl);
      setupThemeToggle(appEl);
    });
    return;
  }

  if (hash === '/login') {
    loadLogin().then((renderLogin) => { renderLogin(appEl, 'login'); setupThemeToggle(appEl); });
  } else if (hash === '/register') {
    loadLogin().then((renderLogin) => { renderLogin(appEl, 'register'); setupThemeToggle(appEl); });
  } else {
    loadLanding().then((renderLanding) => { renderLanding(appEl); setupThemeToggle(appEl); });
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('load', async () => {
  dialogModal.init();
  initTheme();
  await fetchCurrentUser();
  route();
});

export { state, navigate };
