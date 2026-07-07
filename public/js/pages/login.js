// 登录/注册页：统一入口，支持 GitHub / 微信 OAuth 与邮箱/用户名登录。
// 邮箱未注册时自动发送验证码并引导完成注册；用户名不存在时提示错误。

import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { state, navigate } from '../app.js';

function currentReturnTo() {
  const hash = location.hash.replace(/^#/, '');
  return (hash && hash !== '/login' && hash !== '/register') ? hash : '/';
}

function renderLogin(container) {
  if (state.currentUser) { navigate('/'); return; }
  const tmpl = document.getElementById('login-template');
  container.innerHTML = '';
  container.appendChild(tmpl.content.cloneNode(true));

  const oauthBox = container.querySelector('#auth-oauth');
  const githubBtn = container.querySelector('#btn-github-login');
  const wechatBtn = container.querySelector('#btn-wechat-login');

  // GitHub 登录
  api('/api/auth/github/status').then(data => {
    if (data.enabled && oauthBox && githubBtn) oauthBox.hidden = false;
  }).catch(() => {});
  githubBtn?.addEventListener('click', () => {
    const returnTo = encodeURIComponent(currentReturnTo());
    location.href = `/api/auth/github/start?returnTo=${returnTo}`;
  });

  // 微信登录（保留兼容）
  api('/api/auth/wechat/status').then(data => {
    if (data.enabled && oauthBox && wechatBtn) {
      oauthBox.hidden = false;
      wechatBtn.hidden = false;
    }
  }).catch(() => {});
  wechatBtn?.addEventListener('click', () => {
    const returnTo = encodeURIComponent(currentReturnTo());
    location.href = `/api/auth/wechat/start?returnTo=${returnTo}`;
  });

  // 统一登录/注册表单
  const authForm = container.querySelector('#auth-form');
  const accountInput = container.querySelector('#auth-account');
  const passwordInput = container.querySelector('#auth-password');
  const authSubmit = container.querySelector('#auth-submit');
  const authError = container.querySelector('#auth-error');

  // 注册补充区
  const registerExtra = container.querySelector('#register-extra');
  const registerEmail = container.querySelector('#register-email');
  const registerCode = container.querySelector('#register-code');
  const sendCodeBtn = container.querySelector('#btn-send-code');
  const codeTip = container.querySelector('#register-code-tip');
  const registerUsername = container.querySelector('#register-username');
  const usernameHint = container.querySelector('#register-username-hint');
  const registerPassword = container.querySelector('#register-password');
  const registerConfirm = container.querySelector('#register-confirm');
  const registerSubmit = container.querySelector('#register-submit');
  const registerError = container.querySelector('#register-error');
  const backToLoginBtn = container.querySelector('#btn-back-to-login');

  function showError(el, msg) {
    el.textContent = msg;
    el.hidden = false;
  }
  function clearError(el) { el.textContent = ''; el.hidden = true; }

  function showRegisterExtra(email) {
    authForm.classList.remove('active');
    authForm.hidden = true;
    registerExtra.hidden = false;
    registerExtra.classList.add('active');
    registerEmail.value = email;
    registerCode.value = '';
    registerPassword.value = '';
    registerConfirm.value = '';
    registerUsername.value = '';
    clearError(registerError);
  }

  function resetToLogin() {
    registerExtra.hidden = true;
    registerExtra.classList.remove('active');
    authForm.hidden = false;
    authForm.classList.add('active');
    passwordInput.value = '';
    clearError(authError);
  }

  backToLoginBtn?.addEventListener('click', resetToLogin);

  // 用户名实时校验
  registerUsername?.addEventListener('input', () => {
    const val = registerUsername.value.trim();
    if (!val) { usernameHint.hidden = true; usernameHint.textContent = ''; return; }
    if (/[^a-zA-Z0-9_]/.test(val)) {
      usernameHint.textContent = '用户名只能包含字母、数字和下划线';
      usernameHint.hidden = false;
    } else if (val.length < 2) {
      usernameHint.textContent = '用户名至少 2 个字符';
      usernameHint.hidden = false;
    } else {
      usernameHint.hidden = true;
      usernameHint.textContent = '';
    }
  });

  // 统一表单提交：登录 / 触发注册验证码
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const account = accountInput.value.trim();
    const password = passwordInput.value;
    if (!account || !password) return;
    clearError(authError);
    authSubmit.disabled = true;
    const origText = authSubmit.textContent;
    authSubmit.textContent = '处理中…';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: { account, password }
      });
      if (data.action === 'register_code_sent') {
        showRegisterExtra(data.email);
        toast('验证码已发送，请查收邮件');
        return;
      }
      state.currentUser = data;
      toast('登录成功');
      navigate('/');
    } catch (e) {
      let msg = e.message || '登录失败';
      if (e.status === 401) msg = '密码错误';
      else if (e.status === 404) msg = '用户名不存在';
      else if (e.status === 400) msg = e.message || '请求格式错误';
      showError(authError, msg);
    } finally {
      authSubmit.disabled = false;
      authSubmit.textContent = origText;
    }
  });

  // 发送验证码
  let codeTimer = null;
  let tipTimer = null;
  sendCodeBtn?.addEventListener('click', async () => {
    const email = registerEmail.value.trim();
    if (!email) { showError(registerError, '邮箱不能为空'); return; }
    clearError(registerError);
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
      showError(registerError, e.message || '发送失败');
      sendCodeBtn.disabled = false;
    }
  });

  // 注册提交
  registerExtra.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = registerEmail.value.trim();
    const code = registerCode.value.trim();
    const username = registerUsername.value.trim();
    const password = registerPassword.value;
    const confirmPassword = registerConfirm.value;
    if (!email) { showError(registerError, '请填写邮箱'); return; }
    if (!code) { showError(registerError, '请填写验证码'); return; }
    if (!password || !confirmPassword) { showError(registerError, '请填写密码'); return; }
    if (password.length < 8) { showError(registerError, '密码至少 8 位'); return; }
    if (password !== confirmPassword) { showError(registerError, '两次密码不一致'); return; }
    if (username && !/^[a-zA-Z0-9_]{2,30}$/.test(username)) {
      showError(registerError, '用户名只能包含字母、数字和下划线，2-30 位');
      return;
    }
    clearError(registerError);
    registerSubmit.disabled = true;
    const origText = registerSubmit.textContent;
    registerSubmit.textContent = '注册中…';
    try {
      const body = { email, code, password, confirmPassword };
      if (username) body.username = username;
      const data = await api('/api/auth/register', { method: 'POST', body });
      state.currentUser = data;
      toast('注册成功');
      navigate('/');
    } catch (e) {
      showError(registerError, e.message || '注册失败');
    } finally {
      registerSubmit.disabled = false;
      registerSubmit.textContent = origText;
    }
  });
}

export { renderLogin };
