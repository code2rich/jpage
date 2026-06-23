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

// 数据库存储的时间是 UTC（SQLite CURRENT_TIMESTAMP / datetime('now')），
// 但返回给前端的是无时区标记的字符串（如 "2026-06-23 06:33:37"）。
// new Date() 会把这类字符串当作本地时间解析，导致显示偏移一个时区（东八区差 8 小时）。
// 这里统一补上 'Z' 让其按 UTC 解析，再由浏览器换算成本地时区显示。
function parseDate(dateStr) {
  if (!dateStr) return null;
  // 已带时区（Z / ±hh:mm）或仅日期：交给原生解析
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(dateStr) || /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr);
  }
  // "YYYY-MM-DD HH:MM:SS"（无时区）→ 视作 UTC
  return new Date(dateStr.replace(' ', 'T') + 'Z');
}

function relativeTime(dateStr) {
  const then = parseDate(dateStr);
  if (!then || isNaN(then)) return '';
  const now = Date.now();
  const diff = now - then.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return then.toLocaleDateString('zh-CN');
}

function formatDate(iso) {
  const d = parseDate(iso);
  if (!d || isNaN(d)) return '-';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function buildSkeletonCards(n, viewMode) {
  let html = '';
  for (let i = 0; i < n; i++) {
    if (viewMode === 'card') {
      html += '<div class="skeleton-item skeleton-card" aria-hidden="true">'
        + '<div class="skeleton-card-thumb"></div>'
        + '<div class="skeleton-line skeleton-w60"></div>'
        + '<div class="skeleton-line skeleton-w40"></div>'
        + '</div>';
    } else {
      html += '<div class="skeleton-item" aria-hidden="true">'
        + '<div class="skeleton-icon"></div>'
        + '<div class="skeleton-lines">'
        + '<div class="skeleton-line skeleton-w60"></div>'
        + '<div class="skeleton-line skeleton-w40"></div>'
        + '</div></div>';
    }
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

// 复制到剪贴板：优先用现代 Clipboard API，回退到 execCommand
// 返回 boolean 表示是否成功，由调用方决定降级行为（如手动选中提示）
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const input = document.createElement('input');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      return true;
    } catch (e) {
      return false;
    }
  }
}

export { escapeHtml, formatSize, relativeTime, formatDate, esc, buildSkeletonCards, openModal, closeModal, copyToClipboard };
