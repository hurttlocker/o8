'use client';
import {
  useEffect,
  useMemo,
  type CSSProperties,
} from 'react';
import { demoApprovals } from '@/lib/json-render/demo-specs';
import type { ApprovalRequest } from '@/lib/json-render/demo-specs';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import type {
  MobileActionRequest,
  MobileInboxSnapshot,
  MobileReviewFileResponse,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';
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

// Lazy-loaded panels — only loaded when opened (#45)
const ApprovalStack = dynamic(() => import('./mobile/ApprovalStack').then((m) => ({ default: m.ApprovalStack })), { ssr: false });
const ControlsSheet = dynamic(() => import('./mobile/ControlsSheet').then((m) => ({ default: m.ControlsSheet })), { ssr: false });
const CostsDashboard = dynamic(() => import('./mobile/CostsDashboard').then((m) => ({ default: m.CostsDashboard })), { ssr: false });
const DiffOverlay = dynamic(() => import('./mobile/DiffOverlay').then((m) => ({ default: m.DiffOverlay })), { ssr: false });
const TokenUsageSummary = dynamic(() => import('./mobile/TokenUsageSummary').then((m) => ({ default: m.TokenUsageSummary })), { ssr: false });

import {
  copyTextToClipboard,
  enhancePromptDraft,
  focusSessionSurface,
  loadOwnedCorrectionDraftForSession,
  openDiffViewerForSession,
  prepareImageAttachments,
  refreshMobileSurface,
  removeImageAttachment,
  runMobileAction,
  stopActiveRunFromSurface,
  submitOwnedResumeTurn,
  submitSteerTurn,
  updateOwnedReviewDisposition,
} from './mobile/controller';

// Extracted hooks (#43 — hooks extraction)
import { useMobileState } from './mobile/hooks/useMobileState';
import { useMobilePolling } from './mobile/hooks/useMobilePolling';
import { useMobileScroll } from './mobile/hooks/useMobileScroll';
import { useMobileStreaming } from './mobile/hooks/useMobileStreaming';

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
  const { wsConnected } = useMobileStreaming(state);

  // ── Data fetching + polling ──
  const { refreshInbox, loadHistory, loadOwnedReviewPacket, loadReviewFile, reviewFiles, linkedOwnedKey } = useMobilePolling(state, wsConnected);

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

  const shellStyle = {
    '--remodex-header-progress': headerProgress.toFixed(3),
    '--remodex-dock-fade-progress': dockFadeProgress.toFixed(3),
    '--remodex-dock-motion-progress': dockMotionProgress.toFixed(3),
    '--remodex-compose-active': isComposerPrimed ? '1' : '0',
    '--remodex-viewport-top-offset': `${viewportTopOffset}px`,
  } as CSSProperties;

  // ── Action handlers ──
  async function runAction(payload: MobileActionRequest) {
    return await runMobileAction({ payload, setActionStateBySession, setActionNoteBySession, refreshInbox, loadHistory, loadOwnedReviewPacket });
  }

  function playSendClick() {
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(1800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.06);
    } catch { /* audio not available */ }
  }

  async function handleAttachmentSelection(files: FileList | null) {
    await prepareImageAttachments({ selectedSessionKey, files, isChatSession, setSurfaceNote, setDraftAttachmentsBySession, composeRef });
  }

  function removeDraftAttachment(sessionKey: string, attachmentId: string) {
    removeImageAttachment({ sessionKey, attachmentId, setDraftAttachmentsBySession });
  }

  async function handleEnhancePrompt() {
    await enhancePromptDraft({ selectedSessionKey, enhancing, draftBySession, setEnhancing, setPreEnhanceDraft, setDraftBySession, setSurfaceNote });
  }

  function handleUndoEnhance() {
    if (!selectedSessionKey || preEnhanceDraft === null) return;
    setDraftBySession((current) => ({ ...current, [selectedSessionKey]: preEnhanceDraft }));
    setPreEnhanceDraft(null);
  }

  async function handleSteerSubmit(sessionKey: string) {
    await submitSteerTurn({
      sessionKey,
      actionStateBySession,
      snapshot,
      draftBySession,
      draftAttachmentsBySession,
      transcriptEntries,
      lastAssistantCountRef,
      setWaitingForResponse,
      setHistoryBySession,
      setDraftBySession,
      setDraftAttachmentsBySession,
      setPreEnhanceDraft,
      setSurfaceNote,
      setActionNoteBySession,
      setSelectedId,
      runAction,
      refreshInbox,
      loadHistory,
      playSendClick,
    });
  }

  function handleLoadOwnedCorrectionDraft(sessionKey: string) {
    loadOwnedCorrectionDraftForSession({ sessionKey, reviewPacketBySession, setDraftBySession, setActionNoteBySession, composeRef });
  }

  async function handleOwnedResumeSubmit(sessionKey: string) {
    await submitOwnedResumeTurn({
      sessionKey,
      actionStateBySession,
      draftBySession,
      setActionNoteBySession,
      setPendingOwnedTurnBySession,
      setDraftBySession,
      setSurfaceNote,
      runAction,
      playSendClick,
    });
  }

  async function handleOwnedReviewDisposition(action: 'watch' | 'resolve', sessionKey: string) {
    await updateOwnedReviewDisposition({
      action,
      sessionKey,
      reviewPacketBySession,
      setReviewPacketBySession,
      setActionNoteBySession,
      setSurfaceNote,
      runAction,
      loadOwnedReviewPacket,
    });
  }

  function handleCopy(text: string) {
    copyTextToClipboard({ text, setSurfaceNote });
  }

  async function handleSurfaceRefresh() {
    setSurfaceRefreshing(true);
    try {
      await refreshMobileSurface({
        selectedSessionKey,
        selectedReviewFilePath,
        refreshInbox,
        loadHistory,
        loadOwnedReviewPacket,
        loadReviewFile,
        setSurfaceNote,
      });
    } finally {
      setSurfaceRefreshing(false);
    }
  }

  function handleSessionFocus(sessionId: string) {
    focusSessionSurface({
      sessionId,
      snapshot,
      compactLine,
      setSelectedId,
      setActiveView,
      setControlsOpen,
      setDiffOpen,
      setSurfaceNote,
      setSelectedReviewFilePath,
      loadHistory,
      loadOwnedReviewPacket,
      loadReviewFile,
    });
  }

  async function handleStopActiveRun() {
    await stopActiveRunFromSurface({ selectedSessionKey, isChatSession, canInterruptOwnedCodex, isOwnedCodexSession, runAction, setSurfaceNote, setControlsOpen });
  }

  function openDiffViewer() {
    openDiffViewerForSession({
      reviewFiles,
      selectedReviewFilePath,
      reviewFileByPath,
      setSurfaceNote,
      setSelectedReviewFilePath,
      setControlsOpen,
      setDiffOpen,
      loadReviewFile,
    });
  }

  function handleReviewFileFocus(reviewPath: string) {
    setSelectedReviewFilePath(reviewPath);
    void loadReviewFile(reviewPath).catch(() => undefined);
  }

  function handleApprovalDecision(approval: ApprovalRequest, resolution: 'approved' | 'rejected') {
    setResolvedApprovals((current) => ({ ...current, [approval.id]: resolution }));
    setSurfaceNote(`${resolution === 'approved' ? '✅ Approved' : '❌ Rejected'}: ${approval.title}`);
    window.setTimeout(() => setPendingApprovals((current) => current.filter((item) => item.id !== approval.id)), 1500);
  }

  function handleToggleApprovals() {
    setPendingApprovals((current) => (current.length > 0 ? [] : [...demoApprovals]));
    setResolvedApprovals({});
    setControlsOpen(false);
  }

  function handleCopySelectedSessionKey() {
    if (!selectedSessionKey) return;
    handleCopy(selectedSessionKey);
    setControlsOpen(false);
  }

  function handleControlsRefresh() {
    void handleSurfaceRefresh();
    setControlsOpen(false);
  }

  function handleDiffRefresh() {
    if (selectedReviewFilePath) {
      void loadReviewFile(selectedReviewFilePath, true);
      return;
    }
    void handleSurfaceRefresh();
  }

  const withSelectedSession = <Args extends unknown[]>(fn: (sessionKey: string, ...args: Args) => void | Promise<void>) =>
    (...args: Args): void | Promise<void> => (selectedSessionKey ? fn(selectedSessionKey, ...args) : undefined);

  const composeBarHandlers = {
    onSend: withSelectedSession(handleSteerSubmit),
    onOwnedResume: withSelectedSession(handleOwnedResumeSubmit),
    onEnhance: handleEnhancePrompt,
    onUndoEnhance: handleUndoEnhance,
    onAttach: () => fileInputRef.current?.click(),
    onAttachFiles: handleAttachmentSelection,
    onRemoveAttachment: withSelectedSession(removeDraftAttachment),
    onRefresh: handleSurfaceRefresh,
    onStop: handleStopActiveRun,
    onInterrupt: handleStopActiveRun,
    onOpenDiff: openDiffViewer,
    onLoadCorrectionDraft: withSelectedSession(handleLoadOwnedCorrectionDraft),
    onToggleOwnedReviewDisposition: withSelectedSession((sessionKey) => handleOwnedReviewDisposition(ownedReviewDisposition === 'resolved' ? 'watch' : 'resolve', sessionKey)),
    onDraftChange: withSelectedSession((sessionKey, value: string) => setDraftBySession((current) => ({ ...current, [sessionKey]: value }))),
    onFocusChange: setComposeFocused,
  };

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
          compactLine={compactLine}
          onOpenControls={() => setControlsOpen(true)}
          onOpenDiff={openDiffViewer}
        />
        <div className="remodex-scroll-view">
          {activeView === 'costs' ? (
            <CostsDashboard
              snapshot={snapshot}
              onBack={() => setActiveView('squad')}
              onSessionSelect={(sessionId) => {
                setSelectedId(sessionId);
                setActiveView('chat');
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
              onSessionFocus={handleSessionFocus}
              onProjectToggle={(workspace) => setExpandedProject(workspace)}
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
            selectedReviewFile={selectedReviewFile}
            streamingText={streamingText}
            waitingForResponse={waitingForResponse}
            hydrated={hydrated}
            seenMessageIdsRef={seenMessageIdsRef}
            agentDisplayName={agentDisplayName}
            renderMessageBody={renderMessageBody}
            expandedMedia={expandedMedia}
            setExpandedMedia={setExpandedMedia}
            onOpenDiff={openDiffViewer}
            onScrollToLatestMessage={scrollToLatestMessage}
            actionState={transcriptActionState}
          />
          <ApprovalStack
            pendingApprovals={pendingApprovals}
            resolvedApprovals={resolvedApprovals}
            onApprove={(a) => handleApprovalDecision(a, 'approved')}
            onReject={(a) => handleApprovalDecision(a, 'rejected')}
          />
          <div ref={transcriptBottomRef} className="remodex-scroll-anchor" aria-hidden="true" />
        </div>
        <div className="remodex-bottom-dock" data-active={isComposerPrimed ? 'true' : 'false'}>
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
              handlers={composeBarHandlers}
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
        onRefresh={handleControlsRefresh}
        onOpenDiff={openDiffViewer}
        onToggleApprovals={handleToggleApprovals}
        onCopyKey={handleCopySelectedSessionKey}
        onAbort={() => handleStopActiveRun()}
        onSessionFocus={handleSessionFocus}
      />
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
        onFileSelect={handleReviewFileFocus}
        onLoadFile={loadReviewFile}
        onRefresh={handleDiffRefresh}
      />
    </div>
  );
}
