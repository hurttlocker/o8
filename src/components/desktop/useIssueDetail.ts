import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { issueListQuery } from '@/lib/github-client/queries';
import { githubQuotaDeadline } from '@/lib/github-client/quota-deadline';

export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string; color: string }[];
  author: string;
  createdAt: string;
  comments: number;
  url: string;
}

class IssueDetailDeferredError extends Error {
  constructor(readonly retryAt: number) { super('Unable to read issue'); }
}

export function useIssueDetail(repo: string | undefined, issueNumber: number) {
  const client = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const slug = repo?.trim() || null;
  const queryKey = ['gh', slug?.toLowerCase() ?? null, 'issue-viewer', issueNumber];
  const options = issueListQuery('');
  const inheritedRetry = client.defaultQueryOptions({ queryKey }).retry ?? (typeof window === 'undefined' ? 0 : 3);
  const query = useQuery<IssueDetail>({
    ...options,
    // Keep the enriched viewer response apart from list and default-repo reads.
    queryKey,
    enabled: entry => !(entry.state.error instanceof IssueDetailDeferredError
      && Math.max(now, entry.state.errorUpdatedAt) < entry.state.error.retryAt),
    // A refused refresh must recover even if the last successful detail is still fresh.
    staleTime: entry => entry.state.error instanceof IssueDetailDeferredError ? 0 : options.staleTime,
    retry: (failures, error) => !(error instanceof IssueDetailDeferredError) && (typeof inheritedRetry === 'function'
      ? inheritedRetry(failures, error) : inheritedRetry === true || (typeof inheritedRetry === 'number' && failures < inheritedRetry)),
    queryFn: async ({ signal }) => {
      const repoParam = slug ? `?repo=${encodeURIComponent(slug)}` : '';
      const response = await fetch(`/api/panel/issues/${issueNumber}${repoParam}`, { signal });
      const retryAt = githubQuotaDeadline(response);
      if (retryAt !== null) throw new IssueDetailDeferredError(retryAt);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const detail = data.issue ?? data;
      if (data.error || detail.number !== issueNumber || typeof detail.title !== 'string' || !Array.isArray(detail.labels)) {
        throw new Error('Unable to read issue');
      }
      return detail as IssueDetail;
    },
    // Share existing detail reads without adding an interval to the viewer.
    refetchInterval: false,
  });
  useEffect(() => {
    if (!(query.error instanceof IssueDetailDeferredError)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, query.error.retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [query.error]);
  return query;
}
