'use client';

import { useEffect } from 'react';
import type { DiffCard } from './diff-card';
import type { SnapGeometry } from './canvas-persistence';

export const WORKTREE_DIFF_PREFIX = 'worktree:';
const WORKTREE_DIFF_MAX_BYTES = 131_072;
const worktreeDiffRequests = new Map<string, Promise<WorktreeDiffData | null>>();

export interface WorktreeDiffData {
  branch: string | null;
  stat: string;
  diff: string;
  truncated: boolean;
}

interface WorktreeDiffResponse {
  ok?: boolean;
  branch?: string | null;
  stat?: string;
  diff?: string;
  truncated?: boolean;
}

export function fetchWorktreeDiff(repoPath: string, fetchImpl: typeof fetch = fetch): Promise<WorktreeDiffData | null> {
  const existing = fetchImpl === fetch ? worktreeDiffRequests.get(repoPath) : null;
  if (existing) return existing;
  const request = (async () => {
    const query = `?workspace=${encodeURIComponent(repoPath)}&maxBytes=${WORKTREE_DIFF_MAX_BYTES}`;
    const response = await fetchImpl(`/api/panel/worktree-diff${query}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json() as WorktreeDiffResponse;
    if (!data?.ok) return null;
    return {
      branch: typeof data.branch === 'string' ? data.branch : null,
      stat: typeof data.stat === 'string' ? data.stat : '',
      diff: typeof data.diff === 'string' ? data.diff : '',
      truncated: Boolean(data.truncated),
    };
  })();
  if (fetchImpl === fetch) {
    worktreeDiffRequests.set(repoPath, request);
    const clear = () => { if (worktreeDiffRequests.get(repoPath) === request) worktreeDiffRequests.delete(repoPath); };
    void request.then(clear, clear);
  }
  return request;
}

export function worktreeDiffCardFromData({
  id,
  z,
  spot,
  saved,
  repoPath,
  data,
}: {
  id: number;
  z: number;
  spot: { x: number; y: number };
  saved?: SnapGeometry;
  repoPath: string;
  data: WorktreeDiffData;
}): DiffCard {
  const repoName = repoPath.split('/').filter(Boolean).pop() ?? repoPath;
  return {
    id,
    x: spot.x,
    y: spot.y,
    z,
    w: saved?.w ?? 560,
    h: saved?.h ?? 320,
    laneId: `${WORKTREE_DIFF_PREFIX}${repoPath}`,
    packetId: null,
    title: `Your changes — ${repoName}`,
    branch: data.branch,
    stat: data.stat,
    diff: data.diff,
    truncated: data.truncated,
  };
}

export function worktreeRepoPath(laneId: string): string | null {
  return laneId.startsWith(WORKTREE_DIFF_PREFIX) ? laneId.slice(WORKTREE_DIFF_PREFIX.length) : null;
}

export function findFileRepoPath(filePath: string, repoPaths: Array<string | null | undefined>): string | null {
  return [...new Set(repoPaths.filter((path): path is string => Boolean(path)))]
    .map((path) => path.replace(/\/+$/, ''))
    .filter((path) => filePath === path || filePath.startsWith(`${path}/`))
    .sort((left, right) => right.length - left.length)[0] ?? null;
}

export function dispatchWorktreeChanged(repoPath: string): void {
  window.dispatchEvent(new CustomEvent('o8:worktree-changed', { detail: { repoPath } }));
}

export function useWorktreeDiffRefresh({
  cardId,
  repoPath,
  onRefresh,
}: {
  cardId: number;
  repoPath: string | null;
  onRefresh: (cardId: number) => void | Promise<void>;
}): void {
  useEffect(() => {
    if (!repoPath) return;
    const refresh = () => { void onRefresh(cardId); };
    const onWorktreeChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ repoPath?: unknown }>).detail;
      if (detail?.repoPath === repoPath) refresh();
    };
    window.addEventListener('o8:worktree-changed', onWorktreeChanged);
    window.addEventListener('o8:lifecycle-reconcile', refresh);
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 60_000);
    return () => {
      window.removeEventListener('o8:worktree-changed', onWorktreeChanged);
      window.removeEventListener('o8:lifecycle-reconcile', refresh);
      window.clearInterval(intervalId);
    };
  }, [cardId, onRefresh, repoPath]);
}
