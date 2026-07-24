// crypto.js — 悟空书签同步 AES-256-GCM 客户端加密
//
// 在书签数据上传到 WebDAV 之前进行端到端加密。
// 加密密码 != WebDAV 密码：即使 WebDAV 服务器被攻破，书签数据也无法解密。
//
// 加密流程：PBKDF2(密码, salt, 250000轮) → AES-256-GCM(明文, key, iv)
// 加密格式：WUKONG_ENC_V1:<base64(salt||iv||ciphertext)>
// 这样下载时可以快速判断是加密数据还是明文 XBEL。

// ── Web Crypto API 常量 ──
const ALGO = { name: 'AES-GCM', length: 256 };
const SALT_LEN = 16;   // bytes
const IV_LEN = 12;     // bytes — AES-GCM 推荐 96-bit
const PBKDF2_ITER = 250000; // 迭代次数（xBrowserSync 同级别）
const MAGIC = 'WUKONG_ENC_V1:';

// ── 工具函数 ──

/** Uint8Array → Base64（URL-safe，去 padding） */
function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Base64（URL-safe）→ Uint8Array */
function fromBase64(str) {
  return new Uint8Array(
    atob(str).split('').map(c => c.charCodeAt(0))
  );
}

/** 生成随机字节 */
function randomBytes(len) {
  return crypto.getRandomValues(new Uint8Array(len));
}

/** ArrayBuffer → Uint8Array */
function toBytes(buf) {
  return new Uint8Array(buf);
}

// ── 密钥派生 ──

/**
 * 从密码派生 AES-256 密钥
 * @param {string} password 加密密码
 * @param {Uint8Array} salt 盐值
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(password),
    { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    baseKey, ALGO, false, ['encrypt', 'decrypt']
  );
}

// ── 加密 / 解密 ──

/**
 * 加密明文 XBEL 字符串
 * @param {string} plaintext XBEL XML 字符串
 * @param {string} password 加密密码
 * @returns {Promise<string>} 格式：WUKONG_ENC_V1:<base64(salt||iv||ciphertext)>
 */
export async function encryptData(plaintext, password) {
  if (!password) throw new Error('加密密码不能为空');
  if (!plaintext) throw new Error('明文不能为空');

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveKey(password, salt);
  const enc = new TextEncoder();

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(plaintext)
  );

  // 拼接 salt(16) + iv(12) + ciphertext(N)
  const combined = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.byteLength);
  combined.set(salt, 0);
  combined.set(iv, SALT_LEN);
  combined.set(new Uint8Array(ciphertext), SALT_LEN + IV_LEN);

  return MAGIC + toBase64(combined);
}

/**
 * 解密密文为 XBEL 字符串
 * @param {string} encrypted 带 MAGIC 头的数据
 * @param {string} password 加密密码
 * @returns {Promise<string>} 解密后的 XBEL XML
 */
export async function decryptData(encrypted, password) {
  if (!password) throw new Error('解密密码不能为空');
  if (!encrypted || !encrypted.startsWith(MAGIC)) {
    throw new Error('数据格式错误：不是悟空加密数据（缺少 WUKONG_ENC_V1 头）');
  }

  const payload = fromBase64(encrypted.slice(MAGIC.length));

  if (payload.length < SALT_LEN + IV_LEN + 1) {
    throw new Error('加密数据不完整');
  }

  const salt = payload.slice(0, SALT_LEN);
  const iv = payload.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = payload.slice(SALT_LEN + IV_LEN);

  const key = await deriveKey(password, salt);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    if (e.name === 'OperationError') {
      throw new Error('解密失败：密码错误或数据已损坏');
    }
    throw e;
  }
}

/**
 * 判断一段数据是否为加密格式
 * @param {string} data 可能是加密数据或 XBEL XML
 * @returns {boolean}
 */
export function isEncrypted(data) {
  if (!data) return false;
  return data.startsWith(MAGIC);
}
