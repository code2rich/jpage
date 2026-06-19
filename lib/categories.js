// 分类名称内存缓存：列表/搜索每次都会用 categoryId -> name 做映射，
// 分类表变更频率极低。启动时加载，写入（增/删/改名/导入）时失效重建。
// 从 server.js 提取，行为保持不变。

const { dbAll } = require('./db');

let categoryNameCache = {}; // id -> name

async function reloadCategoryNameCache() {
  const rows = await dbAll('SELECT id, name FROM categories');
  const map = {};
  for (const r of rows) map[r.id] = r.name;
  categoryNameCache = map;
}

function getCategoryName(id) {
  return categoryNameCache[id] || null;
}

module.exports = { reloadCategoryNameCache, getCategoryName };
