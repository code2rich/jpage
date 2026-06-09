// 入口：路由初始化、全局状态、hash change 监听

import { api } from './api.js';
import { dialogModal } from './components/dialog.js';
import { renderLogin } from './pages/login.js';
import { renderHome } from './pages/home.js';
import { renderPreview } from './pages/preview.js';

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

  if (hash === '/login') {
    renderLogin(document.getElementById('app'));
    return;
  }

  if (hash.startsWith('/view/')) {
    renderPreview(document.getElementById('app'), hash);
    return;
  }

  if (state.currentUser) {
    renderHome(document.getElementById('app'));
  } else {
    renderLogin(document.getElementById('app'));
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('load', async () => {
  dialogModal.init();
  await fetchCurrentUser();
  route();
});

export { state, navigate };
