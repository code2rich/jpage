// Skills、MCP 配置、CLI 指南路由。从 server.js 提取，行为保持不变。
// 挂载点：/api（内部路径 /skills、/skills/:name、/skills/:name/download、/mcp/config、/cli/guide）
// 设计：CLI 与 MCP 是并列的两个客户端入口（REST / MCP），各有独立端点与 UI 入口，不互相嵌套。

const express = require('express');
const { dbAll } = require('../lib/db');
const { requireAuth } = require('../lib/middleware/auth');
const { marked } = require('../lib/templates');
const { listSkills, getSkill, createZipStream } = require('../skills-registry');
const logger = require('../logger');

const router = express.Router();

router.get('/skills', requireAuth, async (req, res) => {
  try {
    res.json({ skills: listSkills() });
  } catch (e) {
    logger.error({ type: 'app', message: '列出 skills 失败', error: e.message });
    res.status(500).json({ error: '列出 skills 失败' });
  }
});

router.get('/skills/:name', requireAuth, async (req, res) => {
  const skill = getSkill(req.params.name);
  if (!skill) return res.status(404).json({ error: 'Skill 不存在' });
  if (skill.installBody) {
    skill.installHtml = marked.parse(skill.installBody, { gfm: true, breaks: false, async: false });
  }
  res.json(skill);
});

// 生成标准 mcpServers 配置块（所有客户端共用同一格式，仅目标文件/说明不同）
function buildServerConfig(url, token) {
  return {
    mcpServers: {
      jpage: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token || '<YOUR_TOKEN>'}` }
      }
    }
  };
}

// 生成 CLI 用法文档 Markdown。
// baseUrl 预填进示例，方便用户复制即用；真实 token 用 <YOUR_TOKEN> 占位，不在弹窗中泄露。
function buildCliGuide(baseUrl) {
  return `# jpage CLI

\`jpage\` 是即页的命令行工具，与 MCP 并列、基于同一套 REST API。适合 Bash/脚本/CI/Agent 场景，multipart 上传大文件更省流。

## 安装

\`\`\`bash
npm install -g @code2rich/jpage
\`\`\`

## 认证

在「API 令牌」页创建 token 后，任选一种方式注入：

\`\`\`bash
export JPAGE_TOKEN=<YOUR_TOKEN>   # 推荐
jpage <命令> --token <YOUR_TOKEN> # 单条命令
\`\`\`

token 优先级：\`--token\` > \`JPAGE_TOKEN\` > \`MCP_TOKEN\`。  
服务地址优先级：\`--base\` > \`JPAGE_BASE\` > 默认 \`https://jpage.cn\`。  
以下示例默认使用 \`${baseUrl}\`。

## 命令速查

| 命令 | 说明 |
|---|---|
| \`upload <路径> [--public] [--overwrite ID]\` | 上传文件或 ZIP |
| \`ls [--page --limit --kw --cat --tag]\` | 列出文件 |
| \`cat <id>\` | 查看文件内容 |
| \`url <id>\` | 打印 /s/:key 短链接 |
| \`mv <id> <新名> [--public|--private]\` | 重命名 / 改公开性 |
| \`rm <id> [--yes]\` | 删除 |
| \`star <id>\` / \`unstar <id>\` | 收藏 / 取消收藏 |
| \`tags <id> [add|set|clear] [名,名,...]\` | 标签管理 |
| \`skills ls | get <名> | download <名>\` | Skill 包 |
| \`whoami\` | 校验 token |
| \`update [--check] [--registry <url>]\` | 自更新（**不需 token**） |

## 常用示例

\`\`\`bash
jpage upload ./report.html --public --base ${baseUrl}
jpage ls --kw 季度
jpage cat 8
jpage tags 8 add Q3,财报
jpage url 8
jpage update
\`\`\`

完整说明请运行 \`jpage --help\`。
`;
}

router.get('/mcp/config', requireAuth, async (req, res) => {
  const enabled = !!process.env.MCP_TOKEN || true; // 现在总是可以用用户级 Token
  const host = req.headers.host || `localhost:${process.env.PORT || 8858}`;
  const protocol = req.protocol || 'http';
  const url = `${protocol}://${host}/mcp`;

  // 获取当前用户的 Token 列表
  const tokens = await dbAll(
    'SELECT id, name, token_prefix, created_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC',
    [req.userId]
  );

  const globalToken = process.env.MCP_TOKEN && req.userRole === 'admin' ? process.env.MCP_TOKEN : null;

  // 所有 MCP 客户端共用同一配置对象；差异仅在目标文件路径/说明文字。
  // CLI 不属于 MCP 客户端（它是 REST 命令行入口），走独立的 /api/cli/guide 端点，不混在此处。
  const config = buildServerConfig(url, globalToken);
  const configs = [
    { id: 'claude-code',    label: 'Claude Code',    path: '.mcp.json（项目根）或 ~/.claude.json', config },
    { id: 'claude-desktop', label: 'Claude Desktop', path: 'claude_desktop_config.json',           config },
    { id: 'cursor',         label: 'Cursor',         path: '~/.cursor/mcp.json',                   config },
    { id: 'zcode',          label: 'ZCode',          path: 'ZCode 设置 → MCP 服务器',              config },
    { id: 'generic',        label: '通用/标准 JSON', path: '任意支持 mcpServers 的客户端',         config }
  ];

  res.json({
    enabled,
    globalToken,
    url,
    tokens,
    config,
    configs
  });
});

// CLI 用法指南。CLI 与 MCP 是并列的两个客户端入口（都架在同一套 REST API 上），
// 故独立成端点，供「CLI 工具」菜单/弹窗取用，不挂在 MCP 配置之下。
router.get('/cli/guide', requireAuth, (req, res) => {
  const host = req.headers.host || `localhost:${process.env.PORT || 8858}`;
  const protocol = req.protocol || 'http';
  const baseUrl = `${protocol}://${host}`;
  const guideText = buildCliGuide(baseUrl);
  res.json({
    enabled: true,
    baseUrl,
    guideText,
    guideHtml: marked.parse(guideText, { gfm: true, breaks: false, async: false })
  });
});

router.get('/skills/:name/download', requireAuth, (req, res) => {
  const archive = createZipStream(req.params.name);
  if (!archive) return res.status(404).json({ error: 'Skill 不存在' });
  const fname = `${req.params.name}.zip`;
  const encoded = encodeURIComponent(fname);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  archive.on('end', () => res.end());
  archive.pipe(res);
  archive.finalize().catch(e => {
    logger.error({ type: 'app', message: 'archiver finalize 失败', error: e.message });
    if (!res.headersSent) res.status(500).json({ error: '打包失败' });
  });
});

module.exports = router;
