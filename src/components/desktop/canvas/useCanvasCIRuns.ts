import { useQuery } from '@tanstack/react-query';
import { pullRequestListQuery } from '@/lib/github-client/queries';

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

export function useCanvasCIRuns(repo?: string) {
  const repoScope = repo?.trim().toLowerCase() || null;
  const query = useQuery<CIRunList>({
    ...pullRequestListQuery(''),
    // The omitted repository has a distinct entry for the route's default lookup.
    queryKey: ['gh', repoScope, 'ci'],
    queryFn: async ({ signal }) => {
      const repoParam = repoScope ? `?repo=${encodeURIComponent(repoScope)}` : '';
      const response = await fetch(`/api/panel/ci${repoParam}`, { signal });
      if (!response.ok) throw new Error('Unable to read CI runs');
      const data = await response.json();
      // This route also reports read failures with HTTP 200 and an empty array.
      if (data.error || !Array.isArray(data.runs)) throw new Error('Unable to read CI runs');
      return data as CIRunList;
    },
  });
  return { ...query, repoScope };
}
