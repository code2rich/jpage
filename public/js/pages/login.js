// 登录页：用户名密码登录、错误提示

import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { state, navigate } from '../app.js';

function renderLogin(container) {
  if (state.currentUser) { navigate('/'); return; }
  const tmpl = document.getElementById('login-template');
  container.innerHTML = '';
  container.appendChild(tmpl.content.cloneNode(true));

  const form = container.querySelector('#login-form');
  const errEl = container.querySelector('#login-error');
  const submit = container.querySelector('#login-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = container.querySelector('#login-username').value.trim();
    const password = container.querySelector('#login-password').value;
    if (!username || !password) return;
    errEl.hidden = true;
    submit.disabled = true;
    const origText = submit.textContent;
    submit.textContent = '登录中…';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: { username, password }
      });
      state.currentUser = data;
      toast('登录成功');
      navigate('/');
    } catch (e) {
      errEl.textContent = e.message || '登录失败';
      errEl.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = origText;
    }
  });
}

export { renderLogin };
