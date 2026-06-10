// 工具函数：HTML 转义、文件大小格式化、相对时间、骨架屏等

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function relativeTime(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return '';
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return new Date(dateStr).toLocaleDateString('zh-CN');
}

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function buildSkeletonCards(n) {
  let html = '';
  for (let i = 0; i < n; i++) {
    html += '<div class="skeleton-item" aria-hidden="true">'
      + '<div class="skeleton-icon"></div>'
      + '<div class="skeleton-lines">'
      + '<div class="skeleton-line skeleton-w60"></div>'
      + '<div class="skeleton-line skeleton-w40"></div>'
      + '</div></div>';
  }
  return html;
}

function openModal(el) {
  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
}

function closeModal(el) {
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
}

export { escapeHtml, formatSize, relativeTime, formatDate, esc, buildSkeletonCards, openModal, closeModal };
