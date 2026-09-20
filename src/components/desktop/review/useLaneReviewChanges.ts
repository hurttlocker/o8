'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { summarizeLaneReviewDiff } from '@/lib/review/lane-diff';
import type { WorkspaceChangesState } from '../o8-panel/workspace-rail/ChangesList';

interface LaneDiffResponse {
  ok?: boolean;
  note?: string;
  branch?: string | null;
  base?: string | null;
  diffBase?: { baseBranch?: string | null } | null;
  worktreePath?: string | null;
  diff?: string;
  error?: { code?: string; message?: string } | null;
}

/** Carries the route's error CODE alongside its message so the panel can tell
 *  an unrecoverable lane (#2144, `worktree_missing`) from a retryable failure. */
class LaneDiffError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = 'LaneDiffError';
  }
}

export function useLaneReviewChanges(laneId?: string | null): WorkspaceChangesState {
  const requestVersion = useRef(0);
  const [rawDiff, setRawDiff] = useState('');
  const [sourceRepoPath, setSourceRepoPath] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [destinationBranch, setDestinationBranch] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [sourceLaneId, setSourceLaneId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(() => Boolean(laneId));
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    if (!laneId) {
      setRawDiff('');
      setSourceRepoPath(null);
      setBranch(null);
      setDestinationBranch(null);
      setBase(null);
      setSourceLaneId(null);
      setError(null);
      setErrorCode(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setErrorCode(null);
    try {
      const response = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/diff?maxBytes=524288`, { cache: 'no-store' });
      const data = await response.json().catch(() => null) as LaneDiffResponse | null;
      if (version !== requestVersion.current) return;
      if (!response.ok || !data?.ok) {
        throw new LaneDiffError(
          data?.error?.message ?? data?.note ?? 'Failed to load review lane diff',
          data?.error?.code ?? null,
        );
      }
      setRawDiff(typeof data.diff === 'string' ? data.diff : '');
      setSourceRepoPath(typeof data.worktreePath === 'string' ? data.worktreePath : null);
      setBranch(typeof data.branch === 'string' ? data.branch : null);
      setDestinationBranch(typeof data.diffBase?.baseBranch === 'string' ? data.diffBase.baseBranch : null);
      setBase(typeof data.base === 'string' ? data.base : null);
      setSourceLaneId(laneId);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setRawDiff('');
      setSourceRepoPath(null);
      setBranch(null);
      setDestinationBranch(null);
      setBase(null);
      setSourceLaneId(laneId);
      setError(err instanceof Error ? err.message : 'Unable to load review lane diff');
      setErrorCode(err instanceof LaneDiffError ? err.code : null);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [laneId]);

  useEffect(() => {
    void refresh();
    if (!laneId) return undefined;

    const handler = () => { void refresh(); };
    window.addEventListener('o8:lifecycle-reconcile', handler);
    const fallbackId = window.setInterval(() => { void refresh(); }, 300_000);
    return () => {
      requestVersion.current += 1;
      window.removeEventListener('o8:lifecycle-reconcile', handler);
      window.clearInterval(fallbackId);
    };
  }, [laneId, refresh]);

  const isCurrentLane = sourceLaneId === laneId;
  const summary = useMemo(() => summarizeLaneReviewDiff(isCurrentLane ? rawDiff : ''), [isCurrentLane, rawDiff]);
  const currentBranch = sourceLaneId === laneId ? branch : null;
  const currentDestinationBranch = sourceLaneId === laneId ? destinationBranch : null;
  const currentBase = sourceLaneId === laneId ? base : null;
  const sourceLabel = currentBranch && currentDestinationBranch
    ? `${currentBranch} → ${currentDestinationBranch}`
    : currentBranch
      ? `${currentBranch} (diff vs ${currentBase ?? 'base'})`
      : currentBase
        ? `Branch diff vs ${currentBase}`
        : 'Branch diff vs base';
  const patchByPath = useMemo(() => {
    const patches = new Map<string, string>();
    for (const file of summary.files) patches.set(file.path, file.patch);
    return patches;
  }, [summary.files]);

  return {
    files: summary.files,
    loading: Boolean(laneId) && (loading || !isCurrentLane),
    error: isCurrentLane ? error : null,
    errorCode: isCurrentLane ? errorCode : null,
    totalAdditions: summary.additions,
    totalDeletions: summary.deletions,
    dirtyFileSet: new Set(summary.files.map((file) => file.path)),
    branch: currentBranch,
    repoSlug: null,
    repoPath: isCurrentLane ? sourceRepoPath : null,
    source: laneId ? 'lane' : 'local',
    sourceLabel,
    patchByPath,
    refresh,
  };
}
