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

export function useBranchPr(repo: string | null, branch: string | null): BranchPrRef | null {
  const [pr, setPr] = useState<BranchPrRef | null>(null);
  useEffect(() => {
    if (!repo || !branch || branch === 'main' || branch === 'master') {
      setPr(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`/api/panel/prs?repo=${encodeURIComponent(repo)}`);
        if (!res.ok) { if (active) setPr(null); return; }
        const data = await res.json() as { prs?: PrListItem[]; repo?: string };
        const match = (data.prs ?? []).find(
          (p) => p.headRefName === branch && (p.state ?? '').toLowerCase() === 'open',
        );
        if (active) setPr(match ? { number: match.number, repoSlug: data.repo ?? null } : null);
      } catch {
        if (active) setPr(null);
      }
    })();
    return () => { active = false; };
  }, [repo, branch]);
  return pr;
}
