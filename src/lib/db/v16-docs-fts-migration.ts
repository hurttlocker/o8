/**
 * Schema v16 — `docs` table + `docs_fts` FTS5 index for repo markdown.
 * (epic #915 path-to-70 phase 1.7 #3.)
 *
 * Round-2 brainstormer found cross-repo at 14% (qa-026/27/28/30 all 0.00) is
 * substrate-empty: the questions ask about invariants that live in CLAUDE.md,
 * README.md, AGENTS.md, docs/design/DESIGN.md, THEME.md, and `docs/**` markdown across
 * registered repos — files the retriever has never seen. BM25 over those
 * files lets the FTS retriever return real rows, which is what the composer
 * needs before it can stop saying "I don't have that information yet."
 *
 *   docs                — content-backed parent. Row per repo+rel_path file.
 *   docs_fts            — FTS5 virtual mirror, kept in sync via AI/AD/AU triggers.
 *
 * Why a real parent table (vs the content-less directives_fts pattern):
 *   - Markdown bodies can be large; we want a single place to read body/title
 *     plus mtime metadata for incremental re-ingest.
 *   - Triggers on `docs` keep `docs_fts` automatically coherent — no boot-time
 *     backfill walk like directives. Ingest just upserts and the trigger fires.
 *
 * Why v16 (not v15): a sibling agent ships v15 (`comments_fts`) in parallel.
 * Both migrations are pure additions (new tables, new triggers, no column
 * mutations on existing tables) so they don't conflict on disk.
 */

import type Database from 'better-sqlite3';

import { isFts5Available } from '@/lib/db/v14-fts5-migration';

// ── Schema (v16) ──

/**
 * Idempotent. Creates `docs` + `docs_fts` + sync triggers. Safe on every
 * boot — `CREATE TABLE/VIRTUAL TABLE/INDEX/TRIGGER IF NOT EXISTS` no-ops
 * after the first run.
 *
 * Returns `{ applied }`. `applied=false` means FTS5 wasn't compiled in;
 * Q&A doc retrieval will return zero rows but no other tables/code paths
 * are affected.
 */
export function ensureV16DocsFtsSchema(sqlite: Database.Database): {
  applied: boolean;
} {
  if (!isFts5Available(sqlite)) {
    console.warn(
      '[db][v16] FTS5 not compiled into better-sqlite3 — skipping docs_fts schema. ' +
        'Doc retriever will return empty rows; rest of Q&A pipeline still works.',
    );
    return { applied: false };
  }

  // Parent table — content-backed. `id` is the composite `<repo_path>:<rel_path>`
  // so an upsert from the ingester is a single INSERT OR REPLACE keyed on
  // file identity.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      last_modified TEXT NOT NULL,
      last_synced TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_docs_repo_path ON docs(repo_path);
    CREATE INDEX IF NOT EXISTS idx_docs_kind ON docs(kind);
    CREATE INDEX IF NOT EXISTS idx_docs_repo_kind ON docs(repo_path, kind);
  `);

  // FTS5 virtual table — `id` is UNINDEXED so we can join back to `docs`
  // for body fetches without rebuilding the index. Title and body are the
  // ranked columns; repo_name and kind are searchable but lower-priority.
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      doc_id UNINDEXED,
      repo_name,
      kind,
      title,
      body,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS docs_fts_ai AFTER INSERT ON docs BEGIN
      INSERT INTO docs_fts(doc_id, repo_name, kind, title, body)
      VALUES (new.id, new.repo_name, new.kind, new.title, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS docs_fts_ad AFTER DELETE ON docs BEGIN
      DELETE FROM docs_fts WHERE doc_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS docs_fts_au AFTER UPDATE ON docs BEGIN
      DELETE FROM docs_fts WHERE doc_id = old.id;
      INSERT INTO docs_fts(doc_id, repo_name, kind, title, body)
      VALUES (new.id, new.repo_name, new.kind, new.title, new.body);
    END;
  `);

  return { applied: true };
}
