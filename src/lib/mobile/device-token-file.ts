/**
 * Mobile E2EE — derived active-token-hash file (Orca teardown #5).
 *
 * The middleware (`src/middleware.ts`) validates per-device bearer tokens, but it
 * is bundled separately and must stay free of the better-sqlite3 native addon —
 * it already validates the shared ws-token by reading a FILE. So the device
 * registry derives this small file (newline-separated sha256 hashes of every
 * ACTIVE device token) on each enroll/revoke, and the middleware reads it
 * (mtime-cached, exactly like the ws-token loader). The DB stays canonical; this
 * is a read-optimized projection. No DB import lives in this module.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const DATA_DIR = getDataDir();
export const MOBILE_DEVICE_TOKENS_PATH = path.join(DATA_DIR, 'mobile-device-tokens');

/** Rewrite the active-token-hash file (called by the registry on enroll/revoke). */
export function writeActiveTokenHashes(hashes: string[]): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    // Trailing newline keeps the file POSIX-clean; empty set → empty file.
    const body = hashes.length ? `${hashes.join('\n')}\n` : '';
    writeFileSync(MOBILE_DEVICE_TOKENS_PATH, body, { mode: 0o600 });
  } catch (error) {
    console.warn(`[mobile-e2ee] failed to write device-token file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// mtime+size cached read, mirroring the middleware's ws-token loader.
let cache: { hashes: Set<string>; mtimeMs: number; size: number } | null = null;

/** Read the set of active device-token hashes (mtime-cached). Empty when none/absent. */
export function readActiveTokenHashes(): Set<string> {
  try {
    if (!existsSync(MOBILE_DEVICE_TOKENS_PATH)) {
      cache = null;
      return new Set();
    }
    const stat = statSync(MOBILE_DEVICE_TOKENS_PATH);
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.hashes;
    }
    const raw = readFileSync(MOBILE_DEVICE_TOKENS_PATH, 'utf-8');
    const hashes = new Set(raw.split('\n').map((l) => l.trim()).filter(Boolean));
    cache = { hashes, mtimeMs: stat.mtimeMs, size: stat.size };
    return hashes;
  } catch {
    return new Set();
  }
}
