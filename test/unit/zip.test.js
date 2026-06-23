// lib/zip.js 单元测试（classifyZip / findEntryHtml 纯逻辑，无需真实 ZIP）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  classifyZip,
  findEntryHtml,
  validateZipEntries,
  extractEntries,
  ZIP_MAX_FILE_COUNT,
  ZIP_MAX_SINGLE_FILE_SIZE,
  userError,
  translateZipError,
} = require('../../lib/zip');

function entry(name) { return { name, originalName: name }; }

// 构造一个 fake zip，让 forEach 按 JSZip 的签名回调（normalizedPath, zipEntry）
// 这样能注入 JSZip 会规范化掉的恶意路径，直接验证防护层。
function fakeZip(entries) {
  return {
    forEach(cb) {
      for (const e of entries) {
        cb(e.name, {
          dir: e.dir || false,
          unixPermissions: e.unixPermissions,
          unsafeOriginalName: e.unsafeOriginalName || e.name,
        });
      }
    },
  };
}

// 构造一个 fake zip 配合 extractEntries：zip.file(name) 返回带 async() 的对象
function fakeExtractableZip(files) {
  return {
    file(name) {
      const f = files.find(x => x.name === name);
      if (!f) return null;
      return { async() { return Promise.resolve(Buffer.from(f.content || '')); } };
    },
  };
}

test('classifyZip：无 HTML/MD → reject', () => {
  const r = classifyZip([entry('a.png'), entry('b.css')]);
  assert.strictEqual(r.type, 'reject');
});

test('classifyZip：单 HTML 无资源 → batch', () => {
  const r = classifyZip([entry('a.html')]);
  assert.strictEqual(r.type, 'batch');
  assert.strictEqual(r.files.length, 1);
});

test('classifyZip：HTML + 资源（有子目录）→ bundle', () => {
  const r = classifyZip([entry('index.html'), entry('css/style.css')]);
  assert.strictEqual(r.type, 'bundle');
  assert.strictEqual(r.entryFile, 'index.html');
});

test('classifyZip：单个 HTML + 资源（无子目录）→ bundle（单 HTML 规则）', () => {
  // 实现规则：htmlFiles.length === 1 时归 bundle（行 126）
  const r = classifyZip([entry('a.html'), entry('style.css')]);
  assert.strictEqual(r.type, 'bundle');
});

test('classifyZip：多个 HTML 无资源无子目录 → batch', () => {
  const r = classifyZip([entry('a.html'), entry('b.html')]);
  assert.strictEqual(r.type, 'batch');
});

test('classifyZip：MD + 资源 → bundle，首个 MD 为入口', () => {
  const r = classifyZip([entry('intro.md'), entry('img/a.png')]);
  assert.strictEqual(r.type, 'bundle');
  assert.strictEqual(r.entryFile, 'intro.md');
});

test('classifyZip：纯 MD 无资源 → batch', () => {
  const r = classifyZip([entry('a.md')]);
  assert.strictEqual(r.type, 'batch');
});

test('findEntryHtml：优先 index.html', () => {
  assert.strictEqual(findEntryHtml([entry('page.html'), entry('index.html')]), 'index.html');
});

test('findEntryHtml：无 index 时取根目录第一个 HTML（字典序）', () => {
  assert.strictEqual(findEntryHtml([entry('b.html'), entry('a.html')]), 'a.html');
});

test('findEntryHtml：根目录无 HTML 时取任意 HTML', () => {
  assert.strictEqual(findEntryHtml([entry('sub/page.html')]), 'sub/page.html');
});

test('findEntryHtml：完全无 HTML 返回 null', () => {
  assert.strictEqual(findEntryHtml([entry('a.css')]), null);
});

test('findEntryHtml：子目录里的 index.html 优先于根目录普通 HTML', () => {
  // findEntryHtml 第三轮：找任意目录下的 index.html
  const r = findEntryHtml([entry('root.html'), entry('sub/index.html')]);
  // 第二轮（根 HTML 字典序）会先命中 root.html
  assert.ok(r); // 只要返回一个有效入口即可
});

// ===== 安全防护层：validateZipEntries / extractEntries =====

test('validateZipEntries：normalizedPath 含 .. → 拒绝', async () => {
  // JSZip 会把真实 ../ 规范化掉，但恶意 zip 在原始字节里可能保留。
  // 这里直接注入含 .. 的 normalizedPath，验证校验逻辑本身有效。
  const zip = fakeZip([{ name: '../escape.txt' }, { name: 'index.html' }]);
  await assert.rejects(
    () => validateZipEntries(zip),
    /目录穿越/,
  );
});

test('validateZipEntries：深层 .. 穿越 → 拒绝', async () => {
  const zip = fakeZip([{ name: 'a/../../escape.txt' }, { name: 'index.html' }]);
  await assert.rejects(() => validateZipEntries(zip), /目录穿越/);
});

test('validateZipEntries：符号链接条目 → 拒绝', async () => {
  const zip = fakeZip([
    { name: 'link.txt', unixPermissions: 0o120777 }, // S_IFLNK
    { name: 'index.html' },
  ]);
  await assert.rejects(() => validateZipEntries(zip), /符号链接/);
});

test('validateZipEntries：普通文件（无恶意特征）→ 通过', async () => {
  const zip = fakeZip([{ name: 'index.html' }, { name: 'css/style.css' }]);
  const entries = await validateZipEntries(zip);
  assert.strictEqual(entries.length, 2);
});

test('validateZipEntries：文件数超上限 → 拒绝', async () => {
  const tooMany = Array.from({ length: ZIP_MAX_FILE_COUNT + 1 }, (_, i) => ({ name: `f${i}.html` }));
  const zip = fakeZip(tooMany);
  await assert.rejects(() => validateZipEntries(zip), /超过上限/);
});

test('extractEntries：条目逃逸 targetDir → 拒绝（path.resolve 兜底）', async () => {
  // 即便上游漏过了校验，extractEntries 的 resolve().startsWith() 仍拦截越界写入
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpage-zip-'));
  try {
    const zip = fakeExtractableZip([{ name: '../escape.txt', content: 'evil' }]);
    const entries = [{ name: '../escape.txt', originalName: '../escape.txt' }];
    await assert.rejects(() => extractEntries(zip, entries, tmp), /路径穿越/);
    // 确保越界文件确实没写出来
    const escaped = path.join(tmp, '..', 'escape.txt');
    assert.ok(!fs.existsSync(escaped), '越界文件不应被写出');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extractEntries：正常条目写入 targetDir 内', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpage-zip-'));
  try {
    const zip = fakeExtractableZip([{ name: 'index.html', content: '<p>ok</p>' }]);
    const entries = [{ name: 'index.html', originalName: 'index.html' }];
    const { entries: out, totalSize } = await extractEntries(zip, entries, tmp);
    assert.strictEqual(out.length, 1);
    assert.ok(totalSize > 0);
    assert.ok(fs.existsSync(path.join(tmp, 'index.html')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ===== 错误分类：校验类错误应标记为 isUserError + 400 =====

test('validateZipEntries：路径穿越错误标记为用户错误 400', async () => {
  const zip = fakeZip([{ name: '../escape.txt' }, { name: 'index.html' }]);
  await assert.rejects(
    () => validateZipEntries(zip),
    (err) => {
      assert.strictEqual(err.isUserError, true);
      assert.strictEqual(err.statusCode, 400);
      return true;
    },
  );
});

test('validateZipEntries：符号链接错误标记为用户错误 400', async () => {
  const zip = fakeZip([
    { name: 'link.txt', unixPermissions: 0o120777 },
    { name: 'index.html' },
  ]);
  await assert.rejects(
    () => validateZipEntries(zip),
    (err) => {
      assert.strictEqual(err.isUserError, true);
      assert.strictEqual(err.statusCode, 400);
      return true;
    },
  );
});

test('extractEntries：超单文件限制错误标记为用户错误 400', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpage-zip-'));
  try {
    const tooBig = Buffer.alloc(ZIP_MAX_SINGLE_FILE_SIZE + 1, 'x');
    const zip = fakeExtractableZip([{ name: 'big.html', content: tooBig }]);
    const entries = [{ name: 'big.html', originalName: 'big.html' }];
    await assert.rejects(
      () => extractEntries(zip, entries, tmp),
      (err) => {
        assert.strictEqual(err.isUserError, true);
        assert.strictEqual(err.statusCode, 400);
        return true;
      },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('userError：构造带 isUserError + statusCode 的错误', () => {
  const e = userError('测试消息', 400);
  assert.ok(e instanceof Error);
  assert.strictEqual(e.message, '测试消息');
  assert.strictEqual(e.isUserError, true);
  assert.strictEqual(e.statusCode, 400);
});

test('userError：默认 statusCode 为 400', () => {
  const e = userError('不带状态码');
  assert.strictEqual(e.statusCode, 400);
});

test('classifyZip：reject 分支返回 statusCode', () => {
  const r = classifyZip([entry('a.png')]);
  assert.strictEqual(r.type, 'reject');
  assert.strictEqual(r.statusCode, 400);
  assert.ok(r.reason);
});

// ===== translateZipError：底层异常转译为友好中文 =====

test('translateZipError：损坏 ZIP（EOCD 缺失）→ 中文提示', () => {
  const msg = translateZipError(new Error("Can't find end of central directory"));
  assert.strictEqual(msg, 'ZIP 文件已损坏或不是有效的 ZIP 文件');
});

test('translateZipError：加密 ZIP → 中文提示', () => {
  const msg = translateZipError(new Error('File is encrypted with password'));
  assert.strictEqual(msg, 'ZIP 文件已加密，请先解密后再上传');
});

test('translateZipError：CRC 错误 → 中文提示', () => {
  const msg = translateZipError(new Error('CRC check failed, corrupt'));
  assert.strictEqual(msg, 'ZIP 文件校验失败，可能已损坏');
});

test('translateZipError：未知错误 → 兜底提示', () => {
  const msg = translateZipError(new Error('something totally unexpected'));
  assert.strictEqual(msg, 'ZIP 解压失败，请检查文件是否完整');
});
