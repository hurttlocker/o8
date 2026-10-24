import { useEffect, useRef, useState } from 'react';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { githubQuotaDeadline } from '@/lib/github-client/quota-deadline';
import { relativeAge } from './shared';
import type { ActivityItem } from './types';

type ActivityExtras = {
  issues: ActivityItem[];
  prs: ActivityItem[];
  ciRuns: ActivityItem[];
  repoCommits: ActivityItem[];
};
const EMPTY_EXTRAS: ActivityExtras = { issues: [], prs: [], ciRuns: [], repoCommits: [] };
const PAUSED = 'GitHub rate limit — paused until reset';

/** Keep successful streams scoped to their repository through failed refreshes. */
export function useActivityExtras(repo: string | null, allRepos: string[], isAllRepos: boolean, refreshKey?: number) {
  const repos = isAllRepos ? [...allRepos].sort() : repo ? [repo] : [];
  const scope = JSON.stringify({ repos, registered: [...allRepos].sort(), isAllRepos });
  const cache = useRef(new Map<string, ActivityExtras>());
  const pausedUntil = useRef(0);
  const [snapshot, setSnapshot] = useState(() => ({
    byRepo: new Map<string, ActivityExtras>(), errorScope: '', error: null as string | null, timelineOrigin: Date.now(),
  }));

  useEffect(() => {
    const current = JSON.parse(scope) as { repos: string[]; registered: string[] };
    let controller: AbortController | null = null;
    let disposed = false;

    async function refresh() {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const errors: string[] = [];
      let nextPause = pausedUntil.current;
      const results = await Promise.all(current.repos.map(async (repoSlug) => {
        const previous = cache.current.get(repoSlug) ?? EMPTY_EXTRAS;
        if (Date.now() < pausedUntil.current) {
          errors.push(PAUSED);
          return [repoSlug, previous] as const;
        }
        const init = { signal: request.signal };
        const [issuesRes, prsRes, ciRes, commitsRes] = await Promise.all([
          fetch(`/api/panel/issues?repo=${encodeURIComponent(repoSlug)}`, init).catch(() => null),
          fetch(`/api/panel/prs?repo=${encodeURIComponent(repoSlug)}`, init).catch(() => null),
          fetch(`/api/panel/ci?repo=${encodeURIComponent(repoSlug)}`, init).catch(() => null),
          ipcFetch(`/api/panel/commits?repo=${encodeURIComponent(repoSlug)}`, init).catch(() => null),
        ]);
        for (const response of [issuesRes, prsRes, ciRes, commitsRes]) {
          const deadline = response ? githubQuotaDeadline(response) : null;
          if (deadline !== null) {
            nextPause = Math.max(nextPause, deadline);
            errors.push(PAUSED);
          }
        }
        async function readStream(
          response: Response | null,
          previousItems: ActivityItem[],
          map: (response: Response) => Promise<ActivityItem[]>,
        ): Promise<ActivityItem[]> {
          try {
            if (!response?.ok) throw new Error('Unable to load repo activity');
            return await map(response);
          } catch {
            errors.push('Unable to load repo activity');
            return previousItems;
          }
        }
        const issueItems = await readStream(issuesRes, previous.issues, async (response) => {
          const issueItems: ActivityItem[] = [];
          const data = await response.json();
          if (data.error) throw new Error(String(data.error));
          if (!Array.isArray(data.issues)) throw new Error('Invalid issues activity');
          for (const issue of (data.issues ?? []).slice(0, 8)) {
            const ts = issue.createdAt ? new Date(issue.createdAt).getTime() : 0;
            issueItems.push({
              kind: 'issue',
              number: issue.number,
              title: issue.title,
              state: (issue.state ?? '').toLowerCase(),
              labels: issue.labels ?? [],
              age: issue.createdAt ? relativeAge(issue.createdAt) : '',
              ts,
              repo: repoSlug,
              author: issue.author?.login ?? 'unknown',
              assignees: (issue.assignees ?? [])
                .map((assignee: { login?: string | null }) => assignee.login ?? '')
                .filter(Boolean),
              comments: typeof issue.comments === 'number' ? issue.comments : 0,
              body: (issue.body ?? '').trim(),
            });
          }
          return issueItems;
        });

        const prItems = await readStream(prsRes, previous.prs, async (response) => {
          const prItems: ActivityItem[] = [];
          const data = await response.json();
          if (data.error) throw new Error(String(data.error));
          if (!Array.isArray(data.prs)) throw new Error('Invalid prs activity');
          for (const pr of (data.prs ?? []).slice(0, 8)) {
            const ts = pr.createdAt ? new Date(pr.createdAt).getTime() : 0;
            const checks = pr.statusCheckRollup ?? [];
            prItems.push({
              kind: 'pr',
              number: pr.number,
              title: pr.title,
              state: (pr.state ?? '').toLowerCase(),
              author: pr.author?.login ?? '',
              branch: pr.headRefName ?? '',
              additions: pr.additions ?? 0,
              deletions: pr.deletions ?? 0,
              changedFiles: pr.changedFiles ?? 0,
              reviewDecision: pr.reviewDecision ?? '',
              checkSummary: {
                passed: checks.filter((check: { conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'success').length,
                failed: checks.filter((check: { conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'failure').length,
                pending: checks.filter((check: { conclusion?: string | null; status?: string | null }) => !check.conclusion || check.status?.toLowerCase() !== 'completed').length,
              },
              failingChecks: checks
                .filter((check: { name?: string | null; conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'failure')
                .map((check: { name?: string | null }) => check.name || 'Unknown check')
                .slice(0, 3),
              age: pr.createdAt ? relativeAge(pr.createdAt) : '',
              ts,
              repo: repoSlug,
            });
          }
          return prItems;
        });

        const ciItems = await readStream(ciRes, previous.ciRuns, async (response) => {
          const ciItems: ActivityItem[] = [];
          const data = await response.json();
          if (data.error) throw new Error(String(data.error));
          if (!Array.isArray(data.runs)) throw new Error('Invalid runs activity');
          for (const run of (data.runs ?? []).slice(0, 6)) {
            const ts = run.createdAt ? new Date(run.createdAt).getTime() : 0;
            ciItems.push({
              kind: 'ci',
              id: run.databaseId,
              title: run.displayTitle ?? '',
              status: run.status ?? '',
              conclusion: run.conclusion ?? '',
              branch: run.headBranch ?? '',
              workflow: run.workflowName ?? '',
              age: run.createdAt ? relativeAge(run.createdAt) : '',
              ts,
              repo: repoSlug,
            });
          }
          return ciItems;
        });

        const commitItems = await readStream(commitsRes, previous.repoCommits, async (response) => {
          const commitItems: ActivityItem[] = [];
          const data = await response.json();
          if (data.error) throw new Error(String(data.error));
          if (!Array.isArray(data.commits)) throw new Error('Invalid commits activity');
          for (const commit of (data.commits ?? []).slice(0, 10)) {
            const ts = commit.date ? new Date(commit.date).getTime() : 0;
            commitItems.push({
              kind: 'commit',
              hash: commit.hash ?? '',
              message: commit.message ?? '',
              age: commit.date ? relativeAge(commit.date) : '',
              ts,
              repo: repoSlug,
            });
          }
          return commitItems;
        });
        return [repoSlug, { issues: issueItems, prs: prItems, ciRuns: ciItems, repoCommits: commitItems }] as const;
      }));
      // IPC and some transports cannot abort their work; ignore their late replies too.
      if (disposed || request.signal.aborted) return;
      const retained = new Set([...current.registered, ...current.repos]);
      const byRepo = new Map([...cache.current].filter(([slug]) => retained.has(slug)));
      for (const [slug, extras] of results) byRepo.set(slug, extras);
      cache.current = byRepo;
      pausedUntil.current = nextPause;
      setSnapshot({ byRepo, errorScope: scope, error: errors.length ? [...new Set(errors)].join(' | ') : null, timelineOrigin: Date.now() });
    }

    void refresh();
    const handler = () => { void refresh(); };
    window.addEventListener('o8:lifecycle-reconcile', handler);
    const timer = setInterval(handler, 300_000);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      window.removeEventListener('o8:lifecycle-reconcile', handler);
    };
  }, [scope, refreshKey]);

  const extras: ActivityExtras = { issues: [], prs: [], ciRuns: [], repoCommits: [] };
  for (const slug of repos) {
    const result = snapshot.byRepo.get(slug);
    if (!result) continue;
    extras.issues.push(...result.issues);
    extras.prs.push(...result.prs);
    extras.ciRuns.push(...result.ciRuns);
    extras.repoCommits.push(...result.repoCommits.map((item) => item.kind === 'commit' && isAllRepos
      ? { ...item, message: `[${slug.split('/').pop()}] ${item.message}` } : item));
  }
  return { extras, remoteScopeError: snapshot.errorScope === scope ? snapshot.error : null, timelineOrigin: snapshot.timelineOrigin };
}
