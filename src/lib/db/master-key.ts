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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

// ── Constants ──

/** Fallback env var for non-Tauri / dev environments. */
const ENV_MASTER_KEY = 'O8_MASTER_KEY';

/** Keychain service + account — must match src-tauri/src/lib.rs constants. */
const KEYCHAIN_SERVICE = 'ai.o8.master-key';
const KEYCHAIN_ACCOUNT = 'default';

function dataDir(): string {
  return getDataDir();
}

/**
 * Read (or first-run create) a persisted random master key file at
 * ~/.o8/master-key, mode 0600. This replaces the former hardcoded all-zeros
 * "dev static key", which made AES-256-GCM encryption-at-rest worthless on any
 * platform without the macOS Keychain (SECURITY_AUDIT_2026-07-02 §MED-1). The
 * key is reproducible across restarts (persisted) but secret (random + 0600).
 */
function readOrCreateKeyFile(): string {
  const keyPath = join(dataDir(), 'master-key');
  try {
    if (existsSync(keyPath)) {
      const existing = readFileSync(keyPath, 'utf-8').trim();
      if (existing.length >= 40) return existing;
    }
  } catch {
    // Unreadable — fall through to (re)create.
  }
  const key = generateKey();
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(keyPath, key, { encoding: 'utf-8', mode: 0o600 });
  return key;
}

// ── Master key resolution ──

let _cachedKey: string | null = null;

type KeychainRead =
  | { status: 'found'; key: string }
  | { status: 'absent' }
  | { status: 'error'; detail: string };

/**
 * Read the master key directly from the macOS Keychain using the `security`
 * CLI. This is the server-side path — no Tauri IPC needed because the Next.js
 * server process runs on the same macOS machine.
 *
 * Distinguishes "entry genuinely absent" (exit 44, errSecItemNotFound — safe
 * to create a fresh key) from "read FAILED" (locked Keychain, denied ACL —
 * the entry may exist, and generating a replacement would orphan every blob
 * encrypted under it).
 */
function readKeychainKey(): KeychainRead {
  if (process.platform !== 'darwin') return { status: 'absent' };
  try {
    const { execSync: exec } = require('node:child_process') as typeof import('node:child_process');
    const out = exec(
      `security find-generic-password -s '${KEYCHAIN_SERVICE}' -a '${KEYCHAIN_ACCOUNT}' -w`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    // An existing-but-too-short entry is invalid (key is >=40 chars) — treat
    // as absent so a valid key replaces it.
    return out.length >= 40 ? { status: 'found', key: out } : { status: 'absent' };
  } catch (err) {
    const exitStatus = (err as { status?: number | null }).status;
    if (exitStatus === 44) return { status: 'absent' }; // errSecItemNotFound
    return {
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
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
    const read = readKeychainKey();

    if (read.status === 'error') {
      // The entry may EXIST but be unreadable right now (locked Keychain,
      // ACL change after an OS update). Anything we'd do silently here is
      // wrong: generating a fresh key with `add-generic-password -U` would
      // OVERWRITE the real entry and orphan every previously-encrypted blob;
      // falling to the dev key would re-encrypt new secrets under a
      // non-secret value. Fail loudly — feature unavailable beats silent
      // data loss. Not cached, so a later call retries.
      console.error(`[master-key] Keychain read FAILED (not "absent"): ${read.detail}`);
      throw new Error(
        `Keychain read failed — refusing to rotate or downgrade the master key. Unlock the login Keychain and retry. (${read.detail})`,
      );
    }

    let keychainKey = read.status === 'found' ? read.key : null;
    if (!keychainKey) {
      // Genuinely absent (first run) — generate and persist.
      const newKey = generateKey();
      if (writeKeychainKey(newKey)) {
        keychainKey = newKey;
        console.log('[master-key] Generated and stored new key in macOS Keychain');
      } else {
        console.warn('[master-key] Failed to write key to Keychain, using persisted key file');
      }
    } else {
      console.log('[master-key] Resolved from macOS Keychain');
    }
    if (keychainKey) {
      _cachedKey = keychainKey;
      return _cachedKey;
    }
  }

  // 3. Persisted random key file (0600) — non-macOS, or if the Keychain is
  //    unavailable. NEVER a hardcoded constant (§MED-1).
  _cachedKey = readOrCreateKeyFile();
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
