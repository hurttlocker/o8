'use client';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { demoApprovals } from '@/lib/json-render/demo-specs';
import type { ApprovalRequest } from '@/lib/json-render/demo-specs';
import type { ReviewChangedFile, RuntimeReviewPacket } from '@/lib/fleet/types';
import type {
  MobileActionRequest,
  MobileInboxSnapshot,
  MobileReviewFileResponse,
  MobileRuntimeTailGroup,
  MobileTranscriptEntry,
  MobileTranscriptMedia,
} from '@/lib/mobile/types';
import type { DraftAttachment, PendingOwnedTurn } from './mobile/types';
import {
  agentDisplayName,
  compactLine,
  pickCurrentSession,
  renderMessageBody,
} from './mobile/utils';
import { ApprovalStack } from './mobile/ApprovalStack';
import { ChatView } from './mobile/ChatView';
import { ComposeBar } from './mobile/ComposeBar';
import { ControlsSheet } from './mobile/ControlsSheet';
import { CostsDashboard } from './mobile/CostsDashboard';
import { DiffOverlay } from './mobile/DiffOverlay';
import { RuntimeBar } from './mobile/RuntimeBar';
import { SquadRail } from './mobile/SquadRail';
import { SurfaceStatus } from './mobile/SurfaceStatus';
import { TokenUsageSummary } from './mobile/TokenUsageSummary';
import { TopBar } from './mobile/TopBar';
import {
  copyTextToClipboard,
  enhancePromptDraft,
  focusSessionSurface,
  loadOwnedCorrectionDraftForSession,
  loadOwnedReviewPacketForSession,
  loadReviewFilePreview,
  loadSessionHistory,
  openDiffViewerForSession,
  prepareImageAttachments,
  refreshInboxSnapshot,
  refreshMobileSurface,
  removeImageAttachment,
  runMobileAction,
  stopActiveRunFromSurface,
  submitOwnedResumeTurn,
  submitSteerTurn,
  updateOwnedReviewDisposition,
} from './mobile/controller';
import {
  connectTranscriptStream,
  pinTranscriptToBottom,
  startUnifiedSyncPolling,
  trackScrollChrome,
  trackViewportTopOffset,
  trackVisibilityRefresh,
} from './mobile/effects';
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
  const [snapshot, setSnapshot] = useState<MobileInboxSnapshot>(initialSnapshot);
  const [selectedId, setSelectedId] = useState(() => pickCurrentSession(initialSnapshot)?.id ?? '');
  const [activeView, setActiveView] = useState<'squad' | 'chat' | 'costs'>('squad');
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [surfaceNote, setSurfaceNote] = useState<string | null>(null);
  const [historyBySession, setHistoryBySession] = useState<Record<string, MobileTranscriptEntry[]>>(() => (
    initialTranscript?.sessionKey ? { [initialTranscript.sessionKey]: initialTranscript.transcript } : {}
  ));
  const [historyGroupsBySession, setHistoryGroupsBySession] = useState<Record<string, MobileRuntimeTailGroup[]>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [historyError, setHistoryError] = useState<Record<string, string | null>>({});
  const [reviewPacketBySession, setReviewPacketBySession] = useState<Record<string, RuntimeReviewPacket>>(() => (
    initialOwnedReviewPacket ? { [initialOwnedReviewPacket.surfaceId]: initialOwnedReviewPacket } : {}
  ));
  const [reviewPacketLoadingBySession, setReviewPacketLoadingBySession] = useState<Record<string, boolean>>({});
  const [reviewPacketErrorBySession, setReviewPacketErrorBySession] = useState<Record<string, string | null>>({});
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>({});
  const [actionStateBySession, setActionStateBySession] = useState<Record<string, 'idle' | 'steering' | 'stopping' | 'reviewing'>>({});
  const [actionNoteBySession, setActionNoteBySession] = useState<Record<string, string | null>>({});
  const [draftAttachmentsBySession, setDraftAttachmentsBySession] = useState<Record<string, DraftAttachment[]>>({});
  const [pendingOwnedTurnBySession, setPendingOwnedTurnBySession] = useState<Record<string, PendingOwnedTurn>>({});
  const [selectedReviewFilePath, setSelectedReviewFilePath] = useState<string | null>(() => (
    initialReviewFile?.path ?? initialOwnedReviewPacket?.changedFiles[0]?.path ?? initialSnapshot.review?.changedFiles[0]?.path ?? null
  ));
  const [reviewFileByPath, setReviewFileByPath] = useState<Record<string, MobileReviewFileResponse['file']>>(() => (
    initialReviewFile ? { [initialReviewFile.path]: initialReviewFile } : {}
  ));
  const [reviewFileLoadingPath, setReviewFileLoadingPath] = useState<string | null>(null);
  const [reviewFileError, setReviewFileError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [resolvedApprovals, setResolvedApprovals] = useState<Record<string, 'approved' | 'rejected'>>({});
  const [enhancing, setEnhancing] = useState(false);
  const [preEnhanceDraft, setPreEnhanceDraft] = useState<string | null>(null);
  const [surfaceRefreshing, setSurfaceRefreshing] = useState(false);
  const [expandedMedia, setExpandedMedia] = useState<MobileTranscriptMedia | null>(null);
  const [scrollY, setScrollY] = useState(0);
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
  const [isScrolling, setIsScrolling] = useState(false);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [viewportTopOffset, setViewportTopOffset] = useState(0);
  const [composeFocused, setComposeFocused] = useState(false);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null);
  const scrollStopTimerRef = useRef<number | null>(null);
  const headerRevealTimerRef = useRef<number | null>(null);
  const initialBottomPinBySessionRef = useRef<Record<string, boolean>>({});
  const stickToBottomRef = useRef(true);
  const refreshInbox = useCallback(
    () => refreshInboxSnapshot({ setSnapshot, setRefreshError }),
    [],
  );
  const isWindowNearBottom = useCallback((threshold = 160) => {
    if (typeof window === 'undefined') {
      return true;
    }
    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    const viewportBottom = scrollTop + window.innerHeight;
    const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    return documentHeight - viewportBottom <= threshold;
  }, []);
  const scrollToLatestMessage = useCallback((force = false) => {
    if (typeof window === 'undefined') {
      return;
    }
    if (!force && !stickToBottomRef.current) {
      return;
    }
    transcriptBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, []);
  useEffect(() => {
    return trackViewportTopOffset({ setViewportTopOffset });
  }, []);
  // Inbox refresh handled by unified sync polling below
  useEffect(() => {
    return trackScrollChrome({
      setScrollY,
      setIsScrolling,
      setHeaderVisible,
      scrollStopTimerRef,
      headerRevealTimerRef,
      stickToBottomRef,
      isWindowNearBottom,
    });
  }, [isWindowNearBottom]);
  useEffect(() => {
    setSelectedId((currentId) => {
      if (currentId && snapshot.sessions.some((session) => session.id === currentId)) {
        return currentId;
      }
      return pickCurrentSession(snapshot)?.id ?? '';
    });
  }, [snapshot]);
  const selectedSession = useMemo(
    () => snapshot.sessions.find((session) => session.id === selectedId) ?? pickCurrentSession(snapshot),
    [selectedId, snapshot],
  );
  const selectedSessionKey = selectedSession?.sessionKey;
  const isOpenClawSession = selectedSession?.runtime === 'openclaw';
  const isChatSession = isOpenClawSession || selectedSession?.runtime === 'codex';
  const isOwnedCodexSession = selectedSession?.runtime === 'codex' && selectedSession?.runtimeSurface?.ownership === 'owned';
  const selectedReviewPacket = selectedSessionKey && isOwnedCodexSession ? reviewPacketBySession[selectedSessionKey] ?? null : null;
  const selectedReviewPacketLoading = selectedSessionKey && isOwnedCodexSession ? reviewPacketLoadingBySession[selectedSessionKey] ?? false : false;
  const selectedReviewPacketError = selectedSessionKey && isOwnedCodexSession ? reviewPacketErrorBySession[selectedSessionKey] ?? null : null;
  const stickyReviewFilesRef = useRef<ReviewChangedFile[]>([]);
  const [waitingForResponse, setWaitingForResponse] = useState(false);
  const lastAssistantCountRef = useRef(0);
  const seenMessageIdsRef = useRef<Set<string> | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const streamingTextRef = useRef('');
  useEffect(() => {
    if (!seenMessageIdsRef.current) {
      seenMessageIdsRef.current = new Set(transcriptEntries.map((e) => e.id));
    }
    setHydrated(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    return connectTranscriptStream({
      selectedSessionKey,
      sessions: snapshot.sessions,
      setHistoryBySession,
      setStreamingText,
      streamingTextRef,
      loadHistory,
    });
  }, [selectedSessionKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const reviewFiles = useMemo(() => {
    const next = isOwnedCodexSession
      ? selectedReviewPacket?.changedFiles ?? []
      : snapshot.review?.changedFiles ?? [];
    if (next.length) {
      stickyReviewFilesRef.current = next;
      return next;
    }
    return stickyReviewFilesRef.current;
  }, [isOwnedCodexSession, selectedReviewPacket, snapshot.review?.changedFiles]);
  const loadHistory = useCallback(
    (sessionKey: string, force = false) => loadSessionHistory({
      sessionKey,
      force,
      historyBySession,
      setHistoryLoading,
      setHistoryBySession,
      setHistoryGroupsBySession,
      setHistoryError,
    }),
    [historyBySession],
  );
  const loadOwnedReviewPacket = useCallback(
    (sessionKey: string, force = false) => loadOwnedReviewPacketForSession({
      sessionKey,
      force,
      reviewPacketBySession,
      setReviewPacketLoadingBySession,
      setReviewPacketBySession,
      setReviewPacketErrorBySession,
    }),
    [reviewPacketBySession],
  );
  const loadReviewFile = useCallback(
    (reviewPath: string, force = false) => loadReviewFilePreview({
      reviewPath,
      force,
      reviewFileByPath,
      setReviewFileLoadingPath,
      setReviewFileError,
      setReviewFileByPath,
    }),
    [reviewFileByPath],
  );
  useEffect(() => {
    if (!selectedSessionKey) {
      return;
    }
    if (!historyBySession[selectedSessionKey]?.length && !historyLoading[selectedSessionKey]) {
      void loadHistory(selectedSessionKey).catch(() => undefined);
    }
  }, [historyBySession, historyLoading, loadHistory, selectedSessionKey]);
  useEffect(() => {
    if (!selectedSessionKey || !selectedSessionKey.startsWith('codex-owned:')) {
      return;
    }
    if (!reviewPacketBySession[selectedSessionKey] && !reviewPacketLoadingBySession[selectedSessionKey]) {
      void loadOwnedReviewPacket(selectedSessionKey).catch(() => undefined);
    }
  }, [loadOwnedReviewPacket, reviewPacketBySession, reviewPacketLoadingBySession, selectedSessionKey]);
  useEffect(() => {
    if (!reviewFiles.length) {
      setSelectedReviewFilePath(null);
      setReviewFileError(null);
      return;
    }
    if (selectedReviewFilePath && reviewFiles.some((file) => file.path === selectedReviewFilePath)) {
      return;
    }
    const nextPath = reviewFiles[0]?.path ?? null;
    setSelectedReviewFilePath(nextPath);
    if (nextPath) {
      void loadReviewFile(nextPath).catch(() => undefined);
    }
  }, [loadReviewFile, reviewFiles, selectedReviewFilePath]);
  const documentVisibleRef = useRef(true);
  useEffect(() => {
    return trackVisibilityRefresh({
      documentVisibleRef,
      selectedSessionKey,
      loadHistory,
      refreshInbox,
    });
  }, [loadHistory, refreshInbox, selectedSessionKey]);
  const linkedOwnedKey = useMemo(() => {
    if (!selectedSession || selectedSession.runtime !== 'codex' || selectedSession.runtimeSurface?.ownership !== 'discovered') return null;
    const cwd = selectedSession.runtimeSurface?.cwd ?? selectedSession.workspace ?? '';
    const owned = snapshot.sessions.find((s) =>
      s.runtime === 'codex' &&
      s.runtimeSurface?.ownership === 'owned' &&
      (s.runtimeSurface?.cwd === cwd || s.workspace === cwd),
    );
    return owned?.sessionKey ?? null;
  }, [selectedSession, snapshot.sessions]);
  // Initial linked history load
  useEffect(() => {
    if (linkedOwnedKey && !historyBySession[linkedOwnedKey] && !historyLoading[linkedOwnedKey]) {
      void loadHistory(linkedOwnedKey, true).catch(() => undefined);
    }
  }, [linkedOwnedKey, historyBySession, historyLoading, loadHistory]);
  // Unified sync polling — replaces separate session + linked + review file polling (5 requests → 1)
  useEffect(() => {
    return startUnifiedSyncPolling({
      selectedSessionKey,
      selectedSession,
      linkedOwnedKey,
      pendingOwnedTurnBySession,
      actionStateBySession,
      waitingForResponse,
      diffOpen,
      selectedReviewFilePath,
      documentVisibleRef,
      historyBySession,
      setSnapshot,
      setRefreshError,
      setHistoryBySession,
      setHistoryGroupsBySession,
      setReviewFileByPath,
      loadOwnedReviewPacket,
    });
  }, [
    actionStateBySession,
    diffOpen,
    historyBySession,
    linkedOwnedKey,
    loadOwnedReviewPacket,
    pendingOwnedTurnBySession,
    selectedReviewFilePath,
    selectedSession,
    selectedSessionKey,
    waitingForResponse,
  ]);
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
  const assistantCount = transcriptEntries.filter((e) => e.role === 'assistant').length;
  useEffect(() => {
    if (waitingForResponse && assistantCount > lastAssistantCountRef.current) {
      setWaitingForResponse(false);
    }
  }, [waitingForResponse, assistantCount]);
  const transcriptActionNote = selectedSessionKey ? actionNoteBySession[selectedSessionKey] ?? null : null;
  const latestTranscriptMarker = transcriptEntries[transcriptEntries.length - 1]?.id ?? 'empty';
  const scrollMarker = pendingOwnedTurn ? `${latestTranscriptMarker}:${pendingOwnedTurn.id}` : latestTranscriptMarker;
  const selectedReviewFile = selectedReviewFilePath ? reviewFileByPath[selectedReviewFilePath] : undefined;
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
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
  useEffect(() => {
    if (!selectedSessionKey?.startsWith('codex-owned:')) {
      return;
    }
    const pendingTurn = pendingOwnedTurnBySession[selectedSessionKey];
    if (!pendingTurn) {
      return;
    }
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
    if (!matchingGroup && !runSettledAgain) {
      return;
    }
    setPendingOwnedTurnBySession((current) => {
      if (!current[selectedSessionKey]) {
        return current;
      }
      const next = { ...current };
      delete next[selectedSessionKey];
      return next;
    });
  }, [historyGroupsBySession, pendingOwnedTurnBySession, selectedSession?.runtimeSurface?.capabilities.interrupt, selectedSession?.runtimeSurface?.capabilities.sendInput, selectedSessionKey, transcriptActionState]);
  const shellStyle = {
    '--remodex-header-progress': headerProgress.toFixed(3),
    '--remodex-dock-fade-progress': dockFadeProgress.toFixed(3),
    '--remodex-dock-motion-progress': dockMotionProgress.toFixed(3),
    '--remodex-compose-active': isComposerPrimed ? '1' : '0',
    '--remodex-viewport-top-offset': `${viewportTopOffset}px`,
  } as CSSProperties;
  useLayoutEffect(() => {
    return pinTranscriptToBottom({
      selectedSessionKey,
      transcriptEntries,
      transcriptGroups,
      pendingOwnedTurn,
      initialBottomPinBySessionRef,
      transcriptBottomRef,
      stickToBottomRef,
    });
  }, [pendingOwnedTurn, scrollMarker, selectedSessionKey, transcriptEntries, transcriptGroups]);
  async function handleAttachmentSelection(files: FileList | null) {
    await prepareImageAttachments({ selectedSessionKey, files, isChatSession, setSurfaceNote, setDraftAttachmentsBySession, composeRef });
  }
  function removeDraftAttachment(sessionKey: string, attachmentId: string) {
    removeImageAttachment({ sessionKey, attachmentId, setDraftAttachmentsBySession });
  }
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
  function handleApprovalApprove(approval: ApprovalRequest) {
    handleApprovalDecision(approval, 'approved');
  }
  function handleApprovalReject(approval: ApprovalRequest) {
    handleApprovalDecision(approval, 'rejected');
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
            onApprove={handleApprovalApprove}
            onReject={handleApprovalReject}
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
