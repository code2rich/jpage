// lib/crypto.js 单元测试：AES-256-GCM 加解密往返、密钥持久化、密钥变更后解密失败。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 用临时数据目录隔离密钥文件
const TMP_DATA = path.join(__dirname, '..', `data-crypto-${process.pid}-${Date.now()}`);

function freshCrypto() {
  // 清除缓存，让 lib/crypto.js 重新读取 JPAGE_DATA_DIR / 环境变量
  delete require.cache[require.resolve('../../lib/paths')];
  delete require.cache[require.resolve('../../lib/crypto')];
  return require('../../lib/crypto');
}

test.beforeEach(() => {
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
  fs.mkdirSync(TMP_DATA, { recursive: true });
  delete process.env.TOKEN_ENCRYPTION_KEY;
  process.env.JPAGE_DATA_DIR = TMP_DATA;
});

test.afterEach(() => {
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

test('加密后解密能还原原文', () => {
  const { encryptToken, decryptToken } = freshCrypto();
  const plain = 'jp_abcdefghijklmnopqrstuvwxyz123456';
  const enc = encryptToken(plain);
  assert.notStrictEqual(enc, plain, '密文不应等于明文');
  assert.strictEqual(decryptToken(enc), plain);
});

test('同一明文每次加密结果不同（随机 IV）', () => {
  const { encryptToken } = freshCrypto();
  const plain = 'jp_sametokenvalue';
  const a = encryptToken(plain);
  const b = encryptToken(plain);
  assert.notStrictEqual(a, b, '不同次加密应产生不同密文');
});

test('密文格式为 iv : ciphertext : authTag 三段 base64', () => {
  const { encryptToken } = freshCrypto();
  const enc = encryptToken('jp_test');
  const parts = enc.split(':');
  assert.strictEqual(parts.length, 3);
  // 每段都是合法 base64
  parts.forEach(p => assert.ok(Buffer.from(p, 'base64').length > 0));
});

test('密钥文件自动生成在数据目录并持久化', () => {
  const { encryptToken } = freshCrypto();
  const enc = encryptToken('jp_persist');
  const keyFile = path.join(TMP_DATA, 'token-key.key');
  assert.ok(fs.existsSync(keyFile), '应生成 token-key.key 文件');
  const hex = fs.readFileSync(keyFile, 'utf8').trim();
  assert.match(hex, /^[0-9a-fA-F]{64}$/, '密钥文件为 32 字节 hex');

  // 再次 require（重新读文件）应能解密旧密文
  const { decryptToken: decryptAgain } = freshCrypto();
  assert.strictEqual(decryptAgain(enc), 'jp_persist');
});

test('密文被篡改 → 解密抛错（GCM 完整性校验）', () => {
  const { encryptToken, decryptToken } = freshCrypto();
  const enc = encryptToken('jp_tamper');
  const parts = enc.split(':');
  // 篡改 ciphertext 段的第一个字符
  const tamperedData = Buffer.from(parts[1], 'base64');
  tamperedData[0] ^= 0xff;
  const tampered = [parts[0], tamperedData.toString('base64'), parts[2]].join(':');
  assert.throws(() => decryptToken(tampered), /unsupported|auth|decrypt|final/i);
});

test('格式错误的密文 → 解密抛错', () => {
  const { decryptToken } = freshCrypto();
  assert.throws(() => decryptToken('not-a-valid-ciphertext'));
  assert.throws(() => decryptToken('a:b'));
});

test('环境变量 TOKEN_ENCRYPTION_KEY 优先于密钥文件（合法 hex）', () => {
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  const { encryptToken, decryptToken } = freshCrypto();
  const enc = encryptToken('jp_env_key');
  assert.strictEqual(decryptToken(enc), 'jp_env_key');
  assert.ok(!fs.existsSync(path.join(TMP_DATA, 'token-key.key')), '用环境变量时不应生成密钥文件');
});

test('reloadKey() 切换密钥后旧密文无法解密', () => {
  const mod = freshCrypto();
  const enc = mod.encryptToken('jp_rotate');
  // 换一个新环境变量密钥并 reload
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  mod.reloadKey();
  assert.throws(() => mod.decryptToken(enc), '换密钥后旧密文应无法解密');
});
