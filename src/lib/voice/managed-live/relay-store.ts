import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export interface VoiceRelayRecord {
  version: 1 | 2;
  id: string;
  owner: string;
  binding: string;
  gateway: string;
  createdAt: number;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
export class VoiceRelayPersistenceError extends Error {
  constructor(readonly published: boolean) { super('Voice relay ownership could not be confirmed durable'); }
}

/** Only server configuration supplies this URL. Credentials never follow redirects. */
export function voiceGatewayUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) throw new Error('Invalid voice gateway');
  return url.href.replace(/\/+$/, '');
}
function directory(): string {
  const root = join(getDataDir(), 'managed-voice-relay');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
    throw new Error('Unsafe voice relay directory');
  }
  return root;
}
function validate(value: unknown): VoiceRelayRecord {
  const record = value as VoiceRelayRecord;
  if (!record || ![1, 2].includes(record.version) || !UUID.test(record.id) || !HASH.test(record.owner)
    || !HASH.test(record.binding) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
    || typeof record.gateway !== 'string' || voiceGatewayUrl(record.gateway) !== record.gateway) {
    throw new Error('Invalid voice relay ownership');
  }
  return record;
}
export function loadVoiceRelay(id: string): VoiceRelayRecord | null {
  if (!UUID.test(id)) return null;
  let fd: number;
  try { fd = openSync(join(directory(), `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077))) {
      throw new Error('Unsafe voice relay ownership');
    }
    const record = validate(JSON.parse(readFileSync(fd, 'utf8')));
    if (record.id !== id) throw new Error('Voice relay identity mismatch');
    return record;
  } finally { closeSync(fd); }
}

/** Immutable, no-clobber publication. Unknown/terminal records are retained for recovery. */
export function saveVoiceRelay(record: VoiceRelayRecord): void {
  validate(record);
  const root = directory();
  const temporary = join(root, `${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  let published = false;
  try {
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    // A duplicate provider id is ambiguous even when its fields happen to match.
    // Never overwrite it or close a potentially unrelated provider session.
    linkSync(temporary, join(root, `${record.id}.json`));
    published = true;
    if (process.platform !== 'win32') {
      const dirFd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } catch { throw new VoiceRelayPersistenceError(published); }
  finally { try { unlinkSync(temporary); } catch { /* An orphaned private temp file grants no ownership. */ } }
}
