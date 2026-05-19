'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- dashboard shell is mid-refactor and keeps dormant wiring for upcoming panels */

import { lazy, Suspense, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import { AnimatePresence, motion } from 'framer-motion';
import { DesktopWebSocketProvider, useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { bootstrapTranscripts } from '@/lib/transcripts/bootstrap';
import { buildTranscriptWsCallbacks } from '@/lib/transcripts/wireWsBridge';
import { mergeTranscriptEntries } from '@/components/desktop/workspace-terminal/utils';
import { ReactiveQueryProvider } from '@/lib/query/provider';
import { useReactiveQuery } from '@/lib/query/use-reactive-query';
import { AgentPanel } from '@/components/desktop/AgentPanel';
import { AgentPanelChat } from '@/components/desktop/AgentPanelChat';
import { useLeftPanelProjectFocus } from '@/components/desktop/repo-focus/useLeftPanelProjectFocus';
import type { CanvasTab } from '@/components/desktop/Canvas';
import type { SettingsTab } from '@/components/desktop/SettingsPage';
import { AlertProvider, useAlerts } from '@/lib/alerts/context';
import { ConnectionBanner } from '@/components/desktop/ConnectionBanner';
import { ThemeProvider } from '@/lib/theme/context';
import { AlertToast } from '@/components/shared/AlertToast';
import type { ContextualPanelHandle } from '@/components/desktop/ContextualPanel';
import { LeftHeaderStrip } from '@/components/desktop/shell/LeftHeaderStrip';
import { WorkspaceHeaderStrip } from '@/components/desktop/shell/WorkspaceHeaderStrip';
import { PanelHeaderStrip } from '@/components/desktop/shell/PanelHeaderStrip';
import { DesktopStatusBar } from '@/components/desktop/DesktopStatusBar';
import { useProjects } from '@/components/desktop/repo-registry/useProjects';
import type { CommandPaletteActionItem } from '@/components/desktop/CommandPalette';
import { SessionTimeline } from '@/components/desktop/SessionTimeline';
import { ApprovalBanner } from '@/components/desktop/ApprovalBanner';
import { DictationHost } from '@/components/desktop/dictation/DictationHost';
import {
  OPEN_MOBILE_PAIRING_EVENT,
  OPEN_SETTINGS_TAB_EVENT,
  REQUEST_ADD_REPO_EVENT,
  type OpenSettingsTabDetail,
} from '@/lib/desktop/events';
import { ApprovalQueuePanel } from '@/components/desktop/ApprovalQueuePanel';
// AnalyticsPage lazy-loaded below
import type { WorkspaceSidePanelRepo } from '@/components/desktop/WorkspaceSidePanel';
import type { O8Tab } from '@/components/desktop/o8-panel/types';
import {
  markDashboardScriptStart,
  markDashboardFirstRender,
  markDashboardInteractive,
} from '@/lib/perf/dashboard-marks';
import {
  subscribeO8PanelFocus,
} from '@/lib/events/o8-panel-focus';
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
  sessionBelongsToRepoScope,
  summarizeLifecycleRecords,
} from './utils';
import { useFtuxMilestones } from './hooks/useFtuxMilestones';
import { useGlobalRepoState } from './hooks/useGlobalRepoState';
import { useLaneArchivedView } from './hooks/useLaneArchivedSet';
import { useOrchestratorMission } from './hooks/useOrchestratorMission';
import { useSessionState } from './hooks/useSessionState';
import { useSettingsOverlayDismiss } from './hooks/useSettingsOverlayDismiss';
import { useSetupWizard } from './hooks/useSetupWizard';
import { useTileLayout } from './hooks/useTileLayout';
import { useUIChrome } from './hooks/useUIChrome';
import { useWorkspaceTerminal } from './hooks/useWorkspaceTerminal';
import { useDesignMode } from '@/hooks/useDesignMode';
import { createTileRegistry } from './tileRegistry';
import { SettingsOverlay } from './SettingsOverlay';
import type { TerminalTabHandle } from '@/components/desktop/workspace-terminal/types';
import type { SavedChatRepoContext } from '@/lib/llm/chat-history';

// Mark the dashboard module load as early as possible. Runs once when the
// bundle is first parsed, before the React component is even invoked, so
// the "script-start" anchor really does represent the moment the JS bundle
// is parsed. Subsequent calls are no-ops.
markDashboardScriptStart();

/* ── Lazy-loaded heavy components (code-split for faster initial paint) ──
   Anything below is *not* on the critical bootstrap path — the user has to
   open a panel, hit Cmd+K, or trigger design mode before its chunk needs to
   load. Keeping these out of the main dashboard chunk shaves real ms off
   first-render on cold launch. */
const LazySettingsPage = lazy(() => import('@/components/desktop/SettingsPage').then(m => ({ default: m.SettingsPage })));
const LazyAnalyticsPage = lazy(() => import('@/components/desktop/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const LazyOnboarding = lazy(() => import('@/components/desktop/Onboarding').then(m => ({ default: m.Onboarding })));
const LazyCommandPalette = lazy(() => import('@/components/desktop/CommandPalette').then(m => ({ default: m.CommandPalette })));
const LazyDesignModeOverlay = lazy(() => import('@/components/desktop/DesignModeOverlay').then(m => ({ default: m.DesignModeOverlay })));
const LazyO8Panel = lazy(() => import('@/components/desktop/O8Panel').then(m => ({ default: m.O8Panel })));
// #888/#895 — packet-mode right panel (Spec / Agent Overview / Changes).
import { OrchestratorDataProvider } from '@/components/desktop/orchestrator-data-context';
import { ReviewPanel } from '@/components/desktop/review/ReviewPanel';
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
const FOCUS_LEFT_PANEL_WIDTH = 320;
const MIN_RIGHT_PANEL_WIDTH = 240;
const MAX_RIGHT_PANEL_WIDTH = 600;
const MIN_O8_PANEL_WIDTH = 400;
const MAX_O8_PANEL_WIDTH = 1200;
const COMPACT_SHELL_MEDIA_QUERY = '(max-width: 980px)';
const O8_ACTIVE_TAB_STORAGE_KEY = 'o8ActiveTab';
const DEFAULT_O8_ACTIVE_TAB: O8Tab = 'activity';

function normalizeO8ActiveTab(raw: string | null | undefined): O8Tab | null {
  if (!raw) return null;
  if (raw === 'files' || raw === 'diff' || raw === 'changes') return 'workspace';
  if (
    raw === 'workspace'
    || raw === 'browser'
    || raw === 'prs'
    || raw === 'activity'
    || raw === 'inbox'
    || raw === 'spec'
  ) {
    return raw;
  }
  return null;
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
  // Perf mark — capture the moment the dashboard component begins its first
  // render. Pairs with markDashboardScriptStart() (called at module load)
  // and markDashboardInteractive() (scheduled below on the next idle tick)
  // to produce the [perf] bootstrap log.
  markDashboardFirstRender();

  const [inTauri, setInTauri] = useState(false);
  useEffect(() => {
    setInTauri(isTauri());
    // tauri-plugin-mcp no longer needs JS-side init — the eval_and_await
    // protocol shipped in #932 phase 2 invokes JS from Rust per call.
    // Schedule the "interactive" mark on the first idle tick after mount.
    // requestIdleCallback is unavailable in some webview / older browser
    // environments, so we fall back to setTimeout(_, 0). Either way the
    // measure runs after React has flushed the initial render and the
    // browser has finished its first round of layout/paint.
    const schedule: (cb: () => void) => () => void = (cb) => {
      if (typeof window === 'undefined') return () => {};
      if (typeof window.requestIdleCallback === 'function') {
        const handle = window.requestIdleCallback(cb, { timeout: 1500 });
        return () => window.cancelIdleCallback(handle);
      }
      const handle = window.setTimeout(cb, 0);
      return () => window.clearTimeout(handle);
    };
    return schedule(() => markDashboardInteractive());
  }, []);
  const initialTileLayout = useMemo(() => createDefaultTileLayout(), []);
  const designMode = useDesignMode();

  // ── Grouped state hooks ──
  const uiChrome = useUIChrome();
  const {
    activeNavSection, setActiveNavSection,
    settingsInitialTab,
    sidebarVisible, setSidebarVisible,
    timelineVisible, setTimelineVisible,
    desktopDraftInjection, setDesktopDraftInjection,
    thoughtsDraftInjection, setThoughtsDraftInjection,
    mobileRemoteHref,
    handleOpenSettingsTab,
  } = uiChrome;

  const session = useSessionState();
  const {
    activeSessionKey, setActiveSessionKey,
    agentsJson, setAgentsJson,
    activeWorkspace, setActiveWorkspace,
    wsStatus,
    approvalCount,
    resolvedApprovalCount,
    parsedAgents,
    orchestratorRuntimeTruth,
  } = session;

  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_PANEL_WIDTH);
  const contextualPanelHandlesRef = useRef<Map<string, ContextualPanelHandle>>(new Map());
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const [workspaceLifecycleRecords, setWorkspaceLifecycleRecords] = useState<WorkspaceLifecycleRecordView[]>([]);
  const [workspaceLifecycleSummary, setWorkspaceLifecycleSummary] = useState<WorkspaceLifecycleSummaryView>({
    unreadCount: 0,
    archivedCount: 0,
    nextAttentionWorkspaceId: null,
  });
  const {
    handleThoughtsMissionStateChange,
    scheduleThoughtsMissionPersist,
    setThoughtsMissionState,
    thoughtsMissionState,
  } = useOrchestratorMission();
  // ── Right panel + workspace side panel state (tightly coupled to callbacks, kept inline) ──
  // SSR-safe defaults; hydrate from localStorage in an effect so the
  // visibility/kind survives a reload but server and first client render
  // match (no hydration mismatch).
  const [chatVisible, setChatVisible] = useState(false);
  const [rightPanelKind, setRightPanelKind] = useState<'review' | 'o8'>('o8');
  useEffect(() => {
    try {
      const visRaw = window.localStorage.getItem('o8:right-panel:visible');
      const kindRaw = window.localStorage.getItem('o8:right-panel:kind');
      if (visRaw === '1') setChatVisible(true);
      if (kindRaw === 'o8' || kindRaw === 'review') setRightPanelKind(kindRaw);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem('o8:right-panel:visible', chatVisible ? '1' : '0'); } catch { /* ignore */ }
  }, [chatVisible]);
  useEffect(() => {
    try { window.localStorage.setItem('o8:right-panel:kind', rightPanelKind); } catch { /* ignore */ }
  }, [rightPanelKind]);
  const [compactShell, setCompactShell] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia(COMPACT_SHELL_MEDIA_QUERY);
    const update = () => setCompactShell(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [rightWidth, setRightWidth] = useState(() => {
    if (typeof window === 'undefined') return 280;
    try {
      const stored = Number(window.localStorage.getItem('o8:right-panel:width-chat') ?? 0);
      if (Number.isFinite(stored) && stored >= MIN_RIGHT_PANEL_WIDTH && stored <= MAX_RIGHT_PANEL_WIDTH) return stored;
    } catch { /* ignore */ }
    return 280;
  });
  // Default 440px is a balance: wide enough for PRs/Activity content but
  // doesn't eat the workspace on a 1280px laptop viewport. User resizes
  // persist via the o8:right-panel:width-o8 key.
  const [o8Width, setO8Width] = useState(() => {
    if (typeof window === 'undefined') return 440;
    try {
      const stored = Number(window.localStorage.getItem('o8:right-panel:width-o8') ?? 0);
      if (Number.isFinite(stored) && stored >= MIN_O8_PANEL_WIDTH && stored <= MAX_O8_PANEL_WIDTH) return stored;
    } catch { /* ignore */ }
    return 440;
  });
  useEffect(() => {
    try { window.localStorage.setItem('o8:right-panel:width-chat', String(rightWidth)); } catch { /* ignore */ }
  }, [rightWidth]);
  useEffect(() => {
    try { window.localStorage.setItem('o8:right-panel:width-o8', String(o8Width)); } catch { /* ignore */ }
  }, [o8Width]);
  const [o8ActiveTab, setO8ActiveTab] = useState<O8Tab>(DEFAULT_O8_ACTIVE_TAB);
  const [o8PrNumber, setO8PrNumber] = useState<number | null>(null);
  const [o8PrRepo, setO8PrRepo] = useState<string | null>(null);
  const [o8BrowserUrl, setO8BrowserUrl] = useState<string | null>(null);
  // Mirrors the wide O8 panel BrowserPane's active URL so the TitleBar can
  // hover-preview it. Distinct from o8BrowserUrl (which is a one-shot
  // navigation request from the port popover etc.) — this is the live
  // current URL of whichever tab is selected inside the pane.
  const [o8BrowserHoverUrl, setO8BrowserHoverUrl] = useState<string | null>(null);
  const [o8SelectedFile, setO8SelectedFile] = useState<string | null>(null);
  const [o8SelectedFileRepoPath, setO8SelectedFileRepoPath] = useState<string | null>(null);
  const [o8RepoPathOverride, setO8RepoPathOverride] = useState<string | null>(null);
  const [o8CommitSha, setO8CommitSha] = useState<string | null>(null);
  const [o8CommitRepoPath, setO8CommitRepoPath] = useState<string | null>(null);
  const [o8CommitRepoSlug, setO8CommitRepoSlug] = useState<string | null>(null);
  const rightPanelMode = 'workspace' as const;
  const setRightPanelMode = (_mode: 'chat' | 'workspace') => { /* v1: right panel is always workspace */ };
  const [workspaceChatTargetKeyByRepoPath, setWorkspaceChatTargetKeyByRepoPath] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(O8_ACTIVE_TAB_STORAGE_KEY);
      const migrated = normalizeO8ActiveTab(raw);
      if (migrated) setO8ActiveTab(migrated);
      if (raw && migrated && raw !== migrated) {
        window.localStorage.setItem(O8_ACTIVE_TAB_STORAGE_KEY, migrated);
      }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(O8_ACTIVE_TAB_STORAGE_KEY, o8ActiveTab); } catch { /* ignore */ }
  }, [o8ActiveTab]);

  const [tileLayout, setTileLayout] = useState<TileLayout>(initialTileLayout);
  const [activeTileId, setActiveTileId] = useState<string | null>(getFirstLeaf(initialTileLayout.root).id);
  const [latestDispatchedTabId, setLatestDispatchedTabId] = useState<string | null>(null);
  const [latestDispatchedAt, setLatestDispatchedAt] = useState<number | null>(null);
  // Persist the latest-dispatch marker so a reload during an active
  // dispatch (common during dev-bridge hot-reloads) keeps the orange
  // highlight on the right tab. Treat anything older than 60min as stale
  // so old dispatches don't keep highlighting after the work is done.
  const LATEST_DISPATCH_TTL_MS = 60 * 60 * 1000;
  useEffect(() => {
    try {
      const tabRaw = window.localStorage.getItem('o8:latest-dispatch:tab-id');
      const atRaw = window.localStorage.getItem('o8:latest-dispatch:at');
      const at = atRaw ? parseInt(atRaw, 10) : NaN;
      if (tabRaw && Number.isFinite(at) && Date.now() - at < LATEST_DISPATCH_TTL_MS) {
        setLatestDispatchedTabId(tabRaw);
        setLatestDispatchedAt(at);
      }
    } catch { /* ignore */ }
  }, [LATEST_DISPATCH_TTL_MS]);
  // Latest-dispatch marker derives from mission state: whenever a packet
  // is launching/running/awaiting_review and lane.sessionKey is bound,
  // promote it to the orange marker. Re-runs on every mission update so
  // newer dispatches take over from older ones. CLI-runtime tabs use
  // sessionKey as the tab id (see openCliChatSession), so this same key
  // doubles as the highlight target.
  //
  // Previously this was a back-fill that only fired when the marker was
  // null, which meant if the in-process setLatestDispatchedTabId call
  // missed the race in handleSupervisorUpdate (the most common path for
  // MCP-dispatched packets, since lane.sessionKey lands milliseconds after
  // the supervisor "launched" event), the marker stayed null forever
  // until a manual reload + back-fill from localStorage picked it up.
  useEffect(() => {
    const packets = thoughtsMissionState.packets;
    if (!packets.length) return;
    const candidates = packets
      .filter((p) => p.lane?.sessionKey && (p.status === 'launching' || p.status === 'running' || p.status === 'awaiting_review'))
      .map((p) => ({ sessionKey: p.lane!.sessionKey!, at: p.lane?.lastEventAt ? new Date(p.lane.lastEventAt).getTime() : Date.now() }))
      .filter((c) => Number.isFinite(c.at) && c.at > 0 && Date.now() - c.at < LATEST_DISPATCH_TTL_MS);
    if (candidates.length === 0) return;
    candidates.sort((a, b) => b.at - a.at);
    const winner = candidates[0];
    if (winner.sessionKey === latestDispatchedTabId) return;
    setLatestDispatchedTabId(winner.sessionKey);
    setLatestDispatchedAt(winner.at);
  }, [LATEST_DISPATCH_TTL_MS, latestDispatchedTabId, thoughtsMissionState.packets]);
  useEffect(() => {
    try {
      if (latestDispatchedTabId) window.localStorage.setItem('o8:latest-dispatch:tab-id', latestDispatchedTabId);
      else window.localStorage.removeItem('o8:latest-dispatch:tab-id');
      if (latestDispatchedAt) window.localStorage.setItem('o8:latest-dispatch:at', String(latestDispatchedAt));
      else window.localStorage.removeItem('o8:latest-dispatch:at');
    } catch { /* ignore */ }
  }, [latestDispatchedTabId, latestDispatchedAt]);
  // Stable ref so the auto-spawn callback can look up the matching packet
  // by sessionKey without re-binding on every mission-state delta.
  const thoughtsMissionStateRef = useRef(thoughtsMissionState);
  useEffect(() => { thoughtsMissionStateRef.current = thoughtsMissionState; }, [thoughtsMissionState]);
  // #888/#895 — packet selection lifted from ThoughtsMissionPanel so the
  // right-side workspace panel can flip into packet mode (Spec / Agent
  // Overview) when one is expanded. See `src/lib/panel/mode.ts`.
  const [selectedPacketId, setSelectedPacketId] = useState<string | null>(null);
  const lastMarkedWorkspaceReadRef = useRef<string>('');

  // ── Cmd+K command palette (#661) — full-screen overlay search across
  // issues, files, agents, with localStorage LRU recents. The keydown
  // listener below skips when the user is typing in inputs/textarea/
  // contentEditable so existing native shortcuts (Cmd+K text-link in
  // markdown editors, etc.) don't break.
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const dashboardProjects = useProjects();

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
  // Workspace + side-panel chunks are deferred off the critical path so the
  // initial render is small. We then warm them on the first idle frame so
  // when the user actually clicks (or the right rail mounts), the chunk is
  // already parsed.
  useEffect(() => {
    const prefetch = () => {
      import('@/components/desktop/WorkspaceTerminal');
      import('@/components/desktop/Canvas');
      import('@/components/desktop/workspace-terminal/OrchestratorTab');
      import('@/components/desktop/O8Panel');
    };
    if (typeof requestIdleCallback === 'undefined') {
      const timer = setTimeout(prefetch, 100);
      return () => clearTimeout(timer);
    }
    const id = requestIdleCallback(prefetch);
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
    setSidebarVisible,
    sidebarVisible,
  });
  const currentO8RepoPath = o8CommitRepoPath ?? o8RepoPathOverride ?? globalRepoEntry?.localPath ?? null;
  const scopedO8SelectedFile = o8SelectedFileRepoPath === currentO8RepoPath ? o8SelectedFile : null;

  const handleO8SelectedFileChange = useCallback((filePath: string) => {
    setO8SelectedFile(filePath);
    setO8SelectedFileRepoPath(currentO8RepoPath);
  }, [currentO8RepoPath]);

  // Repo focus state owns whether the left column is in expanded "repo focus"
  // mode. Lifted here (instead of inside AgentPanel) so the column animation
  // can react to the same focusActive boolean and widen from the default
  // sidebar width to FOCUS_LEFT_PANEL_WIDTH without an overlay.
  const leftPanelFocus = useLeftPanelProjectFocus({
    registeredRepos: globalRepoEntries,
    ledger: dashboardProjects.ledger,
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
    setWorkspaceActiveTabKindByTileId,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    setWorkspaceTerminalResetNonceByTileId,
    termWsConnected,
    updateSupervisorWorkspaceTab,
    waitForWorkspaceTerminalTarget,
    workspaceActiveTabKindByTileId,
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

  // ── Client transcript store: seed known workspace sessions + bridge WS fanout ──
  const transcriptWsCallbacks = useMemo(
    () => buildTranscriptWsCallbacks({ merge: mergeTranscriptEntries }),
    [],
  );
  useSharedDesktopWs(undefined, transcriptWsCallbacks);

  const transcriptBootstrapKeysKey = useMemo(() => {
    const keys = new Set<string>();
    for (const sessions of Object.values(workspaceChatSessionsByTileId)) {
      for (const session of sessions) {
        if (session?.sessionKey) keys.add(session.sessionKey);
      }
    }
    if (activeWorkspaceChatSessionKey) keys.add(activeWorkspaceChatSessionKey);
    return [...keys].sort().join('|');
  }, [workspaceChatSessionsByTileId, activeWorkspaceChatSessionKey]);

  useEffect(() => {
    if (!transcriptBootstrapKeysKey) return;
    const sessionKeys = transcriptBootstrapKeysKey.split('|').filter(Boolean);
    if (sessionKeys.length === 0) return;
    const controller = new AbortController();
    void bootstrapTranscripts(sessionKeys, {
      merge: mergeTranscriptEntries,
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [transcriptBootstrapKeysKey]);

  // ── Active workspace-tab kind ──
  // Surfaced to the AgentPanel so the Orchestrator / Assistant rows shimmer
  // only when the corresponding workspace tab is selected, not whenever the
  // repo is focused. Falls back to the first tile with a tracked kind when
  // the activeTileId points at something non-workspace (e.g. orchestrator tile).
  const activeWorkspaceTabKind = useMemo(() => {
    if (activeTileId && workspaceActiveTabKindByTileId[activeTileId]) {
      return workspaceActiveTabKindByTileId[activeTileId];
    }
    const values = Object.values(workspaceActiveTabKindByTileId).filter((kind) => kind !== null);
    return values[0] ?? null;
  }, [activeTileId, workspaceActiveTabKindByTileId]);

  const handleOpenHistoryChatFromPanel = useCallback((
    historyTabId: string,
    title: string,
    repo?: SavedChatRepoContext | null,
  ) => {
    setActiveSessionKey(`llm-chat:${historyTabId}`);
    void (async () => {
      try {
        const target = await waitForWorkspaceTerminalTarget({
          repoPath: repo?.localPath ?? null,
          preferredTileId: activeTileId,
          fallbackToAnyExisting: true,
        });
        const snapshot = target.handle.getTabsSnapshot();
        const primaryConversationTab = snapshot.tabs.find((tab) => tab.kind === 'orchestrator')
          ?? snapshot.tabs.find((tab) => tab.kind === 'llm-chat' && tab.id !== historyTabId)
          ?? snapshot.tabs.find((tab) => tab.kind === 'llm-chat')
          ?? null;
        const tabId = primaryConversationTab && target.handle.focusTab(primaryConversationTab.id)
          ? primaryConversationTab.id
          : target.handle.openHistoryChat(historyTabId, title, repo);
        if (tabId) {
          window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId } }));
          const loadThread = () => {
            window.dispatchEvent(new CustomEvent('o8:load-history-thread', {
              detail: { tabId, historyTabId },
            }));
          };
          loadThread();
          window.setTimeout(loadThread, 120);
          window.setTimeout(loadThread, 420);
        }
      } catch {
        // Best-effort sidebar navigation; the workspace terminal may still be mounting.
      }
    })();
  }, [activeTileId, setActiveSessionKey, waitForWorkspaceTerminalTarget]);

  // ── Workspace tab hotkeys ──
  // Cmd+1..Cmd+9 jump to the Nth workspace tab, Cmd+Opt+Left / Right cycle
  // previous / next with wrap, Cmd+W closes the active tab. All dispatches
  // hit the active workspace terminal's imperative handle, which points the
  // store-backed panes to the target tab. Flash is driven off a custom event
  // that TabBar listens for and pulses an accent shadow on the target label.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isEditable = target?.isContentEditable
        || tagName === 'INPUT'
        || tagName === 'TEXTAREA'
        || tagName === 'SELECT';
      const resolveHandle = () => {
        const handles = workspaceTerminalHandlesRef.current;
        if (handles.size === 0) return null;
        if (activeTileId) {
          const matched = handles.get(activeTileId);
          if (matched) return matched;
        }
        return handles.values().next().value ?? null;
      };
      const flash = (tabId: string) => {
        window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId } }));
      };
      // Cmd+Opt+Left / Right — cycle (allow inside editable fields too)
      if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const handle = resolveHandle();
        if (!handle) return;
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        if (handle.focusTabRelative(delta)) {
          event.preventDefault();
          const snap = handle.getTabsSnapshot();
          flash(snap.activeTabId);
        }
        return;
      }
      if (isEditable && !event.altKey) {
        // Digit + Cmd+W shortcuts should not fire while the user is typing.
        // Cmd+Opt+Arrow bypasses this guard above — consistent with iTerm.
        return;
      }
      if (!event.altKey && event.key >= '1' && event.key <= '9') {
        const handle = resolveHandle();
        if (!handle) return;
        const index = Number.parseInt(event.key, 10);
        if (handle.focusTabAtIndex(index)) {
          event.preventDefault();
          const snap = handle.getTabsSnapshot();
          flash(snap.activeTabId);
        }
        return;
      }
      if (!event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        const handle = resolveHandle();
        if (!handle) return;
        if (handle.closeActiveTab()) {
          event.preventDefault();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTileId, workspaceTerminalHandlesRef]);

  // ── Cmd+K command palette hotkey (#661) ──
  // Toggles the full-screen palette overlay. Skips while the user is
  // typing in <input>, <textarea>, or contentEditable so existing native
  // shortcuts inside editors don't break. Esc closes the overlay (handled
  // inside the CommandPalette component).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isPaletteShortcut = (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && event.key.toLowerCase() === 'k';
      if (!isPaletteShortcut) return;

      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isEditable = Boolean(
        target?.isContentEditable
          || tagName === 'INPUT'
          || tagName === 'TEXTAREA'
          || tagName === 'SELECT',
      );
      if (isEditable) return;

      event.preventDefault();
      event.stopPropagation();
      setCommandPaletteOpen((current) => !current);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Active-workspace switch — clear the owned-session fleet cache so the next
  // consumer rebuilds immediately instead of serving a stale (up to 20s) TTL
  // entry from the previous workspace. Fire-and-forget; idempotent + cheap.
  // Deferred to an idle tick so it doesn't compete with synchronous bootstrap
  // work during the initial mount.
  useEffect(() => {
    if (!activeWorkspace) return;
    const controller = new AbortController();
    const run = () => {
      if (controller.signal.aborted) return;
      void fetch('/api/panel/fleet/invalidate', {
        method: 'POST',
        signal: controller.signal,
      }).catch(() => {});
    };
    let cancel: () => void;
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(run, { timeout: 2000 });
      cancel = () => window.cancelIdleCallback(handle);
    } else {
      const handle = setTimeout(run, 0);
      cancel = () => clearTimeout(handle);
    }
    return () => {
      cancel();
      controller.abort();
    };
  }, [activeWorkspace]);

  const archivedLaneView = useLaneArchivedView();

  const activePackets = useMemo(
    () => thoughtsMissionState.packets.filter((packet) => !archivedLaneView.packetIds.has(packet.id)),
    [thoughtsMissionState.packets, archivedLaneView.packetIds],
  );
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
    setActiveTileId,
    setTileLayout,
    tileLayout,
    workspaceChatTargetKeyByRepoPath,
    workspaceChatTargets,
    workspaceSidePanelRepoPath: null,
    workspaceTerminalHandlesRef,
    workspaceTerminalPreferredRepo,
    waitForWorkspaceTerminalTarget,
  });

  // Cmd/Ctrl+J toggles the orchestrator chat tile. Global shortcut,
  // ignored while the user is typing in an input.
  // Cmd+J used to toggle the thoughts tile. The Orchestrator is now a tab
  // inside WorkspaceTerminal, so the shortcut is retired. Can be reintroduced
  // later by wiring the handler into WorkspaceTerminal's focusTab handle.

  // O8 panel focus bus — when a write-class tool call in the orchestrator
  // chat emits a pivot request, swap the right panel's active tab to the
  // requested tab *only if the panel is already open*. If it's closed,
  // surface a toast the chat tile can render inline. Auto-opening the
  // panel would feel intrusive mid-conversation.
  useEffect(() => {
    const unsubscribe = subscribeO8PanelFocus((request) => {
      const panelOpen = chatVisible && rightPanelKind === 'o8';
      if (!panelOpen) {
        // Panel closed — silently drop the focus request. We used to
        // publish a toast here but no consumer ever subscribed.
        return;
      }
      const requestedTab = normalizeO8ActiveTab(request.tab);
      if (requestedTab) {
        if (requestedTab === 'workspace' && request.artifactId) {
          setO8SelectedFile(request.artifactId);
          setO8SelectedFileRepoPath(currentO8RepoPath);
        }
        setO8ActiveTab(requestedTab);
      }
    });
    return unsubscribe;
  }, [chatVisible, currentO8RepoPath, rightPanelKind]);

  useEffect(() => {
    const handleOpenInbox = () => {
      setRightPanelKind('o8');
      setChatVisible(true);
      setO8ActiveTab('inbox');
    };
    window.addEventListener('o8:open-inbox-tab', handleOpenInbox);
    return () => window.removeEventListener('o8:open-inbox-tab', handleOpenInbox);
  }, []);

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

    if (pathBelongsToRepoScope(o8RepoPathOverride, removedRepoPath)) {
      setO8RepoPathOverride(null);
      setO8SelectedFile(null);
      setO8SelectedFileRepoPath(null);
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
    setActiveSessionKey,
    setActiveWorkspace,
    setAgentsJson,
    setAllRepoWorktrees,
    setCanvasStateByTileId,
    setGlobalRepoBranch,
    setGlobalRepoEntries,
    setGlobalRepoId,
    setSelectedRepoWorktrees,
    setWorkspaceActiveTabKindByTileId,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    setWorkspaceTerminalResetNonceByTileId,
    tileLayout.root,
    workspaceChatSessionsByTileId,
    workspaceLifecycleRecords,
    o8RepoPathOverride,
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

  // ── Alert system (toast-only; tray removed) ──
  const {
    alerts: activeAlerts,
    updateAgents,
  } = useAlerts();

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
            isolationPreference: rootRepo.setup.workspaceIsolationPreference,
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

    // All four runtimes are first-class workspace-tab runtimes since v0.1.24.
    // Use packet.runtime directly so the monitoring tab shows the correct
    // agent label, streams from the right /api/mobile/history branch, and
    // pins the right default model instead of masquerading as Codex.
    const chatRuntime = packet.runtime;
    const tabId = workspaceTarget.handle.openCliChatSession({
      runtime: chatRuntime,
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
    setLatestDispatchedTabId(tabId);
    setLatestDispatchedAt(Date.now());

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
    setAllRepoWorktrees,
    thoughtsMissionState,
    waitForWorkspaceTerminalTarget,
    workspaceScopeEntries,
    workspaceTerminalPreferredRepo,
  ]);

  // ── Repo alignment — click repo name → align whole app ──
  const handleAlignToRepo = useCallback((repoId: string) => {
    void handleSelectRegisteredRepo(repoId);
    const targetRepo = globalRepoEntries.find((r) => r.id === repoId);
    if (targetRepo) {
      setO8RepoPathOverride(targetRepo.localPath);
      setO8SelectedFile(null);
      setO8SelectedFileRepoPath(null);
    }
  }, [globalRepoEntries, handleSelectRegisteredRepo]);

  // ── Routing callbacks for AgentPanel ──
  // Open the wide O8 panel pinned to a specific repo path + tab. Callers
  // that need review mode pass `workspace`; otherwise the panel lands on
  // the operator briefing pulse.
  const handleOpenO8Panel = useCallback((options: { repoPath?: string | null; tab?: O8Tab }) => {
    if (options.repoPath) setO8RepoPathOverride(options.repoPath);
    setO8ActiveTab(options.tab ?? DEFAULT_O8_ACTIVE_TAB);
    setRightPanelKind('o8');
    setChatVisible(true);
  }, []);

  const handleSelectSession = useCallback((sessionKey: string) => {
    // Open the session transcript in a canvas chat tab
    void (async () => {
      const target = await waitForWorkspaceTerminalTarget({});
      if (!target) return;
      const runtime = sessionKey.startsWith('claude-code:') ? 'claude-code'
        : sessionKey.startsWith('gemini-owned:') ? 'gemini'
        : sessionKey.startsWith('opencode-owned:') ? 'opencode'
        : 'codex';
      target.handle.openCliChatSession({
        runtime,
        targetSessionKey: sessionKey,
        label: sessionKey.split(':').pop()?.slice(0, 12) ?? 'Session',
      });

    })();
  }, [waitForWorkspaceTerminalTarget]);

  const handleSelectIssue = useCallback((issueNumber: number, repo?: string) => {
    setRightPanelKind('review');
    setChatVisible(true);
    openCanvasTab({
      id: `issue:${issueNumber}${repo ? `:${repo}` : ''}`,
      kind: 'issue',
      label: `#${issueNumber}`,
      resourceId: String(issueNumber),
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab]);

  // Stable callbacks passed to CommandPalette — extracted to avoid defeating
  // memo boundaries with fresh inline arrows on every render (#809).
  const handlePaletteOpen = useCallback(() => {
    setCommandPaletteOpen(true);
  }, []);

  const handlePaletteClose = useCallback(() => {
    setCommandPaletteOpen(false);
  }, []);

  const handlePaletteSelectIssue = useCallback((issueNumber: number, repo?: string) => {
    handleSelectIssue(issueNumber, repo);
  }, [handleSelectIssue]);

  const handlePaletteSelectFile = useCallback((filePath: string, line?: number) => {
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
  }, [activeWorkspace, openCanvasTab]);

  const handlePaletteSelectAgent = useCallback((sessionKey: string) => {
    handleSelectSession(sessionKey);
  }, [handleSelectSession]);

  const handleSelectPR = useCallback((prNumber: number, repo?: string) => {
    setRightPanelKind('review');
    setChatVisible(true);
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
    handleReviewPR(prNumber, repo);
  }, [handleReviewPR, handleSelectPR]);

  // Bridge for transcript PR-link clicks. LLMMarkdown intercepts GitHub
  // PR URLs and dispatches `o8:open-pr` instead of opening the browser;
  // the listener routes through handleReviewPR so the right panel pops
  // open at the new PrPanel.
  useEffect(() => {
    const handleOpenPr = (event: Event) => {
      const detail = (event as CustomEvent<{ prNumber?: number; repo?: string }>).detail;
      if (!detail || typeof detail.prNumber !== 'number') return;
      handleReviewPR(detail.prNumber, detail.repo);
    };
    window.addEventListener('o8:open-pr', handleOpenPr);
    return () => { window.removeEventListener('o8:open-pr', handleOpenPr); };
  }, [handleReviewPR]);

  // Bridge for "Needs attention" clicks on a repo card. The status pill
  // dispatches `o8:resolve-blocker` with the repo + explanation. We
  // focus the affected repo and inject a draft into the orchestrator
  // chat composer so the user can ask the agent for help. Does NOT
  // auto-send — user reviews + presses send.
  useEffect(() => {
    const handleResolveBlocker = (event: Event) => {
      const detail = (event as CustomEvent<{
        repoPath?: string;
        repoName?: string;
        explanation?: string;
        statusLabel?: string;
      }>).detail;
      if (!detail?.repoPath) return;
      // Focus this repo as the active workspace.
      setActiveWorkspace(detail.repoPath);
      // Compose a draft message — short and direct.
      const repoLabel = detail.repoName ?? detail.repoPath.split('/').pop() ?? 'this repo';
      const issue = (detail.explanation ?? detail.statusLabel ?? 'has an unspecified blocker').trim();
      const draftText = `\`${repoLabel}\` needs attention: ${issue}\n\nHelp me resolve this — read the repo, figure out what's missing or misconfigured, and propose a concrete fix.`;
      setThoughtsDraftInjection({
        id: `blocker-${Date.now()}`,
        text: draftText,
      });
    };
    window.addEventListener('o8:resolve-blocker', handleResolveBlocker);
    return () => { window.removeEventListener('o8:resolve-blocker', handleResolveBlocker); };
  }, [setActiveWorkspace, setThoughtsDraftInjection]);

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
  }, [openCanvasTab, setActiveWorkspace]);

  const handleOpenGitLog = useCallback((_workspace?: string) => {
    /* git-log surface deferred — was wired to dead WorkspaceSidePanel */
  }, []);

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
    // Approvals surface lives on the O8 panel's PRs tab now — no more
    // dedicated Review tab or NavRail shield button. The only remaining
    // caller is an onboarding coachmark CTA.
    handleReviewPR(0);
  }, [handleReviewPR]);

  const handleToggleChatPanel = useCallback(() => {
    // v1: chat panel removed — toggle workspace instead
    if (chatVisible) {
      setChatVisible(false);
      return;
    }
    setChatVisible(true);
  }, [chatVisible]);

  const handleToggleO8Panel = useCallback(() => {
    if (chatVisible && rightPanelKind === 'o8') {
      // o8 → collapsed. Keep kind=o8 so next click re-opens straight to O8
      // (not the workspace side panel). Clear commit context so reopening
      // doesn't re-expand a stale commit detail.
      setChatVisible(false);
      setO8CommitSha(null);
      setO8CommitRepoPath(null);
      setO8CommitRepoSlug(null);
      return;
    }
    setRightPanelKind('o8');
    setChatVisible(true);
  }, [chatVisible, rightPanelKind]);

  // Browser button on the TitleBar — opens (or focuses) the wide O8 panel
  // and selects its Browser tab. The Browser tab itself is no longer in the
  // O8 panel's tab strip; it lives in the title bar so we can hover-extend
  // it with a quick port menu.
  const handleOpenBrowser = useCallback(() => {
    setRightPanelKind('o8');
    setChatVisible(true);
    setO8ActiveTab('browser');
  }, []);

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
  }, [setDesktopDraftInjection]);

  const handleDesignModeCapture = useCallback((contextText: string) => {
    setThoughtsDraftInjection({
      id: globalThis.crypto?.randomUUID?.() ?? `design-mode-${Date.now()}`,
      text: contextText,
    });
  }, [setThoughtsDraftInjection]);

  // #746 — Auto-directive proposer Accept callback. Re-uses the same draft
  // injection pipeline as design-mode capture so the orchestrator chat
  // composer pre-fills with the proposed directive text.
  const handleAcceptDirectiveProposal = useCallback((draft: { id: string; text: string }) => {
    setThoughtsDraftInjection(draft);
  }, [setThoughtsDraftInjection]);

  const injectPayloadIntoRepoChat = useCallback((payload: AgentPanelChatInjectionPayload, repoOverride?: WorkspaceSidePanelRepo | null) => {
    const nextInjection = {
      id: `${payload.reason}-${Date.now()}`,
      text: payload.text,
    };
    // Previously this short-circuited into the thoughts tile draft; that tile
    // no longer exists, so we always route injections through the workspace
    // terminal target path below.
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
  }, [activeWorkspaceChatSessionKey, globalRepoBranch, globalRepoEntry, setActiveWorkspace, setDesktopDraftInjection, waitForWorkspaceTerminalTarget, workspaceChatTargetKeyByRepoPath, workspaceChatTargets]);

  const handleAgentPanelChatInjection = useCallback((payload: AgentPanelChatInjectionPayload) => {
    injectPayloadIntoRepoChat(payload, null);
  }, [injectPayloadIntoRepoChat]);

  // ── Feed agent data to alert engine + search ──
  const handleAgentsUpdate = useCallback((agents: unknown[]) => {
    // AgentDetail from AgentPanel is compatible with AgentSummary for alert detection
    // (has id, name, status, context, approvalStatus, lastEventAt, sessionKey)
    updateAgents(agents as import('@/lib/fleet/types').AgentSummary[]);
    setAgentsJson(JSON.stringify(agents));
  }, [setAgentsJson, updateAgents]);

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
  }, [setActiveSessionKey]);

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
    // CI surface lives on the O8 panel's Activity tab now (filter pill for CI runs).
    setO8ActiveTab('activity');
    setO8PrRepo(repo ?? null);
    setRightPanelKind('o8');
    setChatVisible(true);
  }, []);

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
    runtime?: 'codex' | 'claude-code' | 'gemini' | 'opencode';
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

    // If this auto-spawn corresponds to a packet that was dispatched via
    // MCP (or any non-UI path), look it up in the mission state and attach
    // the orchestrationPacket badge + mark the tab as the latest dispatch
    // so the workspace tab card and the orange tab highlight render
    // identically to UI-launched packets.
    const matchingPacket = request.targetSessionKey
      ? thoughtsMissionStateRef.current.packets.find((p) => p.lane?.sessionKey === request.targetSessionKey) ?? null
      : null;
    const orchestrationPacket = matchingPacket
      ? buildOrchestrationPacketBadge({ ...matchingPacket, status: matchingPacket.status === 'draft' ? 'running' : matchingPacket.status })
      : undefined;

    const tabId = workspaceTarget.handle.openCliChatSession({
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
      orchestrationPacket,
    });
    enqueueFtuxMilestone('firstAgentSpawned');

    if (orchestrationPacket && tabId) {
      setLatestDispatchedTabId(tabId);
      setLatestDispatchedAt(Date.now());
    }
  }, [enqueueFtuxMilestone, globalRepoEntries, loadRegisteredRepos, setGlobalRepoBranch, setGlobalRepoId, waitForWorkspaceTerminalTarget]);

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
  }, [enqueueFtuxMilestone, setGlobalRepoBranch, setGlobalRepoId, waitForWorkspaceTerminalTarget]);

  const handleSelectFile = useCallback((filePath: string, workspace?: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext);
    const diffWorkspace = workspace ?? activeWorkspace ?? globalRepoEntry?.localPath ?? null;

    setO8SelectedFile(filePath);
    setO8SelectedFileRepoPath(diffWorkspace);
    if (diffWorkspace) {
      setO8RepoPathOverride(diffWorkspace);
    }
    setO8ActiveTab('workspace');
    setRightPanelKind('o8');
    setChatVisible(true);

    openCanvasTab({
      id: `${isImage ? 'image' : 'file'}:${filePath}${workspace ? `:${workspace}` : ''}`,
      kind: isImage ? 'image' : 'file',
      label: filePath.split('/').pop() ?? filePath,
      resourceId: filePath,
      meta: workspace ? { workspace } : undefined,
    });
  }, [activeWorkspace, globalRepoEntry?.localPath, openCanvasTab]);

  const handleOpenSpecInWorkspace = useCallback((repoPath: string) => {
    setO8CommitSha(null);
    setO8CommitRepoPath(null);
    setO8CommitRepoSlug(null);
    setO8RepoPathOverride(repoPath);
    setO8ActiveTab('spec');
    setRightPanelKind('o8');
    setChatVisible(true);
  }, []);

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
    setO8ActiveTab('workspace');
    setO8CommitSha(hash);
    setO8CommitRepoPath(repoPath);
    setO8CommitRepoSlug(repoSlug);
    setRightPanelKind('o8');
    setChatVisible(true);
  }, [globalRepoEntries, globalRepoEntry]);

  const handleClearCommit = useCallback(() => {
    setO8CommitSha(null);
    setO8CommitRepoPath(null);
    setO8CommitRepoSlug(null);
  }, []);

  const handleSelectO8RepoPath = useCallback((repoPath: string) => {
    handleClearCommit();
    setO8RepoPathOverride(repoPath);
    setO8SelectedFile(null);
    setO8SelectedFileRepoPath(null);
  }, [handleClearCommit]);

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
  const { data: domainLanesRaw } = useReactiveQuery<{ lanes?: Array<{ id: string; packetId: string | null; status: string; sessionKey: string | null; lastEventLabel: string | null }> }>({
    queryKey: ['lanes', 'active'],
    queryFn: async () => {
      const res = await fetchOnce('/api/lanes?active=true');
      if (!res.ok) return { lanes: [] };
      return await res.json() as { lanes?: Array<{ id: string; packetId: string | null; status: string; sessionKey: string | null; lastEventLabel: string | null }> };
    },
    wsEvents: ['lane-lifecycle', 'agent-lifecycle'],
    staleTime: 10_000,
  });
  const domainLanes = useMemo<DomainLaneSummary[]>(() => {
    return (domainLanesRaw?.lanes ?? [])
      .filter((l): l is typeof l & { packetId: string } => Boolean(l.packetId))
      .map((l) => ({ laneId: l.id, packetId: l.packetId, status: l.status, sessionKey: l.sessionKey, lastEventLabel: l.lastEventLabel }));
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
    workspaceTerminalHandlesRef,
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
  }, [activeSessionKey, paletteAgents, selectedSessionAgent, setActiveSessionKey]);

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
    setWorkspaceActiveTabKindByTileId,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    sendAgentKill,
    sendTerminalAttach,
    sendTerminalCreate,
    sendTerminalDetach,
    sendTerminalInput,
    sendTerminalResize,
    termWsConnected,
    thoughtsDraftInjection,
    thoughtsMissionState,
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
    setWorkspaceActiveTabKindByTileId,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
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

  const {
    closeSettingsOverlay,
    toggleSettingsOverlay,
  } = useSettingsOverlayDismiss({
    activeNavSection,
    panelRef: settingsPanelRef,
    setActiveNavSection,
  });

  // ── Mobile pairing — open the full-screen QR view as a canvas tab ──
  // Always closes the settings overlay first so the tab is visible when this
  // is triggered from the Connections settings tab (overlay covers the
  // workspace); a no-op when fired from the status-bar phone button.
  const openMobilePairing = useCallback(() => {
    closeSettingsOverlay();
    openCanvasTab({
      id: 'mobile-pairing',
      kind: 'mobile-pairing',
      label: 'Pair Mobile',
      resourceId: 'mobile-pairing',
    });
  }, [closeSettingsOverlay, openCanvasTab]);

  useEffect(() => {
    const handleOpenPairing = () => { openMobilePairing(); };
    const handleOpenSettings = (event: Event) => {
      const detail = (event as CustomEvent<OpenSettingsTabDetail>).detail;
      if (detail?.tab) handleOpenSettingsTab(detail.tab as SettingsTab);
    };
    window.addEventListener(OPEN_MOBILE_PAIRING_EVENT, handleOpenPairing);
    window.addEventListener(OPEN_SETTINGS_TAB_EVENT, handleOpenSettings);
    return () => {
      window.removeEventListener(OPEN_MOBILE_PAIRING_EVENT, handleOpenPairing);
      window.removeEventListener(OPEN_SETTINGS_TAB_EVENT, handleOpenSettings);
    };
  }, [openMobilePairing, handleOpenSettingsTab]);

  const showSidebarColumn = sidebarVisible && !compactShell;
  const showRightPanelColumn = chatVisible && !compactShell;
  const workspaceInset = compactShell ? 2 : 4;

  return (
    <DictationHost>
    <div data-vibrancy-passthrough="" data-mcp-scope="dashboard" style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--t-bg-gradient)',
      backdropFilter: 'blur(18px) saturate(1.02)',
      WebkitBackdropFilter: 'blur(18px) saturate(1.02)',
      color: 'var(--t-text)',
      fontFamily: 'var(--font-sans-system)',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* UpdateBanner is mounted from the root layout as a center-top portal. */}

      {/* ── Connection Banner (#634) — surfaces dropped WebSocket so users
          know why agent statuses, transcripts, and approvals appear frozen.
          Reuses the existing reconnect/backoff machinery in
          DesktopWebSocketContext; this only adds the chrome surface. ── */}
      <ConnectionBanner connectionState={wsStatus} />

      <ApprovalBanner />

      {/* DesignModeOverlay only renders the actual overlay when design mode
          is active. Wrapping it in a guarded Suspense + lazy() keeps its
          ~500-line module out of the initial dashboard chunk; the chunk is
          only fetched once the user toggles design mode (Cmd+Shift+D). */}
      {designMode.state.active ? (
        <Suspense fallback={null}>
          <LazyDesignModeOverlay
            active={designMode.state.active}
            selection={designMode.state.selection}
            captureRequestId={designMode.captureRequestId}
            onSelectionChange={designMode.setSelection}
            onCapture={handleDesignModeCapture}
            onClose={designMode.close}
          />
        </Suspense>
      ) : null}

      {/* CommandPalette is opened on Cmd+K. The dashboard owns the hotkey
          listener (above) so the palette chunk only needs to be present
          once the user opens it. */}
      {commandPaletteOpen ? (
        <Suspense fallback={null}>
          <LazyCommandPalette
            open={commandPaletteOpen}
            onClose={handlePaletteClose}
            workspace={activeWorkspace ?? null}
            repo={globalRepo ?? null}
            actionItems={(() => {
              const ledger = dashboardProjects.ledger;
              if (!ledger) return [];
              const items: CommandPaletteActionItem[] = [];
              const activeRepoPath = globalRepoEntry?.localPath
                ?? workspaceTerminalPreferredRepo?.localPath
                ?? null;
              const activeRepoName = globalRepoEntry?.name
                ?? workspaceTerminalPreferredRepo?.name
                ?? null;

              // Switch-to entries for every project that isn't the active one.
              for (const project of ledger.projects) {
                if (project.id === ledger.activeProjectId) continue;
                items.push({
                  id: `project:switch:${project.id}`,
                  title: `Switch to ${project.name}`,
                  detail: `${project.repoPaths.length} repo${project.repoPaths.length === 1 ? '' : 's'}`,
                  swatchColor: project.color,
                  onActivate: () => { void dashboardProjects.switchActive(project.id); },
                });
              }

              // Move-active-repo entries — only when there's a focused repo.
              if (activeRepoPath && activeRepoName) {
                const currentOwner = ledger.projects.find((p) => p.repoPaths.includes(activeRepoPath));
                for (const project of ledger.projects) {
                  if (project.id === currentOwner?.id) continue;
                  items.push({
                    id: `project:move:${project.id}`,
                    title: `Move ${activeRepoName} to ${project.name}`,
                    detail: currentOwner ? `From ${currentOwner.name}` : 'Currently unassigned',
                    swatchColor: project.color,
                    onActivate: () => { void dashboardProjects.moveRepoToProject(activeRepoPath, project.id); },
                  });
                }
              }

              return items;
            })()}
            onSelectIssue={handlePaletteSelectIssue}
            onSelectFile={handlePaletteSelectFile}
            onSelectAgent={handlePaletteSelectAgent}
          />
        </Suspense>
      ) : null}

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
                fontFamily: 'var(--font-sans-system)',
                flexShrink: 0,
              }}
            >
              Review approval
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ── Session Timeline — always mounted so toggling doesn't refetch. ── */}
      <div style={{ position: 'relative', zIndex: 1, display: timelineVisible ? 'block' : 'none' }}>
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

      {/* ── Main Layout (horizontal) ── */}
      <div data-mcp-scope="main-layout" style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden',
        minHeight: 0, // critical: allow flex children to shrink for scroll
      }}>
      {/* NavRail retired — its Agents / Alerts buttons live in the TitleBar,
          and Settings / Ports / Add-repo live in the
          DesktopStatusBar at the bottom. The AgentPanel stays docked as the
          left column below. */}

      {/* ── Left: Agent Panel ── */}
      {showSidebarColumn && (() => {
        // When a repo is focused, we want the column to behave like the
        // operator dragged the resizer wider — not an overlay sliding over
        // the workspace. The width is animated; the focus content renders
        // inline inside AgentPanel.
        const effectiveLeftWidth = leftPanelFocus.active ? FOCUS_LEFT_PANEL_WIDTH : leftWidth;
        return (
        <motion.div
          animate={{ width: effectiveLeftWidth }}
          transition={
            leftPanelFocus.active
              ? { type: 'spring', stiffness: 360, damping: 32 }
              : showAgentPanelFtux
                ? FTUX_SPRING_TRANSITION
                : { duration: 0.001 }
          }
          data-mcp-scope="agent-panel"
          data-chrome-surface="true"
          style={{
            width: effectiveLeftWidth,
            flexShrink: 0,
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <LeftHeaderStrip
            sidebarVisible={sidebarVisible}
            onToggleSidebar={() => setSidebarVisible(v => !v)}
          />
          <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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
            activeWorkspaceTabKind={activeWorkspaceTabKind}
            onFocusOrchestratorTab={() => {
              for (const handle of workspaceTerminalHandlesRef.current.values()) {
                const snap = handle.getTabsSnapshot();
                const orchTab = snap.tabs.find((tab) => tab.kind === 'orchestrator');
                if (orchTab) {
                  handle.focusTab(orchTab.id);
                  window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId: orchTab.id } }));
                  return;
                }
              }
            }}
            onFocusAssistantTab={() => {
              let fallbackHandle: TerminalTabHandle | null = null;
              for (const handle of workspaceTerminalHandlesRef.current.values()) {
                fallbackHandle ??= handle;
                const snap = handle.getTabsSnapshot();
                const assistantTab = snap.tabs.find((tab) => tab.kind === 'llm-chat');
                if (assistantTab) {
                  handle.focusTab(assistantTab.id);
                  window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId: assistantTab.id } }));
                  return;
                }
              }
              if (fallbackHandle) {
                const tabId = fallbackHandle.openLlmChatSession({
                  repo: workspaceTerminalPreferredRepo ?? undefined,
                  label: 'Chat',
                });
                window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId } }));
              }
            }}
            onOpenCommandPalette={handlePaletteOpen}
            onOpenProjectManagement={() => handleOpenSettingsTab('projects')}
            selectedRepoReadiness={globalRepoEntry?.readiness ?? workspaceTerminalPreferredRepo?.readiness ?? null}
            onLaunchWorkspaceAgent={handleLaunchWorkspaceAgent}
            onLaunchWorkspaceTask={handleLaunchWorkspaceRepoTask}
            onSelectSession={handleSelectSession}
            onOpenHistoryChat={handleOpenHistoryChatFromPanel}
            onSelectRepo={handleAlignToRepo}
            onSelectIssue={handleSelectIssue}
            onSelectCommit={handleSelectCommit}
            onSelectPR={handleSelectPR}
            onReviewPR={handleReviewPR}
            onRepoRemoved={handleRepoRemoved}
            onOpenSpecInWorkspace={handleOpenSpecInWorkspace}
            onExpandWorkspace={handleExpandWorkspace}
            onSelectFile={handleSelectFile}
            onOpenCI={handleOpenCI}
            onCreateIssue={handleCreateIssue}
            onOpenGitLog={handleOpenGitLog}
            onOpenDeploy={handleOpenDeploy}
            onAgentsUpdate={handleAgentsUpdate}
            onAgentKill={sendAgentKill}
            lifecycleEvents={lifecycleEvents}
            orchestratorPackets={activePackets}
            orchestratorMissionState={thoughtsMissionState}
            registeredRepos={globalRepoEntries}
            ideWorkspaceSessions={ideWorkspaceSessionsForSidebar}
            leftPanelFocus={leftPanelFocus}
          />
          </div>
        </motion.div>
      );
      })()}

      {/* ── Left drag handle ── */}
      {showSidebarColumn && <div
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
        // Apple squircle corners — the workspace floats inside the dashboard
        // gradient with a small inset so the curve is visible against the
        // adjacent NavRail / chat columns and the status strip below.
        borderRadius: 14,
        marginTop: workspaceInset,
        marginBottom: workspaceInset,
        marginLeft: workspaceInset,
        marginRight: workspaceInset,
      }}>
        <WorkspaceHeaderStrip
          leadingInset={!showSidebarColumn}
          sidebarVisible={sidebarVisible}
          onToggleSidebar={!showSidebarColumn && !compactShell ? () => setSidebarVisible(v => !v) : undefined}
          isAgentsSectionActive={activeNavSection === 'agents'}
          onOpenAgents={compactShell ? undefined : () => {
            setActiveNavSection('agents');
            if (!chatVisible) setChatVisible(true);
            setRightPanelMode('chat');
          }}
          bottomPanelVisible={bottomPanelVisible}
          onToggleBottomPanel={toggleContextualPanelTile}
        />
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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
        {activeNavSection === 'analytics' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>Loading analytics...</div>}>
            <LazyAnalyticsPage />
            </Suspense>
          </div>
        )}

        {activeNavSection !== 'analytics' && (
          <OrchestratorDataProvider
            agents={parsedAgents}
            missionState={thoughtsMissionState}
            workspaceTargets={orchestratorWorkspaceTargets}
            onMissionStateChange={handleThoughtsMissionStateChange}
            onLaunchPacket={launchOrchestrationPacket}
            draftInjection={thoughtsDraftInjection}
            onSelectSession={handleSelectSession}
            latestDispatchedTabId={latestDispatchedTabId}
            latestDispatchedAt={latestDispatchedAt}
            onAcceptDirectiveProposal={handleAcceptDirectiveProposal}
            selectedPacketId={selectedPacketId}
            onSelectedPacketChange={setSelectedPacketId}
            onOpenO8Panel={handleOpenO8Panel}
            o8PanelVisible={showRightPanelColumn && rightPanelKind === 'o8'}
          >
            <TileContainer
              layout={tileLayout}
              activeTileId={activeTileId}
              registry={tileRegistry}
              onActivateTile={setActiveTileId}
              onCloseTile={handleCloseTile}
              onResizeSplit={handleResizeSplit}
              onSplitTile={handleSplitTile}
            />
          </OrchestratorDataProvider>
        )}

        {activeNavSection === 'settings' && (
          <SettingsOverlay panelRef={settingsPanelRef}>
            <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>Loading settings...</div>}>
            <LazySettingsPage initialTab={settingsInitialTab} onClose={closeSettingsOverlay} />
            </Suspense>
          </SettingsOverlay>
        )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {showRightPanelColumn ? (
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
                alignSelf: 'stretch',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                borderRadius: 14,
                marginTop: 4,
                marginBottom: 4,
                marginRight: 4,
              }}
            >
              <PanelHeaderStrip
                o8PanelVisible={rightPanelKind === 'o8'}
                workspacePanelVisible={rightPanelKind === 'review'}
                onToggleO8Panel={handleToggleO8Panel}
                o8ActiveTab={o8ActiveTab}
                onO8TabChange={rightPanelKind === 'o8' ? setO8ActiveTab : undefined}
                browserActive={rightPanelKind === 'o8' && o8ActiveTab === 'browser'}
                browserPreviewUrl={o8BrowserHoverUrl}
                onOpenBrowser={handleOpenBrowser}
              />
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
                    <Suspense fallback={null}>
                      <OrchestratorDataProvider
                        agents={parsedAgents}
                        missionState={thoughtsMissionState}
                        workspaceTargets={orchestratorWorkspaceTargets}
                        onMissionStateChange={handleThoughtsMissionStateChange}
                        onLaunchPacket={launchOrchestrationPacket}
                        draftInjection={thoughtsDraftInjection}
                        onSelectSession={handleSelectSession}
                        latestDispatchedTabId={latestDispatchedTabId}
                        latestDispatchedAt={latestDispatchedAt}
                        onAcceptDirectiveProposal={handleAcceptDirectiveProposal}
                        selectedPacketId={selectedPacketId}
                        onSelectedPacketChange={setSelectedPacketId}
                        onOpenO8Panel={handleOpenO8Panel}
                      >
                        <LazyO8Panel
                          repoPath={currentO8RepoPath}
                          registeredRepos={globalRepoEntries}
                          onRepoPathChange={handleSelectO8RepoPath}
                          previews={workspacePreviews}
                          activeTab={o8ActiveTab}
                          selectedFile={scopedO8SelectedFile}
                          onSelectedFileChange={handleO8SelectedFileChange}
                          prNumber={o8PrNumber}
                          prRepo={o8PrRepo}
                          repoSlug={o8CommitRepoSlug ?? repoSlugFromRemote(globalRepoEntry?.remoteUrl)}
                          browserUrl={o8BrowserUrl}
                          onBrowserActiveUrlChange={setO8BrowserHoverUrl}
                          commitSha={o8CommitSha}
                          onClearCommit={handleClearCommit}
                          onSelectCommit={handleSelectCommit}
                          onSelectPR={handleReviewPR}
                          onSelectIssue={handleSelectIssue}
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
                      </OrchestratorDataProvider>
                    </Suspense>
                  </motion.div>
                ) : (
                  <motion.div
                    key="ambient-right-panel"
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
                    <Suspense fallback={null}>
                      <OrchestratorDataProvider
                        agents={parsedAgents}
                        missionState={thoughtsMissionState}
                        workspaceTargets={orchestratorWorkspaceTargets}
                        onMissionStateChange={handleThoughtsMissionStateChange}
                        onLaunchPacket={launchOrchestrationPacket}
                        draftInjection={thoughtsDraftInjection}
                        onSelectSession={handleSelectSession}
                        latestDispatchedTabId={latestDispatchedTabId}
                        latestDispatchedAt={latestDispatchedAt}
                        onAcceptDirectiveProposal={handleAcceptDirectiveProposal}
                        selectedPacketId={selectedPacketId}
                        onSelectedPacketChange={setSelectedPacketId}
            onOpenO8Panel={handleOpenO8Panel}
                      >
                        <ReviewPanel repoPath={currentO8RepoPath} />
                      </OrchestratorDataProvider>
                    </Suspense>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>


      {/* ── Alert Toast (desktop only — urgent alerts slide in bottom-left near bell) ── */}
      <AlertToast alerts={activeAlerts} compact={compactShell} onAction={handleAlertAction} />
      </div>{/* end main layout */}

      {/* ── Bottom chrome: transparent status strip with branch + chrome buttons ── */}
      <DesktopStatusBar
        branchName={globalRepoEntry?.readiness?.currentBranch ?? globalRepoBranch ?? workspaceTerminalPreferredRepo?.branch ?? null}
        repoName={globalRepoEntry?.name ?? workspaceTerminalPreferredRepo?.name ?? null}
        repoRemoteUrl={globalRepoEntry?.remoteUrl ?? workspaceTerminalPreferredRepo?.remoteUrl ?? null}
        compact={compactShell}
        leftColumnWidth={showSidebarColumn ? (leftPanelFocus.active ? FOCUS_LEFT_PANEL_WIDTH : leftWidth) : 0}
        rightColumnWidth={showRightPanelColumn ? (rightPanelKind === 'o8' ? o8Width : rightWidth) : 0}
        onOpenSettings={toggleSettingsOverlay}
        onOpenMobilePairing={openMobilePairing}
        onAddRepo={() => {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(REQUEST_ADD_REPO_EVENT));
          }
        }}
        onPortPreview={(_port, url) => {
          setO8BrowserUrl(url);
          setO8ActiveTab('browser');
          setRightPanelKind('o8');
          setChatVisible(true);
        }}
      />

      <GuidedDiscoveryCoachmark
        visible={showMobileFtux}
        position="bottom-right"
        title="Approve from your phone next time"
        body={mobilePromptBody}
        actions={mobilePromptActions}
        maxWidth={340}
      />

      {/* Orchestrator chat lives entirely inside the tile system now —
          open it via the tile picker or the dedicated NavRail button.
          The floating ThoughtsCard overlay was removed in the
          thoughts→workspace merge. */}

      {/* ── First Launch Onboarding ── */}
      {setupWizardOpen && (
        <Suspense fallback={null}>
          <LazyOnboarding onComplete={handleSetupComplete} />
        </Suspense>
      )}

    </div>
    </DictationHost>
  );
}
