'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalRequest } from '@/lib/json-render/demo-specs';
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
import { pickCurrentSession } from '../utils';

export interface MobileStateInit {
  initialSnapshot: MobileInboxSnapshot;
  initialTranscript?: { sessionKey: string; transcript: MobileTranscriptEntry[] };
  initialReviewFile?: MobileReviewFileResponse['file'] | null;
  initialOwnedReviewPacket?: RuntimeReviewPacket | null;
}

const MOBILE_SELECTED_SESSION_KEY_STORAGE = 'cortex.mobile.selected-session-key';

export function useMobileState(init: MobileStateInit) {
  const { initialSnapshot, initialTranscript, initialReviewFile, initialOwnedReviewPacket } = init;
  const initialSession = pickCurrentSession(initialSnapshot);

  // ── Core state ──
  const [snapshot, setSnapshot] = useState<MobileInboxSnapshot>(initialSnapshot);
  const [selectedId, setSelectedId] = useState(() => initialSession?.id ?? '');
  const [selectedSessionKeyHint, setSelectedSessionKeyHint] = useState(() => initialSession?.sessionKey ?? '');
  const [selectedSessionFallback, setSelectedSessionFallback] = useState<MobileInboxSnapshot['sessions'][number] | null>(() => initialSession ?? null);
  const [activeView, setActiveView] = useState<'squad' | 'chat' | 'costs' | 'fleet' | 'activity' | 'settings' | 'memory' | 'issues'>('squad');
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
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
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

  // ── Cortex memory surfaces ──
  const [squadPickerOpen, setSquadPickerOpen] = useState(false);
  const [cortexRecallOpen, setCortexRecallOpen] = useState(false);
  const [cortexHealthOpen, setCortexHealthOpen] = useState(false);
  const [cortexGraphOpen, setCortexGraphOpen] = useState(false);

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
  const selectedSessionFromSnapshot = useMemo(
    () => snapshot.sessions.find((session) => session.id === selectedId)
      ?? snapshot.sessions.find((session) => session.sessionKey === selectedSessionKeyHint)
      ?? null,
    [selectedId, selectedSessionKeyHint, snapshot],
  );
  const selectedSession = selectedSessionFromSnapshot
    ?? selectedSessionFallback
    ?? pickCurrentSession(snapshot);
  const selectedSessionKey = selectedSessionFromSnapshot?.sessionKey
    ?? selectedSessionFallback?.sessionKey
    ?? pickCurrentSession(snapshot)?.sessionKey;
  const isOpenClawSession = selectedSession?.runtime === 'openclaw';
  const isChatSession = isOpenClawSession || selectedSession?.runtime === 'codex' || selectedSession?.runtime === 'claude-code';
  const isOwnedCodexSession = selectedSession?.runtime === 'codex' && selectedSession?.runtimeSurface?.ownership === 'owned';
  const selectedReviewPacket = selectedSessionKey && isOwnedCodexSession ? reviewPacketBySession[selectedSessionKey] ?? null : null;
  const selectedReviewPacketError = selectedSessionKey && isOwnedCodexSession ? reviewPacketErrorBySession[selectedSessionKey] ?? null : null;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedSessionKey = window.localStorage.getItem(MOBILE_SELECTED_SESSION_KEY_STORAGE)?.trim();
    if (!savedSessionKey || savedSessionKey === selectedSessionKeyHint) return;
    setSelectedSessionKeyHint(savedSessionKey);
    const matchingSession = snapshot.sessions.find((session) => session.sessionKey === savedSessionKey);
    if (!matchingSession) return;
    setSelectedId(matchingSession.id);
    setSelectedSessionFallback(matchingSession);
  // Intentionally one-time restore: later session churn should not re-run storage hydration.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!selectedSessionKeyHint) return;
    window.localStorage.setItem(MOBILE_SELECTED_SESSION_KEY_STORAGE, selectedSessionKeyHint);
  }, [selectedSessionKeyHint]);

  return {
    // Core state + setters
    snapshot, setSnapshot,
    selectedId, setSelectedId,
    selectedSessionKeyHint, setSelectedSessionKeyHint,
    selectedSessionFallback, setSelectedSessionFallback,
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
    sessionInfoOpen, setSessionInfoOpen,
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
    squadPickerOpen, setSquadPickerOpen,
    expandedProject, setExpandedProject,

    // Cortex memory
    cortexRecallOpen, setCortexRecallOpen,
    cortexHealthOpen, setCortexHealthOpen,
    cortexGraphOpen, setCortexGraphOpen,

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
    isOpenClawSession, isChatSession, isOwnedCodexSession,
    selectedReviewPacket, selectedReviewPacketError,
  };
}

export type MobileState = ReturnType<typeof useMobileState>;
