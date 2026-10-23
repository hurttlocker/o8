import { useCallback, useEffect, useState } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { pullRequestListQuery } from '@/lib/github-client/queries';
import type { CIRun } from './useCanvasCIRuns';

interface CIAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: string;
  message: string;
  title: string;
  rawDetails: string;
  blobUrl: string;
  jobName?: string;
  jobUrl?: string;
}

interface CIBotComment {
  id: number;
  prNumber: number;
  kind: 'issue' | 'review';
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number | null;
  url: string;
}

export interface CIRunDetail extends CIRun {
  jobs: {
    databaseId: number;
    name: string;
    status: string;
    conclusion: string;
    startedAt: string;
    completedAt: string;
    url?: string;
    checkRunId?: number | null;
    annotations?: CIAnnotation[];
  }[];
  annotations: CIAnnotation[];
  botComments: CIBotComment[];
}

interface CIRunSnapshot { run: CIRunDetail; logs: string }
class CIReadDeferredError extends Error {
  constructor(readonly retryAt: number) { super('Unable to load run details'); }
}

function quotaDeadline(response: Response): number | null {
  if (response.status !== 429 && response.status !== 403) return null;
  const now = Date.now();
  const retry = response.headers.get('retry-after');
  const seconds = Number(retry);
  const retryAt = Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : Date.parse(retry ?? '');
  if (response.status === 403 && !(retryAt > now) && response.headers.get('x-ratelimit-remaining') !== '0') return null;
  const resetAt = Number(response.headers.get('x-ratelimit-reset')) * 1000;
  const deadline = Math.max(Number.isFinite(retryAt) ? retryAt : 0, Number.isFinite(resetAt) ? resetAt : 0);
  return Math.min(now + 24 * 60 * 60_000, deadline > now ? deadline : now + 60_000);
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optionalText = (value: unknown) => value === undefined || typeof value === 'string';
const textFields = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string');

function validAnnotation(value: unknown): value is CIAnnotation {
  return record(value) && textFields(value, ['path', 'level', 'message', 'title', 'rawDetails', 'blobUrl'])
    && count(value.startLine) && count(value.endLine) && optionalText(value.jobName) && optionalText(value.jobUrl);
}

function validRun(value: unknown, id: number): value is CIRunDetail {
  if (!record(value) || value.databaseId !== id || !textFields(value, ['displayTitle', 'event', 'headBranch', 'status', 'conclusion', 'createdAt', 'updatedAt', 'workflowName', 'url']) || !optionalText(value.headSha)) return false;
  if (value.pullRequests !== undefined && (!Array.isArray(value.pullRequests) || !value.pullRequests.every(pr => record(pr) && count(pr.number) && typeof pr.url === 'string'))) return false;
  if (!Array.isArray(value.jobs) || !value.jobs.every(job => record(job) && count(job.databaseId)
    && textFields(job, ['name', 'status', 'conclusion', 'startedAt', 'completedAt']) && optionalText(job.url)
    && (job.checkRunId === undefined || job.checkRunId === null || count(job.checkRunId))
    && (job.annotations === undefined || (Array.isArray(job.annotations) && job.annotations.every(validAnnotation))))) return false;
  if (!Array.isArray(value.annotations) || !value.annotations.every(validAnnotation)) return false;
  return Array.isArray(value.botComments) && value.botComments.every(comment => record(comment) && count(comment.id) && count(comment.prNumber)
    && (comment.kind === 'issue' || comment.kind === 'review') && textFields(comment, ['author', 'body', 'createdAt', 'url'])
    && optionalText(comment.path) && (comment.line === undefined || comment.line === null || count(comment.line)));
}

function ciDetailQuery(repo: string | undefined, id: number, resolvedRepo?: string) {
  const slug = repo?.trim() || null;
  // The route also accepts a registered name/path. Its successful list resolves that alias.
  const reportedRepo = typeof resolvedRepo === 'string' ? resolvedRepo.trim() || null : null;
  const expectedRepo = slug && /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : reportedRepo ?? slug;
  const cacheScope = slug ? expectedRepo?.toLowerCase() ?? null : null;
  return queryOptions({
    ...pullRequestListQuery(''),
    // Lists and detail snapshots have different shapes; default lookup is a separate scope.
    queryKey: ['gh', cacheScope, 'ci-run', id],
    queryFn: async ({ signal }): Promise<CIRunSnapshot> => {
      const repoParam = slug ? `?repo=${encodeURIComponent(slug)}` : '';
      const response = await fetch(`/api/panel/ci/${id}${repoParam}`, { signal });
      const retryAt = quotaDeadline(response);
      if (retryAt !== null) throw new CIReadDeferredError(retryAt);
      if (!response.ok) throw new Error('Unable to load run details');
      const data = await response.json();
      if (!record(data) || data.error || !validRun(data.run, id) || !optionalText(data.logs)
        || (data.repo !== undefined && (typeof data.repo !== 'string' || (expectedRepo && data.repo.trim().toLowerCase() !== expectedRepo.toLowerCase())))) throw new Error('Unable to load run details');
      return { run: data.run, logs: data.logs ?? '' };
    },
    // Keep the existing selection/invalidation triggers; the list owns periodic refresh.
    refetchInterval: false,
    retry: false,
  });
}

export function useCanvasCIDetail(repo: string | undefined, id: number | null, resolvedRepo?: string) {
  const client = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const query = useQuery({
    ...ciDetailQuery(repo, id ?? 0, resolvedRepo),
    // Capture the clock per render so the deadline changes enabled from false to true.
    enabled: entry => id !== null && !(entry.state.error instanceof CIReadDeferredError
      && Math.max(now, entry.state.errorUpdatedAt) < entry.state.error.retryAt),
  });
  useEffect(() => {
    if (id === null || !(query.error instanceof CIReadDeferredError)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, query.error.retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [id, query.error]);
  const refresh = useCallback(async () => {
    if (id === null) return;
    const options = ciDetailQuery(repo, id, resolvedRepo);
    try {
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      await client.invalidateQueries({ queryKey: options.queryKey, exact: true, refetchType: 'none' });
      await client.fetchQuery({ ...options, staleTime: 0 });
    } catch { /* Keep the last successful snapshot and expose Retry through the query error. */ }
  }, [client, id, repo, resolvedRepo]);
  return { ...query, refresh };
}
