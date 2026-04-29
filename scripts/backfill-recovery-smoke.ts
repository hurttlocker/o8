/**
 * Verifies that the always-run `backfillSessionOutcomeValidFrom()` recovers
 * NULL valid_from rows on the next boot — simulating the 3 stuck prod rows
 * (test-prop-001/002/003) in the user's actual ~/.o8/cortex-ide.db.
 *
 * Run with:
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) npx tsx scripts/backfill-recovery-smoke.ts
 */

import { closeDb, getDb, getSqlite } from '@/lib/db';

async function main() {
  const db = getDb();
  if (!db) throw new Error('DB unavailable');
  const sqlite = getSqlite();

  // Wipe + recreate without NOT NULL constraint to seed legacy NULL rows.
  sqlite.exec('DELETE FROM session_outcomes');
  sqlite.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE session_outcomes_temp (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      repo_path TEXT NOT NULL,
      runtime TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      branch TEXT,
      pr_number INTEGER,
      issue_number INTEGER,
      directives_used_json TEXT NOT NULL DEFAULT '[]',
      duration_ms INTEGER,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      model TEXT,
      patterns_json TEXT NOT NULL DEFAULT '[]',
      conflict_zones_json TEXT NOT NULL DEFAULT '[]',
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      review_approved INTEGER,
      review_findings_count INTEGER NOT NULL DEFAULT 0,
      transcript_path TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      valid_from TEXT,
      valid_to TEXT,
      skipped_tests INTEGER, reworked INTEGER, merged_clean INTEGER, plan_text TEXT
    );
    DROP TABLE session_outcomes;
    ALTER TABLE session_outcomes_temp RENAME TO session_outcomes;
    PRAGMA foreign_keys = ON;
  `);

  // Seed 3 test-prop rows to mirror production state.
  sqlite.exec(`
    INSERT INTO session_outcomes
      (id, repo_path, runtime, outcome, summary, started_at, completed_at, created_at, valid_from)
    VALUES
      ('test-prop-001', '/test/repo', 'codex', 'succeeded', 'prop 1', datetime('now', '-5 days'), datetime('now', '-5 days'), datetime('now', '-5 days'), NULL),
      ('test-prop-002', '/test/repo', 'codex', 'succeeded', 'prop 2', datetime('now', '-40 days'), datetime('now', '-40 days'), datetime('now', '-40 days'), NULL),
      ('test-prop-003', '/test/repo', 'codex', 'succeeded', 'prop 3', datetime('now', '-1 days'), datetime('now', '-1 days'), datetime('now', '-1 days'), NULL);
  `);

  const before = sqlite.prepare(`SELECT id, valid_from, completed_at FROM session_outcomes ORDER BY id`).all();
  console.log('Before backfill:');
  console.table(before);

  // Close + reopen to trigger ensureIdempotentColumnAdds (fresh getDb call).
  closeDb();
  const db2 = getDb();
  if (!db2) throw new Error('DB unavailable on reopen');
  const sqlite2 = getSqlite();

  const after = sqlite2.prepare(`SELECT id, valid_from, completed_at FROM session_outcomes ORDER BY id`).all() as Array<{ id: string; valid_from: string | null; completed_at: string }>;
  console.log('After backfill (next boot simulated):');
  console.table(after);

  let failures = 0;
  for (const row of after) {
    if (row.valid_from === null) {
      console.error(`FAIL: ${row.id} still has NULL valid_from`);
      failures += 1;
    } else if (row.valid_from !== row.completed_at) {
      console.error(`FAIL: ${row.id} valid_from (${row.valid_from}) != completed_at (${row.completed_at})`);
      failures += 1;
    } else {
      console.log(`OK: ${row.id} backfilled valid_from = ${row.valid_from}`);
    }
  }

  if (failures > 0) {
    process.exit(1);
  }
  console.log('\nBackfill recovery smoke PASSED — 3 stuck prod rows would be recovered.');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
