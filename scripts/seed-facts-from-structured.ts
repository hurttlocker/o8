/**
 * Engineering Brain — Phase 2a substrate seed (#915 north star follow-up).
 *
 * Promotes already-structured rows into the `facts` table WITHOUT LLM
 * distillation. The four sources here are short, declarative, and curated
 * enough that they're already fact-shaped — the composer LLM layers on top
 * at query time. Cost: zero LLM calls, runs in seconds vs the 25-min comment
 * drain.
 *
 * Sources promoted:
 *   - directives_fts        → kind='directive'  (rule statements)
 *   - session_outcomes      → kind='process'    (what happened, what shipped)
 *   - github_pull_requests  → kind='decision'   (title + body)
 *   - github_issues         → kind='decision'   (title + body)
 *
 * Skipped (handled elsewhere or Phase 2b):
 *   - github_comments  → indexer-run.ts (LLM distill, comment prose is messy)
 *   - docs/*.md        → Phase 2b (LLM distillation of long-form prose)
 *
 * Idempotent via the `idx_facts_fingerprint` unique index — re-running this
 * script never duplicates rows. Updates `extracted_by` if a row already
 * exists from a prior LLM distill run (preserving the LLM-distilled version
 * is safer; we use INSERT OR IGNORE to keep prior facts untouched).
 *
 * Usage:
 *   npx tsx scripts/seed-facts-from-structured.ts
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
}

function seedOutcomes(db: Database.Database): SeedRow[] {
  const rows = db
    .prepare(
      `SELECT id, repo_path, outcome, summary, branch, packet_id, runtime
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
  url: string;
}

function seedPullRequests(db: Database.Database, repoPathByFullName: Map<string, string>): SeedRow[] {
  const rows = db
    .prepare(
      `SELECT pull_request_id, repo_full_name, number, title, body, state, merged_at, url
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
  url: string;
}

function seedIssues(db: Database.Database, repoPathByFullName: Map<string, string>): SeedRow[] {
  const rows = db
    .prepare(
      `SELECT issue_id, repo_full_name, number, title, body, state, closed_at, url
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
    const raw = require('node:fs').readFileSync(reposJson, 'utf-8');
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

function writeAll(db: Database.Database, rows: SeedRow[]): { inserted: number; skipped: number } {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  // Use INSERT OR IGNORE — if a fact with this fingerprint already exists
  // (e.g. from a prior LLM distill run), keep the existing row untouched.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO facts (
       id, kind, content, source_kind, source_id, source_excerpt,
       repo_path, confidence, fingerprint, extracted_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction((items: SeedRow[]) => {
    for (const r of items) {
      const result = insert.run(
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
      );
      if (result.changes > 0) inserted += 1;
      else skipped += 1;
    }
  });
  tx(rows);
  return { inserted, skipped };
}

function main(): void {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    console.error(`[seed-facts] DB not found: ${dbPath}`);
    process.exit(1);
  }
  console.log(`[seed-facts] DB: ${dbPath}`);
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
  const directiveResult = writeAll(db, directiveRows);
  console.log(
    `[seed-facts] directives: ${directiveRows.length} rows → inserted=${directiveResult.inserted} skipped=${directiveResult.skipped}`,
  );

  const outcomeRows = seedOutcomes(db);
  const outcomeResult = writeAll(db, outcomeRows);
  console.log(
    `[seed-facts] outcomes: ${outcomeRows.length} rows → inserted=${outcomeResult.inserted} skipped=${outcomeResult.skipped}`,
  );

  const prRows = seedPullRequests(db, repoMap);
  const prResult = writeAll(db, prRows);
  console.log(
    `[seed-facts] pull_requests: ${prRows.length} rows → inserted=${prResult.inserted} skipped=${prResult.skipped}`,
  );

  const issueRows = seedIssues(db, repoMap);
  const issueResult = writeAll(db, issueRows);
  console.log(
    `[seed-facts] issues: ${issueRows.length} rows → inserted=${issueResult.inserted} skipped=${issueResult.skipped}`,
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
  console.log(`  skipped (dedup)  : ${totalSkipped}`);
  console.log(`  elapsed          : ${elapsed}s`);
  console.log('────────────────────────────────────────────────────────────');

  db.close();
}

main();
