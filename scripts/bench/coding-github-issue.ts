import { execFileSync } from 'node:child_process';

interface BenchmarkGitHubIssue {
  number: number;
  state: string;
  title: string;
  body: string;
}

const issueCache = new Map<string, BenchmarkGitHubIssue>();

export function resolveBenchmarkRepoSlug(repoRoot: string): string {
  const pinned = process.env.O8_BENCH_REPO?.trim() || process.env.GH_REPO?.trim();
  if (pinned) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(pinned)) {
      throw new Error(`invalid benchmark repository slug: ${JSON.stringify(pinned)}`);
    }
    return pinned;
  }

  const slug = execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  if (!slug) throw new Error('could not resolve the current repository slug');
  return slug;
}

export function readBenchmarkGitHubIssue(repoRoot: string, issue: number): BenchmarkGitHubIssue {
  const slug = resolveBenchmarkRepoSlug(repoRoot);
  const cacheKey = `${slug}#${issue}`;
  const cached = issueCache.get(cacheKey);
  if (cached) return cached;

  let payload: unknown;
  try {
    payload = JSON.parse(execFileSync(
      'gh',
      ['api', `repos/${slug}/issues/${issue}`],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch {
    throw new Error(`could not read issue #${issue} through the authenticated repository REST API`);
  }

  const record = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : null;
  if (
    record?.number !== issue
    || typeof record.state !== 'string'
    || typeof record.title !== 'string'
    || (typeof record.body !== 'string' && record.body !== null)
    || record.pull_request !== undefined
  ) {
    throw new Error(`issue #${issue} returned an invalid repository payload`);
  }

  const result: BenchmarkGitHubIssue = {
    number: issue,
    state: record.state,
    title: record.title,
    body: typeof record.body === 'string' ? record.body : '',
  };
  issueCache.set(cacheKey, result);
  return result;
}

export function benchmarkIssueText(repoRoot: string, issue: number): string {
  const record = readBenchmarkGitHubIssue(repoRoot, issue);
  return `# ${record.title}\n\n${record.body}`.trim();
}
