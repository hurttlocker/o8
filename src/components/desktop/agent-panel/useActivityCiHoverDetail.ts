import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pullRequestListQuery } from '@/lib/github-client';
import { githubQuotaDeadline } from '@/lib/github-client/quota-deadline';
import type { CIHoverDetail } from './types';

export interface ActivityCiHoverStatus {
  error: string | null;
  isFetching: boolean;
  ageSeconds: number | null;
  retry: () => Promise<void>;
}
interface RunDetail {
  run: { databaseId: number; jobs: { name: string; conclusion?: string | null; steps?: { name?: string | null; conclusion?: string | null }[] }[] };
  logs?: string | null;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value: unknown) => value == null || typeof value === 'string';
function validDetail(value: unknown, repo: string, id: number): value is RunDetail {
  return record(value) && !value.error && optionalText(value.logs)
    && (value.repo === undefined || (typeof value.repo === 'string' && value.repo.trim().toLowerCase() === repo))
    && record(value.run) && value.run.databaseId === id && Array.isArray(value.run.jobs)
    && value.run.jobs.every((job: unknown) => record(job) && typeof job.name === 'string' && optionalText(job.conclusion)
      && (job.steps === undefined || (Array.isArray(job.steps) && job.steps.every((step: unknown) =>
        record(step) && optionalText(step.name) && optionalText(step.conclusion)))));
}
class CiHoverDeferredError extends Error {
  constructor(readonly retryAt: number) { super('CI detail refresh is paused'); }
}

function hoverQuery(repo: string, id: number | null) {
  return {
    ...pullRequestListQuery(repo),
    // This query stores the hover's summary, separate from full run detail and lists.
    queryKey: ['gh', repo, 'activity-ci-hover', id],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<CIHoverDetail> => {
      if (!repo || id === null) throw new Error('No CI run selected');
      const response = await fetch(`/api/panel/ci/${id}?repo=${encodeURIComponent(repo)}`, { signal });
      const retryAt = githubQuotaDeadline(response);
      if (retryAt !== null) throw new CiHoverDeferredError(retryAt);
      if (!response.ok) throw new Error(`CI detail request failed (${response.status})`);
      const detail: unknown = await response.json();
      if (!validDetail(detail, repo, id)) throw new Error('Invalid CI detail response');
      return {
        failingJobs: detail.run.jobs.filter(job => job.conclusion?.toLowerCase() === 'failure').map(job => ({
          name: job.name, failingStep: job.steps?.find(step => step.conclusion?.toLowerCase() === 'failure')?.name ?? null,
        })).slice(0, 3),
        summaryLine: (detail.logs ?? '').split('\n')
          .find(line => line.includes('##[error]') || line.toLowerCase().includes('error ts') || line.toLowerCase().includes('failed'))
          ?.replace(/^.*##\[error\]/, '').trim() ?? null,
      };
    },
    refetchInterval: false as const,
    retry: false as const,
  };
}

/** Observe only the hovered, visible run; opening a hover never starts a detail poller. */
export function useActivityCiHoverDetail(repo: string | null, id: number | null) {
  const client = useQueryClient();
  const canonicalRepo = repo?.trim().toLowerCase() ?? '';
  const options = useMemo(() => hoverQuery(canonicalRepo, id), [canonicalRepo, id]);
  const [now, setNow] = useState(() => Date.now());
  const query = useQuery({
    ...options,
    enabled: entry => Boolean(canonicalRepo) && id !== null
      && !(entry.state.error instanceof CiHoverDeferredError && Math.max(now, entry.state.errorUpdatedAt) < entry.state.error.retryAt),
  });
  const retry = useCallback(async () => {
    if (!canonicalRepo || id === null) return;
    try {
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      await client.fetchQuery({ ...options, staleTime: 0 });
    } catch { /* Keep the known summary and expose recovery through the query state. */ }
  }, [client, canonicalRepo, id, options]);
  useEffect(() => {
    if (!query.isError) return;
    const catchUp = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearTimeout(catchUp); clearInterval(timer); };
  }, [query.isError]);
  const status: ActivityCiHoverStatus = {
    error: query.isFetching ? null : query.error?.message ?? null,
    isFetching: query.isFetching,
    ageSeconds: query.dataUpdatedAt ? Math.max(0, Math.floor((Math.max(now, query.errorUpdatedAt) - query.dataUpdatedAt) / 1000)) : null,
    retry,
  };
  return { detail: query.data ?? null, status };
}
