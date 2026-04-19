/**
 * Master Key Resolver — AES-256-GCM master encryption key source.
 *
 * Resolution order (server-side Node.js process):
 *   1. O8_MASTER_KEY env var — CI / headless override, always wins.
 *   2. macOS Keychain via `security` CLI — creates a fresh 256-bit key on
 *      first call; subsequent calls retrieve the same key. Only on darwin.
 *   3. Static dev fallback — reproducible across restarts, used only when
 *      Keychain is unavailable (e.g. `npm run dev` on non-macOS or in CI).
 *
 * The Tauri commands `master_key_get` / `master_key_ensure` (src-tauri/src/lib.rs)
 * expose the same Keychain entry to the frontend via IPC for future use.
 *
 * The returned key is a URL-safe base64-encoded 256-bit value (no padding).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ── Constants ──

/** Fallback env var for non-Tauri / dev environments. */
const ENV_MASTER_KEY = 'O8_MASTER_KEY';

/** Keychain service + account — must match src-tauri/src/lib.rs constants. */
const KEYCHAIN_SERVICE = 'ai.o8.master-key';
const KEYCHAIN_ACCOUNT = 'default';

/**
 * Dev-only static key. Reproducible across restarts when Keychain is absent
 * (e.g. `npm run dev`). NEVER used when a real Keychain entry exists.
 * 32 bytes = 256 bits, URL-safe base64.
 */
const DEV_STATIC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// ── Master key resolution ──

let _cachedKey: string | null = null;

/**
 * Read the master key directly from the macOS Keychain using the `security`
 * CLI. This is the server-side path — no Tauri IPC needed because the Next.js
 * server process runs on the same macOS machine.
 *
 * Returns null if the entry does not exist, is inaccessible, or this is not macOS.
 */
function readKeychainKey(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const { execSync: exec } = require('node:child_process') as typeof import('node:child_process');
    const out = exec(
      `security find-generic-password -s '${KEYCHAIN_SERVICE}' -a '${KEYCHAIN_ACCOUNT}' -w`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return out.length >= 40 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Write (or update) the master key in the macOS Keychain.
 * Returns true on success.
 */
function writeKeychainKey(key: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const { execSync: exec } = require('node:child_process') as typeof import('node:child_process');
    exec(
      `security add-generic-password -s '${KEYCHAIN_SERVICE}' -a '${KEYCHAIN_ACCOUNT}' -w '${key}' -U`,
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a cryptographically random 256-bit key as URL-safe base64 (no padding).
 */
function generateKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Resolve the AES-256-GCM master encryption key.
 *
 * Resolution order:
 *   1. O8_MASTER_KEY env var  (CI / headless override, always wins).
 *   2. macOS Keychain via `security` CLI (creates entry on first call).
 *   3. Static dev fallback (reproducible across restarts, no Keychain needed).
 *
 * The result is cached in-process so Keychain is queried at most once.
 */
export async function resolveMasterKey(): Promise<string> {
  if (_cachedKey) return _cachedKey;

  // 1. Env-var override.
  const envKey = process.env[ENV_MASTER_KEY];
  if (envKey && envKey.length >= 40) {
    _cachedKey = envKey;
    return _cachedKey;
  }

  // 2. macOS Keychain (server-side direct CLI call).
  if (process.platform === 'darwin') {
    let keychainKey = readKeychainKey();
    if (!keychainKey) {
      // First run — generate and persist.
      const newKey = generateKey();
      if (writeKeychainKey(newKey)) {
        keychainKey = newKey;
        console.log('[master-key] Generated and stored new key in macOS Keychain');
      } else {
        console.warn('[master-key] Failed to write key to Keychain, using dev fallback');
      }
    } else {
      console.log('[master-key] Resolved from macOS Keychain');
    }
    if (keychainKey) {
      _cachedKey = keychainKey;
      return _cachedKey;
    }
  }

  // 3. Static dev fallback.
  console.warn('[master-key] Using static dev fallback key — Keychain unavailable');
  _cachedKey = DEV_STATIC_KEY;
  return _cachedKey;
}

/**
 * Bust the in-process key cache.  Useful in tests or after a key rotation.
 */
export function clearMasterKeyCache(): void {
  _cachedKey = null;
}

// ── AES-256-GCM helpers ──

const CIPHER_ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16;

/** Decode a URL-safe base64 string (no padding) to a Buffer. */
function decodeBase64Url(s: string): Buffer {
  // Restore standard base64 padding and replace URL-safe chars.
  const standard = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 *
 * @returns `{ ciphertext, iv }` — both are hex strings suitable for storage.
 */
export async function encryptValue(plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const keyBuf = decodeBase64Url(await resolveMasterKey());
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(CIPHER_ALGORITHM, keyBuf, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Append auth tag to ciphertext so it's stored together.
  const payload = Buffer.concat([encrypted, authTag]);
  return {
    ciphertext: payload.toString('hex'),
    iv: iv.toString('hex'),
  };
}

/**
 * Decrypt a value previously produced by `encryptValue`.
 *
 * @returns the plaintext, or `null` if decryption fails.
 */
export async function decryptValue(ciphertext: string, iv: string): Promise<string | null> {
  try {
    const keyBuf = decodeBase64Url(await resolveMasterKey());
    const ivBuf = Buffer.from(iv, 'hex');
    const payload = Buffer.from(ciphertext, 'hex');
    // Last AUTH_TAG_LENGTH bytes are the auth tag.
    const encryptedBuf = payload.slice(0, payload.length - AUTH_TAG_LENGTH);
    const authTag = payload.slice(payload.length - AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(CIPHER_ALGORITHM, keyBuf, ivBuf, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}
