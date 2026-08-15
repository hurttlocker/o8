import type Database from 'better-sqlite3';
import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentitySync,
  probeSystemBootTimeMsSync,
  sameMetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';

/**
 * Detach dead process ownership from unfinished reservations without deleting
 * the execution guard. Process death cannot prove whether an external side
 * effect landed before receipt finalization.
 */
export function quarantineDeadIdempotencyReservations(sqlite: Database.Database): void {
  try {
    const orphans = sqlite
      .prepare('SELECT key, pid, owner_identity_json, created_at FROM idempotency_keys WHERE result_json IS NULL AND pid IS NOT NULL')
      .all() as Array<{ key: string; pid: number; owner_identity_json: string | null; created_at: number }>;
    const bootTimeMs = probeSystemBootTimeMsSync();
    const dead = orphans.filter((row) => {
      const probe = probeMetadataLockProcessIdentitySync(row.pid);
      if (probe.state === 'absent') return true;
      if (probe.state !== 'live') return false;
      if (!row.owner_identity_json) {
        return bootTimeMs !== null && Number.isSafeInteger(row.created_at) && row.created_at < bootTimeMs;
      }
      try {
        const recorded = JSON.parse(row.owner_identity_json) as unknown;
        return isMetadataLockProcessIdentity(recorded)
          && !sameMetadataLockProcessIdentity(probe.identity, recorded);
      } catch {
        return false;
      }
    });
    if (dead.length === 0) return;
    const quarantine = sqlite.prepare(
      `UPDATE idempotency_keys SET pid = NULL, owner_identity_json = NULL
       WHERE key = ? AND result_json IS NULL AND pid = ? AND owner_identity_json IS ?`,
    );
    const tx = sqlite.transaction((rows: typeof dead) => {
      for (const row of rows) quarantine.run(row.key, row.pid, row.owner_identity_json);
    });
    tx(dead);
    console.log(`[db] Quarantined ${dead.length} unresolved idempotency reservation(s) from dead process(es)`);
  } catch (error) {
    console.warn('[db] idempotency reservation recovery failed:', error instanceof Error ? error.message : error);
  }
}
