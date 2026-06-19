// Token 明文可逆加密：AES-256-GCM。
//
// 用途：API Token 创建时除存 SHA-256 哈希（用于鉴权比对，不可逆）外，
// 另存一份 AES-256-GCM 密文，使 token 明文可在用户登录后再次查看/复制。
// 鉴权链路（lib/middleware/auth.js）完全不依赖本模块，仍走哈希比对。
//
// 密钥来源（优先级）：
//   1. 环境变量 TOKEN_ENCRYPTION_KEY（hex；若长度不足 32 字节则用 sha256 派生到 32 字节）
//   2. 数据目录下的 token-key.key 文件（hex 文本，重启不变）
//   3. 上述文件不存在 → 生成 32 随机字节写入该文件后再读取
// 不设置环境变量时也能开箱即用，不破坏现有部署。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const KEY_FILE = path.join(DATA_DIR, 'token-key.key');
const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM 推荐 96-bit IV

// 解析为 32 字节密钥：合法 hex(64) 直接用，否则 sha256 派生。
function deriveKey(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  return crypto.createHash('sha256').update(trimmed).digest();
}

// 读取或生成持久化密钥文件（hex 文本）。
function loadKeyFile() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
    }
  } catch (_) { /* 读取失败则走生成路径 */ }

  // 生成并写入（0600，仅属主可读写）
  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  } catch (_) { /* 写入失败时退回内存密钥（重启后旧密文不可解密） */ }
  return key;
}

let _key = process.env.TOKEN_ENCRYPTION_KEY ? deriveKey(process.env.TOKEN_ENCRYPTION_KEY) : loadKeyFile();

// 供测试重置密钥（按环境变量/文件重新解析）。
function reloadKey() {
  _key = process.env.TOKEN_ENCRYPTION_KEY ? deriveKey(process.env.TOKEN_ENCRYPTION_KEY) : loadKeyFile();
  return _key;
}

// 密文格式：base64(iv) : base64(ciphertext) : base64(authTag)
function encryptToken(plain) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, _key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), enc.toString('base64'), tag.toString('base64')].join(':');
}

// 解密失败抛错（由调用方捕获并转友好提示）。
function decryptToken(encStr) {
  const parts = String(encStr || '').split(':');
  if (parts.length !== 3) throw new Error('invalid ciphertext format');
  const [ivB, dataB, tagB] = parts;
  const iv = Buffer.from(ivB, 'base64');
  const data = Buffer.from(dataB, 'base64');
  const tag = Buffer.from(tagB, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, _key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

module.exports = {
  encryptToken,
  decryptToken,
  reloadKey,
};
