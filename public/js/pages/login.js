// 登录/注册页：全屏认证页面，tab 切换登录和注册

import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { state, navigate } from '../app.js';

function renderLogin(container, openTab) {
  if (state.currentUser) { navigate('/'); return; }
  const tmpl = document.getElementById('login-template');
  container.innerHTML = '';
  container.appendChild(tmpl.content.cloneNode(true));

  const tabs = container.querySelectorAll('.auth-tab');
  const loginForm = container.querySelector('#login-form');
  const registerForm = container.querySelector('#register-form');

  function switchTab(tab) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    loginForm.classList.toggle('active', tab === 'login');
    registerForm.classList.toggle('active', tab === 'register');
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
      location.hash = '/' + tab.dataset.tab;
    });
  });

  const initialTab = openTab || (location.hash === '#/register' ? 'register' : 'login');
  switchTab(initialTab);

  // 登录 — 统一入口，自动识别用户名或邮箱
  const loginError = container.querySelector('#login-error');
  const loginSubmit = container.querySelector('#login-submit');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const account = container.querySelector('#login-username').value.trim();
    const password = container.querySelector('#login-password').value;
    if (!account || !password) return;
    loginError.hidden = true;
    loginSubmit.disabled = true;
    const origText = loginSubmit.textContent;
    loginSubmit.textContent = '登录中…';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: { account, password }
      });
      state.currentUser = data;
      toast('登录成功');
      navigate('/');
    } catch (e) {
      loginError.textContent = e.message || '登录失败';
      loginError.hidden = false;
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = origText;
    }
  });

  // 注册 — 邮箱和用户名至少填一个
  const registerError = container.querySelector('#register-error');
  const registerSubmit = container.querySelector('#register-submit');
  const emailInput = container.querySelector('#register-email');
  const usernameInput = container.querySelector('#register-username');

  // 邮箱输入时自动建议用户名
  emailInput.addEventListener('input', () => {
    const email = emailInput.value.trim();
    if (email && email.includes('@') && !usernameInput.value) {
      const suggested = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
      if (suggested) usernameInput.placeholder = '建议: ' + suggested;
    } else {
      usernameInput.placeholder = '字母、数字、下划线';
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    const username = usernameInput.value.trim();
    const password = container.querySelector('#register-password').value;
    const confirmPassword = container.querySelector('#register-confirm').value;
    if (!email && !username) {
      registerError.textContent = '请填写用户名或邮箱';
      registerError.hidden = false;
      return;
    }
    if (!password || !confirmPassword) return;
    registerError.hidden = true;
    registerSubmit.disabled = true;
    const origText = registerSubmit.textContent;
    registerSubmit.textContent = '注册中…';
    try {
      const body = { password, confirmPassword };
      if (email) body.email = email;
      if (username) body.username = username;
      const data = await api('/api/auth/register', {
        method: 'POST',
        body
      });
      state.currentUser = data;
      toast(data.email && !data.emailVerified ? '注册成功，请验证邮箱' : '注册成功');
      navigate('/');
    } catch (e) {
      registerError.textContent = e.message || '注册失败';
      registerError.hidden = false;
    } finally {
      registerSubmit.disabled = false;
      registerSubmit.textContent = origText;
    }
  });
}

export { renderLogin };
