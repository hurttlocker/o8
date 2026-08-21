/**
 * DB-free projection of active Broadcast credential hashes.
 *
 * Middleware cannot load the SQLite native addon, so token mutations rewrite
 * this owner-only file beside the canonical DB row. Mutation ordering is
 * fail-closed: mint commits before projection; revoke removes projection before
 * commit. Reads intentionally avoid an mtime cache: revocation must take effect
 * on the very next request even on filesystems with coarse timestamp resolution.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function spectatorTokenHashesPath(): string {
  return path.join(getDataDir(), 'broadcast-spectator-tokens');
}

export function writeActiveSpectatorTokenHashes(hashes: string[]): void {
  const dataDir = getDataDir();
  const target = spectatorTokenHashesPath();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const normalized = [...new Set(hashes.map((hash) => hash.trim()).filter((hash) => HASH_PATTERN.test(hash)))]
    .sort();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  writeFileSync(temporary, normalized.length ? `${normalized.join('\n')}\n` : '', {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temporary, target);
}

export function readActiveSpectatorTokenHashes(): Set<string> {
  try {
    const target = spectatorTokenHashesPath();
    if (!existsSync(target)) return new Set();
    return new Set(
      readFileSync(target, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => HASH_PATTERN.test(line)),
    );
  } catch {
    return new Set();
  }
}
