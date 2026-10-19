import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Explicit, expiring personal experiment. Never changes the funded gateway's admission policy. */
export function personalVoiceGateway(): string | null {
  if (process.env.NODE_ENV !== 'development') return null;
  let fd: number;
  try { fd = openSync(join(getDataDir(), 'managed-voice-personal.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Personal voice configuration unavailable');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Unsafe personal voice configuration');
    const value = JSON.parse(readFileSync(fd, 'utf8')) as { version?: number; expiresAt?: number; gateway?: string };
    if (value.version !== 1 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt! <= Date.now()
      || value.expiresAt! > Date.now() + 24 * 60 * 60_000 || typeof value.gateway !== 'string') throw new Error('Personal voice test expired');
    const url = new URL(value.gateway);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Personal voice relay must be loopback');
    return url.origin;
  } finally { closeSync(fd); }
}
