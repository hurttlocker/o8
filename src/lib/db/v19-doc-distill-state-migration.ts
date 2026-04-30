/**
 * Schema v19 — `doc_distill_state` checkpoint table for the Phase 2b docs
 * distillation worker (#915 north star follow-up).
 *
 * `scripts/distill-docs.ts` walks repo markdown, semantically chunks each
 * file, and pushes batches of chunks through Claude Sonnet to extract facts.
 * Long runs may be interrupted (CLI bootstrap stalls, OOM, Ctrl-C). To keep
 * resumes cheap and avoid re-paying the LLM cost, we persist per-chunk status
 * here so a re-run skips anything already `done` and retries `pending`/`failed`
 * chunks with bumped attempt counts.
 *
 * Source identity matches what the script writes into `facts.source_id` —
 * `doc:<repoPath>:<relPath>:<chunkIdx>` — so checkpoint state and fact rows
 * stay aligned 1:1.
 *
 * Idempotent. Safe on every boot.
 */

import type Database from 'better-sqlite3';

export function ensureV19DocDistillStateSchema(
  sqlite: Database.Database,
): { applied: boolean } {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS doc_distill_state (
      source_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempted_at TEXT,
      error TEXT,
      file_mtime TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_doc_distill_state_status
      ON doc_distill_state(status);
  `);

  return { applied: true };
}
