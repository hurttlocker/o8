/**
 * Schema v17 — `facts` table + `facts_fts` FTS5 mirror + `facts_queue` work
 * queue for the Engineering Brain Indexer (#915 north star #1 foundation).
 *
 * The background distiller reads raw substrate (comments, docs, outcomes,
 * directives, PRs, issues), extracts structured facts via a Claude/Codex CLI
 * call, and upserts each fact here. The Q&A retrievers then pull from
 * `facts_fts` alongside the existing per-substrate indexes — facts are the
 * highest-leverage row in the merged top-30 because they are the distilled
 * answer, not the raw evidence.
 *
 * Tables:
 *   facts         — distilled facts with provenance (source_kind+source_id).
 *                   `fingerprint` makes upserts idempotent so re-running the
 *                   distiller over the same substrate doesn't double-write.
 *   facts_fts     — FTS5 virtual mirror over (id, kind, content) with AI/AD/AU
 *                   triggers so writes to `facts` keep the index coherent.
 *   facts_queue   — distillation work queue. The worker (#2) drains rows here
 *                   FIFO with attempts tracking + last_error for poisoned items.
 *
 * This migration is the FOUNDATION ONLY. Worker (#2), composer RRF rebalance
 * (#3), and smoke eval (#4) are sibling agents.
 */

import type Database from 'better-sqlite3';

import { isFts5Available } from '@/lib/db/v14-fts5-migration';

/**
 * Idempotent. Creates `facts`, `facts_fts`, `facts_queue`, and the trigger
 * trio. Safe on every boot — every statement is `IF NOT EXISTS`.
 *
 * Returns `{ applied }`. `applied=false` means FTS5 wasn't compiled in;
 * the parent `facts` and `facts_queue` tables still get created (they're
 * not FTS-dependent), but `facts_fts` and the BM25 retriever path are
 * skipped with a warning. Worker writes still work, just without search.
 */
export function ensureV17FactsFtsSchema(sqlite: Database.Database): {
  applied: boolean;
} {
  // `facts` and `facts_queue` are regular tables — create unconditionally so
  // the worker can ingest even when FTS5 is missing. Only the FTS mirror +
  // triggers are gated on FTS5 availability.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_excerpt TEXT NOT NULL,
      repo_path TEXT,
      confidence REAL NOT NULL DEFAULT 0.0,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      extracted_by TEXT NOT NULL DEFAULT 'claude-cli'
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_fingerprint ON facts(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(kind);
    CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_facts_repo_path ON facts(repo_path);
    CREATE INDEX IF NOT EXISTS idx_facts_confidence ON facts(confidence);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS facts_queue (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      repo_path TEXT,
      enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_facts_queue_pending
      ON facts_queue(completed_at, enqueued_at)
      WHERE completed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_facts_queue_source
      ON facts_queue(source_kind, source_id);
  `);

  if (!isFts5Available(sqlite)) {
    console.warn(
      '[db][v17] FTS5 not compiled into better-sqlite3 — skipping facts_fts schema. ' +
        'Facts retriever will return empty rows; worker writes to `facts` still work.',
    );
    return { applied: false };
  }

  // FTS5 mirror — `id` is UNINDEXED so the retriever can join back to `facts`
  // for source_excerpt + confidence at read time. `kind` and `content` are
  // the searchable columns; BM25 ranks against the distilled content.
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      fact_id UNINDEXED,
      kind,
      content,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS facts_fts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(fact_id, kind, content)
      VALUES (new.id, new.kind, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS facts_fts_ad AFTER DELETE ON facts BEGIN
      DELETE FROM facts_fts WHERE fact_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS facts_fts_au AFTER UPDATE ON facts BEGIN
      DELETE FROM facts_fts WHERE fact_id = old.id;
      INSERT INTO facts_fts(fact_id, kind, content)
      VALUES (new.id, new.kind, new.content);
    END;
  `);

  return { applied: true };
}
