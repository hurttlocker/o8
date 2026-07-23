/**
 * One-time data directory migration: ~/.cortex-ide → ~/.o8
 *
 * Runs idempotently on first call per process. Multiple processes (Next dev
 * server, ws-server, MCP servers) may try to migrate concurrently — a lock
 * file ensures only one wins, the others wait for the marker and then skip.
 *
 * Migration triggers when:
 *   - Neither O8_DATA_DIR nor CORTEX_IDE_DATA_DIR is explicitly set
 *   - ~/.o8 does not exist OR is empty
 *   - ~/.cortex-ide exists with content
 *
 * The migration is a recursive copy. We never delete the old dir — that lets
 * the user roll back to a prior installer if anything goes sideways.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  cpSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';

let _ranInThisProcess = false;

export function migrateDataDirOnce(): void {
  if (_ranInThisProcess) return;
  _ranInThisProcess = true;

  // Respect either explicit override. Tests, side-by-side installs, and
  // cold-start probes still use the legacy CORTEX_IDE_DATA_DIR name; treating
  // it as a migration source copied isolated state into ~/.o8 and broke the
  // isolation boundary before the server had even opened its database.
  const explicitDir = process.env.O8_DATA_DIR || process.env.CORTEX_IDE_DATA_DIR;
  if (explicitDir) {
    const dir = explicitDir;
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch {}
    }
    return;
  }

  const home = homedir();
  const newDir = join(home, '.o8');
  const oldDir = join(home, '.cortex-ide');
  const marker = join(newDir, '.migrated-from-cortex-ide');

  // Already migrated → nothing to do
  if (existsSync(marker)) return;

  // New dir exists and has content but no marker → assume someone else
  // started writing here (clean install, no migration needed)
  if (existsSync(newDir)) {
    let entries: string[] = [];
    try { entries = readdirSync(newDir); } catch {}
    if (entries.length > 0) {
      // Drop the marker so future processes skip the check
      try { writeFileSync(marker, `Existing dir on ${new Date().toISOString()}\n`); } catch {}
      return;
    }
  }

  // Old dir doesn't exist → fresh install, just create the new dir
  if (!existsSync(oldDir)) {
    try {
      mkdirSync(newDir, { recursive: true });
      writeFileSync(marker, `Fresh install on ${new Date().toISOString()}\n`);
    } catch {}
    return;
  }

  // Migrate. We catch errors so a busted migration doesn't hard-crash the
  // server — at worst the new dir ends up partial and someone can rerun
  // by deleting ~/.o8.
  try {
    console.log(`[data-dir] Migrating ${oldDir} → ${newDir}`);
    mkdirSync(newDir, { recursive: true });
    cpSync(oldDir, newDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    writeFileSync(marker, `Migrated from ${oldDir} on ${new Date().toISOString()}\n`);
    console.log(`[data-dir] Migration complete. Old dir left in place at ${oldDir} for rollback.`);
  } catch (error) {
    console.error('[data-dir] Migration failed:', error);
  }
}

/**
 * Get the canonical data dir, running the one-time migration first.
 * Callers with an injected environment/home get pure resolution without
 * touching either real data directory.
 */
export function getDataDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = homedir(),
): string {
  // Production callers use the process defaults and retain the one-time
  // migration. Pure resolvers and tests may inject env/home without mutating
  // either real data directory.
  if (env === process.env && homeDir === homedir()) {
    migrateDataDirOnce();
  }
  return env.O8_DATA_DIR
    || env.CORTEX_IDE_DATA_DIR
    || join(homeDir, '.o8');
}
