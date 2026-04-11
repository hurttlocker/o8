'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MobileApprovalCard } from '@/lib/approvals/types';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import type {
  MobileInboxSnapshot,
  MobileReviewFileResponse,
  MobileRuntimeTailGroup,
  MobileTranscriptEntry,
  MobileTranscriptMedia,
} from '@/lib/mobile/types';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';
import type { DraftAttachment, PendingOwnedTurn } from '../types';
import { pickHomeSession } from '../utils';

export interface MobileStateInit {
  initialSnapshot: MobileInboxSnapshot;
  initialTranscript?: { sessionKey: string; transcript: MobileTranscriptEntry[] };
  initialReviewFile?: MobileReviewFileResponse['file'] | null;
  initialOwnedReviewPacket?: RuntimeReviewPacket | null;
}

export interface MobileSelectionState {
  id: string;
  sessionKey: string;
  fallback: MobileInboxSnapshot['sessions'][number] | null;
}

export function useMobileState(init: MobileStateInit) {
  const { initialSnapshot, initialTranscript, initialReviewFile, initialOwnedReviewPacket } = init;
  const initialSession = pickHomeSession(initialSnapshot);

  // ── Core state ──
  const [snapshot, setSnapshot] = useState<MobileInboxSnapshot>(initialSnapshot);
  const [selection, setSelection] = useState<MobileSelectionState>(() => ({
    id: initialSession?.id ?? '',
    sessionKey: initialSession?.sessionKey ?? '',
    fallback: initialSession ?? null,
  }));
  const [activeView, setActiveView] = useState<'squad' | 'chat' | 'costs' | 'fleet' | 'activity' | 'settings' | 'issues'>('squad');
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [surfaceNote, setSurfaceNote] = useState<string | null>(null);

  // ── History ──
  const [historyBySession, setHistoryBySession] = useState<Record<string, MobileTranscriptEntry[]>>(() => (
    initialTranscript?.sessionKey ? { [initialTranscript.sessionKey]: initialTranscript.transcript } : {}
  ));
  // Stable ref for historyBySession — used by polling to read latest state
  // without putting historyBySession in the polling effect's dependency array
  // (which would cause a restart loop: poll → update history → restart effect → immediate poll).
  // Synced in an effect to avoid render-time ref mutation (#195).
  const historyBySessionRef = useRef(historyBySession);
  useEffect(() => { historyBySessionRef.current = historyBySession; }, [historyBySession]);

  const [historyGroupsBySession, setHistoryGroupsBySession] = useState<Record<string, MobileRuntimeTailGroup[]>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [historyError, setHistoryError] = useState<Record<string, string | null>>({});

  // ── Review ──
  const [reviewPacketBySession, setReviewPacketBySession] = useState<Record<string, RuntimeReviewPacket>>(() => (
    initialOwnedReviewPacket ? { [initialOwnedReviewPacket.surfaceId]: initialOwnedReviewPacket } : {}
  ));
  const [reviewPacketLoadingBySession, setReviewPacketLoadingBySession] = useState<Record<string, boolean>>({});
  const [reviewPacketErrorBySession, setReviewPacketErrorBySession] = useState<Record<string, string | null>>({});
  const [selectedReviewFilePath, setSelectedReviewFilePath] = useState<string | null>(() => (
    initialReviewFile?.path ?? initialOwnedReviewPacket?.changedFiles[0]?.path ?? initialSnapshot.review?.changedFiles[0]?.path ?? null
  ));
  const [reviewFileByPath, setReviewFileByPath] = useState<Record<string, MobileReviewFileResponse['file']>>(() => (
    initialReviewFile ? { [initialReviewFile.path]: initialReviewFile } : {}
  ));
  const [reviewFileLoadingPath, setReviewFileLoadingPath] = useState<string | null>(null);
  const [reviewFileError, setReviewFileError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  // ── Compose / actions ──
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>({});
  const [actionStateBySession, setActionStateBySession] = useState<Record<string, 'idle' | 'steering' | 'stopping' | 'reviewing'>>({});
  const [actionNoteBySession, setActionNoteBySession] = useState<Record<string, string | null>>({});
  const [draftAttachmentsBySession, setDraftAttachmentsBySession] = useState<Record<string, DraftAttachment[]>>({});
  const [pendingOwnedTurnBySession, setPendingOwnedTurnBySession] = useState<Record<string, PendingOwnedTurn>>({});
  const [realtimeMutationsById, setRealtimeMutationsById] = useState<Record<string, RealtimeMutationRecord>>({});
  const [pendingMutationIdBySession, setPendingMutationIdBySession] = useState<Record<string, string>>({});
  const pendingMutationIdBySessionRef = useRef(pendingMutationIdBySession);
  useEffect(() => { pendingMutationIdBySessionRef.current = pendingMutationIdBySession; }, [pendingMutationIdBySession]);
  const [enhancing, setEnhancing] = useState(false);
  const [preEnhanceDraft, setPreEnhanceDraft] = useState<string | null>(null);

  // ── UI chrome ──
  const [controlsOpen, setControlsOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<MobileApprovalCard[]>(() => initialSnapshot.approvals ?? []);
  const [resolvedApprovals, setResolvedApprovals] = useState<Record<string, 'approved' | 'rejected'>>({});
  const [surfaceRefreshing, setSurfaceRefreshing] = useState(false);
  const [expandedMedia, setExpandedMedia] = useState<MobileTranscriptMedia | null>(null);
  const [scrollY, setScrollY] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [viewportTopOffset, setViewportTopOffset] = useState(0);
  const [composeFocused, setComposeFocused] = useState(false);
  const [composeHeight, setComposeHeight] = useState(120);
  const [waitingForResponse, setWaitingForResponse] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  // ── Streaming ──
  const [streamingText, setStreamingText] = useState('');
  const streamingTextRef = useRef('');

  // ── Refs ──
  const composeRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null);
  const scrollStopTimerRef = useRef<number | null>(null);
  const headerRevealTimerRef = useRef<number | null>(null);
  const initialBottomPinBySessionRef = useRef<Record<string, boolean>>({});
  const stickToBottomRef = useRef(true);
  const lastAssistantCountRef = useRef(0);
  const seenMessageIdsRef = useRef<Set<string> | null>(null);
  const documentVisibleRef = useRef(true);
  const attachmentPreviewUrlsRef = useRef<Record<string, string>>({});
  const recoveredSelectionRef = useRef<string>('');

  useEffect(() => {
    const nextPreviewUrls: Record<string, string> = {};
    for (const [sessionKey, attachments] of Object.entries(draftAttachmentsBySession)) {
      for (const attachment of attachments) {
        nextPreviewUrls[`${sessionKey}:${attachment.id}`] = attachment.previewUrl;
      }
    }

    for (const [attachmentKey, previewUrl] of Object.entries(attachmentPreviewUrlsRef.current)) {
      if (!(attachmentKey in nextPreviewUrls)) {
        URL.revokeObjectURL(previewUrl);
      }
    }

    attachmentPreviewUrlsRef.current = nextPreviewUrls;
  }, [draftAttachmentsBySession]);

  useEffect(() => {
    return () => {
      for (const previewUrl of Object.values(attachmentPreviewUrlsRef.current)) {
        URL.revokeObjectURL(previewUrl);
      }
      attachmentPreviewUrlsRef.current = {};
    };
  }, []);

  // ── Derived ──
  const selectedId = selection.id;
  const selectedSessionKeyHint = selection.sessionKey;
  const selectedSessionFallback = selection.fallback;
  const selectedSessionFromSnapshot = useMemo(
    () => snapshot.sessions.find((session) => session.sessionKey === selectedSessionKeyHint)
      ?? snapshot.sessions.find((session) => session.id === selectedId)
      ?? null,
    [selectedId, selectedSessionKeyHint, snapshot],
  );
  const hasPinnedSelection = Boolean(selectedSessionKeyHint || selectedId || selectedSessionFallback?.sessionKey);
  const homeSession = pickHomeSession(snapshot);
  const missingPinnedFallback = snapshot.sessions.length === 0 && hasPinnedSelection
    ? (selectedSessionFallback ?? undefined)
    : undefined;
  const selectedSession = selectedSessionFromSnapshot
    ?? missingPinnedFallback
    ?? (!hasPinnedSelection ? homeSession : undefined);
  const selectedSessionKey = selectedSessionFromSnapshot?.sessionKey
    ?? missingPinnedFallback?.sessionKey
    ?? (snapshot.sessions.length === 0 && hasPinnedSelection
      ? selectedSessionKeyHint || selectedSessionFallback?.sessionKey
      : undefined)
    ?? (!hasPinnedSelection ? homeSession?.sessionKey : undefined);
  const isChatSession = selectedSession?.runtime === 'codex' || selectedSession?.runtime === 'claude-code' || selectedSession?.runtime === 'chat';
  const isOwnedCodexSession = selectedSession?.runtime === 'codex' && selectedSession?.runtimeSurface?.ownership === 'owned';
  const selectedReviewPacket = selectedSessionKey && isOwnedCodexSession ? reviewPacketBySession[selectedSessionKey] ?? null : null;
  const selectedReviewPacketError = selectedSessionKey && isOwnedCodexSession ? reviewPacketErrorBySession[selectedSessionKey] ?? null : null;

  useEffect(() => {
    if (selectedSessionFromSnapshot) {
      recoveredSelectionRef.current = '';
      setSelection((current) => {
        if (
          current.id === selectedSessionFromSnapshot.id
          && current.sessionKey === selectedSessionFromSnapshot.sessionKey
          && current.fallback?.id === selectedSessionFromSnapshot.id
          && current.fallback?.sessionKey === selectedSessionFromSnapshot.sessionKey
        ) {
          return current;
        }
        if (current.sessionKey !== selectedSessionFromSnapshot.sessionKey || current.id !== selectedSessionFromSnapshot.id) {
          console.info('[mobile] canonicalizing selected session', {
            selectedId: current.id,
            selectedSessionKeyHint: current.sessionKey,
            nextId: selectedSessionFromSnapshot.id,
            nextSessionKey: selectedSessionFromSnapshot.sessionKey,
          });
        }
        return {
          id: selectedSessionFromSnapshot.id,
          sessionKey: selectedSessionFromSnapshot.sessionKey,
          fallback: selectedSessionFromSnapshot,
        };
      });
      return;
    }

    if (!selectedSessionFallback) return;
    if (snapshot.sessions.length === 0) {
      console.info('[mobile] selected session missing while live inventory is empty; keeping last known selection', {
        missingId: selectedSessionFallback.id,
        missingSessionKey: selectedSessionFallback.sessionKey,
        selectedId,
        selectedSessionKeyHint,
      });
      return;
    }
    const nextSession = pickHomeSession(snapshot);
    const recoveryKey = `${selectedSessionFallback.sessionKey}->${nextSession?.sessionKey ?? 'picker'}`;
    if (recoveredSelectionRef.current === recoveryKey) return;
    recoveredSelectionRef.current = recoveryKey;
    if (!nextSession) {
      console.info('[mobile] selected session missing and no active home session is available; clearing selection', {
        missingId: selectedSessionFallback.id,
        missingSessionKey: selectedSessionFallback.sessionKey,
        selectedId,
        selectedSessionKeyHint,
        availableSessionKeys: snapshot.sessions.map((session) => session.sessionKey),
      });
      setSelection((current) => (
        current.id || current.sessionKey || current.fallback
          ? { id: '', sessionKey: '', fallback: null }
          : current
      ));
      setActiveView('squad');
      setSurfaceNote('No active session is available. Pick a recent thread.');
      return;
    }
    console.info('[mobile] selected session missing from latest snapshot; recovering to live fallback', {
      missingId: selectedSessionFallback.id,
      missingSessionKey: selectedSessionFallback.sessionKey,
      recoveredId: nextSession.id,
      recoveredSessionKey: nextSession.sessionKey,
      selectedId,
      selectedSessionKeyHint,
      availableSessionKeys: snapshot.sessions.map((session) => session.sessionKey),
    });
    setSelection((current) => (
      current.id === nextSession.id
      && current.sessionKey === nextSession.sessionKey
      && current.fallback?.id === nextSession.id
      && current.fallback?.sessionKey === nextSession.sessionKey
        ? current
        : {
            id: nextSession.id,
            sessionKey: nextSession.sessionKey,
            fallback: nextSession,
          }
    ));
    setSurfaceNote(`Recovered to ${nextSession.name}. Previous session is no longer live.`);
  }, [selectedId, selectedSessionFallback, selectedSessionFromSnapshot, selectedSessionKeyHint, setActiveView, setSelection, setSurfaceNote, snapshot]);

  return {
    // Core state + setters
    snapshot, setSnapshot,
    selection, setSelection,
    selectedId,
    selectedSessionKeyHint,
    selectedSessionFallback,
    activeView, setActiveView,
    refreshError, setRefreshError,
    surfaceNote, setSurfaceNote,

    // History
    historyBySession, setHistoryBySession, historyBySessionRef,
    historyGroupsBySession, setHistoryGroupsBySession,
    historyLoading, setHistoryLoading,
    historyError, setHistoryError,

    // Review
    reviewPacketBySession, setReviewPacketBySession,
    reviewPacketLoadingBySession, setReviewPacketLoadingBySession,
    reviewPacketErrorBySession, setReviewPacketErrorBySession,
    selectedReviewFilePath, setSelectedReviewFilePath,
    reviewFileByPath, setReviewFileByPath,
    reviewFileLoadingPath, setReviewFileLoadingPath,
    reviewFileError, setReviewFileError,
    diffOpen, setDiffOpen,

    // Compose / actions
    draftBySession, setDraftBySession,
    actionStateBySession, setActionStateBySession,
    actionNoteBySession, setActionNoteBySession,
    draftAttachmentsBySession, setDraftAttachmentsBySession,
    pendingOwnedTurnBySession, setPendingOwnedTurnBySession,
    realtimeMutationsById, setRealtimeMutationsById,
    pendingMutationIdBySession, setPendingMutationIdBySession,
    pendingMutationIdBySessionRef,
    enhancing, setEnhancing,
    preEnhanceDraft, setPreEnhanceDraft,

    // UI chrome
    controlsOpen, setControlsOpen,
    alertsOpen, setAlertsOpen,
    sessionPickerOpen, setSessionPickerOpen,
    pendingApprovals, setPendingApprovals,
    resolvedApprovals, setResolvedApprovals,
    surfaceRefreshing, setSurfaceRefreshing,
    expandedMedia, setExpandedMedia,
    scrollY, setScrollY,
    isScrolling, setIsScrolling,
    headerVisible, setHeaderVisible,
    viewportTopOffset, setViewportTopOffset,
    composeFocused, setComposeFocused,
    composeHeight, setComposeHeight,
    waitingForResponse, setWaitingForResponse,
    hydrated, setHydrated,
    expandedProject, setExpandedProject,

    // Streaming
    streamingText, setStreamingText,
    streamingTextRef,

    // Refs
    composeRef, fileInputRef, transcriptBottomRef,
    scrollStopTimerRef, headerRevealTimerRef,
    initialBottomPinBySessionRef, stickToBottomRef,
    lastAssistantCountRef, seenMessageIdsRef,
    documentVisibleRef,

    // Derived
    selectedSession, selectedSessionKey,
    isChatSession, isOwnedCodexSession,
    selectedReviewPacket, selectedReviewPacketError,
  };
}

export type MobileState = ReturnType<typeof useMobileState>;
