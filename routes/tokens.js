// API Token 管理路由：创建 / 列表 / 查看明文 / 删除。
// 鉴权用 SHA-256 哈希比对（lib/middleware/auth.js），与可逆加密存储（lib/crypto.js）相互独立：
//   - token_hash：不可逆哈希，用于 Bearer 鉴权。
//   - token_enc：AES-256-GCM 密文，使已登录用户可在 UI 上再次查看/复制明文。

const express = require('express');
const crypto = require('crypto');
const { dbGet, dbRun, dbAll } = require('../lib/db');
const { requireAuth } = require('../lib/middleware/auth');
const { clientIp } = require('../lib/util');
const { encryptToken, decryptToken } = require('../lib/crypto');
const logger = require('../logger');

const router = express.Router();

function generateApiToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(32);
  let token = 'jp_';
  for (let i = 0; i < 32; i++) {
    token += chars[bytes[i] % chars.length];
  }
  return token;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const tokens = await dbAll(
      'SELECT id, name, token_prefix, last_used_at, created_at, token_enc IS NOT NULL AS viewable FROM tokens WHERE user_id = ? ORDER BY created_at DESC',
      [req.userId]
    );
    res.json({ tokens });
  } catch (e) {
    res.status(500).json({ error: '获取令牌列表失败' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '令牌名称不能为空' });
  try {
    // 每用户最多 10 个 Token
    const count = await dbGet('SELECT COUNT(*) AS c FROM tokens WHERE user_id = ?', [req.userId]);
    if (count.c >= 10) return res.status(400).json({ error: '最多创建 10 个令牌' });

    const tokenValue = generateApiToken();
    const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');
    const tokenPrefix = tokenValue.slice(0, 8);
    const tokenEnc = encryptToken(tokenValue); // 可逆加密存储，用于后续查看明文

    const result = await dbRun(
      'INSERT INTO tokens (user_id, name, token_hash, token_prefix, token_enc) VALUES (?, ?, ?, ?, ?)',
      [req.userId, name.trim(), tokenHash, tokenPrefix, tokenEnc]
    );
    logger.audit('token.create', { tokenId: result.lastID, name: name.trim(), userId: req.userId, ip: clientIp(req) });
    res.json({
      id: result.lastID,
      name: name.trim(),
      token: tokenValue,
      token_prefix: tokenPrefix,
    });
  } catch (e) {
    res.status(500).json({ error: '创建令牌失败' });
  }
});

// 查看令牌明文：旧令牌（token_enc 为 NULL）不可查看，仅返回友好提示。
router.post('/:id/reveal', requireAuth, async (req, res) => {
  const tokenId = parseInt(req.params.id);
  if (isNaN(tokenId)) return res.status(400).json({ error: '无效令牌 ID' });
  try {
    const token = await dbGet('SELECT * FROM tokens WHERE id = ?', [tokenId]);
    if (!token) return res.status(404).json({ error: '令牌不存在' });
    if (token.user_id !== req.userId && req.userRole !== 'admin') {
      return res.status(403).json({ error: '无权查看此令牌' });
    }
    if (!token.token_enc) {
      return res.status(409).json({ error: '此令牌创建于功能启用前，无法查看明文，请删除后重建' });
    }
    try {
      const plain = decryptToken(token.token_enc);
      logger.audit('token.reveal', { tokenId, userId: req.userId, ip: clientIp(req) });
      res.json({ token: plain });
    } catch (e) {
      // 密钥变更或密文损坏，无法解密
      res.status(409).json({ error: '此令牌无法解密，请删除后重建' });
    }
  } catch (e) {
    res.status(500).json({ error: '查看令牌失败' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const tokenId = parseInt(req.params.id);
  if (isNaN(tokenId)) return res.status(400).json({ error: '无效令牌 ID' });
  try {
    const token = await dbGet('SELECT * FROM tokens WHERE id = ?', [tokenId]);
    if (!token) return res.status(404).json({ error: '令牌不存在' });
    if (token.user_id !== req.userId && req.userRole !== 'admin') {
      return res.status(403).json({ error: '无权删除此令牌' });
    }
    await dbRun('DELETE FROM tokens WHERE id = ?', [tokenId]);
    logger.audit('token.delete', { tokenId, userId: req.userId, ip: clientIp(req) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '删除令牌失败' });
  }
});

module.exports = router;
