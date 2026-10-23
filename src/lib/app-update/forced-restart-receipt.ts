import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { listWorkLaunches } from './work-launch-admission';

/** Persist the observed live/unknown work before acknowledging interruption consent. */
export function recordForcedRestart(source: string, work: unknown): string {
  const id = randomUUID();
  const directory = join(getDataDir(), 'forced-restarts');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let launches: unknown;
  try { launches = listWorkLaunches(); } catch { launches = { unavailable: true }; }
  const file = openSync(join(directory, `${id}.json`), 'wx', 0o600);
  try { writeFileSync(file, JSON.stringify({ id, source, at: new Date().toISOString(), work, launches })); fsyncSync(file); }
  finally { closeSync(file); }
  return id;
}
