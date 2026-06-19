// 模板系统 + Markdown 渲染管线（marked + highlight.js + KaTeX）。
// 从 server.js 提取，行为保持不变。

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { markedHighlight } = require('marked-highlight');
const hljs = require('highlight.js');
const katex = require('katex');
const logger = require('../logger');
const { dbAll, dbGet } = require('./db');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const templateCache = {};

const TEMPLATE_PLACEHOLDERS = {
  katex_css_url: '/vendor/katex/katex.min.css',
  hljs_css_url: '/vendor/highlight.js/styles',
  mermaid_js_url: '/vendor/mermaid/mermaid.min.js',
  hljs_js_url: '/vendor/highlight.js/highlight.min.js',
  katex_js_url: '/vendor/katex/katex.min.js',
  marked_js_url: '/vendor/marked/marked.min.js',
};

function loadTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return;
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.html'));
  for (const f of files) {
    const name = path.basename(f, '.html');
    const raw = fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf-8');
    templateCache[name] = compileTemplate(raw);
  }
  logger.info({ type: 'app', msg: 'templates loaded', count: Object.keys(templateCache).length });
}

// 预编译模板：静态占位符（vendor URL）在加载时一次替换；运行时只剩 title/content/hljs_theme 三个动态替换，
// 避免每次渲染都跑 ~8 次正则（含 new RegExp 构造）。返回函数 (title, content, hljsTheme) => html。
function compileTemplate(raw) {
  let src = raw;
  for (const [key, value] of Object.entries(TEMPLATE_PLACEHOLDERS)) {
    src = src.split('{{' + key + '}}').join(value);
  }
  return function applyCompiled(title, content, hljsTheme) {
    return src
      .split('{{title}}').join(title)
      .split('{{content}}').join(content)
      .split('{{hljs_theme}}').join(hljsTheme || 'github');
  };
}

function applyTemplate(tplFn, title, content, hljsTheme) {
  return tplFn(title, content, hljsTheme);
}

const BUILTIN_TEMPLATE_THEMES = {
  default: 'github',
  github: 'github',
  academic: 'github',
  'dark-pro': 'github-dark-dimmed',
};

let templateNameToId = {};

async function loadTemplateNameMap() {
  const rows = await dbAll('SELECT id, name FROM templates');
  templateNameToId = {};
  for (const r of rows) templateNameToId[r.name] = r.id;
}

async function getTemplateForFile(file) {
  const tplId = file.template_id;
  if (tplId) {
    const row = await dbGet('SELECT name FROM templates WHERE id = ?', [tplId]);
    if (row && templateCache[row.name]) return row.name;
  }
  return 'default';
}

function renderKatex(tex, displayMode) {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: 'html',
      strict: false
    });
  } catch (e) {
    return `<code class="katex-error">${tex}</code>`;
  }
}

// --- marked 渲染管线配置（highlight.js + KaTeX 扩展）---
marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  }
}));

marked.use({
  extensions: [
    {
      name: 'katexInline',
      level: 'inline',
      start(src) { return src.indexOf('$'); },
      tokenizer(src) {
        const match = /^\$([^\$\n]+?)\$/.exec(src);
        if (!match) return;
        return {
          type: 'katexInline',
          raw: match[0],
          text: match[1]
        };
      },
      renderer(token) {
        return renderKatex(token.text, false);
      }
    },
    {
      name: 'katexBlock',
      level: 'block',
      start(src) { return src.indexOf('$$'); },
      tokenizer(src) {
        const match = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);
        if (!match) return;
        return {
          type: 'katexBlock',
          raw: match[0],
          text: match[1]
        };
      },
      renderer(token) {
        return `<div class="katex-display">${renderKatex(token.text, true)}</div>\n`;
      }
    }
  ]
});

module.exports = {
  templateCache,
  BUILTIN_TEMPLATE_THEMES,
  loadTemplates,
  applyTemplate,
  loadTemplateNameMap,
  getTemplateForFile,
  renderKatex,
  marked,
};
