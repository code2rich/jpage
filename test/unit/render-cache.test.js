// lib/render-cache.js 单元测试
const test = require('node:test');
const assert = require('node:assert');
const {
  renderCacheKey,
  getRenderedHtml,
  setRenderedHtml,
  invalidateRenderCache,
  clearRenderCache,
} = require('../../lib/render-cache');

function fakeFile(id, overrides = {}) {
  return {
    id,
    stored_name: `f${id}.md`,
    updated_at: '2026-01-01 00:00:00',
    is_bundle: 0,
    entry_path: null,
    ...overrides,
  };
}

test('renderCacheKey：含 id/stored_name/updated_at/is_bundle/entry_path', () => {
  const key = renderCacheKey(fakeFile(1));
  assert.ok(key.startsWith('1:f1.md:2026-01-01 00:00:00:0:'));
});

test('renderCacheKey：stored_name 不同则 key 不同（历史版本场景）', () => {
  const a = renderCacheKey(fakeFile(1, { stored_name: 'current.md' }));
  const b = renderCacheKey(fakeFile(1, { stored_name: 'v2.md' }));
  assert.notStrictEqual(a, b);
});

test('getRenderedHtml：未缓存返回 null', () => {
  clearRenderCache();
  assert.strictEqual(getRenderedHtml(fakeFile(99)), null);
});

test('setRenderedHtml / getRenderedHtml：写入后命中', () => {
  clearRenderCache();
  const f = fakeFile(2);
  setRenderedHtml(f, '<html></html>');
  assert.strictEqual(getRenderedHtml(f), '<html></html>');
});

test('setRenderedHtml：updated_at 变化后旧缓存失效', () => {
  clearRenderCache();
  const f1 = fakeFile(3, { updated_at: '2026-01-01 00:00:00' });
  setRenderedHtml(f1, 'old');
  const f2 = fakeFile(3, { updated_at: '2026-01-02 00:00:00' });
  assert.strictEqual(getRenderedHtml(f2), null);
});

test('invalidateRenderCache：按 fileId 清除该文件全部缓存', () => {
  clearRenderCache();
  setRenderedHtml(fakeFile(5, { stored_name: 'a.md' }), 'a');
  setRenderedHtml(fakeFile(5, { stored_name: 'b.md' }), 'b');
  setRenderedHtml(fakeFile(6), 'other');
  invalidateRenderCache(5);
  assert.strictEqual(getRenderedHtml(fakeFile(5, { stored_name: 'a.md' })), null);
  assert.strictEqual(getRenderedHtml(fakeFile(5, { stored_name: 'b.md' })), null);
  assert.ok(getRenderedHtml(fakeFile(6))); // 其它文件不受影响
});

test('LRU 淘汰：超过 256 条时淘汰最早的', () => {
  clearRenderCache();
  // 填满 256 条
  for (let i = 0; i < 256; i++) {
    setRenderedHtml(fakeFile(1000 + i), `html${i}`);
  }
  // 第 257 条触发淘汰 id=1000 的
  setRenderedHtml(fakeFile(2000), 'new');
  assert.strictEqual(getRenderedHtml(fakeFile(1000)), null);
  assert.strictEqual(getRenderedHtml(fakeFile(2000)), 'new');
  clearRenderCache();
});
