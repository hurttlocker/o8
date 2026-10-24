import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pullRequestListQuery } from './queries';
import { githubQuotaDeadline } from '@/lib/github-client/quota-deadline';

export interface CIRun {
  databaseId: number;
  displayTitle: string;
  event: string;
  headBranch: string;
  headSha?: string;
  status: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
  workflowName: string;
  url: string;
  pullRequests?: { number: number; url: string }[];
}

interface CIRunList {
  runs: CIRun[];
  repo: string;
}

class CIRunsDeferredError extends Error {
  constructor(readonly retryAt: number) { super('Unable to read CI runs'); }
}

/** Shared run-list observer; disabled hovers must not resolve the default repository. */
export function useRepoCIRuns(repo?: string, enabled = true) {
  const client = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const repoScope = repo?.trim().toLowerCase() || null;
  const queryKey = ['gh', repoScope, 'ci'];
  const inheritedRetry = client.defaultQueryOptions({ queryKey }).retry ?? (typeof window === 'undefined' ? 0 : 3);
  const query = useQuery<CIRunList>({
    ...pullRequestListQuery(''),
    // The omitted repository has a distinct entry for the route's default lookup.
    queryKey,
    enabled: entry => enabled && !(entry.state.error instanceof CIRunsDeferredError
      && Math.max(now, entry.state.errorUpdatedAt) < entry.state.error.retryAt),
    // Keep configured ordinary-error retries, but never retry a quota refusal immediately.
    retry: (failures, error) => !(error instanceof CIRunsDeferredError) && (typeof inheritedRetry === 'function'
      ? inheritedRetry(failures, error) : inheritedRetry === true || (typeof inheritedRetry === 'number' && failures < inheritedRetry)),
    queryFn: async ({ signal }) => {
      const repoParam = repoScope ? `?repo=${encodeURIComponent(repoScope)}` : '';
      const response = await fetch(`/api/panel/ci${repoParam}`, { signal });
      const retryAt = githubQuotaDeadline(response);
      if (retryAt !== null) throw new CIRunsDeferredError(retryAt);
      if (!response.ok) throw new Error('Unable to read CI runs');
      const data = await response.json();
      // This route also reports read failures with HTTP 200 and an empty array.
      if (data.error || !Array.isArray(data.runs)) throw new Error('Unable to read CI runs');
      return data as CIRunList;
    },
  });
  useEffect(() => {
    if (!enabled || !(query.error instanceof CIRunsDeferredError)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, query.error.retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [enabled, query.error]);
  return { ...query, repoScope };
}
