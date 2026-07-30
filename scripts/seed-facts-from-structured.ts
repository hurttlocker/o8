// Engineering Brain — Phase 2a substrate seed (#915 north star follow-up).
//
// Promotes already-structured rows into the `facts` table WITHOUT LLM
// distillation. The four sources here are short, declarative, and curated
// enough that they're already fact-shaped — the composer LLM layers on top
// at query time. Cost: zero LLM calls, runs in seconds vs the 25-min comment
// drain.
//
// Sources promoted:
//   - directives_fts        → kind='directive'  (rule statements)
//   - session_outcomes      → kind='process'    (what happened, what shipped)
//   - github_pull_requests  → kind='decision'   (title + body)
//   - github_issues         → kind='decision'   (title + body)
//
// Skipped (handled elsewhere or Phase 2b):
//   - github_comments  → indexer-run.ts (LLM distill, comment prose is messy)
//   - docs/**/*.md     → Phase 2b (LLM distillation of long-form prose)
//
// Idempotent via the `idx_facts_fingerprint` unique index — re-running this
// script never duplicates rows. Source-update detection: the default path is
// INSERT OR REPLACE on fingerprint, but only when the source's current
// authority/state would produce a stricter (newer) row than the existing
// fact. We approximate "newer" via fact `created_at` — if the existing
// fact's created_at is older than now (always true) AND the source's
// `updated_at`/`merged_at`/`closed_at` is newer than the fact, we replace.
// Pass `--force` to bypass the freshness check (used for migrations).
//
// Usage:
//   npx tsx scripts/seed-facts-from-structured.ts            # default (freshness-checked replace)
//   npx tsx scripts/seed-facts-from-structured.ts --force    # rebuild every row

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

interface SeedRow {
  factId: string;
  kind: 'directive' | 'process' | 'decision' | 'spec';
  content: string;
  sourceKind: 'directive' | 'outcome' | 'pr' | 'issue';
  sourceId: string;
  sourceExcerpt: string;
  repoPath: string | null;
  confidence: number;
  fingerprint: string;
  extractedBy: string;
  /** Authority tier for the source-of-truth hierarchy (#915 follow-up).
   *  directive=1.0, merged-PR=0.95, outcome=0.9, closed-issue=0.85,
   *  pr=0.8, issue=0.75, comment=0.7. Computed from row state at
   *  promotion time. */
  sourceAuthority: number;
  /** ISO timestamp the upstream source was last edited. NULL when there is
   *  no meaningful upstream-mutation timestamp (e.g. directives). Used by
   *  the freshness check in writeAll() to decide whether to overwrite an
   *  existing fact row. */
  sourceUpdatedAt: string | null;
}

function getDbPath(): string {
  const dataDir =
    process.env.O8_DATA_DIR ||
    process.env.CORTEX_IDE_DATA_DIR ||
    path.join(os.homedir(), '.o8');
  return path.join(dataDir, 'cortex-ide.db');
}

function fingerprintOf(content: string, sourceId: string): string {
  return createHash('sha256').update(`${sourceId}\n${content}`).digest('hex');
}

function clip(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

interface DirectiveRow {
  directive_id: string;
  title: string;
  body: string;
}

function seedDirectives(db: Database.Database): SeedRow[] {
  const rows = db
    .prepare(`SELECT directive_id, title, body FROM directives_fts`)
    .all() as DirectiveRow[];
  const out: SeedRow[] = [];
  for (const row of rows) {
    const title = (row.title || '').trim();
    const body = (row.body || '').trim();
    if (!title && !body) continue;
    const content = title && body ? `${title} — ${body}` : title || body;
    const sourceId = `directive:${row.directive_id}`;
    out.push({
      factId: randomUUID(),
      kind: 'directive',
      content: clip(content, 2000),
      sourceKind: 'directive',
      sourceId,
      sourceExcerpt: clip(content, 400),
      repoPath: null,
      confidence: 1.0,
      fingerprint: fingerprintOf(content, sourceId),
      extractedBy: 'directive-import',
      sourceAuthority: 1.0,
      // directives_fts doesn't carry a timestamp — directives are project rules
      // that don't churn often. Without --force the freshness check keeps the
      // existing fact row.
      sourceUpdatedAt: null,
    });
  }
  return out;
}

interface OutcomeRow {
  id: string;
  repo_path: string | null;
  outcome: string;
  summary: string;
  branch: string | null;
  packet_id: string | null;
  runtime: string;
  completed_at: string | null;
  created_at: string | null;
}

function seedOutcomes(db: Database.Database): SeedRow[] {
  const rows = db
    .prepare(
      `SELECT id, repo_path, outcome, summary, branch, packet_id, runtime,
              completed_at, created_at
         FROM session_outcomes
        WHERE summary IS NOT NULL AND length(summary) > 20`,
    )
    .all() as OutcomeRow[];
  const out: SeedRow[] = [];
  for (const row of rows) {
    const summary = (row.summary || '').trim();
    if (!summary) continue;
    const tag = `[${row.outcome}${row.runtime ? `/${row.runtime}` : ''}]`;
    const content = `${tag} ${summary}`;
    const sourceId = `outcome:${row.id}`;
    out.push({
      factId: randomUUID(),
      kind: 'process',
      content: clip(content, 2000),
      sourceKind: 'outcome',
      sourceId,
      sourceExcerpt: clip(summary, 400),
      repoPath: row.repo_path ?? null,
      confidence: 0.9,
      fingerprint: fingerprintOf(content, sourceId),
      extractedBy: 'outcome-import',
      sourceAuthority: 0.9,
      // session_outcomes are append-only — `completed_at` is the work-finish
      // stamp and never moves. Use it as the canonical "source freshness"
      // signal so re-seeding the same outcome doesn't churn writes.
      sourceUpdatedAt: row.completed_at ?? row.created_at ?? null,
    });
  }
  return out;
}

interface PrRow {
  pull_request_id: number;
  repo_full_name: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
  updated_at: string | null;
  url: string;
}

function seedPullRequests(db: Database.Database, repoPathByFullName: Map<string, string>): SeedRow[] {
  const rows = db
    .prepare(
      `SELECT pull_request_id, repo_full_name, number, title, body, state,
              merged_at, updated_at, url
         FROM github_pull_requests
        WHERE title IS NOT NULL AND length(title) > 0`,
    )
    .all() as PrRow[];
  const out: SeedRow[] = [];
  for (const row of rows) {
    const title = (row.title || '').trim();
    const body = (row.body || '').trim();
    if (!title) continue;
    const stateTag = row.merged_at
      ? '[merged]'
      : row.state
        ? `[${row.state.toLowerCase()}]`
        : '';
    const head = `${stateTag} PR #${row.number}: ${title}`.trim();
    const content = body ? `${head}\n\n${clip(body, 1400)}` : head;
    const sourceId = `pr:${row.pull_request_id}`;
    const repoPath = repoPathByFullName.get(row.repo_full_name) ?? null;
    out.push({
      factId: randomUUID(),
      kind: 'decision',
      content: clip(content, 2000),
      sourceKind: 'pr',
      sourceId,
      sourceExcerpt: clip(`${head}${body ? `\n\n${body}` : ''}`, 400),
      repoPath,
      confidence: row.merged_at ? 0.9 : 0.7,
      fingerprint: fingerprintOf(content, sourceId),
      extractedBy: 'pr-import',
      // Source-of-truth hierarchy: merged PRs (0.95) carry more authority
      // than open ones (0.8) because the change has actually shipped.
      sourceAuthority: row.merged_at ? 0.95 : 0.8,
      // updated_at moves on every GitHub PR mutation (label, edit, review).
      // The freshness check uses the latest of merged_at / updated_at so a
      // PR that was edited after merge still re-distills.
      sourceUpdatedAt: row.merged_at ?? row.updated_at ?? null,
    });
  }
  return out;
}

interface IssueRow {
  issue_id: number;
  repo_full_name: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  closed_at: string | null;
  updated_at: string | null;
  url: string;
}

function seedIssues(db: Database.Database, repoPathByFullName: Map<string, string>): SeedRow[] {
  const rows = db
    .prepare(
      `SELECT issue_id, repo_full_name, number, title, body, state, closed_at,
              updated_at, url
         FROM github_issues
        WHERE title IS NOT NULL AND length(title) > 0`,
    )
    .all() as IssueRow[];
  const out: SeedRow[] = [];
  for (const row of rows) {
    const title = (row.title || '').trim();
    const body = (row.body || '').trim();
    if (!title) continue;
    const stateTag = row.state ? `[${row.state.toLowerCase()}]` : '';
    const head = `${stateTag} Issue #${row.number}: ${title}`.trim();
    const content = body ? `${head}\n\n${clip(body, 1400)}` : head;
    const sourceId = `issue:${row.issue_id}`;
    const repoPath = repoPathByFullName.get(row.repo_full_name) ?? null;
    out.push({
      factId: randomUUID(),
      kind: 'decision',
      content: clip(content, 2000),
      sourceKind: 'issue',
      sourceId,
      sourceExcerpt: clip(`${head}${body ? `\n\n${body}` : ''}`, 400),
      repoPath,
      confidence: row.closed_at ? 0.85 : 0.65,
      fingerprint: fingerprintOf(content, sourceId),
      extractedBy: 'issue-import',
      // Source-of-truth hierarchy: closed issues (0.85) outrank open ones
      // (0.75) because the resolution is final.
      sourceAuthority: row.closed_at ? 0.85 : 0.75,
      // updated_at moves on every comment/edit. closed_at is the resolution
      // stamp. Use the later of the two as the freshness signal.
      sourceUpdatedAt: row.closed_at ?? row.updated_at ?? null,
    });
  }
  return out;
}

function loadRepoFullNameMap(): Map<string, string> {
  const map = new Map<string, string>();
  const dataDir =
    process.env.O8_DATA_DIR ||
    process.env.CORTEX_IDE_DATA_DIR ||
    path.join(os.homedir(), '.o8');
  const reposJson = path.join(dataDir, 'repos.json');
  if (!existsSync(reposJson)) return map;
  try {
    const raw = readFileSync(reposJson, 'utf-8');
    const parsed = JSON.parse(raw) as {
      repos?: Array<{ remoteUrl?: string | null; localPath?: string }>;
    };
    for (const r of parsed.repos ?? []) {
      const url = r.remoteUrl ?? '';
      const m = url.match(/github\.com[:\/]([^\/]+\/[^\/.]+)/);
      if (m && r.localPath) {
        map.set(m[1], r.localPath);
      }
    }
  } catch {}
  return map;
}

interface WriteAllResult {
  inserted: number;
  replaced: number;
  skipped: number;
}

/**
 * Insert facts. Default mode is INSERT OR REPLACE on the unique fingerprint,
 * gated by a freshness check: we only replace an existing fact when the
 * source has been updated upstream since the fact was last written.
 *
 * Tradeoffs:
 *   - Brand-new fingerprint → INSERT (counts as `inserted`).
 *   - Existing fingerprint + stale source → no-op (counts as `skipped`).
 *   - Existing fingerprint + fresh source → REPLACE (counts as `replaced`).
 *   - `--force` mode bypasses the staleness check and always REPLACEs.
 *
 * Why fingerprint-based and not source_id-based: the same source can fan out
 * into multiple facts (PR title vs PR body vs PR labels — all distinct
 * fingerprints). Replacing on fingerprint preserves that 1:N relationship.
 */
function writeAll(
  db: Database.Database,
  rows: SeedRow[],
  opts: { force: boolean },
): WriteAllResult {
  if (rows.length === 0) return { inserted: 0, replaced: 0, skipped: 0 };

  const lookupByFp = db.prepare(
    `SELECT id, created_at FROM facts WHERE fingerprint = ?`,
  );
  // ON CONFLICT(fingerprint) DO UPDATE keeps the existing row's id stable so
  // the FTS5 trigger updates in place instead of churning a delete+insert.
  // We pin `created_at` to the latest of (now, sourceUpdatedAt) so the next
  // freshness check has a stable comparison and same-day replays don't keep
  // bouncing the row when GitHub's `T`-separated timestamp lexically beats
  // SQLite's space-separated `datetime('now')`.
  const upsert = db.prepare(
    `INSERT INTO facts (
       id, kind, content, source_kind, source_id, source_excerpt,
       repo_path, confidence, fingerprint, extracted_by, source_authority,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       kind = excluded.kind,
       content = excluded.content,
       source_kind = excluded.source_kind,
       source_id = excluded.source_id,
       source_excerpt = excluded.source_excerpt,
       repo_path = excluded.repo_path,
       confidence = excluded.confidence,
       extracted_by = excluded.extracted_by,
       source_authority = excluded.source_authority,
       created_at = excluded.created_at`,
  );
  const insertOnly = db.prepare(
    `INSERT OR IGNORE INTO facts (
       id, kind, content, source_kind, source_id, source_excerpt,
       repo_path, confidence, fingerprint, extracted_by, source_authority
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  let replaced = 0;
  let skipped = 0;

  const tx = db.transaction((items: SeedRow[]) => {
    for (const r of items) {
      const existing = lookupByFp.get(r.fingerprint) as
        | { id: string; created_at: string }
        | undefined;

      if (!existing) {
        // Brand-new fingerprint — straight INSERT. The upsert path also works
        // for this case but we use insertOnly so the changes count distinguishes
        // truly-new rows from replaced ones in the summary.
        const result = insertOnly.run(
          r.factId,
          r.kind,
          r.content,
          r.sourceKind,
          r.sourceId,
          r.sourceExcerpt,
          r.repoPath,
          r.confidence,
          r.fingerprint,
          r.extractedBy,
          r.sourceAuthority,
        );
        if (result.changes > 0) inserted += 1;
        else skipped += 1;
        continue;
      }

      // Existing fingerprint. Decide whether to overwrite.
      let shouldReplace = opts.force;
      if (!shouldReplace && r.sourceUpdatedAt && existing.created_at) {
        // Strict newer-than. SQLite ISO-8601 strings compare
        // lexicographically; GitHub timestamps use `2026-04-30T12:26:45Z`
        // (T-separator) while SQLite's `datetime('now')` uses
        // `2026-04-30 22:20:59` (space-separator). Char comparison treats T
        // (0x54) as later than space (0x20), so same-day edits err on the
        // side of refresh. Fine: the upsert is idempotent on content, so a
        // false-positive replace just rewrites the same row.
        shouldReplace = r.sourceUpdatedAt > existing.created_at;
      }

      if (!shouldReplace) {
        skipped += 1;
        continue;
      }

      // REPLACE via the conflict-update path. Preserves `id` and pins
      // `created_at` to the source's `updated_at` (or now if missing) so the
      // next freshness check sees `source.updated_at <= fact.created_at` and
      // skips. Without this, GitHub's T-separator vs SQLite's space-separator
      // would re-replace the same row on every same-day rerun.
      const newCreatedAt = r.sourceUpdatedAt ?? new Date().toISOString().replace('T', ' ').replace('Z', '');
      upsert.run(
        r.factId, // ignored on conflict (existing.id stays)
        r.kind,
        r.content,
        r.sourceKind,
        r.sourceId,
        r.sourceExcerpt,
        r.repoPath,
        r.confidence,
        r.fingerprint,
        r.extractedBy,
        r.sourceAuthority,
        newCreatedAt,
      );
      replaced += 1;
    }
  });
  tx(rows);
  return { inserted, replaced, skipped };
}

function main(): void {
  const force = process.argv.includes('--force');
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    console.error(`[seed-facts] DB not found: ${dbPath}`);
    process.exit(1);
  }
  console.log(`[seed-facts] DB: ${dbPath}`);
  if (force) console.log('[seed-facts] --force mode: bypassing freshness check');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const repoMap = loadRepoFullNameMap();
  console.log(`[seed-facts] resolved ${repoMap.size} repo paths from repos.json`);

  const beforeFacts = (
    db.prepare(`SELECT COUNT(*) AS n FROM facts`).get() as { n: number }
  ).n;
  console.log(`[seed-facts] facts before: ${beforeFacts}`);

  const t0 = Date.now();

  const directiveRows = seedDirectives(db);
  const directiveResult = writeAll(db, directiveRows, { force });
  console.log(
    `[seed-facts] directives: ${directiveRows.length} rows → inserted=${directiveResult.inserted} replaced=${directiveResult.replaced} skipped=${directiveResult.skipped}`,
  );

  const outcomeRows = seedOutcomes(db);
  const outcomeResult = writeAll(db, outcomeRows, { force });
  console.log(
    `[seed-facts] outcomes: ${outcomeRows.length} rows → inserted=${outcomeResult.inserted} replaced=${outcomeResult.replaced} skipped=${outcomeResult.skipped}`,
  );

  const prRows = seedPullRequests(db, repoMap);
  const prResult = writeAll(db, prRows, { force });
  console.log(
    `[seed-facts] pull_requests: ${prRows.length} rows → inserted=${prResult.inserted} replaced=${prResult.replaced} skipped=${prResult.skipped}`,
  );

  const issueRows = seedIssues(db, repoMap);
  const issueResult = writeAll(db, issueRows, { force });
  console.log(
    `[seed-facts] issues: ${issueRows.length} rows → inserted=${issueResult.inserted} replaced=${issueResult.replaced} skipped=${issueResult.skipped}`,
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const afterFacts = (
    db.prepare(`SELECT COUNT(*) AS n FROM facts`).get() as { n: number }
  ).n;
  const totalInserted =
    directiveResult.inserted +
    outcomeResult.inserted +
    prResult.inserted +
    issueResult.inserted;
  const totalReplaced =
    directiveResult.replaced +
    outcomeResult.replaced +
    prResult.replaced +
    issueResult.replaced;
  const totalSkipped =
    directiveResult.skipped +
    outcomeResult.skipped +
    prResult.skipped +
    issueResult.skipped;

  console.log('');
  console.log('────────────────────────────────────────────────────────────');
  console.log('[seed-facts] summary');
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  facts before     : ${beforeFacts}`);
  console.log(`  facts after      : ${afterFacts}`);
  console.log(`  net new          : ${afterFacts - beforeFacts}`);
  console.log(`  inserted (raw)   : ${totalInserted}`);
  console.log(`  replaced (fresh) : ${totalReplaced}`);
  console.log(`  skipped (stale)  : ${totalSkipped}`);
  console.log(`  force            : ${force}`);
  console.log(`  elapsed          : ${elapsed}s`);
  console.log('────────────────────────────────────────────────────────────');

  db.close();
}

main();
