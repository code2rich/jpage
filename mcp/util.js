// MCP 工具的纯函数 + API 辅助。从 mcp-server.js 提取，行为保持不变。
// 被 tools-files / tools-tags / tools-versions 等模块共享。

// 把任意 payload 包成 MCP tool 结果（text content）。opts.isError 标记工具级错误。
function textResult(payload, opts = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

// 人类可读的字节大小。
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ISO → YYYY-MM-DD HH:mm（falsy 返回「未知时间」）。
function formatTime(iso) {
  if (!iso) return '未知时间';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 标签名 → id 列表。不存在的标签自动创建（POST /api/tags，重复名返回现有）。
async function resolveTagIds(api, tags) {
  if (!tags || tags.length === 0) return [];
  const all = await api.get('/api/tags');
  const existing = new Map(all.tags.map(t => [t.name, t.id]));
  const tagIds = [];
  for (const name of tags) {
    if (existing.has(name)) {
      tagIds.push(existing.get(name));
    } else {
      const created = await api.post('/api/tags', { name });
      tagIds.push(created.id);
      existing.set(name, created.id);
    }
  }
  return tagIds;
}

// 上传后为文件设置标签 + 分类（upload_file / batch 用）。
async function applyTagsAndCategory(api, fileId, tags, categoryId) {
  if (tags && tags.length > 0) {
    const tagIds = await resolveTagIds(api, tags);
    await api.put(`/api/files/${fileId}/tags`, { tagIds });
  }
  if (categoryId) {
    await api.put(`/api/files/${fileId}/category`, { categoryId });
  }
}

module.exports = {
  textResult,
  formatSize,
  formatTime,
  resolveTagIds,
  applyTagsAndCategory,
};
