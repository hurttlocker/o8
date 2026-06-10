/**
 * #747 — Per-runtime outcome telemetry columns on `session_outcomes`.
 *
 * Adds three nullable boolean columns (`skipped_tests`, `reworked`,
 * `merged_clean`) and backfills `merged_clean` from the existing
 * `review_approved` + `outcome` pair so the dispatch routing recommender
 * has signal on day one. Idempotent — re-running on a v12 DB is a no-op.
 *
 * Lives outside `db/index.ts` to keep that file under the 800-line ceiling.
 */
import type Database from 'better-sqlite3';

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

// Multiple processes run this at boot — tolerate losing the check-then-ALTER
// race (the column existing is the desired end state either way).
function addColumnTolerant(sqlite: Database.Database, sql: string): void {
  try {
    sqlite.exec(sql);
  } catch (err) {
    if (err instanceof Error && /duplicate column name/i.test(err.message)) return;
    throw err;
  }
}

export function ensureSessionOutcomeRoutingColumns(sqlite: Database.Database): void {
  if (!columnExists(sqlite, 'session_outcomes', 'skipped_tests')) {
    addColumnTolerant(sqlite, 'ALTER TABLE session_outcomes ADD COLUMN skipped_tests INTEGER');
  }
  if (!columnExists(sqlite, 'session_outcomes', 'reworked')) {
    addColumnTolerant(sqlite, 'ALTER TABLE session_outcomes ADD COLUMN reworked INTEGER');
  }
  if (!columnExists(sqlite, 'session_outcomes', 'merged_clean')) {
    addColumnTolerant(sqlite, 'ALTER TABLE session_outcomes ADD COLUMN merged_clean INTEGER');
    // Backfill: a prior outcome with `outcome='succeeded'` AND
    // `review_approved=1` is a clean merge. Failed outcomes mark
    // `merged_clean=0`. Everything else (NULL approved, partial, interrupted)
    // stays NULL — we don't want to assume the unknown rows.
    sqlite.exec("UPDATE session_outcomes SET merged_clean = 1 WHERE merged_clean IS NULL AND outcome = 'succeeded' AND review_approved = 1");
    sqlite.exec("UPDATE session_outcomes SET merged_clean = 0 WHERE merged_clean IS NULL AND outcome = 'failed'");
  }
}
