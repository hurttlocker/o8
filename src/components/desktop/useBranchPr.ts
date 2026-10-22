'use client';

import { useRepoPullRequests } from '@/lib/github-client';

/**
 * Resolve the open PR for a branch from the GitHub mirror (Q ruling
 * 2026-07-11). Lets the workspace rail surface PR status inline without
 * opening the dedicated PRs tab. Reuses /api/panel/prs (the same list the
 * PrPanel reads); the caller pairs the returned number with usePrDetail for
 * the full card. `main`/`master` never have a PR pointing at them, so those
 * short-circuit to null.
 */
export interface BranchPrRef {
  number: number;
  repoSlug: string | null;
}

export function useBranchPr(
  repo: string | null,
  branch: string | null,
  repoPath: string | null = null,
): BranchPrRef | null {
  const enabled = Boolean(repo && branch && branch !== 'main' && branch !== 'master');
  const { data } = useRepoPullRequests(enabled ? repo : null, repoPath);
  if (!enabled) return null;
  const match = (Array.isArray(data?.prs) ? data.prs : []).find(
    (pr) => pr.headRefName === branch && (pr.state ?? '').toLowerCase() === 'open',
  );
  return match ? { number: match.number, repoSlug: data?.repo ?? null } : null;
}
