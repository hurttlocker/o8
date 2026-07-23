/**
 * GitHub comment ingestion job (epic #915 phase 1.7 #2).
 *
 * Walks every repo in `~/.o8/repos.json` and fetches:
 *   - issue comments     GET /repos/{o}/{r}/issues/comments
 *   - pull review        GET /repos/{o}/{r}/pulls/comments
 *
 * Both endpoints support `since=<ISO>` for incremental polling. We track the
 * cursor per (repo_full_name, resource) in the `comments_sync` table created
 * by schema v15.
 *
 * Comments upsert into `github_comments` keyed on
 * `<parent_kind>-<parent_number>-<gh_comment_id>`, so re-fetching the same
 * comment is idempotent and the FTS triggers keep `comments_fts` coherent.
 *
 * Auth: routed through the same GitHub App installation token path that
 * github-broker uses (15k/hr per installation). When the App isn't
 * configured, the job logs a warning and exits 0 — fresh clones boot fine.
 */

import 'server-only';

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { getSqlite } from '@/lib/db';
import { githubInstallationFetch } from '@/lib/github-broker/auth';
import { getGitHubAppConfig } from '@/lib/github-broker/env';
import { getDataDir } from '@/lib/data-dir-migration';

// ── Repo registry loader (duplicated to avoid pulling in 'server-only' imports) ──
//
// We can't import @/lib/repos/registry directly because it pulls in
// 'server-only' and our smoke script runs as a standalone tsx process.
// Reading the registry JSON is cheap; mirroring the loader keeps the
// ingestion job dependency-free.

interface RepoRegistryRow {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  defaultBranch: string;
}

interface RepoRegistry {
  version: number;
  repos: RepoRegistryRow[];
}


function loadRepos(): RepoRegistryRow[] {
  const registryPath = path.join(getDataDir(), 'repos.json');
  if (!existsSync(registryPath)) return [];
  try {
    const raw = readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(raw) as RepoRegistry;
    return Array.isArray(parsed.repos) ? parsed.repos : [];
  } catch (error) {
    console.warn(
      '[ingest][comments] failed to read repos.json:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/** Pull `<owner>/<repo>` out of a remote url. Returns null when the url is
 *  missing or doesn't look like a github.com remote. */
function parseRepoFullName(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  // Match both git@github.com:owner/repo and https://github.com/owner/repo
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

// ── Sync cursor ──

interface SyncCursor {
  lastSyncedAt: string | null;
}

function readSyncCursor(repoFullName: string, resource: string): SyncCursor {
  const sqlite = getSqlite();
  const row = sqlite
    .prepare(
      'SELECT last_synced_at FROM comments_sync WHERE repo_full_name = ? AND resource = ?',
    )
    .get(repoFullName, resource) as { last_synced_at: string | null } | undefined;
  return { lastSyncedAt: row?.last_synced_at ?? null };
}

function writeSyncCursor(
  repoFullName: string,
  resource: string,
  lastSyncedAt: string,
  lastSeenUpdatedAt: string | null,
  lastError: string | null,
): void {
  const sqlite = getSqlite();
  sqlite
    .prepare(
      `INSERT INTO comments_sync (repo_full_name, resource, last_synced_at, last_seen_updated_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(repo_full_name, resource) DO UPDATE SET
         last_synced_at = excluded.last_synced_at,
         last_seen_updated_at = excluded.last_seen_updated_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    )
    .run(repoFullName, resource, lastSyncedAt, lastSeenUpdatedAt, lastError);
}

// ── GitHub payload shapes ──

interface GitHubIssueCommentPayload {
  id: number;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string | null } | null;
  // /repos/.../issues/comments returns issue_url like
  //   https://api.github.com/repos/owner/repo/issues/123
  issue_url?: string;
}

interface GitHubPrReviewCommentPayload {
  id: number;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string | null } | null;
  // pull_request_url like https://api.github.com/repos/owner/repo/pulls/123
  pull_request_url?: string;
}

function extractParentNumber(url: string | undefined): number | null {
  if (!url) return null;
  const match = url.match(/\/(?:issues|pulls)\/(\d+)$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

// ── Upsert ──

interface CommentUpsertRow {
  id: string;
  ghCommentId: string;
  parentKind: 'issue' | 'pull_request';
  parentNumber: number;
  parentId: string | null;
  repoFullName: string;
  repoOwner: string;
  repoName: string;
  repoPath: string | null;
  authorLogin: string | null;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
}

function upsertComments(rows: CommentUpsertRow[]): number {
  if (rows.length === 0) return 0;
  const sqlite = getSqlite();
  const stmt = sqlite.prepare(
    `INSERT INTO github_comments
       (id, gh_comment_id, parent_kind, parent_number, parent_id,
        repo_full_name, repo_owner, repo_name, repo_path,
        author_login, body, created_at, updated_at, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       body = excluded.body,
       updated_at = excluded.updated_at,
       author_login = excluded.author_login,
       url = excluded.url,
       parent_id = excluded.parent_id,
       repo_path = excluded.repo_path`,
  );
  let inserted = 0;
  sqlite.transaction((all: CommentUpsertRow[]) => {
    for (const row of all) {
      stmt.run(
        row.id,
        row.ghCommentId,
        row.parentKind,
        row.parentNumber,
        row.parentId,
        row.repoFullName,
        row.repoOwner,
        row.repoName,
        row.repoPath,
        row.authorLogin,
        row.body,
        row.createdAt,
        row.updatedAt,
        row.url,
      );
      inserted += 1;
    }
  })(rows);
  return inserted;
}

// ── Resolve parent ids from existing tables ──

function lookupParentId(
  parentKind: 'issue' | 'pull_request',
  repoFullName: string,
  parentNumber: number,
): string | null {
  const sqlite = getSqlite();
  if (parentKind === 'issue') {
    const row = sqlite
      .prepare(
        'SELECT issue_id FROM github_issues WHERE repo_full_name = ? AND number = ?',
      )
      .get(repoFullName, parentNumber) as { issue_id: number } | undefined;
    return row?.issue_id != null ? String(row.issue_id) : null;
  }
  const row = sqlite
    .prepare(
      'SELECT pull_request_id FROM github_pull_requests WHERE repo_full_name = ? AND number = ?',
    )
    .get(repoFullName, parentNumber) as { pull_request_id: number } | undefined;
  return row?.pull_request_id != null ? String(row.pull_request_id) : null;
}

// ── Fetch loops ──

const PER_PAGE = 100;
const MAX_PAGES = 20; // guardrail — 2000 comments/resource per ingest run

async function fetchIssueComments(
  repoFullName: string,
  since: string | null,
): Promise<GitHubIssueCommentPayload[]> {
  const all: GitHubIssueCommentPayload[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      per_page: String(PER_PAGE),
      sort: 'updated',
      direction: 'asc',
      page: String(page),
    });
    if (since) params.set('since', since);
    const target = `/repos/${repoFullName}/issues/comments?${params.toString()}`;
    const { response } = await githubInstallationFetch(repoFullName, target);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`issue-comments page ${page} failed (${response.status}): ${text.slice(0, 200)}`);
    }
    const items = JSON.parse(text) as GitHubIssueCommentPayload[];
    all.push(...items);
    if (items.length < PER_PAGE) break;
  }
  return all;
}

async function fetchPrReviewComments(
  repoFullName: string,
  since: string | null,
): Promise<GitHubPrReviewCommentPayload[]> {
  const all: GitHubPrReviewCommentPayload[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      per_page: String(PER_PAGE),
      sort: 'updated',
      direction: 'asc',
      page: String(page),
    });
    if (since) params.set('since', since);
    const target = `/repos/${repoFullName}/pulls/comments?${params.toString()}`;
    const { response } = await githubInstallationFetch(repoFullName, target);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`pr-review-comments page ${page} failed (${response.status}): ${text.slice(0, 200)}`);
    }
    const items = JSON.parse(text) as GitHubPrReviewCommentPayload[];
    all.push(...items);
    if (items.length < PER_PAGE) break;
  }
  return all;
}

// ── Per-repo orchestrator ──

export interface RepoIngestStats {
  repoFullName: string;
  issueCommentsIngested: number;
  prReviewCommentsIngested: number;
  errors: string[];
}

async function ingestRepoComments(
  repo: { localPath: string; remoteUrl: string | null },
): Promise<RepoIngestStats | null> {
  const repoFullName = parseRepoFullName(repo.remoteUrl);
  if (!repoFullName) {
    console.warn(
      `[ingest][comments] skipping ${repo.localPath} — no parseable remote (${repo.remoteUrl ?? 'null'})`,
    );
    return null;
  }
  const [repoOwner, repoName] = repoFullName.split('/');

  const stats: RepoIngestStats = {
    repoFullName,
    issueCommentsIngested: 0,
    prReviewCommentsIngested: 0,
    errors: [],
  };

  // ── Issue comments ──
  const issueCursor = readSyncCursor(repoFullName, 'issue_comments');
  const issueRunStartedAt = new Date().toISOString();
  let issueLastSeen: string | null = issueCursor.lastSyncedAt;
  try {
    const items = await fetchIssueComments(repoFullName, issueCursor.lastSyncedAt);
    const rows: CommentUpsertRow[] = [];
    for (const item of items) {
      const parentNumber = extractParentNumber(item.issue_url);
      if (parentNumber == null) continue;
      const ghCommentId = String(item.id);
      const id = `issue-${parentNumber}-${ghCommentId}`;
      const updatedAt = item.updated_at ?? null;
      if (updatedAt && (!issueLastSeen || updatedAt > issueLastSeen)) {
        issueLastSeen = updatedAt;
      }
      rows.push({
        id,
        ghCommentId,
        parentKind: 'issue',
        parentNumber,
        parentId: lookupParentId('issue', repoFullName, parentNumber),
        repoFullName,
        repoOwner,
        repoName,
        repoPath: repo.localPath,
        authorLogin: item.user?.login ?? null,
        body: item.body ?? '',
        createdAt: item.created_at ?? null,
        updatedAt,
        url: item.html_url ?? null,
      });
    }
    stats.issueCommentsIngested = upsertComments(rows);
    writeSyncCursor(repoFullName, 'issue_comments', issueRunStartedAt, issueLastSeen, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stats.errors.push(`issue_comments: ${message}`);
    writeSyncCursor(repoFullName, 'issue_comments', issueRunStartedAt, issueLastSeen, message);
  }

  // ── PR review comments ──
  const prCursor = readSyncCursor(repoFullName, 'pr_review_comments');
  const prRunStartedAt = new Date().toISOString();
  let prLastSeen: string | null = prCursor.lastSyncedAt;
  try {
    const items = await fetchPrReviewComments(repoFullName, prCursor.lastSyncedAt);
    const rows: CommentUpsertRow[] = [];
    for (const item of items) {
      const parentNumber = extractParentNumber(item.pull_request_url);
      if (parentNumber == null) continue;
      const ghCommentId = String(item.id);
      const id = `pr-${parentNumber}-${ghCommentId}`;
      const updatedAt = item.updated_at ?? null;
      if (updatedAt && (!prLastSeen || updatedAt > prLastSeen)) {
        prLastSeen = updatedAt;
      }
      rows.push({
        id,
        ghCommentId,
        parentKind: 'pull_request',
        parentNumber,
        parentId: lookupParentId('pull_request', repoFullName, parentNumber),
        repoFullName,
        repoOwner,
        repoName,
        repoPath: repo.localPath,
        authorLogin: item.user?.login ?? null,
        body: item.body ?? '',
        createdAt: item.created_at ?? null,
        updatedAt,
        url: item.html_url ?? null,
      });
    }
    stats.prReviewCommentsIngested = upsertComments(rows);
    writeSyncCursor(repoFullName, 'pr_review_comments', prRunStartedAt, prLastSeen, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stats.errors.push(`pr_review_comments: ${message}`);
    writeSyncCursor(repoFullName, 'pr_review_comments', prRunStartedAt, prLastSeen, message);
  }

  return stats;
}

// ── Public entry point ──

export interface IngestSummary {
  reposScanned: number;
  reposSkipped: number;
  totalIssueComments: number;
  totalPrReviewComments: number;
  perRepo: RepoIngestStats[];
}

/**
 * Ingest comments for every repo in the registry. Best-effort — a single
 * repo's failure is logged into its `errors[]` and the loop moves on.
 */
export async function ingestAllRepoComments(): Promise<IngestSummary> {
  const summary: IngestSummary = {
    reposScanned: 0,
    reposSkipped: 0,
    totalIssueComments: 0,
    totalPrReviewComments: 0,
    perRepo: [],
  };

  if (!getGitHubAppConfig()) {
    console.warn(
      '[ingest][comments] GitHub App not configured — set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (or ~/.o8/github-app.pem). Exiting.',
    );
    return summary;
  }

  const repos = loadRepos();
  if (repos.length === 0) {
    console.warn('[ingest][comments] no repos found in ~/.o8/repos.json — nothing to ingest.');
    return summary;
  }

  for (const repo of repos) {
    const stats = await ingestRepoComments(repo);
    if (!stats) {
      summary.reposSkipped += 1;
      continue;
    }
    summary.reposScanned += 1;
    summary.totalIssueComments += stats.issueCommentsIngested;
    summary.totalPrReviewComments += stats.prReviewCommentsIngested;
    summary.perRepo.push(stats);
  }

  return summary;
}
