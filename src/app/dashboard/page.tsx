'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- dashboard shell is mid-refactor and keeps dormant wiring for upcoming panels */

import { lazy, Suspense, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import { AnimatePresence, motion } from 'framer-motion';
import { DesktopWebSocketProvider, useSharedDesktopWs, useWsConnectionState } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { bootstrapTranscripts } from '@/lib/transcripts/bootstrap';
import { buildTranscriptWsCallbacks } from '@/lib/transcripts/wireWsBridge';
import { mergeTranscriptEntries } from '@/components/desktop/workspace-terminal/utils';
import { ReactiveQueryProvider } from '@/lib/query/provider';
import { useReactiveQuery } from '@/lib/query/use-reactive-query';
import { AgentPanel } from '@/components/desktop/AgentPanel';
// AgentPanelChat retired — orchestrator/chat tabs handle chat surfaces now.
import { useLeftPanelProjectFocus } from '@/components/desktop/repo-focus/useLeftPanelProjectFocus';
import type { CanvasTab } from '@/components/desktop/Canvas';
import type { SettingsTab } from '@/components/desktop/SettingsPage';
import { AlertProvider, useAlerts } from '@/lib/alerts/context';
import { EntitlementProvider } from '@/lib/entitlement/context';
// ConnectionBanner retired — ConnectionPill in AgentPanel surfaces WS state.
import { ThemeProvider, useTheme } from '@/lib/theme/context';
import { AlertToast } from '@/components/shared/AlertToast';
import type { BottomPanelSurfaceKind, ContextualPanelHandle } from '@/components/desktop/ContextualPanel';
import { LeftHeaderStrip } from '@/components/desktop/shell/LeftHeaderStrip';
import { WorkspaceHeaderStrip } from '@/components/desktop/shell/WorkspaceHeaderStrip';
import { PanelHeaderStrip } from '@/components/desktop/shell/PanelHeaderStrip';
import { DesktopStatusBar } from '@/components/desktop/DesktopStatusBar';
import { useProjects, type ProjectRecord } from '@/components/desktop/repo-registry/useProjects';
import type { CommandPaletteActionItem } from '@/components/desktop/CommandPalette';
import { SessionTimeline } from '@/components/desktop/SessionTimeline';
import { ApprovalBanner } from '@/components/desktop/ApprovalBanner';
import { DictationHost } from '@/components/desktop/dictation/DictationHost';
import { AttendanceHeartbeat } from '@/components/desktop/AttendanceHeartbeat';
import {
  OPEN_MOBILE_PAIRING_EVENT,
  OPEN_SETTINGS_TAB_EVENT,
  REQUEST_ADD_REPO_EVENT,
  type OpenSettingsTabDetail,
} from '@/lib/desktop/events';
// ApprovalQueuePanel retired — was only consumed by the dead workspace-side-panel ReviewTab.
// AnalyticsPage lazy-loaded below
import type { WorkspaceSidePanelRepo } from './types';
import type { O8Tab } from '@/components/desktop/o8-panel/types';
import {
  logDashboardBootTiming,
  markDashboardScriptStart,
  markDashboardFirstRender,
  markDashboardInteractive,
} from '@/lib/perf/dashboard-marks';
import { startWebVitalsObserver } from '@/lib/perf/web-vitals';
import {
  subscribeO8PanelFocus,
} from '@/lib/events/o8-panel-focus';
import { fetchOnce } from '@/lib/panel/fetch-cache';
import { safeCancelIdleCallback, safeRequestIdleCallback } from '@/lib/util/webview-safe';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { MobileInboxSnapshot, MobileOrchestratorThread } from '@/lib/mobile/types';
import type { AgentSummary } from '@/lib/fleet/types';
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
// LazyAnalyticsPage full-page mount retired — Settings → Analytics tab is
// the live entry point. AnalyticsPage is still consumed via that tab.
const LazyAutomationsPage = lazy(() => import('@/components/desktop/AutomationsPage').then(m => ({ default: m.AutomationsPage })));
const LazyOnboarding = lazy(() => import('@/components/desktop/Onboarding').then(m => ({ default: m.Onboarding })));
const LazyCommandPalette = lazy(() => import('@/components/desktop/CommandPalette').then(m => ({ default: m.CommandPalette })));
const LazyKeyboardShortcutsOverlay = lazy(() => import('@/components/desktop/KeyboardShortcutsOverlay').then(m => ({ default: m.KeyboardShortcutsOverlay })));
const LazyDesignModeOverlay = lazy(() => import('@/components/desktop/DesignModeOverlay').then(m => ({ default: m.DesignModeOverlay })));
const LazyO8Panel = lazy(() => import('@/components/desktop/O8Panel').then(m => ({ default: m.O8Panel })));
// #888/#895 — packet-mode right panel (Spec / Agent Overview / Changes).
import { OrchestratorDataProvider } from '@/components/desktop/orchestrator-data-context';
import { useMissionCompleteDetector } from '@/components/desktop/thoughts/mission-complete-detector';
import { ReviewPanel } from '@/components/desktop/review/ReviewPanel';
import { TileContainer } from '@/components/desktop/TileContainer';
import { DashboardHydrationMarker } from './DashboardHydrationMarker';
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

const DEFAULT_LEFT_PANEL_WIDTH = 300;
const FOCUS_LEFT_PANEL_WIDTH = 320;
const CONTROL_ROOM_WIDTH = 760; // wide "control-room mode" — Control tab opens the left panel wide for the two-column layout
const MIN_RIGHT_PANEL_WIDTH = 240;
const MAX_RIGHT_PANEL_WIDTH = 720;
const MIN_O8_PANEL_WIDTH = 400;
const MAX_O8_PANEL_WIDTH = 1200;
const O8_SPEC_PANEL_TARGET_WIDTH = 600;
const RESPONSIVE_RIGHT_PANEL_COLLAPSE_WIDTH = 1180;
const RESPONSIVE_LEFT_PANEL_COLLAPSE_WIDTH = 900;
const RESPONSIVE_COMPACT_SHELL_WIDTH = 420;
const O8_ACTIVE_TAB_STORAGE_KEY = 'o8ActiveTab';
const DEFAULT_O8_ACTIVE_TAB: O8Tab = 'activity';

/** Floating terminal toggle sitting at the bottom-center of the
 *  workspace card. Moved here from the column header per operator
 *  request — "put the terminal button down under the input where main
 *  is like centered below the composer first that will free up the
 *  header". No background, just the icon; active state tints it. */
function BottomCenterTerminalToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="Toggle terminal"
      title="Toggle terminal"
      style={{
        position: 'absolute',
        bottom: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 8,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: active ? 'var(--t-accent)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        padding: 0,
        zIndex: 30,
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m4 17 6-6-6-6" />
        <line x1="12" x2="20" y1="19" y2="19" />
      </svg>
    </button>
  );
}

/**
 * SidebarHoverPreviewBody — content shown inside the drop-from-top overlay
 * when the AgentPanel column is collapsed and the operator hovers the left
 * edge. Renders a condensed snapshot of the same data the full sidebar
 * surfaces — active project + repo list + live packets + sessions — so the
 * operator can scan and click through chats without expanding the panel.
 *
 * Kept intentionally lightweight (no useEffect-driven fetches, no expensive
 * memoization) since the parent `AnimatePresence` mounts/unmounts it on
 * every hover-enter. The data props are already-computed snapshots from
 * DashboardInner, so re-renders are cheap.
 */
interface SidebarHoverPreviewBodyProps {
  projects: ProjectRecord[];
  activeProjectId: string | null;
  repos: RepoRegistryEntry[];
  packets: OrchestratorPacket[];
  sessions: AgentSummary[];
  activeSessionKey: string | null;
  onOpenFullPanel: () => void;
  onSelectSession: (sessionKey: string) => void;
}

function SidebarHoverPreviewBody({
  projects,
  activeProjectId,
  repos,
  packets,
  sessions,
  activeSessionKey,
  onOpenFullPanel,
  onSelectSession,
}: SidebarHoverPreviewBodyProps) {
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;
  const livePackets = packets.filter((p) => p.status !== 'released' && p.status !== 'archived');
  const previewPackets = livePackets.slice(0, 5);
  const previewSessions = sessions.slice(0, 6);

  // Hurttlocker spec — system stack only, no Inter; chrome rows clamp at
  // fontWeight 400, section labels at 300 and 10px tracked uppercase, row
  // titles at 13.5/300/-0.1px.
  const sectionLabelStyle: React.CSSProperties = {
    display: 'block',
    paddingLeft: 14,
    paddingRight: 14,
    paddingTop: 8,
    paddingBottom: 4,
    fontSize: 10,
    fontWeight: 300,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: 'var(--t-text-muted)',
  };
  const rowTitleStyle: React.CSSProperties = {
    fontSize: 13.5,
    fontWeight: 300,
    letterSpacing: -0.1,
    color: 'var(--t-text)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
  const rowMetaStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 300,
    color: 'var(--t-text-muted)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* Header — project name + open-full-panel affordance */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          paddingLeft: 14,
          paddingRight: 12,
          paddingTop: 12,
          paddingBottom: 10,
          borderBottom: '1px solid var(--t-divider-subtle)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 300,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              color: 'var(--t-text-muted)',
            }}
          >
            Project
          </span>
          <span
            style={{
              fontSize: 13.5,
              fontWeight: 400,
              letterSpacing: -0.1,
              color: 'var(--t-text)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {activeProject?.name ?? 'No project'}
          </span>
        </div>
        <button
          type="button"
          onClick={onOpenFullPanel}
          aria-label="Open full sidebar"
          title="Open full sidebar"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 26,
            minWidth: 26,
            paddingLeft: 8,
            paddingRight: 8,
            borderWidth: 0,
            borderRadius: 7,
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 300,
            letterSpacing: 0.2,
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; e.currentTarget.style.color = 'var(--t-text)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-secondary)'; }}
        >
          Open
        </button>
      </div>

      {/* Scrollable body — repos / packets / sessions sections */}
      <div
        className="cortex-themed-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          paddingBottom: 8,
        }}
      >
        {repos.length > 0 && (
          <>
            <span style={sectionLabelStyle}>Repos</span>
            {repos.slice(0, 6).map((repo) => (
              <div
                key={repo.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  paddingLeft: 14,
                  paddingRight: 14,
                  paddingTop: 6,
                  paddingBottom: 6,
                  minHeight: 28,
                }}
              >
                <span style={rowTitleStyle}>{repo.name}</span>
                {repo.readiness?.currentBranch ? (
                  <span style={{ ...rowMetaStyle, marginLeft: 'auto' }}>{repo.readiness.currentBranch}</span>
                ) : null}
              </div>
            ))}
            {repos.length > 6 ? (
              <div style={{ ...rowMetaStyle, paddingLeft: 14, paddingTop: 4, paddingBottom: 4 }}>
                +{repos.length - 6} more
              </div>
            ) : null}
          </>
        )}

        {previewPackets.length > 0 && (
          <>
            <span style={sectionLabelStyle}>Active packets</span>
            {previewPackets.map((packet) => (
              <div
                key={packet.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  paddingLeft: 14,
                  paddingRight: 14,
                  paddingTop: 6,
                  paddingBottom: 6,
                  minHeight: 32,
                }}
              >
                <span style={rowTitleStyle}>{packet.title || packet.referenceLabel || packet.id}</span>
                <span style={rowMetaStyle}>
                  {packet.status}
                  {packet.branchTarget ? ` · ${packet.branchTarget}` : ''}
                </span>
              </div>
            ))}
            {livePackets.length > previewPackets.length ? (
              <div style={{ ...rowMetaStyle, paddingLeft: 14, paddingTop: 4, paddingBottom: 4 }}>
                +{livePackets.length - previewPackets.length} more
              </div>
            ) : null}
          </>
        )}

        {previewSessions.length > 0 && (
          <>
            <span style={sectionLabelStyle}>Chats</span>
            {previewSessions.map((session) => {
              const isActive = activeSessionKey === session.sessionKey;
              const label = session.surfaceLabel || session.name || session.sessionKey;
              return (
                <button
                  key={session.sessionKey}
                  type="button"
                  onClick={() => onSelectSession(session.sessionKey)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: 8,
                    paddingLeft: 14,
                    paddingRight: 14,
                    paddingTop: 8,
                    paddingBottom: 8,
                    minHeight: 36,
                    background: isActive ? 'var(--t-input-bg)' : 'transparent',
                    borderWidth: 0,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                    color: 'inherit',
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--t-hover)'; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                    <span style={rowTitleStyle}>{label}</span>
                    {session.currentTask ? (
                      <span style={rowMetaStyle}>{session.currentTask}</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
            {sessions.length > previewSessions.length ? (
              <div style={{ ...rowMetaStyle, paddingLeft: 14, paddingTop: 4, paddingBottom: 4 }}>
                +{sessions.length - previewSessions.length} more
              </div>
            ) : null}
          </>
        )}

        {repos.length === 0 && previewPackets.length === 0 && previewSessions.length === 0 && (
          <div
            style={{
              paddingLeft: 14,
              paddingRight: 14,
              paddingTop: 16,
              paddingBottom: 16,
              fontSize: 12,
              fontWeight: 300,
              color: 'var(--t-text-muted)',
            }}
          >
            No active work — open the full sidebar to start.
          </div>
        )}
      </div>
    </div>
  );
}

function normalizeO8ActiveTab(raw: string | null | undefined): O8Tab | null {
  if (!raw) return null;
  // Legacy migrations — 'diff' and 'changes' were old labels for what's
  // now the Workspace tab. 'files' used to be the same, but is now a
  // distinct surface in the launcher (see O8Panel RIGHT_UTILITY_TABS),
  // so we let it pass through to the new kind instead of remapping.
  if (raw === 'diff' || raw === 'changes') return 'workspace';
  if (raw === 'prs') return 'activity';
  if (
    raw === 'workspace'
    || raw === 'browser'
    || raw === 'activity'
    || raw === 'inbox'
    || raw === 'spec'
    || raw === 'launcher'
    || raw === 'files'
    || raw === 'side-chat'
    || raw === 'review'
    || raw === 'terminal'
  ) {
    return raw;
  }
  return null;
}

function historyRepoContextFromMobileThread(thread: MobileOrchestratorThread): SavedChatRepoContext | null {
  if (!thread.repoPath) return null;
  return {
    name: thread.repoName ?? undefined,
    localPath: thread.repoPath,
    branch: thread.repoBranch ?? null,
    remoteUrl: null,
  };
}

export default function DashboardPage() {
  return (
    <ThemeProvider>
      <AlertProvider>
        <EntitlementProvider>
          <ReactiveQueryProvider>
            <DesktopWebSocketProvider>
              <DashboardInner />
            </DesktopWebSocketProvider>
          </ReactiveQueryProvider>
        </EntitlementProvider>
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


  // Glass vs solid axis: in glass mode the AgentPanel card paints nothing
  // and shadows its descendants with midnight-palette ink so dark vibrancy
  // shows through with legible light text (matches the right O8Panel
  // approach). In solid mode the card keeps --t-panel-solid (the proper
  // opaque paper) with the normal dark-on-cream tokens.
  const { surface: themeSurface } = useTheme();
  const isGlassSurface = themeSurface === 'glass';

  const [inTauri, setInTauri] = useState(false);
  useEffect(() => {
    logDashboardBootTiming();
    startWebVitalsObserver();
    setInTauri(isTauri());
    // tauri-plugin-mcp no longer needs JS-side init — the eval_and_await
    // protocol shipped in #932 phase 2 invokes JS from Rust per call.
    // Schedule the "interactive" mark after React has flushed the initial
    // render and the browser has finished its first layout/paint pass.
    const handle = safeRequestIdleCallback(() => markDashboardInteractive(), { timeout: 1500 });
    return () => safeCancelIdleCallback(handle);
  }, []);
  const initialTileLayout = useMemo(() => createDefaultTileLayout(), []);
  const designMode = useDesignMode();

  // ── Grouped state hooks ──
  const uiChrome = useUIChrome();
  const {
    activeNavSection, setActiveNavSection,
    settingsInitialTab,
    sidebarVisible, setSidebarVisible,
    timelineVisible,
    desktopDraftInjection, setDesktopDraftInjection,
    thoughtsDraftInjection, setThoughtsDraftInjection,
    thoughtsImageInjection, setThoughtsImageInjection,
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

  // ── Sidebar hover-preview state ──
  // When the AgentPanel is collapsed (sidebarVisible === false), hovering the
  // left-edge rail drops a detail panel down from the top of the screen
  // (Spotify mini-player ↔ full-player pattern). Click on the rail still
  // performs the regular slide-out behavior; the hover-preview is a separate,
  // overlay-only surface that auto-retracts on hover-leave (with a small
  // dismiss delay so brief mouse-outs don't flicker) or any outside click.
  const [sidebarPreviewOpen, setSidebarPreviewOpen] = useState(false);
  const sidebarPreviewLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarPreviewOverlayRef = useRef<HTMLDivElement | null>(null);

  // Active-workspace map — each WorkspaceTerminalRoot broadcasts via
  // 'o8:workspace-active-label' with its stable workspaceId. We track
  // them all here so splits don't overwrite each other. The top header
  // label only renders when there's exactly one active workspace; with
  // multiple, each split's own lower TabBar carries its own title.
  type WorkspaceTabSummary = {
    id: string;
    label: string;
    kind: string;
    runtime: string | null;
    packetStatus: string | null;
  };
  type WorkspaceActivePayload = {
    workspaceId: string | null;
    label: string | null;
    tabId: string | null;
    kind: string | null;
    tabs: WorkspaceTabSummary[];
    finishedTabCount: number;
    contextRailAvailable: boolean;
    contextRailVisible: boolean;
  };
  const [workspaceActiveMap, setWorkspaceActiveMap] = useState<Map<string, WorkspaceActivePayload>>(() => new Map());
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        workspaceId?: string;
        label?: string | null;
        tabId?: string | null;
        kind?: string | null;
        finishedTabCount?: number;
        contextRailAvailable?: boolean;
        contextRailVisible?: boolean;
        removed?: boolean;
      }>).detail;
      const id = detail?.workspaceId;
      if (!id) return;
      setWorkspaceActiveMap((current) => {
        const next = new Map(current);
        if (detail?.removed) {
          next.delete(id);
        } else {
          next.set(id, {
            workspaceId: id,
            label: detail?.label ?? null,
            tabId: detail?.tabId ?? null,
            kind: detail?.kind ?? null,
            tabs: Array.isArray((detail as { tabs?: WorkspaceTabSummary[] })?.tabs)
              ? (detail as { tabs?: WorkspaceTabSummary[] }).tabs ?? []
              : [],
            finishedTabCount: typeof detail?.finishedTabCount === 'number' ? detail.finishedTabCount : 0,
            contextRailAvailable: Boolean(detail?.contextRailAvailable),
            contextRailVisible: detail?.contextRailVisible !== false,
          });
        }
        return next;
      });
    };
    window.addEventListener('o8:workspace-active-label', handler as EventListener);
    return () => window.removeEventListener('o8:workspace-active-label', handler as EventListener);
  }, []);

  const workspaceHeaderActive = useMemo<WorkspaceActivePayload>(() => {
    // Single workspace mounted → its label / pill strip drives the
    // global header. Multiple mounted (splits) → fall back to empty
    // (the split header path below renders both panes side by side).
    if (workspaceActiveMap.size === 1) {
      const [only] = workspaceActiveMap.values();
      return only;
    }
    return { workspaceId: null, label: null, tabId: null, kind: null, tabs: [], finishedTabCount: 0, contextRailAvailable: false, contextRailVisible: false };
  }, [workspaceActiveMap]);

  // Side-by-side header pills for splits — both workspaces' tabs land
  // in the global header with a divider between them, mirroring the
  // visual split below. Only populated when split (2+ workspaces).
  const splitHeaderWorkspaces = useMemo(() => {
    if (workspaceActiveMap.size < 2) return null;
    return Array.from(workspaceActiveMap.entries()).map(([workspaceId, payload]) => ({
      workspaceId,
      tabs: payload.tabs,
      activeTabId: payload.tabId,
      finishedTabCount: payload.finishedTabCount,
      contextRailAvailable: payload.contextRailAvailable,
      contextRailVisible: payload.contextRailVisible,
    }));
  }, [workspaceActiveMap]);

  // `…` menu handlers. Only orchestrator + llm-chat tabs back to
  // /api/v2/chat-history, so we gate by kind. Other tab kinds (CLI
  // sessions, terminals, canvas) skip the menu entirely.
  const titleMenuActive = (workspaceHeaderActive.kind === 'orchestrator'
    || workspaceHeaderActive.kind === 'llm-chat')
    && Boolean(workspaceHeaderActive.tabId);

  const handleTitleArchive = useCallback(async () => {
    const workspaceTabId = workspaceHeaderActive.tabId;
    if (!workspaceTabId) return;
    const threadId = threadIdByTabRef.current.get(workspaceTabId) ?? workspaceTabId;
    try {
      await fetch('/api/v2/chat-history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: threadId, archivedAt: new Date().toISOString() }),
      });
      window.dispatchEvent(new CustomEvent('o8:chat-history-updated', {
        detail: { tabId: workspaceTabId, threadId, archived: true },
      }));
    } catch {
      // silent — operator will see staleness on next refresh
    }
  }, [workspaceHeaderActive.tabId]);

  // Workspace tab id → chat-history thread id map. OrchestratorTab
  // broadcasts 'o8:workspace-thread-id' whenever its loaded thread
  // changes; we use the map to PATCH the canonical chat-history file
  // (issue #1100). Workspace tab id ≠ chat-history thread id — without
  // this lookup the PATCH writes to the wrong file.
  const threadIdByTabRef = useRef<Map<string, string | null>>(new Map());
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; threadId?: string | null }>).detail;
      if (!detail?.tabId) return;
      threadIdByTabRef.current.set(detail.tabId, detail.threadId ?? null);
      // Sidebar shimmer should follow the active workspace tab. Clicking
      // a workspace tab pill activates that tab → its OrchestratorTab
      // fires this event when its loaded thread settles → we sync
      // activeSessionKey so the matching sidebar row shimmers + sits
      // highlighted. Without this the shimmer is pinned to the last
      // SIDEBAR click and diverges from the actually-displayed thread.
      // (The auto-fallback effect upstream guards `llm-chat:` keys so
      // this update isn't overwritten on the next render.)
      if (detail.threadId) {
        setActiveSessionKey(`llm-chat:${detail.threadId}`);
      }
    };
    window.addEventListener('o8:workspace-thread-id', handler as EventListener);
    return () => window.removeEventListener('o8:workspace-thread-id', handler as EventListener);
  }, [setActiveSessionKey]);

  // Bottom DesktopStatusBar pill — branch + lane state.
  //
  // The pill defaults to the project's HEAD branch (globalRepo readiness),
  // but each OrchestratorTab's empty-state lets the operator pick a
  // worktree mode + branch. When an orchestrator tab is active and has
  // surfaced a selection, mirror that branch in the pill so MergeAction
  // Cluster's PR lookup + ready/push/merge state badge follows the
  // operator's worktree pick instead of the repo HEAD.
  //
  // Set on `o8:orchestrator-worktree-selection`, cleared on
  // `o8:orchestrator-worktree-selection-clear` (the broadcasting tab
  // dispatches the clear when it loses focus). When no orchestrator tab
  // is active, this is null and the pill falls back to project state.
  const [orchestratorWorktreeSelection, setOrchestratorWorktreeSelection] = useState<{
    tabId: string;
    repoPath: string | null;
    branch: string;
    worktreeMode: 'local' | 'new-worktree';
  } | null>(null);
  useEffect(() => {
    const handleSelection = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        repoPath?: string | null;
        branch?: string;
        worktreeMode?: 'local' | 'new-worktree';
      }>).detail;
      if (!detail?.tabId || !detail.branch || !detail.worktreeMode) return;
      setOrchestratorWorktreeSelection({
        tabId: detail.tabId,
        repoPath: detail.repoPath ?? null,
        branch: detail.branch,
        worktreeMode: detail.worktreeMode,
      });
    };
    const handleClear = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (!detail?.tabId) return;
      setOrchestratorWorktreeSelection((current) => (
        current && current.tabId === detail.tabId ? null : current
      ));
    };
    window.addEventListener('o8:orchestrator-worktree-selection', handleSelection as EventListener);
    window.addEventListener('o8:orchestrator-worktree-selection-clear', handleClear as EventListener);
    return () => {
      window.removeEventListener('o8:orchestrator-worktree-selection', handleSelection as EventListener);
      window.removeEventListener('o8:orchestrator-worktree-selection-clear', handleClear as EventListener);
    };
  }, []);

  const handleTitleRenameSubmit = useCallback(async (newTitle: string) => {
    // The header strip flipped its label into an inline input and the
    // operator committed a new value. PATCH the chat-history record
    // keyed by THREAD id (chat-history file key), not the workspace
    // tab id. Broadcast updates so other surfaces refetch.
    const workspaceTabId = workspaceHeaderActive.tabId;
    const trimmed = newTitle.trim();
    if (!workspaceTabId || !trimmed) return;
    const threadId = threadIdByTabRef.current.get(workspaceTabId) ?? workspaceTabId;
    const res = await fetch('/api/v2/chat-history', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: threadId, title: trimmed }),
    });
    if (!res.ok) throw new Error('rename failed');
    // Include both the workspace tab id (for in-memory label updates)
    // and the thread id (for chat-history-keyed surfaces) so both
    // listeners can fire correctly.
    window.dispatchEvent(new CustomEvent('o8:chat-history-updated', {
      detail: { tabId: workspaceTabId, threadId, title: trimmed },
    }));
  }, [workspaceHeaderActive.tabId]);

  // Single-workspace spawn shortcut. Dispatches a window event the
  // (only) WorkspaceTerminalRoot listens for to call its spawn handlers.
  // Only meaningful when there's a single workspace; with splits each
  // pane's own lower TabBar carries the play button.
  const isSingleWorkspace = workspaceActiveMap.size === 1;
  const dispatchSpawn = useCallback((kind: 'orchestrator' | 'chat' | 'terminal') => {
    window.dispatchEvent(new CustomEvent('o8:request-spawn-tab', { detail: { kind } }));
  }, []);
  const handleSpawnOrchestrator = useCallback(() => dispatchSpawn('orchestrator'), [dispatchSpawn]);
  const handleSpawnChat = useCallback(() => dispatchSpawn('chat'), [dispatchSpawn]);
  const handleSpawnTerminal = useCallback(() => dispatchSpawn('terminal'), [dispatchSpawn]);

  const handleTitleShare = useCallback(async () => {
    const workspaceTabId = workspaceHeaderActive.tabId;
    if (!workspaceTabId) return;
    const threadId = threadIdByTabRef.current.get(workspaceTabId) ?? workspaceTabId;
    try {
      const res = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(threadId)}`);
      if (!res.ok) return;
      const data = await res.json();
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      const title = data?.title ?? workspaceHeaderActive.label ?? 'Conversation';
      const lines: string[] = [`# ${title}`, ''];
      for (const msg of messages) {
        const role = msg?.role ?? 'note';
        const content = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content ?? '');
        lines.push(`**${role}**`, '', content, '');
      }
      const markdown = lines.join('\n');
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(markdown);
      }
    } catch {
      // silent
    }
  }, [workspaceHeaderActive.label, workspaceHeaderActive.tabId]);

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
  // Always-mounted Mission-complete detector — records the card from durable
  // lane-lifecycle signals regardless of which tab is focused, so a dispatched
  // mission's completion card survives the orchestrator tab's active/mode
  // flapping. The orchestrator feed drains the recorded card on view.
  useMissionCompleteDetector(thoughtsMissionState);
  // ── Right panel + workspace side panel state (tightly coupled to callbacks, kept inline) ──
  // SSR-safe defaults; hydrate from localStorage in an effect so the
  // visibility/kind survives a reload but server and first client render
  // match (no hydration mismatch).
  const [chatVisible, setChatVisible] = useState(false);
  const [rightPanelKind, setRightPanelKind] = useState<'review' | 'o8'>('o8');
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const viewportWidthRef = useRef<number | null>(null);
  const [responsiveAutoCollapsed, setResponsiveAutoCollapsed] = useState({ left: false, right: false });
  const responsiveManualOpenRef = useRef({ left: false, right: false });
  useEffect(() => {
    try {
      const visRaw = window.localStorage.getItem('o8:right-panel:visible');
      const kindRaw = window.localStorage.getItem('o8:right-panel:kind');
      if (visRaw === '1') setChatVisible(true);
      if (kindRaw === 'o8' || kindRaw === 'review') setRightPanelKind(kindRaw);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (responsiveAutoCollapsed.right) return;
    try { window.localStorage.setItem('o8:right-panel:visible', chatVisible ? '1' : '0'); } catch { /* ignore */ }
  }, [chatVisible, responsiveAutoCollapsed.right]);
  useEffect(() => {
    try { window.localStorage.setItem('o8:right-panel:kind', rightPanelKind); } catch { /* ignore */ }
  }, [rightPanelKind]);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const update = () => {
      const next = window.innerWidth;
      viewportWidthRef.current = next;
      setViewportWidth(next);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const compactShell = viewportWidth !== null && viewportWidth < RESPONSIVE_COMPACT_SHELL_WIDTH;
  const getResponsiveViewportWidth = useCallback(() => (
    viewportWidthRef.current ?? (typeof window !== 'undefined' ? window.innerWidth : Number.POSITIVE_INFINITY)
  ), []);
  const noteSidebarManualIntent = useCallback((nextVisible: boolean) => {
    responsiveManualOpenRef.current.left = nextVisible
      && getResponsiveViewportWidth() < RESPONSIVE_LEFT_PANEL_COLLAPSE_WIDTH;
    setResponsiveAutoCollapsed((current) => (
      current.left ? { ...current, left: false } : current
    ));
  }, [getResponsiveViewportWidth]);
  const toggleSidebarFromChrome = useCallback(() => {
    const nextVisible = !sidebarVisible;
    noteSidebarManualIntent(nextVisible);
    setSidebarVisible(nextVisible);
  }, [noteSidebarManualIntent, setSidebarVisible, sidebarVisible]);
  const openSidebarFromChrome = useCallback(() => {
    noteSidebarManualIntent(true);
    setSidebarVisible(true);
  }, [noteSidebarManualIntent, setSidebarVisible]);
  const noteRightPanelManualIntent = useCallback((nextVisible: boolean) => {
    responsiveManualOpenRef.current.right = nextVisible
      && getResponsiveViewportWidth() < RESPONSIVE_RIGHT_PANEL_COLLAPSE_WIDTH;
    setResponsiveAutoCollapsed((current) => (
      current.right ? { ...current, right: false } : current
    ));
  }, [getResponsiveViewportWidth]);
  const openRightPanelFromUser = useCallback(() => {
    noteRightPanelManualIntent(true);
    setChatVisible(true);
  }, [noteRightPanelManualIntent]);
  const closeRightPanelFromUser = useCallback(() => {
    noteRightPanelManualIntent(false);
    setChatVisible(false);
  }, [noteRightPanelManualIntent]);
  useEffect(() => {
    if (viewportWidth === null) return;

    if (viewportWidth < RESPONSIVE_RIGHT_PANEL_COLLAPSE_WIDTH) {
      if (chatVisible && !responsiveManualOpenRef.current.right) {
        setResponsiveAutoCollapsed((current) => (
          current.right ? current : { ...current, right: true }
        ));
        setChatVisible(false);
      }
    } else {
      responsiveManualOpenRef.current.right = false;
      if (responsiveAutoCollapsed.right) {
        setChatVisible(true);
        setResponsiveAutoCollapsed((current) => (
          current.right ? { ...current, right: false } : current
        ));
      }
    }

    if (viewportWidth < RESPONSIVE_LEFT_PANEL_COLLAPSE_WIDTH) {
      if (sidebarVisible && !responsiveManualOpenRef.current.left) {
        setResponsiveAutoCollapsed((current) => (
          current.left ? current : { ...current, left: true }
        ));
        setSidebarVisible(false);
      }
    } else {
      responsiveManualOpenRef.current.left = false;
      if (responsiveAutoCollapsed.left) {
        setSidebarVisible(true);
        setResponsiveAutoCollapsed((current) => (
          current.left ? { ...current, left: false } : current
        ));
      }
    }
  }, [
    chatVisible,
    responsiveAutoCollapsed.left,
    responsiveAutoCollapsed.right,
    setSidebarVisible,
    sidebarVisible,
    viewportWidth,
  ]);
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
  const o8SpecAutoWidenedRef = useRef(false);
  const handleO8TabChange = useCallback((tab: O8Tab) => {
    if (tab === 'spec' && !o8SpecAutoWidenedRef.current) {
      o8SpecAutoWidenedRef.current = true;
      setO8Width((current) => (
        current < O8_SPEC_PANEL_TARGET_WIDTH
          ? O8_SPEC_PANEL_TARGET_WIDTH
          : current
      ));
    }
    setO8ActiveTab(tab);
  }, []);
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
  // Right-panel repo scope: true = "All repos" aggregate across the active
  // project, false = focused on currentO8RepoPath. Shared by the Workspace +
  // Activity selectors and driven by the left switcher (project pick → all,
  // repo pick → that repo).
  const [o8AllRepos, setO8AllRepos] = useState(false);
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
    const id = safeRequestIdleCallback(prefetch, { fallbackDelayMs: 100 });
    return () => safeCancelIdleCallback(id);
  }, []);

  const { handleSetupComplete, setSetupWizardOpen, setupCompleteError, setupWizardOpen } = useSetupWizard();

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
  // Mirror for the project-switch guard effect — lets it read the focused repo
  // without re-subscribing (and without clobbering an explicit repo pick).
  const currentO8RepoPathRef = useRef<string | null>(null);
  currentO8RepoPathRef.current = currentO8RepoPath;
  const scopedO8SelectedFile = o8SelectedFileRepoPath === currentO8RepoPath ? o8SelectedFile : null;

  // Scope the right-panel surfaces (Activity / PRs / GitHub) to the ACTIVE
  // project's repos rather than the global pool, so repos that aren't in the
  // project (old ones, ones moved out) don't keep showing in the control room.
  // Falls back to the global list if scoping would empty it.
  const activeProjectRepoEntries = useMemo(() => {
    const ledger = dashboardProjects.ledger;
    if (!ledger?.projects?.length) return globalRepoEntries;
    const active = ledger.projects.find((p) => p.id === ledger.activeProjectId) ?? ledger.projects[0];
    const paths = new Set((active?.repoPaths ?? []).map((p) => p.replace(/\/+$/, '')));
    if (paths.size === 0) return globalRepoEntries;
    const scoped = globalRepoEntries.filter((repo) => paths.has(repo.localPath.replace(/\/+$/, '')));
    return scoped.length > 0 ? scoped : globalRepoEntries;
  }, [dashboardProjects.ledger, globalRepoEntries]);

  // When the active PROJECT changes, keep the right panel coherent. Repo
  // membership is exclusive to one project, so after a project switch the
  // previously-focused repo no longer belongs here. A pure project pick →
  // default to the project's primary repo (so a freshly spawned orchestrator +
  // commit surfaces have a valid target) AND show the "All repos" aggregate.
  // If a specific repo was just picked on the left (focused repo IS in the new
  // project, set synchronously before this fires) → keep it, no All-repos.
  const lastActiveProjectRef = useRef<string | null>(null);
  useEffect(() => {
    const ledger = dashboardProjects.ledger;
    const activeId = ledger?.activeProjectId ?? null;
    if (!activeId || activeId === lastActiveProjectRef.current) return;
    const isFirst = lastActiveProjectRef.current === null;
    lastActiveProjectRef.current = activeId;
    if (isFirst) return; // don't override the repo chosen on initial load
    const project = ledger?.projects.find((p) => p.id === activeId);
    const projectPaths = new Set((project?.repoPaths ?? []).map((p) => p.replace(/\/+$/, '')));
    const focused = currentO8RepoPathRef.current?.replace(/\/+$/, '') ?? null;
    if (focused && projectPaths.has(focused)) return; // explicit repo pick → keep it
    const primaryPath = project?.repoPaths?.[0];
    if (primaryPath) {
      const entry = globalRepoEntries.find((repo) => repo.localPath === primaryPath);
      if (entry) {
        setGlobalRepoId(entry.id);
        setO8RepoPathOverride(primaryPath);
        setO8CommitRepoPath(null);
      }
    }
    setO8AllRepos(true);
  }, [dashboardProjects.ledger, globalRepoEntries, setGlobalRepoId]);

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

  // "Control-room mode" — LeftPanelProjectFocus dispatches o8:control-room-wide
  // when the Control tab is active, so the left column widens to fit the
  // two-column control room and collapses back on Chats / close.
  const [controlRoomWide, setControlRoomWide] = useState(false);
  useEffect(() => {
    const handler = (event: Event) => {
      setControlRoomWide(Boolean((event as CustomEvent<{ wide?: boolean }>).detail?.wide));
    };
    window.addEventListener('o8:control-room-wide', handler);
    return () => window.removeEventListener('o8:control-room-wide', handler);
  }, []);

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
        // Reuse a tab that MATCHES the thread's kind — orchestrator threads
        // (thoughts-*) reuse only an orchestrator tab (Claude); never load them
        // into the free o8-Default casual chat. Falling through to historyTabId
        // makes a fresh tab of the right kind (see buildHistoryChatTab).
        const isOrchestratorThread = historyTabId.startsWith('thoughts-');
        const primaryConversationTab = isOrchestratorThread
          ? snapshot.tabs.find((tab) => tab.kind === 'orchestrator') ?? null
          : snapshot.tabs.find((tab) => tab.kind === 'llm-chat' && tab.id !== historyTabId)
              ?? snapshot.tabs.find((tab) => tab.kind === 'llm-chat')
              ?? null;
        const tabId = target.handle.openHistoryChat(primaryConversationTab?.id ?? historyTabId, title, repo);
        if (tabId) {
          window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId } }));
          const loadThread = () => {
            window.dispatchEvent(new CustomEvent('o8:load-history-thread', {
              detail: { tabId, historyTabId },
            }));
          };
          // When the OrchestratorTab is already mounted + active, its
          // o8:load-history-thread listener is registered and a single
          // dispatch suffices. The 120/420ms retries are only needed when
          // the tab is being newly-activated — without them, the listener
          // can mount AFTER our first dispatch and miss it. The redundant
          // trampoline used to flicker the transcript on already-open
          // chats (3x load × ~80ms each). Cooldown in handleLoadThread
          // keeps the retries cheap even when they do fire.
          const tabAlreadyActive = snapshot.activeTabId === tabId;
          loadThread();
          if (!tabAlreadyActive) {
            window.setTimeout(loadThread, 120);
            window.setTimeout(loadThread, 420);
          }
        }
      } catch {
        // Best-effort sidebar navigation; the workspace terminal may still be mounting.
      }
    })();
  }, [activeTileId, setActiveSessionKey, waitForWorkspaceTerminalTarget]);

  const wsConnectionState = useWsConnectionState();
  const wsConnectedRef = useRef<typeof wsConnectionState>('disconnected');
  wsConnectedRef.current = wsConnectionState;
  const mobileRevealCursorRef = useRef(new Date(Date.now() - 3000).toISOString());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const seen = new Set<string>();
    let disposed = false;
    let inFlight = false;

    const openRevealRequest = (requestedAt: string | null, thread: MobileOrchestratorThread | undefined) => {
      if (!requestedAt || !thread?.id || !thread.title) return;
      if (Date.parse(requestedAt) > Date.parse(mobileRevealCursorRef.current)) {
        mobileRevealCursorRef.current = requestedAt;
      }
      const seenKey = `${thread.id}:${requestedAt}`;
      if (seen.has(seenKey)) return;
      seen.add(seenKey);
      handleOpenHistoryChatFromPanel(
        thread.id,
        thread.title,
        historyRepoContextFromMobileThread(thread),
      );
    };

    const handleThreadEvent = (event: Event) => {
      const detail = (event as CustomEvent<{
        event?: string;
        data?: { requestedAt?: string; thread?: MobileOrchestratorThread };
      }>).detail;
      if (detail?.event !== 'reveal') return;
      openRevealRequest(
        typeof detail.data?.requestedAt === 'string' ? detail.data.requestedAt : null,
        detail.data?.thread,
      );
    };

    const pollMobileRevealRequests = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/mobile/orchestrator/threads/reveal?since=${encodeURIComponent(mobileRevealCursorRef.current)}`, { cache: 'no-store' });
        if (!res.ok || disposed) return;
        const data = await res.json() as {
          requests?: Array<{ requestedAt?: string; thread?: MobileOrchestratorThread }>;
        };
        const requests = Array.isArray(data.requests) ? data.requests : [];
        for (const request of requests) {
          openRevealRequest(
            typeof request.requestedAt === 'string' ? request.requestedAt : null,
            request.thread,
          );
        }
      } catch {
        // Best-effort mobile reveal bridge; the normal history list still works.
      } finally {
        inFlight = false;
      }
    };

    window.addEventListener('o8:orchestrator-threads', handleThreadEvent);
    void pollMobileRevealRequests();
    const timer = window.setInterval(() => {
      if (wsConnectedRef.current === 'connected') return;
      void pollMobileRevealRequests();
    }, 30000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('o8:orchestrator-threads', handleThreadEvent);
    };
  }, [handleOpenHistoryChatFromPanel]);

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
      // Cmd+1-9 — jump straight to tab N. Allowed inside editable fields too
      // (like browsers / VS Code) so power users switch tabs without leaving
      // the composer. ⌘+digit is a no-op in a plain textarea, so nothing is
      // lost. Shift+digit naturally falls through (event.key becomes '!' etc).
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
      if (isEditable && !event.altKey) {
        // Cmd+W must not fire while typing — it would close the tab and drop
        // the in-progress draft. Cmd+Opt+Arrow and Cmd+digit bypass this
        // guard above, matching iTerm / browser tab navigation.
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

  // ── ⌘/ (and bare `?`) opens the keyboard-shortcuts reference overlay ──
  // ⌘/ is the macOS-convention "show shortcuts" binding; `?` is a fallback
  // that only fires when the user isn't typing into a field. Both skip
  // editable targets so they don't hijack literal `/` or `?` input.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isSlash = (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && event.key === '/';
      const isQuestion = !event.metaKey && !event.ctrlKey && !event.altKey && event.key === '?';
      if (!isSlash && !isQuestion) return;

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
      setShortcutsOpen((current) => !current);
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
    const handle = safeRequestIdleCallback(run, { timeout: 2000 });
    return () => {
      safeCancelIdleCallback(handle);
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
      openRightPanelFromUser();
      setO8ActiveTab('inbox');
    };
    window.addEventListener('o8:open-inbox-tab', handleOpenInbox);
    return () => window.removeEventListener('o8:open-inbox-tab', handleOpenInbox);
  }, [openRightPanelFromUser]);

  // Automations nav entry (lives in AgentPanel's MiniAgentPanelHeader) dispatches
  // o8:open-automations when clicked. Flip the activeNavSection so the
  // AutomationsPage takes the workspace center. Codex-style page-takeover.
  useEffect(() => {
    const handler = () => setActiveNavSection('automations');
    window.addEventListener('o8:open-automations', handler);
    return () => window.removeEventListener('o8:open-automations', handler);
  }, [setActiveNavSection]);

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
    setO8AllRepos(false); // picking a specific repo exits the All-repos aggregate
    const targetRepo = globalRepoEntries.find((r) => r.id === repoId);
    if (targetRepo) {
      setO8RepoPathOverride(targetRepo.localPath);
      setO8SelectedFile(null);
      setO8SelectedFileRepoPath(null);
    }
  }, [globalRepoEntries, handleSelectRegisteredRepo]);

  const handleRepoAddedFromPanel = useCallback(async (repo: RepoRegistryEntry) => {
    const repos = await loadRegisteredRepos();
    const selected = repos.find((entry) => entry.id === repo.id) ?? repo;
    setGlobalRepoId(selected.id);
    setGlobalRepoBranch(selected.defaultBranch || 'main');
    setO8RepoPathOverride(selected.localPath);
    setO8SelectedFile(null);
    setO8SelectedFileRepoPath(null);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', selected.id);
    }
  }, [loadRegisteredRepos, setGlobalRepoBranch, setGlobalRepoId]);

  // ── Routing callbacks for AgentPanel ──
  // Open the wide O8 panel pinned to a specific repo path + tab. Callers
  // that need review mode pass `workspace`; otherwise the panel lands on
  // the operator briefing pulse.
  const handleOpenO8Panel = useCallback((options: { repoPath?: string | null; tab?: O8Tab }) => {
    if (options.repoPath) setO8RepoPathOverride(options.repoPath);
    setO8ActiveTab(normalizeO8ActiveTab(options.tab) ?? DEFAULT_O8_ACTIVE_TAB);
    setRightPanelKind('o8');
    openRightPanelFromUser();
  }, [openRightPanelFromUser]);

  const handleSelectSession = useCallback((sessionKey: string) => {
    // Open the session transcript in a canvas chat tab
    void (async () => {
      const selectedSession = ideWorkspaceSessionsForSidebar.find((session) => (
        session.sessionKey === sessionKey
        || session.id === sessionKey
        || session.sessionId === sessionKey
        || session.runtimeSurface?.id === sessionKey
      ));
      const sessionScope = selectedSession?.workspace
        ?? selectedSession?.runtimeSurface?.cwd
        ?? null;
      const targetRepo = sessionScope
        ? workspaceScopeEntries.find((repo) => (
          pathBelongsToRepoScope(sessionScope, repo.localPath)
          || pathBelongsToRepoScope(repo.localPath, sessionScope)
        ))
        : null;
      const target = await waitForWorkspaceTerminalTarget({
        repoPath: targetRepo?.localPath ?? sessionScope ?? undefined,
      });
      if (!target) return;
      const runtime = selectedSession?.runtime === 'claude-code'
        || selectedSession?.runtime === 'gemini'
        || selectedSession?.runtime === 'opencode'
        || selectedSession?.runtime === 'codex'
        ? selectedSession.runtime
        : sessionKey.startsWith('claude-code:') ? 'claude-code'
        : sessionKey.startsWith('gemini-owned:') ? 'gemini'
        : sessionKey.startsWith('opencode-owned:') ? 'opencode'
        : 'codex';
      const label = selectedSession?.name?.trim()
        || selectedSession?.surfaceLabel?.trim()
        || selectedSession?.currentTask?.trim()
        || sessionKey.split(':').pop()?.slice(0, 12)
        || 'Session';
      target.handle.openCliChatSession({
        runtime,
        repo: targetRepo ? {
          name: targetRepo.name,
          localPath: targetRepo.localPath,
          remoteUrl: targetRepo.remoteUrl,
          branch: targetRepo.branch,
          readiness: targetRepo.readiness,
          registryRepoId: targetRepo.registryRepoId,
          isWorktree: targetRepo.isWorktree,
          worktreeStatus: targetRepo.worktreeStatus,
        } : undefined,
        targetSessionKey: sessionKey,
        label,
      });
      setActiveTileId(target.tileId);

    })();
  }, [ideWorkspaceSessionsForSidebar, setActiveTileId, waitForWorkspaceTerminalTarget, workspaceScopeEntries]);

  const flashWorkspaceTab = useCallback((tabId: string) => {
    if (!tabId) return;
    window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId } }));
  }, []);

  const handleCreateWorkspaceOrchestrator = useCallback(() => {
    void (async () => {
      try {
        const target = await waitForWorkspaceTerminalTarget({
          preferredTileId: activeTileId,
          fallbackToAnyExisting: true,
        });
        setActiveTileId(target.tileId);
        flashWorkspaceTab(target.handle.openOrchestratorTab());
      } catch {
        // Workspace may still be mounting; the click is best-effort.
      }
    })();
  }, [activeTileId, flashWorkspaceTab, setActiveTileId, waitForWorkspaceTerminalTarget]);

  const handleCreateWorkspaceChat = useCallback(() => {
    void (async () => {
      try {
        const target = await waitForWorkspaceTerminalTarget({
          repoPath: workspaceTerminalPreferredRepo?.localPath ?? null,
          preferredTileId: activeTileId,
          fallbackToAnyExisting: true,
        });
        setActiveTileId(target.tileId);
        flashWorkspaceTab(target.handle.openLlmChatSession({
          repo: workspaceTerminalPreferredRepo ?? undefined,
          label: 'Chat',
          createNew: true,
        }));
      } catch {
        // Workspace may still be mounting; the click is best-effort.
      }
    })();
  }, [activeTileId, flashWorkspaceTab, setActiveTileId, waitForWorkspaceTerminalTarget, workspaceTerminalPreferredRepo]);

  const handleCreateWorkspaceTerminal = useCallback(() => {
    void (async () => {
      try {
        const target = await waitForWorkspaceTerminalTarget({
          repoPath: workspaceTerminalPreferredRepo?.localPath ?? null,
          preferredTileId: activeTileId,
          fallbackToAnyExisting: true,
        });
        setActiveTileId(target.tileId);
        flashWorkspaceTab(target.handle.openTerminalTab(workspaceTerminalPreferredRepo ?? undefined));
      } catch {
        // Workspace may still be mounting; the click is best-effort.
      }
    })();
  }, [activeTileId, flashWorkspaceTab, setActiveTileId, waitForWorkspaceTerminalTarget, workspaceTerminalPreferredRepo]);

  const handleSelectIssue = useCallback((issueNumber: number, repo?: string) => {
    setRightPanelKind('review');
    openRightPanelFromUser();
    openCanvasTab({
      id: `issue:${issueNumber}${repo ? `:${repo}` : ''}`,
      kind: 'issue',
      label: `#${issueNumber}`,
      resourceId: String(issueNumber),
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab, openRightPanelFromUser]);

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
    openRightPanelFromUser();
    openCanvasTab({
      id: `pr:${prNumber}${repo ? `:${repo}` : ''}`,
      kind: 'pr',
      label: `PR #${prNumber}`,
      resourceId: String(prNumber),
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab, openRightPanelFromUser]);

  const handleReviewPR = useCallback((prNumber: number, repo?: string) => {
    // PRs now live under Activity — prNumber 0 means show the Activity feed.
    setO8CommitSha(null);
    setO8CommitRepoPath(null);
    setO8CommitRepoSlug(null);
    setO8ActiveTab('activity');
    setO8PrNumber(prNumber || null);
    setO8PrRepo(repo ?? null);
    setRightPanelKind('o8');
    openRightPanelFromUser();
  }, [openRightPanelFromUser]);

  const handleDeepReviewPR = useCallback((prNumber: number, repo?: string) => {
    handleSelectPR(prNumber, repo);
    handleReviewPR(prNumber, repo);
  }, [handleReviewPR, handleSelectPR]);

  // Bridge for transcript PR-link clicks. LLMMarkdown intercepts GitHub
  // PR URLs and dispatches `o8:open-pr` instead of opening the browser;
  // the listener routes through handleReviewPR so the right panel opens
  // Activity with the inline PrPanel detail.
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

  // Right-clicking an inline image in o8.md → "Add to chat" dispatches
  // `o8:attach-image` with the asset URL. Fetch it here (single, always-mounted
  // listener — avoids multi-firing across the visibility:hidden chat tabs), encode
  // as a data URI, and stash it as an image injection the visible chat composer
  // consumes once.
  useEffect(() => {
    const handleAttachImage = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: string; name?: string }>).detail;
      if (!detail?.url) return;
      const url = detail.url;
      const name = detail.name || 'image';
      void (async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const blob = await res.blob();
          const dataUri = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          setThoughtsImageInjection({
            id: `img-${Date.now()}`,
            dataUri,
            name,
            mimeType: blob.type || 'image/png',
          });
        } catch { /* transient — ignore */ }
      })();
    };
    window.addEventListener('o8:attach-image', handleAttachImage);
    return () => window.removeEventListener('o8:attach-image', handleAttachImage);
  }, [setThoughtsImageInjection]);

  const handleImageInjectionConsumed = useCallback(() => {
    setThoughtsImageInjection(null);
  }, [setThoughtsImageInjection]);

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
    // Approvals surface lives under the O8 panel's Activity tab now — no more
    // dedicated Review tab or NavRail shield button. The only remaining
    // caller is an onboarding coachmark CTA.
    handleReviewPR(0);
  }, [handleReviewPR]);

  const handleToggleChatPanel = useCallback(() => {
    // v1: chat panel removed — toggle workspace instead
    if (chatVisible) {
      closeRightPanelFromUser();
      return;
    }
    openRightPanelFromUser();
  }, [chatVisible, closeRightPanelFromUser, openRightPanelFromUser]);

  const handleToggleO8Panel = useCallback(() => {
    if (chatVisible && rightPanelKind === 'o8') {
      // o8 → collapsed. Keep kind=o8 so next click re-opens straight to O8
      // (not the workspace side panel). Clear commit context so reopening
      // doesn't re-expand a stale commit detail.
      closeRightPanelFromUser();
      setO8CommitSha(null);
      setO8CommitRepoPath(null);
      setO8CommitRepoSlug(null);
      return;
    }
    setRightPanelKind('o8');
    openRightPanelFromUser();
  }, [chatVisible, closeRightPanelFromUser, openRightPanelFromUser, rightPanelKind]);

  // Browser button on the TitleBar — opens (or focuses) the wide O8 panel
  // and selects its Browser tab. The Browser tab itself is no longer in the
  // O8 panel's tab strip; it lives in the title bar so we can hover-extend
  // it with a quick port menu.
  const handleOpenBrowser = useCallback(() => {
    setRightPanelKind('o8');
    openRightPanelFromUser();
    setO8ActiveTab('browser');
  }, [openRightPanelFromUser]);

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
    openRightPanelFromUser();
    setRightPanelMode('chat');
    setDesktopDraftInjection({
      id: `${payload.reason}-${Date.now()}`,
      text: payload.text,
    });
  }, [openRightPanelFromUser, setDesktopDraftInjection]);

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
      openRightPanelFromUser();
      setRightPanelMode('chat');
      setDesktopDraftInjection(nextInjection);
    })();
  }, [activeWorkspaceChatSessionKey, globalRepoBranch, globalRepoEntry, openRightPanelFromUser, setActiveWorkspace, setDesktopDraftInjection, waitForWorkspaceTerminalTarget, workspaceChatTargetKeyByRepoPath, workspaceChatTargets]);

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

  // ── Open a non-terminal surface in the bottom panel ──
  const handleOpenBottomPanelSurface = useCallback((surface: BottomPanelSurfaceKind) => {
    const tileId = ensureTileKind('contextual-panel', {
      direction: 'horizontal',
      preferredKinds: ['terminal', 'contextual-panel', 'preview'],
      ratio: 0.68,
    });
    const open = (attempt = 0) => {
      const handle = getPreferredContextualPanelHandle(tileId);
      if (handle) {
        handle.openSurface(surface);
        return;
      }
      if (attempt < 8) {
        window.setTimeout(() => open(attempt + 1), 50);
      }
    };
    open();
  }, [ensureTileKind, getPreferredContextualPanelHandle]);

  // ── Watch a live o8-owned run session (`o8 run`) in the bottom panel ──
  const handleOpenAgentTerminal = useCallback((session: string) => {
    if (!session) return;
    const tileId = ensureTileKind('contextual-panel', {
      direction: 'horizontal',
      preferredKinds: ['terminal', 'contextual-panel', 'preview'],
      ratio: 0.68,
    });
    const attach = (attempt = 0) => {
      const handle = getPreferredContextualPanelHandle(tileId);
      if (handle) {
        handle.attachLiveAgentTerminal(session);
        return;
      }
      if (attempt < 8) {
        window.setTimeout(() => attach(attempt + 1), 50);
      }
    };
    attach();
  }, [ensureTileKind, getPreferredContextualPanelHandle]);

  // Footer agent chip → attach the o8 run's live terminal in the bottom panel.
  useEffect(() => {
    const handleOpenAgentTerminalEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ session?: string }>).detail;
      if (detail?.session) handleOpenAgentTerminal(detail.session);
    };
    window.addEventListener('o8:open-agent-terminal', handleOpenAgentTerminalEvent);
    return () => window.removeEventListener('o8:open-agent-terminal', handleOpenAgentTerminalEvent);
  }, [handleOpenAgentTerminal]);

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
    openRightPanelFromUser();
  }, [openRightPanelFromUser]);

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
    openRightPanelFromUser();

    openCanvasTab({
      id: `${isImage ? 'image' : 'file'}:${filePath}${workspace ? `:${workspace}` : ''}`,
      kind: isImage ? 'image' : 'file',
      label: filePath.split('/').pop() ?? filePath,
      resourceId: filePath,
      meta: workspace ? { workspace } : undefined,
    });
  }, [activeWorkspace, globalRepoEntry?.localPath, openCanvasTab, openRightPanelFromUser]);

  const handleOpenSpecInWorkspace = useCallback((repoPath: string) => {
    setO8CommitSha(null);
    setO8CommitRepoPath(null);
    setO8CommitRepoSlug(null);
    setO8RepoPathOverride(repoPath);
    setO8ActiveTab('spec');
    setRightPanelKind('o8');
    openRightPanelFromUser();
  }, [openRightPanelFromUser]);

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
    openRightPanelFromUser();
  }, [globalRepoEntries, globalRepoEntry, openRightPanelFromUser]);

  const handleClearCommit = useCallback(() => {
    setO8CommitSha(null);
    setO8CommitRepoPath(null);
    setO8CommitRepoSlug(null);
  }, []);

  const handleSelectO8RepoPath = useCallback((repoPath: string) => {
    handleClearCommit();
    setO8RepoPathOverride(repoPath);
    setO8AllRepos(false); // a concrete repo pick (selector / overview row) exits All-repos
    setO8SelectedFile(null);
    setO8SelectedFileRepoPath(null);
  }, [handleClearCommit]);

  // "All repos" — the shared O8RepoSelector and the left project pick route here.
  const handleSelectO8AllRepos = useCallback(() => {
    setO8AllRepos(true);
  }, []);

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

  // ── Sidebar hover-preview open/close ──
  // Open immediately on hover-enter; close on hover-leave with a 220ms grace
  // window so brief mouse-outs (cursor crossing a sub-element, scrollbar nudge)
  // don't dismiss. Both the trigger zone and the overlay share these helpers
  // so moving the cursor between them never flickers the panel away.
  const cancelSidebarPreviewClose = useCallback(() => {
    if (sidebarPreviewLeaveTimerRef.current) {
      clearTimeout(sidebarPreviewLeaveTimerRef.current);
      sidebarPreviewLeaveTimerRef.current = null;
    }
  }, []);
  const openSidebarPreview = useCallback(() => {
    cancelSidebarPreviewClose();
    setSidebarPreviewOpen(true);
  }, [cancelSidebarPreviewClose]);
  const scheduleSidebarPreviewClose = useCallback(() => {
    cancelSidebarPreviewClose();
    sidebarPreviewLeaveTimerRef.current = setTimeout(() => {
      setSidebarPreviewOpen(false);
      sidebarPreviewLeaveTimerRef.current = null;
    }, 220);
  }, [cancelSidebarPreviewClose]);
  // Outside-click dismiss + cleanup on unmount.
  useEffect(() => {
    if (!sidebarPreviewOpen) return;
    const handleClick = (event: MouseEvent) => {
      const overlay = sidebarPreviewOverlayRef.current;
      if (!overlay) return;
      if (event.target instanceof Node && overlay.contains(event.target)) return;
      // Don't pre-empt clicks on the sidebar-toggle pill — its own onClick
      // toggles `sidebarVisible` and the collapse-on-open effect at line
      // 3047 dismisses the preview right after. If we close the preview
      // here first, AnimatePresence starts an exit animation while React
      // is still processing the click, which on real cursors lands the
      // click target on the (still-animating) overlay subtree and the
      // pill's onClick never fires. Symptom: "i have to double click"
      // (operator 2026-05-28). Skipping the pill click lets the toggle
      // own the dismiss path.
      if (event.target instanceof Element) {
        const togglePill = event.target.closest('[aria-label="Toggle sidebar"]');
        if (togglePill) return;
      }
      setSidebarPreviewOpen(false);
    };
    // mousedown so the dismiss fires before any focus changes from the
    // underlying click target — same pattern as the right-rail popovers.
    window.addEventListener('mousedown', handleClick, true);
    return () => window.removeEventListener('mousedown', handleClick, true);
  }, [sidebarPreviewOpen]);
  useEffect(() => () => {
    if (sidebarPreviewLeaveTimerRef.current) {
      clearTimeout(sidebarPreviewLeaveTimerRef.current);
    }
  }, []);
  // When the sidebar re-expands (click on the toggle, ⌘B shortcut, etc.) the
  // hover-preview becomes redundant — collapse it immediately so we don't end
  // up with both surfaces visible at once.
  useEffect(() => {
    if (sidebarVisible && sidebarPreviewOpen) {
      cancelSidebarPreviewClose();
      setSidebarPreviewOpen(false);
    }
  }, [sidebarVisible, sidebarPreviewOpen, cancelSidebarPreviewClose]);

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
    // Sidebar chat-history clicks set activeSessionKey to `llm-chat:<tabId>`
    // — these are chat-thread selections, not CLI session selections, so a
    // palette agent will never match. Without this guard the fallback below
    // overwrites the chat-thread selection with a CLI session key on the
    // very next render, killing the active-row shimmer + highlight.
    if (activeSessionKey.startsWith('llm-chat:')) return;
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
  const showCompletionFtux = activeFtuxMilestone === 'firstCompletion' && timelineVisible;
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

  // ── Power-user chrome shortcuts ──
  // macOS / VS Code conventions, each mapped to a real existing action:
  //   ⌘T new tab · ⌘, settings · ⌘B left sidebar · ⌘⌥B right panel · ⌘J terminal
  // Allowed even while typing — these are app-chrome toggles, none emit text,
  // and power users expect them to fire mid-compose (matches VS Code). Placed
  // here (not with the other hotkey effects above) so toggleSettingsOverlay is
  // already defined — referencing it earlier would hit its const TDZ.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      // ⌘⌥B — toggle right panel. Calls the same handler as the header
      // button so the panel kind + commit context stay in lockstep. Option
      // remaps event.key on macOS (⌥B → '∫'), so match the physical key via
      // event.code. Other Option combos (⌘⌥← / →, handled elsewhere) fall
      // through untouched.
      if (event.altKey) {
        if (event.code === 'KeyB' && !event.shiftKey) {
          event.preventDefault();
          handleToggleO8Panel();
        }
        return;
      }
      if (event.shiftKey) return;
      switch (event.key.toLowerCase()) {
        case 't':
          event.preventDefault();
          dispatchSpawn('orchestrator');
          break;
        case 'b':
          event.preventDefault();
          toggleSidebarFromChrome();
          break;
        case 'j':
          event.preventDefault();
          toggleContextualPanelTile();
          break;
        case ',':
          event.preventDefault();
          toggleSettingsOverlay();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatchSpawn, handleToggleO8Panel, toggleContextualPanelTile, toggleSettingsOverlay, toggleSidebarFromChrome]);

  // ── Symon o8-control: `o8:ui-command` → open a named o8 surface ──
  // The voice agent's `o8_ui_open` tool emits this (src-tauri/src/agent/tools/
  // o8_ui.rs). Routes to the SAME handlers the buttons use — settings overlay,
  // mobile-pairing canvas tab, right-panel tabs, browser pane — so voice and
  // click stay in lockstep. voice_settings never arrives here (Rust opens the
  // standalone window directly).
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const O8_TAB_SURFACES: Record<string, O8Tab> = {
      inbox: 'inbox',
      prs: 'prs',
      activity: 'activity',
      review: 'review',
      o8md: 'spec',
      workspace: 'workspace',
      files: 'files',
      terminal: 'terminal',
      browser: 'browser',
    };
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ surface: string; url?: string }>('o8:ui-command', (event) => {
        const surface = event.payload?.surface ?? '';
        if (surface === 'settings') {
          handleOpenSettingsTab('connectors');
          return;
        }
        if (surface === 'mobile_qr') {
          openMobilePairing();
          return;
        }
        if (surface === 'automations') {
          window.dispatchEvent(new CustomEvent('o8:open-automations'));
          return;
        }
        const tab = O8_TAB_SURFACES[surface];
        if (!tab) return;
        setRightPanelKind('o8');
        openRightPanelFromUser();
        setO8ActiveTab(tab);
        if (surface === 'browser' && event.payload?.url) {
          // Let the pane mount before pushing the URL into it.
          const url = event.payload.url;
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('o8:open-browser', { detail: { url } }));
          }, 250);
        }
      }))
      .then((un) => {
        if (disposed) { un(); return; }
        unlisten = un;
      })
      .catch(() => { /* noop — never let the listener break the dashboard */ });
    return () => {
      disposed = true;
      if (unlisten) { try { unlisten(); } catch { /* noop */ } }
    };
  }, [handleOpenSettingsTab, openMobilePairing, openRightPanelFromUser]);

  // ── Voice P3: ⌘⇧, global shortcut → open the settings overlay ──
  // The Rust global-shortcut handler emits `o8:open-settings` (o8 settings is an
  // overlay in THIS webview, not a separate window, so it can't be opened from
  // Rust directly). Toggling matches the in-app ⌘, binding above. Tauri-only.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('o8:open-settings', () => { toggleSettingsOverlay(); }))
      .then((un) => {
        if (disposed) { un(); return; }
        unlisten = un;
      })
      .catch(() => { /* noop — never let the listener break the dashboard */ });
    return () => {
      disposed = true;
      if (unlisten) { try { unlisten(); } catch { /* noop */ } }
    };
  }, [toggleSettingsOverlay]);

  // ── Voice P4: ⌥S while o8 is frontmost → speak o8's OWN webview selection ──
  // o8's WKWebView doesn't expose its text selection to the native AX/Cmd+C
  // grab, so the Rust ⌥S handler emits `o8:speak-selection` when o8 is the
  // frontmost app; we read `window.getSelection()` here and speak it through the
  // native TTS engine. For other apps the Rust side grabs the selection itself.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('o8:speak-selection', () => {
        const text = window.getSelection()?.toString().trim();
        if (!text) return;
        import('@tauri-apps/api/core')
          .then(({ invoke }) => invoke('tts_speak', { text }))
          .catch(() => { /* noop */ });
      }))
      .then((un) => {
        if (disposed) { un(); return; }
        unlisten = un;
      })
      .catch(() => { /* noop — never let the listener break the dashboard */ });
    return () => {
      disposed = true;
      if (unlisten) { try { unlisten(); } catch { /* noop */ } }
    };
  }, []);

  const showSidebarColumn = sidebarVisible && !compactShell;
  const showRightPanelColumn = chatVisible && !compactShell;
  const workspaceInset = compactShell ? 2 : 4;

  // Same AgentPanel element drives both the in-column mount AND the hover-
  // preview overlay. Only one of the two ever renders at a time (in-column
  // when sidebar is expanded, overlay when collapsed + hovered) so this is
  // a single AgentPanel mount that relocates between trees on transition.
  // Keeps the overlay's content 1:1 with the real panel — no condensed copy.
  const agentPanelElement = (
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
      onCreateWorkspaceOrchestrator={handleCreateWorkspaceOrchestrator}
      onCreateWorkspaceChat={handleCreateWorkspaceChat}
      onCreateWorkspaceTerminal={handleCreateWorkspaceTerminal}
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
      onRepoAdded={handleRepoAddedFromPanel}
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
      registeredRepos={activeProjectRepoEntries}
      ideWorkspaceSessions={ideWorkspaceSessionsForSidebar}
      leftPanelFocus={leftPanelFocus}
    />
  );

  return (
    <DictationHost>
      <AttendanceHeartbeat />
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
          DesktopWebSocketContext; this only adds the chrome surface.
          ConnectionBanner moved out of the workspace top — same state
          now surfaces as ConnectionPill inside AgentPanel above the
          UpdateCard slot (operator pass 2026-05-27). ── */}

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

      {/* Keyboard-shortcuts reference. Opened on ⌘/ or `?`, and from the
          status-bar `?` button. Only mounts the chunk once requested. */}
      {shortcutsOpen ? (
        <Suspense fallback={null}>
          <LazyKeyboardShortcutsOverlay
            open={shortcutsOpen}
            onClose={() => setShortcutsOpen(false)}
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
        const effectiveLeftWidth = leftPanelFocus.active ? (controlRoomWide ? CONTROL_ROOM_WIDTH : FOCUS_LEFT_PANEL_WIDTH) : leftWidth;
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
          // No data-chrome-surface here anymore — the inner card paints a
          // SOLID surface over the vibrancy, so children use the regular
          // palette (dark text in light mode) rather than the chrome-flip
          // (white text on dark vibrancy bleed) overrides.
          style={{
            width: effectiveLeftWidth,
            flexShrink: 0,
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            // Allow the inner card's drop shadow to escape the column box.
            overflow: 'visible',
            position: 'relative',
            // Claude-style floating card. 5px buffer on top/left/right.
            // Bottom stays 0 because the DesktopStatusBar's left section
            // renders directly below as the second half of the SAME
            // visual card (flat-bottom panel + flat-top footer, divider
            // between them) — adding a gap here would break the
            // merged-card design. (The +4px breathing-room bump from
            // 2026-05-27 was reverted same day — it shifted the toggle
            // pill 4px right when sidebar opens, breaking header alignment.)
            paddingTop: 5,
            paddingLeft: 5,
            paddingRight: 5,
            paddingBottom: 0,
          }}
        >
          {/* Floating card — paper over vibrancy. Top corners rounded;
              bottom corners flat so this card merges flush with the
              footer card rendered in DesktopStatusBar (which has flat
              top + rounded bottom). Together they read as one card. */}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              borderTopLeftRadius: 14,
              borderTopRightRadius: 14,
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              // Surface axis branches here:
              //   - solid: --t-panel-solid (the proper opaque cream paper)
              //     so dark-ink text reads on its own surface.
              //   - glass: paint nothing + shadow descendants with light
              //     ink tokens so the panel reads as glass over macOS
              //     vibrancy (matches the right O8Panel approach).
              background: isGlassSurface ? 'transparent' : 'var(--t-panel-solid)',
              boxShadow: isGlassSurface ? 'none' : '0 8px 28px rgba(15, 23, 42, 0.10), 0 2px 6px rgba(15, 23, 42, 0.06)',
              ...(isGlassSurface ? {
                ['--t-text' as string]: '#e8ecf2',
                ['--t-text-strong' as string]: '#f5f8fc',
                ['--t-text-secondary' as string]: '#bcc5d0',
                ['--t-text-muted' as string]: '#8b95a3',
                ['--t-text-faint' as string]: '#5f6b7a',
                ['--t-hover' as string]: 'rgba(255, 255, 255, 0.05)',
                ['--t-input-bg' as string]: 'rgba(255, 255, 255, 0.06)',
                ['--t-divider-subtle' as string]: 'rgba(255, 255, 255, 0.06)',
              } : {}),
            } as React.CSSProperties}
          >
          <LeftHeaderStrip
            sidebarVisible={sidebarVisible}
            onToggleSidebar={toggleSidebarFromChrome}
          />
          <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <GuidedDiscoveryHalo active={showAgentPanelFtux} borderRadius={20} />
          <GuidedDiscoveryCoachmark
            visible={showAgentPanelFtux}
            position="top-left"
            title="Live agent sessions appear here"
            body="When you dispatch work, Cortex expands this rail and keeps the active session card within reach."
          />
          {agentPanelElement}
          </div>
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
          onToggleSidebar={!showSidebarColumn && !compactShell ? toggleSidebarFromChrome : undefined}
          onSidebarHoverEnter={!showSidebarColumn && !compactShell ? openSidebarPreview : undefined}
          onSidebarHoverLeave={!showSidebarColumn && !compactShell ? scheduleSidebarPreviewClose : undefined}
          rightPanelOpen={showRightPanelColumn}
          onToggleRightPanel={compactShell ? undefined : handleToggleO8Panel}
          headerLabel={workspaceHeaderActive.label}
          headerTabs={workspaceHeaderActive.tabs}
          workspaceId={workspaceHeaderActive.workspaceId}
          headerActiveTabId={workspaceHeaderActive.tabId}
          finishedTabCount={workspaceHeaderActive.finishedTabCount}
          splitHeaderWorkspaces={splitHeaderWorkspaces}
          onTitleRenameSubmit={titleMenuActive ? handleTitleRenameSubmit : undefined}
          onTitleArchive={titleMenuActive ? handleTitleArchive : undefined}
          onTitleShare={titleMenuActive ? handleTitleShare : undefined}
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
        {/* The full-page Analytics branch was here when NavSection was
            'analytics'. Audit found that section is never set by any
            code path (NavRail retired, no other setter calls
            setActiveNavSection('analytics')). Analytics still reaches
            the operator through Settings → Analytics tab. Dropped
            2026-05-27. */}

        {activeNavSection === 'automations' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>Loading automations…</div>}>
              <LazyAutomationsPage currentOwner="operator" />
            </Suspense>
          </div>
        )}

        {activeNavSection !== 'automations' && (
          <OrchestratorDataProvider
            agents={parsedAgents}
            missionState={thoughtsMissionState}
            workspaceTargets={orchestratorWorkspaceTargets}
            onMissionStateChange={handleThoughtsMissionStateChange}
            onLaunchPacket={launchOrchestrationPacket}
            draftInjection={thoughtsDraftInjection} imageInjection={thoughtsImageInjection} onImageInjectionConsumed={handleImageInjectionConsumed}
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
            <DashboardHydrationMarker />
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
                onO8TabChange={rightPanelKind === 'o8' ? handleO8TabChange : undefined}
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
                        draftInjection={thoughtsDraftInjection} imageInjection={thoughtsImageInjection} onImageInjectionConsumed={handleImageInjectionConsumed}
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
                          registeredRepos={activeProjectRepoEntries}
                          onRepoPathChange={handleSelectO8RepoPath}
                          allRepos={o8AllRepos}
                          onSelectAllRepos={handleSelectO8AllRepos}
                          previews={workspacePreviews}
                          activeTab={o8ActiveTab}
                          onActiveTabChange={setO8ActiveTab}
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
                        draftInjection={thoughtsDraftInjection} imageInjection={thoughtsImageInjection} onImageInjectionConsumed={handleImageInjectionConsumed}
                        onSelectSession={handleSelectSession}
                        latestDispatchedTabId={latestDispatchedTabId}
                        latestDispatchedAt={latestDispatchedAt}
                        onAcceptDirectiveProposal={handleAcceptDirectiveProposal}
                        selectedPacketId={selectedPacketId}
                        onSelectedPacketChange={setSelectedPacketId}
            onOpenO8Panel={handleOpenO8Panel}
                      >
                        <ReviewPanel repoPath={currentO8RepoPath} selectedFile={scopedO8SelectedFile} />
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

      {/* ── Sidebar hover-preview trigger + drop overlay (collapsed only) ──
          When the AgentPanel column is hidden, we keep a thin invisible hot
          zone along the left edge. Hovering it drops a detail panel from the
          top of the screen — same content shape as the open sidebar, but
          condensed and overlaid (not pushing layout). Click on the workspace
          toggle pill keeps the existing slide-from-left full open. */}
      {!showSidebarColumn && !compactShell && (
        <>
          <AnimatePresence initial={false}>
            {sidebarPreviewOpen && (
              <motion.div
                key="sidebar-hover-preview"
                ref={sidebarPreviewOverlayRef}
                initial={{ y: '-100%', opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: '-100%', opacity: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                onMouseEnter={openSidebarPreview}
                onMouseLeave={scheduleSidebarPreviewClose}
                // Clicking ANYWHERE on the overlay pins it → expands the
                // real sidebar. Without this, the overlay looks like the
                // sidebar but a click on its chrome bounces off (the
                // operator's complaint 2026-05-28 "can't click agent
                // panel to keep it up"). Child rows (New session,
                // Search, chat rows) have their own onClick handlers
                // that fire first; this bubble-phase handler pins the
                // sidebar after so the user keeps their context.
                onClick={openSidebarFromChrome}
                data-mcp-scope="agent-panel-hover-preview"
                style={{
                  position: 'fixed',
                  // Sits just under the toggle pill (pill height 26, sits
                  // at y=7 → bottom=33) with a 2 px breathing gap. The
                  // old top:44 left an 11 px dead zone between pill and
                  // overlay — clicking in that gap fired the window
                  // mousedown listener (closing the preview) but no
                  // onClick handler caught the press, so the operator
                  // had to double-click to pin (2026-05-28). Traffic
                  // lights end around y=30 — y=35 still clears them.
                  top: 35,
                  left: 8,
                  // Match the actual AgentPanel column width so the
                  // overlay is a 1:1 stand-in for the real panel — no
                  // condensed copy. Default 300px (DEFAULT_LEFT_PANEL_WIDTH).
                  width: leftWidth,
                  // Explicit height — without it the overlay sizes to the
                  // AgentPanel's intrinsic content height (which collapses
                  // to ~48 px because AgentPanel's children use flex: 1).
                  // Pin the rail to (viewport − top inset − bottom gutter)
                  // so it matches the open AgentPanel column. top went
                  // 44 → 35 to close the click-gap, so the height grew
                  // proportionally (was 100vh - 90 from the old top).
                  height: 'calc(100vh - 81px)',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  borderRadius: 14,
                  // Surface-aware paint — mirrors the AgentPanel card in
                  // dashboard so the preview reads consistently in both
                  // glass and solid modes. In glass we scope light ink on
                  // the subtree (matches commit 53f13374); in solid we
                  // paint cream paper + keep the dark-ink palette.
                  background: isGlassSurface ? 'rgba(20, 24, 32, 0.78)' : 'var(--t-panel-solid)',
                  backdropFilter: isGlassSurface ? 'blur(18px) saturate(1.15)' : undefined,
                  WebkitBackdropFilter: isGlassSurface ? 'blur(18px) saturate(1.15)' : undefined,
                  boxShadow: '0 18px 48px rgba(15, 23, 42, 0.32), 0 4px 14px rgba(15, 23, 42, 0.16)',
                  border: isGlassSurface
                    ? '1px solid rgba(255, 255, 255, 0.08)'
                    : '1px solid var(--t-divider-subtle)',
                  zIndex: 200,
                  fontFamily: 'var(--font-sans-system)',
                  ...(isGlassSurface ? {
                    ['--t-text' as string]: '#e8ecf2',
                    ['--t-text-strong' as string]: '#f5f8fc',
                    ['--t-text-secondary' as string]: '#bcc5d0',
                    ['--t-text-muted' as string]: '#8b95a3',
                    ['--t-text-faint' as string]: '#5f6b7a',
                    ['--t-hover' as string]: 'rgba(255, 255, 255, 0.06)',
                    ['--t-input-bg' as string]: 'rgba(255, 255, 255, 0.06)',
                    ['--t-divider-subtle' as string]: 'rgba(255, 255, 255, 0.08)',
                  } : {}),
                } as React.CSSProperties}
              >
                {agentPanelElement}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
      </div>{/* end main layout */}

      {/* ── Bottom chrome: transparent status strip with branch + chrome buttons ──
          The pill defaults to the project's HEAD branch. When the active
          orchestrator tab has a worktree pick that targets the same repo,
          the pill mirrors that branch so MergeActionCluster's PR + lane
          state (ready / push / merge) tracks the operator's pick. */}
      <DesktopStatusBar
        branchName={(() => {
          const projectBranch = globalRepoEntry?.readiness?.currentBranch
            ?? globalRepoBranch
            ?? workspaceTerminalPreferredRepo?.branch
            ?? null;
          const sel = orchestratorWorktreeSelection;
          // Only override when the orchestrator's pick targets the same
          // repo as the bottom-status context. Cross-repo picks fall back
          // to the project branch so the pill doesn't surface PRs from a
          // different repo than the chrome buttons point at.
          if (!sel) return projectBranch;
          const projectPath = globalRepoEntry?.localPath ?? workspaceTerminalPreferredRepo?.localPath ?? null;
          if (sel.repoPath && projectPath && sel.repoPath !== projectPath) return projectBranch;
          return sel.branch || projectBranch;
        })()}
        repoName={globalRepoEntry?.name ?? workspaceTerminalPreferredRepo?.name ?? null}
        repoRemoteUrl={globalRepoEntry?.remoteUrl ?? workspaceTerminalPreferredRepo?.remoteUrl ?? null}
        compact={compactShell}
        bottomPanelVisible={bottomPanelVisible}
        onToggleBottomPanel={toggleContextualPanelTile}
        onOpenBottomPanelSurface={handleOpenBottomPanelSurface}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        leftColumnWidth={showSidebarColumn ? (leftPanelFocus.active ? (controlRoomWide ? CONTROL_ROOM_WIDTH : FOCUS_LEFT_PANEL_WIDTH) : leftWidth) : 0}
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
          openRightPanelFromUser();
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
          <LazyOnboarding onComplete={handleSetupComplete} completionError={setupCompleteError} />
        </Suspense>
      )}

    </div>
    </DictationHost>
  );
}
