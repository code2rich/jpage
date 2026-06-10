// 入口：路由初始化、全局状态、hash change 监听

import { api } from './api.js';
import { dialogModal } from './components/dialog.js';
import { toast } from './components/toast.js';
import { renderLogin } from './pages/login.js';
import { renderHome } from './pages/home.js';
import { renderPreview } from './pages/preview.js';
import { renderLanding } from './pages/landing.js';
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

function route() {
  const hash = location.hash.replace('#', '') || '/';

  // 邮箱验证结果页
  if (hash === '/email-verified' || hash === '/email-verify-failed' || hash === '/email-verify-expired') {
    const app = document.getElementById('app');
    const messages = {
      '/email-verified': { title: '邮箱验证成功', desc: '你的邮箱已通过验证。', ok: true },
      '/email-verify-failed': { title: '验证失败', desc: '验证链接无效，请重新发送验证邮件。', ok: false },
      '/email-verify-expired': { title: '链接已过期', desc: '验证链接已过期，请重新发送验证邮件。', ok: false },
    };
    const msg = messages[hash];
    app.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px">
      <h2>${msg.title}</h2><p>${msg.desc}</p>
      <a href="#/" class="btn btn-primary">${msg.ok ? '返回首页' : '返回'}</a>
    </div>`;
    return;
  }

  if (hash.startsWith('/view/')) {
    renderPreview(document.getElementById('app'), hash);
    setupThemeToggle(document.getElementById('app'));
    return;
  }

  if (state.currentUser) {
    if (hash === '/login' || hash === '/register') { navigate('/'); return; }
    renderHome(document.getElementById('app'));
    setupThemeToggle(document.getElementById('app'));
    return;
  }

  if (hash === '/login') {
    renderLogin(document.getElementById('app'), 'login');
  } else if (hash === '/register') {
    renderLogin(document.getElementById('app'), 'register');
  } else {
    renderLanding(document.getElementById('app'), null);
  }
  setupThemeToggle(document.getElementById('app'));
}

window.addEventListener('hashchange', route);
window.addEventListener('load', async () => {
  dialogModal.init();
  initTheme();
  await fetchCurrentUser();
  route();
});

export { state, navigate };
