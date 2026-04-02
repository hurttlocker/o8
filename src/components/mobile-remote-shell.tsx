'use client';
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  type CSSProperties,
} from 'react';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import type { MobileInboxSnapshot, MobileReviewFileResponse, MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  agentDisplayName,
  compactLine,
  renderMessageBody,
} from './mobile/utils';
import dynamic from 'next/dynamic';
import { ChatView } from './mobile/ChatView';
import { ComposeBar } from './mobile/ComposeBar';
import { MOBILE_SESSION_LIST_COLORS, RecentSessionPicker, SessionAgentPill } from './mobile/RecentSessionPicker';
import { TopBar } from './mobile/TopBar';

import { ShimmerCard } from './mobile/ShimmerCard';
import { AlertProvider, useAlerts } from '@/lib/alerts/context';
import { AlertTray } from '@/components/shared/AlertTray';
import { type MobileScreen } from './mobile/SpeedDial';

// Lazy-loaded panels — only loaded when opened (#45)
const shimmerFallback = { loading: () => <ShimmerCard /> };
const ControlsSheet = dynamic(() => import('./mobile/ControlsSheet').then((m) => ({ default: m.ControlsSheet })), { ssr: false, ...shimmerFallback });
const DiffOverlay = dynamic(() => import('./mobile/DiffOverlay').then((m) => ({ default: m.DiffOverlay })), { ssr: false, ...shimmerFallback });
const MobileTerminal = dynamic(() => import('./mobile/MobileTerminal').then((m) => ({ default: m.MobileTerminal })), { ssr: false, ...shimmerFallback });
const WorktreeActions = dynamic(() => import('./mobile/WorktreeActions').then((m) => ({ default: m.WorktreeActions })), { ssr: false, ...shimmerFallback });
const FleetView = dynamic(() => import('./mobile/FleetView').then((m) => ({ default: m.FleetView })), { ssr: false, ...shimmerFallback });
import { PullToRefresh } from './mobile/PullToRefresh';
import { PageTransition } from './mobile/PageTransition';
import { useSwipeBack } from './mobile/useSwipeBack';
import { DARK_COLORS, ThemeProvider } from './mobile/ThemeContext';
const LaunchSheet = dynamic(() => import('./mobile/LaunchSheet').then((m) => ({ default: m.LaunchSheet })), { ssr: false });
const ActivityFeed = dynamic(() => import('./mobile/ActivityFeed').then((m) => ({ default: m.ActivityFeed })), { ssr: false, ...shimmerFallback });
const PRReviewSheet = dynamic(() => import('./mobile/PRReviewSheet').then((m) => ({ default: m.PRReviewSheet })), { ssr: false });
const CostsDashboard = lazy(async () => ({ default: (await import('./mobile/CostsDashboard')).CostsDashboard }));
const SettingsView = lazy(async () => ({ default: (await import('./mobile/SettingsView')).SettingsView }));
const MemoryPage = lazy(() => import('./mobile/MemoryPage'));
const IssuesPage = lazy(() => import('./mobile/IssuesPage'));

const MOBILE_SESSION_LIST_WINDOW_MS = 24 * 60 * 60 * 1000;
const MOBILE_SESSION_LIST_LIMIT = 20;
const MOBILE_INITIAL_INBOX_LIMIT = 15;

// Cortex memory surfaces (#78-#85) — typed via explicit generic param
const RecallPanel = dynamic(() => import('./mobile/RecallPanel'), { ssr: false });
const MemoryHealth = dynamic(() => import('./mobile/MemoryHealth'), { ssr: false });
const GraphExplorer = dynamic(() => import('./mobile/GraphExplorer'), { ssr: false });
const CortexStatus = dynamic(() => import('./mobile/CortexStatus'), { ssr: false });
const SessionPickerSheet = dynamic(() => import('./mobile/SessionPickerSheet').then((m) => ({ default: m.SessionPickerSheet })), { ssr: false });

// Extracted hooks (#43 — hooks extraction)
import { useMobileState } from './mobile/hooks/useMobileState';
import { useMobilePolling } from './mobile/hooks/useMobilePolling';
import { useMobileScroll } from './mobile/hooks/useMobileScroll';
import { useMobileStreaming } from './mobile/hooks/useMobileStreaming';
import { useMobileActions } from './mobile/hooks/useMobileActions';
import {
  mobileShellStyle,
  neomorphicButtonStyle,
} from './mobile/neomorph';

export function MobileRemoteShell(props: MobileRemoteShellProps) {
  return (
    <AlertProvider>
      <MobileRemoteShellInner {...props} />
    </AlertProvider>
  );
}

interface MobileRemoteShellProps {
  initialSnapshot: MobileInboxSnapshot;
  initialTranscript?: { sessionKey: string; transcript: MobileTranscriptEntry[] };
  initialReviewFile?: MobileReviewFileResponse['file'] | null;
  initialOwnedReviewPacket?: RuntimeReviewPacket | null;
}

function buildOptimisticMobileChatSession(args: {
  sessionKey: string;
  tabId: string;
  workspace?: string;
  branch?: string;
}): MobileInboxSnapshot['sessions'][number] {
  return {
    id: args.sessionKey,
    name: 'Chat',
    squadId: 'workspace-chat',
    runtime: 'chat',
    model: 'Workspace Chat',
    primaryModel: 'Workspace Chat',
    status: 'idle',
    currentTask: 'Start a conversation.',
    workspace: args.workspace || '~/clawd',
    branch: args.branch || 'workspace',
    sessionKey: args.sessionKey,
    approvalStatus: 'none',
    lastEventAt: 'just now',
    lastActivityAt: Date.now(),
    context: {
      usedPercent: 0,
      trend: 'stable',
    },
    alerts: 0,
    sessionId: args.tabId,
    surfaceLabel: 'Chat',
    isCurrentSession: true,
    runtimeSurface: {
      id: args.sessionKey,
      runtime: 'chat',
      kind: 'chat-session',
      ownership: 'owned',
      title: 'Chat',
      cwd: args.workspace,
      branch: args.branch || 'workspace',
      sourceLabel: 'Mobile workspace chat',
      capabilities: {
        attach: false,
        readTail: true,
        sendInput: true,
        interrupt: false,
        resize: false,
        diffContext: true,
        reviewContext: true,
      },
    },
  };
}

function sessionListStatus(session: MobileInboxSnapshot['sessions'][number]) {
  if (session.runtimeSurface?.lifecycle?.availability === 'running') {
    return 'running';
  }
  return String(session.status ?? '').trim().toLowerCase();
}

function sessionLastActivityAt(session: MobileInboxSnapshot['sessions'][number]) {
  if (typeof session.lastActivityAt === 'number' && Number.isFinite(session.lastActivityAt)) {
    return session.lastActivityAt;
  }
  const lifecycleTime = session.runtimeSurface?.lifecycle?.lastRunFinishedAt
    ?? session.runtimeSurface?.lifecycle?.lastRunStartedAt
    ?? null;
  if (lifecycleTime) {
    const parsed = new Date(lifecycleTime).getTime();
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function buildVisibleMobileSessionList(sessions: MobileInboxSnapshot['sessions']) {
  const cutoff = Date.now() - MOBILE_SESSION_LIST_WINDOW_MS;
  const activeSessions: MobileInboxSnapshot['sessions'] = [];
  const recentSessions: MobileInboxSnapshot['sessions'] = [];

  for (const session of sessions) {
    const status = sessionListStatus(session);
    const isActive = status === 'running' || status === 'launching';
    if (isActive) {
      activeSessions.push(session);
      continue;
    }
    const lastActivityAt = sessionLastActivityAt(session);
    if (lastActivityAt != null && lastActivityAt >= cutoff) {
      recentSessions.push(session);
    }
  }

  return [...activeSessions, ...recentSessions].slice(0, MOBILE_SESSION_LIST_LIMIT);
}

function MobileRemoteShellInner({
  initialSnapshot,
  initialTranscript,
  initialReviewFile,
  initialOwnedReviewPacket,
}: {
  initialSnapshot: MobileInboxSnapshot;
  initialTranscript?: { sessionKey: string; transcript: MobileTranscriptEntry[] };
  initialReviewFile?: MobileReviewFileResponse['file'] | null;
  initialOwnedReviewPacket?: RuntimeReviewPacket | null;
}) {
  const [detailTabState, setDetailTabState] = useState<{
    sessionId: string | null;
    tab: 'chat' | 'terminal';
  }>({ sessionId: null, tab: 'chat' });
  const pinnedSessionKeyRef = useRef<string | null>(null);
  const pinnedSessionTimeoutRef = useRef<number | null>(null);

  const clearPinnedSession = useCallback((sessionKey?: string | null) => {
    if (sessionKey && pinnedSessionKeyRef.current !== sessionKey) {
      return;
    }
    pinnedSessionKeyRef.current = null;
    if (pinnedSessionTimeoutRef.current !== null) {
      window.clearTimeout(pinnedSessionTimeoutRef.current);
      pinnedSessionTimeoutRef.current = null;
    }
  }, []);

  const pinOptimisticSession = useCallback((sessionKey: string) => {
    clearPinnedSession();
    pinnedSessionKeyRef.current = sessionKey;
    pinnedSessionTimeoutRef.current = window.setTimeout(() => {
      if (pinnedSessionKeyRef.current === sessionKey) {
        clearPinnedSession(sessionKey);
      }
    }, 5000);
  }, [clearPinnedSession]);

  // ── All state lives in useMobileState ──
  const state = useMobileState({ initialSnapshot, initialTranscript, initialReviewFile, initialOwnedReviewPacket });

  // ── Streaming + WebSocket ──
  const {
    wsConnected,
    sendTerminalAttach,
    sendTerminalInput,
  } = useMobileStreaming(state);

  // ── Data fetching + polling ──
  const { refreshInbox, loadHistory, loadOwnedReviewPacket, loadReviewFile, reviewFiles, stickyReviewFiles } = useMobilePolling(state, wsConnected, {
    pinnedSessionKeyRef,
    clearPinnedSession,
  });

  // ── Action handlers ──
  const actions = useMobileActions(state, { wsConnected, refreshInbox, loadHistory, loadOwnedReviewPacket, loadReviewFile, reviewFiles, sendTerminalAttach, sendTerminalInput });

  // ── Alert engine: feed agent data on each snapshot update ──
  const { updateAgents, alerts: activeAlerts, markRead: alertMarkRead, markAllRead: alertMarkAllRead, dismiss: alertDismiss, dismissAll: alertDismissAll } = useAlerts();
  useEffect(() => {
    if (state.snapshot.sessions.length > 0) {
      updateAgents(state.snapshot.sessions);
    }
  }, [state.snapshot, updateAgents]);

  useEffect(() => {
    if (state.snapshot.mode === 'live' && state.snapshot.sessions.length > 0) return;
    let active = true;

    async function refreshSoon() {
      try {
        await refreshInbox(true, MOBILE_INITIAL_INBOX_LIMIT);
      } catch {
        // Shell-first bootstrap should stay honest and retry later.
      }
    }

    void refreshSoon();
    const timer = window.setTimeout(() => {
      if (active) void refreshSoon();
    }, 2500);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [refreshInbox, state.snapshot.mode, state.snapshot.sessions.length]);

  // ── Derived transcript data ──
  const {
    snapshot, selectedSession, selectedSessionKey,
    isOwnedCodexSession, isChatSession,
    selectedReviewPacket, selectedReviewPacketError,
    historyBySession, historyGroupsBySession, historyLoading,
    historyError,
    selectedReviewFilePath, reviewFileByPath, reviewFileLoadingPath, reviewFileError,
    diffOpen,
    draftBySession, actionStateBySession, actionNoteBySession,
    draftAttachmentsBySession, pendingOwnedTurnBySession,
    enhancing, preEnhanceDraft,
    controlsOpen, alertsOpen, sessionPickerOpen,
    pendingApprovals,
    surfaceRefreshing, expandedMedia, scrollY,
    isScrolling, headerVisible, viewportTopOffset,
    composeFocused, composeHeight, waitingForResponse, hydrated,
    streamingText,
    // Setters
    setSelection, setActiveView, setSurfaceNote,
    setDraftBySession, setPendingOwnedTurnBySession,
    setControlsOpen, setAlertsOpen, setSessionPickerOpen,
    setPendingApprovals, setResolvedApprovals,
    setExpandedMedia, setComposeHeight, setWaitingForResponse,
    setDiffOpen, setSnapshot,
    // Refs
    composeRef, fileInputRef, transcriptBottomRef,
    seenMessageIdsRef,
    refreshError, surfaceNote,
    activeView,
    // Cortex memory
    cortexRecallOpen, setCortexRecallOpen,
    cortexHealthOpen, setCortexHealthOpen,
    cortexGraphOpen, setCortexGraphOpen,
  } = state;

  const [launchOpen, setLaunchOpen] = useState(false);
  const [prReviewOpen, setPrReviewOpen] = useState(false);
  const [prReviewNumber, setPrReviewNumber] = useState<number | null>(null);
  const [prReviewRepo, setPrReviewRepo] = useState('');

  useEffect(() => () => {
    clearPinnedSession();
  }, [clearPinnedSession]);

  useEffect(() => {
    setPendingApprovals(snapshot.approvals ?? []);
    setResolvedApprovals((current) => {
      const activeIds = new Set((snapshot.approvals ?? []).map((approval) => approval.id));
      const next = Object.fromEntries(
        Object.entries(current).filter(([approvalId]) => activeIds.has(approvalId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [setPendingApprovals, setResolvedApprovals, snapshot.approvals]);

  // ── Swipe right from left edge to go back to chat ──
  useSwipeBack(
    () => { if (activeView !== 'squad' && activeView !== 'chat') setActiveView('squad'); },
    activeView !== 'squad' && activeView !== 'chat',
  );

  // Lock body scroll when diff overlay is open
  useEffect(() => {
    if (!diffOpen) return;
    const scrollPos = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollPos}px`;
    document.body.style.width = '100%';
    return () => {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, scrollPos);
    };
  }, [diffOpen]);

  const transcriptEntries = selectedSessionKey ? historyBySession[selectedSessionKey] ?? [] : [];
  const transcriptGroups = selectedSessionKey ? historyGroupsBySession[selectedSessionKey] ?? [] : [];
  const transcriptLoading = selectedSessionKey ? historyLoading[selectedSessionKey] ?? false : false;
  const transcriptError = selectedSessionKey ? historyError[selectedSessionKey] ?? null : null;
  const transcriptDraft = selectedSessionKey ? draftBySession[selectedSessionKey] ?? '' : '';
  const transcriptAttachments = selectedSessionKey ? draftAttachmentsBySession[selectedSessionKey] ?? [] : [];
  const pendingOwnedTurn = selectedSessionKey ? pendingOwnedTurnBySession[selectedSessionKey] ?? null : null;
  const transcriptActionState = selectedSessionKey ? actionStateBySession[selectedSessionKey] ?? 'idle' : 'idle';
  const transcriptActionNote = selectedSessionKey ? actionNoteBySession[selectedSessionKey] ?? null : null;
  const selectedReviewFile = selectedReviewFilePath ? reviewFileByPath[selectedReviewFilePath] : undefined;

  const latestTranscriptMarker = transcriptEntries[transcriptEntries.length - 1]?.id ?? 'empty';
  const scrollMarker = pendingOwnedTurn ? `${latestTranscriptMarker}:${pendingOwnedTurn.id}` : latestTranscriptMarker;

  // ── Scroll management ──
  const { scrollToLatestMessage } = useMobileScroll(state, transcriptEntries, transcriptGroups, pendingOwnedTurn, scrollMarker);

  // ── Owned Codex turn lifecycle ──
  useEffect(() => {
    if (!selectedSessionKey?.startsWith('codex-owned:')) return;
    const pendingTurn = pendingOwnedTurnBySession[selectedSessionKey];
    if (!pendingTurn) return;
    const sessionGroups = historyGroupsBySession[selectedSessionKey] ?? [];
    const matchingGroup = sessionGroups.find((group) => {
      const promptMatches = group.prompt.trim() === pendingTurn.prompt.trim();
      const startedAt = group.startedAt ? new Date(group.startedAt).getTime() : 0;
      return promptMatches || (startedAt > 0 && startedAt >= pendingTurn.createdAt - 1000);
    });
    const runSettledAgain = Boolean(
      selectedSession?.runtimeSurface?.capabilities.sendInput
      && !selectedSession?.runtimeSurface?.capabilities.interrupt
      && transcriptActionState === 'idle',
    );
    if (!matchingGroup && !runSettledAgain) return;
    setPendingOwnedTurnBySession((current) => {
      if (!current[selectedSessionKey]) return current;
      const next = { ...current };
      delete next[selectedSessionKey];
      return next;
    });
  }, [historyGroupsBySession, pendingOwnedTurnBySession, selectedSession?.runtimeSurface?.capabilities.interrupt, selectedSession?.runtimeSurface?.capabilities.sendInput, selectedSessionKey, transcriptActionState, setPendingOwnedTurnBySession]);

  // ── UI layout values ──
  const sessionListSessions = useMemo(
    () => buildVisibleMobileSessionList(snapshot.sessions),
    [snapshot.sessions],
  );
  const sessionSwitcher = snapshot.sessions.slice(0, 5);
  const isComposerPrimed = isChatSession && (composeFocused || transcriptAttachments.length > 0);
  const ownedAvailability = selectedSession?.runtimeSurface?.lifecycle?.availability;
  const ownedReviewDisposition = selectedReviewPacket?.reviewDisposition;
  const ownedQueuedTurn = Boolean(pendingOwnedTurn) || transcriptActionState === 'steering';
  const canResumeOwnedCodex = Boolean(isOwnedCodexSession && selectedSession?.runtimeSurface?.capabilities.sendInput && !ownedQueuedTurn);
  const canInterruptOwnedCodex = Boolean(isOwnedCodexSession && selectedSession?.runtimeSurface?.capabilities.interrupt);
  const hasTerminalSession = Boolean(selectedSession?.tmuxSession);
  const isIndexView = activeView === 'squad';
  const isThreadView = activeView === 'chat';
  const showRecentPicker = isIndexView || (isThreadView && !selectedSession);
  const isSessionListSurface = showRecentPicker || activeView === 'fleet';
  const showThreadSurface = isThreadView && Boolean(selectedSession);
  const returnToHome = () => setActiveView('squad');
  const detailTab = detailTabState.sessionId === selectedSession?.id
    ? detailTabState.tab
    : 'chat';
  const terminalActive = hasTerminalSession && detailTab === 'terminal';
  const recentSessions = sessionListSessions;
  const linkedWorktree = selectedReviewPacket?.worktree;
  const showWorktreeActions = Boolean(
    isOwnedCodexSession
    && linkedWorktree
    && linkedWorktree.dirtyFiles.length > 0
    && selectedSession?.runtimeSurface?.lifecycle?.availability === 'ready-for-resume',
  );
  const worktreeRepoRoot = selectedReviewPacket?.repoPath
    ? selectedReviewPacket.repoPath.replace(
        /^~(?=\/|$)/,
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- repo paths arrive shortened with `~`, and this client-side expansion already exists in the mobile worktree flow.
        require('os').homedir(),
      )
    : null;
  const mobileWorktree = linkedWorktree ? {
    id: linkedWorktree.id,
    path: linkedWorktree.path,
    branch: linkedWorktree.branch,
    baseBranch: linkedWorktree.baseBranch,
    agentType: 'codex' as const,
    status: linkedWorktree.status as import('@/lib/worktree/types').WorktreeStatus,
    createdAt: 0,
    lastActivityAt: 0,
    dirtyFiles: linkedWorktree.dirtyFiles,
    claudeManaged: false,
  } : null;

  async function handleCreateNewChat() {
    try {
      const response = await fetch('/api/mobile/chat', {
        method: 'POST',
      });
      const payload = await response.json().catch(() => null) as { sessionKey?: string; tabId?: string; error?: string } | null;
      if (!response.ok || !payload?.sessionKey || !payload?.tabId) {
        throw new Error(payload?.error || 'Unable to create a new mobile chat.');
      }

      setActiveView('chat');

      const optimisticSession = buildOptimisticMobileChatSession({
        sessionKey: payload.sessionKey,
        tabId: payload.tabId,
        workspace: selectedSession?.workspace || snapshot.sessions[0]?.workspace,
        branch: selectedSession?.branch || snapshot.sessions[0]?.branch || 'workspace',
      });

      setSnapshot((current) => ({
        ...current,
        primarySessionKey: payload.sessionKey,
        sessions: [
          optimisticSession,
          ...current.sessions
            .filter((session) => session.sessionKey !== payload.sessionKey)
            .map((session) => (session.isCurrentSession ? { ...session, isCurrentSession: false } : session)),
        ],
      }));
      pinOptimisticSession(payload.sessionKey);
      state.setHistoryBySession((current) => ({
        ...current,
        [payload.sessionKey!]: current[payload.sessionKey!] ?? [],
      }));
      setSelection({
        id: optimisticSession.id,
        sessionKey: payload.sessionKey,
        fallback: optimisticSession,
      });
      setWaitingForResponse(false);
      setSurfaceNote('New mobile chat ready.');

      void loadHistory(payload.sessionKey, true).catch(() => undefined);
      void refreshInbox(true).catch(() => undefined);
    } catch (error) {
      setSurfaceNote(error instanceof Error ? error.message : 'Unable to create a new mobile chat.');
    }
  }

  // Track compose bar height via ResizeObserver for dynamic pill positioning
  const bottomDockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bottomDockRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setComposeHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [setComposeHeight]);

  const pageStyle: CSSProperties = {
    ...mobileShellStyle,
    minHeight: '100vh',
    padding: '0 0 34px',
    backgroundColor: DARK_COLORS.bg,
    backgroundImage: isSessionListSurface
      ? 'none'
      : [
          'radial-gradient(circle at top, rgba(10, 132, 255, 0.12), transparent 42%)',
          'linear-gradient(180deg, #0A0A0A 0%, #0F0D0C 56%, #151210 100%)',
        ].join(', '),
    color: DARK_COLORS.text,
  };
  const phoneShellStyle: CSSProperties = {
    position: 'relative',
    maxWidth: 720,
    minHeight: '100vh',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingTop: `calc(env(safe-area-inset-top, 0px) + ${viewportTopOffset}px + 74px)`,
    paddingBottom: 18,
    WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 5rem, black 100%)',
    maskImage: 'linear-gradient(to bottom, transparent, black 5rem, black 100%)',
  } as CSSProperties;
  const scrollViewStyle: CSSProperties = {
    display: 'grid',
    gap: 0,
    paddingTop: 0,
    paddingRight: isSessionListSurface ? 0 : 18,
    paddingBottom: showRecentPicker
      ? 'calc(env(safe-area-inset-bottom, 0px) + 96px)'
      : activeView === 'fleet'
        ? 'calc(env(safe-area-inset-bottom, 0px) + 24px)'
        : `calc(${composeHeight}px + env(safe-area-inset-bottom, 0px) + 42px)`,
    paddingLeft: isSessionListSurface ? 0 : 18,
    background: 'transparent',
  };
  const noteStyle: CSSProperties = {
    margin: '0 0 14px',
    padding: '12px 15px',
    borderRadius: 14,
    border: `1px solid ${DARK_COLORS.surfaceBorder}`,
    background: DARK_COLORS.surface,
    color: DARK_COLORS.textSecondary,
    fontSize: '0.88rem',
    lineHeight: 1.45,
    boxShadow: '0 12px 24px rgba(0,0,0,0.18)',
  };
  const scrollAnchorStyle: CSSProperties = {
    height: 1,
    scrollMarginBottom: `calc(${composeHeight}px + 108px)`,
  };
  // Bottom fade removed — scroll fade handled by mask-image on scroll container
  const fabWrapStyle: CSSProperties = {
    position: 'fixed',
    left: '50%',
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)',
    width: 'min(calc(100dvw - 32px), 390px)',
    transform: 'translateX(-50%)',
    display: 'flex',
    justifyContent: 'flex-end',
    pointerEvents: 'none',
    zIndex: 92,
  };
  const fabButtonStyle: CSSProperties = {
    width: 56,
    height: 56,
    minWidth: 56,
    minHeight: 56,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    border: `1px solid ${DARK_COLORS.surfaceBorder}`,
    background: 'rgba(46,42,38,0.18)',
    color: MOBILE_SESSION_LIST_COLORS.primary,
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    boxShadow: '0 18px 36px rgba(0,0,0,0.28)',
    cursor: 'pointer',
    pointerEvents: 'auto',
    WebkitTapHighlightColor: 'transparent',
  };
  const bottomDockStyle: CSSProperties = {
    position: 'fixed',
    left: '50%',
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)',
    zIndex: 92,
    width: 'min(calc(100dvw - 24px), 394px)',
    display: 'grid',
    gap: '0.34rem',
    padding: '0',
    opacity: isScrolling && !isComposerPrimed ? 0 : 1,
    transform: isScrolling && !isComposerPrimed ? 'translate(-50%, 18px)' : 'translate(-50%, 0)',
    transition: 'opacity 180ms ease, transform 180ms ease',
    pointerEvents: isScrolling && !isComposerPrimed ? 'none' : 'auto',
    background: 'transparent',
  };
  const composeShellStyle: CSSProperties = {
    position: 'relative',
    display: 'grid',
    gap: '0.42rem',
    padding: 0,
    background: 'transparent',
  };

  // ── Render ──
  return (
    <ThemeProvider>
    <div
      style={pageStyle}
    >
      <div style={phoneShellStyle}>
        <TopBar
          selectedSession={selectedSession}
          headerVisible={headerVisible}
          pendingApprovalsCount={pendingApprovals.length}
          activeView={activeView}
          compactLine={compactLine}
          activeScreen={activeView === 'costs' ? 'costs' : activeView === 'fleet' ? 'fleet' : activeView === 'activity' ? 'approvals' : activeView === 'settings' ? 'settings' : activeView === 'memory' ? 'memory' : activeView === 'issues' ? 'issues' : 'chat'}
          onNavigate={(screen: MobileScreen) => {
            switch (screen) {
              case 'chat':
                returnToHome();
                break;
              case 'fleet':
                setActiveView('fleet');
                break;
              case 'memory':
                setActiveView('memory');
                break;
              case 'issues':
                setActiveView('issues');
                break;
              case 'approvals':
                setActiveView('activity');
                break;
              case 'costs':
                setActiveView('costs');
                break;
              case 'settings':
                setActiveView('settings');
                break;
            }
          }}
          onNewChat={handleCreateNewChat}
          onOpenControls={() => setControlsOpen(true)}
        />
        <PullToRefresh onRefresh={async () => { await refreshInbox(true); await new Promise(r => setTimeout(r, 600)); }}>
        <PageTransition activeKey={activeView}>
        <div style={scrollViewStyle}>
          {activeView === 'fleet' ? (
            <FleetView
              sessions={sessionListSessions}
              onAgentSelect={actions.handleSessionFocus}
              onBack={returnToHome}
              onLaunch={() => setLaunchOpen(true)}
            />
          ) : null}
          {activeView === 'settings' ? (
            <Suspense fallback={null}>
              <SettingsView onBack={returnToHome} />
            </Suspense>
          ) : null}
          {activeView === 'memory' ? (
            <Suspense fallback={null}>
              <MemoryPage
                onBack={returnToHome}
                onInjectText={(text: string) => {
                  if (!selectedSessionKey) return;
                  setDraftBySession((prev) => ({
                    ...prev,
                    [selectedSessionKey]: (prev[selectedSessionKey] ?? '') + (prev[selectedSessionKey] ? '\n' : '') + text,
                  }));
                  setActiveView('chat');
                }}
              />
            </Suspense>
          ) : null}
          {activeView === 'issues' ? (
            <Suspense fallback={null}>
              <IssuesPage
                onBack={returnToHome}
                onOpenPR={(repo, prNumber) => {
                  setPrReviewRepo(repo);
                  setPrReviewNumber(prNumber);
                  setPrReviewOpen(true);
                }}
              />
            </Suspense>
          ) : null}
          {activeView === 'activity' ? (
            <ActivityFeed
              snapshot={snapshot}
              onBack={returnToHome}
              onAgentSelect={(sessionKey) => {
                actions.handleSessionFocus(sessionKey);
              }}
              onApprove={(item) => {
                if (item.sessionKey && item.approvalId) {
                  actions.runAction({ action: 'approve', sessionKey: item.sessionKey, approvalId: item.approvalId });
                }
              }}
              onDeny={(item) => {
                if (item.sessionKey && item.approvalId) {
                  actions.runAction({ action: 'deny', sessionKey: item.sessionKey, approvalId: item.approvalId });
                }
              }}
              onReviewPR={(repoPath, prNumber) => {
                setPrReviewRepo(repoPath);
                setPrReviewNumber(prNumber);
                setPrReviewOpen(true);
              }}
            />
          ) : null}
          {activeView === 'costs' ? (
            <Suspense fallback={null}>
              <CostsDashboard
                snapshot={snapshot}
                onBack={returnToHome}
                onSessionSelect={actions.handleSessionFocus}
                compactLine={compactLine}
              />
            </Suspense>
          ) : null}
          {showRecentPicker ? (
            <RecentSessionPicker
              sessions={recentSessions}
              compactLine={compactLine}
              agentDisplayName={agentDisplayName}
              onSessionSelect={actions.handleSessionFocus}
              onNewChat={handleCreateNewChat}
              onLaunch={() => setLaunchOpen(true)}
            />
          ) : null}
          {hasTerminalSession && showThreadSurface ? (
            <div
              style={{
                display: 'flex',
                gap: 8,
                paddingTop: 8,
                paddingRight: 14,
                paddingBottom: 0,
                paddingLeft: 14,
              }}
            >
              <button
                type="button"
                onClick={() => setDetailTabState({ sessionId: selectedSession?.id ?? null, tab: 'terminal' })}
                style={{
                  ...neomorphicButtonStyle(detailTab === 'terminal' ? 'red' : 'slate', detailTab === 'terminal'),
                  flex: 1,
                  minHeight: 44,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  letterSpacing: '-0.01em',
                }}
              >
                Terminal
              </button>
              <button
                type="button"
                onClick={() => setDetailTabState({ sessionId: selectedSession?.id ?? null, tab: 'chat' })}
                style={{
                  ...neomorphicButtonStyle(detailTab === 'chat' ? 'blue' : 'slate', detailTab === 'chat'),
                  flex: 1,
                  minHeight: 44,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  letterSpacing: '-0.01em',
                }}
              >
                Chat
              </button>
            </div>
          ) : null}
          {showThreadSurface ? (
          terminalActive ? (
            <MobileTerminal tmuxSession={selectedSession!.tmuxSession!} />
          ) : (
            <>
              {[refreshError, surfaceNote, transcriptError, selectedReviewPacketError]
                .filter(Boolean)
                .slice(0, 2)
                .map((note, index) => (
                  <p key={`${note}-${index}`} style={noteStyle}>{note}</p>
                ))}
              <SessionAgentPill
                session={selectedSession!}
                compactLine={compactLine}
                agentDisplayName={agentDisplayName}
                onClick={() => setSessionPickerOpen(true)}
              />
              <ChatView
                transcriptEntries={transcriptEntries}
                selectedSession={selectedSession}
                isOwnedCodexSession={isOwnedCodexSession}
                transcriptLoading={transcriptLoading}
                isRefreshing={surfaceRefreshing}
                composeHeight={composeHeight}
                selectedReviewFile={selectedReviewFile}
                streamingText={streamingText}
                waitingForResponse={waitingForResponse}
                hydrated={hydrated}
                seenMessageIdsRef={seenMessageIdsRef}
                agentDisplayName={agentDisplayName}
                renderMessageBody={renderMessageBody}
                expandedMedia={expandedMedia}
                setExpandedMedia={setExpandedMedia}
                onOpenDiff={actions.openDiffViewer}
                onScrollToLatestMessage={scrollToLatestMessage}
                actionState={transcriptActionState}
                onLoadMore={selectedSessionKey ? async () => {
                  const { loadMoreHistory } = await import('./mobile/controller-sync');
                  return loadMoreHistory({
                    sessionKey: selectedSessionKey,
                    historyBySession: state.historyBySession,
                    setHistoryLoading: state.setHistoryLoading,
                    setHistoryBySession: state.setHistoryBySession,
                  });
                } : undefined}
              />
              {showWorktreeActions && mobileWorktree && worktreeRepoRoot ? (
                <div style={{ padding: '0 14px', marginTop: 12 }}>
                  <WorktreeActions
                    worktree={mobileWorktree}
                    repoRoot={worktreeRepoRoot}
                    onResult={(result) => {
                      setSurfaceNote(result.note);
                      void refreshInbox();
                      if (selectedSessionKey) {
                        void loadOwnedReviewPacket(selectedSessionKey, true);
                      }
                    }}
                  />
                </div>
              ) : null}
            </>
          )
          ) : null}
          <div ref={transcriptBottomRef} style={scrollAnchorStyle} aria-hidden="true" />
        </div>
        </PageTransition>
        </PullToRefresh>
        {showRecentPicker ? (
          <>
          <div style={fabWrapStyle}>
            <button
              type="button"
              aria-label="New chat"
              onClick={handleCreateNewChat}
              style={fabButtonStyle}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
          </div>
          </>
        ) : null}
        <div ref={bottomDockRef} style={bottomDockStyle}>
          {!terminalActive && showThreadSurface ? (
            <div style={composeShellStyle}>
              <ComposeBar
                session={selectedSession}
                sessionKey={selectedSessionKey}
                draft={transcriptDraft}
                attachments={transcriptAttachments}
                actionState={transcriptActionState}
                enhancing={enhancing}
                preEnhanceDraft={preEnhanceDraft}
                isChatSession={isChatSession}
                canResumeOwnedCodex={canResumeOwnedCodex}
                canInterruptOwnedCodex={canInterruptOwnedCodex}
                selectedReviewPacket={selectedReviewPacket}
                reviewFiles={reviewFiles}
                ownedAvailability={ownedAvailability}
                ownedReviewDisposition={ownedReviewDisposition}
                ownedQueuedTurn={ownedQueuedTurn}
                surfaceRefreshing={surfaceRefreshing}
                actionNote={transcriptActionNote}
                compactLine={compactLine}
                agentDisplayName={agentDisplayName}
                composeRef={composeRef}
                fileInputRef={fileInputRef}
                handlers={actions.composeBarHandlers}
                onOpenRecall={() => setCortexRecallOpen(true)}
                onModelPillTap={() => setSessionPickerOpen(true)}
                streamingText={streamingText}
                agentRunning={waitingForResponse}
              />
            </div>
          ) : null}
        </div>
      </div>
      <ControlsSheet
        controlsOpen={controlsOpen}
        selectedSession={selectedSession}
        selectedSessionKey={selectedSessionKey}
        pendingApprovals={pendingApprovals}
        sessionSwitcher={sessionSwitcher}
        reviewFiles={reviewFiles}
        surfaceRefreshing={surfaceRefreshing}
        isChatSession={isChatSession}
        isOwnedCodexSession={isOwnedCodexSession}
        canInterruptOwnedCodex={canInterruptOwnedCodex}
        compactLine={compactLine}
        onClose={() => setControlsOpen(false)}
        onRefresh={actions.handleControlsRefresh}
        onOpenDiff={actions.openDiffViewer}
        onToggleApprovals={actions.handleToggleApprovals}
        onCopyKey={actions.handleCopySelectedSessionKey}
        onAbort={actions.handleStopActiveRun}
        onSessionFocus={actions.handleSessionFocus}
        onSearchSelectSession={(sessionKey) => actions.handleSessionFocus(sessionKey)}
        onSearchSelectIssue={() => { /* issue viewing not wired on mobile yet */ }}
      >
        <CortexStatus
          onRecallOpen={() => { setControlsOpen(false); setCortexRecallOpen(true); }}
          onMemoryHealthOpen={() => { setControlsOpen(false); setCortexHealthOpen(true); }}
          onGraphOpen={() => { setControlsOpen(false); setCortexGraphOpen(true); }}
        />
      </ControlsSheet>
      <DiffOverlay
        diffOpen={diffOpen}
        selectedFile={selectedReviewFile}
        selectedReviewFilePath={selectedReviewFilePath}
        reviewFiles={reviewFiles}
        reviewFileByPath={reviewFileByPath}
        stickyReviewFiles={stickyReviewFiles}
        reviewFileError={reviewFileError}
        reviewFileLoadingPath={reviewFileLoadingPath}
        compactLine={compactLine}
        onClose={() => setDiffOpen(false)}
        onFileSelect={actions.handleReviewFileFocus}
        onLoadFile={loadReviewFile}
        onRefresh={actions.handleDiffRefresh}
      />
      {/* Cortex Memory Surfaces */}
      <RecallPanel
        currentTask={selectedSession?.currentTask ?? selectedSession?.name}
        cwd={selectedSession?.runtimeSurface?.cwd}
        branch={selectedSession?.runtimeSurface?.branch}
        visible={cortexRecallOpen}
        onClose={() => setCortexRecallOpen(false)}
        onInjectText={(text: string) => {
          if (!selectedSessionKey) return;
          setDraftBySession((prev) => ({
            ...prev,
            [selectedSessionKey]: (prev[selectedSessionKey] ?? '') + (prev[selectedSessionKey] ? '\n' : '') + text,
          }));
          setCortexRecallOpen(false);
        }}
      />
      <MemoryHealth
        visible={cortexHealthOpen}
        onClose={() => setCortexHealthOpen(false)}
      />
      <GraphExplorer
        visible={cortexGraphOpen}
        onClose={() => setCortexGraphOpen(false)}
        initialSubject={selectedSession?.currentTask?.slice(0, 60)}
      />
      <AlertTray
        alerts={activeAlerts}
        open={alertsOpen}
        onClose={() => setAlertsOpen(false)}
        onMarkRead={alertMarkRead}
        onMarkAllRead={alertMarkAllRead}
        onDismiss={alertDismiss}
        onDismissAll={alertDismissAll}
        onAction={(alert) => {
          if (alert.sessionKey) {
            actions.handleSessionFocus(alert.sessionKey);
          }
          setAlertsOpen(false);
        }}
        variant="mobile"
      />
      <SessionPickerSheet
        open={sessionPickerOpen}
        sessions={snapshot.sessions}
        selectedSessionKey={selectedSessionKey}
        onClose={() => setSessionPickerOpen(false)}
        onSelectSession={(sessionKey) => {
          setSessionPickerOpen(false);
          actions.handleSessionFocus(sessionKey);
          setActiveView('chat');
        }}
      />
      {/* SpeedDial now lives in TopBar — no more FAB */}
      <PRReviewSheet
        open={prReviewOpen}
        repoPath={prReviewRepo}
        prNumber={prReviewNumber}
        onClose={() => setPrReviewOpen(false)}
        onViewDiff={() => {
          setPrReviewOpen(false);
          actions.openDiffViewer();
        }}
      />
      <LaunchSheet
        open={launchOpen}
        onClose={() => setLaunchOpen(false)}
        onLaunched={(surfaceId) => {
          setLaunchOpen(false);
          refreshInbox();
          if (surfaceId) {
            setTimeout(() => {
              actions.handleSessionFocus(surfaceId);
            }, 500);
          }
        }}
      />
    </div>
    </ThemeProvider>
  );
}
