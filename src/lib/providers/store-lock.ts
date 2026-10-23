import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Synchronous only: preparation, mutation and the actual spawn share this OS lock. */
export function withProviderStoreLock<T>(operation: () => T): T {
  mkdirSync(getDataDir(), { recursive: true, mode: 0o700 });
  const lock = new Database(join(getDataDir(), '.provider-keys.lock'), { timeout: 0 });
  try { lock.exec('BEGIN EXCLUSIVE'); return operation(); }
  finally { lock.close(); }
}
