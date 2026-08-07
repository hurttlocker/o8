import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureGitHubIssues, normalizeRepoSlug, resolveRepoSlug } from '@/lib/github-broker';
import { listRepos } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { SearchResult } from '@/lib/search/types';

const execFileAsync = promisify(execFile);

async function searchIssuesForRepo(
  query: string,
  repoSlug: string,
  browse = false,
): Promise<SearchResult[]> {
  const result = await ensureGitHubIssues(repoSlug).catch(() => null);
  if (!result) return [];

  const lowered = query.toLowerCase();
  return result.issues
    .filter((issue) => {
      if (browse) return issue.state === 'open';
      const haystack = `${issue.title}\n${issue.body ?? ''}\n#${issue.number}`.toLowerCase();
      return haystack.includes(lowered);
    })
    .sort((left, right) => browse
      ? Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt)
      : 0)
    .slice(0, 8)
    .map<SearchResult>((issue) => {
      const titleStarts = issue.title.toLowerCase().startsWith(lowered) ? 30 : 0;
      const numberHit = String(issue.number) === query.replace(/^#/, '') ? 60 : 0;
      const stateBonus = issue.state === 'open' ? 10 : 0;
      return {
        kind: 'issue',
        id: `issue:${repoSlug}:${issue.number}`,
        title: `#${issue.number} ${issue.title}`,
        detail: `${repoSlug} · ${issue.state}${(issue.body ?? '').trim() ? ` · ${(issue.body ?? '').slice(0, 80)}` : ''}`,
        target: { issueNumber: issue.number, repo: repoSlug },
        score: browse
          ? Date.parse(issue.updatedAt || issue.createdAt)
          : 70 + titleStarts + numberHit + stateBonus,
      };
    });
}

async function registeredRepoSlug(
  repo: RepoRegistryEntry,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cached = cache.get(repo.localPath);
  if (cached !== undefined) return cached;

  let slug = normalizeRepoSlug(repo.remoteUrl);
  if (!slug && repo.isGitRepo !== false) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', repo.localPath, 'config', '--get', 'remote.origin.url'],
        { windowsHide: true, encoding: 'utf-8', timeout: 2_500, maxBuffer: 128 * 1024 },
      );
      slug = normalizeRepoSlug(stdout.trim());
    } catch {
      slug = null;
    }
  }
  cache.set(repo.localPath, slug);
  return slug;
}

async function resolveIssueRepoSlugs(repoLike: string | null, cap: number): Promise<string[]> {
  if (repoLike && /^[\w.-]+\/[\w.-]+$/.test(repoLike)) return [repoLike];

  const repos = await listRepos().catch(() => []);
  const cache = new Map<string, string | null>();

  if (repoLike) {
    const resolved = await resolveRepoSlug(repoLike, '');
    if (resolved) return [resolved];
    const normalized = repoLike.toLowerCase();
    const match = repos.find((repo) => (
      repo.name.toLowerCase() === normalized
      || repo.localPath.toLowerCase() === normalized
    ));
    if (!match) return [];
    const slug = await registeredRepoSlug(match, cache);
    return slug ? [slug] : [];
  }

  const resolvedSlugs = await Promise.all(
    repos.slice(0, 6).map((repo) => registeredRepoSlug(repo, cache)),
  );
  return Array.from(new Set(resolvedSlugs.filter((slug): slug is string => Boolean(slug)))).slice(0, cap);
}

export async function searchIssues(query: string, repoLike: string | null): Promise<SearchResult[]> {
  const slugs = await resolveIssueRepoSlugs(repoLike, repoLike ? 1 : 4);
  if (slugs.length === 0) return [];

  const settled = await Promise.allSettled(
    slugs.map((slug) => searchIssuesForRepo(query, slug)),
  );
  return settled.flatMap((entry) => entry.status === 'fulfilled' ? entry.value : []);
}

export async function browseIssues(repoLike: string | null): Promise<SearchResult[]> {
  if (!repoLike) return [];
  const [slug] = await resolveIssueRepoSlugs(repoLike, 1);
  return slug ? searchIssuesForRepo('', slug, true) : [];
}
