'use client';

/**
 * useLeftPanelProjectFocus — single source of truth for the left-panel
 * detailed view, which is now PROJECT-scoped (not repo-scoped).
 *
 * Two activation paths:
 *   - focusByProjectId(projectId)  → opens the panel project-wide,
 *     no specific repo selected.
 *   - focusByRepoId(repoId)        → resolves the repo's containing
 *     project, opens the panel scoped to that repo inside that project.
 *
 * In-panel scope toggling is handled by setSelectedRepoPath(path|null),
 * which never closes the panel — clicking another repo or the project
 * header just changes the inner scope. clearFocus() is the only way out.
 *
 * Persisted to two localStorage keys so a relaunch lands the operator
 * back on the same project + repo:
 *   o8:left-panel:focused-project
 *   o8:left-panel:focused-repo
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { ProjectRecord, ProjectsLedger } from '../repo-registry/useProjects';
import { toRepoFocusRepo, type RepoFocusRepo } from './types';
import { normalizeRepoPath } from './utils';

const PROJECT_STORAGE_KEY = 'o8:left-panel:focused-project';
const REPO_STORAGE_KEY = 'o8:left-panel:focused-repo';

function readStored(key: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return (window.localStorage.getItem(key) ?? '').trim();
  } catch {
    return '';
  }
}

function writeStored(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Persistence is best-effort.
  }
}

export interface FocusedProjectView {
  /** The active project record. */
  project: ProjectRecord;
  /** All repos that belong to this project (resolved against the registry). */
  repos: RepoFocusRepo[];
  /**
   * The currently-focused repo within the project, or null when the panel
   * is in project-wide mode. Always one of `repos` when non-null.
   */
  selectedRepo: RepoFocusRepo | null;
}

export interface LeftPanelProjectFocusState {
  /** True whenever the panel should render (a project is focused). */
  active: boolean;
  /** Resolved focus payload — null when no project is loaded yet. */
  view: FocusedProjectView | null;
  focusByProjectId: (projectId: string) => void;
  focusByRepoId: (repoIdOrPath: string) => void;
  setSelectedRepoPath: (repoPath: string | null) => void;
  clearFocus: () => void;
}

interface Args {
  registeredRepos: RepoRegistryEntry[];
  ledger: ProjectsLedger | null;
}

export function useLeftPanelProjectFocus({ registeredRepos, ledger }: Args): LeftPanelProjectFocusState {
  const [projectId, setProjectId] = useState<string>(() => readStored(PROJECT_STORAGE_KEY));
  const [repoPath, setRepoPath] = useState<string>(() => readStored(REPO_STORAGE_KEY));

  // Resolve the focused project + its repos against the live registry.
  const view = useMemo<FocusedProjectView | null>(() => {
    if (!projectId || !ledger) return null;
    const project = ledger.projects.find((p) => p.id === projectId);
    if (!project) return null;
    const repos: RepoFocusRepo[] = project.repoPaths.flatMap((path) => {
      const normalized = normalizeRepoPath(path);
      const entry = registeredRepos.find(
        (r) => normalizeRepoPath(r.localPath) === normalized || r.id === path,
      );
      return entry ? [toRepoFocusRepo(entry)] : [];
    });
    const normalizedRepoPath = normalizeRepoPath(repoPath);
    const selectedRepo = normalizedRepoPath
      ? repos.find((r) => normalizeRepoPath(r.localPath) === normalizedRepoPath) ?? null
      : null;
    return { project, repos, selectedRepo };
  }, [projectId, ledger, registeredRepos, repoPath]);

  // Auto-evict a stale focus when its project no longer exists in the
  // ledger (e.g. operator deleted it from another window). Don't clobber
  // a fresh project that's still loading — only reset when the ledger
  // resolved AND the project isn't there.
  useEffect(() => {
    if (!ledger || !projectId) return;
    if (!ledger.projects.some((p) => p.id === projectId)) {
      const timeout = window.setTimeout(() => {
        setProjectId('');
        setRepoPath('');
        writeStored(PROJECT_STORAGE_KEY, '');
        writeStored(REPO_STORAGE_KEY, '');
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    return undefined;
  }, [ledger, projectId]);

  // If the focused repo dropped out of its project, fall back to project-
  // wide rather than show stale chrome.
  useEffect(() => {
    if (!view) return;
    if (repoPath && !view.selectedRepo) {
      const timeout = window.setTimeout(() => {
        setRepoPath('');
        writeStored(REPO_STORAGE_KEY, '');
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    return undefined;
  }, [repoPath, view]);

  const focusByProjectId = useCallback((nextProjectId: string) => {
    setProjectId(nextProjectId);
    setRepoPath('');
    writeStored(PROJECT_STORAGE_KEY, nextProjectId);
    writeStored(REPO_STORAGE_KEY, '');
  }, []);

  const focusByRepoId = useCallback((repoIdOrPath: string) => {
    const repo = registeredRepos.find(
      (entry) => entry.id === repoIdOrPath || entry.localPath === repoIdOrPath,
    );
    const targetPath = normalizeRepoPath(repo?.localPath ?? repoIdOrPath);
    if (!targetPath) return;
    const owningProject = ledger?.projects.find((p) =>
      p.repoPaths.some((path) => normalizeRepoPath(path) === targetPath),
    );
    const nextProjectId = owningProject?.id ?? ledger?.activeProjectId ?? '';
    if (!nextProjectId) return;
    setProjectId(nextProjectId);
    setRepoPath(targetPath);
    writeStored(PROJECT_STORAGE_KEY, nextProjectId);
    writeStored(REPO_STORAGE_KEY, targetPath);
  }, [ledger, registeredRepos]);

  const setSelectedRepoPath = useCallback((nextPath: string | null) => {
    const normalized = nextPath ? normalizeRepoPath(nextPath) : '';
    setRepoPath(normalized);
    writeStored(REPO_STORAGE_KEY, normalized);
  }, []);

  const clearFocus = useCallback(() => {
    setProjectId('');
    setRepoPath('');
    writeStored(PROJECT_STORAGE_KEY, '');
    writeStored(REPO_STORAGE_KEY, '');
  }, []);

  return {
    active: Boolean(view),
    view,
    focusByProjectId,
    focusByRepoId,
    setSelectedRepoPath,
    clearFocus,
  };
}
