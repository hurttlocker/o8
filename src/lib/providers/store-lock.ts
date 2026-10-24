import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

let heldDirectory: string | null = null;

/** Synchronous only: preparation, mutation and the actual spawn share this OS lock. */
export function withProviderStoreLock<T>(operation: () => T): T {
  const directory = getDataDir();
  if (heldDirectory === directory) return operation();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Concurrent launchers may finish their short validation-and-spawn transaction.
  const lock = new Database(join(directory, '.provider-keys.lock'), { timeout: 1000 });
  try { lock.exec('BEGIN EXCLUSIVE'); heldDirectory = directory; return operation(); }
  finally { heldDirectory = null; lock.close(); }
}
