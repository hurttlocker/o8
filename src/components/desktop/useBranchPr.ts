'use client';

import { useEffect, useState } from 'react';

/**
 * Resolve the open PR for a branch from the GitHub mirror (Q ruling
 * 2026-07-11). Lets the workspace rail surface PR status inline without
 * opening the dedicated PRs tab. Reuses /api/panel/prs (the same list the
 * PrPanel reads); the caller pairs the returned number with usePrDetail for
 * the full card. `main`/`master` never have a PR pointing at them, so those
 * short-circuit to null.
 */
interface PrListItem {
  number: number;
  headRefName: string;
  state: string;
}

export interface BranchPrRef {
  number: number;
  repoSlug: string | null;
}

export function useBranchPr(
  repo: string | null,
  branch: string | null,
  repoPath: string | null = null,
): BranchPrRef | null {
  const requestKey = !repo || !branch || branch === 'main' || branch === 'master'
    ? null
    : `${repo}\u0000${branch}\u0000${repoPath ?? ''}`;
  const [resolved, setResolved] = useState<{ requestKey: string; pr: BranchPrRef | null } | null>(null);
  useEffect(() => {
    if (!requestKey || !repo || !branch) return;
    let active = true;
    void (async () => {
      try {
        const params = new URLSearchParams({ repo });
        if (repoPath) params.set('repoPath', repoPath);
        const res = await fetch(`/api/panel/prs?${params.toString()}`);
        if (!res.ok) { if (active) setResolved({ requestKey, pr: null }); return; }
        const data = await res.json() as { prs?: PrListItem[]; repo?: string };
        const match = (data.prs ?? []).find(
          (p) => p.headRefName === branch && (p.state ?? '').toLowerCase() === 'open',
        );
        if (active) setResolved({ requestKey, pr: match ? { number: match.number, repoSlug: data.repo ?? null } : null });
      } catch {
        if (active) setResolved({ requestKey, pr: null });
      }
    })();
    return () => { active = false; };
  }, [branch, repo, repoPath, requestKey]);
  return resolved?.requestKey === requestKey ? resolved.pr : null;
}
