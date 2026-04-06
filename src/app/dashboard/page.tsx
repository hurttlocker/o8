'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- dashboard shell is mid-refactor and keeps dormant wiring for upcoming panels */

import { lazy, Suspense, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { isTauri, initMcpPlugin } from '@/lib/tauri/bridge';
import { AnimatePresence, motion } from 'framer-motion';
import { DesktopWebSocketProvider, useSharedDesktopWs, type WsConnectionState } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { ReactiveQueryProvider } from '@/lib/query/provider';
import { useReactiveQuery } from '@/lib/query/use-reactive-query';
import { AgentPanel } from '@/components/desktop/AgentPanel';
// WorkspacesPanel merged into AgentPanel — unified agent+workspace view
import { AgentPanelChat } from '@/components/desktop/AgentPanelChat';
import type { CanvasTab } from '@/components/desktop/Canvas';
import { UniversalSearch } from '@/components/shared/UniversalSearch';
// GraphExplorer3D lazy-loaded below
import { AlertProvider, useAlerts } from '@/lib/alerts/context';
import type { ApprovalRecord } from '@/lib/approvals/types';
import { UpdateBanner } from '@/components/desktop/UpdateBanner';
import { ThemeProvider } from '@/lib/theme/context';
import { AlertTray } from '@/components/shared/AlertTray';
import { AlertToast } from '@/components/shared/AlertToast';
import { NavRail, type NavSection } from '@/components/desktop/NavRail';
import type { ContextualPanelHandle } from '@/components/desktop/ContextualPanel';
import { TitleBar } from '@/components/desktop/TitleBar';
import { SessionTimeline } from '@/components/desktop/SessionTimeline';
import { readTimelineVisible, subscribeTimelineVisible } from '@/lib/appearance/timeline';
import type { SettingsTab } from '@/components/desktop/SettingsPage';
import { ApprovalQueuePanel } from '@/components/desktop/ApprovalQueuePanel';
// AnalyticsPage lazy-loaded below
import { WorkspaceSidePanel, type WorkspaceSidePanelRepo, type WorkspaceSidePanelView } from '@/components/desktop/WorkspaceSidePanel';
import { O8Panel, type O8Tab } from '@/components/desktop/O8Panel';
import { fetchOnce } from '@/lib/panel/fetch-cache';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type {
  OrchestratorLaneBinding,
  OrchestratorLaneSnapshot,
  OrchestratorPacket,
  OrchestratorRuntimeTruth,
  WorkspaceLaneState,
  WorkspaceOrchestrationPacketBadge,
} from '@/lib/orchestrator/types';
import {
  reconcileOrchestratorMissionState,
  updateOrchestratorMissionState,
  type DomainLaneSummary,
} from '@/lib/orchestrator/store';
import type { RealtimeEventEnvelope } from '@/lib/realtime/types';
import type { WorkspaceLifecycleRecordView, WorkspaceLifecycleSummaryView } from '@/lib/workspace/lifecycle-types';
import type {
  CanvasTileState,
  PaletteAgentSummary,
  WorkspaceChatTargetOption,
} from './types';
import {
  FTUX_SPRING_TRANSITION,
  GuidedDiscoveryCoachmark,
  GuidedDiscoveryHalo,
  type GuidedDiscoveryAction,
} from './ftux';
import {
  buildOrchestrationPacketBadge,
  buildOrchestrationPacketDraft,
  buildWorkspaceChatTargetOptions,
  clearRepoScopeFromTileLayout,
  collectRepoScopedTileIds,
  collectTerminalLeafIds,
  findCanvasLeafByRepoPath,
  findTerminalLeafByRepoPath,
  findUnscopedCanvasLeaf,
  findUnscopedTerminalLeaf,
  openedLaneSessionsCache,
  packetStatusFromLaneStatus,
  parseIssueNumber,
  pathBelongsToRepoScope,
  repoSlugFromAgent,
  repoSlugFromRemote,
  sameWorkspaceSidePanelRepo,
  sessionBelongsToRepoScope,
  summarizeLifecycleRecords,
} from './utils';
import { useFtuxMilestones } from './hooks/useFtuxMilestones';
import { useGlobalRepoState } from './hooks/useGlobalRepoState';
import { useOrchestratorMission } from './hooks/useOrchestratorMission';
import { usePaletteActions } from './hooks/usePaletteActions';
import { useSetupWizard } from './hooks/useSetupWizard';
import { useTileLayout } from './hooks/useTileLayout';
import { useWorkspaceTerminal } from './hooks/useWorkspaceTerminal';
import { createTileRegistry } from './tileRegistry';

/* ── Lazy-loaded heavy components (code-split for faster initial paint) ── */
const LazySettingsPage = lazy(() => import('@/components/desktop/SettingsPage').then(m => ({ default: m.SettingsPage })));
const LazyAnalyticsPage = lazy(() => import('@/components/desktop/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const LazyGraphExplorer3D = lazy(() => import('@/components/desktop/GraphExplorer3D').then(m => ({ default: m.GraphExplorer3D })));
const LazyThoughtsCard = lazy(() => import('@/components/desktop/ThoughtsCard').then(m => ({ default: m.ThoughtsCard })));
const LazySetupWizard = lazy(() => import('@/components/desktop/SetupWizard').then(m => ({ default: m.SetupWizard })));
const LazyOnboarding = lazy(() => import('@/components/desktop/Onboarding').then(m => ({ default: m.Onboarding })));
import { TileContainer } from '@/components/desktop/TileContainer';
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
  countLeaves,
  splitTile,
  wrapRootWithSplit,
} from '@/lib/tiles/operations';
import type { TileContentKind, TileLayout, TileLeafNode } from '@/lib/tiles/types';

const DEFAULT_LEFT_PANEL_WIDTH = 240;
const DEFAULT_RIGHT_PANEL_WIDTH = 280;
const MIN_RIGHT_PANEL_WIDTH = 240;
const MAX_RIGHT_PANEL_WIDTH = 600;
const DEFAULT_O8_PANEL_WIDTH = 700;
const MIN_O8_PANEL_WIDTH = 400;
const MAX_O8_PANEL_WIDTH = 1200;

function approvalInboxFingerprint(snapshot: MobileInboxSnapshot | null | undefined): string | null {
  if (!snapshot) return null;

  const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const summaryApprovals = typeof snapshot.summary?.approvals === 'number' ? snapshot.summary.approvals : 0;

  const pendingApprovals = approvals
    .map((approval) => `${approval.id}:${approval.sessionKey}:${approval.createdAt}`)
    .join('|');
  const approvalItems = items
    .filter((item) => item.kind === 'approval' || Boolean(item.approvalId))
    .map((item) => `${item.id}:${item.approvalId ?? ''}:${item.sessionKey ?? ''}`)
    .join('|');
  const pendingSessions = sessions
    .filter((session) => session.approvalStatus === 'pending')
    .map((session) => `${session.sessionKey}:${session.lastEventAt ?? ''}`)
    .join('|');

  return `${summaryApprovals}:${pendingApprovals}:${approvalItems}:${pendingSessions}`;
}

function reviewPayloadTouchesApprovals(data: Record<string, unknown>): boolean {
  const event = typeof data.event === 'string' ? data.event.toLowerCase() : '';
  const kind = typeof data.kind === 'string' ? data.kind.toLowerCase() : '';
  const title = typeof data.title === 'string' ? data.title.toLowerCase() : '';

  return event.includes('approval')
    || kind.includes('approval')
    || title.includes('approval')
    || typeof data.approvalId === 'string'
    || typeof data.approvalStatus === 'string'
    || typeof data.policyRuleId === 'string';
}

export default function DashboardPage() {
  return (
    <ThemeProvider>
      <AlertProvider>
        <ReactiveQueryProvider>
          <DesktopWebSocketProvider>
            <DashboardInner />
          </DesktopWebSocketProvider>
        </ReactiveQueryProvider>
      </AlertProvider>
    </ThemeProvider>
  );
}

function DashboardInner() {
  const [inTauri, setInTauri] = useState(false);
  useEffect(() => { setInTauri(isTauri()); initMcpPlugin(); }, []);
  const initialTileLayout = useMemo(() => createDefaultTileLayout(), []);

  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_PANEL_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  const [o8Width, setO8Width] = useState(DEFAULT_O8_PANEL_WIDTH);
  const [activeSessionKey, setActiveSessionKey] = useState<string | undefined>();
  const [liveOutputCollapsed, setLiveOutputCollapsed] = useState(false);
  const contextualPanelHandlesRef = useRef<Map<string, ContextualPanelHandle>>(new Map());
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
  const [rightPanelKind, setRightPanelKind] = useState<'review' | 'o8'>('review');
  const [o8ActiveTab, setO8ActiveTab] = useState<O8Tab>('changes');
  const [o8PrNumber, setO8PrNumber] = useState<number | null>(null);
  const [o8PrRepo, setO8PrRepo] = useState<string | null>(null);
  const [o8BrowserUrl, setO8BrowserUrl] = useState<string | null>(null);
  const [o8CommitSha, setO8CommitSha] = useState<string | null>(null);
  const [o8CommitRepoPath, setO8CommitRepoPath] = useState<string | null>(null);
  const [o8CommitRepoSlug, setO8CommitRepoSlug] = useState<string | null>(null);
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
  const {
    handleThoughtsMissionStateChange,
    scheduleThoughtsMissionPersist,
    setThoughtsMissionState,
    thoughtsMissionState,
  } = useOrchestratorMission();
  const [tileLayout, setTileLayout] = useState<TileLayout>(initialTileLayout);
  const [activeTileId, setActiveTileId] = useState<string | null>(getFirstLeaf(initialTileLayout.root).id);
  const [mobileRemoteHref, setMobileRemoteHref] = useState('/mobile');
  const lastWorkspacePanelViewRef = useRef<'diff' | 'review'>('diff');
  const lastMarkedWorkspaceReadRef = useRef<string>('');
  const approvalRefreshRef = useRef<() => void>(() => {});
  const lastApprovalInboxFingerprintRef = useRef<string | null>(null);

  const triggerApprovalRefreshFromInbox = useCallback((snapshot: MobileInboxSnapshot | null | undefined) => {
    const nextFingerprint = approvalInboxFingerprint(snapshot);
    if (nextFingerprint === null) return;
    if (lastApprovalInboxFingerprintRef.current === null) {
      lastApprovalInboxFingerprintRef.current = nextFingerprint;
      return;
    }
    if (lastApprovalInboxFingerprintRef.current === nextFingerprint) return;
    lastApprovalInboxFingerprintRef.current = nextFingerprint;
    approvalRefreshRef.current();
  }, []);

  const approvalWsCallbacks = useMemo(() => ({
    onInboxUpdate: (data: Record<string, unknown>) => {
      triggerApprovalRefreshFromInbox(data as unknown as MobileInboxSnapshot);
    },
    onReviewUpdate: (data: Record<string, unknown>) => {
      if (reviewPayloadTouchesApprovals(data)) {
        approvalRefreshRef.current();
      }
    },
    onRealtimeEvent: (event: RealtimeEventEnvelope) => {
      if (event.channel !== 'mobile' || event.event !== 'mobile.inbox.snapshot') return;
      const payload = event.data as { inbox?: MobileInboxSnapshot };
      triggerApprovalRefreshFromInbox(payload.inbox);
    },
  }), [triggerApprovalRefreshFromInbox]);

  const { connectionState: wsStatus } = useSharedDesktopWs(undefined, approvalWsCallbacks);

  useEffect(() => subscribeTimelineVisible(setTimelineVisible), []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setMobileRemoteHref(`${window.location.origin}/mobile`);
  }, []);

  const {
    activeFtuxMilestone,
    dismissFtuxMilestone,
    enqueueFtuxMilestone,
    ftuxDormant,
    ftuxFirstChangedFile,
    ftuxMilestones,
    setFtuxFirstChangedFile,
  } = useFtuxMilestones({
    sidebarVisible,
    setLeftWidth,
    setSidebarVisible,
    setTimelineVisible,
    timelineVisible,
  });

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

  const { handleSetupComplete, setSetupWizardOpen, setupWizardOpen } = useSetupWizard();

  const refreshWorkspaceLifecycle = useCallback(async () => {
    try {
      const response = await fetchOnce('/api/panel/workspaces', {
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

  const {
    allRepoWorktrees,
    globalRepo,
    globalRepoBranch,
    globalRepoEntries,
    globalRepoEntry,
    globalRepoId,
    handleFocusCurrentRepoSetup,
    handleOpenFolder,
    handleOpenRepoInDesktop,
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
  } = useGlobalRepoState({
    activeWorkspace,
    setActiveNavSection,
    setShowMemoryView,
    setSidebarVisible,
    sidebarVisible,
  });

  const {
    activeWorkspaceChatSessionKey,
    activeWorkspaceLane,
    areWorkspaceTerminalRestoresSettled,
    collectOrchestratorLaneSnapshots,
    ensureWorkspaceTerminalTile,
    findInsertionTarget,
    findWorkspaceTarget,
    focusOrchestrationPacketLane,
    ideWorkspaceSessionsForSidebar,
    lifecycleEvents,
    registerWorkspaceTerminalHandle,
    sendAgentKill,
    sendTerminalAttach,
    sendTerminalCreate,
    sendTerminalDetach,
    sendTerminalInput,
    sendTerminalResize,
    setTerminalTileRepoScope,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    setWorkspaceTerminalResetNonceByTileId,
    termWsConnected,
    updateSupervisorWorkspaceTab,
    waitForWorkspaceTerminalTarget,
    workspaceChatSessionsByTileId,
    workspaceChatTargets,
    workspaceTerminalHandlesRef,
    workspaceTerminalResetNonceByTileId,
  } = useWorkspaceTerminal({
    activeTileId,
    contextualPanelHandlesRef,
    refreshWorkspaceLifecycle,
    setActiveTileId,
    setActiveWorkspace,
    setTileLayout,
    thoughtsMissionPackets: thoughtsMissionState.packets,
    tileLayout,
    workspaceScopeEntries,
    workspaceTerminalPreferredRepo,
  });
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

  const {
    activeSurfaceRepoPath,
    activeWorkspaceChatTargetKey,
    bottomPanelVisible,
    canvasStateByTileId,
    closeCanvasTab,
    ensureTileKind,
    getPreferredContextualPanelHandle,
    handleClosePreviewTileItem,
    handleCloseTile,
    handlePreviewDetected,
    handleResizeSplit,
    handleSelectPreviewTile,
    handleSplitTile,
    hasThoughtsTile,
    openCanvasTab,
    registerContextualPanelHandle,
    selectCanvasTab,
    setCanvasStateByTileId,
    setTileLayoutHydrated,
    setWorkspacePreviews,
    tileLayoutHydrated,
    toggleContextualPanelTile,
    workspaceChatTargetLabel,
    workspaceChatTargetRepoPath,
    workspacePreviews,
  } = useTileLayout({
    activeTileId,
    activeWorkspaceChatSessionKey,
    contextualPanelHandlesRef,
    findInsertionTarget,
    findWorkspaceTarget,
    globalRepoEntries,
    globalRepoEntry,
    openWorkspaceSidePanel,
    setActiveTileId,
    setTileLayout,
    tileLayout,
    workspaceChatTargetKeyByRepoPath,
    workspaceChatTargets,
    workspaceSidePanelRepoPath,
    workspaceTerminalHandlesRef,
    workspaceTerminalPreferredRepo,
    waitForWorkspaceTerminalTarget,
  });

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

  useEffect(() => {
    if (workspaceSidePanelView === 'diff' || workspaceSidePanelView === 'review') {
      lastWorkspacePanelViewRef.current = workspaceSidePanelView;
    }
  }, [workspaceSidePanelView]);

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

  useEffect(() => {
    const initTimer = setTimeout(() => { void refreshWorkspaceLifecycle(); }, 2_500);
    // WS-driven: instant refresh on lifecycle events instead of 30s polling
    const handler = () => { void refreshWorkspaceLifecycle(); };
    const wsEvents = ['o8:lane-lifecycle', 'o8:agent-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = window.setInterval(handler, 300_000); // 5min resilience fallback
    return () => {
      clearTimeout(initTimer);
      for (const e of wsEvents) window.removeEventListener(e, handler);
      window.clearInterval(fallbackId);
    };
  }, [refreshWorkspaceLifecycle]);

  useEffect(() => {
    if (wsStatus !== 'connected') return;
    void refreshWorkspaceLifecycle();
  }, [refreshWorkspaceLifecycle, wsStatus]);

  const handleOpenSettingsTab = useCallback((tab: SettingsTab) => {
    setShowMemoryView(false);
    setSettingsInitialTab(tab);
    setActiveNavSection('settings');
  }, []);
  const [desktopDraftInjection, setDesktopDraftInjection] = useState<{ id: string; text: string } | null>(null);
  const [thoughtsDraftInjection, setThoughtsDraftInjection] = useState<{ id: string; text: string } | null>(null);

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

  // ── Approval count — reactive query, invalidated by WS inbox/realtime events ──
  const { data: approvalData } = useReactiveQuery<{ approvals?: ApprovalRecord[] }>({
    queryKey: ['approvals', 'all'],
    queryFn: async () => {
      const res = await fetchOnce('/api/panel/approvals?status=all');
      if (!res.ok) return { approvals: [] };
      return await res.json() as { approvals?: ApprovalRecord[] };
    },
    wsEvents: ['inbox', 'realtime', 'lane-lifecycle'],
    staleTime: 5_000,
  });
  const approvalCount = useMemo(() => (approvalData?.approvals ?? []).filter((a) => a.status === 'pending').length, [approvalData]);
  const resolvedApprovalCount = useMemo(() => (approvalData?.approvals ?? []).filter((a) => a.status !== 'pending').length, [approvalData]);
  useEffect(() => {
    approvalRefreshRef.current = () => {
      // No-op — TanStack Query handles refetching via WS events now.
      // Kept for compatibility with components that call approvalRefreshRef.current() directly.
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

  // ── Routing callbacks for AgentPanel ──
  const handleSelectSession = useCallback((sessionKey: string) => {
    // Open the session transcript in a canvas chat tab
    void (async () => {
      const target = await waitForWorkspaceTerminalTarget({});
      if (!target) return;
      // Determine runtime from session key prefix
      const runtime = sessionKey.startsWith('claude-code') ? 'claude-code' : 'codex';
      target.handle.openCliChatSession({
        runtime,
        targetSessionKey: sessionKey,
        label: sessionKey.split(':').pop()?.slice(0, 12) ?? 'Session',
      });
    })();
  }, [waitForWorkspaceTerminalTarget]);

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
    // Open O8 panel to PRs tab — prNumber 0 means show the list
    setO8CommitSha(null);
    setO8CommitRepoPath(null);
    setO8CommitRepoSlug(null);
    setO8ActiveTab('prs');
    setO8PrNumber(prNumber || null);
    setO8PrRepo(repo ?? null);
    setRightPanelKind('o8');
    setChatVisible(true);
  }, []);

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
    // Open review panel (first state in the cycle)
    setRightPanelKind('review');
    const nextView = workspaceSidePanelView === 'review' || workspaceSidePanelView === 'diff'
      ? workspaceSidePanelView
      : lastWorkspacePanelViewRef.current;
    openWorkspaceSidePanel(nextView, workspaceSidePanelRepo);
  }, [openWorkspaceSidePanel, workspaceSidePanelRepo, workspaceSidePanelView]);

  const handleToggleO8Panel = useCallback(() => {
    if (rightPanelKind === 'o8' && chatVisible) {
      // o8 → collapsed — clear commit context so reopening doesn't re-expand stale commit
      setChatVisible(false);
      setRightPanelKind('review');
      setO8CommitSha(null);
      setO8CommitRepoPath(null);
      setO8CommitRepoSlug(null);
      return;
    }
    // review → o8
    setRightPanelKind('o8');
    setChatVisible(true);
  }, [chatVisible, rightPanelKind]);

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
    const repoSlug = nextMeta.repo
      ?? repoSlugFromRemote(matchedRepo?.remoteUrl)
      ?? null;

    setO8PrNumber(null);
    setO8PrRepo(null);
    setO8ActiveTab('changes');
    setO8CommitSha(hash);
    setO8CommitRepoPath(repoPath);
    setO8CommitRepoSlug(repoSlug);
    setRightPanelKind('o8');
    setChatVisible(true);
  }, [globalRepoEntries, globalRepoEntry]);

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

  // ── O8 panel drag handle ──
  const startO8Drag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = o8Width;
    const onMove = (ev: MouseEvent) => {
      setO8Width(Math.min(Math.max(startW + (startX - ev.clientX), MIN_O8_PANEL_WIDTH), MAX_O8_PANEL_WIDTH));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [o8Width]);

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
    setFtuxFirstChangedFile,
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

  // ── Domain lanes — reactive query, invalidated by WS lane-lifecycle events ──
  const { data: domainLanesRaw } = useReactiveQuery<{ lanes?: Array<{ id: string; packetId: string | null; status: string; sessionKey: string | null }> }>({
    queryKey: ['lanes', 'active'],
    queryFn: async () => {
      const res = await fetchOnce('/api/lanes?active=true');
      if (!res.ok) return { lanes: [] };
      return await res.json() as { lanes?: Array<{ id: string; packetId: string | null; status: string; sessionKey: string | null }> };
    },
    wsEvents: ['lane-lifecycle', 'agent-lifecycle'],
    staleTime: 10_000,
  });
  const domainLanes = useMemo<DomainLaneSummary[]>(() => {
    return (domainLanesRaw?.lanes ?? [])
      .filter((l): l is typeof l & { packetId: string } => Boolean(l.packetId))
      .map((l) => ({ laneId: l.id, packetId: l.packetId, status: l.status, sessionKey: l.sessionKey }));
  }, [domainLanesRaw]);

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
    setThoughtsMissionState,
    thoughtsMissionState,
    tileLayoutHydrated,
    workspaceChatSessionsByTileId,
  ]);
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
  const selectedSessionWorktree = selectedSessionAgent?.worktree ?? null;

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

  const paletteActions = usePaletteActions({
    activeSessionKey,
    archivedWorkspaceCandidate,
    currentIssueTarget,
    currentReviewAgent,
    currentWorkspaceLifecycleRecord,
    focusRepoSetup,
    globalRepo,
    globalRepoEntries,
    globalRepoEntry,
    handleFocusCurrentRepoSetup,
    handleLaunchWorkspaceAgent,
    handleLaunchWorkspaceRepoTask,
    handleOpenCI,
    handleOpenFolder,
    handleOpenRepoInDesktop,
    handleOpenSettingsTab,
    handleReviewPR,
    handleRunInTerminal,
    handleSelectIssue,
    handleSelectRegisteredRepo,
    handleSelectSession,
    mutateWorkspaceLifecycle,
    nextAttentionWorkspace,
    openRepoWorkspaceModal,
    paletteAgents,
    scopedRepoAgents,
    selectedRepoWorktrees,
    selectedRepoWorktreesLoading,
    selectedSessionAgent,
    selectedSessionWorktree,
    staleSelectedRepoWorktrees,
    waitForWorkspaceTerminalTarget,
    wsStatus,
    setActiveSessionKey,
    setActiveWorkspace,
    setChatVisible,
    setSelectedRepoWorktreeRefreshNonce,
    setSetupWizardOpen,
    setSidebarVisible,
    setRightPanelMode,
  });

  const tileRegistry = useMemo(() => createTileRegistry({
    activeTileId,
    canvasStateByTileId,
    closeCanvasTab,
    ensureWorkspaceTerminalTile,
    focusOrchestrationPacketLane,
    globalRepoEntries,
    handleAgentPanelChatInjection,
    handleClosePreviewTileItem,
    handleCloseTile,
    handleLaunchWorkspaceAgent,
    handleLaunchWorkspaceRepoTask,
    handleOpenCI,
    handleOpenGitLog,
    handlePreviewDetected,
    handlePreviewSelection,
    handleSelectCommit,
    handleSelectPreviewTile,
    handleSelectRegisteredRepo,
    handleSplitTile,
    handleThoughtsMissionStateChange,
    launchOrchestrationPacket,
    openWorkspaceSidePanel,
    orchestratorWorkspaceTargets,
    parsedAgents,
    registerContextualPanelHandle,
    registerWorkspaceTerminalHandle,
    selectCanvasTab,
    setActiveTileId,
    setActiveWorkspace,
    setTileLayout,
    setTileLayoutHydrated,
    setTerminalTileRepoScope,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    setWorkspaceSidePanelRepoContext,
    sendAgentKill,
    sendTerminalAttach,
    sendTerminalCreate,
    sendTerminalDetach,
    sendTerminalInput,
    sendTerminalResize,
    termWsConnected,
    thoughtsDraftInjection,
    thoughtsMissionState,
    thoughtsOpen,
    tileLayout,
    workspacePreviews,
    workspaceScopeEntries,
    workspaceTerminalPreferredRepo,
    workspaceTerminalResetNonceByTileId,
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
    setActiveTileId,
    setActiveWorkspace,
    setTileLayout,
    setTileLayoutHydrated,
    setTerminalTileRepoScope,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    setWorkspaceSidePanelRepoContext,
    sendAgentKill,
    sendTerminalAttach,
    sendTerminalCreate,
    sendTerminalDetach,
    sendTerminalInput,
    sendTerminalResize,
    termWsConnected,
    tileLayout,
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
    <div data-vibrancy-passthrough="" data-mcp-scope="dashboard" style={{
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
        workspacePanelVisible={chatVisible && rightPanelKind === 'review'}
        onToggleWorkspacePanel={handleToggleWorkspacePanel}
        o8PanelVisible={chatVisible && rightPanelKind === 'o8'}
        onToggleO8Panel={handleToggleO8Panel}
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
      <div data-mcp-scope="main-layout" style={{
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
        onPortPreview={(_port, url) => {
          setO8BrowserUrl(url);
          setO8ActiveTab('browser');
          setRightPanelKind('o8');
          setChatVisible(true);
        }}
      />}

      {/* ── Left: Agent Panel ── */}
      {sidebarVisible && (
        <motion.div
          animate={{ width: leftWidth }}
          transition={showAgentPanelFtux ? FTUX_SPRING_TRANSITION : { duration: 0.001 }}
          data-mcp-scope="agent-panel"
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
      <div data-mcp-scope="workspace" style={{
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
              onMouseDown={rightPanelKind === 'o8' ? startO8Drag : startRightDrag}
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

            <motion.div
              data-mcp-scope="chat-panel"
              initial={false}
              animate={{ width: rightPanelKind === 'o8' ? o8Width : rightWidth }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              style={{
                flexShrink: 0,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <AnimatePresence initial={false} mode="wait">
                {rightPanelKind === 'o8' ? (
                  <motion.div
                    key="o8-panel"
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
                    <O8Panel
                      onClose={handleToggleO8Panel}
                      repoPath={o8CommitRepoPath ?? globalRepoEntry?.localPath}
                      previews={workspacePreviews}
                      activeTab={o8ActiveTab}
                      onActiveTabChange={setO8ActiveTab}
                      prNumber={o8PrNumber}
                      prRepo={o8PrRepo}
                      repoSlug={o8CommitRepoSlug ?? repoSlugFromRemote(globalRepoEntry?.remoteUrl)}
                      browserUrl={o8BrowserUrl}
                      commitSha={o8CommitSha}
                      onEditWithAI={(context) => injectPayloadIntoRepoChat({ reason: 'element-edit', text: context }, null)}
                      onOpenFile={(filePath) => {
                        const tab = { id: `file:${filePath}`, kind: 'file' as const, label: filePath.split('/').pop() ?? filePath, resourceId: filePath };
                        void (async () => {
                          const target = await waitForWorkspaceTerminalTarget({});
                          if (target) target.handle.openInspectorTab(tab);
                          else openCanvasTab(tab);
                        })();
                      }}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key={`review:${workspaceSidePanelView}:${workspaceSidePanelActivationKey}`}
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
                )}
              </AnimatePresence>
            </motion.div>
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
