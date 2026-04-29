/**
 * Project Pulse — aggregated peer-repo activity for the Recall Card (epic #899
 * wave 2). Given a repo, walk every Project the repo belongs to and collect
 * recent commits / open PRs / open issues from each peer repo so the operator
 * can see what teammates just shipped without leaving the packet.
 *
 * Wedge constraints (v0.2):
 *   - NO new GitHub API calls. Only the cache that already exists (SQLite
 *     `github_issues` / `github_pull_requests` and the in-memory commit cache).
 *   - Stale or missing cache entries return empty arrays — never throw.
 *   - The current repo is excluded; only PEER repos surface.
 *
 * Drift detection (commits-touching-directive-files) is deferred to v0.2.5.
 * Don't add it here.
 */

import 'server-only';

import { listProjectsByRepoId } from './store';
import type { ProjectRole } from './types';
import { listRepos } from '@/lib/repos/registry';
import { normalizeRepoSlug } from '@/lib/github-broker/repo';
import {
  listGitHubIssues,
  listGitHubPullRequests,
  type GitHubIssueSnapshot,
  type GitHubPullRequestSnapshot,
} from '@/lib/github-broker/store';
import { getCached } from '@/lib/github/cache';

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_PER_LIST = 5;

/** Lightweight commit shape from the in-memory cache. */
interface CachedCommit {
  hash: string;
  message: string;
  date: string;
  author?: string | null;
}

export interface PulseCommit {
  hash: string;
  message: string;
  date: string;
  author: string | null;
  url: string | null;
}

export interface PulsePullRequest {
  number: number;
  title: string;
  state: string;
  author: string | null;
  url: string;
  updatedAt: string;
}

export interface PulseIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: Array<{ name: string; color: string }>;
  updatedAt: string;
}

export interface ProjectPulseRepo {
  repoId: string;
  repoName: string;
  repoFullName: string | null;
  role: ProjectRole | null;
  recentCommits: PulseCommit[];
  openPrs: PulsePullRequest[];
  openIssues: PulseIssue[];
}

export interface ProjectPulse {
  projectId: string;
  projectName: string;
  projectSlug: string;
  byRepo: ProjectPulseRepo[];
  generatedAt: number;
}

function isWithin(iso: string | null | undefined, windowMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= windowMs;
}

function commitUrl(repoFullName: string | null, hash: string): string | null {
  if (!repoFullName || !hash) return null;
  return `https://github.com/${repoFullName}/commit/${hash}`;
}

function readCachedCommits(repoFullName: string): CachedCommit[] {
  // The /api/panel/commits route caches under `commits:${repo}:${limit}`; we
  // try a small set of common limits since the cache is shared across all
  // dashboard reads. Whatever's there, we use.
  const candidates = [15, 20, 30, 10, 5];
  for (const limit of candidates) {
    const hit = getCached<CachedCommit[]>(`commits:${repoFullName}:${limit}`);
    if (hit && hit.length > 0) return hit;
  }
  return [];
}

function mapCommit(commit: CachedCommit, repoFullName: string | null): PulseCommit {
  return {
    hash: commit.hash,
    message: commit.message,
    date: commit.date,
    author: commit.author ?? null,
    url: commitUrl(repoFullName, commit.hash),
  };
}

function mapPullRequest(pr: GitHubPullRequestSnapshot): PulsePullRequest {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    author: pr.author?.login ?? null,
    url: pr.url,
    updatedAt: pr.updatedAt,
  };
}

function mapIssue(issue: GitHubIssueSnapshot): PulseIssue {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    labels: issue.labels,
    updatedAt: issue.updatedAt,
  };
}

/**
 * Resolve a repoId to its `owner/name` GitHub slug. Returns null when the
 * repo isn't registered, has no remote, or the remote isn't a GitHub URL.
 */
function repoFullNameFromRegistry(
  repoId: string,
  registry: Awaited<ReturnType<typeof listRepos>>,
): { repoFullName: string | null; repoName: string } {
  const entry = registry.find((r) => r.id === repoId);
  if (!entry) return { repoFullName: null, repoName: repoId };
  return {
    repoFullName: normalizeRepoSlug(entry.remoteUrl),
    repoName: entry.name,
  };
}

/**
 * For every Project the source repo belongs to, return per-peer-repo activity
 * pulled from existing caches. Self-rows are excluded so the card focuses on
 * what teammates shipped.
 */
export async function getProjectPulse(repoId: string): Promise<ProjectPulse[]> {
  if (!repoId) return [];

  // Project memberships — empty list when the repo isn't in any project.
  let projects: ReturnType<typeof listProjectsByRepoId>;
  try {
    projects = listProjectsByRepoId(repoId);
  } catch {
    return [];
  }
  if (projects.length === 0) return [];

  // Resolve registry once for the whole fan-out.
  const registry = await listRepos().catch(() => []);
  const generatedAt = Date.now();

  const pulses: ProjectPulse[] = [];

  for (const project of projects) {
    const peerRows: ProjectPulseRepo[] = [];

    for (const repoLink of project.repos) {
      // Skip the current repo — peers only.
      if (repoLink.repoId === repoId) continue;

      const { repoFullName, repoName } = repoFullNameFromRegistry(repoLink.repoId, registry);

      // Without a GitHub slug we can't reach the cache. Surface the row with
      // empty arrays so the operator at least sees the peer exists.
      if (!repoFullName) {
        peerRows.push({
          repoId: repoLink.repoId,
          repoName,
          repoFullName: null,
          role: repoLink.role,
          recentCommits: [],
          openPrs: [],
          openIssues: [],
        });
        continue;
      }

      // Issues + PRs come from the durable SQLite cache. Wrapped because a
      // missing table or migration glitch shouldn't poison the whole pulse.
      let issues: GitHubIssueSnapshot[] = [];
      let prs: GitHubPullRequestSnapshot[] = [];
      try {
        issues = listGitHubIssues(repoFullName);
      } catch {
        issues = [];
      }
      try {
        prs = listGitHubPullRequests(repoFullName);
      } catch {
        prs = [];
      }

      // Commits — best-effort from the in-memory cache. The /api/panel/commits
      // route only populates this when the dashboard has fetched the repo;
      // empty is the default state.
      const cachedCommits = readCachedCommits(repoFullName)
        .filter((c) => isWithin(c.date, RECENT_WINDOW_MS))
        .slice(0, MAX_PER_LIST)
        .map((c) => mapCommit(c, repoFullName));

      peerRows.push({
        repoId: repoLink.repoId,
        repoName,
        repoFullName,
        role: repoLink.role,
        recentCommits: cachedCommits,
        openPrs: prs.slice(0, MAX_PER_LIST).map(mapPullRequest),
        openIssues: issues.slice(0, MAX_PER_LIST).map(mapIssue),
      });
    }

    // If a project has no peers (just the source repo), drop it entirely so
    // the card doesn't render an empty "Project pulse" header.
    if (peerRows.length === 0) continue;

    pulses.push({
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
      byRepo: peerRows,
      generatedAt,
    });
  }

  return pulses;
}
