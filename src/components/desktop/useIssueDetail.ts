import { useQuery } from '@tanstack/react-query';
import { issueListQuery } from '@/lib/github-client/queries';

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

export function useIssueDetail(repo: string | undefined, issueNumber: number) {
  const slug = repo?.trim() || null;
  return useQuery<IssueDetail>({
    ...issueListQuery(''),
    // Keep the enriched viewer response apart from list and default-repo reads.
    queryKey: ['gh', slug?.toLowerCase() ?? null, 'issue-viewer', issueNumber],
    queryFn: async ({ signal }) => {
      const repoParam = slug ? `?repo=${encodeURIComponent(slug)}` : '';
      const response = await fetch(`/api/panel/issues/${issueNumber}${repoParam}`, { signal });
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
}
