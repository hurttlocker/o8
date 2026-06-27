'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ReviewChangedFile } from '@/lib/fleet/types';
import type { WorkspaceChangesState } from '@/components/desktop/o8-panel/workspace-rail/ChangesList';

/**
 * #1293 — best-of-N compare diff. Unlike `useWorkspaceChanges` (which returns the
 * working-tree diff vs HEAD), this returns each candidate's OWN COMMITTED diff
 * (`git diff <base>...HEAD`) via the stateless `/api/orchestrator/comparison-diff`
 * endpoint. A candidate commits its work, so the working tree is clean (or holds
 * incidental WIP); the committed diff is the right thing to compare + pick. Shares
 * the `WorkspaceChangesState` shape so `ComparisonColumn` is a drop-in swap.
 */
export function useComparisonDiff(worktreePath?: string | null, base = 'main'): WorkspaceChangesState {
  const [files, setFiles] = useState<ReviewChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!worktreePath) {
      setFiles([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ worktree: worktreePath, base });
      const res = await fetch(`/api/orchestrator/comparison-diff?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load comparison diff');
      const data = (await res.json()) as { changedFiles?: ReviewChangedFile[] };
      setFiles(Array.isArray(data.changedFiles) ? data.changedFiles : []);
    } catch (err) {
      setFiles([]);
      setError(err instanceof Error ? err.message : 'Unable to load comparison diff');
    } finally {
      setLoading(false);
    }
  }, [worktreePath, base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalAdditions = useMemo(() => files.reduce((sum, file) => sum + (file.additions ?? 0), 0), [files]);
  const totalDeletions = useMemo(() => files.reduce((sum, file) => sum + (file.deletions ?? 0), 0), [files]);
  const dirtyFileSet = useMemo(() => new Set(files.map((file) => file.path)), [files]);

  return { files, loading, error, totalAdditions, totalDeletions, dirtyFileSet, branch: base, repoSlug: null, refresh };
}
