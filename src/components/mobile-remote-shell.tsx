'use client';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import type { MobileInboxSnapshot, MobileReviewFileResponse, MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  agentDisplayName,
  compactLine,
  pickCurrentSession,
  renderMessageBody,
} from './mobile/utils';
import dynamic from 'next/dynamic';
import { ChatView } from './mobile/ChatView';
import { ComposeBar } from './mobile/ComposeBar';
import { RuntimeBar } from './mobile/RuntimeBar';
import { SquadRail } from './mobile/SquadRail';
import { SurfaceStatus } from './mobile/SurfaceStatus';
import { TopBar } from './mobile/TopBar';

import { ShimmerCard } from './mobile/ShimmerCard';
import { AlertProvider, useAlerts } from '@/lib/alerts/context';
import { AlertTray } from '@/components/shared/AlertTray';
import { type MobileScreen } from './mobile/SpeedDial';

// Lazy-loaded panels — only loaded when opened (#45)
const shimmerFallback = { loading: () => <ShimmerCard /> };
const ApprovalStack = dynamic(() => import('./mobile/ApprovalStack').then((m) => ({ default: m.ApprovalStack })), { ssr: false, ...shimmerFallback });
const ControlsSheet = dynamic(() => import('./mobile/ControlsSheet').then((m) => ({ default: m.ControlsSheet })), { ssr: false, ...shimmerFallback });
const CostsDashboard = dynamic(() => import('./mobile/CostsDashboard').then((m) => ({ default: m.CostsDashboard })), { ssr: false, ...shimmerFallback });
const DiffOverlay = dynamic(() => import('./mobile/DiffOverlay').then((m) => ({ default: m.DiffOverlay })), { ssr: false, ...shimmerFallback });
const TokenUsageSummary = dynamic(() => import('./mobile/TokenUsageSummary').then((m) => ({ default: m.TokenUsageSummary })), { ssr: false, ...shimmerFallback });
const MobileTerminal = dynamic(() => import('./mobile/MobileTerminal').then((m) => ({ default: m.MobileTerminal })), { ssr: false, ...shimmerFallback });
const WorktreeActions = dynamic(() => import('./mobile/WorktreeActions').then((m) => ({ default: m.WorktreeActions })), { ssr: false, ...shimmerFallback });
const FleetView = dynamic(() => import('./mobile/FleetView').then((m) => ({ default: m.FleetView })), { ssr: false, ...shimmerFallback });
const LaunchSheet = dynamic(() => import('./mobile/LaunchSheet').then((m) => ({ default: m.LaunchSheet })), { ssr: false });
const ActivityFeed = dynamic(() => import('./mobile/ActivityFeed').then((m) => ({ default: m.ActivityFeed })), { ssr: false, ...shimmerFallback });
const PRReviewSheet = dynamic(() => import('./mobile/PRReviewSheet').then((m) => ({ default: m.PRReviewSheet })), { ssr: false });
const SettingsView = dynamic(() => import('./mobile/SettingsView').then((m) => ({ default: m.SettingsView })), { ssr: false, ...shimmerFallback });

// Cortex memory surfaces (#78-#85) — typed via explicit generic param
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RecallPanel = dynamic(() => import('./mobile/RecallPanel'), { ssr: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MemoryHealth = dynamic(() => import('./mobile/MemoryHealth'), { ssr: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// MemoryContext removed — recall trigger moved to ComposeBar action row
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GraphExplorer = dynamic(() => import('./mobile/GraphExplorer'), { ssr: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CortexStatus = dynamic(() => import('./mobile/CortexStatus'), { ssr: false });
const SessionInfoSheet = dynamic(() => import('./mobile/SessionInfoSheet').then((m) => ({ default: m.SessionInfoSheet })), { ssr: false });

// Extracted hooks (#43 — hooks extraction)
import { useMobileState } from './mobile/hooks/useMobileState';
import { useMobilePolling } from './mobile/hooks/useMobilePolling';
import { useMobileScroll } from './mobile/hooks/useMobileScroll';
import { useMobileStreaming } from './mobile/hooks/useMobileStreaming';
import { useMobileActions } from './mobile/hooks/useMobileActions';
import { NotificationBanner, useNotifications } from './mobile/NotificationBanner';

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

function formatSessionAge(lastEventAt: string): string {
  const diff = Date.now() - new Date(lastEventAt).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d`;
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

  // ── All state lives in useMobileState ──
  const state = useMobileState({ initialSnapshot, initialTranscript, initialReviewFile, initialOwnedReviewPacket });

  // ── Streaming + WebSocket ──
  const { wsConnected, wsConnectionState, sendTerminalAttach, sendTerminalInput } = useMobileStreaming(state);

  // ── Data fetching + polling ──
  const { refreshInbox, loadHistory, loadOwnedReviewPacket, loadReviewFile, reviewFiles, linkedOwnedKey } = useMobilePolling(state, wsConnected);

  // ── Action handlers ──
  const actions = useMobileActions(state, { refreshInbox, loadHistory, loadOwnedReviewPacket, loadReviewFile, reviewFiles, sendTerminalAttach, sendTerminalInput });

  // ── Alert engine: feed agent data on each snapshot update ──
  const { updateAgents, alerts: activeAlerts, markRead: alertMarkRead, markAllRead: alertMarkAllRead, dismiss: alertDismiss, dismissAll: alertDismissAll } = useAlerts();
  useEffect(() => {
    if (state.snapshot.sessions.length > 0) {
      updateAgents(state.snapshot.sessions);
    }
  }, [state.snapshot, updateAgents]);

  // ── Derived transcript data ──
  const {
    snapshot, selectedSession, selectedSessionKey,
    isOwnedCodexSession, isChatSession,
    selectedReviewPacket, selectedReviewPacketError,
    historyBySession, historyGroupsBySession, historyLoading,
    historyError, reviewPacketBySession, reviewPacketLoadingBySession,
    selectedReviewFilePath, reviewFileByPath, reviewFileLoadingPath, reviewFileError,
    diffOpen, stickyReviewFilesRef,
    draftBySession, actionStateBySession, actionNoteBySession,
    draftAttachmentsBySession, pendingOwnedTurnBySession,
    enhancing, preEnhanceDraft,
    controlsOpen, alertsOpen, sessionInfoOpen,
    pendingApprovals, resolvedApprovals,
    surfaceRefreshing, expandedMedia, scrollY,
    isScrolling, headerVisible, viewportTopOffset,
    composeFocused, waitingForResponse, hydrated,
    expandedProject, streamingText,
    // Setters
    setSelectedId, setActiveView, setSurfaceNote,
    setDraftBySession, setActionStateBySession, setActionNoteBySession,
    setDraftAttachmentsBySession, setPendingOwnedTurnBySession,
    setEnhancing, setPreEnhanceDraft,
    setControlsOpen, setAlertsOpen, setSessionInfoOpen,
    setPendingApprovals, setResolvedApprovals,
    setSurfaceRefreshing, setExpandedMedia,
    setComposeFocused, setWaitingForResponse,
    setExpandedProject, setSelectedReviewFilePath,
    setDiffOpen, setReviewFileError,
    setHistoryBySession,
    // Refs
    composeRef, fileInputRef, transcriptBottomRef,
    stickToBottomRef, lastAssistantCountRef, seenMessageIdsRef,
    refreshError, surfaceNote,
    selectedId, activeView,
    setReviewPacketBySession,
    // Cortex memory
    cortexRecallOpen, setCortexRecallOpen,
    cortexHealthOpen, setCortexHealthOpen,
    cortexGraphOpen, setCortexGraphOpen,
    // cortexContextEnabled/Block removed — recall moved to ComposeBar
  } = state;

  const [launchOpen, setLaunchOpen] = useState(false);
  const [prReviewOpen, setPrReviewOpen] = useState(false);
  const [prReviewNumber, setPrReviewNumber] = useState<number | null>(null);
  const [prReviewRepo, setPrReviewRepo] = useState('');
  const { notifications, dismiss: dismissNotification, unreadCount } = useNotifications(snapshot);

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

  // Sync selected session with snapshot
  useEffect(() => {
    setSelectedId((currentId) => {
      if (currentId && snapshot.sessions.some((session) => session.id === currentId)) return currentId;
      return pickCurrentSession(snapshot)?.id ?? '';
    });
  }, [snapshot, setSelectedId]);

  const effectiveHistoryKey = linkedOwnedKey && historyBySession[linkedOwnedKey]?.length ? linkedOwnedKey : selectedSessionKey;
  const discoveredEntries = selectedSessionKey ? historyBySession[selectedSessionKey] ?? [] : [];
  const ownedEntries = linkedOwnedKey ? historyBySession[linkedOwnedKey] ?? [] : [];
  const mergedEntries = linkedOwnedKey && ownedEntries.length > 0
    ? [...discoveredEntries, ...ownedEntries]
    : discoveredEntries;
  const transcriptEntries = mergedEntries;
  const transcriptGroups = effectiveHistoryKey ? historyGroupsBySession[effectiveHistoryKey] ?? [] : [];
  const transcriptLoading = selectedSessionKey ? historyLoading[selectedSessionKey] ?? false : false;
  const transcriptError = selectedSessionKey ? historyError[selectedSessionKey] ?? null : null;
  const transcriptDraft = selectedSessionKey ? draftBySession[selectedSessionKey] ?? '' : '';
  const transcriptAttachments = selectedSessionKey ? draftAttachmentsBySession[selectedSessionKey] ?? [] : [];
  const pendingOwnedTurn = selectedSessionKey ? pendingOwnedTurnBySession[selectedSessionKey] ?? null : null;
  const transcriptActionState = selectedSessionKey ? actionStateBySession[selectedSessionKey] ?? 'idle' : 'idle';
  const transcriptActionNote = selectedSessionKey ? actionNoteBySession[selectedSessionKey] ?? null : null;
  const selectedReviewFile = selectedReviewFilePath ? reviewFileByPath[selectedReviewFilePath] : undefined;

  // Track assistant count for response detection
  const assistantCount = transcriptEntries.filter((e) => e.role === 'assistant').length;
  useEffect(() => {
    if (waitingForResponse && assistantCount > lastAssistantCountRef.current) {
      setWaitingForResponse(false);
    }
  }, [waitingForResponse, assistantCount, lastAssistantCountRef, setWaitingForResponse]);

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
  const sessionSwitcher = snapshot.sessions.slice(0, 5);
  const headerProgress = Math.min(scrollY / 88, 1);
  const isHeaderCompact = headerProgress > 0.12;
  const isComposerPrimed = isChatSession && (composeFocused || transcriptAttachments.length > 0);
  const dockMotionProgress = !isComposerPrimed && isScrolling ? 1 : 0;
  const dockFadeProgress = dockMotionProgress;
  const ownedAvailability = selectedSession?.runtimeSurface?.lifecycle?.availability;
  const ownedReviewDisposition = selectedReviewPacket?.reviewDisposition;
  const ownedQueuedTurn = Boolean(pendingOwnedTurn) || transcriptActionState === 'steering';
  const canResumeOwnedCodex = Boolean(isOwnedCodexSession && selectedSession?.runtimeSurface?.capabilities.sendInput && !ownedQueuedTurn);
  const canInterruptOwnedCodex = Boolean(isOwnedCodexSession && selectedSession?.runtimeSurface?.capabilities.interrupt);
  const hasTerminalSession = Boolean(selectedSession?.tmuxSession);
  const detailTab = detailTabState.sessionId === selectedSession?.id
    ? detailTabState.tab
    : hasTerminalSession
      ? 'terminal'
      : 'chat';
  const terminalActive = hasTerminalSession && detailTab === 'terminal';
  const linkedWorktree = selectedReviewPacket?.worktree;
  const showWorktreeActions = Boolean(
    isOwnedCodexSession
    && linkedWorktree
    && linkedWorktree.dirtyFiles.length > 0
    && selectedSession?.runtimeSurface?.lifecycle?.availability === 'ready-for-resume',
  );
  const worktreeRepoRoot = selectedReviewPacket?.repoPath
    ? selectedReviewPacket.repoPath.replace(/^~(?=\/|$)/, '/Users/marquisehurtt')
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

  // Track compose bar height via ResizeObserver for dynamic pill positioning
  const bottomDockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bottomDockRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) state.setComposeHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [state.setComposeHeight]);

  const shellStyle = {
    '--remodex-header-progress': headerProgress.toFixed(3),
    '--remodex-dock-fade-progress': dockFadeProgress.toFixed(3),
    '--remodex-dock-motion-progress': dockMotionProgress.toFixed(3),
    '--remodex-compose-active': isComposerPrimed ? '1' : '0',
    '--remodex-viewport-top-offset': `${viewportTopOffset}px`,
    '--remodex-compose-height': `${state.composeHeight}px`,
  } as CSSProperties;

  // ── Render ──
  return (
    <div className="mobile-wrap remodex-mobile-page" style={shellStyle} suppressHydrationWarning>
      <div className="remodex-phone-shell">
        {/* Frosted status bar blend — white gradient above TopBar */}
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0,
          height: 'calc(env(safe-area-inset-top, 0px) + 12px)',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0.92) 60%, rgba(255,255,255,0) 100%)',
          zIndex: 9,
          pointerEvents: 'none',
        }} />
        <TopBar
          snapshot={snapshot}
          selectedSession={selectedSession}
          selectedReviewPacket={selectedReviewPacket}
          selectedReviewFile={selectedReviewFile}
          reviewFiles={reviewFiles}
          isOwnedCodexSession={isOwnedCodexSession}
          isHeaderCompact={isHeaderCompact}
          headerVisible={headerVisible}
          pendingApprovalsCount={pendingApprovals.length}
          wsConnectionState={wsConnectionState}
          compactLine={compactLine}
          squadPickerOpen={state.squadPickerOpen}
          activeScreen={activeView === 'costs' ? 'costs' : activeView === 'fleet' ? 'fleet' : activeView === 'activity' ? 'approvals' : activeView === 'settings' ? 'settings' : 'chat'}
          onNavigate={(screen: MobileScreen) => {
            switch (screen) {
              case 'chat':
                setActiveView('squad');
                break;
              case 'fleet':
                setActiveView('fleet');
                break;
              case 'memory':
                setCortexRecallOpen(true);
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
          onOpenControls={() => setControlsOpen(true)}
          onOpenDiff={actions.openDiffViewer}
          onOpenAlerts={() => state.setAlertsOpen(true)}
          onToggleSquadPicker={() => state.setSquadPickerOpen(!state.squadPickerOpen)}
          onSessionFocus={actions.handleSessionFocus}
        />
        <div className="remodex-scroll-view">
          {activeView === 'fleet' ? (
            <FleetView
              snapshot={snapshot}
              onAgentSelect={(sessionKey) => {
                actions.handleSessionFocus(sessionKey);
                setActiveView('squad');
              }}
              onBack={() => setActiveView('squad')}
              onLaunch={() => setLaunchOpen(true)}
            />
          ) : null}
          {activeView === 'settings' ? (
            <SettingsView onBack={() => setActiveView('squad')} />
          ) : null}
          {activeView === 'activity' ? (
            <ActivityFeed
              snapshot={snapshot}
              onBack={() => setActiveView('squad')}
              onAgentSelect={(sessionKey) => {
                actions.handleSessionFocus(sessionKey);
                setActiveView('squad');
              }}
              onApprove={(item) => {
                if (item.sessionKey) {
                  actions.runAction({ action: 'approve', sessionKey: item.sessionKey });
                }
              }}
              onDeny={(item) => {
                if (item.sessionKey) {
                  actions.runAction({ action: 'deny', sessionKey: item.sessionKey });
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
            <CostsDashboard
              snapshot={snapshot}
              onBack={() => setActiveView('squad')}
              onSessionSelect={(sessionId) => {
                state.setSelectedId(sessionId);
                state.setActiveView('chat');
              }}
              compactLine={compactLine}
            />
          ) : null}
          {activeView !== 'costs' && activeView !== 'fleet' ? (
            <TokenUsageSummary snapshot={snapshot} onViewCosts={() => setActiveView('costs')} />
          ) : null}
          {activeView !== 'costs' && activeView !== 'fleet' ? (
            <SquadRail
              snapshot={snapshot}
              expandedProject={expandedProject}
              selectedSession={selectedSession}
              onSessionFocus={actions.handleSessionFocus}
              onProjectToggle={(workspace) => state.setExpandedProject(workspace)}
              onCostsView={() => setActiveView('costs')}
              agentDisplayName={agentDisplayName}
            />
          ) : null}
          {activeView !== 'fleet' && activeView !== 'costs' && activeView !== 'activity' && activeView !== 'settings' ? (
          <SurfaceStatus
            snapshot={snapshot}
            selectedSession={selectedSession}
            selectedReviewPacket={selectedReviewPacket}
            isOwnedCodexSession={isOwnedCodexSession}
            refreshError={refreshError}
            surfaceNote={surfaceNote}
            transcriptError={transcriptError}
            selectedReviewPacketError={selectedReviewPacketError}
          />
          ) : null}
          {hasTerminalSession && activeView !== 'fleet' && activeView !== 'costs' && activeView !== 'activity' && activeView !== 'settings' ? (
            <div
              style={{
                display: 'flex',
                gap: 8,
                padding: '8px 14px 0',
              }}
            >
              <button
                type="button"
                onClick={() => setDetailTabState({ sessionId: selectedSession?.id ?? null, tab: 'terminal' })}
                style={{
                  flex: 1,
                  minHeight: 36,
                  borderRadius: 12,
                  border: detailTab === 'terminal' ? '1px solid rgba(239, 68, 68, 0.18)' : '1px solid rgba(15, 23, 42, 0.08)',
                  background: detailTab === 'terminal' ? 'rgba(239, 68, 68, 0.08)' : 'rgba(255, 255, 255, 0.72)',
                  color: detailTab === 'terminal' ? '#b91c1c' : '#475569',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Terminal
              </button>
              <button
                type="button"
                onClick={() => setDetailTabState({ sessionId: selectedSession?.id ?? null, tab: 'chat' })}
                style={{
                  flex: 1,
                  minHeight: 36,
                  borderRadius: 12,
                  border: detailTab === 'chat' ? '1px solid rgba(239, 68, 68, 0.18)' : '1px solid rgba(15, 23, 42, 0.08)',
                  background: detailTab === 'chat' ? 'rgba(239, 68, 68, 0.08)' : 'rgba(255, 255, 255, 0.72)',
                  color: detailTab === 'chat' ? '#b91c1c' : '#475569',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Chat
              </button>
            </div>
          ) : null}
          {activeView !== 'fleet' && activeView !== 'costs' && activeView !== 'activity' && activeView !== 'settings' ? (
          terminalActive ? (
            <MobileTerminal tmuxSession={selectedSession!.tmuxSession!} />
          ) : (
            <>
              <ChatView
                transcriptEntries={transcriptEntries}
                selectedSession={selectedSession}
                isOwnedCodexSession={isOwnedCodexSession}
                transcriptLoading={transcriptLoading}
                isRefreshing={surfaceRefreshing}
                composeHeight={state.composeHeight}
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
              />
              <ApprovalStack
                pendingApprovals={pendingApprovals}
                resolvedApprovals={resolvedApprovals}
                onApprove={(a) => actions.handleApprovalDecision(a, 'approved')}
                onReject={(a) => actions.handleApprovalDecision(a, 'rejected')}
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
          <div ref={transcriptBottomRef} className="remodex-scroll-anchor" aria-hidden="true" />
        </div>
        <div ref={bottomDockRef} className="remodex-bottom-dock" data-active={isComposerPrimed ? 'true' : 'false'}>
          {!terminalActive && activeView !== 'fleet' && activeView !== 'costs' && activeView !== 'activity' && activeView !== 'settings' ? (
            <div className="remodex-compose-shell">
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
                onModelPillTap={() => setSessionInfoOpen(true)}
                streamingText={streamingText}
                agentRunning={waitingForResponse}
              />
            </div>
          ) : null}
        </div>
      {/* RuntimeBar — pinned to very bottom, separate from compose dock */}
      {activeView !== 'fleet' && activeView !== 'costs' && activeView !== 'activity' && activeView !== 'settings' ? (
        <div style={{
          position: 'fixed',
          left: 0, right: 0,
          bottom: 0,
          zIndex: 5,
          background: 'rgba(255,255,255,0.85)',
          backdropFilter: 'blur(20px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
          borderTop: '1px solid rgba(0,0,0,0.04)',
        }}>
          <RuntimeBar
            snapshot={snapshot}
            selectedSession={selectedSession}
            selectedReviewPacket={selectedReviewPacket}
            isOwnedCodexSession={isOwnedCodexSession}
            compactLine={compactLine}
            reviewFiles={reviewFiles}
            onOpenDiff={actions.openDiffViewer}
          />
        </div>
      ) : null}
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
        stickyReviewFilesRef={stickyReviewFilesRef}
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
      <SessionInfoSheet
        open={sessionInfoOpen}
        onClose={() => setSessionInfoOpen(false)}
        sessionKey={selectedSessionKey}
        modelName={selectedSession?.model}
        status={selectedSession?.status}
        contextPercent={selectedSession?.context?.usedPercent ?? 0}
        totalTokens={selectedSession?.tokenUsage?.totalTokens ?? 0}
        contextTokens={selectedSession?.tokenUsage?.remainingTokens ? (selectedSession.tokenUsage.totalTokens ?? 0) + (selectedSession.tokenUsage.remainingTokens ?? 0) : 0}
        messageCount={transcriptEntries.length}
        sessionAge={selectedSession?.lastEventAt ? formatSessionAge(selectedSession.lastEventAt) : undefined}
        onCopyKey={actions.handleCopySelectedSessionKey}
        onExpandMedia={(media) => { setSessionInfoOpen(false); setExpandedMedia(media); }}
      />
      {/* Notification banners — iOS-style toast from top */}
      <NotificationBanner
        notifications={notifications}
        onDismiss={dismissNotification}
        onTap={(n) => {
          dismissNotification(n.id);
          if (n.sessionKey) {
            actions.handleSessionFocus(n.sessionKey);
            setActiveView('squad');
          } else {
            setActiveView('activity');
          }
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
            // Navigate to chat with the newly launched agent
            setTimeout(() => {
              actions.handleSessionFocus(surfaceId);
              setActiveView('squad');
            }, 500);
          }
        }}
      />
    </div>
  );
}
