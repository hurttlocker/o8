/**
 * useMobileActions — Action handler wrappers that bridge state to controller functions.
 * Extracted from shell to reduce orchestration noise.
 */
import { useCallback } from 'react';
import { demoApprovals } from '@/lib/json-render/demo-specs';
import type { ApprovalRequest } from '@/lib/json-render/demo-specs';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import type { MobileActionRequest, MobileActionResponse, MobileInboxSnapshot, MobileReviewFileResponse } from '@/lib/mobile/types';
import type { MobileState } from './useMobileState';
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
} from '../controller';
import { compactLine } from '../utils';

interface ActionDeps {
  wsConnected: boolean;
  refreshInbox: () => Promise<MobileInboxSnapshot>;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
  loadOwnedReviewPacket: (sessionKey: string, force?: boolean) => Promise<RuntimeReviewPacket | null | undefined>;
  loadReviewFile: (reviewPath: string, force?: boolean) => Promise<MobileReviewFileResponse['file'] | undefined>;
  reviewFiles: RuntimeReviewPacket['changedFiles'];
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
}

let sendClickAudioContext: AudioContext | null = null;

function playSendClick() {
  try {
    const AudioContextCtor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    if (!sendClickAudioContext || sendClickAudioContext.state === 'closed') {
      sendClickAudioContext = new AudioContextCtor();
    }

    const ctx = sendClickAudioContext;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }

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
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } catch { /* audio not available */ }
}

export function useMobileActions(state: MobileState, deps: ActionDeps) {
  const {
    refreshInbox,
    loadHistory,
    loadOwnedReviewPacket,
    loadReviewFile,
    reviewFiles,
    sendTerminalAttach,
    sendTerminalInput,
  } = deps;
  const {
    snapshot, selectedSessionKey, isChatSession, isOwnedCodexSession,
    selectedReviewPacket, reviewPacketBySession, reviewFileByPath,
    selectedReviewFilePath, draftBySession, actionStateBySession,
    draftAttachmentsBySession, enhancing, preEnhanceDraft,
    setSelectedId, setSelectedSessionKeyHint, setSelectedSessionFallback, setActiveView, setSurfaceNote,
    setDraftBySession, setActionStateBySession, setActionNoteBySession,
    setDraftAttachmentsBySession, setPendingOwnedTurnBySession,
    setRealtimeMutationsById, setPendingMutationIdBySession,
    pendingMutationIdBySessionRef,
    setEnhancing, setPreEnhanceDraft,
    setControlsOpen, setPendingApprovals, setResolvedApprovals,
    setSurfaceRefreshing, setSelectedReviewFilePath,
    setDiffOpen, setHistoryBySession, setReviewPacketBySession,
    setWaitingForResponse, setComposeFocused,
    composeRef, fileInputRef, lastAssistantCountRef,
  } = state;

  const runAction = useCallback(async (payload: MobileActionRequest): Promise<MobileActionResponse | undefined> => {
    const clientMutationId = payload.clientMutationId
      ?? (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `mutation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    if (payload.sessionKey) {
      pendingMutationIdBySessionRef.current = {
        ...pendingMutationIdBySessionRef.current,
        [payload.sessionKey]: clientMutationId,
      };
      setPendingMutationIdBySession((current) => ({ ...current, [payload.sessionKey]: clientMutationId }));
      setRealtimeMutationsById((current) => ({
        ...current,
        [clientMutationId]: {
          mutationId: clientMutationId,
          source: 'mobile',
          action: payload.action,
          status: 'pending',
          sessionKey: payload.sessionKey,
          surfaceId: payload.sessionKey,
          createdAt: new Date().toISOString(),
          optimistic: true,
        },
      }));
    }
    try {
      return await runMobileAction({
        payload: { ...payload, clientMutationId },
        setActionStateBySession,
        setActionNoteBySession,
        // Mobile should reconcile truth through HTTP even when WS reports
        // connected, because mobile browser WS delivery is less reliable
        // than desktop and we can't let chat targeting depend on it.
        realtimeEnabled: false,
        refreshInbox,
        loadHistory,
        loadOwnedReviewPacket,
      });
    } catch (error) {
      if (payload.sessionKey) {
        if (pendingMutationIdBySessionRef.current[payload.sessionKey] === clientMutationId) {
          const nextPending = { ...pendingMutationIdBySessionRef.current };
          delete nextPending[payload.sessionKey];
          pendingMutationIdBySessionRef.current = nextPending;
        }
        setPendingMutationIdBySession((current) => {
          if (current[payload.sessionKey] !== clientMutationId) return current;
          const next = { ...current };
          delete next[payload.sessionKey];
          return next;
        });
        setRealtimeMutationsById((current) => ({
          ...current,
          [clientMutationId]: {
            ...(current[clientMutationId] ?? {
              mutationId: clientMutationId,
              source: 'mobile',
              action: payload.action,
              sessionKey: payload.sessionKey,
              surfaceId: payload.sessionKey,
              createdAt: new Date().toISOString(),
            }),
            status: 'failed',
            note: error instanceof Error ? error.message : 'Mobile action failed before reconciliation.',
            settledAt: new Date().toISOString(),
          },
        }));
      }
      throw error;
    }
  }, [pendingMutationIdBySessionRef, setPendingMutationIdBySession, setRealtimeMutationsById, setActionStateBySession, setActionNoteBySession, refreshInbox, loadHistory, loadOwnedReviewPacket]);

  const relaySlashCommand = useCallback(async (sessionKey: string, commandText: string) => {
    const session = snapshot.sessions.find((item) => item.sessionKey === sessionKey);
    const supportsTerminalRelay = Boolean(
      session?.tmuxSession && (session.runtime === 'codex' || session.runtime === 'claude-code'),
    );
    if (!supportsTerminalRelay || !session?.tmuxSession) {
      return false;
    }
    sendTerminalAttach(session.tmuxSession, 120, 32);
    await new Promise((resolve) => setTimeout(resolve, 120));
    sendTerminalInput(session.tmuxSession, commandText);
    return true;
  }, [snapshot.sessions, sendTerminalAttach, sendTerminalInput]);

  const handleSteerSubmit = useCallback(async (sessionKey: string) => {
    const transcriptEntries = state.historyBySession[sessionKey] ?? [];
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
      setSelectedSessionKeyHint,
      setSelectedSessionFallback,
      runAction,
      refreshInbox,
      loadHistory,
      playSendClick,
      relaySlashCommand,
    });
  }, [actionStateBySession, snapshot, draftBySession, draftAttachmentsBySession, state.historyBySession, lastAssistantCountRef, setWaitingForResponse, setHistoryBySession, setDraftBySession, setDraftAttachmentsBySession, setPreEnhanceDraft, setSurfaceNote, setActionNoteBySession, setSelectedId, setSelectedSessionKeyHint, setSelectedSessionFallback, runAction, refreshInbox, loadHistory, relaySlashCommand]);

  const handleOwnedResumeSubmit = useCallback(async (sessionKey: string) => {
    await submitOwnedResumeTurn({
      sessionKey, actionStateBySession, draftBySession,
      setActionNoteBySession, setPendingOwnedTurnBySession,
      setDraftBySession, setSurfaceNote, runAction, playSendClick,
      relaySlashCommand,
    });
  }, [actionStateBySession, draftBySession, setActionNoteBySession, setPendingOwnedTurnBySession, setDraftBySession, setSurfaceNote, runAction, relaySlashCommand]);

  const handleEnhancePrompt = useCallback(async () => {
    await enhancePromptDraft({ selectedSessionKey, enhancing, draftBySession, setEnhancing, setPreEnhanceDraft, setDraftBySession, setSurfaceNote });
  }, [selectedSessionKey, enhancing, draftBySession, setEnhancing, setPreEnhanceDraft, setDraftBySession, setSurfaceNote]);

  const handleUndoEnhance = useCallback(() => {
    if (!selectedSessionKey || preEnhanceDraft === null) return;
    setDraftBySession((current) => ({ ...current, [selectedSessionKey]: preEnhanceDraft }));
    setPreEnhanceDraft(null);
  }, [selectedSessionKey, preEnhanceDraft, setDraftBySession, setPreEnhanceDraft]);

  const handleAttachmentSelection = useCallback(async (files: FileList | null) => {
    await prepareImageAttachments({
      selectedSessionKey,
      files,
      isChatSession,
      draftAttachmentsBySession,
      setSurfaceNote,
      setDraftAttachmentsBySession,
      composeRef,
    });
  }, [selectedSessionKey, isChatSession, draftAttachmentsBySession, setSurfaceNote, setDraftAttachmentsBySession, composeRef]);

  const removeDraftAttachment = useCallback((sessionKey: string, attachmentId: string) => {
    removeImageAttachment({ sessionKey, attachmentId, setDraftAttachmentsBySession });
  }, [setDraftAttachmentsBySession]);

  const handleLoadOwnedCorrectionDraft = useCallback((sessionKey: string) => {
    loadOwnedCorrectionDraftForSession({ sessionKey, reviewPacketBySession, setDraftBySession, setActionNoteBySession, composeRef });
  }, [reviewPacketBySession, setDraftBySession, setActionNoteBySession, composeRef]);

  const handleOwnedReviewDisposition = useCallback(async (action: 'watch' | 'resolve', sessionKey: string) => {
    await updateOwnedReviewDisposition({
      action, sessionKey, reviewPacketBySession, setReviewPacketBySession,
      setActionNoteBySession, setSurfaceNote, runAction, loadOwnedReviewPacket,
    });
  }, [reviewPacketBySession, setReviewPacketBySession, setActionNoteBySession, setSurfaceNote, runAction, loadOwnedReviewPacket]);

  const handleCopy = useCallback((text: string) => {
    copyTextToClipboard({ text, setSurfaceNote });
  }, [setSurfaceNote]);

  const handleSurfaceRefresh = useCallback(async () => {
    setSurfaceRefreshing(true);
    try {
      await refreshMobileSurface({ selectedSessionKey, selectedReviewFilePath, refreshInbox, loadHistory, loadOwnedReviewPacket, loadReviewFile, setSurfaceNote });
    } finally {
      setSurfaceRefreshing(false);
    }
  }, [selectedSessionKey, selectedReviewFilePath, refreshInbox, loadHistory, loadOwnedReviewPacket, loadReviewFile, setSurfaceNote, setSurfaceRefreshing]);

  const handleSessionFocus = useCallback((sessionId: string) => {
    focusSessionSurface({
      sessionId, snapshot, compactLine, setSelectedId, setSelectedSessionKeyHint, setSelectedSessionFallback, setActiveView, setControlsOpen, setDiffOpen,
      setSurfaceNote, setSelectedReviewFilePath, loadHistory, loadOwnedReviewPacket, loadReviewFile,
    });
  }, [snapshot, setSelectedId, setSelectedSessionKeyHint, setSelectedSessionFallback, setActiveView, setControlsOpen, setDiffOpen, setSurfaceNote, setSelectedReviewFilePath, loadHistory, loadOwnedReviewPacket, loadReviewFile]);

  const handleStopActiveRun = useCallback(async () => {
    const canInterruptOwnedCodex = Boolean(isOwnedCodexSession && state.selectedSession?.runtimeSurface?.capabilities.interrupt);
    await stopActiveRunFromSurface({ selectedSessionKey, isChatSession, canInterruptOwnedCodex, isOwnedCodexSession, runAction, setSurfaceNote, setControlsOpen });
  }, [selectedSessionKey, isChatSession, isOwnedCodexSession, state.selectedSession?.runtimeSurface?.capabilities.interrupt, runAction, setSurfaceNote, setControlsOpen]);

  const openDiffViewer = useCallback(() => {
    openDiffViewerForSession({
      reviewFiles, selectedReviewFilePath, reviewFileByPath,
      setSurfaceNote, setSelectedReviewFilePath, setControlsOpen, setDiffOpen, loadReviewFile,
    });
  }, [reviewFiles, selectedReviewFilePath, reviewFileByPath, setSurfaceNote, setSelectedReviewFilePath, setControlsOpen, setDiffOpen, loadReviewFile]);

  const handleReviewFileFocus = useCallback((reviewPath: string) => {
    setSelectedReviewFilePath(reviewPath);
    void loadReviewFile(reviewPath).catch(() => undefined);
  }, [setSelectedReviewFilePath, loadReviewFile]);

  const handleApprovalDecision = useCallback((approval: ApprovalRequest, resolution: 'approved' | 'rejected') => {
    setResolvedApprovals((current) => ({ ...current, [approval.id]: resolution }));
    setSurfaceNote(`${resolution === 'approved' ? '✅ Approved' : '❌ Rejected'}: ${approval.title}`);
    window.setTimeout(() => setPendingApprovals((current) => current.filter((item) => item.id !== approval.id)), 1500);
  }, [setResolvedApprovals, setSurfaceNote, setPendingApprovals]);

  const handleToggleApprovals = useCallback(() => {
    setPendingApprovals((current) => (current.length > 0 ? [] : [...demoApprovals]));
    setResolvedApprovals({});
    setControlsOpen(false);
  }, [setPendingApprovals, setResolvedApprovals, setControlsOpen]);

  const handleCopySelectedSessionKey = useCallback(() => {
    if (!selectedSessionKey) return;
    handleCopy(selectedSessionKey);
    setControlsOpen(false);
  }, [selectedSessionKey, handleCopy, setControlsOpen]);

  const handleControlsRefresh = useCallback(() => {
    void handleSurfaceRefresh();
    setControlsOpen(false);
  }, [handleSurfaceRefresh, setControlsOpen]);

  const handleDiffRefresh = useCallback(() => {
    if (selectedReviewFilePath) {
      void loadReviewFile(selectedReviewFilePath, true);
      return;
    }
    void handleSurfaceRefresh();
  }, [selectedReviewFilePath, loadReviewFile, handleSurfaceRefresh]);

  const withSelectedSession = useCallback(<Args extends unknown[]>(fn: (sessionKey: string, ...args: Args) => void | Promise<void>) =>
    (...args: Args): void | Promise<void> => (selectedSessionKey ? fn(selectedSessionKey, ...args) : undefined),
  [selectedSessionKey]);

  const ownedReviewDisposition = selectedReviewPacket?.reviewDisposition;

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

  return {
    runAction,
    handleSteerSubmit,
    handleOwnedResumeSubmit,
    handleEnhancePrompt,
    handleUndoEnhance,
    handleAttachmentSelection,
    removeDraftAttachment,
    handleLoadOwnedCorrectionDraft,
    handleOwnedReviewDisposition,
    handleCopy,
    handleSurfaceRefresh,
    handleSessionFocus,
    handleStopActiveRun,
    openDiffViewer,
    handleReviewFileFocus,
    handleApprovalDecision,
    handleToggleApprovals,
    handleCopySelectedSessionKey,
    handleControlsRefresh,
    handleDiffRefresh,
    composeBarHandlers,
  };
}
