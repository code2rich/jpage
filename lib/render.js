// 文件渲染：listBundleEntries（bundle 目录清单）+ renderFile（Markdown/HTML/bundle → HTML 文档）。
// Markdown 渲染页下发严格 CSP（内联 mermaid 脚本靠每次生成的 nonce 放行），
// HTML 渲染页下发宽松 CSP（用户 HTML 常含合法 script，依赖 iframe sandbox 兜底）。

const fs = require('fs');
const path = require('path');
const { marked, applyTemplate, templateCache, getTemplateForFile, BUILTIN_TEMPLATE_THEMES } = require('./templates');
const { getRenderedHtml, setRenderedHtml } = require('./render-cache');
const { UPLOAD_DIR } = require('./paths');
const { ZIP_MAX_FILE_COUNT } = require('./zip');
const { generateNonce, markdownCsp, HTML_CSP } = require('./csp');

// 枚举 bundle 目录组成，供 /content 返回清单。
// 安全与体量约束：条目数上限与上传校验一致（ZIP_MAX_FILE_COUNT），
// 另设深度上限避免畸形嵌套；只收录 bundle 目录内的相对路径，防穿越。
const BUNDLE_LIST_MAX_DEPTH = 8;
const BUNDLE_LIST_MAX_ENTRIES = ZIP_MAX_FILE_COUNT;

async function listBundleEntries(bundleDir) {
  const root = path.resolve(bundleDir);
  const out = [];
  let truncated = false;

  async function walk(dir, depth) {
    if (out.length >= BUNDLE_LIST_MAX_ENTRIES || depth > BUNDLE_LIST_MAX_DEPTH) {
      truncated = true;
      return;
    }
    let names;
    try { names = await fs.promises.readdir(dir); }
    catch { return; } // 子目录不可读则跳过，不致整个清单失败
    for (const name of names) {
      const full = path.join(dir, name);
      const resolved = path.resolve(full);
      const rel = path.relative(root, resolved);
      // 仅收录 root 内的条目，跳过越界/穿越项
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      let st;
      try { st = await fs.promises.stat(full); }
      catch { continue; }
      const relPosix = rel.split(path.sep).join('/');
      if (st.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        if (out.length >= BUNDLE_LIST_MAX_ENTRIES) { truncated = true; return; }
        out.push({ path: relPosix, size: st.size });
      }
    }
  }

  await walk(bundleDir, 0);
  return { entries: out, truncated };
}

// 发送 Markdown 渲染结果：注入 nonce 到内联 <script>（无 src），下发严格 CSP。
// 缓存的是「无 nonce 的模板 HTML」，每次发送时动态注入 nonce，保证 nonce 唯一。
function sendMarkdownHtml(res, html) {
  const nonce = generateNonce();
  // 只给内联 <script>（无 src 属性）加 nonce；外链 <script src> 走 'self' 无需 nonce
  const withNonce = html.replace(/<script(?![^>]*\bsrc=)([^>]*)>/gi, '<script nonce="' + nonce + '"$1>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', markdownCsp(nonce));
  res.send(withNonce);
}

// 发送 HTML 渲染结果：下发宽松 CSP（依赖 iframe sandbox 兜底）
function sendHtmlDoc(res, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', HTML_CSP);
  res.send(html);
}

// 向 HTML 文档注入 charset meta（若缺失）
function ensureCharset(html) {
  if (/<meta[^>]+charset=/i.test(html)) return html;
  const meta = '<meta charset="UTF-8">';
  if (/<head>/i.test(html)) return html.replace(/<head>/i, '<head>\n' + meta);
  if (/<html/i.test(html)) return html.replace(/<html[^>]*>/i, '$&\n<head>' + meta + '</head>');
  return meta + '\n' + html;
}

async function renderFile(res, file) {
  // Bundle 渲染
  if (file.is_bundle) {
    const bundleDir = path.join(UPLOAD_DIR, file.stored_name);
    const entryPath = path.join(bundleDir, file.entry_path || 'index.html');
    const resolved = path.resolve(entryPath);
    const resolvedDir = path.resolve(bundleDir) + path.sep;
    if (!resolved.startsWith(resolvedDir)) return res.status(403).json({ error: '非法路径' });
    try {
      let content = await fs.promises.readFile(entryPath, 'utf-8');
      const entryExt = path.extname(file.entry_path || 'index.html').toLowerCase();
      // <base> 指向 entry 所在目录（posix 路径），而非 bundle 根。
      // entry 在根时（如 index.html）目录为空，base 退化为 bundle 根，行为不变；
      // entry 在子目录时（如 deck/index.html）base 含 deck/，使 HTML 内相对资源路径正确解析。
      const entryDir = (file.entry_path || 'index.html').split('/').slice(0, -1).join('/');
      const entryDirPart = entryDir ? entryDir + '/' : '';
      const baseTag = '<base href="/api/files/' + file.id + '/asset/' + entryDirPart + '">';

      if (entryExt === '.md' || entryExt === '.markdown') {
        // Markdown 入口：marked 渲染 + 模板（命中缓存则跳过昂贵的渲染）
        const cached = getRenderedHtml(file);
        if (cached) return sendMarkdownHtml(res, cached);
        const mdHtml = marked.parse(content, { gfm: true, breaks: false, async: false })
          .replace(/<pre><code class="hljs language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
            (_, code) => `<pre class="mermaid">${code}</pre>`);
        const tplName = await getTemplateForFile(file);
        const tpl = templateCache[tplName] || templateCache['default'];
        const hljsTheme = BUILTIN_TEMPLATE_THEMES[tplName] || 'github';
        let fullHtml = applyTemplate(tpl, file.original_name, mdHtml, hljsTheme);
        if (/<head>/i.test(fullHtml)) {
          fullHtml = fullHtml.replace(/<head>/i, '<head>\n' + baseTag);
        }
        setRenderedHtml(file, fullHtml);
        return sendMarkdownHtml(res, fullHtml);
      }

      // HTML 入口：注入 <base> 和 charset，宽松 CSP
      if (/<head>/i.test(content)) {
        content = content.replace(/<head>/i, '<head>\n' + baseTag);
      } else if (/<html/i.test(content)) {
        content = content.replace(/<html[^>]*>/i, '$&\n<head>' + baseTag + '</head>');
      }
      return sendHtmlDoc(res, ensureCharset(content));
    } catch (e) {
      if (e && e.code === 'ENOENT') return res.status(404).json({ error: '入口文件已丢失' });
      return res.status(500).json({ error: '渲染失败' });
    }
  }

  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');

    if (file.file_type === 'markdown') {
      // 命中渲染缓存则直接返回（updated_at 失效，覆盖上传会刷新 key）
      const cached = getRenderedHtml(file);
      if (cached) return sendMarkdownHtml(res, cached);
      const html = marked.parse(content, { gfm: true, breaks: false, async: false })
        .replace(/<pre><code class="hljs language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
          (_, code) => `<pre class="mermaid">${code}</pre>`);
      const tplName = await getTemplateForFile(file);
      const tpl = templateCache[tplName] || templateCache['default'];
      const hljsTheme = BUILTIN_TEMPLATE_THEMES[tplName] || 'github';
      const fullHtml = applyTemplate(tpl, file.original_name, html, hljsTheme);
      setRenderedHtml(file, fullHtml);
      return sendMarkdownHtml(res, fullHtml);
    }

    return sendHtmlDoc(res, ensureCharset(content));
  } catch (e) {
    if (e && e.code === 'ENOENT') return res.status(404).json({ error: '文件已丢失' });
    res.status(500).json({ error: '渲染失败' });
  }
}

module.exports = {
  BUNDLE_LIST_MAX_DEPTH,
  BUNDLE_LIST_MAX_ENTRIES,
  listBundleEntries,
  renderFile,
};
