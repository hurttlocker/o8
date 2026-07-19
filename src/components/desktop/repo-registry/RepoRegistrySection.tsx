'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { openExternalUrl } from '@/lib/desktop/open-external';
import {
  FOCUS_REPO_SETUP_EVENT,
  OPEN_REPO_WORKSPACE_EVENT,
  buildBranchAgentMapFromIdeSessions,
  defaultWorkspaceName,
  getWorkspaceBranchPreview,
  githubUrlFromRemote,
  requestJson,
  sortRepoEntries,
  type BranchAgent,
  type FocusRepoSetupDetail,
  type IdeWorkspaceSession,
  type OpenRepoWorkspaceDetail,
  type OrchestratorPacket,
  type RepoRegistryEntry,
  type RepoSetupConfig,
  type ValidatedRepoCandidate,
  type WorkspaceAgentLaunchRequest,
  type WorkspaceCreateResult,
} from './shared';
import { RepoRegistryList } from './RepoRegistryList';
import { RepoRegistryModals } from './RepoRegistryModals';
import { pickRepoFolder } from './pickRepoFolder';

function RepoRegistrySectionBase({
  onSelectSession,
  onSelectRepo,
  onSelectPR,
  onReviewPR,
  onRepoRemoved,
  onLaunchComplete,
  onLaunchWorkspaceAgent,
  onRegistryStateChange,
  activeSessionKey = null,
  activeRepoLocalPath = null,
  activeWorkspacePath = null,
  activeWorkspaceTabKind = null,
  onFocusOrchestratorTab,
  onFocusAssistantTab,
  sectionOpen,
  onSectionOpenChange,
  launchIntent,
  workspaceIntent,
  addIntent,
  orchestratorPackets = [],
  ideWorkspaceSessions,
  hideHeader = false,
  repoPathFilter = null,
  projectsForMove,
  currentProjectId = null,
  onMoveRepoToProject,
  activeProjectName,
}: {
  onSelectSession?: (sessionKey: string) => void;
  onSelectRepo?: (repoId: string) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onRepoRemoved?: (repo: RepoRegistryEntry) => void;
  onLaunchComplete?: () => void;
  onLaunchWorkspaceAgent?: (request: WorkspaceAgentLaunchRequest) => Promise<void>;
  onRegistryStateChange?: (state: { loading: boolean; count: number; hasError: boolean }) => void;
  activeSessionKey?: string | null;
  activeRepoLocalPath?: string | null;
  activeWorkspacePath?: string | null;
  activeWorkspaceTabKind?: 'terminal' | 'chat' | 'llm-chat' | 'canvas' | 'orchestrator' | null;
  onFocusOrchestratorTab?: () => void;
  onFocusAssistantTab?: () => void;
  sectionOpen?: boolean;
  onSectionOpenChange?: (open: boolean) => void;
  launchIntent?: { repoPath: string | null; nonce: number } | null;
  workspaceIntent?: { repoPath: string | null; nonce: number } | null;
  addIntent?: { nonce: number } | null;
  orchestratorPackets?: OrchestratorPacket[];
  ideWorkspaceSessions?: IdeWorkspaceSession[];
  hideHeader?: boolean;
  /** When provided, only repos whose localPath is in this set are shown.
   *  Used by the projects bottom-bar to scope the panel to one project. */
  repoPathFilter?: Set<string> | null;
  projectsForMove?: Array<{ id: string; name: string; color?: string; repoPaths?: string[] }>;
  currentProjectId?: string | null;
  onMoveRepoToProject?: (repoLocalPath: string, targetProjectId: string) => void | Promise<void>;
  activeProjectName?: string | null;
} = {}) {
  const [repos, setRepos] = useState<RepoRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reposOpenInternal, setReposOpenInternal] = useState(true);
  const reposOpen = sectionOpen ?? reposOpenInternal;
  const setReposOpen = useCallback((next: boolean) => {
    if (onSectionOpenChange) onSectionOpenChange(next);
    else setReposOpenInternal(next);
  }, [onSectionOpenChange]);
  const [expandedRepoIds, setExpandedRepoIds] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const stored = sessionStorage.getItem('cortex-repo-expanded-ids');
      if (stored) return new Set(JSON.parse(stored) as string[]);
      // Migrate from old single-id key
      const old = sessionStorage.getItem('cortex-repo-expanded-id');
      return old ? new Set([old]) : new Set();
    } catch {
      return new Set();
    }
  });

  const [addOpen, setAddOpen] = useState(false);
  const [repoPathInput, setRepoPathInput] = useState('');
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<ValidatedRepoCandidate | null>(null);
  const [adding, setAdding] = useState(false);

  const [workspaceRepo, setWorkspaceRepo] = useState<RepoRegistryEntry | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceBaseBranch, setWorkspaceBaseBranch] = useState('');
  const [workspaceUseSetup, setWorkspaceUseSetup] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceResult, setWorkspaceResult] = useState<WorkspaceCreateResult | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<Record<string, WorkspaceCreateResult>>({});

  const [launchRepo, setLaunchRepo] = useState<RepoRegistryEntry | null>(null);
  const [launchRuntime, setLaunchRuntime] = useState<OrchestratorRuntime>(() => {
    if (typeof window === 'undefined') return 'codex';
    try {
      const saved = window.localStorage.getItem('cortex-workspace-launch-runtime');
      if (saved === 'codex' || saved === 'claude-code' || saved === 'gemini' || saved === 'opencode') {
        return saved;
      }
      return 'codex';
    } catch {
      return 'codex';
    }
  });
  const [launchTaskName, setLaunchTaskName] = useState('');
  const [launchPrompt, setLaunchPrompt] = useState('');
  const [launchLoading, setLaunchLoading] = useState(false);

  useEffect(() => {
    const handleFocusRepoSetup = (event: Event) => {
      const detail = (event as CustomEvent<FocusRepoSetupDetail>).detail;
      if (!detail) return;
      const targetRepo = repos.find((repo) => repo.id === detail.repoId || repo.localPath === detail.repoPath);
      if (!targetRepo) return;
      setReposOpen(true);
      setExpandedRepoIds((prev) => new Set([...prev, targetRepo.id]));
      try {
        sessionStorage.setItem('cortex-repo-expanded-ids', JSON.stringify([...expandedRepoIds, targetRepo.id]));
      } catch {
        // Ignore session storage failures and still reveal the repo.
      }
    };

    window.addEventListener(FOCUS_REPO_SETUP_EVENT, handleFocusRepoSetup as EventListener);
    return () => {
      window.removeEventListener(FOCUS_REPO_SETUP_EVENT, handleFocusRepoSetup as EventListener);
    };
  }, [repos, setReposOpen]);

  const [launchError, setLaunchError] = useState<string | null>(null);

  const [removeTarget, setRemoveTarget] = useState<RepoRegistryEntry | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const handledLaunchIntentNonceRef = useRef<number | null>(null);
  const handledWorkspaceIntentNonceRef = useRef<number | null>(null);
  const handledAddIntentNonceRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      if (expandedRepoIds.size > 0) sessionStorage.setItem('cortex-repo-expanded-ids', JSON.stringify([...expandedRepoIds]));
      else sessionStorage.removeItem('cortex-repo-expanded-ids');
    } catch { /* ignore */ }
  }, [expandedRepoIds]);

  useEffect(() => {
    try {
      window.localStorage.setItem('cortex-workspace-launch-runtime', launchRuntime);
    } catch {
      // ignore local preference persistence failures
    }
  }, [launchRuntime]);

  const loadRepos = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await requestJson<{ repos: RepoRegistryEntry[] }>('/api/panel/repos');
      setRepos(sortRepoEntries(data.repos ?? []));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load repositories.');
    } finally {
      setLoading(false);
    }
  }, []);

  const touchRepo = useCallback(async (repo: RepoRegistryEntry) => {
    const touched = await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repo.id }),
    });

    setRepos((current) => sortRepoEntries(
      current.map((entry) => (entry.id === repo.id ? touched.repo : entry)),
    ));
  }, []);

  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  useEffect(() => {
    onRegistryStateChange?.({
      loading,
      count: repos.length,
      hasError: Boolean(loadError),
    });
  }, [loadError, loading, onRegistryStateChange, repos.length]);

  // ── Agent ↔ Branch association (#168) ──
  const [agentBranchMap, setAgentBranchMap] = useState<Map<string, Map<string, BranchAgent[]>>>(new Map());
  const [agentBranchMapLoaded, setAgentBranchMapLoaded] = useState(false);
  const ideAgentBranchMap = useMemo(
    () => buildBranchAgentMapFromIdeSessions(ideWorkspaceSessions ?? []),
    [ideWorkspaceSessions],
  );
  // Tile-local IDE sessions can lag lane archival; once the workspace API has
  // loaded, prefer its repo/branch map because it already strips ghost lanes.
  const effectiveAgentBranchMap = useMemo(() => {
    if (!ideWorkspaceSessions) return agentBranchMap;
    return agentBranchMapLoaded ? agentBranchMap : ideAgentBranchMap;
  }, [agentBranchMap, agentBranchMapLoaded, ideAgentBranchMap, ideWorkspaceSessions]);

  useEffect(() => {
    function fetchAgentBranches() {
      fetch('/api/panel/workspaces')
        .then(r => r.json())
        .then((data: { workspaces?: Array<{
          repo: string;
          branch: string;
          agentName: string;
          sessionKey: string;
          runtime?: string;
          agentStatus: string;
          currentTask?: string | null;
          localDiff?: { additions: number; deletions: number; changedFiles: number };
          pr?: { additions: number; deletions: number; changedFiles: number } | null;
        }> }) => {
          const map = new Map<string, Map<string, BranchAgent[]>>();
          const AGENT_COLORS: Record<string, string> = {
            'Assistant': '#111827',
            'Niot': '#2563eb',
            'Hawk': '#f59e0b',
          };
          for (const ws of data.workspaces ?? []) {
            if (!ws.branch || ws.branch.startsWith('surface/')) continue;
            const repoKey = ws.repo;
            if (!map.has(repoKey)) map.set(repoKey, new Map());
            const branchMap = map.get(repoKey)!;
            if (!branchMap.has(ws.branch)) branchMap.set(ws.branch, []);
            // Derive agent display name
            const agentName = ws.agentName.split(' ')[0] || ws.agentName;
            const isCodex = agentName.toLowerCase().includes('codex');
            const isClaude = agentName.toLowerCase().includes('claude');
            const displayName = isCodex ? 'Codex' : isClaude ? 'Claude Code' : agentName;
            const color = AGENT_COLORS[displayName] ?? (isCodex ? '#10b981' : isClaude ? '#8b5cf6' : '#6b7280');
            const diffSource = ws.pr ?? ws.localDiff ?? null;
            // Deduplicate by session key
            const existing = branchMap.get(ws.branch)!;
            if (!existing.some(a => a.sessionKey === ws.sessionKey)) {
              existing.push({
                name: displayName,
                agentName: ws.agentName,
                sessionKey: ws.sessionKey,
                color,
                runtime: ws.runtime ?? (isClaude ? 'claude-code' : 'codex'),
                status: ws.agentStatus,
                currentTask: ws.currentTask ?? null,
                additions: diffSource?.additions,
                deletions: diffSource?.deletions,
                changedFiles: diffSource?.changedFiles,
              });
            }
          }
          setAgentBranchMap(map);
          setAgentBranchMapLoaded(true);
        })
        .catch(() => {});
    }
    fetchAgentBranches();
    // WS-driven: instant refresh on agent events instead of 30s polling
    const handler = () => { fetchAgentBranches(); };
    const wsEvents = ['o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchAgentBranches, 300_000);
    return () => {
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, [ideWorkspaceSessions]);

  // ── Port data for running indicators (#170) ──
  const [portsByRepo, setPortsByRepo] = useState<Map<string, number[]>>(new Map());

  useEffect(() => {
    function fetchPorts() {
      fetch('/api/panel/ports')
        .then(r => r.json())
        .then((data: { groups?: { repo: string; ports: number[] }[] }) => {
          const map = new Map<string, number[]>();
          for (const g of data.groups ?? []) {
            map.set(g.repo, g.ports);
          }
          setPortsByRepo(map);
        })
        .catch(() => {});
    }
    fetchPorts();
    // WS-driven: refresh on agent events instead of 10s polling
    const handler = () => { fetchPorts(); };
    const wsEvents = ['o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchPorts, 120_000); // 2min fallback
    return () => {
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, []);

  const resetAddModal = useCallback(() => {
    setAddOpen(false);
    setRepoPathInput('');
    setValidationError(null);
    setValidationResult(null);
    setValidating(false);
    setAdding(false);
  }, []);

  const validateRepoPath = useCallback(async (localPath: string) => {
    setValidating(true);
    setValidationError(null);
    setValidationResult(null);

    try {
      const data = await requestJson<{ repo: ValidatedRepoCandidate }>('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'validate', localPath }),
      });
      setValidationResult(data.repo);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Validation failed.');
    } finally {
      setValidating(false);
    }
  }, []);

  const handleBrowseForRepo = useCallback(async () => {
    setAddOpen(true);
    setValidationError(null);
    setValidationResult(null);
    setValidating(false);
    setAdding(false);
    const folderPath = await pickRepoFolder('Select project folder', 'Enter the folder path to add as a repository.');
    if (!folderPath) return;
    setRepoPathInput(folderPath);
    await validateRepoPath(folderPath);
  }, [validateRepoPath]);

  const handleAddRepo = useCallback(async () => {
    const localPath = repoPathInput.trim();
    if (!localPath) {
      setValidationError('Enter a local folder path.');
      return;
    }

    setAdding(true);
    setValidationError(null);

    try {
      await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', localPath }),
      });
      await loadRepos();
      resetAddModal();
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Unable to add repository.');
    } finally {
      setAdding(false);
    }
  }, [loadRepos, repoPathInput, resetAddModal]);

  const handleSaveSetup = useCallback(async (repoId: string, setup: RepoSetupConfig) => {
    const data = await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', id: repoId, setup }),
    });

    setRepos((current) => sortRepoEntries(
      current.map((repo) => (repo.id === repoId ? data.repo : repo)),
    ));
  }, []);

  const handleOpenGitHub = useCallback((repo: RepoRegistryEntry) => {
    const githubUrl = githubUrlFromRemote(repo.remoteUrl);
    if (!githubUrl) return;

    void requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repo.id }),
    }).then((data) => {
      setRepos((current) => sortRepoEntries(
        current.map((entry) => (entry.id === repo.id ? data.repo : entry)),
      ));
    }).catch(() => null);

    openExternalUrl(githubUrl);
  }, []);

  const openLaunchModal = useCallback((repo: RepoRegistryEntry) => {
    setLaunchRepo(repo);
    setLaunchTaskName('');
    setLaunchPrompt('');
    setLaunchError(null);
  }, []);

  const closeLaunchModal = useCallback(() => {
    setLaunchRepo(null);
    setLaunchTaskName('');
    setLaunchPrompt('');
    setLaunchLoading(false);
    setLaunchError(null);
  }, []);

  const launchIntoWorkspace = useCallback(async (
    repo: RepoRegistryEntry,
    options?: {
      runtime?: OrchestratorRuntime;
      label?: string;
      initialText?: string;
      autoSend?: boolean;
    },
  ) => {
    if (!onLaunchWorkspaceAgent) {
      openLaunchModal(repo);
      return;
    }

    await onLaunchWorkspaceAgent({
      repoPath: repo.localPath,
      runtime: options?.runtime,
      label: options?.label,
      initialText: options?.initialText,
      autoSend: options?.autoSend,
      createNew: true,
    });

    try {
      await touchRepo(repo);
    } catch {
      // Repo recency is best-effort; do not fail the launch if touch misses.
    }
    onLaunchComplete?.();
  }, [onLaunchComplete, onLaunchWorkspaceAgent, openLaunchModal, touchRepo]);

  const handleLaunchAgent = useCallback(async () => {
    if (!launchRepo) return;

    setLaunchLoading(true);
    setLaunchError(null);

    try {
      await launchIntoWorkspace(launchRepo, {
        runtime: launchRuntime,
        label: launchTaskName.trim() || undefined,
        initialText: launchPrompt.trim() || undefined,
        autoSend: launchPrompt.trim().length > 0,
      });
      closeLaunchModal();
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : 'Unable to launch agent.');
    } finally {
      setLaunchLoading(false);
    }
  }, [
    launchPrompt,
    launchRepo,
    launchRuntime,
    launchTaskName,
    closeLaunchModal,
    launchIntoWorkspace,
  ]);

  const openWorkspaceModal = useCallback((repo: RepoRegistryEntry) => {
    setWorkspaceRepo(repo);
    setWorkspaceName(defaultWorkspaceName(repo.name));
    setWorkspaceBaseBranch(repo.defaultBranch);
    setWorkspaceUseSetup(repo.setup.installOnCreateWorkspace);
    setWorkspaceError(null);
    setWorkspaceResult(null);
  }, []);

  const closeWorkspaceModal = useCallback(() => {
    setWorkspaceRepo(null);
    setWorkspaceName('');
    setWorkspaceBaseBranch('');
    setWorkspaceUseSetup(true);
    setWorkspaceError(null);
    setWorkspaceResult(null);
    setWorkspaceLoading(false);
  }, []);

  useEffect(() => {
    const handleOpenRepoWorkspace = (event: Event) => {
      const detail = (event as CustomEvent<OpenRepoWorkspaceDetail>).detail;
      if (!detail) return;
      const targetRepo = repos.find((repo) => repo.id === detail.repoId || repo.localPath === detail.repoPath);
      if (!targetRepo) return;
      setReposOpen(true);
      setExpandedRepoIds((prev) => new Set([...prev, targetRepo.id]));
      openWorkspaceModal(targetRepo);
      try {
        sessionStorage.setItem('cortex-repo-expanded-ids', JSON.stringify([...expandedRepoIds, targetRepo.id]));
      } catch {
        // Ignore session storage failures and still reveal the repo.
      }
    };

    window.addEventListener(OPEN_REPO_WORKSPACE_EVENT, handleOpenRepoWorkspace as EventListener);
    return () => {
      window.removeEventListener(OPEN_REPO_WORKSPACE_EVENT, handleOpenRepoWorkspace as EventListener);
    };
  }, [openWorkspaceModal, repos, setReposOpen]);

  const handleCreateWorkspace = useCallback(async () => {
    if (!workspaceRepo) return;

    const taskName = workspaceName.trim();
    if (!taskName) {
      setWorkspaceError('Workspace name is required.');
      return;
    }

    setWorkspaceLoading(true);
    setWorkspaceError(null);

    try {
      const data = await requestJson<{ worktree: WorkspaceCreateResult }>('/api/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: workspaceRepo.localPath,
          agentType: 'workspace',
          taskName,
          baseBranch: workspaceBaseBranch.trim() || undefined,
          skipSetup: !workspaceUseSetup,
          envMode: workspaceRepo.setup.envMode,
          envFiles: workspaceRepo.setup.envFiles,
          isolationPreference: workspaceRepo.setup.workspaceIsolationPreference,
        }),
      });

      setWorkspaceResult(data.worktree);
      setWorkspaceNotice((current) => ({
        ...current,
        [workspaceRepo.id]: data.worktree,
      }));

      const touched = await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'touch', id: workspaceRepo.id }),
      });

      setRepos((current) => sortRepoEntries(
        current.map((repo) => (repo.id === workspaceRepo.id ? touched.repo : repo)),
      ));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Unable to create workspace.');
    } finally {
      setWorkspaceLoading(false);
    }
  }, [workspaceBaseBranch, workspaceName, workspaceRepo, workspaceUseSetup]);

  const handleRemoveRepo = useCallback(async () => {
    if (!removeTarget) return;

    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await requestJson<{ ok: boolean }>('/api/panel/repos', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: removeTarget.id }),
      });
      setRepos((current) => current.filter((repo) => repo.id !== removeTarget.id));
      setWorkspaceNotice((current) => {
        const next = { ...current };
        delete next[removeTarget.id];
        return next;
      });
      onRepoRemoved?.(removeTarget);
      setRemoveTarget(null);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'Unable to remove repository.');
    } finally {
      setRemoveBusy(false);
    }
  }, [onRepoRemoved, removeTarget]);

  const locateRepo = useCallback(async (repo: RepoRegistryEntry) => {
    const localPath = await pickRepoFolder('Locate moved repository folder', 'Enter the new folder path for this repository.');
    if (!localPath) return;
    setLoadError(null);
    try {
      const data = await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id: repo.id, localPath }),
      });
      setRepos((current) => sortRepoEntries(current.map((entry) => (entry.id === repo.id ? data.repo : entry))));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to locate repository folder.');
    }
  }, []);

  const activeRepoEntry = useMemo(
    () => repos.find((repo) => repo.localPath === activeRepoLocalPath) ?? null,
    [activeRepoLocalPath, repos],
  );

  const orderedRepos = useMemo(() => {
    const visible = repoPathFilter
      ? repos.filter((repo) => repoPathFilter.has(repo.localPath))
      : repos;
    if (!activeRepoEntry || !visible.includes(activeRepoEntry)) return visible;
    return [activeRepoEntry, ...visible.filter((repo) => repo.id !== activeRepoEntry.id)];
  }, [activeRepoEntry, repoPathFilter, repos]);

  // Cross-project repo list for the empty-state quick-pick. Walks each
  // non-active project's claimed paths, joins with the global registry to
  // resolve the human-readable repo name, and skips paths that aren't
  // actually registered (eg. removed from disk but still on the ledger).
  const reposInOtherProjects = useMemo(() => {
    if (!projectsForMove?.length) return [];
    const reposByPath = new Map(repos.map((entry) => [entry.localPath, entry]));
    const out: Array<{ repoName: string; repoLocalPath: string; projectName: string; projectColor?: string }> = [];
    for (const project of projectsForMove) {
      if (project.id === currentProjectId) continue;
      for (const path of project.repoPaths ?? []) {
        const repo = reposByPath.get(path);
        if (!repo) continue;
        out.push({
          repoName: repo.name,
          repoLocalPath: repo.localPath,
          projectName: project.name,
          projectColor: project.color,
        });
      }
    }
    return out;
  }, [currentProjectId, projectsForMove, repos]);

  useEffect(() => {
    if (!activeRepoEntry) return;
    setExpandedRepoIds((prev) => prev.size > 0 ? prev : new Set([activeRepoEntry.id]));
  }, [activeRepoEntry]);

  useEffect(() => {
    if (!launchIntent?.repoPath) return;
    if (handledLaunchIntentNonceRef.current === launchIntent.nonce) return;
    const match = repos.find((repo) => repo.localPath === launchIntent.repoPath);
    if (!match) return;
    handledLaunchIntentNonceRef.current = launchIntent.nonce;
    setReposOpen(true);
    setExpandedRepoIds((prev) => new Set([...prev, match.id]));
    openLaunchModal(match);
  }, [launchIntent?.nonce, launchIntent?.repoPath, openLaunchModal, repos, setReposOpen]);

  useEffect(() => {
    if (!workspaceIntent?.repoPath) return;
    if (handledWorkspaceIntentNonceRef.current === workspaceIntent.nonce) return;
    const match = repos.find((repo) => repo.localPath === workspaceIntent.repoPath);
    if (!match) return;
    handledWorkspaceIntentNonceRef.current = workspaceIntent.nonce;
    setReposOpen(true);
    setExpandedRepoIds((prev) => new Set([...prev, match.id]));
    openWorkspaceModal(match);
  }, [openWorkspaceModal, repos, setReposOpen, workspaceIntent?.nonce, workspaceIntent?.repoPath]);

  useEffect(() => {
    if (!addIntent?.nonce) return;
    if (handledAddIntentNonceRef.current === addIntent.nonce) return;
    handledAddIntentNonceRef.current = addIntent.nonce;
    setReposOpen(true);
    void handleBrowseForRepo();
  }, [addIntent?.nonce, handleBrowseForRepo, setReposOpen]);

  const branchPreview = useMemo(() => getWorkspaceBranchPreview(workspaceName), [workspaceName]);
  const showEmptyState = !loading && !loadError && repos.length === 0;

  return (
    <>
      <RepoRegistryList
        projectsForMove={projectsForMove}
        currentProjectId={currentProjectId}
        onMoveRepoToProject={onMoveRepoToProject}
        activeProjectName={activeProjectName}
        reposInOtherProjects={reposInOtherProjects}
        onAddRepoToActiveProject={() => setAddOpen(true)}
        totalReposInRegistry={repos.length}
        hideHeader={hideHeader}
        reposOpen={reposOpen}
        loading={loading}
        reposCount={repos.length}
        loadError={loadError}
        showEmptyState={showEmptyState}
        orderedRepos={orderedRepos}
        workspaceNotice={workspaceNotice}
        onToggleOpen={() => setReposOpen(!reposOpen)}
        launchIntoWorkspace={launchIntoWorkspace}
        openWorkspaceModal={openWorkspaceModal}
        handleOpenGitHub={handleOpenGitHub}
        locateRepo={locateRepo}
        setRemoveTarget={setRemoveTarget}
        handleSaveSetup={handleSaveSetup}
        onSelectSession={onSelectSession}
        onSelectPR={onSelectPR}
        onReviewPR={onReviewPR}
        activeSessionKey={activeSessionKey}
        effectiveAgentBranchMap={effectiveAgentBranchMap}
        orchestratorPackets={orchestratorPackets}
        portsByRepo={portsByRepo}
        expandedRepoIds={expandedRepoIds}
        setExpandedRepoIds={setExpandedRepoIds}
        activeRepoLocalPath={activeRepoLocalPath}
        activeWorkspacePath={activeWorkspacePath}
        activeWorkspaceTabKind={activeWorkspaceTabKind}
        onFocusOrchestratorTab={onFocusOrchestratorTab}
        onFocusAssistantTab={onFocusAssistantTab}
        onSelectRepo={onSelectRepo}
      />

      <RepoRegistryModals
        addOpen={addOpen}
        resetAddModal={resetAddModal}
        validating={validating}
        validationError={validationError}
        validationResult={validationResult}
        adding={adding}
        handleBrowseForRepo={handleBrowseForRepo}
        handleAddRepo={handleAddRepo}
        workspaceRepo={workspaceRepo}
        closeWorkspaceModal={closeWorkspaceModal}
        workspaceName={workspaceName}
        setWorkspaceName={setWorkspaceName}
        branchPreview={branchPreview}
        workspaceBaseBranch={workspaceBaseBranch}
        setWorkspaceBaseBranch={setWorkspaceBaseBranch}
        workspaceUseSetup={workspaceUseSetup}
        setWorkspaceUseSetup={setWorkspaceUseSetup}
        workspaceError={workspaceError}
        workspaceResult={workspaceResult}
        workspaceLoading={workspaceLoading}
        handleCreateWorkspace={handleCreateWorkspace}
        launchRepo={launchRepo}
        closeLaunchModal={closeLaunchModal}
        launchRuntime={launchRuntime}
        setLaunchRuntime={setLaunchRuntime}
        launchTaskName={launchTaskName}
        setLaunchTaskName={setLaunchTaskName}
        launchPrompt={launchPrompt}
        setLaunchPrompt={setLaunchPrompt}
        launchError={launchError}
        launchLoading={launchLoading}
        handleLaunchAgent={handleLaunchAgent}
        removeTarget={removeTarget}
        setRemoveTarget={setRemoveTarget}
        removeError={removeError}
        setRemoveError={setRemoveError}
        removeBusy={removeBusy}
        setRemoveBusy={setRemoveBusy}
        handleRemoveRepo={handleRemoveRepo}
      />
    </>
  );
}

export const RepoRegistrySection = memo(RepoRegistrySectionBase);
