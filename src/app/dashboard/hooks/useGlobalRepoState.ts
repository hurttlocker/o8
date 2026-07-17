import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { requestConfirm, requestPrompt, toast } from '@/components/shared/ConfirmToastHost';
import type { NavSection } from '@/app/dashboard/types';
import { FOCUS_REPO_SETUP_EVENT, OPEN_REPO_WORKSPACE_EVENT } from '@/lib/desktop/events';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { fetchSWRJson, getSWR } from '@/lib/panel/fetch-cache';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type {
  RepoWorktreeSummary,
  WorkspaceScopeEntry,
} from '../types';
import {
  repoEntryToWorkspaceScope,
  repoSlugFromRemote,
} from '../utils';

interface UseGlobalRepoStateArgs {
  activeWorkspace: string | undefined;
  setActiveNavSection: Dispatch<SetStateAction<NavSection>>;
  setSidebarVisible: Dispatch<SetStateAction<boolean>>;
  sidebarVisible: boolean;
}

export function useGlobalRepoState({
  activeWorkspace,
  setActiveNavSection,
  setSidebarVisible,
  sidebarVisible,
}: UseGlobalRepoStateArgs) {
  // Global repo state (shared between TitleBar and AgentPanel)
  const [globalRepoId, setGlobalRepoId] = useState<string | null>(null);
  const [globalRepoBranch, setGlobalRepoBranch] = useState<string>('main');
  const [globalRepoEntries, setGlobalRepoEntries] = useState<RepoRegistryEntry[]>([]);
  const [allRepoWorktrees, setAllRepoWorktrees] = useState<Record<string, WorktreeInfo[]>>({});
  const globalRepoEntry = useMemo(
    () => globalRepoEntries.find((repo) => repo.id === globalRepoId) ?? null,
    [globalRepoEntries, globalRepoId],
  );
  const workspaceScopeEntries = useMemo<WorkspaceScopeEntry[]>(() => {
    const entries: WorkspaceScopeEntry[] = [];
    for (const repo of globalRepoEntries) {
      entries.push(repoEntryToWorkspaceScope(repo));
      for (const worktree of allRepoWorktrees[repo.localPath] ?? []) {
        entries.push({
          registryRepoId: repo.id,
          name: repo.name,
          localPath: worktree.path,
          branch: worktree.branch,
          readiness: null,
          remoteUrl: repo.remoteUrl ?? undefined,
          isWorktree: true,
          worktreeStatus: worktree.status,
        });
      }
    }
    return entries;
  }, [allRepoWorktrees, globalRepoEntries]);
  const orchestratorWorkspaceTargets = useMemo<OrchestratorWorkspaceTarget[]>(
    // Orchestrator packets dispatch against each repo's main checkout — never
    // against a worktree — so the picker only surfaces base-repo entries. Agent
    // worktrees (.claude/worktrees/*) and any branch-worktrees would otherwise
    // appear as duplicate "main" rows here.
    () => workspaceScopeEntries
      .filter((entry) => !entry.isWorktree)
      .map((entry) => ({
        id: entry.localPath,
        label: entry.name,
        repoName: entry.name,
        localPath: entry.localPath,
        branch: entry.branch ?? null,
        isWorktree: false,
        worktreeStatus: entry.worktreeStatus ?? null,
      })),
    [workspaceScopeEntries],
  );
  const workspaceTerminalPreferredRepo = useMemo(() => {
    const activeWorkspaceRepo = activeWorkspace
      ? globalRepoEntries.find((repo) => (
        activeWorkspace === repo.localPath
        || activeWorkspace.startsWith(`${repo.localPath}/`)
      )) ?? null
      : null;
    const source =
      (globalRepoEntry ? repoEntryToWorkspaceScope(globalRepoEntry) : null)
      ?? (activeWorkspace
        ? workspaceScopeEntries.find((entry) => entry.localPath === activeWorkspace)
          ?? (activeWorkspaceRepo ? repoEntryToWorkspaceScope(activeWorkspaceRepo) : null)
        : null)
      ?? (globalRepoEntries.length === 1 ? repoEntryToWorkspaceScope(globalRepoEntries[0]) : null);
    return source ? {
      name: source.name,
      localPath: source.localPath,
      branch: source.branch ?? source.readiness?.currentBranch ?? 'main',
      readiness: source.readiness ?? null,
      ...(source.remoteUrl ? { remoteUrl: source.remoteUrl } : {}),
      ...(source.registryRepoId ? { registryRepoId: source.registryRepoId } : {}),
      ...(source.isWorktree ? { isWorktree: true, worktreeStatus: source.worktreeStatus ?? null } : {}),
    } : null;
  }, [activeWorkspace, globalRepoEntries, globalRepoEntry, workspaceScopeEntries]);
  const globalRepo = useMemo(
    () => repoSlugFromRemote(globalRepoEntry?.remoteUrl),
    [globalRepoEntry],
  );
  const [selectedRepoWorktrees, setSelectedRepoWorktrees] = useState<RepoWorktreeSummary | null>(null);
  const [selectedRepoWorktreesLoading, setSelectedRepoWorktreesLoading] = useState(false);
  const [selectedRepoWorktreeRefreshNonce, setSelectedRepoWorktreeRefreshNonce] = useState(0);

  const refreshSelectedRepoWorktrees = useCallback(async () => {
    if (!globalRepoEntry?.localPath) {
      setSelectedRepoWorktrees(null);
      return;
    }
    setSelectedRepoWorktreesLoading(true);
    try {
      const response = await ipcFetch(`/api/worktrees?repo=${encodeURIComponent(globalRepoEntry.localPath)}`);
      const data = await response.json() as RepoWorktreeSummary & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load worktree summary.');
      }
      setSelectedRepoWorktrees(data);
    } catch {
      setSelectedRepoWorktrees(null);
    } finally {
      setSelectedRepoWorktreesLoading(false);
    }
  }, [globalRepoEntry?.localPath]);

  const loadRegisteredRepos = useCallback(async () => {
    const cacheKey = 'panel:repos';
    const cached = getSWR<{ repos?: RepoRegistryEntry[] }>(cacheKey);
    if (cached.data) setGlobalRepoEntries(cached.data.repos ?? []);
    const data = await fetchSWRJson<{ repos?: RepoRegistryEntry[] }>(cacheKey, '/api/panel/repos');
    const repos = data.repos ?? [];
    setGlobalRepoEntries(repos);
    return repos;
  }, []);

  // Fetch registered repos on mount — prefer saved repo, otherwise restore the first registered repo
  useEffect(() => {
    loadRegisteredRepos()
      .then((repos) => {
        const savedId = typeof window !== 'undefined' ? sessionStorage.getItem('cortex-global-repo-id') : null;
        if (savedId && repos.some((repo) => repo.id === savedId)) {
          setGlobalRepoId(savedId);
          return;
        }
        const fallbackRepo = repos[0] ?? null;
        if (!fallbackRepo) return;
        setGlobalRepoId(fallbackRepo.id);
        setGlobalRepoBranch(fallbackRepo.defaultBranch || 'main');
        if (typeof window !== 'undefined') {
          sessionStorage.setItem('cortex-global-repo-id', fallbackRepo.id);
        }
      })
      .catch(() => {
        setGlobalRepoEntries([]);
      });
  }, [loadRegisteredRepos]);

  // Refetch when a repo is added/removed anywhere (the add-repo dialog, etc.)
  // so the workspace targets show the new repo WITHOUT a manual reload —
  // operator-hit 2026-06-22: adding a repo didn't refresh the workspace.
  // loadRegisteredRepos refreshes globalRepoEntries → orchestratorWorkspaceTargets
  // re-derives.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => { void loadRegisteredRepos(); };
    window.addEventListener('o8:repos-changed', handler);
    return () => window.removeEventListener('o8:repos-changed', handler);
  }, [loadRegisteredRepos]);

  const handleSelectRegisteredRepo = useCallback(async (repoId: string | null) => {
    setGlobalRepoId(repoId);
    if (!repoId) {
      setGlobalRepoBranch('main');
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('cortex-global-repo-id');
      }
      return;
    }

    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoId);
    }

    const selected = globalRepoEntries.find((repo) => repo.id === repoId) ?? null;
    if (!selected) return;

    setGlobalRepoBranch(selected.defaultBranch || 'main');

    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repoId }),
    })
      .then(async (response) => {
        const data = await response.json() as { repo?: RepoRegistryEntry };
        if (data.repo) {
          setGlobalRepoEntries((current) => {
            const next = current.map((repo) => (repo.id === data.repo?.id ? data.repo : repo));
            return next;
          });
        }
      })
      .catch(() => null);
  }, [globalRepoEntries]);

  const handleRemoveRegisteredRepo = useCallback(async (repoId: string) => {
    const target = globalRepoEntries.find((repo) => repo.id === repoId);
    if (!target) return;

    const confirmed = await requestConfirm({
      title: `Remove ${target.name} from o8?`,
      message: 'This only removes it from the local repo list. It does not delete the folder on disk.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;

    const response = await fetch('/api/panel/repos', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: repoId }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) {
      throw new Error(data.error ?? 'Unable to remove repository.');
    }

    setGlobalRepoEntries((current) => current.filter((repo) => repo.id !== repoId));
    if (globalRepoId === repoId) {
      setGlobalRepoId(null);
      setGlobalRepoBranch('main');
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('cortex-global-repo-id');
      }
    }
  }, [globalRepoEntries, globalRepoId]);

  // Fetch branch when selected repo changes
  useEffect(() => {
    if (!globalRepoEntry?.localPath) return;
    const controller = new AbortController();
    fetch(`/api/panel/branches?path=${encodeURIComponent(globalRepoEntry.localPath)}`, { signal: controller.signal })
      .then(r => r.json())
      .then(bData => {
        const current = (bData.branches ?? []).find((b: { current: boolean; name: string }) => b.current);
        if (current?.name) setGlobalRepoBranch(current.name);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [globalRepoEntry?.localPath]);

  useEffect(() => {
    // Defer worktree refresh — not needed for initial shell paint
    const initTimer = setTimeout(() => { void refreshSelectedRepoWorktrees(); }, 1_500);
    if (!globalRepoEntry?.localPath) {
      return () => clearTimeout(initTimer);
    }
    // WS-driven: instant refresh on lifecycle events instead of 30s polling
    const handler = () => { void refreshSelectedRepoWorktrees(); };
    const wsEvents = ['o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = window.setInterval(handler, 300_000);
    return () => {
      clearTimeout(initTimer);
      for (const e of wsEvents) window.removeEventListener(e, handler);
      window.clearInterval(fallbackId);
    };
  }, [globalRepoEntry?.localPath, refreshSelectedRepoWorktrees, selectedRepoWorktreeRefreshNonce]);

  useEffect(() => {
    if (globalRepoEntries.length === 0) {
      setAllRepoWorktrees({});
      return;
    }
    let active = true;
    async function fetchAllRepoWorktrees() {
      const entries = await Promise.all(globalRepoEntries.map(async (repo) => {
        try {
          const response = await ipcFetch(`/api/worktrees?repo=${encodeURIComponent(repo.localPath)}`);
          const data = await response.json() as RepoWorktreeSummary & { error?: string };
          return [repo.localPath, Array.isArray(data.worktrees) ? data.worktrees : []] as const;
        } catch {
          return [repo.localPath, []] as const;
        }
      }));
      if (!active) return;
      setAllRepoWorktrees(Object.fromEntries(entries));
    }
    // Defer all-repo worktree scan — heavy operation, not needed for first paint
    const initTimer = setTimeout(() => { void fetchAllRepoWorktrees(); }, 4_000);
    // WS-driven: instant refresh on lifecycle events instead of 60s polling
    const handler = () => { void fetchAllRepoWorktrees(); };
    const wsEvents = ['o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = window.setInterval(handler, 300_000);
    return () => {
      active = false;
      clearTimeout(initTimer);
      for (const e of wsEvents) window.removeEventListener(e, handler);
      window.clearInterval(fallbackId);
    };
  }, [globalRepoEntries]);

  const handleOpenFolder = useCallback(async () => {
    let folderPath: string | null = null;

    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({ directory: true, title: 'Select project folder' });
      if (typeof result === 'string') folderPath = result;
    } catch {
      try {
        const response = await fetch('/api/panel/browse-folder', { method: 'POST' });
        const data = await response.json() as { path?: string | null };
        if (data.path) folderPath = data.path;
      } catch {
        folderPath = await requestPrompt({ title: 'Open folder', message: 'Enter the folder path to add as a repository.', placeholder: '/path/to/folder' });
      }
    }

    if (!folderPath) return;

    try {
      const response = await fetch('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', localPath: folderPath }),
      });
      const data = await response.json() as {
        error?: string;
        repo?: RepoRegistryEntry;
      };

      if (!response.ok || !data.repo) {
        throw new Error(data.error ?? 'Unable to add repository.');
      }

      const repos = await loadRegisteredRepos();
      const selected = repos.find((repo) => repo.id === data.repo?.id) ?? data.repo;
      setGlobalRepoId(selected.id);
      if (data.repo.defaultBranch) {
        setGlobalRepoBranch(data.repo.defaultBranch);
      }
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('cortex-global-repo-id', selected.id);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to open folder.');
    }
  }, [loadRegisteredRepos]);

  const focusRepoSetup = useCallback((repoEntry: RepoRegistryEntry) => {
    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }
    setSidebarVisible(true);
    setActiveNavSection('agents');

    const dispatch = () => {
      window.dispatchEvent(new CustomEvent(FOCUS_REPO_SETUP_EVENT, {
        detail: {
          repoId: repoEntry.id,
          repoPath: repoEntry.localPath,
        },
      }));
    };

    if (sidebarVisible) {
      dispatch();
      return;
    }

    window.setTimeout(dispatch, 120);
  }, [setActiveNavSection, setSidebarVisible, sidebarVisible]);

  const handleFocusCurrentRepoSetup = useCallback(() => {
    if (!globalRepoEntry) {
      throw new Error('Select a repository before opening its setup profile.');
    }
    focusRepoSetup(globalRepoEntry);
  }, [focusRepoSetup, globalRepoEntry]);

  const openRepoWorkspaceModal = useCallback((repoEntry: RepoRegistryEntry) => {
    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }
    setSidebarVisible(true);
    setActiveNavSection('agents');

    const dispatch = () => {
      window.dispatchEvent(new CustomEvent(OPEN_REPO_WORKSPACE_EVENT, {
        detail: {
          repoId: repoEntry.id,
          repoPath: repoEntry.localPath,
        },
      }));
    };

    if (sidebarVisible) {
      dispatch();
      return;
    }

    window.setTimeout(dispatch, 120);
  }, [setActiveNavSection, setSidebarVisible, sidebarVisible]);

  const handleOpenRepoInDesktop = useCallback(async (editor: 'finder' | 'terminal') => {
    if (!globalRepoEntry?.localPath) {
      throw new Error('Select a repository before opening it outside Cortex.');
    }

    const response = await fetch('/api/panel/open-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editor, repo: globalRepoEntry.localPath }),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Unable to open the repo in ${editor}.`);
    }
  }, [globalRepoEntry]);

  const staleSelectedRepoWorktrees = useMemo(
    () => (selectedRepoWorktrees?.worktrees ?? []).filter((worktree) => worktree.status === 'stale'),
    [selectedRepoWorktrees],
  );

  return {
    allRepoWorktrees,
    globalRepo,
    globalRepoBranch,
    globalRepoEntries,
    globalRepoEntry,
    globalRepoId,
    handleFocusCurrentRepoSetup,
    handleOpenFolder,
    handleOpenRepoInDesktop,
    handleRemoveRegisteredRepo,
    handleSelectRegisteredRepo,
    loadRegisteredRepos,
    openRepoWorkspaceModal,
    orchestratorWorkspaceTargets,
    focusRepoSetup,
    selectedRepoWorktrees,
    selectedRepoWorktreesLoading,
    setAllRepoWorktrees,
    setGlobalRepoBranch,
    setGlobalRepoEntries,
    setGlobalRepoId,
    setSelectedRepoWorktreeRefreshNonce,
    setSelectedRepoWorktrees,
    staleSelectedRepoWorktrees,
    workspaceScopeEntries,
    workspaceTerminalPreferredRepo,
  };
}
