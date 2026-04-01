'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- dashboard shell is mid-refactor and keeps dormant wiring for upcoming panels */

import { lazy, Suspense, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import { AnimatePresence, motion } from 'framer-motion';
import { DesktopWebSocketProvider, useSharedDesktopWs, type WsConnectionState } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from '@/components/desktop/hooks/useDesktopWebSocket';
import type { TerminalHandle } from '@/components/desktop/LiveOutput';
import type { TerminalTabHandle } from '@/components/desktop/WorkspaceTerminal';
import { AgentPanel } from '@/components/desktop/AgentPanel';
// WorkspacesPanel merged into AgentPanel — unified agent+workspace view
import { AgentPanelChat } from '@/components/desktop/AgentPanelChat';
import type { CanvasTab } from '@/components/desktop/Canvas';
import { UniversalSearch, type CommandPaletteAction, type CommandPaletteStateTone } from '@/components/shared/UniversalSearch';
// GraphExplorer3D lazy-loaded below
import { AlertProvider, useAlerts } from '@/lib/alerts/context';
import type { ApprovalRecord } from '@/lib/approvals/types';
import { UpdateBanner } from '@/components/desktop/UpdateBanner';
import { ThemeProvider } from '@/lib/theme/context';
import { AlertTray } from '@/components/shared/AlertTray';
import { AlertToast } from '@/components/shared/AlertToast';
import { NavRail, type NavSection } from '@/components/desktop/NavRail';
import { ContextualPanel, type ContextualPanelHandle } from '@/components/desktop/ContextualPanel';
import { TitleBar } from '@/components/desktop/TitleBar';
import { SessionTimeline } from '@/components/desktop/SessionTimeline';
import { readTimelineVisible, subscribeTimelineVisible, writeTimelineVisible } from '@/lib/appearance/timeline';
import type { SettingsTab } from '@/components/desktop/SettingsPage';
import { ApprovalQueuePanel } from '@/components/desktop/ApprovalQueuePanel';
// AnalyticsPage lazy-loaded below
import type { DetectionResult } from '@/components/desktop/SetupWizard';
import { WorkspaceSidePanel, type WorkspaceSidePanelRepo, type WorkspaceSidePanelView } from '@/components/desktop/WorkspaceSidePanel';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type {
  OrchestratorLaneBinding,
  OrchestratorLaneSnapshot,
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorRuntimeTruth,
  OrchestratorWorkspaceTarget,
  WorkspaceLaneState,
  WorkspaceOrchestrationPacketBadge,
} from '@/lib/orchestrator/types';
import {
  loadOrchestratorMissionState,
  persistOrchestratorMissionState,
  readOrchestratorMissionState,
  reconcileOrchestratorMissionState,
  subscribeOrchestratorMissionState,
  updateOrchestratorMissionState,
  type DomainLaneSummary,
} from '@/lib/orchestrator/store';
import { FOCUS_REPO_SETUP_EVENT, OPEN_REPO_WORKSPACE_EVENT } from '@/lib/desktop/events';
import {
  areAllFtuxMilestonesSeen,
  readFtuxMilestones,
  writeFtuxMilestones,
  type FtuxMilestoneId,
  type FtuxMilestonesState,
} from '@/lib/ftux/milestones';
import type { RealtimeEventEnvelope, RealtimeMutationRecord } from '@/lib/realtime/types';
import type { WorkspaceLifecycleRecordView, WorkspaceLifecycleSummaryView } from '@/lib/workspace/lifecycle-types';
import { deriveWorkflowStage, describeWorkflowStage } from '@/lib/workflows/status';
import type {
  CanvasTileState,
  PaletteAgentSummary,
  RepoWorktreeSummary,
  WorkspaceChatTargetOption,
  WorkspaceScopeEntry,
} from './types';
import {
  FTUX_AGENT_PANEL_TARGET_WIDTH,
  FTUX_REVEAL_DURATION_MS,
  FTUX_SPRING_TRANSITION,
  GuidedDiscoveryCoachmark,
  GuidedDiscoveryHalo,
  type GuidedDiscoveryAction,
} from './ftux';
import {
  attentionRank,
  buildOrchestrationPacketBadge,
  buildOrchestrationPacketDraft,
  buildWorkspaceChatTargetOptions,
  clearRepoScopeFromTileLayout,
  collectOpenTerminalRepoPaths,
  collectRepoScopedTileIds,
  collectTerminalLeafIds,
  findCanvasLeafByRepoPath,
  findTerminalLeafByRepoPath,
  findUnscopedCanvasLeaf,
  findUnscopedTerminalLeaf,
  formatAttentionDetail,
  normalizeDetection,
  packetStatusFromLaneStatus,
  paletteSessionDetail,
  paletteSessionRuntime,
  paletteSessionTitle,
  paletteWorkflowLabel,
  parseIssueNumber,
  pathBelongsToRepoScope,
  readinessTone,
  repoEntryToWorkspaceScope,
  repoReadinessDetail,
  repoSlugFromAgent,
  repoSlugFromRemote,
  repoWorktreeDetail,
  sameWorkspaceLaneState,
  sameWorkspaceSidePanelRepo,
  sessionBelongsToRepoScope,
  shortenPath,
  summarizeLifecycleRecords,
  workflowTone,
  worktreeStageLabel,
  worktreeStageTone,
} from './utils';

/* ── Lazy-loaded heavy components (code-split for faster initial paint) ── */
const LazyWorkspaceTerminal = lazy(() => import('@/components/desktop/WorkspaceTerminal').then(m => ({ default: m.WorkspaceTerminal })));
const LazyCanvas = lazy(() => import('@/components/desktop/Canvas').then(m => ({ default: m.Canvas })));
const LazySettingsPage = lazy(() => import('@/components/desktop/SettingsPage').then(m => ({ default: m.SettingsPage })));
const LazyAnalyticsPage = lazy(() => import('@/components/desktop/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const LazyGraphExplorer3D = lazy(() => import('@/components/desktop/GraphExplorer3D').then(m => ({ default: m.GraphExplorer3D })));
const LazyThoughtsCard = lazy(() => import('@/components/desktop/ThoughtsCard').then(m => ({ default: m.ThoughtsCard })));
const LazySetupWizard = lazy(() => import('@/components/desktop/SetupWizard').then(m => ({ default: m.SetupWizard })));
const LazyOnboarding = lazy(() => import('@/components/desktop/Onboarding').then(m => ({ default: m.Onboarding })));

function openedLaneSessionsCache() {
  const key = '__o8_opened_lane_sessions';
  const existing = (globalThis as Record<string, unknown>)[key];
  if (existing instanceof Set) {
    return existing as Set<string>;
  }
  const created = new Set<string>();
  (globalThis as Record<string, unknown>)[key] = created;
  return created;
}
import { LocalhostPreviewTabs } from '@/components/desktop/LocalhostPreviewTabs';
import { TileContainer, type TileContentRegistry } from '@/components/desktop/TileContainer';
import type { AgentPanelChatInjectionPayload } from '@/lib/chat/injection';
import {
  type DetectedLocalhostPreview,
  formatPreviewSelectionContext,
  type PreviewSelectionPayload,
} from '@/lib/panel/preview';
import {
  closeTile,
  createDefaultTileLayout,
  createTileContent,
  deserializeTileLayout,
  findLeafByContentKind,
  findSiblingLeaf,
  findTile,
  getFirstLeaf,
  replaceTileContent,
  resizeTile,
  serializeTileLayout,
  collectLeafContentKinds,
  countLeaves,
  splitTile,
  wrapRootWithSplit,
} from '@/lib/tiles/operations';
import type { TileContentKind, TileLayout, TileLeafNode } from '@/lib/tiles/types';

const TILE_LAYOUT_STORAGE_KEY = 'cortex-ide:dashboard-tiles:v1';
const ACTIVE_TILE_STORAGE_KEY = 'cortex-ide:dashboard-active-tile:v1';
const DEFAULT_LEFT_PANEL_WIDTH = 200;
const DEFAULT_RIGHT_PANEL_WIDTH = 280;
const MIN_RIGHT_PANEL_WIDTH = 240;
const MAX_RIGHT_PANEL_WIDTH = 600;

export default function DashboardPage() {
  return (
    <ThemeProvider>
      <AlertProvider>
        <DesktopWebSocketProvider>
          <DashboardInner />
        </DesktopWebSocketProvider>
      </AlertProvider>
    </ThemeProvider>
  );
}

function DashboardInner() {
  const [inTauri, setInTauri] = useState(false);
  useEffect(() => { setInTauri(isTauri()); }, []);
  const initialTileLayout = useMemo(() => createDefaultTileLayout(), []);

  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_PANEL_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  const [activeSessionKey, setActiveSessionKey] = useState<string | undefined>();
  const [liveOutputCollapsed, setLiveOutputCollapsed] = useState(false);
  const [dashTermSession, setDashTermSession] = useState<string | null>(null);
  const termCreatedRef = useRef(false);
  const terminalRef = useRef<TerminalHandle>(null);
  const workspaceTerminalHandlesRef = useRef<Map<string, TerminalTabHandle>>(new Map());
  const pendingWorkspaceTerminalResolversRef = useRef<Map<string, (handle: TerminalTabHandle) => void>>(new Map());
  const [workspaceChatSessionByTileId, setWorkspaceChatSessionByTileId] = useState<Record<string, string | undefined>>({});
  const [workspaceChatSessionsByTileId, setWorkspaceChatSessionsByTileId] = useState<Record<string, MobileInboxSnapshot['sessions']>>({});
  const [workspaceLaneByTileId, setWorkspaceLaneByTileId] = useState<Record<string, WorkspaceLaneState | null>>({});
  const [workspaceTerminalResetNonceByTileId, setWorkspaceTerminalResetNonceByTileId] = useState<Record<string, number>>({});
  const contextualPanelHandlesRef = useRef<Map<string, ContextualPanelHandle>>(new Map());
  const canvasStateByTileIdRef = useRef<Record<string, CanvasTileState>>({});
  const [agentsJson, setAgentsJson] = useState('[]');
  const [activeWorkspace, setActiveWorkspace] = useState<string | undefined>();
  const [workspaceLifecycleRecords, setWorkspaceLifecycleRecords] = useState<WorkspaceLifecycleRecordView[]>([]);
  const [workspaceLifecycleSummary, setWorkspaceLifecycleSummary] = useState<WorkspaceLifecycleSummaryView>({
    unreadCount: 0,
    archivedCount: 0,
    nextAttentionWorkspaceId: null,
  });
  const [showMemoryView, setShowMemoryView] = useState(false);
  const [alertTrayOpen, setAlertTrayOpen] = useState(false);
  const [activeNavSection, setActiveNavSection] = useState<NavSection>('agents');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('connectors');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [timelineVisible, setTimelineVisible] = useState(() => readTimelineVisible());
  const [chatVisible, setChatVisible] = useState(true);
  const rightPanelMode = 'workspace' as const;
  const setRightPanelMode = (_mode: 'chat' | 'workspace') => { /* v1: right panel is always workspace */ };
  const [workspaceSidePanelView, setWorkspaceSidePanelView] = useState<WorkspaceSidePanelView>('diff');
  const [workspaceSidePanelRepoPath, setWorkspaceSidePanelRepoPath] = useState<string | null>(null);
  const [workspaceSidePanelRepoContext, setWorkspaceSidePanelRepoContext] = useState<WorkspaceSidePanelRepo | null>(null);
  const [workspaceSidePanelPullRequestNumber, setWorkspaceSidePanelPullRequestNumber] = useState<number | null>(null);
  const [workspaceSidePanelCompactReview, setWorkspaceSidePanelCompactReview] = useState(false);
  const [workspaceSidePanelActivationKey, setWorkspaceSidePanelActivationKey] = useState(0);
  const [workspaceChatTargetKeyByRepoPath, setWorkspaceChatTargetKeyByRepoPath] = useState<Record<string, string>>({});
  const [thoughtsOpen, setThoughtsOpen] = useState(false);
  const [thoughtsMissionState, setThoughtsMissionState] = useState<OrchestratorMissionState>(() => readOrchestratorMissionState());
  const [wsStatus, setWsStatus] = useState<WsConnectionState>('connecting');
  const [workspacePreviews, setWorkspacePreviews] = useState<DetectedLocalhostPreview[]>([]);
  const [tileLayout, setTileLayout] = useState<TileLayout>(initialTileLayout);
  const [activeTileId, setActiveTileId] = useState<string | null>(getFirstLeaf(initialTileLayout.root).id);
  const [tileLayoutHydrated, setTileLayoutHydrated] = useState(false);
  const [ftuxMilestones, setFtuxMilestones] = useState<FtuxMilestonesState>(() => readFtuxMilestones());
  const [ftuxQueuedMilestones, setFtuxQueuedMilestones] = useState<FtuxMilestoneId[]>([]);
  const [activeFtuxMilestone, setActiveFtuxMilestone] = useState<FtuxMilestoneId | null>(null);
  const [ftuxFirstChangedFile, setFtuxFirstChangedFile] = useState<{ path: string; workspace: string | null } | null>(null);
  const [mobileRemoteHref, setMobileRemoteHref] = useState('/mobile');
  const lastWorkspacePanelViewRef = useRef<'diff' | 'review'>('diff');
  const lastMarkedWorkspaceReadRef = useRef<string>('');
  const thoughtsPersistTimerRef = useRef<number | null>(null);
  const ftuxMilestonesRef = useRef<FtuxMilestonesState>(ftuxMilestones);
  const activeFtuxMilestoneRef = useRef<FtuxMilestoneId | null>(null);
  const ftuxDormant = useMemo(() => areAllFtuxMilestonesSeen(ftuxMilestones), [ftuxMilestones]);

  useEffect(() => subscribeTimelineVisible(setTimelineVisible), []);

  useEffect(() => {
    ftuxMilestonesRef.current = ftuxMilestones;
  }, [ftuxMilestones]);

  useEffect(() => {
    activeFtuxMilestoneRef.current = activeFtuxMilestone;
  }, [activeFtuxMilestone]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setMobileRemoteHref(`${window.location.origin}/mobile`);
  }, []);

  const enqueueFtuxMilestone = useCallback((milestoneId: FtuxMilestoneId) => {
    if (ftuxMilestonesRef.current[milestoneId].seen) {
      return false;
    }

    const next = {
      ...ftuxMilestonesRef.current,
      [milestoneId]: { seen: true },
    };

    ftuxMilestonesRef.current = next;
    setFtuxMilestones(next);
    writeFtuxMilestones(next);
    setFtuxQueuedMilestones((current) => (
      current.includes(milestoneId) || activeFtuxMilestoneRef.current === milestoneId
        ? current
        : [...current, milestoneId]
    ));
    return true;
  }, []);

  const dismissFtuxMilestone = useCallback(() => {
    setActiveFtuxMilestone(null);
  }, []);

  useEffect(() => {
    if (activeFtuxMilestone || ftuxQueuedMilestones.length === 0) {
      return;
    }

    const [nextMilestone, ...remaining] = ftuxQueuedMilestones;
    setFtuxQueuedMilestones(remaining);
    setActiveFtuxMilestone(nextMilestone);
  }, [activeFtuxMilestone, ftuxQueuedMilestones]);

  useEffect(() => {
    if (!activeFtuxMilestone) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setActiveFtuxMilestone((current) => (current === activeFtuxMilestone ? null : current));
    }, FTUX_REVEAL_DURATION_MS);

    return () => window.clearTimeout(timeout);
  }, [activeFtuxMilestone]);

  useEffect(() => {
    if (activeFtuxMilestone !== 'firstAgentSpawned') {
      return;
    }

    if (!sidebarVisible) {
      setSidebarVisible(true);
    }
    setLeftWidth((current) => Math.max(current, FTUX_AGENT_PANEL_TARGET_WIDTH));
  }, [activeFtuxMilestone, sidebarVisible]);

  useEffect(() => {
    if (activeFtuxMilestone !== 'firstCompletion') {
      return;
    }

    if (!timelineVisible) {
      writeTimelineVisible(true);
      setTimelineVisible(true);
    }
  }, [activeFtuxMilestone, timelineVisible]);

  // ── Prefetch heavy lazy chunks on idle so Suspense fallbacks are never visible ──
  useEffect(() => {
    if (typeof requestIdleCallback === 'undefined') {
      const timer = setTimeout(() => {
        import('@/components/desktop/WorkspaceTerminal');
        import('@/components/desktop/Canvas');
        import('@/components/desktop/ThoughtsCard');
      }, 100);
      return () => clearTimeout(timer);
    }
    const id = requestIdleCallback(() => {
      import('@/components/desktop/WorkspaceTerminal');
      import('@/components/desktop/Canvas');
      import('@/components/desktop/ThoughtsCard');
    });
    return () => cancelIdleCallback(id);
  }, []);

  useEffect(() => {
    return subscribeOrchestratorMissionState(setThoughtsMissionState);
  }, []);

  useEffect(() => {
    void loadOrchestratorMissionState().then(setThoughtsMissionState);
    const handleFocus = () => {
      void loadOrchestratorMissionState().then(setThoughtsMissionState);
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  useEffect(() => () => {
    if (thoughtsPersistTimerRef.current !== null) {
      window.clearTimeout(thoughtsPersistTimerRef.current);
    }
  }, []);

  const scheduleThoughtsMissionPersist = useCallback((next: OrchestratorMissionState) => {
    if (thoughtsPersistTimerRef.current !== null) {
      window.clearTimeout(thoughtsPersistTimerRef.current);
    }
    thoughtsPersistTimerRef.current = window.setTimeout(() => {
      thoughtsPersistTimerRef.current = null;
      void persistOrchestratorMissionState(next);
    }, 180);
  }, []);

  const handleThoughtsMissionStateChange = useCallback((
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState),
  ) => {
    const updated = updateOrchestratorMissionState(next);
    setThoughtsMissionState(updated);
    scheduleThoughtsMissionPersist(updated);
  }, [scheduleThoughtsMissionPersist]);

  // ── Setup wizard state ──
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [setupDetection, setSetupDetection] = useState<DetectionResult | null>(null);
  const setupCheckedRef = useRef(false);

  useEffect(() => {
    if (setupCheckedRef.current) return;
    setupCheckedRef.current = true;
    (async () => {
      try {
        const configRes = await fetch('/api/setup/config');
        if (!configRes.ok) return;
        const config = await configRes.json();
        if (config.completedAt) return; // Already completed setup
        // Show the onboarding screen immediately — detection runs in background
        setSetupWizardOpen(true);
        try {
          const detectRes = await fetch('/api/setup/detect');
          if (detectRes.ok) {
            const rawDetection = await detectRes.json() as Record<string, unknown>;
            setSetupDetection(normalizeDetection(rawDetection));
          }
        } catch { /* detection is optional for onboarding */ }
      } catch { /* silent — don't block dashboard */ }
    })();
  }, []);

  const handleSetupComplete = useCallback(async () => {
    setSetupWizardOpen(false);
    try {
      await fetch('/api/setup/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completedAt: new Date().toISOString() }),
      });
    } catch { /* silent */ }
  }, []);

  // Dev: trigger onboarding from settings without resetting config
  useEffect(() => {
    const handler = () => setSetupWizardOpen(true);
    window.addEventListener('cortex-trigger-onboarding', handler);
    return () => window.removeEventListener('cortex-trigger-onboarding', handler);
  }, []);

  const refreshWorkspaceLifecycle = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/workspaces', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      });
      if (!response.ok) return;
      const payload = await response.json() as {
        lifecycle?: {
          records?: WorkspaceLifecycleRecordView[];
          summary?: WorkspaceLifecycleSummaryView;
        };
      };
      setWorkspaceLifecycleRecords(payload.lifecycle?.records ?? []);
      setWorkspaceLifecycleSummary(payload.lifecycle?.summary ?? {
        unreadCount: 0,
        archivedCount: 0,
        nextAttentionWorkspaceId: null,
      });
    } catch {
      // Keep the last truthful lifecycle snapshot if refresh fails.
    }
  }, []);

  const mutateWorkspaceLifecycle = useCallback(async (
    action: 'archive' | 'restore' | 'mark_read',
    workspaceId: string,
  ) => {
    const response = await fetch('/api/panel/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, workspaceId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error || 'Unable to update workspace lifecycle.');
    }
    await refreshWorkspaceLifecycle();
  }, [refreshWorkspaceLifecycle]);

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
    () => workspaceScopeEntries.map((entry) => ({
      id: entry.localPath,
      label: entry.isWorktree
        ? `${entry.name} · ${entry.branch ?? 'worktree'}`
        : entry.name,
      repoName: entry.name,
      localPath: entry.localPath,
      branch: entry.branch ?? null,
      isWorktree: entry.isWorktree ?? false,
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
  const workspaceSidePanelRepo = useMemo<WorkspaceSidePanelRepo | null>(() => {
    if (
      workspaceSidePanelRepoContext
      && (!workspaceSidePanelRepoPath || workspaceSidePanelRepoContext.localPath === workspaceSidePanelRepoPath)
    ) {
      return workspaceSidePanelRepoContext;
    }
    if (!workspaceSidePanelRepoPath) {
      return null;
    }
    const matched = workspaceScopeEntries.find((repo) => repo.localPath === workspaceSidePanelRepoPath) ?? null;
    if (!matched) {
      return globalRepoEntry?.localPath === workspaceSidePanelRepoPath
        ? {
            name: globalRepoEntry.name,
            localPath: globalRepoEntry.localPath,
            branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
            readiness: globalRepoEntry.readiness ?? null,
            remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
          }
        : null;
    }
    return {
      name: matched.name,
      localPath: matched.localPath,
      branch: matched.branch ?? matched.readiness?.currentBranch ?? null,
      readiness: matched.readiness ?? null,
      remoteUrl: matched.remoteUrl ?? undefined,
      isWorktree: matched.isWorktree ?? undefined,
      worktreeStatus: matched.worktreeStatus ?? undefined,
    };
  }, [globalRepoBranch, globalRepoEntry, workspaceScopeEntries, workspaceSidePanelRepoContext, workspaceSidePanelRepoPath]);
  const getWorkspaceSidePanelRepoBySlug = useCallback((repoSlug?: string | null): WorkspaceSidePanelRepo | null => {
    if (!repoSlug) return globalRepoEntry ? {
      name: globalRepoEntry.name,
      localPath: globalRepoEntry.localPath,
      branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
      readiness: globalRepoEntry.readiness ?? null,
      remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
    } : null;

    const matched = globalRepoEntries.find((entry) => repoSlugFromRemote(entry.remoteUrl) === repoSlug) ?? null;
    if (!matched) return null;
    return {
      name: matched.name,
      localPath: matched.localPath,
      branch: matched.readiness?.currentBranch ?? matched.defaultBranch,
      readiness: matched.readiness ?? null,
      remoteUrl: matched.remoteUrl ?? undefined,
    };
  }, [globalRepoBranch, globalRepoEntries, globalRepoEntry]);
  const getWorkspaceSidePanelRepoByPath = useCallback((repoPath?: string | null): WorkspaceSidePanelRepo | null => {
    if (!repoPath) {
      return globalRepoEntry ? {
        name: globalRepoEntry.name,
        localPath: globalRepoEntry.localPath,
        branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
        readiness: globalRepoEntry.readiness ?? null,
        remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
      } : null;
    }

    const matched = workspaceScopeEntries.find((entry) => entry.localPath === repoPath) ?? null;
    if (!matched) return null;
    return {
      name: matched.name,
      localPath: matched.localPath,
      branch: matched.branch ?? matched.readiness?.currentBranch ?? null,
      readiness: matched.readiness ?? null,
      remoteUrl: matched.remoteUrl ?? undefined,
    };
  }, [globalRepoBranch, globalRepoEntry, workspaceScopeEntries]);
  const openWorkspaceSidePanel = useCallback((
    view: WorkspaceSidePanelView,
    repo?: WorkspaceSidePanelRepo | null,
    options?: { pullRequestNumber?: number | null; compactReview?: boolean },
  ) => {
    setChatVisible(true);
    setRightPanelMode('workspace');
    setWorkspaceSidePanelView(view);
    setWorkspaceSidePanelRepoPath(repo?.localPath ?? globalRepoEntry?.localPath ?? null);
    setWorkspaceSidePanelRepoContext(repo ?? (globalRepoEntry ? {
      name: globalRepoEntry.name,
      localPath: globalRepoEntry.localPath,
      branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
      readiness: globalRepoEntry.readiness ?? null,
      remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
    } : null));
    setWorkspaceSidePanelPullRequestNumber(view === 'review' ? options?.pullRequestNumber ?? null : null);
    setWorkspaceSidePanelCompactReview(view === 'review' ? Boolean(options?.compactReview) : false);
    setWorkspaceSidePanelActivationKey((value) => value + 1);
  }, [globalRepoBranch, globalRepoEntry]);

  useEffect(() => {
    if (workspaceSidePanelView === 'diff' || workspaceSidePanelView === 'review') {
      lastWorkspacePanelViewRef.current = workspaceSidePanelView;
    }
  }, [workspaceSidePanelView]);
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
      const response = await fetch(`/api/worktrees?repo=${encodeURIComponent(globalRepoEntry.localPath)}`);
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
    const response = await fetch('/api/panel/repos');
    const data = await response.json() as { repos?: RepoRegistryEntry[] };
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

    const confirmed = window.confirm(
      `Remove ${target.name} from Cortex?\n\nThis only removes it from the local repo list. It does not delete the folder on disk.`,
    );
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

  const handleRepoRemoved = useCallback((removedRepo: RepoRegistryEntry) => {
    const removedRepoPath = removedRepo.localPath;
    const nextGlobalRepoEntries = globalRepoEntries.filter((repo) => repo.id !== removedRepo.id);
    const scopedTileIds = collectRepoScopedTileIds(tileLayout.root, removedRepoPath);
    const affectedTerminalTileIds = new Set(scopedTileIds.terminal);
    const affectedCanvasTileIds = new Set(scopedTileIds.canvas);

    const nextWorkspaceChatSessionsByTileId = Object.entries(workspaceChatSessionsByTileId).reduce<Record<string, MobileInboxSnapshot['sessions']>>((next, [tileId, sessions]) => {
      const filteredSessions = sessions.filter((session) => !sessionBelongsToRepoScope(session, removedRepoPath));
      if (filteredSessions.length !== sessions.length) {
        affectedTerminalTileIds.add(tileId);
      }
      if (filteredSessions.length > 0) {
        next[tileId] = filteredSessions;
      }
      return next;
    }, {});

    const parsed = (() => {
      try {
        return JSON.parse(agentsJson) as PaletteAgentSummary[];
      } catch {
        return [] as PaletteAgentSummary[];
      }
    })();
    const filteredAgents = parsed.filter((agent) => !sessionBelongsToRepoScope(agent, removedRepoPath));
    const removedSessionKeys = new Set<string>([
      ...parsed.filter((agent) => sessionBelongsToRepoScope(agent, removedRepoPath)).map((agent) => agent.sessionKey),
      ...Object.values(workspaceChatSessionsByTileId).flatMap((sessions) => sessions
        .filter((session) => sessionBelongsToRepoScope(session, removedRepoPath))
        .map((session) => session.sessionKey)),
    ]);

    setAgentsJson(JSON.stringify(filteredAgents));
    setGlobalRepoEntries(nextGlobalRepoEntries);
    setAllRepoWorktrees((current) => {
      const next = { ...current };
      delete next[removedRepoPath];
      return next;
    });

    if (globalRepoId === removedRepo.id) {
      const fallbackRepo = nextGlobalRepoEntries[0] ?? null;
      setGlobalRepoId(fallbackRepo?.id ?? null);
      setGlobalRepoBranch(fallbackRepo?.defaultBranch ?? 'main');
      if (typeof window !== 'undefined') {
        if (fallbackRepo) {
          sessionStorage.setItem('cortex-global-repo-id', fallbackRepo.id);
        } else {
          sessionStorage.removeItem('cortex-global-repo-id');
        }
      }
    }

    if (pathBelongsToRepoScope(activeWorkspace, removedRepoPath)) {
      setActiveWorkspace(undefined);
    }

    if (pathBelongsToRepoScope(workspaceSidePanelRepoPath, removedRepoPath)) {
      setWorkspaceSidePanelRepoPath(null);
      setWorkspaceSidePanelRepoContext(null);
      setWorkspaceSidePanelView('blank');
      setWorkspaceSidePanelPullRequestNumber(null);
      setWorkspaceSidePanelCompactReview(false);
      setWorkspaceSidePanelActivationKey((value) => value + 1);
    }

    setWorkspaceChatSessionsByTileId(nextWorkspaceChatSessionsByTileId);
    setWorkspaceChatSessionByTileId((current) => Object.entries(current).reduce<Record<string, string | undefined>>((next, [tileId, sessionKey]) => {
      if (affectedTerminalTileIds.has(tileId)) {
        return next;
      }
      if (!sessionKey) {
        next[tileId] = sessionKey;
        return next;
      }
      const sessions = nextWorkspaceChatSessionsByTileId[tileId] ?? [];
      if (sessions.some((session) => session.sessionKey === sessionKey)) {
        next[tileId] = sessionKey;
      }
      return next;
    }, {}));
    setWorkspaceChatTargetKeyByRepoPath((current) => Object.entries(current).reduce<Record<string, string>>((next, [repoPath, sessionKey]) => {
      if (!pathBelongsToRepoScope(repoPath, removedRepoPath) && !removedSessionKeys.has(sessionKey)) {
        next[repoPath] = sessionKey;
      }
      return next;
    }, {}));
    setWorkspaceLaneByTileId((current) => Object.entries(current).reduce<Record<string, WorkspaceLaneState | null>>((next, [tileId, lane]) => {
      if (affectedTerminalTileIds.has(tileId)) {
        return next;
      }
      if (!lane || !pathBelongsToRepoScope(lane.repoPath, removedRepoPath)) {
        next[tileId] = lane;
      }
      return next;
    }, {}));

    if (activeSessionKey && removedSessionKeys.has(activeSessionKey)) {
      setActiveSessionKey(undefined);
    }

    const nextLifecycleRecords = workspaceLifecycleRecords.filter((record) => (
      !pathBelongsToRepoScope(record.repoPath, removedRepoPath)
      && !pathBelongsToRepoScope(record.workspacePath, removedRepoPath)
    ));
    setWorkspaceLifecycleRecords(nextLifecycleRecords);
    setWorkspaceLifecycleSummary(summarizeLifecycleRecords(nextLifecycleRecords));
    void refreshWorkspaceLifecycle();

    if (globalRepoEntry?.localPath === removedRepoPath) {
      setSelectedRepoWorktrees(null);
    }

    if (affectedCanvasTileIds.size > 0) {
      setCanvasStateByTileId((current) => {
        const next = { ...current };
        for (const tileId of affectedCanvasTileIds) {
          next[tileId] = {
            tabs: [],
            activeTabId: null,
            revealKey: (current[tileId]?.revealKey ?? 0) + 1,
          };
        }
        return next;
      });
    }

    if (affectedTerminalTileIds.size > 0) {
      setWorkspaceTerminalResetNonceByTileId((current) => {
        const next = { ...current };
        for (const tileId of affectedTerminalTileIds) {
          next[tileId] = (next[tileId] ?? 0) + 1;
        }
        return next;
      });
    }

    setTileLayout((current) => ({
      ...current,
      root: clearRepoScopeFromTileLayout(current.root, removedRepoPath),
    }));
  }, [
    activeSessionKey,
    activeWorkspace,
    agentsJson,
    globalRepoEntries,
    globalRepoEntry?.localPath,
    globalRepoId,
    refreshWorkspaceLifecycle,
    tileLayout.root,
    workspaceChatSessionsByTileId,
    workspaceLifecycleRecords,
    workspaceSidePanelRepoPath,
  ]);

  // Fetch branch when selected repo changes
  useEffect(() => {
    if (!globalRepoEntry?.localPath) return;
    fetch(`/api/panel/branches?path=${encodeURIComponent(globalRepoEntry.localPath)}`)
      .then(r => r.json())
      .then(bData => {
        const current = (bData.branches ?? []).find((b: { current: boolean; name: string }) => b.current);
        if (current?.name) setGlobalRepoBranch(current.name);
      })
      .catch(() => {});
  }, [globalRepoEntry]);

  useEffect(() => {
    // Defer worktree refresh — not needed for initial shell paint
    const initTimer = setTimeout(() => { void refreshSelectedRepoWorktrees(); }, 1_500);
    if (!globalRepoEntry?.localPath) {
      return () => clearTimeout(initTimer);
    }
    const intervalId = window.setInterval(() => {
      void refreshSelectedRepoWorktrees();
    }, 30_000);
    return () => { clearTimeout(initTimer); window.clearInterval(intervalId); };
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
          const response = await fetch(`/api/worktrees?repo=${encodeURIComponent(repo.localPath)}`);
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
    const intervalId = window.setInterval(() => { void fetchAllRepoWorktrees(); }, 60_000);
    return () => {
      active = false;
      clearTimeout(initTimer);
      window.clearInterval(intervalId);
    };
  }, [globalRepoEntries]);

  useEffect(() => {
    const initTimer = setTimeout(() => { void refreshWorkspaceLifecycle(); }, 2_500);
    const intervalId = window.setInterval(() => {
      void refreshWorkspaceLifecycle();
    }, 30_000);
    return () => { clearTimeout(initTimer); window.clearInterval(intervalId); };
  }, [refreshWorkspaceLifecycle]);

  useEffect(() => {
    if (wsStatus !== 'connected') return;
    void refreshWorkspaceLifecycle();
  }, [refreshWorkspaceLifecycle, wsStatus]);

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
        folderPath = window.prompt('Enter folder path:');
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
      window.alert(error instanceof Error ? error.message : 'Unable to open folder.');
    }
  }, [loadRegisteredRepos]);

  const handleOpenSettingsTab = useCallback((tab: SettingsTab) => {
    setShowMemoryView(false);
    setSettingsInitialTab(tab);
    setActiveNavSection('settings');
  }, []);

  const focusRepoSetup = useCallback((repoEntry: RepoRegistryEntry) => {
    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }
    setShowMemoryView(false);
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
  }, [sidebarVisible]);

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
    setShowMemoryView(false);
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
  }, [sidebarVisible]);

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
  const [lifecycleEvents, setLifecycleEvents] = useState<Map<string, { state: string; exitCode?: number; ts: number }>>(new Map());
  const [desktopDraftInjection, setDesktopDraftInjection] = useState<{ id: string; text: string } | null>(null);
  const [thoughtsDraftInjection, setThoughtsDraftInjection] = useState<{ id: string; text: string } | null>(null);

  const registerWorkspaceTerminalHandle = useCallback((tileId: string, handle: TerminalTabHandle | null) => {
    if (handle) {
      workspaceTerminalHandlesRef.current.set(tileId, handle);
      const resolver = pendingWorkspaceTerminalResolversRef.current.get(tileId);
      if (resolver) {
        pendingWorkspaceTerminalResolversRef.current.delete(tileId);
        resolver(handle);
      }
      return;
    }
    workspaceTerminalHandlesRef.current.delete(tileId);
    pendingWorkspaceTerminalResolversRef.current.delete(tileId);
  }, []);

  const registerContextualPanelHandle = useCallback((tileId: string, handle: ContextualPanelHandle | null) => {
    if (handle) {
      contextualPanelHandlesRef.current.set(tileId, handle);
      return;
    }
    contextualPanelHandlesRef.current.delete(tileId);
  }, []);

  const getPreferredContextualPanelHandle = useCallback((preferredTileId?: string | null) => {
    if (preferredTileId) {
      const preferredHandle = contextualPanelHandlesRef.current.get(preferredTileId);
      if (preferredHandle) {
        return preferredHandle;
      }
    }
    if (activeTileId) {
      const activeHandle = contextualPanelHandlesRef.current.get(activeTileId);
      if (activeHandle) {
        return activeHandle;
      }
    }
    return contextualPanelHandlesRef.current.values().next().value ?? null;
  }, [activeTileId]);

  const findInsertionTarget = useCallback((preferredKinds: TileContentKind[]): TileLeafNode => {
    const activeTile = activeTileId ? findTile(tileLayout.root, activeTileId) : null;
    if (activeTile?.type === 'leaf' && preferredKinds.includes(activeTile.content.kind)) {
      return activeTile;
    }
    for (const kind of preferredKinds) {
      const matchingLeaf = findLeafByContentKind(tileLayout.root, kind);
      if (matchingLeaf) {
        return matchingLeaf;
      }
    }
    if (activeTile?.type === 'leaf') {
      return activeTile;
    }
    return getFirstLeaf(tileLayout.root);
  }, [activeTileId, tileLayout.root]);

  const findWorkspaceTarget = useCallback((): TileLeafNode | null => {
    const activeTile = activeTileId ? findTile(tileLayout.root, activeTileId) : null;
    if (activeTile?.type === 'leaf' && activeTile.content.kind === 'workspace') {
      return activeTile;
    }
    return findLeafByContentKind(tileLayout.root, 'workspace');
  }, [activeTileId, tileLayout.root]);

  const setTerminalTileRepoScope = useCallback((tileId: string, repoPath: string | null) => {
    setTileLayout((current) => {
      const tile = findTile(current.root, tileId);
      if (tile?.type !== 'leaf' || tile.content.kind !== 'terminal') {
        return current;
      }
      const nextRepoPath = repoPath ?? null;
      if ((tile.content.repoPath ?? null) === nextRepoPath) {
        return current;
      }
      return {
        ...current,
        root: replaceTileContent(current.root, tileId, {
          kind: 'terminal',
          repoPath: nextRepoPath,
        }),
      };
    });
  }, []);

  const findPreferredWorkspaceTerminalTileId = useCallback((repoPath?: string | null, preferredTileId?: string | null) => {
    const normalizedRepoPath = repoPath ?? null;
    if (preferredTileId) {
      const preferredTile = findTile(tileLayout.root, preferredTileId);
      if (preferredTile?.type === 'leaf' && preferredTile.content.kind === 'terminal') {
        const preferredRepoPath = preferredTile.content.repoPath ?? null;
        if (!normalizedRepoPath || preferredRepoPath === normalizedRepoPath || preferredRepoPath === null) {
          return preferredTileId;
        }
      }
    }

    if (normalizedRepoPath) {
      const matchingLeaf = findTerminalLeafByRepoPath(tileLayout.root, normalizedRepoPath);
      if (matchingLeaf) {
        return matchingLeaf.id;
      }
    }

    if (activeTileId) {
      const activeTile = findTile(tileLayout.root, activeTileId);
      if (activeTile?.type === 'leaf' && activeTile.content.kind === 'terminal') {
        const activeRepoPath = activeTile.content.repoPath ?? null;
        if (!normalizedRepoPath || activeRepoPath === normalizedRepoPath || activeRepoPath === null) {
          return activeTileId;
        }
      }
    }

    if (normalizedRepoPath) {
      const unscopedLeaf = findUnscopedTerminalLeaf(tileLayout.root);
      if (unscopedLeaf) {
        return unscopedLeaf.id;
      }
      return null;
    }

    const firstEntry = workspaceTerminalHandlesRef.current.entries().next().value as [string, TerminalTabHandle] | undefined;
    return firstEntry?.[0] ?? null;
  }, [activeTileId, tileLayout.root]);

  const getPreferredWorkspaceTerminalTarget = useCallback((repoPath?: string | null, preferredTileId?: string | null) => {
    const targetTileId = findPreferredWorkspaceTerminalTileId(repoPath, preferredTileId);
    if (!targetTileId) return null;
    const handle = workspaceTerminalHandlesRef.current.get(targetTileId);
    return handle ? { tileId: targetTileId, handle } : null;
  }, [findPreferredWorkspaceTerminalTileId]);

  const activeWorkspaceChatSessionKey = useMemo(() => {
    const openTerminalTileIds = new Set(collectTerminalLeafIds(tileLayout.root));
    if (activeTileId && workspaceChatSessionByTileId[activeTileId]) {
      return workspaceChatSessionByTileId[activeTileId];
    }
    const preferredRepoPath = workspaceTerminalPreferredRepo?.localPath ?? null;
    if (preferredRepoPath) {
      const matchingTerminalLeaf = findTerminalLeafByRepoPath(tileLayout.root, preferredRepoPath);
      if (matchingTerminalLeaf && workspaceChatSessionByTileId[matchingTerminalLeaf.id]) {
        return workspaceChatSessionByTileId[matchingTerminalLeaf.id];
      }
    }
    return Object.entries(workspaceChatSessionByTileId)
      .find(([tileId, value]) => openTerminalTileIds.has(tileId) && Boolean(value))?.[1];
  }, [activeTileId, tileLayout.root, workspaceChatSessionByTileId, workspaceTerminalPreferredRepo?.localPath]);
  const activeWorkspaceLane = useMemo(() => {
    const openTerminalTileIds = new Set(collectTerminalLeafIds(tileLayout.root));
    if (activeTileId && workspaceLaneByTileId[activeTileId]) {
      return workspaceLaneByTileId[activeTileId];
    }
    const preferredRepoPath = workspaceTerminalPreferredRepo?.localPath ?? null;
    if (preferredRepoPath) {
      const matchingTerminalLeaf = findTerminalLeafByRepoPath(tileLayout.root, preferredRepoPath);
      if (matchingTerminalLeaf && workspaceLaneByTileId[matchingTerminalLeaf.id]) {
        return workspaceLaneByTileId[matchingTerminalLeaf.id];
      }
    }
    const fallback = Object.entries(workspaceLaneByTileId)
      .find(([tileId, lane]) => openTerminalTileIds.has(tileId) && Boolean(lane))?.[1] ?? null;
    return fallback;
  }, [activeTileId, tileLayout.root, workspaceLaneByTileId, workspaceTerminalPreferredRepo?.localPath]);

  const workspaceChatSessions = useMemo(() => {
    if (activeTileId && workspaceChatSessionsByTileId[activeTileId]?.length) {
      return workspaceChatSessionsByTileId[activeTileId];
    }
    const preferredRepoPath = workspaceTerminalPreferredRepo?.localPath ?? null;
    if (preferredRepoPath) {
      const matchingTerminalLeaf = findTerminalLeafByRepoPath(tileLayout.root, preferredRepoPath);
      if (matchingTerminalLeaf && workspaceChatSessionsByTileId[matchingTerminalLeaf.id]?.length) {
        return workspaceChatSessionsByTileId[matchingTerminalLeaf.id];
      }
    }
    return Object.values(workspaceChatSessionsByTileId).find((sessions) => sessions.length > 0) ?? [];
  }, [activeTileId, tileLayout.root, workspaceChatSessionsByTileId, workspaceTerminalPreferredRepo?.localPath]);
  const ideWorkspaceSessionsForSidebar = useMemo(() => {
    const deduped = new Map<string, MobileInboxSnapshot['sessions'][number]>();
    for (const sessions of Object.values(workspaceChatSessionsByTileId)) {
      for (const session of sessions) {
        if (!session?.sessionKey) continue;
        deduped.set(session.sessionKey, session);
      }
    }
    return [...deduped.values()];
  }, [workspaceChatSessionsByTileId]);
  const workspaceChatTargets = useMemo(
    () => buildWorkspaceChatTargetOptions(workspaceChatSessions),
    [workspaceChatSessions],
  );
  const workspaceChatTargetRepoPath = workspaceSidePanelRepoPath
    ?? workspaceTerminalPreferredRepo?.localPath
    ?? globalRepoEntry?.localPath
    ?? '__global__';
  const activeWorkspaceChatTargetKey = useMemo(() => {
    const preferredTargetKey = workspaceChatTargetKeyByRepoPath[workspaceChatTargetRepoPath];
    if (preferredTargetKey && workspaceChatTargets.some((target) => target.sessionKey === preferredTargetKey)) {
      return preferredTargetKey;
    }
    if (activeWorkspaceChatSessionKey && workspaceChatTargets.some((target) => target.sessionKey === activeWorkspaceChatSessionKey)) {
      return activeWorkspaceChatSessionKey;
    }
    return workspaceChatTargets[0]?.sessionKey ?? null;
  }, [activeWorkspaceChatSessionKey, workspaceChatTargetKeyByRepoPath, workspaceChatTargetRepoPath, workspaceChatTargets]);
  const workspaceChatTargetOption = useMemo(
    () => workspaceChatTargets.find((target) => target.sessionKey === activeWorkspaceChatTargetKey) ?? null,
    [activeWorkspaceChatTargetKey, workspaceChatTargets],
  );
  const workspaceChatTargetLabel = workspaceChatTargetOption?.label ?? null;
  const showEmptyWorkspaceChatRail = globalRepoEntries.length === 0 && !activeWorkspaceLane;
  const activeSurfaceRepoPath = useMemo(() => {
    if (!activeTileId) return null;
    const activeTile = findTile(tileLayout.root, activeTileId);
    if (activeTile?.type === 'leaf' && activeTile.content.kind === 'terminal') {
      return activeTile.content.repoPath ?? null;
    }
    return null;
  }, [activeTileId, tileLayout.root]);

  useEffect(() => {
    const openTerminalTileIds = new Set(collectTerminalLeafIds(tileLayout.root));
    setWorkspaceChatSessionByTileId((current) => {
      const next = Object.entries(current).reduce<Record<string, string | undefined>>((result, [tileId, value]) => {
        if (openTerminalTileIds.has(tileId)) result[tileId] = value;
        return result;
      }, {});
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setWorkspaceChatSessionsByTileId((current) => {
      const next = Object.entries(current).reduce<Record<string, MobileInboxSnapshot['sessions']>>((result, [tileId, value]) => {
        if (openTerminalTileIds.has(tileId)) result[tileId] = value;
        return result;
      }, {});
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setWorkspaceLaneByTileId((current) => {
      const next = Object.entries(current).reduce<Record<string, WorkspaceLaneState | null>>((result, [tileId, value]) => {
        if (openTerminalTileIds.has(tileId)) result[tileId] = value;
        return result;
      }, {});
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [tileLayout.root]);

  useEffect(() => {
    const preferredRepoPath = workspaceTerminalPreferredRepo?.localPath ?? null;
    if (!preferredRepoPath) return;
    if (collectOpenTerminalRepoPaths(tileLayout.root).length > 0) return;
    const firstUnscopedLeaf = findUnscopedTerminalLeaf(tileLayout.root);
    if (!firstUnscopedLeaf) return;
    setTerminalTileRepoScope(firstUnscopedLeaf.id, preferredRepoPath);
  }, [setTerminalTileRepoScope, tileLayout.root, workspaceTerminalPreferredRepo?.localPath]);

  const ensureWorkspaceTerminalTile = useCallback((repoPath?: string | null, preferredTileId?: string | null) => {
    const normalizedRepoPath = repoPath ?? null;
    const preferredTile = findPreferredWorkspaceTerminalTileId(normalizedRepoPath, preferredTileId);
    if (preferredTile) {
      if (normalizedRepoPath) {
        setTerminalTileRepoScope(preferredTile, normalizedRepoPath);
      }
      setActiveTileId(preferredTile);
      return preferredTile;
    }

    const workspaceTarget = findWorkspaceTarget();
    if (workspaceTarget) {
      setTileLayout((current) => ({
        ...current,
        root: replaceTileContent(current.root, workspaceTarget.id, {
          kind: 'terminal',
          repoPath: normalizedRepoPath,
        }),
      }));
      setActiveTileId(workspaceTarget.id);
      return workspaceTarget.id;
    }

    const targetLeaf = findInsertionTarget(['terminal', 'workspace']);
    const result = splitTile(
      tileLayout.root,
      targetLeaf.id,
      'vertical',
      {
        kind: 'terminal',
        repoPath: normalizedRepoPath,
      },
      0.58,
    );
    if (!result.newTileId) {
      return null;
    }
    setTileLayout((current) => ({
      ...current,
      root: result.root,
    }));
    setActiveTileId(result.newTileId);
    return result.newTileId;
  }, [findInsertionTarget, findPreferredWorkspaceTerminalTileId, findWorkspaceTarget, setTerminalTileRepoScope, tileLayout.root]);

  const setCanvasTileRepoScope = useCallback((tileId: string, repoPath: string | null) => {
    setTileLayout((current) => {
      const tile = findTile(current.root, tileId);
      if (tile?.type !== 'leaf' || tile.content.kind !== 'canvas') {
        return current;
      }
      const nextRepoPath = repoPath ?? null;
      if ((tile.content.repoPath ?? null) === nextRepoPath) {
        return current;
      }
      return {
        ...current,
        root: replaceTileContent(current.root, tileId, {
          kind: 'canvas',
          repoPath: nextRepoPath,
        }),
      };
    });
  }, []);

  const findPreferredCanvasTileId = useCallback((repoPath?: string | null, preferredTileId?: string | null) => {
    const normalizedRepoPath = repoPath ?? null;
    if (preferredTileId) {
      const preferredTile = findTile(tileLayout.root, preferredTileId);
      if (preferredTile?.type === 'leaf' && preferredTile.content.kind === 'canvas') {
        const preferredRepoPath = preferredTile.content.repoPath ?? null;
        if (!normalizedRepoPath || preferredRepoPath === normalizedRepoPath || preferredRepoPath === null) {
          return preferredTileId;
        }
      }
    }

    if (normalizedRepoPath) {
      const matchingLeaf = findCanvasLeafByRepoPath(tileLayout.root, normalizedRepoPath);
      if (matchingLeaf) {
        return matchingLeaf.id;
      }
    }

    if (activeTileId) {
      const activeTile = findTile(tileLayout.root, activeTileId);
      if (activeTile?.type === 'leaf' && activeTile.content.kind === 'canvas') {
        const activeRepoPath = activeTile.content.repoPath ?? null;
        if (!normalizedRepoPath || activeRepoPath === normalizedRepoPath || activeRepoPath === null) {
          return activeTileId;
        }
      }
    }

    if (normalizedRepoPath) {
      const unscopedLeaf = findUnscopedCanvasLeaf(tileLayout.root);
      const unscopedState = unscopedLeaf ? canvasStateByTileIdRef.current[unscopedLeaf.id] : null;
      if (unscopedLeaf && (!unscopedState || unscopedState.tabs.length === 0)) {
        return unscopedLeaf.id;
      }
      return null;
    }

    const existingLeaf = findUnscopedCanvasLeaf(tileLayout.root);
    return existingLeaf?.id ?? null;
  }, [activeTileId, tileLayout.root]);

  const ensureCanvasTile = useCallback((repoPath?: string | null, preferredTileId?: string | null) => {
    const normalizedRepoPath = repoPath ?? null;
    const preferredTile = findPreferredCanvasTileId(normalizedRepoPath, preferredTileId);
    if (preferredTile) {
      if (normalizedRepoPath) {
        setCanvasTileRepoScope(preferredTile, normalizedRepoPath);
      }
      setActiveTileId(preferredTile);
      return preferredTile;
    }

    const workspaceTarget = findWorkspaceTarget();
    if (workspaceTarget) {
      setTileLayout((current) => ({
        ...current,
        root: replaceTileContent(current.root, workspaceTarget.id, {
          kind: 'canvas',
          repoPath: normalizedRepoPath,
        }),
      }));
      setActiveTileId(workspaceTarget.id);
      return workspaceTarget.id;
    }

    const repoTerminalLeaf = normalizedRepoPath
      ? findTerminalLeafByRepoPath(tileLayout.root, normalizedRepoPath)
      : null;
    if (repoTerminalLeaf) {
      const result = splitTile(
        tileLayout.root,
        repoTerminalLeaf.id,
        'horizontal',
        {
          kind: 'canvas',
          repoPath: normalizedRepoPath,
        },
        0.62,
      );
      if (result.newTileId) {
        setTileLayout((current) => ({
          ...current,
          root: result.root,
        }));
        setActiveTileId(result.newTileId);
        return result.newTileId;
      }
    }

    const targetLeaf = findInsertionTarget(['terminal', 'canvas', 'preview', 'workspace']);
    const result = splitTile(
      tileLayout.root,
      targetLeaf.id,
      'horizontal',
      {
        kind: 'canvas',
        repoPath: normalizedRepoPath,
      },
      0.62,
    );
    if (!result.newTileId) {
      return null;
    }
    setTileLayout((current) => ({
      ...current,
      root: result.root,
    }));
    setActiveTileId(result.newTileId);
    return result.newTileId;
  }, [findInsertionTarget, findPreferredCanvasTileId, findWorkspaceTarget, setCanvasTileRepoScope, tileLayout.root]);

  // Terminal WS hook — routes events to WorkspaceTerminal + ContextualPanel
  const terminalWsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onTerminalCreated: (sessionName: string, requestId?: string) => {
      setDashTermSession(sessionName);
      let claimed = false;

      for (const handle of contextualPanelHandlesRef.current.values()) {
        claimed = handle.onSessionCreated(sessionName, requestId) || claimed;
        if (claimed) break;
      }

      if (!claimed) {
        for (const handle of workspaceTerminalHandlesRef.current.values()) {
          claimed = handle.onSessionCreated(sessionName, requestId) || claimed;
          if (claimed) break;
        }
      }
    },
    onTerminalData: (sessionName: string, data: string) => {
      terminalRef.current?.writeToTerminal(data);
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        handle.writeToTerminal(sessionName, data);
      }
      for (const handle of contextualPanelHandlesRef.current.values()) {
        handle.writeToTerminal(sessionName, data);
      }
    },
    onTerminalError: (sessionName: string, error: string) => {
      terminalRef.current?.setTermError(error);
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        handle.setTermError(sessionName, error);
      }
      for (const handle of contextualPanelHandlesRef.current.values()) {
        handle.setTermError(sessionName, error);
      }
    },
    onTerminalExited: (sessionName: string, _exitCode: number) => {
      terminalRef.current?.setTermExited(true);
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        handle.setTermExited(sessionName);
      }
      for (const handle of contextualPanelHandlesRef.current.values()) {
        handle.setTermExited(sessionName);
      }
    },
    onTerminalImage: (sessionName: string, imageB64: string, filename: string) => {
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        handle.showImage(sessionName, imageB64, filename);
      }
      for (const handle of contextualPanelHandlesRef.current.values()) {
        handle.showImage(sessionName, imageB64, filename);
      }
    },
    onAgentLifecycle: (sessionName: string, state: string, exitCode?: number) => {
      setLifecycleEvents(prev => {
        const next = new Map(prev);
        next.set(sessionName, { state, exitCode, ts: Date.now() });
        return next;
      });
    },
  }), []);

  const {
    isConnected: termWsConnected,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
    sendAgentKill,
  } = useSharedDesktopWs(undefined, terminalWsCallbacks);

  // Terminal auto-creation now handled by WorkspaceTerminal component

  // ── Alert system ──
  const {
    alerts: activeAlerts,
    unreadCount,
    markRead,
    markAllRead,
    dismiss,
    dismissAll,
    updateAgents,
  } = useAlerts();

  // ── Approval count for NavRail badge ──
  const [approvalCount, setApprovalCount] = useState(0);
  const [resolvedApprovalCount, setResolvedApprovalCount] = useState(0);
  useEffect(() => {
    let cancelled = false;

    function fetchCount() {
      fetch('/api/panel/approvals?status=all')
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          const approvals = (data.approvals ?? []) as ApprovalRecord[];
          setApprovalCount(approvals.filter((approval) => approval.status === 'pending').length);
          setResolvedApprovalCount(approvals.filter((approval) => approval.status !== 'pending').length);
        })
        .catch(() => {});
    }
    // Keep approval and resolution state fairly fresh so discovery cues track the operator flow.
    const initTimer = setTimeout(fetchCount, 1_500);
    const id = setInterval(fetchCount, 5_000);
    return () => {
      cancelled = true;
      clearTimeout(initTimer);
      clearInterval(id);
    };
  }, []);

  // ── Cmd+J to toggle Thoughts Card ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable = Boolean(
        target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]'),
      );
      if (isEditable) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setThoughtsOpen(v => !v);
      }
      if (e.key === 'Escape') {
        setThoughtsOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Tile layout persistence + helpers ──
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const restoreTimer = window.setTimeout(() => {
      const restored = deserializeTileLayout(window.localStorage.getItem(TILE_LAYOUT_STORAGE_KEY));
      const nextLayout = restored ?? createDefaultTileLayout();
      const storedActiveTileId = window.localStorage.getItem(ACTIVE_TILE_STORAGE_KEY);
      const restoredActiveTileId = storedActiveTileId && findTile(nextLayout.root, storedActiveTileId)
        ? storedActiveTileId
        : getFirstLeaf(nextLayout.root).id;
      setTileLayout(nextLayout);
      setActiveTileId(restoredActiveTileId);
      setTileLayoutHydrated(true);
    }, 0);

    return () => window.clearTimeout(restoreTimer);
  }, []);

  useEffect(() => {
    if (!tileLayoutHydrated || typeof window === 'undefined') return;
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(tileLayout));
  }, [tileLayout, tileLayoutHydrated]);

  useEffect(() => {
    if (!tileLayoutHydrated || typeof window === 'undefined' || !activeTileId) return;
    if (!findTile(tileLayout.root, activeTileId)) return;
    window.localStorage.setItem(ACTIVE_TILE_STORAGE_KEY, activeTileId);
  }, [activeTileId, tileLayout.root, tileLayoutHydrated]);

  const lastPersistedIdeSurfaceSignatureRef = useRef('');
  useEffect(() => {
    if (!tileLayoutHydrated || typeof window === 'undefined') return;
    const terminalRepoPaths = Array.from(new Set(collectOpenTerminalRepoPaths(tileLayout.root)));
    const activeRepoPath = workspaceTerminalPreferredRepo?.localPath ?? null;
    if (activeRepoPath && !terminalRepoPaths.includes(activeRepoPath)) {
      terminalRepoPaths.push(activeRepoPath);
    }
    const signature = JSON.stringify({
      terminalRepoPaths: [...terminalRepoPaths].sort(),
      activeRepoPath,
    });
    if (lastPersistedIdeSurfaceSignatureRef.current === signature) return;
    lastPersistedIdeSurfaceSignatureRef.current = signature;
    void fetch('/api/panel/ide-surface', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: signature,
    }).catch(() => undefined);
  }, [tileLayout.root, tileLayoutHydrated, workspaceTerminalPreferredRepo?.localPath]);

  const bottomPanelVisible = useMemo(
    () => Boolean(findLeafByContentKind(tileLayout.root, 'contextual-panel')),
    [tileLayout.root],
  );
  const hasThoughtsTile = useMemo(
    () => Boolean(findLeafByContentKind(tileLayout.root, 'thoughts')),
    [tileLayout.root],
  );

  const handleCloseTile = useCallback((tileId: string) => {
    // Never close the WorkspaceTerminal tile
    const tile = findTile(tileLayout.root, tileId);
    // Protect the LAST terminal tile — but allow closing extras
    if (tile?.type === 'leaf' && tile.content.kind === 'terminal') {
      const allTerminals = collectLeafContentKinds(tileLayout.root).filter(k => k === 'terminal');
      if (allTerminals.length <= 1) return; // Can't close the last one
    }
    const result = closeTile(tileLayout.root, tileId);
    if (!result.closed) {
      return;
    }
    setTileLayout({
      ...tileLayout,
      root: result.root,
    });
    if (tile?.type === 'leaf' && tile.content.kind === 'canvas') {
      setCanvasStateByTileId((prev) => {
        if (!prev[tileId]) return prev;
        const next = { ...prev };
        delete next[tileId];
        return next;
      });
    }
    if (activeTileId === tileId || (activeTileId && !findTile(result.root, activeTileId))) {
      const sibling = findSiblingLeaf(tileLayout.root, tileId);
      const nextActive = (sibling && findTile(result.root, sibling.id)) ? sibling.id : getFirstLeaf(result.root).id;
      setActiveTileId(nextActive);
    }
  }, [activeTileId, tileLayout]);

  const handleResizeSplit = useCallback((splitId: string, ratio: number) => {
    setTileLayout({
      ...tileLayout,
      root: resizeTile(tileLayout.root, splitId, ratio),
    });
  }, [tileLayout]);

  const handleSplitTile = useCallback((tileId: string, direction: 'horizontal' | 'vertical') => {
    const ratio = direction === 'vertical' ? 0.55 : 0.62;
    // Split creates the same type: workspace splits → new terminal (chat), contextual splits → new contextual (shell)
    const sourceTile = findTile(tileLayout.root, tileId);
    const sourceKind = sourceTile?.type === 'leaf' ? sourceTile.content.kind : 'workspace';
    const newKind = sourceKind === 'contextual-panel' ? 'contextual-panel' : 'terminal';
    const nextContent = sourceTile?.type === 'leaf'
      && sourceTile.content.kind === 'terminal'
      && newKind === 'terminal'
      ? {
          kind: 'terminal' as const,
          repoPath: null,
          createdFromSplit: true,
        }
      : createTileContent(newKind);
    const result = splitTile(tileLayout.root, tileId, direction, nextContent, ratio);
    if (!result.newTileId) {
      return;
    }
    setTileLayout({
      ...tileLayout,
      root: result.root,
    });
    setActiveTileId(result.newTileId);
  }, [tileLayout]);

  const ensureTileKind = useCallback((
    kind: TileContentKind,
    options?: {
      direction?: 'horizontal' | 'vertical';
      preferredKinds?: TileContentKind[];
      ratio?: number;
      selectedPreviewId?: string | null;
    },
  ) => {
    const existingLeaf = findLeafByContentKind(tileLayout.root, kind);
    if (existingLeaf) {
      if (kind === 'preview' && options?.selectedPreviewId && existingLeaf.content.kind === 'preview') {
        setTileLayout({
          ...tileLayout,
          root: replaceTileContent(tileLayout.root, existingLeaf.id, {
            kind: 'preview',
            selectedPreviewId: options.selectedPreviewId,
          }),
        });
      }
      setActiveTileId(existingLeaf.id);
      return existingLeaf.id;
    }

    if (kind === 'contextual-panel') {
      const result = wrapRootWithSplit(
        tileLayout.root,
        options?.direction ?? 'horizontal',
        createTileContent('contextual-panel'),
        options?.ratio ?? 0.68,
      );
      setTileLayout({
        ...tileLayout,
        root: result.root,
      });
      setActiveTileId(result.newTileId);
      return result.newTileId;
    }

    const workspaceTarget = findWorkspaceTarget();
    if (workspaceTarget) {
      const nextContent = kind === 'preview'
        ? {
          kind: 'preview' as const,
          selectedPreviewId: options?.selectedPreviewId ?? workspacePreviews[0]?.id ?? null,
        }
        : createTileContent(kind);
      setTileLayout({
        ...tileLayout,
        root: replaceTileContent(tileLayout.root, workspaceTarget.id, nextContent),
      });
      setActiveTileId(workspaceTarget.id);
      return workspaceTarget.id;
    }

    const targetLeaf = findInsertionTarget(options?.preferredKinds ?? ['terminal']);
    const nextContent = kind === 'preview'
      ? {
        kind: 'preview' as const,
        selectedPreviewId: options?.selectedPreviewId ?? workspacePreviews[0]?.id ?? null,
      }
      : createTileContent(kind);
    const result = splitTile(
      tileLayout.root,
      targetLeaf.id,
      options?.direction ?? 'horizontal',
      nextContent,
      options?.ratio ?? 0.6,
    );

    if (!result.newTileId) {
      return null;
    }

    setTileLayout({
      ...tileLayout,
      root: result.root,
    });
    setActiveTileId(result.newTileId);
    return result.newTileId;
  }, [findInsertionTarget, findWorkspaceTarget, tileLayout, workspacePreviews]);

  const waitForWorkspaceTerminalTarget = useCallback(async (options?: {
    repoPath?: string | null;
    preferredTileId?: string | null;
    fallbackToAnyExisting?: boolean;
  }) => {
    const repoPath = options?.repoPath ?? null;
    const preferredTileId = options?.preferredTileId ?? null;
    const initial = getPreferredWorkspaceTerminalTarget(repoPath, preferredTileId);
    if (initial) {
      setActiveTileId(initial.tileId);
      return initial;
    }

    const fallbackExisting = workspaceTerminalHandlesRef.current.entries().next().value as [string, TerminalTabHandle] | undefined;
    if (options?.fallbackToAnyExisting !== false && fallbackExisting) {
      const [tileId, handle] = fallbackExisting;
      setActiveTileId(tileId);
      return { tileId, handle };
    }

    const ensuredTileId = ensureWorkspaceTerminalTile(repoPath, preferredTileId);

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      const target = getPreferredWorkspaceTerminalTarget(repoPath, (ensuredTileId ?? preferredTileId) ?? undefined);
      if (target) {
        if (repoPath) {
          setTerminalTileRepoScope(target.tileId, repoPath);
        }
        setActiveTileId(target.tileId);
        return target;
      }
    }

    if (ensuredTileId) {
      const awaitedHandle = await new Promise<TerminalTabHandle | null>((resolve) => {
        const timeoutId = window.setTimeout(() => {
          pendingWorkspaceTerminalResolversRef.current.delete(ensuredTileId);
          resolve(null);
        }, 12_000);
        pendingWorkspaceTerminalResolversRef.current.set(ensuredTileId, (handle) => {
          window.clearTimeout(timeoutId);
          resolve(handle);
        });
      });

      if (awaitedHandle) {
        if (repoPath) {
          setTerminalTileRepoScope(ensuredTileId, repoPath);
        }
        setActiveTileId(ensuredTileId);
        return { tileId: ensuredTileId, handle: awaitedHandle };
      }
    }

    throw new Error('Unable to attach the packet to a workspace lane. The workspace surface did not become ready in time.');
  }, [ensureWorkspaceTerminalTile, getPreferredWorkspaceTerminalTarget, setTerminalTileRepoScope]);

  const openWorkspaceTabForLane = useCallback(async (lane: {
    laneId?: string | null;
    packetId?: string | null;
    packetReferenceLabel?: string | null;
    packetTitle?: string | null;
    sessionKey: string;
    runtime: 'codex' | 'claude-code';
    repoPath: string;
    status?: string | null;
    branch?: string | null;
  }) => {
    const opened = openedLaneSessionsCache();
    if (opened.has(lane.sessionKey)) return;
    opened.add(lane.sessionKey);
    try {
      const packet = lane.packetId
        ? thoughtsMissionState.packets.find((candidate) => candidate.id === lane.packetId) ?? null
        : null;
      const targetScope = workspaceScopeEntries.find((entry) => entry.localPath === lane.repoPath)
        ?? workspaceScopeEntries.find((entry) => pathBelongsToRepoScope(lane.repoPath, entry.localPath))
        ?? null;
      const target = await waitForWorkspaceTerminalTarget({
        repoPath: lane.repoPath,
        fallbackToAnyExisting: false,
      });
      const packetTitle = packet?.title ?? lane.packetTitle ?? targetScope?.name ?? 'Dispatched Agent';
      const packetReferenceLabel = packet?.referenceLabel ?? lane.packetReferenceLabel ?? lane.laneId ?? 'Lane';
      const packetStatus = packet && packet.status !== 'queued' && packet.status !== 'draft'
        ? packet.status
        : packetStatusFromLaneStatus(lane.status);
      target.handle.openCliChatSession({
        runtime: lane.runtime,
        repo: targetScope ? {
          name: targetScope.name,
          localPath: targetScope.localPath,
          branch: targetScope.branch ?? 'main',
          readiness: targetScope.readiness ?? null,
          remoteUrl: targetScope.remoteUrl ?? undefined,
          registryRepoId: targetScope.registryRepoId,
          isWorktree: targetScope.isWorktree ?? false,
          worktreeStatus: targetScope.worktreeStatus ?? null,
        } : undefined,
        targetSessionKey: lane.sessionKey,
        label: packetTitle,
        createNew: false,
        orchestrationPacket: lane.packetId
          ? {
              packetId: lane.packetId,
              referenceLabel: packetReferenceLabel,
              title: packetTitle,
              status: packetStatus,
              runtime: lane.runtime,
              branchTarget: lane.branch ?? packet?.branchTarget ?? null,
            }
          : null,
        autoArchiveOnIdle: false,
      });
      setActiveTileId(target.tileId);
      setActiveWorkspace(lane.repoPath);
      console.log(`[packet-dispatch-workspace] Surfaced ${lane.sessionKey} in workspace tile ${target.tileId}`);
    } catch (error) {
      opened.delete(lane.sessionKey);
      console.error('[packet-dispatch-workspace] Failed to surface dispatched lane:', error);
    }
  }, [thoughtsMissionState.packets, waitForWorkspaceTerminalTarget, workspaceScopeEntries]);

  const realtimeDispatchCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onRealtimeEvent: (event: RealtimeEventEnvelope) => {
      if (event.channel !== 'mutation') return;
      if (event.event !== 'mutation.record' && event.event !== 'mutation.settled') return;
      const mutation = (event.data as { mutation?: RealtimeMutationRecord }).mutation;
      if (!mutation || mutation.action !== 'packet-dispatch' || mutation.status === 'failed') return;
      if (!mutation.sessionKey || !mutation.repoPath) return;

      void openWorkspaceTabForLane({
        laneId: mutation.laneId ?? null,
        packetId: mutation.packetId ?? null,
        packetReferenceLabel: mutation.packetReferenceLabel ?? null,
        packetTitle: mutation.packetTitle ?? null,
        sessionKey: mutation.sessionKey,
        runtime: mutation.runtime === 'claude-code' ? 'claude-code' : 'codex',
        repoPath: mutation.repoPath,
        status: 'launching',
        branch: mutation.branch ?? null,
      });
      void refreshWorkspaceLifecycle();
      void loadOrchestratorMissionState();
    },
    onLaneLifecycle: () => {
      void refreshWorkspaceLifecycle();
      void loadOrchestratorMissionState();
    },
  }), [openWorkspaceTabForLane, refreshWorkspaceLifecycle]);

  useSharedDesktopWs(undefined, realtimeDispatchCallbacks);

  // ── Auto-open chat tabs for delegated lane sessions ──
  // Uses a global queue on window that survives HMR rebuilds, plus periodic lane polling.
  useEffect(() => {
    async function pollLanes() {
      try {
        const res = await fetch('/api/lanes?active=true');
        if (!res.ok) return;
        const data = await res.json();
        for (const lane of (data.lanes ?? []) as Array<{
          id: string; label: string; packetId: string | null; sessionKey: string | null;
          status: string; runtime: string; repoPath: string;
          branch?: string;
        }>) {
          if (!lane.sessionKey) continue;
          if (lane.status !== 'running' && lane.status !== 'launching') continue;
          void openWorkspaceTabForLane({
            laneId: lane.id,
            packetId: lane.packetId,
            packetReferenceLabel: null,
            packetTitle: lane.label,
            sessionKey: lane.sessionKey,
            runtime: lane.runtime === 'claude-code' ? 'claude-code' : 'codex',
            repoPath: lane.repoPath,
            status: lane.status,
            branch: lane.branch ?? null,
          });
        }
      } catch { /* best-effort */ }
    }

    // Poll after a short delay, then every 15s (WS delivers real-time updates; this is a safety net)
    const initTimer = setTimeout(pollLanes, 2_000);
    const id = setInterval(pollLanes, 15_000);
    return () => { clearTimeout(initTimer); clearInterval(id); };
  }, [openWorkspaceTabForLane]);

  const collectOrchestratorLaneSnapshots = useCallback((): OrchestratorLaneSnapshot[] => (
    Array.from(workspaceTerminalHandlesRef.current.values()).flatMap((handle) => handle.getChatTabSnapshots())
  ), []);

  const areWorkspaceTerminalRestoresSettled = useCallback(() => {
    const terminalTileIds = collectTerminalLeafIds(tileLayout.root);
    if (terminalTileIds.length === 0) return false;
    return terminalTileIds.every((tileId) => {
      const handle = workspaceTerminalHandlesRef.current.get(tileId);
      return handle?.isRestoreSettled() ?? false;
    });
  }, [tileLayout.root]);

  const focusOrchestrationPacketLane = useCallback((packet: OrchestratorPacket) => {
    if (!packet.lane) return;
    const handle = workspaceTerminalHandlesRef.current.get(packet.lane.tileId);
    if (!handle) return;
    setActiveTileId(packet.lane.tileId);
    handle.focusTab(packet.lane.tabId);
  }, []);

  const launchOrchestrationPacket = useCallback(async (packet: OrchestratorPacket): Promise<OrchestratorLaneBinding | null> => {
    if (packet.lane) {
      focusOrchestrationPacketLane(packet);
      return packet.lane;
    }

    // ── Create a lane for this packet ──
    let laneId: string | null = null;
    const laneApi = async (body: Record<string, unknown>) => {
      try {
        const res = await fetch('/api/lanes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await res.json().catch(() => ({})) as Record<string, unknown>;
      } catch { return {}; }
    };
    try {
      const laneData = await laneApi({
        verb: 'open_lane',
        repoPath: packet.workspaceTargetPath ?? workspaceTerminalPreferredRepo?.localPath ?? '',
        branch: packet.branchTarget || 'main',
        runtime: packet.runtime,
        label: packet.title,
        packetId: packet.id,
        actor: 'user',
      });
      if (laneData.ok && laneData.laneId) {
        laneId = laneData.laneId as string;
        console.log(`[orchestrator] Lane created: ${laneId} for packet ${packet.referenceLabel}`);
      }
    } catch {
      console.warn('[orchestrator] Lane creation failed, continuing without lane tracking');
    }

    let targetScope = workspaceScopeEntries.find((entry) => entry.localPath === packet.workspaceTargetPath)
      ?? workspaceTerminalPreferredRepo
      ?? workspaceScopeEntries[0]
      ?? null;
    const rootRepo = targetScope?.isWorktree
      ? globalRepoEntries.find((repo) => targetScope?.registryRepoId ? repo.id === targetScope.registryRepoId : targetScope.localPath.startsWith(`${repo.localPath}/`)) ?? null
      : globalRepoEntries.find((repo) => repo.localPath === targetScope?.localPath) ?? null;

    if (rootRepo) {
      const currentBranch = targetScope?.branch ?? rootRepo.readiness?.currentBranch ?? rootRepo.defaultBranch ?? 'main';
      const requestedBranch = packet.branchTarget.trim();
      if (targetScope?.isWorktree && (!requestedBranch || requestedBranch === targetScope.branch)) {
        // Existing targeted worktree already matches the packet target.
      } else {
      const existingWorktree = (allRepoWorktrees[rootRepo.localPath] ?? []).find((worktree) => worktree.branch === requestedBranch);
      if (existingWorktree) {
        targetScope = {
          registryRepoId: rootRepo.id,
          name: rootRepo.name,
          localPath: existingWorktree.path,
          branch: existingWorktree.branch,
          readiness: null,
          remoteUrl: rootRepo.remoteUrl ?? undefined,
          isWorktree: true,
          worktreeStatus: existingWorktree.status,
        };
      } else if (requestedBranch && requestedBranch !== currentBranch) {
        const response = await fetch('/api/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: rootRepo.localPath,
            agentType: packet.runtime,
            taskName: `${packet.referenceLabel}-${packet.title}`,
            branchName: requestedBranch,
            baseBranch: currentBranch,
            managed: packet.runtime === 'claude-code',
            skipSetup: true,
          }),
        });
        const payload = await response.json().catch(() => ({})) as { worktree?: WorktreeInfo; error?: string };
        if (!response.ok || !payload.worktree) {
          throw new Error(payload.error ?? 'Unable to create orchestrator worktree lane.');
        }
        setAllRepoWorktrees((current) => {
          const existing = current[rootRepo.localPath] ?? [];
          return {
            ...current,
            [rootRepo.localPath]: [
              ...existing.filter((worktree) => worktree.id !== payload.worktree!.id),
              payload.worktree!,
            ],
          };
        });
        targetScope = {
          registryRepoId: rootRepo.id,
          name: rootRepo.name,
          localPath: payload.worktree.path,
          branch: payload.worktree.branch,
          readiness: null,
          remoteUrl: rootRepo.remoteUrl ?? undefined,
          isWorktree: true,
          worktreeStatus: payload.worktree.status,
        };
      }
      }
    }

    const repoPath = targetScope?.localPath ?? workspaceTerminalPreferredRepo?.localPath ?? null;

    // Update lane with worktree path if one was created
    if (laneId && targetScope?.isWorktree && targetScope.localPath) {
      void laneApi({ verb: 'bind_worktree', laneId, worktreePath: targetScope.localPath, actor: 'system' });
    }

    const workspaceTarget = await waitForWorkspaceTerminalTarget({ repoPath });
    if (!workspaceTarget) {
      if (laneId) void laneApi({ verb: 'request_review', laneId, actor: 'system' });
      return null;
    }

    const tabId = workspaceTarget.handle.openCliChatSession({
      runtime: packet.runtime,
      repo: targetScope ? {
        name: targetScope.name,
        localPath: targetScope.localPath,
        branch: targetScope.branch ?? 'main',
        readiness: targetScope.readiness ?? null,
        remoteUrl: targetScope.remoteUrl ?? undefined,
        registryRepoId: targetScope.registryRepoId,
        isWorktree: targetScope.isWorktree ?? false,
        worktreeStatus: targetScope.worktreeStatus ?? null,
      } : undefined,
      initialText: buildOrchestrationPacketDraft(
        thoughtsMissionState,
        packet,
        targetScope?.name ?? targetScope?.localPath ?? null,
      ),
      autoSend: true,
      createNew: true,
      label: packet.title,
      orchestrationPacket: buildOrchestrationPacketBadge({
        ...packet,
        status: 'running',
      }),
      autoArchiveOnIdle: false,
    });
    enqueueFtuxMilestone('firstAgentSpawned');

    setActiveTileId(workspaceTarget.tileId);

    // ── Notify the lane that a session was created ──
    if (laneId) {
      void laneApi({ verb: 'attach_session', laneId, sessionKey: tabId, actor: 'system' });
    }

    return {
      tileId: workspaceTarget.tileId,
      tabId,
      repoPath,
      runtime: packet.runtime,
      laneId,
    };
  }, [
    allRepoWorktrees,
    enqueueFtuxMilestone,
    focusOrchestrationPacketLane,
    globalRepoEntries,
    thoughtsMissionState,
    waitForWorkspaceTerminalTarget,
    workspaceScopeEntries,
    workspaceTerminalPreferredRepo,
  ]);

  useEffect(() => {
    thoughtsMissionState.packets.forEach((packet) => {
      if (!packet.lane) return;
      const handle = workspaceTerminalHandlesRef.current.get(packet.lane.tileId);
      handle?.setOrchestrationPacket(packet.lane.tabId, buildOrchestrationPacketBadge(packet));
    });
  }, [thoughtsMissionState.packets]);

  const toggleContextualPanelTile = useCallback(() => {
    const existingLeaf = findLeafByContentKind(tileLayout.root, 'contextual-panel');
    if (existingLeaf) {
      if (countLeaves(tileLayout.root) > 1) {
        handleCloseTile(existingLeaf.id);
      }
      return;
    }
    ensureTileKind('contextual-panel', {
      direction: 'horizontal',
      ratio: 0.68,
    });
  }, [ensureTileKind, handleCloseTile, tileLayout]);

  const handlePreviewDetected = useCallback((preview: DetectedLocalhostPreview) => {
    setWorkspacePreviews((current) => {
      if (current.some((existing) => existing.port === preview.port)) {
        return current;
      }
      return [...current, preview];
    });
    ensureTileKind('preview', {
      direction: 'vertical',
      preferredKinds: ['terminal', 'contextual-panel'],
      ratio: 0.56,
      selectedPreviewId: preview.id,
    });
  }, [ensureTileKind]);

  const handleSelectPreviewTile = useCallback((tileId: string, previewId: string) => {
    const currentTile = findTile(tileLayout.root, tileId);
    if (currentTile?.type !== 'leaf' || currentTile.content.kind !== 'preview') {
      return;
    }
    setTileLayout({
      ...tileLayout,
      root: replaceTileContent(tileLayout.root, tileId, {
        kind: 'preview',
        selectedPreviewId: previewId,
      }),
    });
  }, [tileLayout]);

  const handleClosePreviewTileItem = useCallback((tileId: string, previewId: string) => {
    const preview = workspacePreviews.find((entry) => entry.id === previewId);
    if (!preview) {
      return;
    }

    const remainingPreviews = workspacePreviews.filter((entry) => entry.id !== previewId);
    setWorkspacePreviews(remainingPreviews);
    for (const handle of workspaceTerminalHandlesRef.current.values()) {
      handle.clearDetectedPreview(preview.port);
    }

    const currentTile = findTile(tileLayout.root, tileId);
    if (currentTile?.type !== 'leaf' || currentTile.content.kind !== 'preview') {
      return;
    }

    const nextSelectedPreviewId = currentTile.content.selectedPreviewId === previewId
      ? remainingPreviews[0]?.id ?? null
      : currentTile.content.selectedPreviewId ?? null;

    setTileLayout({
      ...tileLayout,
      root: replaceTileContent(tileLayout.root, tileId, {
        kind: 'preview',
        selectedPreviewId: nextSelectedPreviewId,
      }),
    });
  }, [tileLayout, workspacePreviews]);

  // ── Repo/global inspector tab state ──
  const [canvasStateByTileId, setCanvasStateByTileId] = useState<Record<string, CanvasTileState>>({});

  useEffect(() => {
    canvasStateByTileIdRef.current = canvasStateByTileId;
  }, [canvasStateByTileId]);

  const resolveCanvasTabRepoPath = useCallback((tab: CanvasTab) => {
    if (tab.kind === 'timeline' || tab.kind === 'memory' || tab.kind === 'welcome' || tab.kind === 'audit-log' || tab.kind === 'mermaid') {
      return null;
    }

    const repoSlug = tab.meta?.repo ?? null;
    if (repoSlug) {
      const matchedRepo = globalRepoEntries.find((repo) => repoSlugFromRemote(repo.remoteUrl) === repoSlug);
      if (matchedRepo) {
        return matchedRepo.localPath;
      }
    }

    const workspacePath = tab.meta?.workspace ?? (tab.kind === 'readme' || tab.kind === 'git-log' ? tab.resourceId : null);
    if (workspacePath) {
      const matchedRepo = globalRepoEntries.find((repo) => (
        workspacePath === repo.localPath
        || workspacePath.startsWith(`${repo.localPath}/`)
      ));
      if (matchedRepo) {
        return matchedRepo.localPath;
      }
    }

    switch (tab.kind) {
      case 'issue':
      case 'pr':
      case 'file':
      case 'diff':
      case 'commit':
      case 'readme':
      case 'ci':
      case 'new-issue':
      case 'git-log':
      case 'image':
        return globalRepoEntry?.localPath ?? null;
      default:
        return null;
    }
  }, [globalRepoEntries, globalRepoEntry]);

  const openCanvasInInspectorTile = useCallback((tab: CanvasTab, repoPath: string | null) => {
    const existingTileEntry = Object.entries(canvasStateByTileId).find(([, state]) => (
      state.tabs.some((entry) => entry.id === tab.id)
    ));
    if (existingTileEntry) {
      const [existingTileId, existingState] = existingTileEntry;
      if (repoPath) {
        setCanvasTileRepoScope(existingTileId, repoPath);
      }
      setActiveTileId(existingTileId);
      setCanvasStateByTileId((prev) => ({
        ...prev,
        [existingTileId]: {
          ...existingState,
          activeTabId: tab.id,
          revealKey: existingState.revealKey + 1,
        },
      }));
      return;
    }

    const targetTileId = ensureCanvasTile(repoPath);
    if (!targetTileId) {
      return;
    }

    setCanvasStateByTileId((prev) => {
      const current = prev[targetTileId] ?? { tabs: [], activeTabId: null, revealKey: 0 };
      const existingIndex = current.tabs.findIndex((entry) => entry.id === tab.id);
      const nextTabs = existingIndex >= 0
        ? current.tabs
        : [...current.tabs, tab];

      return {
        ...prev,
        [targetTileId]: {
          tabs: nextTabs,
          activeTabId: tab.id,
          revealKey: current.revealKey + 1,
        },
      };
    });
  }, [canvasStateByTileId, ensureCanvasTile, setCanvasTileRepoScope]);

  const openCanvasTab = useCallback((tab: CanvasTab) => {
    if (tab.kind === 'ci') {
      const repoPath = resolveCanvasTabRepoPath(tab);
      const repoEntry = repoPath
        ? globalRepoEntries.find((repo) => repo.localPath === repoPath) ?? null
        : (tab.meta?.repo
            ? globalRepoEntries.find((repo) => repoSlugFromRemote(repo.remoteUrl) === tab.meta?.repo) ?? null
            : null);
      openWorkspaceSidePanel('review', repoEntry ? {
        name: repoEntry.name,
        localPath: repoEntry.localPath,
        branch: repoEntry.readiness?.currentBranch ?? repoEntry.defaultBranch,
        readiness: repoEntry.readiness ?? null,
        remoteUrl: repoEntry.remoteUrl ?? undefined,
      } : null);
      return;
    }

    // Route all canvas tabs to workspace tabs — no more Inspector panel
    const repoPath = resolveCanvasTabRepoPath(tab);
    const repoEntry = repoPath
      ? globalRepoEntries.find((repo) => repo.localPath === repoPath) ?? null
      : null;
    void (async () => {
      const workspaceTarget = await waitForWorkspaceTerminalTarget(repoPath ? { repoPath } : {});
      if (workspaceTarget) {
        workspaceTarget.handle.openInspectorTab(tab, {
          repo: repoEntry ? {
            name: repoEntry.name,
            localPath: repoEntry.localPath,
            branch: repoEntry.readiness?.currentBranch ?? repoEntry.defaultBranch,
            readiness: repoEntry.readiness ?? null,
            remoteUrl: repoEntry.remoteUrl ?? undefined,
          } : undefined,
        });
        return;
      }
      // Last resort fallback — should rarely hit since workspace auto-creates
      openCanvasInInspectorTile(tab, repoPath);
    })();
  }, [globalRepoEntries, openCanvasInInspectorTile, openWorkspaceSidePanel, resolveCanvasTabRepoPath, waitForWorkspaceTerminalTarget]);

  const closeCanvasTab = useCallback((tileId: string, tabId: string) => {
    setCanvasStateByTileId((prev) => {
      const current = prev[tileId];
      if (!current) return prev;
      const nextTabs = current.tabs.filter((entry) => entry.id !== tabId);
      if (nextTabs.length === 0) {
        const next = { ...prev };
        delete next[tileId];
        return next;
      }
      return {
        ...prev,
        [tileId]: {
          ...current,
          tabs: nextTabs,
          activeTabId: current.activeTabId === tabId ? nextTabs[nextTabs.length - 1]?.id ?? null : current.activeTabId,
        },
      };
    });
  }, []);

  const selectCanvasTab = useCallback((tileId: string, tabId: string) => {
    setCanvasStateByTileId((prev) => {
      const current = prev[tileId];
      if (!current || current.activeTabId === tabId) {
        return prev;
      }
      return {
        ...prev,
        [tileId]: {
          ...current,
          activeTabId: tabId,
        },
      };
    });
  }, []);

  // ── Routing callbacks for AgentPanel ──
  const handleSelectSession = useCallback((sessionKey: string) => {
    // Agent clicks only change the chat session — terminal is independent
    setChatVisible(true);
    setRightPanelMode('chat');
    setActiveSessionKey(sessionKey);
  }, []);

  const handleSelectIssue = useCallback((issueNumber: number, repo?: string) => {
    openCanvasTab({
      id: `issue:${issueNumber}${repo ? `:${repo}` : ''}`,
      kind: 'issue',
      label: `#${issueNumber}`,
      resourceId: String(issueNumber),
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab]);

  const handleSelectPR = useCallback((prNumber: number, repo?: string) => {
    openCanvasTab({
      id: `pr:${prNumber}${repo ? `:${repo}` : ''}`,
      kind: 'pr',
      label: `PR #${prNumber}`,
      resourceId: String(prNumber),
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab]);

  const handleReviewPR = useCallback((prNumber: number, repo?: string) => {
    openWorkspaceSidePanel('review', getWorkspaceSidePanelRepoBySlug(repo), {
      pullRequestNumber: prNumber,
      compactReview: false,
    });
  }, [getWorkspaceSidePanelRepoBySlug, openWorkspaceSidePanel]);

  const handleDeepReviewPR = useCallback((prNumber: number, repo?: string) => {
    handleSelectPR(prNumber, repo);
    openWorkspaceSidePanel('review', getWorkspaceSidePanelRepoBySlug(repo), {
      pullRequestNumber: prNumber,
      compactReview: true,
    });
  }, [getWorkspaceSidePanelRepoBySlug, handleSelectPR, openWorkspaceSidePanel]);

  const handleExpandWorkspace = useCallback((workspace: string, repo: string | null) => {
    setActiveWorkspace(workspace);
    // Only open README tab if workspace actually has a README
    fetch(`/api/panel/readme?workspace=${encodeURIComponent(workspace)}`)
      .then(res => res.json())
      .then(data => {
        if (data.content) {
          openCanvasTab({
            id: `readme:${workspace}`,
            kind: 'readme',
            label: 'README',
            resourceId: workspace,
            meta: repo ? { repo } : undefined,
          });
        }
      })
      .catch(() => { /* no README, skip */ });
  }, [openCanvasTab]);

  const handleOpenGitLog = useCallback((workspace?: string) => {
    openWorkspaceSidePanel('git-log', getWorkspaceSidePanelRepoByPath(workspace));
  }, [getWorkspaceSidePanelRepoByPath, openWorkspaceSidePanel]);

  const handleOpenAuditLog = useCallback(() => {
    const tab: CanvasTab = {
      id: 'audit-log:approvals',
      kind: 'audit-log',
      label: 'Audit Log',
      resourceId: 'approvals',
    };
    void (async () => {
      const workspaceTarget = await waitForWorkspaceTerminalTarget({});
      if (workspaceTarget) {
        workspaceTarget.handle.openInspectorTab(tab);
        return;
      }
      openCanvasTab(tab);
    })();
  }, [openCanvasTab, waitForWorkspaceTerminalTarget]);

  const openApprovalsDiscoverySurface = useCallback(() => {
    setActiveNavSection('approvals');
    setShowMemoryView(false);
    setWorkspaceSidePanelView('review');
    setWorkspaceSidePanelCompactReview(false);
    setWorkspaceSidePanelActivationKey((value) => value + 1);
    if (!chatVisible) {
      setChatVisible(true);
    }
    setRightPanelMode('workspace');
  }, [chatVisible]);

  const handleToggleChatPanel = useCallback(() => {
    // v1: chat panel removed — toggle workspace instead
    if (chatVisible) {
      setChatVisible(false);
      return;
    }
    setChatVisible(true);
  }, [chatVisible]);

  const handleToggleWorkspacePanel = useCallback(() => {
    if (chatVisible && rightPanelMode === 'workspace') {
      setChatVisible(false);
      return;
    }
    const nextView = workspaceSidePanelView === 'review' || workspaceSidePanelView === 'diff'
      ? workspaceSidePanelView
      : lastWorkspacePanelViewRef.current;
    openWorkspaceSidePanel(nextView, workspaceSidePanelRepo);
  }, [chatVisible, openWorkspaceSidePanel, rightPanelMode, workspaceSidePanelRepo, workspaceSidePanelView]);

  useEffect(() => {
    if (rightPanelMode !== 'workspace') return;
    if (workspaceSidePanelPullRequestNumber) return;
    // [workspace-side-panel] Skip auto-sync when panel is in blank/idle state —
    // repo context will be set explicitly when a view is opened via openWorkspaceSidePanel.
    if (workspaceSidePanelView === 'blank') return;

    // Lane-scoped context: when the active lane has branch info, use it
    // so the review rail shows the selected lane's diff, not main's.
    let nextRepoContext: WorkspaceSidePanelRepo | null = null;
    if (activeWorkspaceLane?.repoPath && activeWorkspaceLane.branch) {
      const laneName = activeWorkspaceLane.repoPath.split('/').pop() ?? 'repo';
      nextRepoContext = {
        name: laneName,
        localPath: activeWorkspaceLane.repoPath,
        branch: activeWorkspaceLane.branch,
        readiness: null,
        isWorktree: activeWorkspaceLane.branch !== 'main',
      };
    }

    // Fall through to terminal/global when no lane branch context
    if (!nextRepoContext) {
      nextRepoContext = workspaceTerminalPreferredRepo
        ?? (globalRepoEntry ? {
          name: globalRepoEntry.name,
          localPath: globalRepoEntry.localPath,
          branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
          readiness: globalRepoEntry.readiness ?? null,
          remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
        } : null);
    }

    const nextRepoPath = nextRepoContext?.localPath
      ?? activeSurfaceRepoPath
      ?? workspaceTerminalPreferredRepo?.localPath
      ?? globalRepoEntry?.localPath
      ?? null;
    if (workspaceSidePanelRepoPath === nextRepoPath && sameWorkspaceSidePanelRepo(workspaceSidePanelRepoContext, nextRepoContext)) {
      return;
    }
    setWorkspaceSidePanelRepoPath(nextRepoPath);
    setWorkspaceSidePanelRepoContext(nextRepoContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- repoContext/repoPath are outputs, not inputs; including them creates a feedback loop
  }, [
    activeWorkspaceLane?.branch,
    activeWorkspaceLane?.repoPath,
    activeSurfaceRepoPath,
    globalRepoBranch,
    globalRepoEntry,
    rightPanelMode,
    workspaceSidePanelPullRequestNumber,
    workspaceSidePanelView,
    workspaceTerminalPreferredRepo?.localPath,
  ]);

  const handleSelectWorkspaceChatTarget = useCallback((sessionKey: string) => {
    setWorkspaceChatTargetKeyByRepoPath((current) => {
      if (current[workspaceChatTargetRepoPath] === sessionKey) {
        return current;
      }
      return {
        ...current,
        [workspaceChatTargetRepoPath]: sessionKey,
      };
    });
  }, [workspaceChatTargetRepoPath]);

  const handleOpenMemory = useCallback(() => {
    setShowMemoryView(true);
  }, []);

  const handlePreviewSelection = useCallback((selection: PreviewSelectionPayload) => {
    const payload: AgentPanelChatInjectionPayload = {
      reason: 'preview',
      text: formatPreviewSelectionContext(selection),
    };
    setChatVisible(true);
    setRightPanelMode('chat');
    setDesktopDraftInjection({
      id: `${payload.reason}-${Date.now()}`,
      text: payload.text,
    });
  }, []);

  const injectPayloadIntoRepoChat = useCallback((payload: AgentPanelChatInjectionPayload, repoOverride?: WorkspaceSidePanelRepo | null) => {
    const nextInjection = {
      id: `${payload.reason}-${Date.now()}`,
      text: payload.text,
    };
    if (thoughtsOpen) {
      setThoughtsDraftInjection(nextInjection);
      return;
    }
    if (hasThoughtsTile) {
      setThoughtsDraftInjection(nextInjection);
      return;
    }
    void (async () => {
      const targetRepo = repoOverride?.localPath ? repoOverride : (globalRepoEntry
        ? {
            name: globalRepoEntry.name,
            localPath: globalRepoEntry.localPath,
            branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
            readiness: globalRepoEntry.readiness ?? null,
            remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
          }
        : null);
      const targetRepoPath = targetRepo?.localPath ?? '__global__';
      const preferredChatTargetKey = workspaceChatTargetKeyByRepoPath[targetRepoPath]
        ?? (workspaceChatTargets.some((target) => target.sessionKey === activeWorkspaceChatSessionKey)
          ? activeWorkspaceChatSessionKey
          : workspaceChatTargets[0]?.sessionKey)
        ?? undefined;
      const workspaceTarget = await waitForWorkspaceTerminalTarget({
        repoPath: targetRepo?.localPath ?? null,
      });
      if (workspaceTarget) {
        setActiveTileId(workspaceTarget.tileId);
        if (targetRepo?.localPath) {
          setActiveWorkspace(targetRepo.localPath);
        }
        workspaceTarget.handle.injectIntoCliChat(payload.text, {
          repo: targetRepo ?? undefined,
          draftReason: payload.reason,
          targetSessionKey: preferredChatTargetKey,
        });
        return;
      }
      setChatVisible(true);
      setRightPanelMode('chat');
      setDesktopDraftInjection(nextInjection);
    })();
  }, [activeWorkspaceChatSessionKey, globalRepoBranch, globalRepoEntry, hasThoughtsTile, thoughtsOpen, waitForWorkspaceTerminalTarget, workspaceChatTargetKeyByRepoPath, workspaceChatTargets]);

  const handleAgentPanelChatInjection = useCallback((payload: AgentPanelChatInjectionPayload) => {
    injectPayloadIntoRepoChat(payload, null);
  }, [injectPayloadIntoRepoChat]);

  // ── Feed agent data to alert engine + search ──
  const handleAgentsUpdate = useCallback((agents: unknown[]) => {
    // AgentDetail from AgentPanel is compatible with AgentSummary for alert detection
    // (has id, name, status, context, approvalStatus, lastEventAt, sessionKey)
    updateAgents(agents as import('@/lib/fleet/types').AgentSummary[]);
    setAgentsJson(JSON.stringify(agents));
  }, [updateAgents]);

  // ── Run command in bottom terminal ──
  const handleRunInTerminal = useCallback((command: string) => {
    const tileId = ensureTileKind('contextual-panel', {
      direction: 'horizontal',
      preferredKinds: ['terminal', 'contextual-panel', 'preview'],
      ratio: 0.68,
    });
    const runCommand = (attempt = 0) => {
      const handle = getPreferredContextualPanelHandle(tileId);
      if (handle) {
        handle.runCommand(command);
        return;
      }
      if (attempt < 8) {
        window.setTimeout(() => runCommand(attempt + 1), 50);
      }
    };
    runCommand();
  }, [ensureTileKind, getPreferredContextualPanelHandle]);

  // ── Alert action: navigate to agent session ──
  const handleAlertAction = useCallback((alert: import('@/lib/alerts/types').Alert) => {
    if (alert.sessionKey) {
      setActiveSessionKey(alert.sessionKey);
    }
    setAlertTrayOpen(false);
  }, []);

  const handleOpenDeploy = useCallback((project?: string) => {
    openCanvasTab({
      id: `deploy:${project ?? 'all'}`,
      kind: 'deploy',
      label: 'Deploys',
      resourceId: project ?? '',
      meta: project ? { project } : undefined,
    });
  }, [openCanvasTab]);

  const handleOpenCI = useCallback((repo: string) => {
    openWorkspaceSidePanel('review', getWorkspaceSidePanelRepoBySlug(repo));
  }, [getWorkspaceSidePanelRepoBySlug, openWorkspaceSidePanel]);

  const handleCreateIssue = useCallback((repo?: string) => {
    openCanvasTab({
      id: `new-issue:${repo ?? 'default'}:${Date.now()}`,
      kind: 'new-issue',
      label: 'New Issue',
      resourceId: 'new',
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab]);

  const handleLaunchWorkspaceAgent = useCallback(async (request: {
    repoPath: string;
    runtime?: 'codex' | 'claude-code';
    modelId?: string;
    initialText?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
    supervisorStatus?: string | null;
    autoArchiveOnIdle?: boolean;
  }) => {
    const repos = globalRepoEntries.length > 0 ? globalRepoEntries : await loadRegisteredRepos();
    const repoEntry = repos.find((repo) => repo.localPath === request.repoPath);

    if (!repoEntry) {
      throw new Error(`No local checkout is registered for ${request.repoPath}. Open the repo locally before launching work there.`);
    }

    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }

    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repoEntry.id }),
    }).catch(() => null);

    const workspaceTarget = await waitForWorkspaceTerminalTarget({
      repoPath: repoEntry.localPath,
    });
    if (!workspaceTarget) {
      throw new Error('No workspace terminal is available to launch the CLI session.');
    }

    workspaceTarget.handle.openCliChatSession({
      runtime: request.runtime,
      repo: {
        name: repoEntry.name,
        localPath: repoEntry.localPath,
        branch: repoEntry.readiness?.currentBranch ?? repoEntry.defaultBranch,
        readiness: repoEntry.readiness ?? null,
        remoteUrl: repoEntry.remoteUrl ?? undefined,
      },
      modelId: request.modelId,
      initialText: request.initialText,
      autoSend: request.autoSend,
      createNew: request.createNew ?? true,
      label: request.label,
      targetSessionKey: request.targetSessionKey,
      supervisorStatus: request.supervisorStatus,
      autoArchiveOnIdle: request.autoArchiveOnIdle,
    });
    enqueueFtuxMilestone('firstAgentSpawned');
  }, [enqueueFtuxMilestone, globalRepoEntries, loadRegisteredRepos, waitForWorkspaceTerminalTarget]);

  const updateSupervisorWorkspaceTab = useCallback((surfaceId: string, status: string, label?: string) => {
    for (const handle of workspaceTerminalHandlesRef.current.values()) {
      if (handle?.updateChatRuntimeStatus(surfaceId, status, label)) {
        return true;
      }
    }
    return false;
  }, []);

  // ── Auto-open workspace tab when orchestrator launches a Codex agent ──
  const openedSupervisorAgentsRef = useRef(new Set<string>());
  useEffect(() => {
    const handleSupervisorUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{
        surfaceId?: string;
        name?: string;
        status?: string;
        repoPath?: string;
      }>).detail;
      if (!detail?.surfaceId || !detail.status) return;

      if (detail.status !== 'launched') {
        updateSupervisorWorkspaceTab(detail.surfaceId, detail.status, detail.name);
        return;
      }
      if (updateSupervisorWorkspaceTab(detail.surfaceId, detail.status, detail.name)) {
        openedLaneSessionsCache().add(detail.surfaceId);
        return;
      }
      if (!detail.repoPath) return;

      // Deduplicate — only open once per surfaceId
      if (openedSupervisorAgentsRef.current.has(detail.surfaceId)) return;
      openedSupervisorAgentsRef.current.add(detail.surfaceId);
      openedLaneSessionsCache().add(detail.surfaceId);

      void handleLaunchWorkspaceAgent({
        repoPath: detail.repoPath,
        runtime: 'codex',
        label: detail.name ?? 'Codex Agent',
        createNew: true,
        autoSend: false,
        targetSessionKey: detail.surfaceId,
        supervisorStatus: detail.status,
        autoArchiveOnIdle: false,
      }).catch((err) => {
        console.error('[dashboard] Failed to auto-open tab for orchestrator agent:', err);
      });
    };

    window.addEventListener('cortex:agent-supervisor-update', handleSupervisorUpdate);
    return () => window.removeEventListener('cortex:agent-supervisor-update', handleSupervisorUpdate);
  }, [handleLaunchWorkspaceAgent, updateSupervisorWorkspaceTab]);

  const handleLaunchWorkspaceRepoTask = useCallback(async (request: {
    kind: 'issue' | 'pr';
    repo: string;
    number: number;
    title: string;
    body?: string;
    branch?: string;
  }) => {
    const response = await fetch('/api/panel/repos');
    const data = await response.json() as { repos?: RepoRegistryEntry[] };
    const repoEntry = (data.repos ?? []).find((repo) => repoSlugFromRemote(repo.remoteUrl) === request.repo);

    if (!repoEntry) {
      throw new Error(`No local checkout is registered for ${request.repo}. Open the repo locally before launching work there.`);
    }

    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }

    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repoEntry.id }),
    }).catch(() => null);

    const workspaceTarget = await waitForWorkspaceTerminalTarget({
      repoPath: repoEntry.localPath,
    });
    if (!workspaceTarget) {
      throw new Error('No workspace terminal is available to launch the CLI session.');
    }

    let currentBranch = repoEntry.defaultBranch || 'main';
    try {
      const branchResponse = await fetch(`/api/panel/branches?path=${encodeURIComponent(repoEntry.localPath)}`);
      const branchData = await branchResponse.json() as { branches?: Array<{ name: string; current: boolean }> };
      const current = (branchData.branches ?? []).find((branch) => branch.current);
      if (current?.name) currentBranch = current.name;
    } catch {
      // keep default branch fallback
    }

    const effectiveBranch = repoEntry.readiness?.currentBranch ?? currentBranch;
    const readinessLines = [
      repoEntry.readiness
        ? `Readiness: ${repoEntry.readiness.label} — ${repoEntry.readiness.summary}`
        : 'Readiness: unknown',
      `Local checkout: ${repoEntry.localPath}`,
      `Current branch: ${effectiveBranch}`,
      `Default branch: ${repoEntry.defaultBranch}`,
      effectiveBranch === repoEntry.defaultBranch
        ? 'You are operating directly on the default branch right now.'
        : `You are not on the default branch; the current local branch is ${effectiveBranch}.`,
      repoEntry.setup.installCommand
        ? `Install command: ${repoEntry.setup.installCommand}${repoEntry.setup.installOnCreateWorkspace ? ' (saved as default setup)' : ''}`
        : 'Install command: none saved',
      repoEntry.setup.buildCommand
        ? `Build command: ${repoEntry.setup.buildCommand}${repoEntry.setup.runBuildOnCreateWorkspace ? ' (saved for bootstrap)' : ''}`
        : 'Build command: none saved',
      repoEntry.setup.devCommand
        ? `Dev command: ${repoEntry.setup.devCommand}${repoEntry.setup.defaultPort ? ` on port ${repoEntry.setup.defaultPort}` : ''}`
        : 'Dev command: none saved',
      repoEntry.setup.envFiles.length > 0
        ? `Env files: ${repoEntry.setup.envFiles.join(', ')} (mode: ${repoEntry.setup.envMode})`
        : 'Env files: none saved',
      repoEntry.readiness?.nextAction
        ? `Next readiness action: ${repoEntry.readiness.nextAction}`
        : null,
    ];

    const prompt = request.kind === 'issue'
      ? [
          `Work on GitHub issue #${request.number} in ${request.repo}: ${request.title}.`,
          'Use this workspace CLI session as the operator surface.',
          'Start by using the issue context included below and inspecting the current local repo state.',
          'Do not rely on `gh issue view`, GitHub GraphQL, or other remote issue fetches unless the provided issue context is clearly missing something critical.',
          'Before coding, establish whether this repo is actually runnable from this checkout using the saved setup/dev commands and the current branch state below.',
          'If the repo is not ready, say exactly what is missing or broken before you implement anything.',
          'Implement the smallest correct fix, validate it with focused checks, and do not claim success unless the relevant path actually works end to end.',
          'If a runtime/dev-server blocker prevents validation, stop and report the blocker explicitly instead of assuming the feature works.',
          `Repo readiness context:\n${readinessLines.join('\n')}`,
          request.body ? `Issue context:\n${request.body}` : null,
        ].filter(Boolean).join('\n\n')
      : [
          `Review GitHub PR #${request.number} in ${request.repo}: ${request.title}.`,
          `Head branch: ${request.branch ?? 'unknown'}.`,
          'Use this workspace CLI session as the review surface.',
          'Before signing off, establish whether this checkout is runnable and note any setup/runtime blockers using the readiness context below.',
          'Read the PR context and changed files, validate the change locally, identify risks or regressions, and state clearly if the branch cannot be verified end to end.',
          `Repo readiness context:\n${readinessLines.join('\n')}`,
        ].join('\n\n');

    const taskLabel = request.kind === 'issue'
      ? `#${request.number} — ${request.title}`
      : `PR #${request.number} — ${request.title}`;

    workspaceTarget.handle.openCliChatSession({
      runtime: undefined,
      repo: {
        name: repoEntry.name,
        localPath: repoEntry.localPath,
        branch: repoEntry.readiness?.currentBranch ?? repoEntry.defaultBranch,
        readiness: repoEntry.readiness ?? null,
        remoteUrl: repoEntry.remoteUrl ?? undefined,
      },
      modelId: undefined,
      initialText: prompt,
      autoSend: true,
      createNew: true,
      label: taskLabel,
    });
    enqueueFtuxMilestone('firstAgentSpawned');
  }, [enqueueFtuxMilestone, waitForWorkspaceTerminalTarget]);

  const handleSelectFile = useCallback((filePath: string, workspace?: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext);

    openCanvasTab({
      id: `${isImage ? 'image' : 'file'}:${filePath}${workspace ? `:${workspace}` : ''}`,
      kind: isImage ? 'image' : 'file',
      label: filePath.split('/').pop() ?? filePath,
      resourceId: filePath,
      meta: workspace ? { workspace } : undefined,
    });
  }, [openCanvasTab]);

  const handleSelectCommit = useCallback((hash: string, meta?: Record<string, string>) => {
    const nextMeta: Record<string, string> = { ...(meta ?? {}) };
    const matchedRepo = nextMeta.workspace
      ? globalRepoEntries.find((repo) => (
          nextMeta.workspace === repo.localPath
          || nextMeta.workspace.startsWith(`${repo.localPath}/`)
        )) ?? null
      : nextMeta.repo
        ? globalRepoEntries.find((repo) => repoSlugFromRemote(repo.remoteUrl) === nextMeta.repo) ?? null
        : globalRepoEntry ?? null;

    if (matchedRepo) {
      if (!nextMeta.workspace) {
        nextMeta.workspace = matchedRepo.localPath;
      }
      if (!nextMeta.repo) {
        const repoSlug = repoSlugFromRemote(matchedRepo.remoteUrl);
        if (repoSlug) {
          nextMeta.repo = repoSlug;
        }
      }
    }

    const repoPath = matchedRepo?.localPath ?? nextMeta.workspace ?? globalRepoEntry?.localPath ?? null;
    const canvasTab: CanvasTab = {
      id: `commit:${hash}${nextMeta.workspace ? `:${nextMeta.workspace}` : ''}`,
      kind: 'commit',
      label: hash.slice(0, 7),
      resourceId: hash,
      meta: Object.keys(nextMeta).length > 0 ? nextMeta : undefined,
    };

    void (async () => {
      const workspaceTarget = await waitForWorkspaceTerminalTarget({ repoPath });
      if (workspaceTarget) {
        workspaceTarget.handle.openInspectorTab(canvasTab, {
          repo: matchedRepo ? {
            name: matchedRepo.name,
            localPath: matchedRepo.localPath,
            branch: matchedRepo.readiness?.currentBranch ?? matchedRepo.defaultBranch,
            readiness: matchedRepo.readiness ?? null,
            remoteUrl: matchedRepo.remoteUrl ?? undefined,
          } : undefined,
        });
        return;
      }
      openCanvasTab(canvasTab);
    })();
  }, [globalRepoEntries, globalRepoEntry, openCanvasTab, waitForWorkspaceTerminalTarget]);

  // ── Left drag handle ──
  const startLeftDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidth;
    const onMove = (ev: MouseEvent) => {
      setLeftWidth(Math.min(Math.max(startW + (ev.clientX - startX), 160), 500));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [leftWidth]);

  // ── Right drag handle ──
  const startRightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightWidth;
    const onMove = (ev: MouseEvent) => {
      setRightWidth(Math.min(Math.max(startW + (startX - ev.clientX), MIN_RIGHT_PANEL_WIDTH), MAX_RIGHT_PANEL_WIDTH));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [rightWidth]);

  const parsedAgents = useMemo(() => {
    try {
      return JSON.parse(agentsJson) as PaletteAgentSummary[];
    } catch {
      return [] as PaletteAgentSummary[];
    }
  }, [agentsJson]);
  const firstFileChangeCandidate = useMemo(() => {
    const source = parsedAgents.find((agent) => (
      Boolean(agent.activity?.filePath)
      || Boolean((agent.localDiff?.changedFiles ?? 0) > 0)
    ));
    if (!source) {
      return null;
    }

    return {
      path: source.activity?.filePath ?? null,
      workspace: source.workspace ?? source.runtimeSurface?.cwd ?? null,
    };
  }, [parsedAgents]);
  const hasPendingApprovals = useMemo(
    () => approvalCount > 0 || parsedAgents.some((agent) => agent.approvalStatus === 'pending'),
    [approvalCount, parsedAgents],
  );
  const hasCompletedSession = useMemo(
    () => Array.from(lifecycleEvents.values()).some((entry) => entry.state === 'completed'),
    [lifecycleEvents],
  );
  const orchestratorRuntimeTruth = useMemo<OrchestratorRuntimeTruth[]>(
    () => parsedAgents
      .filter((agent) => agent.sessionKey && (agent.runtime === 'codex' || agent.runtime === 'claude-code'))
      .map((agent) => ({
        sessionKey: agent.sessionKey!,
        runtime: agent.runtime === 'claude-code' ? 'claude-code' : 'codex',
        status: agent.status ?? 'idle',
        currentTask: agent.currentTask ?? null,
        lastEventAt: agent.lastEventAt ?? null,
        workflowStageLabel: null,
      })),
    [parsedAgents],
  );

  useEffect(() => {
    if (
      ftuxDormant
      || !ftuxMilestones.firstAgentSpawned.seen
      || ftuxMilestones.firstFileChange.seen
      || !firstFileChangeCandidate
    ) {
      return;
    }

    setFtuxFirstChangedFile((current) => current ?? {
      path: firstFileChangeCandidate.path ?? 'Changed workspace files',
      workspace: firstFileChangeCandidate.workspace,
    });
    enqueueFtuxMilestone('firstFileChange');
    if (firstFileChangeCandidate.path) {
      handleSelectFile(firstFileChangeCandidate.path, firstFileChangeCandidate.workspace ?? undefined);
    }
  }, [
    enqueueFtuxMilestone,
    firstFileChangeCandidate,
    ftuxDormant,
    ftuxMilestones.firstAgentSpawned.seen,
    ftuxMilestones.firstFileChange.seen,
    handleSelectFile,
  ]);

  useEffect(() => {
    if (
      ftuxDormant
      || !ftuxMilestones.firstAgentSpawned.seen
      || ftuxMilestones.firstApproval.seen
      || !hasPendingApprovals
    ) {
      return;
    }

    enqueueFtuxMilestone('firstApproval');
  }, [
    enqueueFtuxMilestone,
    ftuxDormant,
    ftuxMilestones.firstAgentSpawned.seen,
    ftuxMilestones.firstApproval.seen,
    hasPendingApprovals,
  ]);

  useEffect(() => {
    if (
      ftuxDormant
      || !ftuxMilestones.firstAgentSpawned.seen
      || ftuxMilestones.firstCompletion.seen
      || !hasCompletedSession
    ) {
      return;
    }

    enqueueFtuxMilestone('firstCompletion');
  }, [
    enqueueFtuxMilestone,
    ftuxDormant,
    ftuxMilestones.firstAgentSpawned.seen,
    ftuxMilestones.firstCompletion.seen,
    hasCompletedSession,
  ]);

  useEffect(() => {
    if (ftuxDormant || ftuxMilestones.firstMobilePrompt.seen || resolvedApprovalCount < 1) {
      return;
    }

    enqueueFtuxMilestone('firstMobilePrompt');
  }, [
    enqueueFtuxMilestone,
    ftuxDormant,
    ftuxMilestones.firstMobilePrompt.seen,
    resolvedApprovalCount,
  ]);

  // ── Domain lane polling for reconciliation (deferred — not needed for first paint) ──
  const [domainLanes, setDomainLanes] = useState<DomainLaneSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/lanes?active=true');
        if (!res.ok || cancelled) return;
        const data = await res.json() as { lanes?: Array<{ id: string; packetId: string | null; status: string; sessionKey: string | null }> };
        const summaries: DomainLaneSummary[] = (data.lanes ?? [])
          .filter((l): l is typeof l & { packetId: string } => Boolean(l.packetId))
          .map((l) => ({ laneId: l.id, packetId: l.packetId, status: l.status, sessionKey: l.sessionKey }));
        if (!cancelled) setDomainLanes(summaries);
      } catch { /* silent */ }
    };
    // Defer initial fetch — lane tab-sync poll covers the first few seconds
    const initTimer = setTimeout(poll, 5_000);
    const interval = setInterval(poll, 30_000);
    return () => { cancelled = true; clearTimeout(initTimer); clearInterval(interval); };
  }, []);

  const paletteAgents = useMemo(() => parsedAgents, [parsedAgents]);
  const selectedSessionAgent = useMemo(
    () => paletteAgents.find((agent) => agent.sessionKey === activeSessionKey)
      ?? paletteAgents.find((agent) => agent.isCurrentSession)
      ?? null,
    [activeSessionKey, paletteAgents],
  );
  const scopedRepoAgents = useMemo(
    () => paletteAgents.filter((agent) => {
      const repoSlug = repoSlugFromAgent(agent);
      return Boolean(globalRepo && repoSlug === globalRepo);
    }),
    [globalRepo, paletteAgents],
  );
  const currentReviewAgent = useMemo(() => {
    const seen = new Set<string>();
    const candidates = [selectedSessionAgent, ...scopedRepoAgents].filter((agent): agent is PaletteAgentSummary => {
      if (!agent || seen.has(agent.sessionKey)) return false;
      seen.add(agent.sessionKey);
      return true;
    });

    return candidates.find((agent) => {
      const repoSlug = repoSlugFromAgent(agent) || globalRepo;
      return Boolean(repoSlug && agent.pr?.number && agent.pr.state !== 'closed');
    }) ?? null;
  }, [globalRepo, scopedRepoAgents, selectedSessionAgent]);
  useEffect(() => {
    if (!tileLayoutHydrated) return;
    if (workspaceTerminalHandlesRef.current.size === 0) return;
    if (!areWorkspaceTerminalRestoresSettled()) return;
    const reconciled = reconcileOrchestratorMissionState(thoughtsMissionState, {
      laneSnapshots: collectOrchestratorLaneSnapshots(),
      runtimeTruth: orchestratorRuntimeTruth,
      domainLanes,
    });
    const changed = JSON.stringify({
      prompt: reconciled.prompt,
      summary: reconciled.summary,
      packets: reconciled.packets,
      updatedAt: reconciled.updatedAt,
    }) !== JSON.stringify({
      prompt: thoughtsMissionState.prompt,
      summary: thoughtsMissionState.summary,
      packets: thoughtsMissionState.packets,
      updatedAt: thoughtsMissionState.updatedAt,
    });
    if (changed) {
      const updated = updateOrchestratorMissionState(reconciled);
      setThoughtsMissionState(updated);
      scheduleThoughtsMissionPersist(updated);
    }
  }, [
    areWorkspaceTerminalRestoresSettled,
    collectOrchestratorLaneSnapshots,
    domainLanes,
    orchestratorRuntimeTruth,
    scheduleThoughtsMissionPersist,
    thoughtsMissionState,
    tileLayoutHydrated,
    workspaceChatSessionsByTileId,
  ]);
  const currentIssueTarget = useMemo(() => {
    const seen = new Set<string>();
    const candidates = [selectedSessionAgent, ...scopedRepoAgents].filter((agent): agent is PaletteAgentSummary => {
      if (!agent || seen.has(agent.sessionKey)) return false;
      seen.add(agent.sessionKey);
      return true;
    });

    for (const agent of candidates) {
      const issueNumber = parseIssueNumber(agent.currentTask);
      const repoSlug = repoSlugFromAgent(agent) || globalRepo;
      if (issueNumber && repoSlug) {
        return {
          number: issueNumber,
          repo: repoSlug,
          title: agent.currentTask?.trim() || `Issue #${issueNumber}`,
        };
      }
    }

    return null;
  }, [globalRepo, scopedRepoAgents, selectedSessionAgent]);
  const selectedSessionWorktree = selectedSessionAgent?.worktree ?? null;
  const currentWorkspaceLifecycleRecord = useMemo(() => {
    const workflowAgent = currentReviewAgent ?? selectedSessionAgent ?? scopedRepoAgents[0] ?? null;
    if (workflowAgent?.sessionKey) {
      const liveMatch = workspaceLifecycleRecords.find((record) => (
        record.live && record.sessionKey === workflowAgent.sessionKey
      ));
      if (liveMatch) {
        return liveMatch;
      }
    }

    const fallbackRepoPath = workspaceTerminalPreferredRepo?.localPath ?? globalRepoEntry?.localPath ?? null;
    if (!fallbackRepoPath) return null;

    return workspaceLifecycleRecords.find((record) => (
      !record.archivedAt && record.repoPath === fallbackRepoPath
    )) ?? null;
  }, [currentReviewAgent, globalRepoEntry?.localPath, scopedRepoAgents, selectedSessionAgent, workspaceLifecycleRecords, workspaceTerminalPreferredRepo?.localPath]);
  const archivedWorkspaceCandidate = useMemo(() => {
    const preferredRepoPath = workspaceTerminalPreferredRepo?.localPath ?? globalRepoEntry?.localPath ?? null;
    return [...workspaceLifecycleRecords]
      .filter((record) => Boolean(record.archivedAt))
      .sort((left, right) => {
        const leftPreferred = preferredRepoPath ? left.repoPath === preferredRepoPath : false;
        const rightPreferred = preferredRepoPath ? right.repoPath === preferredRepoPath : false;
        if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
        const leftTime = left.archivedAt ? new Date(left.archivedAt).getTime() : 0;
        const rightTime = right.archivedAt ? new Date(right.archivedAt).getTime() : 0;
        return rightTime - leftTime;
      })[0] ?? null;
  }, [globalRepoEntry?.localPath, workspaceLifecycleRecords, workspaceTerminalPreferredRepo?.localPath]);
  const nextAttentionWorkspace = useMemo(() => {
    if (!workspaceLifecycleSummary.nextAttentionWorkspaceId) return null;
    return workspaceLifecycleRecords.find((record) => record.id === workspaceLifecycleSummary.nextAttentionWorkspaceId) ?? null;
  }, [workspaceLifecycleRecords, workspaceLifecycleSummary.nextAttentionWorkspaceId]);
  const staleSelectedRepoWorktrees = useMemo(
    () => (selectedRepoWorktrees?.worktrees ?? []).filter((worktree) => worktree.status === 'stale'),
    [selectedRepoWorktrees],
  );

  useEffect(() => {
    if (!activeSessionKey || selectedSessionAgent || paletteAgents.length === 0) return;
    const fallbackSession = paletteAgents.find((agent) => agent.isCurrentSession) ?? paletteAgents[0];
    if (!fallbackSession || fallbackSession.sessionKey === activeSessionKey) return;
    setActiveSessionKey(fallbackSession.sessionKey);
  }, [activeSessionKey, paletteAgents, selectedSessionAgent]);

  useEffect(() => {
    if (!currentWorkspaceLifecycleRecord || currentWorkspaceLifecycleRecord.archivedAt || currentWorkspaceLifecycleRecord.unreadCount === 0) {
      return;
    }
    const marker = `${currentWorkspaceLifecycleRecord.id}:${currentWorkspaceLifecycleRecord.lastActivityAt ?? ''}`;
    if (lastMarkedWorkspaceReadRef.current === marker) {
      return;
    }
    lastMarkedWorkspaceReadRef.current = marker;
    void mutateWorkspaceLifecycle('mark_read', currentWorkspaceLifecycleRecord.id).catch(() => undefined);
  }, [currentWorkspaceLifecycleRecord, mutateWorkspaceLifecycle]);

  const paletteActions = useMemo<CommandPaletteAction[]>(() => {
    const actions: CommandPaletteAction[] = [];
    const workflowContextAgent = currentReviewAgent ?? selectedSessionAgent ?? scopedRepoAgents[0] ?? null;
    const workflowContextStage = workflowContextAgent
      ? deriveWorkflowStage({
          runtimeStatus: workflowContextAgent.status ?? null,
          workspaceStatus: workflowContextAgent.workspaceStatus ?? null,
          lifecycleState: workflowContextAgent.lifecycleState ?? null,
          latestText: workflowContextAgent.currentTask ?? workflowContextAgent.runtimeSurface?.lifecycle?.summary ?? '',
          lastActivityAt: workflowContextAgent.lastEventAt ? new Date(workflowContextAgent.lastEventAt).getTime() : null,
          hasMessages: Boolean(workflowContextAgent.currentTask?.trim()),
          readinessState: workflowContextAgent.repoReadiness?.state ?? globalRepoEntry?.readiness?.state ?? null,
        })
      : deriveWorkflowStage({
          readinessState: globalRepoEntry?.readiness?.state ?? null,
          latestText: '',
        });
    const workflowContextGuidance = describeWorkflowStage({
      stage: workflowContextStage,
      runtimeStatus: workflowContextAgent?.status ?? null,
      workspaceStatus: workflowContextAgent?.workspaceStatus ?? null,
      lifecycleState: workflowContextAgent?.lifecycleState ?? null,
      latestText: workflowContextAgent?.currentTask ?? workflowContextAgent?.runtimeSurface?.lifecycle?.summary ?? '',
      lastActivityAt: workflowContextAgent?.lastEventAt ? new Date(workflowContextAgent.lastEventAt).getTime() : null,
      hasMessages: Boolean(workflowContextAgent?.currentTask?.trim()),
      readinessState: workflowContextAgent?.repoReadiness?.state ?? globalRepoEntry?.readiness?.state ?? null,
      readinessSummary: workflowContextAgent?.repoReadiness?.summary ?? globalRepoEntry?.readiness?.summary ?? null,
      readinessNextAction: workflowContextAgent?.repoReadiness?.nextAction ?? globalRepoEntry?.readiness?.nextAction ?? null,
    });
    const repoAttention = globalRepoEntries
      .filter((entry) => entry.readiness?.state === 'blocked' || entry.readiness?.state === 'needs_setup')
      .sort((a, b) => {
        const aScore = attentionRank(a.readiness?.label ?? '');
        const bScore = attentionRank(b.readiness?.label ?? '');
        if (aScore !== bScore) return bScore - aScore;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 4);

    for (const entry of repoAttention) {
      actions.push({
        id: `repo-attention:${entry.id}`,
        category: 'attention',
        title: `${entry.readiness?.label}: ${entry.name}`,
        detail: repoReadinessDetail(entry),
        stateLabel: entry.readiness?.label,
        stateTone: readinessTone(entry.readiness?.state),
        keywords: [entry.name, entry.localPath, entry.readiness?.summary ?? '', entry.readiness?.nextAction ?? ''],
        priority: attentionRank(entry.readiness?.label ?? ''),
        run: () => focusRepoSetup(entry),
      });
    }

    const attentionCandidates = paletteAgents
      .map((agent) => {
        const status = paletteWorkflowLabel(agent);
        return {
          agent,
          status,
          score: attentionRank(status) + Math.min(agent.alerts ?? 0, 8) * 12,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    for (const { agent, status, score } of attentionCandidates) {
      actions.push({
        id: `attention:${agent.sessionKey}`,
        category: 'attention',
        title: `${status}: ${agent.name}`,
        detail: formatAttentionDetail(agent),
        stateLabel: status,
        stateTone: agent.repoReadiness
          ? readinessTone(agent.repoReadiness.state)
          : workflowTone(status),
        keywords: [agent.sessionKey, agent.currentTask ?? '', repoSlugFromAgent(agent) ?? '', agent.workspace ?? '', status],
        priority: score,
        run: () => {
          setSidebarVisible(true);
          setActiveSessionKey(agent.sessionKey);
        },
      });
    }

    const liveSessionCandidates = paletteAgents
      .filter((agent) => Boolean(agent.sessionKey))
      .sort((a, b) => {
        if (a.isCurrentSession !== b.isCurrentSession) return a.isCurrentSession ? -1 : 1;
        const aRepoMatch = repoSlugFromAgent(a) === globalRepo || a.workspace === globalRepoEntry?.localPath;
        const bRepoMatch = repoSlugFromAgent(b) === globalRepo || b.workspace === globalRepoEntry?.localPath;
        if (aRepoMatch !== bRepoMatch) return aRepoMatch ? -1 : 1;
        const aRank = attentionRank(paletteWorkflowLabel(a));
        const bRank = attentionRank(paletteWorkflowLabel(b));
        if (aRank !== bRank) return bRank - aRank;
        const aTime = a.lastEventAt ? new Date(a.lastEventAt).getTime() : 0;
        const bTime = b.lastEventAt ? new Date(b.lastEventAt).getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, 6);

    for (const agent of liveSessionCandidates) {
      const workflowLabel = paletteWorkflowLabel(agent);
      const repoReadinessState = agent.repoReadiness?.state ?? null;
      actions.push({
        id: `session:focus:${agent.sessionKey}`,
        category: 'workspace',
        title: `Focus ${paletteSessionTitle(agent)}`,
        detail: paletteSessionDetail(agent),
        stateLabel: workflowLabel,
        stateTone: repoReadinessState ? readinessTone(repoReadinessState) : workflowTone(workflowLabel),
        keywords: [
          agent.name,
          paletteSessionRuntime(agent),
          agent.currentTask ?? '',
          agent.workspace ?? '',
          agent.branch ?? '',
          repoSlugFromAgent(agent) ?? '',
          'focus session',
          'switch session',
          agent.sessionKey,
        ],
        priority: agent.isCurrentSession ? 460 : 430,
        run: () => handleSelectSession(agent.sessionKey),
      });
    }

    if (globalRepoEntry) {
      const repoReadinessLabel = globalRepoEntry.readiness?.label;
      const repoReadinessTone = readinessTone(globalRepoEntry.readiness?.state);
      const repoReadinessSummary = repoReadinessDetail(globalRepoEntry);

      actions.push({
        id: 'workspace:launch-agent',
        category: 'workspace',
        title: 'Launch workspace agent',
        detail: globalRepoEntry.readiness
          ? `${repoReadinessLabel}: ${repoReadinessSummary}`
          : `Start a fresh CLI session in ${globalRepoEntry.name}.`,
        stateLabel: repoReadinessLabel,
        stateTone: repoReadinessTone,
        keywords: [globalRepoEntry.name, globalRepoEntry.localPath, globalRepo ?? '', 'launch', 'workspace', 'agent'],
        priority: 320,
        run: () => handleLaunchWorkspaceAgent({
          repoPath: globalRepoEntry.localPath,
          createNew: true,
        }),
      });

      actions.push({
        id: 'workspace:repo-setup',
        category: 'workspace',
        title: 'Open current repo setup',
        detail: globalRepoEntry.readiness
          ? repoReadinessSummary
          : `Edit saved env, build, and dev commands for ${globalRepoEntry.name}.`,
        stateLabel: repoReadinessLabel,
        stateTone: repoReadinessTone,
        keywords: [globalRepoEntry.name, 'repo setup', 'env', 'build', 'dev', 'profile'],
        priority: 300,
        run: handleFocusCurrentRepoSetup,
      });

      actions.push({
        id: 'workspace:create-worktree',
        category: 'workspace',
        title: 'Create workspace worktree',
        detail: selectedRepoWorktreesLoading
          ? `Checking worktree health for ${globalRepoEntry.name}…`
          : repoWorktreeDetail(selectedRepoWorktrees),
        stateLabel: globalRepoEntry.readiness?.label ?? (selectedRepoWorktrees && !selectedRepoWorktrees.conflicts.safe ? 'Blocked' : 'Ready'),
        stateTone: globalRepoEntry.readiness
          ? readinessTone(globalRepoEntry.readiness.state)
          : selectedRepoWorktrees && !selectedRepoWorktrees.conflicts.safe
            ? 'red'
            : 'blue',
        keywords: ['create worktree', 'new workspace', 'workspace branch', globalRepoEntry.name],
        priority: 298,
        run: () => openRepoWorkspaceModal(globalRepoEntry),
      });

      if (selectedRepoWorktrees && !selectedRepoWorktrees.conflicts.safe) {
        actions.push({
          id: 'workspace:review-worktree-conflicts',
          category: 'attention',
          title: `Blocked: ${globalRepoEntry.name} worktree conflicts`,
          detail: `${selectedRepoWorktrees.conflicts.count} overlapping worktree file${selectedRepoWorktrees.conflicts.count === 1 ? '' : 's'} need operator attention before stacking more work.`,
          stateLabel: 'Blocked',
          stateTone: 'red',
          keywords: ['worktree conflict', 'overlap', 'blocked', globalRepoEntry.name],
          priority: 410,
          run: () => focusRepoSetup(globalRepoEntry),
        });
      }

      actions.push({
        id: 'workspace:open-cli-surface',
        category: 'workspace',
        title: 'Open workspace CLI surface',
        detail: `Focus the main workspace terminal for ${globalRepoEntry.name}.`,
        stateLabel: 'Ready',
        stateTone: 'blue',
        keywords: ['workspace cli', 'workspace terminal', 'terminal', 'focus terminal'],
        priority: 295,
        run: async () => {
          const target = await waitForWorkspaceTerminalTarget({
            repoPath: globalRepoEntry.localPath,
          });
          if (!target) {
            throw new Error('No workspace CLI surface is available right now. Reload the workspace and try again.');
          }
        },
      });

      if (globalRepoEntry.readiness?.state === 'needs_setup' && globalRepoEntry.setup.installCommand) {
        actions.push({
          id: 'workspace:run-setup',
          category: 'recovery',
          title: `Run saved setup for ${globalRepoEntry.name}`,
          detail: `Execute ${globalRepoEntry.setup.installCommand} in the operator terminal.`,
          stateLabel: globalRepoEntry.readiness.label,
          stateTone: readinessTone(globalRepoEntry.readiness.state),
          keywords: [globalRepoEntry.setup.installCommand, 'install deps', 'setup', 'bootstrap', globalRepoEntry.name],
          priority: 340,
          run: () => {
            handleRunInTerminal(`cd ${JSON.stringify(globalRepoEntry.localPath)} && ${globalRepoEntry.setup.installCommand}`);
          },
        });
      }

      if (selectedSessionWorktree?.path) {
        actions.push({
          id: 'workspace:finder-worktree',
          category: 'workspace',
          title: 'Open current worktree in Finder',
          detail: `${selectedSessionWorktree.id} · ${selectedSessionWorktree.path}`,
          stateLabel: worktreeStageLabel(selectedSessionWorktree.status),
          stateTone: worktreeStageTone(selectedSessionWorktree.status),
          keywords: [selectedSessionWorktree.id, selectedSessionWorktree.path, 'worktree', 'finder', 'workspace path'],
          priority: 246,
          run: async () => {
            const response = await fetch('/api/panel/open-in', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ editor: 'finder', repo: selectedSessionWorktree.path }),
            });
            const data = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) {
              throw new Error(data.error || 'Unable to open the current worktree in Finder.');
            }
          },
        });

        actions.push({
          id: 'recovery:copy-worktree-path',
          category: 'recovery',
          title: 'Copy current worktree path',
          detail: shortenPath(selectedSessionWorktree.path),
          stateLabel: worktreeStageLabel(selectedSessionWorktree.status),
          stateTone: worktreeStageTone(selectedSessionWorktree.status),
          keywords: [selectedSessionWorktree.id, selectedSessionWorktree.path, 'copy worktree path', 'worktree'],
          priority: 226,
          run: async () => {
            await navigator.clipboard.writeText(selectedSessionWorktree.path);
          },
        });
      }

      actions.push({
        id: 'workspace:finder',
        category: 'workspace',
        title: 'Open current repo in Finder',
        detail: shortenPath(globalRepoEntry.localPath),
        keywords: [globalRepoEntry.localPath, 'finder', 'folder', 'open repo'],
        priority: 250,
        run: () => handleOpenRepoInDesktop('finder'),
      });

      actions.push({
        id: 'workspace:terminal-app',
        category: 'workspace',
        title: 'Open current repo in Terminal',
        detail: shortenPath(globalRepoEntry.localPath),
        keywords: [globalRepoEntry.localPath, 'terminal app', 'open in terminal', 'open repo'],
        priority: 248,
        run: () => handleOpenRepoInDesktop('terminal'),
      });

      actions.push({
        id: 'workspace:copy-path',
        category: 'recovery',
        title: 'Copy current repo path',
        detail: shortenPath(globalRepoEntry.localPath),
        keywords: [globalRepoEntry.localPath, 'copy path', 'cwd', 'repo path'],
        priority: 220,
        run: async () => {
          await navigator.clipboard.writeText(globalRepoEntry.localPath);
        },
      });

      if (staleSelectedRepoWorktrees.length > 0) {
        actions.push({
          id: 'recovery:prune-stale-worktrees',
          category: 'recovery',
          title: `Prune stale worktrees in ${globalRepoEntry.name}`,
          detail: `${staleSelectedRepoWorktrees.length} stale worktree${staleSelectedRepoWorktrees.length === 1 ? '' : 's'} will be removed. ${repoWorktreeDetail(selectedRepoWorktrees)}`,
          stateLabel: selectedRepoWorktrees && !selectedRepoWorktrees.conflicts.safe ? 'Blocked' : 'Ready',
          stateTone: selectedRepoWorktrees && !selectedRepoWorktrees.conflicts.safe ? 'red' : 'blue',
          keywords: ['prune stale worktrees', 'cleanup worktrees', 'stale worktree', globalRepoEntry.name],
          priority: 345,
          run: async () => {
            const confirmed = window.confirm(
              `Prune ${staleSelectedRepoWorktrees.length} stale worktree${staleSelectedRepoWorktrees.length === 1 ? '' : 's'} for ${globalRepoEntry.name}?\n\nThis removes the stale worktree directories and their branches.`,
            );
            if (!confirmed) {
              return;
            }
            const response = await fetch('/api/worktrees', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repo: globalRepoEntry.localPath, action: 'prune' }),
            });
            const data = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) {
              throw new Error(data.error || 'Unable to prune stale worktrees.');
            }
            setSelectedRepoWorktreeRefreshNonce((current) => current + 1);
          },
        });
      }
    } else {
      actions.push({
        id: 'workspace:open-folder',
        category: 'workspace',
        title: 'Open folder',
        detail: 'Register a local checkout and make it the active workspace.',
        keywords: ['open folder', 'repo', 'workspace', 'register repo'],
        priority: 320,
        run: handleOpenFolder,
      });

      actions.push({
        id: 'workspace:open-cli-surface-empty',
        category: 'workspace',
        title: 'Open workspace CLI surface',
        detail: 'Focus the main workspace terminal even before a repo is selected.',
        stateLabel: 'Ready',
        stateTone: 'blue',
        keywords: ['workspace cli', 'workspace terminal', 'terminal', 'focus terminal'],
        priority: 260,
        run: async () => {
          const target = await waitForWorkspaceTerminalTarget();
          if (!target) {
            throw new Error('No workspace CLI surface is available right now. Reload the workspace and try again.');
          }
        },
      });
    }

    if (globalRepoEntry) {
      actions.push({
        id: 'workspace:open-folder-anyway',
        category: 'workspace',
        title: 'Open another folder',
        detail: 'Register or switch to a different local checkout.',
        keywords: ['open folder', 'switch repo', 'add repo', 'workspace'],
        priority: 180,
        run: handleOpenFolder,
      });
    }

    if (currentReviewAgent?.pr?.number) {
      const reviewRepo = repoSlugFromAgent(currentReviewAgent) || globalRepo;
      if (reviewRepo) {
        const reviewReadiness = globalRepoEntry?.readiness ?? currentReviewAgent.repoReadiness ?? null;
        const reviewStage = currentReviewAgent.workflowStage ?? deriveWorkflowStage({
          runtimeStatus: currentReviewAgent.status ?? null,
          workspaceStatus: currentReviewAgent.workspaceStatus ?? null,
          lifecycleState: currentReviewAgent.lifecycleState ?? null,
          latestText: currentReviewAgent.currentTask ?? '',
          lastActivityAt: currentReviewAgent.lastEventAt ? new Date(currentReviewAgent.lastEventAt).getTime() : null,
          hasMessages: Boolean(currentReviewAgent.currentTask?.trim()),
          readinessState: reviewReadiness?.state ?? null,
          prState: currentReviewAgent.pr.state ?? 'open',
        });
        const reviewGuidance = describeWorkflowStage({
          stage: reviewStage,
          runtimeStatus: currentReviewAgent.status ?? null,
          workspaceStatus: currentReviewAgent.workspaceStatus ?? null,
          lifecycleState: currentReviewAgent.lifecycleState ?? null,
          latestText: currentReviewAgent.currentTask ?? '',
          lastActivityAt: currentReviewAgent.lastEventAt ? new Date(currentReviewAgent.lastEventAt).getTime() : null,
          hasMessages: Boolean(currentReviewAgent.currentTask?.trim()),
          readinessState: reviewReadiness?.state ?? null,
          readinessSummary: reviewReadiness?.summary ?? null,
          readinessNextAction: reviewReadiness?.nextAction ?? null,
          prState: currentReviewAgent.pr.state ?? 'open',
        });
        const reviewStateLabel = reviewStage?.label ?? reviewReadiness?.label ?? 'Reviewing';
        const reviewStateTone = reviewStage ? workflowTone(reviewStage.label) : reviewReadiness ? readinessTone(reviewReadiness.state) : 'purple';
        actions.push({
          id: 'review:open-pr',
          category: 'review',
          title: `Review current PR #${currentReviewAgent.pr.number}`,
          detail: reviewGuidance.nextAction ? `${currentReviewAgent.pr.title} · ${reviewGuidance.nextAction}` : currentReviewAgent.pr.title,
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, currentReviewAgent.pr.title, 'pull request', 'review pr', 'open pr', String(currentReviewAgent.pr.number)],
          priority: 310,
          run: () => handleReviewPR(currentReviewAgent.pr!.number, reviewRepo),
        });

        actions.push({
          id: 'review:launch-pr',
          category: 'review',
          title: `Launch PR #${currentReviewAgent.pr.number} review`,
          detail: reviewGuidance.nextAction ?? 'Open a CLI review lane with current repo readiness context.',
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, 'launch review', 'pr review', currentReviewAgent.pr.title],
          priority: 290,
          run: () => handleLaunchWorkspaceRepoTask({
            kind: 'pr',
            repo: reviewRepo,
            number: currentReviewAgent.pr!.number,
            title: currentReviewAgent.pr!.title,
            branch: currentReviewAgent.branch,
          }),
        });

        actions.push({
          id: 'review:checks',
          category: 'review',
          title: 'Open current checks',
          detail: reviewGuidance.detail,
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, 'checks', 'ci', 'status checks'],
          priority: 280,
          run: () => handleOpenCI(reviewRepo),
        });

        actions.push({
          id: 'review:merge',
          category: 'review',
          title: `Merge current PR #${currentReviewAgent.pr.number}`,
          detail: reviewGuidance.mergeDetail,
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, 'merge pr', 'merge pull request', currentReviewAgent.pr.title],
          priority: 260,
          disabled: !reviewGuidance.mergeAllowed,
          unavailableReason: !reviewGuidance.mergeAllowed ? reviewGuidance.mergeDetail : undefined,
          run: async () => {
            const response = await fetch(`/api/panel/prs/${currentReviewAgent.pr!.number}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'merge', repo: reviewRepo }),
            });
            const data = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) {
              throw new Error(data.error || 'Unable to merge the current pull request.');
            }
            handleReviewPR(currentReviewAgent.pr!.number, reviewRepo);
          },
        });
      }
    }

    if (!currentReviewAgent?.pr?.number && globalRepo) {
      actions.push({
        id: 'review:checks-only',
        category: 'review',
        title: 'Open current checks',
        detail: `Inspect the latest CI state for ${globalRepo}.`,
        stateLabel: globalRepoEntry?.readiness?.label ?? 'Reviewing',
        stateTone: globalRepoEntry?.readiness ? readinessTone(globalRepoEntry.readiness.state) : 'purple',
        keywords: [globalRepo, 'checks', 'ci', 'status checks'],
        priority: 240,
        run: () => handleOpenCI(globalRepo),
      });
    }

    if (currentIssueTarget) {
      actions.push({
        id: 'review:open-issue',
        category: 'review',
        title: `Open current issue #${currentIssueTarget.number}`,
        detail: `${currentIssueTarget.repo} · ${currentIssueTarget.title}`,
        stateLabel: globalRepoEntry?.readiness?.label ?? 'Working',
        stateTone: globalRepoEntry?.readiness ? readinessTone(globalRepoEntry.readiness.state) : 'green',
        keywords: [currentIssueTarget.repo, 'issue', currentIssueTarget.title, String(currentIssueTarget.number)],
        priority: 275,
        run: () => handleSelectIssue(currentIssueTarget.number, currentIssueTarget.repo),
      });
    }

    actions.push({
      id: 'settings:connectors',
      category: 'settings',
      title: 'Open connector settings',
      detail: 'GitHub auth, broker status, and repo access.',
      keywords: ['settings', 'connectors', 'github', 'broker'],
      priority: 210,
      run: () => handleOpenSettingsTab('connectors'),
    });

    actions.push({
      id: 'settings:agents',
      category: 'settings',
      title: 'Open agent settings',
      detail: 'Agent defaults, model choices, and runtime controls.',
      keywords: ['settings', 'agents', 'models', 'runtime'],
      priority: 205,
      run: () => handleOpenSettingsTab('agents'),
    });

    actions.push({
      id: 'settings:memory',
      category: 'settings',
      title: 'Open memory settings',
      detail: 'Cortex memory, embeddings, and maintenance.',
      keywords: ['settings', 'memory', 'cortex', 'embeddings'],
      priority: 200,
      run: () => handleOpenSettingsTab('memory'),
    });

    actions.push({
      id: 'settings:appearance',
      category: 'settings',
      title: 'Open appearance settings',
      detail: 'Theme and desktop shell behavior.',
      keywords: ['settings', 'appearance', 'theme', 'nav rail'],
      priority: 195,
      run: () => handleOpenSettingsTab('appearance'),
    });

    actions.push({
      id: 'recovery:setup',
      category: 'recovery',
      title: 'Rerun setup',
      detail: 'Open the setup flow and recheck local tools and providers.',
      stateLabel: wsStatus === 'disconnected' ? 'Blocked' : wsStatus === 'reconnecting' || wsStatus === 'connecting' ? 'Waiting' : undefined,
      stateTone: wsStatus === 'disconnected' ? 'red' : wsStatus === 'reconnecting' || wsStatus === 'connecting' ? 'amber' : undefined,
      keywords: ['rerun setup', 'setup wizard', 'doctor', 'recovery'],
      priority: wsStatus === 'connected' ? 170 : 260,
      run: () => setSetupWizardOpen(true),
    });

    if (wsStatus !== 'connected') {
      actions.push({
        id: 'recovery:workspace-bridge',
        category: 'recovery',
        title: wsStatus === 'disconnected' ? 'Workspace bridge disconnected' : 'Workspace bridge reconnecting',
        detail: wsStatus === 'disconnected'
          ? 'Saved tabs stay local, but live session updates are paused until the bridge comes back.'
          : 'Live session updates are resyncing. Reload only if the workspace does not recover on its own.',
        stateLabel: wsStatus === 'disconnected' ? 'Blocked' : 'Waiting',
        stateTone: wsStatus === 'disconnected' ? 'red' : 'amber',
        keywords: ['workspace bridge', 'disconnected', 'reconnecting', 'ws', 'reload workspace'],
        priority: wsStatus === 'disconnected' ? 520 : 300,
        run: () => window.location.reload(),
      });
    }

    if (activeSessionKey && !selectedSessionAgent && paletteAgents.length > 0) {
      const fallbackSession = paletteAgents.find((agent) => agent.isCurrentSession) ?? paletteAgents[0];
      actions.push({
        id: 'recovery:missing-session',
        category: 'recovery',
        title: 'Selected session is no longer live',
        detail: 'The current chat selection fell out of the live inventory. Jump to a monitored session or reload the workspace snapshot.',
        stateLabel: 'Blocked',
        stateTone: 'red',
        keywords: ['missing session', 'session unavailable', activeSessionKey].filter((keyword): keyword is string => Boolean(keyword)),
        priority: 510,
        run: () => {
          if (fallbackSession) {
            setActiveSessionKey(fallbackSession.sessionKey);
            setChatVisible(true);
            setRightPanelMode('chat');
            return;
          }
          window.location.reload();
        },
      });
    }

    actions.push({
      id: 'recovery:restore',
      category: 'recovery',
      title: 'Restore workspace tabs',
      detail: 'Reload the dashboard and reattach saved workspace tabs in place.',
      keywords: ['restore session', 'restore tabs', 'reload workspace', 'recover'],
      priority: wsStatus === 'connected' ? 160 : 250,
      run: () => window.location.reload(),
    });

    if (nextAttentionWorkspace) {
      actions.push({
        id: `workspace:attention:${nextAttentionWorkspace.id}`,
        category: 'attention',
        title: 'Open next workspace needing attention',
        detail: nextAttentionWorkspace.attentionDetail,
        stateLabel: nextAttentionWorkspace.attentionLabel,
        stateTone: nextAttentionWorkspace.workflowStage
          ? workflowTone(nextAttentionWorkspace.workflowStage.label)
          : 'amber',
        keywords: [
          'next workspace',
          'next attention',
          nextAttentionWorkspace.repo,
          nextAttentionWorkspace.branch,
          nextAttentionWorkspace.workspacePath,
        ],
        priority: 330 + Math.min(nextAttentionWorkspace.attentionRank, 120),
        run: async () => {
          const matchingRepo = globalRepoEntries.find((entry) => (
            nextAttentionWorkspace.repoPath === entry.localPath
            || nextAttentionWorkspace.workspacePath.startsWith(`${entry.localPath}/`)
          )) ?? null;
          if (matchingRepo) {
            await handleSelectRegisteredRepo(matchingRepo.id);
          }
          setActiveWorkspace(nextAttentionWorkspace.workspacePath);
          setSidebarVisible(true);
          setChatVisible(true);
          if (nextAttentionWorkspace.sessionKey) {
            setActiveSessionKey(nextAttentionWorkspace.sessionKey);
            setRightPanelMode('chat');
            return;
          }
          setRightPanelMode('workspace');
        },
      });
    }

    if (currentWorkspaceLifecycleRecord) {
      actions.push({
        id: `workspace:archive:${currentWorkspaceLifecycleRecord.id}`,
        category: 'workspace',
        title: 'Archive workspace',
        detail: currentWorkspaceLifecycleRecord.archive.detail,
        stateLabel: currentWorkspaceLifecycleRecord.workflowStage?.label ?? currentWorkspaceLifecycleRecord.attentionLabel,
        stateTone: currentWorkspaceLifecycleRecord.workflowStage
          ? workflowTone(currentWorkspaceLifecycleRecord.workflowStage.label)
          : 'slate',
        keywords: [
          'archive workspace',
          'archive lane',
          currentWorkspaceLifecycleRecord.repo,
          currentWorkspaceLifecycleRecord.branch,
        ],
        priority: 120,
        disabled: !currentWorkspaceLifecycleRecord.archive.available,
        unavailableReason: currentWorkspaceLifecycleRecord.archive.unavailableReason,
        run: async () => {
          if (!currentWorkspaceLifecycleRecord.archive.available) return;
          await mutateWorkspaceLifecycle('archive', currentWorkspaceLifecycleRecord.id);
        },
      });
    } else {
      actions.push({
        id: 'workspace:archive-unavailable',
        category: 'workspace',
        title: 'Archive workspace',
        detail: workflowContextGuidance.archiveDetail,
        stateLabel: workflowContextStage?.label ?? 'Unavailable',
        stateTone: workflowContextStage ? workflowTone(workflowContextStage.label) : 'slate',
        keywords: ['archive workspace', 'archive lane', 'archive'],
        priority: 12,
        disabled: true,
        unavailableReason: workflowContextGuidance.archiveUnavailableReason,
        run: () => undefined,
      });
    }

    if (archivedWorkspaceCandidate) {
      actions.push({
        id: `workspace:resume:${archivedWorkspaceCandidate.id}`,
        category: 'workspace',
        title: 'Resume archived workspace',
        detail: archivedWorkspaceCandidate.resume.detail,
        stateLabel: 'Archived',
        stateTone: 'slate',
        keywords: [
          'resume workspace',
          'resume archived workspace',
          'restore archived workspace',
          archivedWorkspaceCandidate.repo,
          archivedWorkspaceCandidate.branch,
        ],
        priority: 115,
        disabled: !archivedWorkspaceCandidate.resume.available,
        unavailableReason: archivedWorkspaceCandidate.resume.unavailableReason,
        run: async () => {
          if (!archivedWorkspaceCandidate.resume.available) return;
          await mutateWorkspaceLifecycle('restore', archivedWorkspaceCandidate.id);
          const matchingRepo = globalRepoEntries.find((entry) => (
            archivedWorkspaceCandidate.repoPath === entry.localPath
            || archivedWorkspaceCandidate.workspacePath.startsWith(`${entry.localPath}/`)
          )) ?? null;
          if (matchingRepo) {
            await handleSelectRegisteredRepo(matchingRepo.id);
          }
          setActiveWorkspace(archivedWorkspaceCandidate.workspacePath);
          setRightPanelMode('workspace');
          setChatVisible(true);
        },
      });
    } else {
      actions.push({
        id: 'workspace:resume-unavailable',
        category: 'workspace',
        title: 'Resume archived workspace',
        detail: workflowContextGuidance.resumeDetail,
        stateLabel: workflowContextStage?.label ?? 'Unavailable',
        stateTone: workflowContextStage ? workflowTone(workflowContextStage.label) : 'slate',
        keywords: ['resume workspace', 'resume archived workspace', 'resume'],
        priority: 11,
        disabled: true,
        unavailableReason: workflowContextGuidance.resumeUnavailableReason,
        run: () => undefined,
      });
    }

    return actions;
  }, [
    activeSessionKey,
    currentIssueTarget,
    currentReviewAgent,
    globalRepo,
    globalRepoEntry,
    globalRepoEntries,
    handleFocusCurrentRepoSetup,
    handleLaunchWorkspaceAgent,
    handleLaunchWorkspaceRepoTask,
    handleSelectSession,
    handleReviewPR,
    handleOpenFolder,
    handleOpenRepoInDesktop,
    handleOpenSettingsTab,
    handleOpenCI,
    handleRunInTerminal,
    handleSelectRegisteredRepo,
    handleSelectIssue,
    openRepoWorkspaceModal,
    paletteAgents,
    focusRepoSetup,
    currentWorkspaceLifecycleRecord,
    archivedWorkspaceCandidate,
    mutateWorkspaceLifecycle,
    nextAttentionWorkspace,
    selectedRepoWorktrees,
    selectedRepoWorktreesLoading,
    selectedSessionWorktree,
    selectedSessionAgent,
    scopedRepoAgents,
    staleSelectedRepoWorktrees,
    waitForWorkspaceTerminalTarget,
    wsStatus,
  ]);

  const tileRegistry = useMemo<TileContentRegistry>(() => ({
    workspace: {
      label: 'Workspace',
      description: 'Empty repo workspace pane that will pick up the next terminal or inspector surface you open.',
      render: ({ active }) => (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          background: 'linear-gradient(180deg, rgba(6,10,18,0.98) 0%, rgba(12,18,30,0.98) 100%)',
          color: '#e2e8f0',
        }}>
          <div style={{
            width: 48,
            height: 48,
            borderRadius: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(148,163,184,0.08)',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: active ? 'rgba(96,165,250,0.26)' : 'rgba(148,163,184,0.12)',
            marginBottom: 14,
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </div>
          <div style={{
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            marginBottom: 6,
          }}>
            Empty workspace
          </div>
          <div style={{
            maxWidth: 320,
            textAlign: 'center',
            fontSize: 12,
            lineHeight: 1.6,
            color: 'rgba(226,232,240,0.72)',
            marginBottom: 16,
          }}>
            Split first, then open a repo surface. Cortex will route the next workspace tab into this pane automatically.
          </div>
          <button
            type="button"
            onClick={() => {
              window.localStorage.removeItem(TILE_LAYOUT_STORAGE_KEY);
              setTileLayout(createDefaultTileLayout());
              setTileLayoutHydrated(true);
            }}
            style={{
              padding: '8px 20px',
              borderRadius: 8,
              border: '1px solid rgba(96,165,250,0.3)',
              background: 'rgba(96,165,250,0.08)',
              color: '#93c5fd',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reset Layout
          </button>
        </div>
      ),
    },
    terminal: {
      label: 'Workspace',
      description: 'Multi-tab terminal and chat workspace for active sessions.',
      singleton: true,
      hideHeader: true,
      // closable determined dynamically in TileContainer (last terminal is protected)
      render: ({ tileId, content }) => {
        const firstTerminalLeafId = (() => {
          const firstLeaf = getFirstLeaf(tileLayout.root);
          return firstLeaf.content.kind === 'terminal' ? firstLeaf.id : null;
        })();
        const hasScopedTerminalLeaf = collectOpenTerminalRepoPaths(tileLayout.root).length > 0;
        const tileRepoEntry = content.kind === 'terminal' && content.repoPath
          ? workspaceScopeEntries.find((repo) => repo.localPath === content.repoPath) ?? null
          : null;
        const isFreshSplitTile = content.kind === 'terminal' && !content.repoPath && tileId !== 'tile-root';
        const isPrimaryUnscopedTerminal = content.kind === 'terminal'
          && !content.repoPath
          && !hasScopedTerminalLeaf
          && firstTerminalLeafId === tileId;
        const effectiveSplitCreated = isFreshSplitTile && !isPrimaryUnscopedTerminal;
        const tilePreferredRepo = tileRepoEntry ? {
          name: tileRepoEntry.name,
          localPath: tileRepoEntry.localPath,
          branch: tileRepoEntry.branch ?? tileRepoEntry.readiness?.currentBranch ?? null,
          readiness: tileRepoEntry.readiness ?? null,
          ...(tileRepoEntry.remoteUrl ? { remoteUrl: tileRepoEntry.remoteUrl } : {}),
          ...(tileRepoEntry.registryRepoId ? { registryRepoId: tileRepoEntry.registryRepoId } : {}),
          ...(tileRepoEntry.isWorktree ? { isWorktree: true, worktreeStatus: tileRepoEntry.worktreeStatus ?? null } : {}),
        } : isPrimaryUnscopedTerminal
          ? workspaceTerminalPreferredRepo
        : isFreshSplitTile
          ? null
          : workspaceTerminalPreferredRepo;
        const canCloseTerminalTile = collectLeafContentKinds(tileLayout.root).filter((kind) => kind === 'terminal').length > 1;
        const openRepoPaths = Array.from(new Set(collectOpenTerminalRepoPaths(tileLayout.root, tileId)));

        return (
          <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(180deg, rgba(6,10,18,0.98) 0%, rgba(12,18,30,0.98) 100%)', color: '#94a3b8', fontSize: 13 }}>Loading workspace...</div>}>
          <LazyWorkspaceTerminal
            key={`workspace-terminal:${tileId}:${workspaceTerminalResetNonceByTileId[tileId] ?? 0}`}
            ref={(handle) => registerWorkspaceTerminalHandle(tileId, handle)}
            stateScope={tileId}
            defaultTab={tileId === 'tile-root' ? 'llm-chat' : 'terminal'}
            autoCreateDefaultTab={tileId === 'tile-root' || workspaceScopeEntries.length > 0}
            preferredRepo={tilePreferredRepo}
            splitCreated={content.kind === 'terminal' ? effectiveSplitCreated : false}
            availableRepos={workspaceScopeEntries}
            openRepoPaths={openRepoPaths}
            canCloseTile={canCloseTerminalTile}
            onActiveChatSessionChange={(sessionKey) => {
              setWorkspaceChatSessionByTileId((current) => (
                current[tileId] === (sessionKey ?? undefined)
                  ? current
                  : { ...current, [tileId]: sessionKey ?? undefined }
              ));
            }}
            onChatSessionsChange={(sessions) => {
              setWorkspaceChatSessionsByTileId((current) => {
                const previous = current[tileId] ?? [];
                const same = previous.length === sessions.length
                  && previous.every((session, index) => (
                    session.sessionKey === sessions[index]?.sessionKey
                    && session.status === sessions[index]?.status
                    && session.name === sessions[index]?.name
                  ));
                if (same) return current;
                return { ...current, [tileId]: sessions };
              });
            }}
            onActiveLaneChange={(lane) => {
              setWorkspaceLaneByTileId((current) => (
                sameWorkspaceLaneState(current[tileId], lane)
                  ? current
                  : { ...current, [tileId]: lane }
              ));
            }}
            onRepoScopeChange={(repoPath) => setTerminalTileRepoScope(tileId, repoPath)}
            onActiveRepoContextChange={(repo) => {
              if (activeTileId !== tileId) return;
              setWorkspaceSidePanelRepoContext((current) => sameWorkspaceSidePanelRepo(current, repo) ? current : repo);
            }}
            onSelectRepoScope={(repo) => {
              const currentRepoPath = tilePreferredRepo?.localPath ?? null;
              if (currentRepoPath === repo.localPath) {
                setActiveTileId(tileId);
                setActiveWorkspace(repo.localPath);
              } else {
                const targetTileId = ensureWorkspaceTerminalTile(repo.localPath, tileId);
                if (targetTileId) {
                  setActiveTileId(targetTileId);
                }
                setActiveWorkspace(repo.localPath);
              }
              const matched = repo.registryRepoId
                ? globalRepoEntries.find((entry) => entry.id === repo.registryRepoId) ?? null
                : globalRepoEntries.find((entry) => entry.localPath === repo.localPath) ?? null;
              if (matched) {
                void handleSelectRegisteredRepo(matched.id);
              }
            }}
            onLaunchRepoAgent={(repo) => {
              void handleLaunchWorkspaceAgent({
                repoPath: repo.localPath,
                createNew: true,
              }).catch((error) => {
                window.alert(error instanceof Error ? error.message : 'Unable to launch workspace agent.');
              });
            }}
            onOpenRepoGitLog={(repo) => handleOpenGitLog(repo.localPath)}
            onOpenRepoCI={(repo) => {
              const repoSlug = repoSlugFromRemote(repo.remoteUrl);
              if (repoSlug) handleOpenCI(repoSlug);
            }}
            onOpenRepoDiff={(repo) => openWorkspaceSidePanel('diff', repo ? {
              name: repo.name,
              localPath: repo.localPath,
              branch: repo.branch ?? null,
              readiness: repo.readiness ?? null,
              remoteUrl: repo.remoteUrl,
            } : null)}
            onInjectChatContext={handleAgentPanelChatInjection}
            onSelectCommit={handleSelectCommit}
            onLaunchWorkspaceTask={handleLaunchWorkspaceRepoTask}
            onSplitVertical={() => handleSplitTile(tileId, 'vertical')}
            onSplitHorizontal={() => handleSplitTile(tileId, 'horizontal')}
            onCloseTile={() => handleCloseTile(tileId)}
            sendTerminalCreate={sendTerminalCreate}
            sendTerminalAttach={sendTerminalAttach}
            sendTerminalInput={sendTerminalInput}
            sendTerminalResize={sendTerminalResize}
            sendTerminalDetach={sendTerminalDetach}
            termWsConnected={termWsConnected}
            onPreviewDetected={handlePreviewDetected}
            onPreviewSelection={handlePreviewSelection}
            showPreviewPane={false}
          />
          </Suspense>
        );
      },
    },
    preview: {
      label: 'Preview',
      description: 'Tabbed localhost previews detected from the workspace terminal.',
      singleton: true,
      render: ({ content, tileId }) => (
        <LocalhostPreviewTabs
          previews={workspacePreviews}
          selectedPreviewId={content.kind === 'preview' ? content.selectedPreviewId ?? null : null}
          onSelectPreview={(previewId) => handleSelectPreviewTile(tileId, previewId)}
          onClosePreview={(previewId) => handleClosePreviewTileItem(tileId, previewId)}
          onElementSelect={handlePreviewSelection}
        />
      ),
    },
    canvas: {
      label: 'Inspector',
      description: 'Legacy canvas surface for diffs, issues, PRs, and session replay.',
      render: ({ tileId, content }) => {
        const tileState = canvasStateByTileId[tileId] ?? { tabs: [], activeTabId: null, revealKey: 0 };
        const tileRepoEntry = content.kind === 'canvas' && content.repoPath
          ? globalRepoEntries.find((repo) => repo.localPath === content.repoPath) ?? null
          : null;

        return (
          <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>Loading inspector...</div>}>
            <LazyCanvas
              tabs={tileState.tabs}
              activeTabId={tileState.activeTabId}
              onSelectTab={(tabId) => selectCanvasTab(tileId, tabId)}
              onCloseTab={(tabId) => closeCanvasTab(tileId, tabId)}
              selectedRepo={repoSlugFromRemote(tileRepoEntry?.remoteUrl) ?? null}
              onInjectChatContext={handleAgentPanelChatInjection}
              onSelectCommit={handleSelectCommit}
              onLaunchWorkspaceTask={handleLaunchWorkspaceRepoTask}
            />
          </Suspense>
        );
      },
    },
    thoughts: {
      label: 'Thoughts',
      description: 'Docked command surface for tasks, approvals, and fast agent chat.',
      singleton: true,
      render: ({ tileId }) => (
        <Suspense fallback={null}>
        <LazyThoughtsCard
          open
          docked
          onClose={() => handleCloseTile(tileId)}
          agents={parsedAgents}
          draftInjection={!thoughtsOpen ? thoughtsDraftInjection : null}
          missionState={thoughtsMissionState}
          workspaceTargets={orchestratorWorkspaceTargets}
          onMissionStateChange={handleThoughtsMissionStateChange}
          onLaunchPacket={launchOrchestrationPacket}
          onFocusPacket={focusOrchestrationPacketLane}
        />
        </Suspense>
      ),
    },
    'contextual-panel': {
      label: 'Global Terminal',
      description: 'Global operator shell for scratch commands, quick command execution, and non-repo-specific utilities.',
      singleton: true,
      hideHeader: true,
      render: ({ tileId }) => (
        <ContextualPanel
          ref={(handle) => registerContextualPanelHandle(tileId, handle)}
          sendTerminalCreate={sendTerminalCreate}
          sendTerminalAttach={sendTerminalAttach}
          sendTerminalInput={sendTerminalInput}
          sendTerminalResize={sendTerminalResize}
          sendTerminalDetach={sendTerminalDetach}
          sendAgentKill={sendAgentKill}
          termWsConnected={termWsConnected}
          onSplitVertical={() => handleSplitTile(tileId, 'vertical')}
          onSplitHorizontal={() => handleSplitTile(tileId, 'horizontal')}
          onClose={() => handleCloseTile(tileId)}
        />
      ),
    },
  }), [
    canvasStateByTileId,
    closeCanvasTab,
    globalRepoEntries,
    workspaceTerminalPreferredRepo,
    handleClosePreviewTileItem,
    handleCloseTile,
    handleSplitTile,
    handleAgentPanelChatInjection,
    ensureWorkspaceTerminalTile,
    handleLaunchWorkspaceRepoTask,
    handlePreviewDetected,
    handlePreviewSelection,
    handleLaunchWorkspaceAgent,
    handleSelectCommit,
    handleSelectRegisteredRepo,
    handleSelectPreviewTile,
    handleOpenCI,
    handleOpenGitLog,
    handleThoughtsMissionStateChange,
    openWorkspaceSidePanel,
    parsedAgents,
    registerContextualPanelHandle,
    registerWorkspaceTerminalHandle,
    workspaceScopeEntries,
    selectCanvasTab,
    setTerminalTileRepoScope,
    sendAgentKill,
    sendTerminalAttach,
    sendTerminalCreate,
    sendTerminalDetach,
    sendTerminalInput,
    sendTerminalResize,
    termWsConnected,
    tileLayout.root,
    thoughtsDraftInjection,
    thoughtsMissionState,
    thoughtsOpen,
    activeTileId,
    orchestratorWorkspaceTargets,
    launchOrchestrationPacket,
    focusOrchestrationPacketLane,
    workspaceTerminalResetNonceByTileId,
    workspacePreviews,
  ]);
  const showAgentPanelFtux = activeFtuxMilestone === 'firstAgentSpawned';
  const showCanvasFtux = activeFtuxMilestone === 'firstFileChange';
  const showApprovalFtux = activeFtuxMilestone === 'firstApproval';
  const showCompletionFtux = activeFtuxMilestone === 'firstCompletion';
  const showMobileFtux = activeFtuxMilestone === 'firstMobilePrompt';
  const changedFileLabel = ftuxFirstChangedFile?.path.split('/').pop() ?? 'your latest edit';
  const mobilePromptBody = mobileRemoteHref.startsWith('http')
    ? `Use ${mobileRemoteHref.replace(/^https?:\/\//, '')} from your phone the next time you need to review an approval away from your desk.`
    : 'Open the mobile remote next time you want to review an approval away from your desk.';
  const mobilePromptActions: GuidedDiscoveryAction[] = [
    {
      label: 'Open mobile remote',
      href: mobileRemoteHref,
      emphasized: true,
    },
  ];

  if (mobileRemoteHref.startsWith('http')) {
    mobilePromptActions.push({
      label: 'Copy link',
      onClick: () => {
        void navigator.clipboard?.writeText(mobileRemoteHref).catch(() => undefined);
        dismissFtuxMilestone();
      },
    });
  }

  return (
    <div data-vibrancy-passthrough="" style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--t-bg-gradient)',
      backdropFilter: 'blur(18px) saturate(1.02)',
      WebkitBackdropFilter: 'blur(18px) saturate(1.02)',
      color: 'var(--t-text)',
      fontFamily: 'system-ui',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* ── Update Banner ── */}
      <UpdateBanner />

      {/* ── Title Bar ── */}
      <TitleBar
        selectedRepoEntry={globalRepoEntry}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible(v => !v)}
        bottomPanelVisible={bottomPanelVisible}
        onToggleBottomPanel={toggleContextualPanelTile}
        chatVisible={false}
        onToggleChat={handleToggleWorkspacePanel}
        workspacePanelVisible={chatVisible && rightPanelMode === 'workspace'}
        onToggleWorkspacePanel={handleToggleWorkspacePanel}
        wsStatus={wsStatus}
        renderSearch={(onClose) => (
          <UniversalSearch
            variant="desktop"
            workspace={activeWorkspace}
            repo={globalRepo ?? undefined}
            agentsJson={agentsJson}
            actions={paletteActions}
            onSelectSession={(sessionKey) => { handleSelectSession(sessionKey); onClose(); }}
            onSelectIssue={(num) => { handleSelectIssue(num); onClose(); }}
            onSelectFile={(filePath, line) => {
              openCanvasTab({
                id: `file:${filePath}${activeWorkspace ? `:${activeWorkspace}` : ''}`,
                kind: 'file',
                label: filePath.split('/').pop() ?? filePath,
                resourceId: filePath,
                meta: {
                  ...(activeWorkspace ? { workspace: activeWorkspace } : {}),
                  ...(line ? { line: String(line) } : {}),
                },
              });
              onClose();
            }}
            onClose={onClose}
          />
        )}
      />

      <AnimatePresence initial={false}>
        {showApprovalFtux ? (
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={FTUX_SPRING_TRANSITION}
            style={{
              alignSelf: 'flex-end',
              marginTop: 12,
              marginRight: 16,
              marginBottom: timelineVisible ? 0 : 12,
              marginLeft: 16,
              minHeight: 44,
              padding: '12px 14px',
              borderRadius: 14,
              border: '1px solid color-mix(in srgb, var(--t-accent, #2563eb) 22%, transparent)',
              background: 'color-mix(in srgb, var(--t-panel-translucent, rgba(255,255,255,0.9)) 90%, white 10%)',
              backdropFilter: 'blur(18px)',
              WebkitBackdropFilter: 'blur(18px)',
              boxShadow: '0 18px 48px rgba(15, 23, 42, 0.12)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              maxWidth: 460,
              zIndex: 20,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span style={{
                fontSize: 10,
                lineHeight: 1.2,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--t-text-muted)',
              }}>
                Guided Discovery
              </span>
              <strong style={{
                fontSize: 14,
                lineHeight: 1.3,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: 'var(--t-text)',
              }}>
                Agents check with you before risky actions
              </strong>
              <span style={{
                fontSize: 12,
                lineHeight: 1.55,
                letterSpacing: '-0.01em',
                color: 'var(--t-text-muted)',
              }}>
                Approval requests stay inline, so you can review the command or diff without leaving the flow.
              </span>
            </div>
            <button
              type="button"
              onClick={openApprovalsDiscoverySurface}
              style={{
                minHeight: 44,
                padding: '0 14px',
                borderRadius: 12,
                border: '1px solid color-mix(in srgb, var(--t-accent, #2563eb) 24%, transparent)',
                background: 'color-mix(in srgb, var(--t-accent, #2563eb) 10%, transparent)',
                color: 'var(--t-text)',
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                cursor: 'pointer',
                fontFamily: 'system-ui',
                flexShrink: 0,
              }}
            >
              Review approval
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ── Session Timeline ── */}
      {timelineVisible && (
        <div style={{ position: 'relative', zIndex: 1 }}>
          <GuidedDiscoveryHalo active={showCompletionFtux} borderRadius={18} />
          <GuidedDiscoveryCoachmark
            visible={showCompletionFtux}
            position="top-right"
            title="Completed sessions land here"
            body="The timeline keeps the latest run in view, and the activity feed on the left will start surfacing the related commit trail."
            actions={[
              {
                label: 'Open session replay',
                onClick: () => {
                  dismissFtuxMilestone();
                  openCanvasTab({
                    id: 'timeline:session',
                    kind: 'timeline',
                    label: 'Session Replay',
                    resourceId: 'session',
                  });
                },
                emphasized: true,
              },
            ]}
          />
          <SessionTimeline
            repoPath={globalRepoEntry?.localPath ?? activeWorkspace ?? null}
            repoName={globalRepoEntry?.name ?? null}
            onExpand={() => {
              openCanvasTab({
                id: 'timeline:session',
                kind: 'timeline',
                label: 'Session Replay',
                resourceId: 'session',
              });
            }}
          />
        </div>
      )}

      {/* ── Main Layout (horizontal) ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden',
        minHeight: 0, // critical: allow flex children to shrink for scroll
      }}>
      {/* ── Nav Rail + Left Panel ── */}
      {sidebarVisible && <NavRail
        activeSection={activeNavSection}
        onSectionChange={(section) => {
          // Dismiss ThoughtsCard when switching nav sections
          setThoughtsOpen(false);
          if (section === 'approvals') {
            openApprovalsDiscoverySurface();
            return;
          }
          if (section === 'settings') {
            // Settings is a full center-workspace view — don't force chat panel open
            setActiveNavSection('settings');
            setShowMemoryView(false);
            return;
          }
          setActiveNavSection(section);
          // Always show chat when switching nav sections
          if (!chatVisible) setChatVisible(true);
          setRightPanelMode('chat');
          if (section === 'memory') setShowMemoryView(true);
          else setShowMemoryView(false);
          if (section === 'terminal') {
            // Show the contextual panel if not already visible
            const existing = findLeafByContentKind(tileLayout.root, 'contextual-panel');
            if (!existing) {
              toggleContextualPanelTile();
            }
          }
        }}
        alertCount={unreadCount}
        approvalCount={approvalCount}
        onAlertClick={() => setAlertTrayOpen(!alertTrayOpen)}
        alertTray={(
          <AlertTray
            alerts={activeAlerts}
            open={alertTrayOpen}
            onClose={() => setAlertTrayOpen(false)}
            onMarkRead={markRead}
            onMarkAllRead={markAllRead}
            onDismiss={dismiss}
            onDismissAll={dismissAll}
            onAction={handleAlertAction}
            variant="desktop"
          />
        )}
        thoughtsOpen={thoughtsOpen}
        onThoughtsToggle={() => setThoughtsOpen(v => !v)}
        onPortPreview={(port, url, repo) => {
          const previewId = `preview-${port}`;
          setWorkspacePreviews((current) => {
            if (current.some((preview) => preview.id === previewId)) {
              return current;
            }
            return [
              ...current,
              {
                id: previewId,
                tabId: '',
                url,
                port,
                detectedAt: Date.now(),
              },
            ];
          });
          ensureTileKind('preview', {
            direction: 'vertical',
            preferredKinds: ['terminal', 'contextual-panel'],
            ratio: 0.56,
            selectedPreviewId: previewId,
          });
        }}
      />}

      {/* ── Left: Agent Panel ── */}
      {sidebarVisible && (
        <motion.div
          animate={{ width: leftWidth }}
          transition={showAgentPanelFtux ? FTUX_SPRING_TRANSITION : { duration: 0.001 }}
          style={{
            width: leftWidth,
            flexShrink: 0,
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <GuidedDiscoveryHalo active={showAgentPanelFtux} borderRadius={20} />
          <GuidedDiscoveryCoachmark
            visible={showAgentPanelFtux}
            position="top-left"
            title="Live agent sessions appear here"
            body="When you dispatch work, Cortex expands this rail and keeps the active session card within reach."
          />
          <AgentPanel
            activeSessionKey={activeSessionKey ?? null}
            selectedRepo={globalRepo ?? repoSlugFromRemote(workspaceTerminalPreferredRepo?.remoteUrl)}
            selectedRepoBranch={globalRepoEntry?.readiness?.currentBranch ?? globalRepoBranch ?? workspaceTerminalPreferredRepo?.branch ?? null}
            selectedRepoLocalPath={globalRepoEntry?.localPath ?? workspaceTerminalPreferredRepo?.localPath ?? null}
            activeWorkspacePath={activeWorkspace ?? null}
            selectedRepoReadiness={globalRepoEntry?.readiness ?? workspaceTerminalPreferredRepo?.readiness ?? null}
            onLaunchWorkspaceAgent={handleLaunchWorkspaceAgent}
            onLaunchWorkspaceTask={handleLaunchWorkspaceRepoTask}
            onSelectSession={handleSelectSession}
            onSelectIssue={handleSelectIssue}
            onSelectCommit={handleSelectCommit}
            onSelectPR={handleSelectPR}
            onReviewPR={handleReviewPR}
            onRepoRemoved={handleRepoRemoved}
            onExpandWorkspace={handleExpandWorkspace}
            onSelectFile={handleSelectFile}
            onOpenCI={handleOpenCI}
            onCreateIssue={handleCreateIssue}
            onOpenGitLog={handleOpenGitLog}
            onOpenDeploy={handleOpenDeploy}
            onOpenMemory={handleOpenMemory}
            onAgentsUpdate={handleAgentsUpdate}
            onAgentKill={sendAgentKill}
            lifecycleEvents={lifecycleEvents}
            orchestratorPackets={thoughtsMissionState.packets}
            ideWorkspaceSessions={ideWorkspaceSessionsForSidebar}
          />
        </motion.div>
      )}

      {/* ── Left drag handle ── */}
      {sidebarVisible && <div
        onMouseDown={startLeftDrag}
        onMouseEnter={(e) => { const bar = e.currentTarget.firstElementChild as HTMLElement; if (bar) bar.style.opacity = '1'; }}
        onMouseLeave={(e) => { const bar = e.currentTarget.firstElementChild as HTMLElement; if (bar) bar.style.opacity = '0'; }}
        style={{
          width: 6,
          cursor: 'col-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <div style={{
          width: 3,
          height: 40,
          borderRadius: 2,
          backgroundColor: 'var(--t-drag-handle)',
          opacity: 0,
          transition: 'opacity 150ms',
        }} />
      </div>}

      {/* ── Center: Workspace Surface ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        minWidth: 0,
        background: 'transparent',
        borderRadius: 0,
      }}>
        <GuidedDiscoveryHalo active={showCanvasFtux} borderRadius={18} />
        <GuidedDiscoveryCoachmark
          visible={showCanvasFtux}
          position="top-left"
          title="Your agent made changes"
          body={`Use the workspace canvas to inspect ${changedFileLabel} and keep following the edit trail as the agent works.`}
          actions={ftuxFirstChangedFile?.path ? [
            {
              label: 'Review file',
              onClick: () => {
                dismissFtuxMilestone();
                handleSelectFile(ftuxFirstChangedFile.path, ftuxFirstChangedFile.workspace ?? undefined);
              },
              emphasized: true,
            },
          ] : []}
        />
        {activeNavSection === 'settings' && !showMemoryView && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>Loading settings...</div>}>
            <LazySettingsPage initialTab={settingsInitialTab} />
            </Suspense>
          </div>
        )}

        {activeNavSection === 'analytics' && !showMemoryView && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>Loading analytics...</div>}>
            <LazyAnalyticsPage />
            </Suspense>
          </div>
        )}

        {showMemoryView && (
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => setShowMemoryView(false)}
              style={{
                position: 'absolute',
                bottom: 14,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 100,
                paddingTop: 6,
                paddingRight: 14,
                paddingBottom: 6,
                paddingLeft: 14,
                borderRadius: 8,
                border: '1px solid rgba(148,163,184,0.15)',
                background: 'rgba(10, 14, 26, 0.85)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                color: '#94a3b8',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              ← Back to Workspace
            </button>
            <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>Loading memory graph...</div>}>
            <LazyGraphExplorer3D />
            </Suspense>
          </div>
        )}

        {!showMemoryView && activeNavSection !== 'settings' && activeNavSection !== 'analytics' && (
          <TileContainer
            layout={tileLayout}
            activeTileId={activeTileId}
            registry={tileRegistry}
            onActivateTile={setActiveTileId}
            onCloseTile={handleCloseTile}
            onResizeSplit={handleResizeSplit}
            onSplitTile={handleSplitTile}
          />
        )}
      </div>

      <AnimatePresence initial={false}>
        {chatVisible ? (
          <motion.div
            key="right-panel-shell"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            style={{
              display: 'flex',
              height: '100%',
              flexShrink: 0,
            }}
          >
            <div
              onMouseDown={startRightDrag}
              onMouseEnter={(e) => { const bar = e.currentTarget.firstElementChild as HTMLElement; if (bar) bar.style.opacity = '1'; }}
              onMouseLeave={(e) => { const bar = e.currentTarget.firstElementChild as HTMLElement; if (bar) bar.style.opacity = '0'; }}
              style={{
                width: 6,
                cursor: 'col-resize',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                zIndex: 10,
              }}
            >
              <div style={{
                width: 3,
                height: 40,
                borderRadius: 2,
                backgroundColor: 'var(--t-drag-handle)',
                opacity: 0,
                transition: 'opacity 150ms',
              }} />
            </div>

            <div
              style={{
                width: rightWidth,
                flexShrink: 0,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <AnimatePresence initial={false} mode="wait">
                <motion.div
                  key={`${rightPanelMode}:${workspaceSidePanelView}:${workspaceSidePanelActivationKey}`}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  style={{
                    flex: 1,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                    <WorkspaceSidePanel
                      view={workspaceSidePanelView}
                      repo={workspaceSidePanelRepo}
                      onClearView={() => setChatVisible(false)}
                      onOpenFile={(filePath, repo) => handleSelectFile(filePath, repo?.localPath)}
                      chatTargetLabel={workspaceChatTargetLabel}
                      chatTargets={workspaceChatTargets}
                      selectedChatTargetKey={activeWorkspaceChatTargetKey}
                      onSelectChatTarget={handleSelectWorkspaceChatTarget}
                      onInjectChatContext={(payload, repo) => injectPayloadIntoRepoChat(payload, repo)}
                      preferredPullRequestNumber={workspaceSidePanelPullRequestNumber}
                      compactReview={workspaceSidePanelCompactReview}
                      onOpenPullRequest={handleSelectPR}
                      onDeepReviewPullRequest={handleDeepReviewPR}
                      onExpandReviewRail={() => setWorkspaceSidePanelCompactReview(false)}
                      onSelectCommit={handleSelectCommit}
                    />
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>


      {/* ── Alert Toast (desktop only — urgent alerts slide in bottom-left near bell) ── */}
      <AlertToast alerts={activeAlerts} onAction={handleAlertAction} />
      </div>{/* end main layout */}

      <GuidedDiscoveryCoachmark
        visible={showMobileFtux}
        position="bottom-right"
        title="Approve from your phone next time"
        body={mobilePromptBody}
        actions={mobilePromptActions}
        maxWidth={340}
      />

      {/* ── Thoughts Card (floating overlay — sits on top of everything) ── */}
      <Suspense fallback={null}>
      <LazyThoughtsCard
        open={thoughtsOpen}
        onClose={() => setThoughtsOpen(false)}
        agents={parsedAgents}
        draftInjection={thoughtsOpen ? thoughtsDraftInjection : null}
        missionState={thoughtsMissionState}
        workspaceTargets={orchestratorWorkspaceTargets}
        onMissionStateChange={handleThoughtsMissionStateChange}
        onLaunchPacket={launchOrchestrationPacket}
        onFocusPacket={focusOrchestrationPacketLane}
      />
      </Suspense>

      {/* ── First Launch Onboarding ── */}
      {setupWizardOpen && (
        <Suspense fallback={null}>
          <LazyOnboarding onComplete={handleSetupComplete} />
        </Suspense>
      )}

    </div>
  );
}
