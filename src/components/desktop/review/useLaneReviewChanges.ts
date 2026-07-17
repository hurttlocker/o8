'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { summarizeLaneReviewDiff } from '@/lib/review/lane-diff';
import type { WorkspaceChangesState } from '../o8-panel/workspace-rail/ChangesList';

interface LaneDiffResponse {
  ok?: boolean;
  note?: string;
  branch?: string | null;
  base?: string | null;
  worktreePath?: string | null;
  diff?: string;
}

export function useLaneReviewChanges(laneId?: string | null): WorkspaceChangesState {
  const [rawDiff, setRawDiff] = useState('');
  const [sourceRepoPath, setSourceRepoPath] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(() => Boolean(laneId));
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!laneId) {
      setRawDiff('');
      setSourceRepoPath(null);
      setBranch(null);
      setBase(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/diff?maxBytes=524288`, { cache: 'no-store' });
      const data = await response.json().catch(() => null) as LaneDiffResponse | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.note ?? 'Failed to load review lane diff');
      }
      setRawDiff(typeof data.diff === 'string' ? data.diff : '');
      setSourceRepoPath(typeof data.worktreePath === 'string' ? data.worktreePath : null);
      setBranch(typeof data.branch === 'string' ? data.branch : null);
      setBase(typeof data.base === 'string' ? data.base : null);
    } catch (err) {
      setRawDiff('');
      setSourceRepoPath(null);
      setBranch(null);
      setBase(null);
      setError(err instanceof Error ? err.message : 'Unable to load review lane diff');
    } finally {
      setLoading(false);
    }
  }, [laneId]);

  useEffect(() => {
    void refresh();
    if (!laneId) return undefined;

    const handler = () => { void refresh(); };
    window.addEventListener('o8:lifecycle-reconcile', handler);
    const fallbackId = window.setInterval(() => { void refresh(); }, 300_000);
    return () => {
      window.removeEventListener('o8:lifecycle-reconcile', handler);
      window.clearInterval(fallbackId);
    };
  }, [laneId, refresh]);

  const summary = useMemo(() => summarizeLaneReviewDiff(rawDiff), [rawDiff]);
  const patchByPath = useMemo(() => {
    const patches = new Map<string, string>();
    for (const file of summary.files) patches.set(file.path, file.patch);
    return patches;
  }, [summary.files]);

  return {
    files: summary.files,
    loading,
    error,
    totalAdditions: summary.additions,
    totalDeletions: summary.deletions,
    dirtyFileSet: new Set(summary.files.map((file) => file.path)),
    branch,
    repoSlug: null,
    repoPath: sourceRepoPath,
    source: laneId ? 'lane' : 'local',
    sourceLabel: base ? `Branch diff vs ${base}` : 'Branch diff vs base',
    patchByPath,
    refresh,
  };
}
