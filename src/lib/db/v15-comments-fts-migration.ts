/**
 * Schema v15 — `github_comments` table + `comments_fts` virtual table.
 *
 * Phase 1.7 #2 of epic #915 — round-2 brainstormer found that decisions
 * (qa-008/9/10) and specs (qa-021..025) bottom out at substrate-empty
 * because the locked-architecture decisions live as comments on issues/PRs,
 * never as standalone bodies. Searching `comments_fts` for "outcomes_fts"
 * surfaces the actual comment that names the four FTS5 tables, which the
 * existing `issues_fts` (title + body only) never could.
 *
 * Mirrors v14's structure: idempotent create, FTS5-availability probe,
 * AI/AD/AU triggers to keep the FTS in sync with the parent. Unlike v14,
 * we do NOT backfill from the parent on first migration — comments are
 * populated by the ingestion job in `src/lib/cortex/ingest/github-comments.ts`.
 *
 * Why a dedicated table instead of stuffing comments into issues_fts/prs_fts:
 *   - Each comment carries its own author + timestamp + url that the citation
 *     pill needs to render correctly.
 *   - One comment per row keeps BM25 ranking sharp; concatenating into the
 *     parent body would dilute matches against long threads.
 *   - The retriever can cap comment hits independently (8) so they compete
 *     fairly with directives/outcomes/PRs/issues without flooding top-30.
 */

import type Database from 'better-sqlite3';

import { isFts5Available } from '@/lib/db/v14-fts5-migration';

/**
 * Idempotent. Creates `github_comments`, `comments_fts`, sync triggers,
 * and a small `comments_sync` table that tracks the last-seen `updated_at`
 * per repo (so the ingestion job can do incremental polls instead of
 * paginating from the start every run).
 *
 * Returns `{ applied }` so the caller can log when the schema was created
 * for the first time vs already existed.
 */
export function ensureV15CommentsFtsSchema(sqlite: Database.Database): {
  applied: boolean;
} {
  if (!isFts5Available(sqlite)) {
    console.warn(
      '[db][v15] FTS5 not compiled into better-sqlite3 — skipping comments FTS schema. ' +
        'comments_fts retriever will return empty rows; the rest of the Q&A path still works.',
    );
    return { applied: false };
  }

  // ── github_comments ──
  // `id` is a composite key `<parent_kind>-<parent_number>-<gh_comment_id>`
  // so re-fetching the same comment from a paginated list is a no-op upsert.
  // `gh_comment_id` is the raw GitHub comment id (numeric, but TEXT here so
  // PR review threads with non-numeric ids stay representable).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS github_comments (
      id TEXT PRIMARY KEY,
      gh_comment_id TEXT NOT NULL,
      parent_kind TEXT NOT NULL,
      parent_number INTEGER NOT NULL,
      parent_id TEXT,
      repo_full_name TEXT NOT NULL,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      repo_path TEXT,
      author_login TEXT,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT,
      updated_at TEXT,
      url TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_github_comments_parent
      ON github_comments(parent_kind, parent_number, repo_full_name);
    CREATE INDEX IF NOT EXISTS idx_github_comments_updated
      ON github_comments(repo_full_name, updated_at DESC);
  `);

  // ── comments_fts ──
  // We index `body` as the searchable column. `parent_number` and
  // `parent_kind` ride along UNINDEXED so the retriever can render citation
  // pills + "issue #915 comment" labels without a join when it doesn't need
  // the full row.
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
      comment_id UNINDEXED,
      parent_number UNINDEXED,
      parent_kind UNINDEXED,
      body,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS comments_fts_ai AFTER INSERT ON github_comments BEGIN
      INSERT INTO comments_fts(comment_id, parent_number, parent_kind, body)
      VALUES (new.id, new.parent_number, new.parent_kind, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS comments_fts_ad AFTER DELETE ON github_comments BEGIN
      DELETE FROM comments_fts WHERE comment_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS comments_fts_au AFTER UPDATE ON github_comments BEGIN
      DELETE FROM comments_fts WHERE comment_id = old.id;
      INSERT INTO comments_fts(comment_id, parent_number, parent_kind, body)
      VALUES (new.id, new.parent_number, new.parent_kind, new.body);
    END;
  `);

  // ── comments_sync ──
  // Per-repo, per-resource cursor (issue-comments vs pr-review-comments) so
  // the ingestion job can pass `since=<last_synced_at>` to GitHub. Resources:
  //   - 'issue_comments' → /repos/{o}/{r}/issues/comments
  //   - 'pr_review_comments' → /repos/{o}/{r}/pulls/comments
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS comments_sync (
      repo_full_name TEXT NOT NULL,
      resource TEXT NOT NULL,
      last_synced_at TEXT,
      last_seen_updated_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo_full_name, resource)
    );
  `);

  return { applied: true };
}
