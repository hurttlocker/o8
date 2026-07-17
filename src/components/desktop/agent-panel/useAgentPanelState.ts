'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSharedDesktopWs } from '../hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from '../hooks/useDesktopWebSocket';
import { isTauri } from '@/lib/tauri/bridge';
import { fetchOnce, getSWR, setSWR } from '@/lib/panel/fetch-cache';
import { REQUEST_ADD_REPO_EVENT } from '@/lib/desktop/events';
import type { RepoReadiness } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { WorkflowStageBadge } from '@/lib/workflows/status';
import {
  agentFp,
  arraysMatchBy,
  buildWorkspaceGroups,
  repoSlugFromRemoteUrl,
} from './shared';
import type {
  AgentDetail,
  RepoTaskLaunchRequest,
} from './types';

type PanelSnapshot = { agents: AgentDetail[] };

interface UseAgentPanelStateArgs {
  selectedRepo?: string | null;
  selectedRepoLocalPath?: string | null;
  onLaunchWorkspaceTask?: (request: RepoTaskLaunchRequest) => Promise<void>;
  onSelectSession?: (sessionKey: string) => void;
  onAgentsUpdate?: (agents: AgentDetail[]) => void;
}

type RepoRegistryState = {
  loading: boolean;
  count: number;
  hasError: boolean;
};

export function useAgentPanelState({
  selectedRepo,
  selectedRepoLocalPath,
  onLaunchWorkspaceTask,
  onSelectSession,
  onAgentsUpdate,
}: UseAgentPanelStateArgs) {
  const [agents, setAgents] = useState<AgentDetail[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [gatewayReachable, setGatewayReachable] = useState(false);
  const [gatewayWarming, setGatewayWarming] = useState(false);
  const [fleetMeta, setFleetMeta] = useState<Record<string, unknown> | null>(null);
  const [reposOpen, setReposOpen] = useState(true);
  const [addRepoIntentNonce, setAddRepoIntentNonce] = useState(0);
  const [repoRegistryState, setRepoRegistryState] = useState<RepoRegistryState>({
    loading: true,
    count: 0,
    hasError: false,
  });
  const [repoLocalPath, setRepoLocalPath] = useState<string | null>(null);
  const fetchNowRef = useRef<() => void>(() => {});
  const inventoryLoadedRef = useRef(false);
  const inventoryGenerationRef = useRef(0);
  const hasSelectedRepo = Boolean(selectedRepoLocalPath);
  const panelSnapshotKey = `panel:agents:${selectedRepoLocalPath ?? selectedRepo ?? 'all'}`;

  const refreshNow = useCallback(() => {
    fetchNowRef.current();
  }, []);

  const requestAddRepo = useCallback(() => {
    setReposOpen(true);
    setAddRepoIntentNonce((current) => current + 1);
  }, []);

  // The global DesktopStatusBar's "+" button dispatches this window event so
  // the add-repo intent can be triggered from outside the AgentPanel's own
  // state scope. Same local handler, different entry point.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => requestAddRepo();
    window.addEventListener(REQUEST_ADD_REPO_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(REQUEST_ADD_REPO_EVENT, handler as EventListener);
    };
  }, [requestAddRepo]);

  const launchRepoTask = useCallback(async (request: RepoTaskLaunchRequest) => {
    if (onLaunchWorkspaceTask) {
      await onLaunchWorkspaceTask(request);
      return;
    }

    const response = await fetchOnce('/api/panel/repos');
    const data = await response.json() as {
      repos?: Array<{
        id: string;
        localPath: string;
        remoteUrl?: string | null;
        defaultBranch: string;
        setup: { installOnCreateWorkspace: boolean };
        readiness?: { state: string; nextAction?: string } | null;
      }>;
    };

    const repoEntry = (data.repos ?? []).find((repo) => repoSlugFromRemoteUrl(repo.remoteUrl ?? null) === request.repo);
    if (!repoEntry) {
      throw new Error(`No local checkout is registered for ${request.repo}. Open the repo locally before launching an agent on it.`);
    }
    if (repoEntry.readiness?.state === 'blocked') {
      throw new Error(`Repo ${request.repo} is blocked: ${repoEntry.readiness.nextAction ?? 'resolve the issue before launching an agent.'}`);
    }

    const prompt = request.kind === 'issue'
      ? [
          `Work on GitHub issue #${request.number} in ${request.repo}: ${request.title}.`,
          'Start by reading the issue context, inspect the current repo state, implement the fix, run focused validation, and summarize the result.',
          request.body ? `Issue context:\n${request.body}` : null,
        ].filter(Boolean).join('\n\n')
      : [
          `Review GitHub PR #${request.number} in ${request.repo}: ${request.title}.`,
          `Head branch: ${request.branch ?? 'unknown'}.`,
          'Start by reading the PR context and changed files, validate the change locally, identify risks or regressions, and leave the repo in a reviewable state.',
        ].join('\n\n');

    const launchResponse = await fetch('/api/runtime/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runtime: 'codex',
        repoPath: repoEntry.localPath,
        prompt,
        taskName: request.kind === 'issue'
          ? `issue-${request.number}-${request.title}`
          : `pr-${request.number}-${request.title}`,
        baseBranch: repoEntry.defaultBranch,
        isolate: true,
        skipSetup: !repoEntry.setup.installOnCreateWorkspace,
      }),
    });

    const launchData = await launchResponse.json() as { error?: string; surfaceId?: string };
    if (!launchResponse.ok || !launchData.surfaceId) {
      throw new Error(launchData.error ?? 'Unable to launch agent task.');
    }

    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repoEntry.id }),
    }).catch(() => null);

    onSelectSession?.(launchData.surfaceId);
    setTimeout(() => fetchNowRef.current(), 800);
  }, [onLaunchWorkspaceTask, onSelectSession]);

  const wsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onInboxUpdate: () => {
      fetchNowRef.current();
    },
    onReviewUpdate: () => {
      fetchNowRef.current();
    },
  }), []);
  const { isConnected: wsConnected } = useSharedDesktopWs(undefined, wsCallbacks);

  useEffect(() => {
    const snapshot = getSWR<PanelSnapshot>(panelSnapshotKey).data;
    if (snapshot) setAgents(snapshot.agents);
  }, [panelSnapshotKey]);

  useEffect(() => {
    async function fetchAll() {
      const generation = ++inventoryGenerationRef.current;
      if (!inventoryLoadedRef.current) setInventoryLoading(true);
      try {
        const [inventoryResponse, workspacesResponse, reposResponse] = await Promise.all([
          fetch('/api/runtime/inventory').catch(() => null),
          fetchOnce('/api/panel/workspaces').catch(() => null),
          fetchOnce('/api/panel/repos').catch(() => null),
        ]);

        let nextAgents: AgentDetail[] = [];
        let registeredRepoPaths = new Set<string>();
        let hasRegisteredRepoSnapshot = false;

        if (inventoryResponse?.ok) {
          const data = await inventoryResponse.json();
          nextAgents = data.agents ?? [];
          if (generation === inventoryGenerationRef.current) {
            setFleetMeta(data.meta ?? null);
            setGatewayReachable(data.meta?.gatewayReachable ?? false);
            setGatewayWarming(data.meta?.gatewayFreshness === 'warming');
          }
        }

        const workspaceMap = new Map<string, {
          branch: string;
          pr: AgentDetail['pr'];
          localDiff: AgentDetail['localDiff'];
          workspaceStatus: AgentDetail['workspaceStatus'];
          repoReadiness?: RepoReadiness;
          workflowStage?: WorkflowStageBadge | null;
        }>();
        if (workspacesResponse?.ok) {
          const workspacesData = await workspacesResponse.json();
          for (const workspace of workspacesData.workspaces ?? []) {
            if (!workspace.sessionKey) continue;
            workspaceMap.set(workspace.sessionKey, {
              branch: workspace.branch,
              pr: workspace.pr,
              localDiff: workspace.localDiff,
              workspaceStatus: workspace.status,
              repoReadiness: workspace.readiness,
              workflowStage: workspace.workflowStage ?? null,
            });
          }
        }

        const worktreeMap = new Map<string, WorktreeInfo>();
        if (reposResponse?.ok) {
          const reposData = await reposResponse.json() as { repos?: Array<{ localPath: string }> };
          hasRegisteredRepoSnapshot = true;
          const repoPaths = Array.from(new Set((reposData.repos ?? [])
            .map((repo) => repo.localPath.trim().replace(/\/+$/, ''))
            .filter(Boolean)));
          registeredRepoPaths = new Set(repoPaths);

          if (repoPaths.length > 0) {
            try {
              const response = await fetch('/api/worktrees/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repoPaths }),
              });

              if (response.ok) {
                const worktreesByRepo = await response.json() as Record<string, WorktreeInfo[]>;
                for (const repoPath of repoPaths) {
                  for (const worktree of worktreesByRepo[repoPath] ?? []) {
                    if (worktree.sessionKey) {
                      worktreeMap.set(worktree.sessionKey, worktree);
                    }
                  }
                }
              }
            } catch {
              // Best-effort enrichment only.
            }
          }
        }

        const enrichedAgents = nextAgents.map((agent) => {
          const workspace = workspaceMap.get(agent.sessionKey);
          const worktree = worktreeMap.get(agent.sessionKey);
          if (!workspace && !worktree) return agent;
          return {
            ...agent,
            branch: workspace?.branch ?? agent.branch,
            pr: workspace?.pr || agent.pr,
            localDiff: workspace?.localDiff || agent.localDiff,
            workspaceStatus: workspace?.workspaceStatus ?? agent.workspaceStatus,
            worktree: worktree ?? agent.worktree,
            repoReadiness: workspace?.repoReadiness ?? agent.repoReadiness,
            workflowStage: workspace?.workflowStage ?? agent.workflowStage,
          };
        });

        const filteredAgents = enrichedAgents.filter((agent) => {
          if (!hasRegisteredRepoSnapshot) return true;
          const repoScopedPath = agent.worktree?.path?.trim().replace(/\/+$/, '')
            || agent.runtimeSurface?.cwd?.trim().replace(/\/+$/, '')
            || null;
          if (!repoScopedPath) return true;
          for (const repoPath of registeredRepoPaths) {
            if (repoScopedPath === repoPath || repoScopedPath.startsWith(`${repoPath}/`)) {
              return true;
            }
          }
          return false;
        });

        if (generation !== inventoryGenerationRef.current) return;
        setSWR(panelSnapshotKey, { agents: filteredAgents });
        onAgentsUpdate?.(filteredAgents);
        setAgents((current) => arraysMatchBy(current, filteredAgents, agentFp) ? current : filteredAgents);
      } catch {
        // Ignore background refresh failures.
      } finally {
        if (generation === inventoryGenerationRef.current && !inventoryLoadedRef.current) {
          inventoryLoadedRef.current = true;
          setInventoryLoading(false);
        }
      }
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    fetchNowRef.current = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void fetchAll();
      }, 300);
    };

    void fetchAll();
    // WS-driven: instant refresh on agent/lane events instead of 60-120s polling
    const handler = () => { fetchNowRef.current?.(); };
    const wsEvents = ['o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchAll, 300_000); // 5min resilience fallback
    return () => {
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [onAgentsUpdate, panelSnapshotKey, wsConnected]);

  // Phase 4 friction fix #3: while the inventory snapshot is in stale mode
  // (the "Showing cached session state while the gateway reconnects" banner)
  // the 5-minute fallback poll is too slow to actually clear the banner —
  // users see it sit indefinitely after a transient hiccup. Run a fast
  // recovery poll (8s) WHILE we're in stale mode; the existing fetchAll
  // logic flips fleetMeta back to 'live' as soon as the inventory snapshot
  // rebuilds. The poll auto-stops once mode flips off 'stale'.
  useEffect(() => {
    if (fleetMeta?.mode !== 'stale') return undefined;
    const id = setInterval(() => {
      fetchNowRef.current?.();
    }, 8000);
    return () => clearInterval(id);
  }, [fleetMeta?.mode]);

  const workspaceGroups = useMemo(() => buildWorkspaceGroups(agents), [agents]);
  const inferredRepo = useMemo(() => {
    const preferredGroup = workspaceGroups.find((group) => group.hasRunning && group.repo !== 'workspace')
      ?? workspaceGroups.find((group) => group.repo !== 'workspace')
      ?? null;
    return preferredGroup?.repo ?? null;
  }, [workspaceGroups]);
  const effectiveScopedRepo = hasSelectedRepo ? (selectedRepo ?? null) : inferredRepo;

  useEffect(() => {
    if (selectedRepoLocalPath) {
      setRepoLocalPath(selectedRepoLocalPath);
      return;
    }
    if (!effectiveScopedRepo) {
      setRepoLocalPath(null);
      return;
    }
    fetchOnce('/api/panel/repos')
      .then((response) => response.json())
      .then((data) => {
        const match = (data.repos ?? []).find((repo: { remoteUrl?: string }) => {
          const url = (repo.remoteUrl ?? '').replace(/\.git$/, '');
          return url.endsWith(effectiveScopedRepo);
        });
        setRepoLocalPath(match?.localPath ?? null);
      })
      .catch(() => setRepoLocalPath(null));
  }, [effectiveScopedRepo, selectedRepoLocalPath]);

  const trackedWorkspaceCount = useMemo(
    () => workspaceGroups.filter((group) => group.repo !== 'workspace').length,
    [workspaceGroups],
  );
  const reviewWorkspaceCount = useMemo(
    () => workspaceGroups.filter((group) => (
      group.repo !== 'workspace'
      && group.agents.some((agent) => agent.workspaceStatus === 'in_review' || agent.status === 'reviewing')
    )).length,
    [workspaceGroups],
  );
  const hasRegisteredRepos = !repoRegistryState.loading && repoRegistryState.count > 0;
  const workspacesSummary = !hasRegisteredRepos
    ? null
    : inventoryLoading
      ? 'Loading repositories and workspaces...'
      : trackedWorkspaceCount > 0 || reviewWorkspaceCount > 0
        ? `${trackedWorkspaceCount} live · ${reviewWorkspaceCount} in review`
        : null;


  const [addRepoIntentMode, setAddRepoIntentMode] = useState<'scratch' | 'existing' | null>(null);
  const addRepoIntent = addRepoIntentNonce > 0
    ? { nonce: addRepoIntentNonce, mode: addRepoIntentMode }
    : null;
  // Listen for the empty-state Project picker's "Add new project" action.
  // The submenu detail carries `mode: 'scratch' | 'existing'` so the
  // dialog can auto-pop the folder picker (existing) or focus the path
  // input with a "new folder" hint (scratch). Other call sites (status
  // bar, etc.) bump setAddRepoIntentNonce directly without a mode.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: 'scratch' | 'existing' }>).detail;
      setAddRepoIntentMode(detail?.mode ?? null);
      setAddRepoIntentNonce((n) => n + 1);
    };
    window.addEventListener('o8:open-add-repo-flow', onOpen as EventListener);
    return () => window.removeEventListener('o8:open-add-repo-flow', onOpen as EventListener);
  }, []);
  const [titlebarSpacerHeight, setTitlebarSpacerHeight] = useState(10);
  useEffect(() => { if (isTauri()) setTitlebarSpacerHeight(38); }, []);
  const currentLaunchRepoPath = hasSelectedRepo ? (selectedRepoLocalPath ?? repoLocalPath) : repoLocalPath;

  return {
    agents,
    inventoryLoading,
    gatewayReachable,
    gatewayWarming,
    fleetMeta,
    reposOpen,
    setReposOpen,
    repoRegistryState,
    setRepoRegistryState,
    effectiveScopedRepo,
    currentLaunchRepoPath,
    workspacesSummary,
    addRepoIntent,
    titlebarSpacerHeight,
    refreshNow,
    requestAddRepo,
    launchRepoTask,
  };
}
