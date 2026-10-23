'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pullRequestListQuery } from '@/lib/github-client';
import { RamsButton } from './settings/RamsButton';

interface CIExpandDetail {
  failingJobs: { name: string; failingStep: string | null }[];
  summaryLine: string | null;
}
interface RunDetail {
  run: { databaseId: number; jobs: { name: string; conclusion?: string | null; steps?: { name: string; conclusion?: string | null }[] }[] };
  logs: string;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const optionalString = (value: unknown) => value == null || typeof value === 'string';
function validDetail(value: unknown, repo: string, id: number): value is RunDetail {
  return isObject(value) && !value.error && typeof value.logs === 'string'
    && (value.repo === undefined || (typeof value.repo === 'string' && value.repo.trim().toLowerCase() === repo))
    && isObject(value.run) && value.run.databaseId === id && Array.isArray(value.run.jobs)
    && value.run.jobs.every((job: unknown) => isObject(job) && typeof job.name === 'string' && optionalString(job.conclusion)
      && (job.steps === undefined || (Array.isArray(job.steps) && job.steps.every((step: unknown) =>
        isObject(step) && typeof step.name === 'string' && optionalString(step.conclusion)))));
}
class CIDetailDeferredError extends Error {
  constructor(status: number, readonly retryAt: number) { super(`CI detail request paused (${status})`); }
}
function retryAt(response: Response) {
  const now = Date.now();
  const retry = response.headers.get('retry-after');
  if (retry) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1000;
    const date = Date.parse(retry);
    if (Number.isFinite(date) && date > now) return date;
  }
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
  return reset > now ? reset : now + 300_000;
}
function detailQuery(repo: string, id: number) {
  return {
    ...pullRequestListQuery(repo),
    // This snapshot contains only the expanded row's failure summary.
    queryKey: ['gh', repo, 'o8-activity-ci-detail', id],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<CIExpandDetail> => {
      // A pane refresh can remove an old row in this commit. Let its last
      // observer cancel before opening a transport for the obsolete row.
      await Promise.resolve();
      signal.throwIfAborted();
      const response = await fetch(`/api/panel/ci/${id}?repo=${encodeURIComponent(repo)}`, { signal });
      if (response.status === 403 || response.status === 429) throw new CIDetailDeferredError(response.status, retryAt(response));
      if (!response.ok) throw new Error(`CI detail request failed (${response.status})`);
      const detail: unknown = await response.json();
      if (!validDetail(detail, repo, id)) throw new Error('Invalid CI detail response');
      return {
        failingJobs: detail.run.jobs.filter(job => job.conclusion?.toLowerCase() === 'failure').map(job => ({
          name: job.name, failingStep: job.steps?.find(step => step.conclusion?.toLowerCase() === 'failure')?.name ?? null,
        })).slice(0, 3),
        summaryLine: detail.logs.split('\n').find(line => line.includes('##[error]') || line.toLowerCase().includes('error ts') || line.toLowerCase().includes('failed'))
          ?.replace(/^.*##\[error\]/, '').trim() ?? null,
      };
    },
    refetchInterval: false as const,
    retry: false as const,
  };
}

/** Mounted only for a visible expanded run in an active pane. */
export function O8ActivityCIDetail({ repo, runId, children }: {
  repo: string; runId: number; children: (detail: CIExpandDetail | undefined) => ReactNode;
}) {
  const client = useQueryClient();
  const options = useMemo(() => detailQuery(repo.trim().toLowerCase(), runId), [repo, runId]);
  const query = useQuery({
    ...options,
    enabled: entry => !(entry.state.error instanceof CIDetailDeferredError && Date.now() < entry.state.error.retryAt),
  });
  const retry = useCallback(async () => {
    try {
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      await client.fetchQuery({ ...options, staleTime: 0 });
    } catch {
      // Preserve the known summary; the query exposes the new read error.
    }
  }, [client, options]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!query.isError) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [query.isError]);
  const ageSeconds = Math.max(0, Math.floor((Math.max(now, query.errorUpdatedAt) - query.dataUpdatedAt) / 1000));
  return <>
    {children(query.data)}
    <div style={{ fontSize: 12, color: 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)' }}>
      {query.isFetching ? (query.data ? 'Refreshing CI details… ' : 'Loading CI details… ') : null}
      {!query.isFetching && query.error ? `CI details delayed: ${query.error.message}. ` : null}
      {!query.isFetching && query.error && query.data ? `Showing last known details (${ageSeconds}s old). ` : null}
      <RamsButton variant="ghost" onClick={() => { void retry(); }}>Retry CI details</RamsButton>
    </div>
  </>;
}
