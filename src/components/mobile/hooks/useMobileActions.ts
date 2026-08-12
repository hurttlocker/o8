/**
 * useMobileActions — Action handler wrappers that bridge state to controller functions.
 * Extracted from shell to reduce orchestration noise.
 */
import { useCallback, useEffect } from 'react';
import type { MobileApprovalCard } from '@/lib/approvals/types';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import { initSounds, playSendClick as playMobileSendClick } from '@/lib/mobile/sounds';
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
import { correlatedActionIsUnsettled } from '@/lib/orchestrator/action-receipt';

interface ActionDeps {
  wsConnected: boolean;
  refreshInbox: (fresh?: boolean, limit?: number) => Promise<MobileInboxSnapshot>;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
  loadOwnedReviewPacket: (sessionKey: string, force?: boolean) => Promise<RuntimeReviewPacket | null | undefined>;
  loadReviewFile: (reviewPath: string, force?: boolean) => Promise<MobileReviewFileResponse['file'] | undefined>;
  reviewFiles: RuntimeReviewPacket['changedFiles'];
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
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
    setSelection, setActiveView, setSurfaceNote,
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

  useEffect(() => {
    initSounds();
  }, []);

  const playSendClick = useCallback(() => {
    playMobileSendClick();
  }, []);

  const runAction = useCallback(async (payload: MobileActionRequest): Promise<MobileActionResponse | undefined> => {
    const clientMutationId = payload.clientMutationId
      ?? (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `mutation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    console.info('[mobile] runAction', {
      action: payload.action,
      sessionKey: payload.sessionKey,
      clientMutationId,
      cwd: payload.cwd,
      hasMessage: Boolean(payload.message?.trim()),
      attachmentCount: payload.attachments?.length ?? 0,
    });
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
      if (correlatedActionIsUnsettled(error)) {
        throw error;
      }
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
    console.info('[mobile] submit steer turn', {
      selectedSessionId: state.selectedSession?.id ?? null,
      selectedSessionKey: state.selectedSession?.sessionKey ?? selectedSessionKey ?? null,
      requestedSessionKey: sessionKey,
      transcriptEntries: transcriptEntries.length,
    });
    await submitSteerTurn({
      sessionKey,
      actionStateBySession,
      snapshot,
      selectedSession: state.selectedSession,
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
      runAction,
      loadHistory,
      playSendClick,
      relaySlashCommand,
    });
  }, [actionStateBySession, snapshot, draftBySession, draftAttachmentsBySession, state.historyBySession, state.selectedSession, selectedSessionKey, lastAssistantCountRef, setWaitingForResponse, setHistoryBySession, setDraftBySession, setDraftAttachmentsBySession, setPreEnhanceDraft, setSurfaceNote, setActionNoteBySession, runAction, loadHistory, playSendClick, relaySlashCommand]);

  const handleOwnedResumeSubmit = useCallback(async (sessionKey: string) => {
    await submitOwnedResumeTurn({
      sessionKey, actionStateBySession, draftBySession,
      setActionNoteBySession, setPendingOwnedTurnBySession,
      setDraftBySession, setSurfaceNote, runAction, playSendClick,
      relaySlashCommand,
    });
  }, [actionStateBySession, draftBySession, setActionNoteBySession, setPendingOwnedTurnBySession, setDraftBySession, setSurfaceNote, runAction, playSendClick, relaySlashCommand]);

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
      sessionId, snapshot, compactLine, setSelection, setActiveView, setControlsOpen, setDiffOpen,
      setSurfaceNote, setSelectedReviewFilePath, loadHistory, loadOwnedReviewPacket, loadReviewFile,
    });
  }, [snapshot, setSelection, setActiveView, setControlsOpen, setDiffOpen, setSurfaceNote, setSelectedReviewFilePath, loadHistory, loadOwnedReviewPacket, loadReviewFile]);

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

  const handleApprovalDecision = useCallback(async (approval: MobileApprovalCard, resolution: 'approved' | 'rejected') => {
    setResolvedApprovals((current) => ({ ...current, [approval.id]: resolution }));
    setSurfaceNote(`${resolution === 'approved' ? 'Approving' : 'Rejecting'}: ${approval.title}`);
    try {
      const result = await runAction({
        action: resolution === 'approved' ? 'approve' : 'deny',
        sessionKey: approval.sessionKey,
        approvalId: approval.id,
      });
      setSurfaceNote(result?.note ?? `${resolution === 'approved' ? 'Approved' : 'Rejected'}: ${approval.title}`);
      window.setTimeout(() => {
        setPendingApprovals((current) => current.filter((item) => item.id !== approval.id));
      }, 300);
    } catch (error) {
      setResolvedApprovals((current) => {
        const next = { ...current };
        delete next[approval.id];
        return next;
      });
      setSurfaceNote(error instanceof Error ? error.message : `Unable to ${resolution === 'approved' ? 'approve' : 'reject'} this request.`);
    }
  }, [runAction, setPendingApprovals, setResolvedApprovals, setSurfaceNote]);

  const handleToggleApprovals = useCallback(() => {
    setActiveView('activity');
    setControlsOpen(false);
  }, [setActiveView, setControlsOpen]);

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

  const ownedReviewDisposition = selectedReviewPacket?.reviewDisposition;

  const composeBarHandlers = {
    // onSend/onOwnedResume accept an explicit sessionKey from ComposeBar
    // to avoid stale closure from snapshot refresh races.
    onSend: (explicitKey?: string) => {
      const key = explicitKey || selectedSessionKey;
      if (key) return handleSteerSubmit(key);
    },
    onOwnedResume: (explicitKey?: string) => {
      const key = explicitKey || selectedSessionKey;
      if (key) return handleOwnedResumeSubmit(key);
    },
    onEnhance: handleEnhancePrompt,
    onUndoEnhance: handleUndoEnhance,
    onAttach: () => fileInputRef.current?.click(),
    onAttachFiles: handleAttachmentSelection,
    onRemoveAttachment: (attachmentId: string) => {
      if (selectedSessionKey) removeDraftAttachment(selectedSessionKey, attachmentId);
    },
    onRefresh: handleSurfaceRefresh,
    onStop: handleStopActiveRun,
    onInterrupt: handleStopActiveRun,
    onOpenDiff: openDiffViewer,
    onLoadCorrectionDraft: () => {
      if (selectedSessionKey) handleLoadOwnedCorrectionDraft(selectedSessionKey);
    },
    onToggleOwnedReviewDisposition: () => {
      if (selectedSessionKey) handleOwnedReviewDisposition(ownedReviewDisposition === 'resolved' ? 'watch' : 'resolve', selectedSessionKey);
    },
    onDraftChange: (value: string) => {
      if (selectedSessionKey) setDraftBySession((current) => ({ ...current, [selectedSessionKey]: value }));
    },
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
