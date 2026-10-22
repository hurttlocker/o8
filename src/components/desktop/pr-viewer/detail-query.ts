import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { GITHUB_LIST_FRESH_MS } from '@/lib/github-client';
import { normalizePRDetail } from './shared';
import type { PRDetail } from './types';

export function prViewerDetailQuery(repo: string | undefined, number: number) {
  const slug = repo?.trim() || null;
  return queryOptions({
    // Viewer snapshots include normalized comments/files; keep their shape
    // separate from the compact PR panel's existing snapshot cache.
    queryKey: ['gh', slug?.toLowerCase() ?? null, 'pr-viewer', number],
    queryFn: async ({ signal }): Promise<PRDetail> => {
      const repoParam = slug ? `?repo=${encodeURIComponent(slug)}` : '';
      const response = await fetch(`/api/panel/prs/${number}${repoParam}`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { pr: PRDetail };
      return normalizePRDetail(data.pr);
    },
    staleTime: query => ['CLOSED', 'MERGED'].includes(query.state.data?.state?.toUpperCase() ?? '')
      ? Infinity : GITHUB_LIST_FRESH_MS,
    gcTime: 10 * 60_000,
    // This migration shares existing reads; the full viewer has no timer.
    refetchInterval: false,
  });
}

export async function refreshPrViewerDetail(client: QueryClient, repo: string | undefined, number: number) {
  const options = prViewerDetailQuery(repo, number);
  // A write/Retry must start a new read rather than join a pre-write request.
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  await client.invalidateQueries({ queryKey: options.queryKey, exact: true, refetchType: 'none' });
  return client.fetchQuery({ ...options, staleTime: 0 });
}
