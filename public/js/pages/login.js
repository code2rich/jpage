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

  // 注册 — 邮箱必填，验证码校验
  const registerError = container.querySelector('#register-error');
  const registerSubmit = container.querySelector('#register-submit');
  const emailInput = container.querySelector('#register-email');
  const usernameInput = container.querySelector('#register-username');
  const codeInput = container.querySelector('#register-code');
  const sendCodeBtn = container.querySelector('#btn-send-code');
  const codeTip = container.querySelector('#register-code-tip');
  let codeTimer = null;
  let tipTimer = null;

  // 发送验证码
  sendCodeBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    if (!email) { registerError.textContent = '请先填写邮箱'; registerError.hidden = false; return; }
    registerError.hidden = true;
    sendCodeBtn.disabled = true;
    try {
      await api('/api/auth/send-register-code', { method: 'POST', body: { email } });
      toast('验证码已发送');
      let remain = 60;
      sendCodeBtn.textContent = remain + 's';
      codeTimer = setInterval(() => {
        remain--;
        if (remain <= 0) {
          clearInterval(codeTimer);
          clearInterval(tipTimer);
          sendCodeBtn.disabled = false;
          sendCodeBtn.textContent = '发送验证码';
          codeTip.hidden = true;
        } else {
          sendCodeBtn.textContent = remain + 's';
        }
      }, 1000);
      // 剩余 30s 时开始轮转提示
      setTimeout(() => {
        if (remain <= 0) return;
        const tips = ['还没收到？检查一下垃圾邮件', '邮件可能在垃圾箱里，去看看吧', '仍未收到？稍等片刻再查看'];
        let tipIdx = 0;
        function showTip() {
          codeTip.textContent = tips[tipIdx % tips.length];
          codeTip.hidden = false;
          tipIdx++;
        }
        showTip();
        tipTimer = setInterval(showTip, 5000);
      }, 30000);
    } catch (e) {
      registerError.textContent = e.message || '发送失败';
      registerError.hidden = false;
      sendCodeBtn.disabled = false;
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    const code = codeInput.value.trim();
    const username = usernameInput.value.trim();
    const password = container.querySelector('#register-password').value;
    const confirmPassword = container.querySelector('#register-confirm').value;
    if (!email) { registerError.textContent = '请填写邮箱'; registerError.hidden = false; return; }
    if (!code) { registerError.textContent = '请填写验证码'; registerError.hidden = false; return; }
    if (!password || !confirmPassword) return;
    registerError.hidden = true;
    registerSubmit.disabled = true;
    const origText = registerSubmit.textContent;
    registerSubmit.textContent = '注册中…';
    try {
      const body = { email, code, password, confirmPassword };
      if (username) body.username = username;
      const data = await api('/api/auth/register', {
        method: 'POST',
        body
      });
      state.currentUser = data;
      toast('注册成功');
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
