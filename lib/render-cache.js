// 渲染缓存：Markdown 渲染（marked + highlight.js + KaTeX）是 CPU 热点，
// 公开短链 /render 热门文档被反复渲染。缓存以 (fileId, updated_at) 为失效键：
// 覆盖上传会更新 updated_at，旧缓存自动失效。HTML/Bundle 不缓存（主要瓶颈是磁盘读，
// 且注入逻辑依赖文件内容，缓存收益低、失效复杂）。
// 从 server.js 提取，行为保持不变。

const RENDER_CACHE = new Map(); // key -> { html, ts }
const RENDER_CACHE_MAX = 256;

function renderCacheKey(file) {
  // stored_name 必须进 key：历史版本渲染会用 { ...file, stored_name: ver.stored_name }，
  // 若不加会错误命中当前版本的缓存。
  return `${file.id}:${file.stored_name || ''}:${file.updated_at || ''}:${file.is_bundle ? 1 : 0}:${file.entry_path || ''}`;
}

function getRenderedHtml(file) {
  const key = renderCacheKey(file);
  return RENDER_CACHE.has(key) ? RENDER_CACHE.get(key).html : null;
}

function setRenderedHtml(file, html) {
  const key = renderCacheKey(file);
  if (RENDER_CACHE.size >= RENDER_CACHE_MAX && !RENDER_CACHE.has(key)) {
    // 简单 LRU 淘汰：删最早的 key（Map 保持插入顺序）
    const firstKey = RENDER_CACHE.keys().next().value;
    RENDER_CACHE.delete(firstKey);
  }
  RENDER_CACHE.set(key, { html });
}

function invalidateRenderCache(fileId) {
  for (const k of RENDER_CACHE.keys()) {
    if (k.startsWith(`${fileId}:`)) RENDER_CACHE.delete(k);
  }
}

// 数据导入替换数据库连接后，清空全部渲染缓存
function clearRenderCache() {
  RENDER_CACHE.clear();
}

module.exports = {
  renderCacheKey,
  getRenderedHtml,
  setRenderedHtml,
  invalidateRenderCache,
  clearRenderCache,
};
