// 问题反馈弹窗组件。
// 导出 openFeedbackModal()，供落地页页脚链接与工作台「设置 → 问题反馈」菜单项复用。
// 复用 index.html 内的 #feedback-modal 模板块，以及 utils.js 的 openModal/closeModal。

import { api } from '../api.js';
import { toast } from './toast.js';
import { openModal, closeModal } from '../utils.js';

let bound = false;

function bindOnce(modal) {
  if (bound || !modal) return;
  bound = true;

  const closeBtn = modal.querySelector('#feedback-modal-close');
  const cancelBtn = modal.querySelector('#feedback-modal-cancel');
  const submitBtn = modal.querySelector('#feedback-modal-submit');
  const chipGroup = modal.querySelector('#feedback-category-group');
  const contentInput = modal.querySelector('#feedback-content');
  const countEl = modal.querySelector('#feedback-content-count');

  closeBtn.addEventListener('click', () => closeModal(modal));
  cancelBtn.addEventListener('click', () => closeModal(modal));
  // 点击遮罩关闭
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal); });

  // 类型 chips：单选切换
  chipGroup.addEventListener('click', (e) => {
    const chip = e.target.closest('.feedback-category-chip');
    if (!chip) return;
    chipGroup.querySelectorAll('.feedback-category-chip').forEach((c) => {
      const active = c === chip;
      c.classList.toggle('active', active);
      c.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  });

  // 字数统计
  const syncCount = () => {
    const len = contentInput.value.length;
    countEl.textContent = `${len} / 5000`;
  };
  contentInput.addEventListener('input', () => {
    syncCount();
    hideError(modal);
  });

  submitBtn.addEventListener('click', () => submit(modal));
}

function showError(modal, msg) {
  const el = modal.querySelector('#feedback-error');
  el.textContent = msg;
  el.hidden = false;
}
function hideError(modal) {
  const el = modal.querySelector('#feedback-error');
  el.textContent = '';
  el.hidden = true;
}

function selectedCategory(modal) {
  const active = modal.querySelector('.feedback-category-chip.active');
  return active ? active.dataset.category : 'feature';
}

async function submit(modal) {
  const content = modal.querySelector('#feedback-content').value.trim();
  const name = modal.querySelector('#feedback-name').value.trim();
  const contact = modal.querySelector('#feedback-contact').value.trim();
  const category = selectedCategory(modal);
  const submitBtn = modal.querySelector('#feedback-modal-submit');

  if (!content) { showError(modal, '请填写反馈内容'); return; }
  if (content.length > 5000) { showError(modal, '反馈内容不能超过 5000 字'); return; }

  hideError(modal);
  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.innerHTML = '<span class="spinner"></span> 提交中...';

  try {
    await api('/api/feedback', { method: 'POST', body: { content, category, name, contact } });
    toast('感谢反馈，我们已收到');
    resetForm(modal);
    closeModal(modal);
  } catch (e) {
    showError(modal, e.message || '提交失败，请稍后重试');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

function resetForm(modal) {
  modal.querySelector('#feedback-content').value = '';
  modal.querySelector('#feedback-name').value = '';
  modal.querySelector('#feedback-contact').value = '';
  modal.querySelector('#feedback-content-count').textContent = '0 / 5000';
  // 类型重置为「功能建议」
  modal.querySelectorAll('.feedback-category-chip').forEach((c) => {
    const active = c.dataset.category === 'feature';
    c.classList.toggle('active', active);
    c.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  hideError(modal);
}

function openFeedbackModal() {
  const modal = document.getElementById('feedback-modal');
  if (!modal) return;
  bindOnce(modal);
  resetForm(modal);

  // 二维码：图片存在才显示，避免破图
  const qr = modal.querySelector('#feedback-wechat-qr');
  if (qr && qr.dataset.checked !== '1') {
    qr.dataset.checked = '1';
    qr.addEventListener('error', () => { qr.hidden = true; });
    // 测试图片可达性：先隐藏，加载成功后显示
    qr.hidden = true;
    const test = new Image();
    test.onload = () => { qr.hidden = false; };
    test.onerror = () => { qr.hidden = true; };
    test.src = qr.src;
  }

  openModal(modal);
  // 自动聚焦内容框
  setTimeout(() => modal.querySelector('#feedback-content')?.focus(), 0);
}

export { openFeedbackModal };
