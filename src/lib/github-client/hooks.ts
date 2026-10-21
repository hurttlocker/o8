/**
 * React hooks over the shared GitHub list cache (#3460). Components read a
 * repository's pull requests or issues through these instead of calling
 * `fetch` on mount, so every surface shares one entry per repository.
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  issueListQuery,
  pullRequestListQuery,
  refreshGithubList,
  type GithubIssueList,
  type GithubPullRequestList,
} from './queries';

export function useRepoPullRequests(repo: string | null | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery<GithubPullRequestList>({
    ...pullRequestListQuery(repo ?? ''),
    enabled: Boolean(repo),
  });
  const refresh = useCallback(
    () => (repo ? refreshGithubList(queryClient, repo, 'prs') : Promise.resolve(undefined)),
    [queryClient, repo],
  );
  return { ...query, refresh };
}

export function useRepoIssues(repo: string | null | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery<GithubIssueList>({
    ...issueListQuery(repo ?? ''),
    enabled: Boolean(repo),
  });
  const refresh = useCallback(
    () => (repo ? refreshGithubList(queryClient, repo, 'issues') : Promise.resolve(undefined)),
    [queryClient, repo],
  );
  return { ...query, refresh };
}
