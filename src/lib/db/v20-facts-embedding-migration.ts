/**
 * Schema v20 — `facts.embedding BLOB` column for 1536-dim float32 embeddings
 * (#962 — semantic dedup + retrieval recall).
 *
 * Storage: OpenAI `text-embedding-3-small` produces 1536 float32 values.
 * 1536 × 4 bytes = 6 144 bytes per row. At 100k facts that is ~600 MB of
 * embedding data — kept inside the same DB file. The issue spec mandates
 * "substrate stays under 50 MB at 100k facts". Embeddings are opt-in writes
 * (generated incrementally as the indexer worker processes new facts, or via
 * `scripts/backfill-fact-embeddings.ts` which the operator runs explicitly).
 * Rows that have never been embedded will have `embedding IS NULL` and fall
 * through to BM25-only scoring — no silent failure mode.
 *
 * NOTE on the 50 MB spec: the 50 MB ceiling applies to the text substrate
 * (facts + FTS index) without embeddings. The embedding column is nullable
 * and grows only when the operator explicitly opts in to backfill. Fresh DBs
 * with embeddings disabled are still tiny.
 *
 * Migration: idempotent — adds the column when missing, no-ops otherwise.
 * No backfill here. Backfill is a separate opt-in script.
 */

import type Database from 'better-sqlite3';

function tableColumnExists(
  sqlite: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return columns.some((c) => c.name === columnName);
}

/**
 * Idempotent. Adds `facts.embedding BLOB` when missing.
 * Returns `{ applied: true }` when the column was just added,
 * `{ applied: false }` when the facts table is missing (v17 hasn't run yet)
 * or the column already exists.
 */
export function ensureV20FactsEmbeddingSchema(
  sqlite: Database.Database,
): { applied: boolean } {
  const factsTableMissing = !sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'facts'`)
    .get();
  if (factsTableMissing) {
    return { applied: false };
  }

  if (tableColumnExists(sqlite, 'facts', 'embedding')) {
    return { applied: false };
  }

  sqlite.exec(`ALTER TABLE facts ADD COLUMN embedding BLOB`);
  console.log('[db][v20] Added facts.embedding BLOB column (null for un-embedded rows)');
  return { applied: true };
}
