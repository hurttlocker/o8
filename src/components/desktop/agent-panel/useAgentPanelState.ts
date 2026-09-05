'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSharedDesktopWs } from '../hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from '../hooks/useDesktopWebSocket';
import { isTauri } from '@/lib/tauri/bridge';
import { fetchOnce, getSWR, setSWR } from '@/lib/panel/fetch-cache';
import { REQUEST_ADD_REPO_EVENT } from '@/lib/desktop/events';
import {
  correlatedActionIsUnsettled,
  fetchCorrelatedActionReceipt,
  type CorrelatedActionReceipt,
} from '@/lib/orchestrator/action-receipt';
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
import { deriveWorktreeEnrichmentRepoPaths } from './worktree-enrichment-scope';

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

interface RuntimeLaunchReceiptPayload {
  ok?: boolean;
  error?: string;
  note?: string;
  surfaceId?: string;
  inProgress?: boolean;
  status?: string;
}

interface PendingRuntimeLaunch {
  requestBody: string;
  promise: Promise<CorrelatedActionReceipt<RuntimeLaunchReceiptPayload>> | null;
}

const pendingRuntimeLaunches = new Map<string, PendingRuntimeLaunch>();

interface InventoryFetchOptions {
  inventoryFresh?: boolean;
  allowWarmingRetry?: boolean;
}

interface AgentPanelFleetMeta extends Record<string, unknown> {
  gatewayFreshness?: 'fresh' | 'stale' | 'warming';
  gatewayReachable?: boolean;
  warmingRetryAfterMs?: number;
}

interface InventoryFetchPhase {
  agents: AgentDetail[];
  meta: AgentPanelFleetMeta | null;
  enrichment: Promise<[Response | null, Response | null]>;
}

export async function startAgentPanelInventoryFetch(
  fetcher: (url: string) => Promise<Response>,
  options: InventoryFetchOptions = {},
  onInventory?: (inventory: Pick<InventoryFetchPhase, 'agents' | 'meta'>) => void,
): Promise<InventoryFetchPhase | null> {
  const inventoryUrl = options.inventoryFresh
    ? '/api/runtime/inventory?fresh=1'
    : '/api/runtime/inventory';
  const inventoryPending = fetcher(inventoryUrl).catch(() => null);
  const enrichment = Promise.all([
    fetcher('/api/panel/workspaces').catch(() => null),
    fetcher('/api/panel/repos').catch(() => null),
  ]);
  const inventoryResponse = await inventoryPending;
  if (!inventoryResponse?.ok) return null;
  const data = await inventoryResponse.json() as {
    agents?: AgentDetail[];
    meta?: AgentPanelFleetMeta | null;
  };
  const inventory = {
    agents: data.agents ?? [],
    meta: data.meta ?? null,
    enrichment,
  };
  onInventory?.(inventory);
  return inventory;
}

export function createWarmingInventoryScheduler(
  refetch: (options: InventoryFetchOptions) => void,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    update(meta: AgentPanelFleetMeta | null, allowRetry = true) {
      if (meta?.gatewayFreshness !== 'warming') {
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      const retryAfterMs = Number(meta.warmingRetryAfterMs);
      if (!allowRetry || timer || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
      timer = setTimeout(() => {
        timer = null;
        refetch({ inventoryFresh: true, allowWarmingRetry: false });
      }, Math.min(retryAfterMs, 30_000));
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

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
        readiness?: { state: string; summary?: string; nextAction?: string } | null;
      }>;
    };

    let repoEntry = (data.repos ?? []).find((repo) => repoSlugFromRemoteUrl(repo.remoteUrl ?? null) === request.repo);
    if (!repoEntry) {
      throw new Error(`No local checkout is registered for ${request.repo}. Open the repo locally before launching an agent on it.`);
    }
    const readinessResponse = await fetchOnce(`/api/panel/repos?readiness=${encodeURIComponent(repoEntry.id)}`);
    if (!readinessResponse.ok) {
      throw new Error(`Unable to verify the local checkout for ${request.repo}.`);
    }
    const readinessData = await readinessResponse.json() as { repos?: typeof data.repos };
    repoEntry = (readinessData.repos ?? []).find((repo) => repo.id === repoEntry?.id) ?? repoEntry;
    if (repoEntry.readiness?.state === 'missing') {
      throw new Error(repoEntry.readiness.summary ?? `Repo folder not found at ${repoEntry.localPath}.`);
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

    const launchIntent = {
      runtime: 'codex',
      repoPath: repoEntry.localPath,
      prompt,
      taskName: request.kind === 'issue'
        ? `issue-${request.number}-${request.title}`
        : `pr-${request.number}-${request.title}`,
      baseBranch: repoEntry.defaultBranch,
      isolate: true,
      skipSetup: !repoEntry.setup.installOnCreateWorkspace,
    };
    const launchKey = JSON.stringify(launchIntent);
    const pending = pendingRuntimeLaunches.get(launchKey) ?? {
      requestBody: JSON.stringify({ ...launchIntent, clientMutationId: crypto.randomUUID() }),
      promise: null,
    };
    const launchRequest = pending.promise ?? fetchCorrelatedActionReceipt<RuntimeLaunchReceiptPayload>(
      '/api/runtime/launch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: pending.requestBody,
      },
    );
    pending.promise = launchRequest;
    pendingRuntimeLaunches.set(launchKey, pending);
    let launchReceipt: CorrelatedActionReceipt<RuntimeLaunchReceiptPayload>;
    try {
      launchReceipt = await launchRequest;
      pendingRuntimeLaunches.delete(launchKey);
    } catch (error) {
      if (correlatedActionIsUnsettled(error)) pending.promise = null;
      else pendingRuntimeLaunches.delete(launchKey);
      throw error;
    }
    const { response: launchResponse, payload: launchData } = launchReceipt;

    if (!launchResponse.ok || !launchData?.surfaceId) {
      throw new Error(launchData?.error ?? launchData?.note ?? 'Unable to launch agent task.');
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
    const commitAgents = (nextAgents: AgentDetail[], generation: number) => {
      if (generation !== inventoryGenerationRef.current) return;
      setSWR(panelSnapshotKey, { agents: nextAgents });
      onAgentsUpdate?.(nextAgents);
      setAgents((current) => arraysMatchBy(current, nextAgents, agentFp) ? current : nextAgents);
    };

    const finishInitialInventoryLoad = (generation: number) => {
      if (generation !== inventoryGenerationRef.current || inventoryLoadedRef.current) return;
      inventoryLoadedRef.current = true;
      setInventoryLoading(false);
    };

    const warmingScheduler = createWarmingInventoryScheduler((options) => {
      void fetchAll(options);
    });

    async function fetchAll(options: InventoryFetchOptions = {}) {
      const generation = ++inventoryGenerationRef.current;
      if (!inventoryLoadedRef.current) setInventoryLoading(true);
      try {
        const inventory = await startAgentPanelInventoryFetch(fetchOnce, options, ({ agents, meta }) => {
          if (generation !== inventoryGenerationRef.current) return;
          setFleetMeta(meta);
          setGatewayReachable(meta?.gatewayReachable ?? false);
          setGatewayWarming(meta?.gatewayFreshness === 'warming');
          commitAgents(agents, generation);
          finishInitialInventoryLoad(generation);
          warmingScheduler.update(meta, options.allowWarmingRetry !== false);
        });
        if (generation !== inventoryGenerationRef.current || !inventory) return;

        const nextAgents = inventory.agents;

        // Inventory is authoritative row state and paints above. Workspace,
        // repository, PR, diff, and worktree data only enrich those rows.
        const [workspacesResponse, reposResponse] = await inventory.enrichment;
        let registeredRepoPaths = new Set<string>();
        let hasRegisteredRepoSnapshot = false;

        const workspaceMap = new Map<string, {
          branch: string;
          pr: AgentDetail['pr'];
          localDiff: AgentDetail['localDiff'];
          workspaceStatus: AgentDetail['workspaceStatus'];
          repoReadiness?: RepoReadiness;
          workflowStage?: WorkflowStageBadge | null;
        }>();
        const workspaceRepoScopes: Array<{ sessionKey: string; repoPath: string }> = [];
        if (workspacesResponse?.ok) {
          const workspacesData = await workspacesResponse.json();
          for (const workspace of workspacesData.workspaces ?? []) {
            if (!workspace.sessionKey) continue;
            const repoPath = typeof workspace.repoPath === 'string' ? workspace.repoPath : '';
            workspaceMap.set(workspace.sessionKey, {
              branch: workspace.branch,
              pr: workspace.pr,
              localDiff: workspace.localDiff,
              workspaceStatus: workspace.status,
              repoReadiness: workspace.readiness,
              workflowStage: workspace.workflowStage ?? null,
            });
            workspaceRepoScopes.push({ sessionKey: workspace.sessionKey, repoPath });
          }
        }

        const worktreeMap = new Map<string, WorktreeInfo>();
        if (reposResponse?.ok) {
          const reposData = await reposResponse.json() as { repos?: Array<{ localPath: string }> };
          hasRegisteredRepoSnapshot = true;
          const allRepoPaths = Array.from(new Set((reposData.repos ?? [])
            .map((repo) => repo.localPath.trim().replace(/\/+$/, ''))
            .filter(Boolean)));
          registeredRepoPaths = new Set(allRepoPaths);
          const repoPaths = deriveWorktreeEnrichmentRepoPaths({
            agents: nextAgents,
            workspaces: workspaceRepoScopes,
            registeredRepoPaths: allRepoPaths,
          });

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
        commitAgents(filteredAgents, generation);
      } catch {
        // Ignore background refresh failures.
      } finally {
        finishInitialInventoryLoad(generation);
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
      warmingScheduler.dispose();
    };
  }, [onAgentsUpdate, panelSnapshotKey, wsConnected]);

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
