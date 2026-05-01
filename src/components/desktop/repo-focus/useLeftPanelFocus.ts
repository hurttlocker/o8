'use client';

import { useCallback, useMemo, useState } from 'react';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { LeftPanelFocusState, RepoFocusRepo } from './types';
import { toRepoFocusRepo } from './types';
import { normalizeRepoPath } from './utils';

const STORAGE_KEY = 'cortex-ide:left-panel:focused-repo';

function readStoredPath(): string {
  if (typeof window === 'undefined') return '';
  try {
    return normalizeRepoPath(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return '';
  }
}

function writeStoredPath(repoPath: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (repoPath) window.localStorage.setItem(STORAGE_KEY, repoPath);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Persistence is best-effort; the view state still updates in memory.
  }
}

function fallbackRepo(repoPath: string): RepoFocusRepo {
  const name = repoPath.split('/').filter(Boolean).pop() ?? 'repository';
  return {
    id: repoPath,
    name,
    localPath: repoPath,
    remoteUrl: null,
    defaultBranch: 'main',
  };
}

export function useLeftPanelFocus(registeredRepos: RepoRegistryEntry[] = []): LeftPanelFocusState {
  const initialPath = readStoredPath;
  const [focusedRepoPath, setFocusedRepoPath] = useState<string>(initialPath);
  const [focusActive, setFocusActive] = useState<boolean>(() => Boolean(initialPath()));

  const focusedRepo = useMemo(() => {
    if (!focusActive || !focusedRepoPath) return null;
    const normalized = normalizeRepoPath(focusedRepoPath);
    const repo = registeredRepos.find((entry) => (
      normalizeRepoPath(entry.localPath) === normalized || entry.id === focusedRepoPath
    ));
    return repo ? toRepoFocusRepo(repo) : fallbackRepo(normalized);
  }, [focusActive, focusedRepoPath, registeredRepos]);

  const focusByRepoId = useCallback((repoId: string) => {
    const repo = registeredRepos.find((entry) => entry.id === repoId || entry.localPath === repoId);
    if (!repo) return;
    const nextPath = normalizeRepoPath(repo.localPath);
    setFocusedRepoPath(nextPath);
    setFocusActive(true);
    writeStoredPath(nextPath);
  }, [registeredRepos]);

  const clearFocus = useCallback(() => {
    setFocusActive(false);
    setFocusedRepoPath('');
    writeStoredPath('');
  }, []);

  return {
    focusActive,
    focusedRepoPath,
    focusedRepo,
    focusByRepoId,
    clearFocus,
  };
}
