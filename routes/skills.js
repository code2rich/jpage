// Skills 与 MCP 配置路由。从 server.js 提取，行为保持不变。
// 挂载点：/api（内部路径 /skills、/skills/:name、/skills/:name/download、/mcp/config）

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

  res.json({
    enabled,
    globalToken,
    url,
    tokens,
    config: {
      mcpServers: {
        jpage: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${globalToken || '<YOUR_TOKEN>'}` }
        }
      }
    }
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
