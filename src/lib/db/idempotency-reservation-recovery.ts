import type Database from 'better-sqlite3';

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Detach dead process ownership from unfinished reservations without deleting
 * the execution guard. Process death cannot prove whether an external side
 * effect landed before receipt finalization.
 */
export function quarantineDeadIdempotencyReservations(sqlite: Database.Database): void {
  try {
    const orphans = sqlite
      .prepare('SELECT key, pid FROM idempotency_keys WHERE result_json IS NULL AND pid IS NOT NULL')
      .all() as Array<{ key: string; pid: number }>;
    const dead = orphans.filter((row) => !isPidAlive(row.pid));
    if (dead.length === 0) return;
    const quarantine = sqlite.prepare(
      'UPDATE idempotency_keys SET pid = NULL WHERE key = ? AND result_json IS NULL AND pid = ?',
    );
    const tx = sqlite.transaction((rows: Array<{ key: string; pid: number }>) => {
      for (const row of rows) quarantine.run(row.key, row.pid);
    });
    tx(dead);
    console.log(`[db] Quarantined ${dead.length} unresolved idempotency reservation(s) from dead process(es)`);
  } catch (error) {
    console.warn('[db] idempotency reservation recovery failed:', error instanceof Error ? error.message : error);
  }
}
