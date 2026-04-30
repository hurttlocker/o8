/**
 * Schema v18 — `facts.source_authority` REAL column + state-aware backfill
 * (#915 north star follow-up: source-of-truth hierarchy).
 *
 * Today the composer treats every retrieved row equally aside from BM25 score
 * and a top-6 fact pin. When a directive (a project rule) and a stale comment
 * contradict each other, the composer might cite the comment. This migration
 * formalizes a hierarchy that retrieval + citation can lean on:
 *
 *   directive (1.0) > merged-PR (0.95) > closed-outcome (0.9) >
 *   closed-issue (0.85) > pr (0.8) > issue (0.75) > comment (0.7)
 *
 * The column lives on `facts` so retrievers can surface it cheaply alongside
 * the BM25 hit, and so the composer can prefer high-authority rows when two
 * facts conflict. Worker writes (`worker.ts`) and the structured promotion
 * (`scripts/seed-facts-from-structured.ts`) populate it on insert.
 *
 * Backfill strategy for existing rows uses `extracted_by` as the source-shape
 * key, then JOINs through `github_pull_requests.merged_at` and
 * `github_issues.closed_at` for the state-aware tiers (merged vs open PR,
 * closed vs open issue). Idempotent — only updates rows whose authority is
 * still the default 0.5 floor.
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
 * Idempotent. Adds `source_authority REAL DEFAULT 0.5` to `facts` when
 * missing, then runs the backfill once. Subsequent boots no-op because the
 * column-add path is gated and the backfill only touches authority=0.5 rows.
 */
export function ensureV18FactsSourceAuthoritySchema(
  sqlite: Database.Database,
): { applied: boolean } {
  const factsTableMissing = !sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'facts'`)
    .get();
  if (factsTableMissing) {
    // v17 didn't run (FTS5 missing or DB freshly created on a v18-aware build
    // before getDb's ensureTables path) — skip and let v17 catch up first.
    return { applied: false };
  }

  if (!tableColumnExists(sqlite, 'facts', 'source_authority')) {
    sqlite.exec(`ALTER TABLE facts ADD COLUMN source_authority REAL NOT NULL DEFAULT 0.5`);
  }

  backfillSourceAuthority(sqlite);

  return { applied: true };
}

/**
 * Backfill `source_authority` for existing facts based on `extracted_by` +
 * upstream state (merged_at / closed_at). Only touches rows whose authority
 * is still the default 0.5, so re-runs are no-ops once the column is filled.
 *
 * Authority tiers:
 *   directive-import  → 1.0
 *   pr-import         → 0.95 if merged_at IS NOT NULL else 0.8
 *   outcome-import    → 0.9
 *   issue-import      → 0.85 if closed_at IS NOT NULL else 0.75
 *   claude-cli        → 0.7 (comment-distilled)
 *   codex-cli         → 0.7 (comment-distilled, alt CLI tier)
 *
 * The PR/issue JOINs use `source_id LIKE 'pr:%'` / `'issue:%'` because the
 * structured seeder writes source_id as `<kind>:<numeric pk>` — see
 * scripts/seed-facts-from-structured.ts.
 */
function backfillSourceAuthority(sqlite: Database.Database): void {
  // 1.0 — directives
  const directives = sqlite
    .prepare(
      `UPDATE facts
         SET source_authority = 1.0
       WHERE source_authority = 0.5
         AND extracted_by = 'directive-import'`,
    )
    .run() as { changes?: number };

  // 0.9 — outcomes (no state subtlety; presence in session_outcomes is enough)
  const outcomes = sqlite
    .prepare(
      `UPDATE facts
         SET source_authority = 0.9
       WHERE source_authority = 0.5
         AND extracted_by = 'outcome-import'`,
    )
    .run() as { changes?: number };

  // 0.95 — merged PRs. JOIN through github_pull_requests.merged_at.
  // source_id format: 'pr:<pull_request_id>' (numeric pk).
  const mergedPrs = sqlite
    .prepare(
      `UPDATE facts
         SET source_authority = 0.95
       WHERE source_authority = 0.5
         AND extracted_by = 'pr-import'
         AND EXISTS (
           SELECT 1 FROM github_pull_requests p
            WHERE 'pr:' || p.pull_request_id = facts.source_id
              AND p.merged_at IS NOT NULL
         )`,
    )
    .run() as { changes?: number };

  // 0.8 — non-merged PRs (everything else under pr-import).
  const otherPrs = sqlite
    .prepare(
      `UPDATE facts
         SET source_authority = 0.8
       WHERE source_authority = 0.5
         AND extracted_by = 'pr-import'`,
    )
    .run() as { changes?: number };

  // 0.85 — closed issues. JOIN through github_issues.closed_at.
  const closedIssues = sqlite
    .prepare(
      `UPDATE facts
         SET source_authority = 0.85
       WHERE source_authority = 0.5
         AND extracted_by = 'issue-import'
         AND EXISTS (
           SELECT 1 FROM github_issues i
            WHERE 'issue:' || i.issue_id = facts.source_id
              AND i.closed_at IS NOT NULL
         )`,
    )
    .run() as { changes?: number };

  // 0.75 — open issues (everything else under issue-import).
  const openIssues = sqlite
    .prepare(
      `UPDATE facts
         SET source_authority = 0.75
       WHERE source_authority = 0.5
         AND extracted_by = 'issue-import'`,
    )
    .run() as { changes?: number };

  // 0.7 — comment-distilled facts (claude-cli + codex-cli paths).
  const comments = sqlite
    .prepare(
      `UPDATE facts
         SET source_authority = 0.7
       WHERE source_authority = 0.5
         AND extracted_by IN ('claude-cli', 'codex-cli')`,
    )
    .run() as { changes?: number };

  const totalChanges =
    (directives.changes ?? 0) +
    (outcomes.changes ?? 0) +
    (mergedPrs.changes ?? 0) +
    (otherPrs.changes ?? 0) +
    (closedIssues.changes ?? 0) +
    (openIssues.changes ?? 0) +
    (comments.changes ?? 0);

  if (totalChanges > 0) {
    console.log(
      `[db][v18] Backfilled source_authority for ${totalChanges} facts ` +
        `(directives=${directives.changes ?? 0}, outcomes=${outcomes.changes ?? 0}, ` +
        `merged-prs=${mergedPrs.changes ?? 0}, other-prs=${otherPrs.changes ?? 0}, ` +
        `closed-issues=${closedIssues.changes ?? 0}, open-issues=${openIssues.changes ?? 0}, ` +
        `comments=${comments.changes ?? 0})`,
    );
  }
}
