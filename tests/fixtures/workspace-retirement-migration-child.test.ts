import { existsSync, writeFileSync } from 'node:fs';

import Database from 'better-sqlite3';

import { ensureV41WorkspaceRetirementSchema } from '@/lib/db/v41-workspace-retirement-migration';

const dbPath = process.env.O8_MIGRATION_DB_PATH;
const role = process.env.O8_MIGRATION_ROLE;
const lockMarker = process.env.O8_MIGRATION_LOCK_MARKER;
const attemptMarker = process.env.O8_MIGRATION_ATTEMPT_MARKER;
const releaseMarker = process.env.O8_MIGRATION_RELEASE_MARKER;
if (!dbPath || !role || !lockMarker || !attemptMarker || !releaseMarker) {
  throw new Error('workspace retirement migration child environment is incomplete');
}

function waitFor(pathname: string): void {
  const deadline = Date.now() + 10_000;
  while (!existsSync(pathname)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${pathname}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

const sqlite = new Database(dbPath);
sqlite.pragma('busy_timeout = 10000');
sqlite.pragma('foreign_keys = ON');
try {
  ensureV41WorkspaceRetirementSchema(sqlite, role === 'holder'
    ? {
        afterMigrationLock: () => {
          writeFileSync(lockMarker, 'locked\n');
          waitFor(releaseMarker);
        },
      }
    : {
        beforeMigrationLock: () => {
          writeFileSync(attemptMarker, 'attempting\n');
        },
      });
} finally {
  sqlite.close();
}
