/**
 * Schema v14 — FTS5 virtual tables for the Q&A retrieval foundation
 * (epic #915 sub-1).
 *
 * Four content-aware FTS5 indexes:
 *   - outcomes_fts(summary, plan_text)        content='session_outcomes'
 *   - prs_fts(title, body)                    content='github_pull_requests'
 *   - issues_fts(title, body)                 content='github_issues'
 *   - directives_fts(directive_id, title, body)
 *       NOT content-backed — directives live as markdown in
 *       ~/.o8/directives/*.md, so we materialize on first migration and
 *       on every directive write hook.
 *
 * Plus `qa_eval_runs` for the eval harness (later sub-issue).
 *
 * Why no vectors: the prior retrieval pipeline silently degraded 413 of 501
 * rows to zero vectors, leaving only 88 real embeddings. BM25 has no
 * silent-failure mode: it returns ranked tokens or nothing. Indexed-on-write
 * via SQLite triggers, sub-200ms p95, no async embedding worker.
 *
 * Boot guard: `pragma compile_options` must include `ENABLE_FTS5`. better-
 * sqlite3 ships it on every supported platform, but we still verify and
 * skip the schema with a warning rather than crashing — matches the
 * "never throw in API routes" / "fail soft on optional infra" pattern.
 */

import type Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

// ── FTS5 availability probe ──

let _fts5Available: boolean | null = null;

/** Cached probe — `pragma compile_options` is cheap but not free. */
export function isFts5Available(sqlite: Database.Database): boolean {
  if (_fts5Available !== null) return _fts5Available;
  try {
    const opts = sqlite.pragma('compile_options') as Array<{ compile_options: string }>;
    _fts5Available = opts.some((row) => row.compile_options === 'ENABLE_FTS5');
    return _fts5Available;
  } catch {
    // Don't cache a transient probe failure — a permanently-cached `false`
    // would silently disable every FTS write for the process lifetime.
    return false;
  }
}

// ── Schema (v14) ──

/**
 * Idempotent. Creates virtual tables, sync triggers, qa_eval_runs, and
 * backfills FTS rows from existing parent tables. Safe to call on every
 * boot — `CREATE VIRTUAL TABLE IF NOT EXISTS` no-ops after the first run,
 * triggers are likewise IF NOT EXISTS, and the directives backfill walks
 * the markdown dir on each call (cheap; ~50 files).
 *
 * Returns the number of rows materialized into FTS during the call (used
 * by smoke tests and boot logs). 0 means everything was already coherent.
 */
export function ensureV14Fts5Schema(sqlite: Database.Database): {
  applied: boolean;
  outcomesBackfilled: number;
  prsBackfilled: number;
  issuesBackfilled: number;
  directivesBackfilled: number;
} {
  const empty = {
    applied: false,
    outcomesBackfilled: 0,
    prsBackfilled: 0,
    issuesBackfilled: 0,
    directivesBackfilled: 0,
  };

  if (!isFts5Available(sqlite)) {
    console.warn(
      '[db][v14] FTS5 not compiled into better-sqlite3 — skipping Q&A retrieval schema. ' +
        'Q&A retrievers will return empty FTS rows; SQL + graph paths still work.',
    );
    return empty;
  }

  // qa_eval_runs is a regular table — fine for this codepath.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS qa_eval_runs (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      expected_answer TEXT NOT NULL,
      actual_answer TEXT NOT NULL,
      citations_json TEXT,
      factual_accuracy REAL,
      citation_correctness REAL,
      hallucination_count INTEGER,
      category TEXT,
      run_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_qa_eval_runs_run_at ON qa_eval_runs(run_at);
  `);

  // Content-backed FTS5 against session_outcomes. We use the rowid contract
  // (FTS rowid = parent rowid) so triggers stay simple and we don't need a
  // separate id<->rowid map. session_outcomes has a TEXT PRIMARY KEY, so
  // we identify rows in the FTS via session_outcomes.id stored in an
  // UNINDEXED column and join back at read time.
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS outcomes_fts USING fts5(
      outcome_id UNINDEXED,
      summary,
      plan_text,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS outcomes_fts_ai AFTER INSERT ON session_outcomes BEGIN
      INSERT INTO outcomes_fts(outcome_id, summary, plan_text)
      VALUES (new.id, new.summary, COALESCE(new.plan_text, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS outcomes_fts_ad AFTER DELETE ON session_outcomes BEGIN
      DELETE FROM outcomes_fts WHERE outcome_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS outcomes_fts_au AFTER UPDATE ON session_outcomes BEGIN
      DELETE FROM outcomes_fts WHERE outcome_id = old.id;
      INSERT INTO outcomes_fts(outcome_id, summary, plan_text)
      VALUES (new.id, new.summary, COALESCE(new.plan_text, ''));
    END;
  `);

  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS prs_fts USING fts5(
      pr_id UNINDEXED,
      title,
      body,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS prs_fts_ai AFTER INSERT ON github_pull_requests BEGIN
      INSERT INTO prs_fts(pr_id, title, body)
      VALUES (new.pull_request_id, new.title, COALESCE(new.body, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS prs_fts_ad AFTER DELETE ON github_pull_requests BEGIN
      DELETE FROM prs_fts WHERE pr_id = old.pull_request_id;
    END;

    CREATE TRIGGER IF NOT EXISTS prs_fts_au AFTER UPDATE ON github_pull_requests BEGIN
      DELETE FROM prs_fts WHERE pr_id = old.pull_request_id;
      INSERT INTO prs_fts(pr_id, title, body)
      VALUES (new.pull_request_id, new.title, COALESCE(new.body, ''));
    END;
  `);

  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
      issue_id UNINDEXED,
      title,
      body,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS issues_fts_ai AFTER INSERT ON github_issues BEGIN
      INSERT INTO issues_fts(issue_id, title, body)
      VALUES (new.issue_id, new.title, COALESCE(new.body, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS issues_fts_ad AFTER DELETE ON github_issues BEGIN
      DELETE FROM issues_fts WHERE issue_id = old.issue_id;
    END;

    CREATE TRIGGER IF NOT EXISTS issues_fts_au AFTER UPDATE ON github_issues BEGIN
      DELETE FROM issues_fts WHERE issue_id = old.issue_id;
      INSERT INTO issues_fts(issue_id, title, body)
      VALUES (new.issue_id, new.title, COALESCE(new.body, ''));
    END;
  `);

  // Directives live on disk, not in SQL. No content backing — this is a
  // pure FTS index that we materialize from `~/.o8/directives/*.md` on
  // first migration and refresh from the directive write hook.
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS directives_fts USING fts5(
      directive_id UNINDEXED,
      title,
      body,
      tokenize='porter unicode61'
    );
  `);

  // Backfill from parent tables when the FTS index is empty. We treat
  // "row count = 0" as the empty signal — once the triggers are in place,
  // future writes keep us coherent without a backfill pass.
  const outcomesBackfilled = backfillOutcomesFts(sqlite);
  const prsBackfilled = backfillPrsFts(sqlite);
  const issuesBackfilled = backfillIssuesFts(sqlite);
  const directivesBackfilled = backfillDirectivesFts(sqlite);

  if (outcomesBackfilled + prsBackfilled + issuesBackfilled + directivesBackfilled > 0) {
    console.log(
      `[db][v14] FTS5 backfill — outcomes=${outcomesBackfilled} prs=${prsBackfilled} ` +
        `issues=${issuesBackfilled} directives=${directivesBackfilled}`,
    );
  }

  return {
    applied: true,
    outcomesBackfilled,
    prsBackfilled,
    issuesBackfilled,
    directivesBackfilled,
  };
}

function backfillOutcomesFts(sqlite: Database.Database): number {
  const count = (sqlite.prepare('SELECT COUNT(*) as c FROM outcomes_fts').get() as { c: number }).c;
  if (count > 0) return 0;
  const result = sqlite
    .prepare(
      `INSERT INTO outcomes_fts(outcome_id, summary, plan_text)
       SELECT id, summary, COALESCE(plan_text, '') FROM session_outcomes`,
    )
    .run() as { changes?: number };
  return result.changes ?? 0;
}

function backfillPrsFts(sqlite: Database.Database): number {
  const count = (sqlite.prepare('SELECT COUNT(*) as c FROM prs_fts').get() as { c: number }).c;
  if (count > 0) return 0;
  const result = sqlite
    .prepare(
      `INSERT INTO prs_fts(pr_id, title, body)
       SELECT pull_request_id, title, COALESCE(body, '') FROM github_pull_requests`,
    )
    .run() as { changes?: number };
  return result.changes ?? 0;
}

function backfillIssuesFts(sqlite: Database.Database): number {
  const count = (sqlite.prepare('SELECT COUNT(*) as c FROM issues_fts').get() as { c: number }).c;
  if (count > 0) return 0;
  const result = sqlite
    .prepare(
      `INSERT INTO issues_fts(issue_id, title, body)
       SELECT issue_id, title, COALESCE(body, '') FROM github_issues`,
    )
    .run() as { changes?: number };
  return result.changes ?? 0;
}

/**
 * Walk `~/.o8/directives/*.md` and (re)populate `directives_fts`. Called
 * once at boot when the FTS index is empty, and re-callable whenever a
 * directive is written (so the Q&A path always sees the latest body).
 *
 * Strips the YAML front matter so BM25 ranks against the prose body, not
 * scope/repoName/etc. metadata.
 */
function backfillDirectivesFts(sqlite: Database.Database): number {
  const count = (sqlite.prepare('SELECT COUNT(*) as c FROM directives_fts').get() as { c: number }).c;
  if (count > 0) return 0;

  const dir = join(getDataDir(), 'directives');
  if (!existsSync(dir)) return 0;

  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    return 0;
  }
  if (files.length === 0) return 0;

  // #915 path-to-70 phase 1.3 — upsert semantics by directive id (the slug).
  // Two markdown files with the same `id:` front-matter slug used to produce
  // two FTS rows; the RRF retriever then picked one non-deterministically and
  // the Q&A judge dinged citation_correctness. Now we delete-then-insert per
  // id so the last-loaded file wins and the index always carries a single row
  // per slug. Seed directives sort first by filename ('s' > 'd'), so when a
  // legacy `d-*.md` paraphrases a `seed-*.md` rule and they happen to share
  // the same id (rare — they don't today, but defensive), the seed wins.
  files.sort();
  const del = sqlite.prepare('DELETE FROM directives_fts WHERE directive_id = ?');
  const insert = sqlite.prepare(
    'INSERT INTO directives_fts(directive_id, title, body) VALUES (?, ?, ?)',
  );
  let inserted = 0;
  sqlite.transaction((names: string[]) => {
    for (const name of names) {
      try {
        const raw = readFileSync(join(dir, name), 'utf-8');
        const { id, title, body } = extractDirectiveFields(raw, name);
        del.run(id);
        insert.run(id, title, body);
        inserted += 1;
      } catch {
        // skip unreadable files
      }
    }
  })(files);

  return inserted;
}

/**
 * Pull `id`, `title`, and the prose body out of a directive markdown file.
 * Front matter is stripped so BM25 ranks on content rather than YAML keys.
 *
 * Exported so the directive write hook can reuse the exact same parser
 * when refreshing a single directive's FTS row.
 */
export function extractDirectiveFields(
  raw: string,
  fileName: string,
): { id: string; title: string; body: string } {
  const fallbackId = fileName.replace(/\.md$/i, '');
  const text = raw.replace(/\r\n/g, '\n');

  let id = fallbackId;
  let title = fallbackId;
  let body = text;

  if (text.startsWith('---')) {
    const afterFirst = text.slice(3).trimStart();
    const closing = afterFirst.search(/^---\s*$/m);
    if (closing >= 0) {
      const front = afterFirst.slice(0, closing);
      body = afterFirst.slice(closing + 3).trimStart();
      for (const line of front.split('\n')) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (!value) continue;
        if (key === 'id') id = value;
        else if (key === 'title') title = value;
      }
    }
  }

  return { id, title, body };
}

/**
 * Refresh a single directive's row in `directives_fts`. Idempotent —
 * deletes the existing row (if any) then re-inserts. Called from the
 * directive write hook so the Q&A surface always reads the freshest
 * body without waiting for the next boot backfill.
 */
export function refreshDirectiveFts(
  sqlite: Database.Database,
  fileName: string,
  raw: string,
): void {
  if (!isFts5Available(sqlite)) return;
  try {
    const { id, title, body } = extractDirectiveFields(raw, fileName);
    sqlite.prepare('DELETE FROM directives_fts WHERE directive_id = ?').run(id);
    sqlite
      .prepare('INSERT INTO directives_fts(directive_id, title, body) VALUES (?, ?, ?)')
      .run(id, title, body);
  } catch (error) {
    console.warn(
      `[db][v14] refreshDirectiveFts(${fileName}) failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}
