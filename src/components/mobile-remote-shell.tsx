'use client';
import {
  useEffect,
  useMemo,
  useRef,
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

// Lazy-loaded panels — only loaded when opened (#45)
const shimmerFallback = { loading: () => <ShimmerCard /> };
const ApprovalStack = dynamic(() => import('./mobile/ApprovalStack').then((m) => ({ default: m.ApprovalStack })), { ssr: false, ...shimmerFallback });
const ControlsSheet = dynamic(() => import('./mobile/ControlsSheet').then((m) => ({ default: m.ControlsSheet })), { ssr: false, ...shimmerFallback });
const CostsDashboard = dynamic(() => import('./mobile/CostsDashboard').then((m) => ({ default: m.CostsDashboard })), { ssr: false, ...shimmerFallback });
const DiffOverlay = dynamic(() => import('./mobile/DiffOverlay').then((m) => ({ default: m.DiffOverlay })), { ssr: false, ...shimmerFallback });
const TokenUsageSummary = dynamic(() => import('./mobile/TokenUsageSummary').then((m) => ({ default: m.TokenUsageSummary })), { ssr: false, ...shimmerFallback });

// Cortex memory surfaces (#78-#85) — typed via explicit generic param
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RecallPanel = dynamic<any>(() => import('./mobile/RecallPanel'), { ssr: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MemoryHealth = dynamic<any>(() => import('./mobile/MemoryHealth'), { ssr: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MemoryContext = dynamic<any>(() => import('./mobile/MemoryContext'), { ssr: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GraphExplorer = dynamic<any>(() => import('./mobile/GraphExplorer'), { ssr: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CortexStatus = dynamic<any>(() => import('./mobile/CortexStatus'), { ssr: false });

// Extracted hooks (#43 — hooks extraction)
import { useMobileState } from './mobile/hooks/useMobileState';
import { useMobilePolling } from './mobile/hooks/useMobilePolling';
import { useMobileScroll } from './mobile/hooks/useMobileScroll';
import { useMobileStreaming } from './mobile/hooks/useMobileStreaming';
import { useMobileActions } from './mobile/hooks/useMobileActions';

export function MobileRemoteShell({
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
  // ── All state lives in useMobileState ──
  const state = useMobileState({ initialSnapshot, initialTranscript, initialReviewFile, initialOwnedReviewPacket });

  // ── Streaming + WebSocket ──
  const { wsConnected, wsConnectionState } = useMobileStreaming(state);

  // ── Data fetching + polling ──
  const { refreshInbox, loadHistory, loadOwnedReviewPacket, loadReviewFile, reviewFiles, linkedOwnedKey } = useMobilePolling(state, wsConnected);

  // ── Action handlers ──
  const actions = useMobileActions(state, { refreshInbox, loadHistory, loadOwnedReviewPacket, loadReviewFile, reviewFiles });

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
    controlsOpen, pendingApprovals, resolvedApprovals,
    surfaceRefreshing, expandedMedia, scrollY,
    isScrolling, headerVisible, viewportTopOffset,
    composeFocused, waitingForResponse, hydrated,
    expandedProject, streamingText,
    // Setters
    setSelectedId, setActiveView, setSurfaceNote,
    setDraftBySession, setActionStateBySession, setActionNoteBySession,
    setDraftAttachmentsBySession, setPendingOwnedTurnBySession,
    setEnhancing, setPreEnhanceDraft,
    setControlsOpen, setPendingApprovals, setResolvedApprovals,
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
    cortexContextEnabled, setCortexContextEnabled,
    cortexContextBlock, setCortexContextBlock,
  } = state;

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
          onOpenControls={() => setControlsOpen(true)}
          onOpenDiff={actions.openDiffViewer}
          onOpenCortexRecall={() => setCortexRecallOpen(true)}
        />
        <div className="remodex-scroll-view">
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
          {activeView !== 'costs' ? (
            <TokenUsageSummary snapshot={snapshot} onViewCosts={() => setActiveView('costs')} />
          ) : null}
          {activeView !== 'costs' ? (
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
          <div ref={transcriptBottomRef} className="remodex-scroll-anchor" aria-hidden="true" />
        </div>
        <div ref={bottomDockRef} className="remodex-bottom-dock" data-active={isComposerPrimed ? 'true' : 'false'}>
          <MemoryContext
            prompt={transcriptDraft}
            cwd={selectedSession?.runtimeSurface?.cwd}
            branch={selectedSession?.runtimeSurface?.branch}
            enabled={cortexContextEnabled}
            onToggle={setCortexContextEnabled}
            onContextReady={setCortexContextBlock}
          />
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
            />
          </div>
          <RuntimeBar
            snapshot={snapshot}
            selectedSession={selectedSession}
            selectedReviewPacket={selectedReviewPacket}
            isOwnedCodexSession={isOwnedCodexSession}
            compactLine={compactLine}
          />
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
        sessionKey={selectedSessionKey ?? ''}
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
    </div>
  );
}
