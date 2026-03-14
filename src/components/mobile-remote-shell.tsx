'use client';

import Image from 'next/image';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  Menu,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { demoApprovals } from '@/lib/json-render/demo-specs';
import type { ApprovalRequest } from '@/lib/json-render/demo-specs';
import type { ReviewChangedFile, RuntimeReviewPacket } from '@/lib/fleet/types';
import type {
  MobileActionRequest,
  MobileActionResponse,
  MobileHistoryResponse,
  MobileInboxSnapshot,
  MobileReviewFileResponse,
  MobileRuntimeTailGroup,
  MobileTranscriptEntry,
  MobileTranscriptMedia,
} from '@/lib/mobile/types';

import type { DraftAttachment, PendingOwnedTurn, ProjectGroup } from './mobile/types';
import {
  agentDisplayName,
  buildOwnedCorrectionDraft,
  compactLine,
  contextPressureTone,
  contextTrendLabel,
  fileToDataUrl,
  isImageMedia,
  mediaHref,
  ownedLifecycleLabel,
  ownedLifecycleTone,
  ownedOutcomeLabel,
  ownedReviewDispositionLabel,
  pickCurrentSession,
  projectDisplayName,
  projectSummary,
  readJson,
  renderMessageBody,
} from './mobile/utils';
import { ApprovalStack } from './mobile/ApprovalStack';
import { TokenUsageSummary } from './mobile/TokenUsageSummary';
import { ChatView } from './mobile/ChatView';
import { CostsDashboard } from './mobile/CostsDashboard';
import { SquadRail } from './mobile/SquadRail';
import { ComposeBar } from './mobile/ComposeBar';
import { ControlsSheet } from './mobile/ControlsSheet';
import { DiffOverlay } from './mobile/DiffOverlay';

const mobileClockFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

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

  // Lock body scroll when diff overlay is open (iOS Safari requires JS approach)
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

  const refreshInbox = useCallback(async () => {
    const response = await fetch(`/api/mobile/inbox?_t=${Date.now()}`, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const nextSnapshot = (await response.json()) as MobileInboxSnapshot;
    // Only update state if snapshot meaningfully changed — prevents cascade re-renders
    setSnapshot((prev) => {
      // Compare session count + statuses + context usage as a fast equality check
      // Round usedPercent to nearest integer — fractional changes shouldn't trigger re-renders
      const prevKey = prev.sessions.map((s) => `${s.sessionKey}:${s.status}:${Math.round(s.context?.usedPercent ?? 0)}`).join('|');
      const nextKey = nextSnapshot.sessions.map((s) => `${s.sessionKey}:${s.status}:${Math.round(s.context?.usedPercent ?? 0)}`).join('|');
      if (prevKey === nextKey && prev.summary.alerts === nextSnapshot.summary.alerts) {
        return prev; // same reference — React skips re-render
      }
      return nextSnapshot;
    });
    setRefreshError(null);
    return nextSnapshot;
  }, []);

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
    const readViewportTopOffset = () => {
      const nextOffset = typeof window === 'undefined'
        ? 0
        : Math.max(0, Math.round(window.visualViewport?.offsetTop ?? 0));
      setViewportTopOffset((current) => (current === nextOffset ? current : nextOffset));
    };

    readViewportTopOffset();
    window.visualViewport?.addEventListener('resize', readViewportTopOffset);
    window.visualViewport?.addEventListener('scroll', readViewportTopOffset);
    window.addEventListener('orientationchange', readViewportTopOffset);

    return () => {
      window.visualViewport?.removeEventListener('resize', readViewportTopOffset);
      window.visualViewport?.removeEventListener('scroll', readViewportTopOffset);
      window.removeEventListener('orientationchange', readViewportTopOffset);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function refreshLiveInbox() {
      try {
        const nextSnapshot = await fetch('/api/mobile/inbox', { cache: 'no-store' }).then(async (response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return (await response.json()) as MobileInboxSnapshot;
        });
        if (!active) return;
        setSnapshot(nextSnapshot);
        setRefreshError(null);
      } catch (error) {
        if (!active) return;
        setRefreshError(error instanceof Error ? error.message : 'Unable to refresh mobile inbox');
      }
    }

    void refreshLiveInbox();
    const timer = window.setInterval(() => {
      void refreshLiveInbox();
    }, 30000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let frame = 0;

    const clearHeaderReveal = () => {
      if (headerRevealTimerRef.current) {
        window.clearTimeout(headerRevealTimerRef.current);
        headerRevealTimerRef.current = null;
      }
    };

    const scheduleHeaderReveal = (delayMs = 700) => {
      clearHeaderReveal();
      headerRevealTimerRef.current = window.setTimeout(() => {
        setHeaderVisible(true);
        headerRevealTimerRef.current = null;
      }, delayMs);
    };

    const readScrollY = () => window.scrollY || document.documentElement.scrollTop || 0;

    const markScrollSettled = () => {
      if (scrollStopTimerRef.current) {
        window.clearTimeout(scrollStopTimerRef.current);
      }
      scrollStopTimerRef.current = window.setTimeout(() => {
        setIsScrolling(false);
        if (readScrollY() <= 12) {
          clearHeaderReveal();
          setHeaderVisible(true);
        }
        scrollStopTimerRef.current = null;
      }, 150);
    };

    const updateScrollY = () => {
      frame = 0;
      const nextScrollY = readScrollY();
      stickToBottomRef.current = isWindowNearBottom();
      setScrollY((current) => (Math.abs(current - nextScrollY) > 1 ? nextScrollY : current));
    };

    const handleScroll = () => {
      const nextScrollY = readScrollY();
      stickToBottomRef.current = isWindowNearBottom();
      setScrollY((current) => (Math.abs(current - nextScrollY) > 1 ? nextScrollY : current));
      setIsScrolling(true);
      if (nextScrollY > 12) {
        setHeaderVisible(false);
        scheduleHeaderReveal(700);
      } else {
        clearHeaderReveal();
        setHeaderVisible(true);
      }
      markScrollSettled();
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(updateScrollY);
    };

    const handleResize = () => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(updateScrollY);
    };

    updateScrollY();
    if (readScrollY() <= 12) {
      setHeaderVisible(true);
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleResize);

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      if (scrollStopTimerRef.current) {
        window.clearTimeout(scrollStopTimerRef.current);
      }
      clearHeaderReveal();
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
    };
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
  // Discovered Codex sessions use the same chat UI as OpenClaw sessions
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

  // ── Streaming state ──
  const [streamingText, setStreamingText] = useState('');
  const streamingTextRef = useRef(''); // avoid stale closures in EventSource handler
  useEffect(() => {
    // Seed with all current IDs so initial render doesn't animate everything
    if (!seenMessageIdsRef.current) {
      seenMessageIdsRef.current = new Set(transcriptEntries.map((e) => e.id));
    }
    setHydrated(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── SSE streaming connection ──
  useEffect(() => {
    if (!selectedSessionKey || typeof window === 'undefined') return;
    // Only stream OpenClaw sessions (not owned Codex which has its own tail)
    const session = snapshot.sessions.find((s) => s.sessionKey === selectedSessionKey);
    if (session?.runtime !== 'openclaw') return;

    let es: EventSource | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      es = new EventSource(`/api/mobile/stream?sessionKey=${encodeURIComponent(selectedSessionKey)}`);

      es.addEventListener('chat-delta', (event) => {
        if (disposed) return;
        try {
          const data = JSON.parse(event.data);
          if (data.text) {
            streamingTextRef.current = data.text;
            setStreamingText(data.text);
          }
        } catch { /* ignore malformed events */ }
      });

      es.addEventListener('chat-done', (event) => {
        if (disposed) return;
        // Response complete — clear streaming state, force poll for final transcript
        streamingTextRef.current = '';
        setStreamingText('');
        try {
          const data = JSON.parse(event.data);
          // Inline the final text immediately for zero-latency display
          if (data.text && selectedSessionKey) {
            setHistoryBySession((current) => {
              const prev = current[selectedSessionKey] ?? [];
              // Don't add if the last message already matches (poll caught up)
              if (prev.length > 0 && prev[prev.length - 1]?.text === data.text) {
                return current;
              }
              // Append a synthetic entry — the next poll will reconcile with the real one
              const syntheticEntry: MobileTranscriptEntry = {
                id: `stream:${data.runId ?? Date.now()}`,
                role: 'assistant',
                text: data.text,
                timestampLabel: new Date(data.timestamp ?? Date.now()).toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                }),
              };
              return { ...current, [selectedSessionKey]: [...prev, syntheticEntry] };
            });
          }
        } catch { /* ignore */ }
        // Force a fresh poll to get the authoritative transcript
        void loadHistory(selectedSessionKey, true).catch(() => undefined);
      });

      es.addEventListener('chat-error', () => {
        if (disposed) return;
        streamingTextRef.current = '';
        setStreamingText('');
      });

      es.onerror = () => {
        // EventSource auto-reconnects on error — just clean up streaming state
        if (!disposed) {
          streamingTextRef.current = '';
          setStreamingText('');
          }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (es) {
        es.close();
        es = null;
      }
      streamingTextRef.current = '';
      setStreamingText('');
    };
  }, [selectedSessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const reviewFiles = useMemo(() => {
    const next = isOwnedCodexSession
      ? selectedReviewPacket?.changedFiles ?? []
      : snapshot.review?.changedFiles ?? [];
    // Keep last known non-empty file list if a poll temporarily returns empty
    // (e.g., during compaction, git lock, or slow endpoint)
    if (next.length) {
      stickyReviewFilesRef.current = next;
      return next;
    }
    return stickyReviewFilesRef.current;
  }, [isOwnedCodexSession, selectedReviewPacket, snapshot.review?.changedFiles]);

  const loadHistory = useCallback(async (sessionKey: string, force = false) => {
    if (!force && historyBySession[sessionKey]?.length) {
      return historyBySession[sessionKey];
    }

    setHistoryLoading((current) => ({ ...current, [sessionKey]: true }));
    try {
      const response = await fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=18&_t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
      });
      const payload = await readJson<MobileHistoryResponse>(response);
      // Diff-and-patch: only update state if transcript actually changed.
      // Prevents React re-render flash when polling returns identical data.
      setHistoryBySession((current) => {
        const prev = current[sessionKey] ?? [];
        const next = payload.transcript;
        // Fast path: same length + same last ID = no change
        if (
          prev.length === next.length
          && prev.length > 0
          && prev[prev.length - 1]?.id === next[next.length - 1]?.id
          // Also check the last message text in case of streaming/edit updates
          && prev[prev.length - 1]?.text === next[next.length - 1]?.text
        ) {
          return current; // return same reference — React skips re-render
        }
        // Merge: keep optimistic entries that haven't been replaced yet,
        // then append only genuinely new server entries
        const existingIds = new Set(prev.filter((e) => !e.id.startsWith('optimistic-')).map((e) => e.id));
        const newServerEntries = next.filter((e) => !existingIds.has(e.id));
        if (newServerEntries.length === 0 && prev.length >= next.length) {
          // Server returned subset of what we have (optimistic entries still pending)
          return current;
        }
        return { ...current, [sessionKey]: next };
      });
      setHistoryGroupsBySession((current) => {
        const prev = current[sessionKey] ?? [];
        const next = payload.groups ?? [];
        if (prev.length === next.length && prev.length > 0 && prev[prev.length - 1]?.id === next[next.length - 1]?.id) {
          return current;
        }
        return { ...current, [sessionKey]: next };
      });
      setHistoryError((current) => ({ ...current, [sessionKey]: null }));
      return payload.transcript;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load session history';
      setHistoryError((current) => ({ ...current, [sessionKey]: message }));
      throw error;
    } finally {
      setHistoryLoading((current) => ({ ...current, [sessionKey]: false }));
    }
  }, [historyBySession]);

  const loadOwnedReviewPacket = useCallback(async (sessionKey: string, force = false) => {
    if (!sessionKey.startsWith('codex-owned:')) {
      return null;
    }
    if (!force && reviewPacketBySession[sessionKey]) {
      return reviewPacketBySession[sessionKey];
    }

    setReviewPacketLoadingBySession((current) => ({ ...current, [sessionKey]: true }));
    try {
      const response = await fetch(`/api/runtime/review?surfaceId=${encodeURIComponent(sessionKey)}`, {
        cache: 'no-store',
      });
      const payload = await readJson<RuntimeReviewPacket>(response);
      setReviewPacketBySession((current) => ({ ...current, [sessionKey]: payload }));
      setReviewPacketErrorBySession((current) => ({ ...current, [sessionKey]: null }));
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load the owned review packet.';
      setReviewPacketErrorBySession((current) => ({ ...current, [sessionKey]: message }));
      throw error;
    } finally {
      setReviewPacketLoadingBySession((current) => ({ ...current, [sessionKey]: false }));
    }
  }, [reviewPacketBySession]);

  const loadReviewFile = useCallback(async (reviewPath: string, force = false) => {
    if (!force && reviewFileByPath[reviewPath]) {
      setReviewFileError(null);
      return reviewFileByPath[reviewPath];
    }

    setReviewFileLoadingPath(reviewPath);
    setReviewFileError(null);
    try {
      const response = await fetch(`/api/mobile/review-file?path=${encodeURIComponent(reviewPath)}`, {
        cache: 'no-store',
      });
      const payload = await readJson<MobileReviewFileResponse>(response);
      setReviewFileByPath((current) => ({ ...current, [reviewPath]: payload.file }));
      return payload.file;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load the per-file review preview.';
      setReviewFileError(message);
      throw error;
    } finally {
      setReviewFileLoadingPath((current) => (current === reviewPath ? null : current));
    }
  }, [reviewFileByPath]);

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

  // Adaptive polling: fast when active, slow when idle, paused when tab hidden
  const documentVisibleRef = useRef(true);
  useEffect(() => {
    const handler = () => {
      documentVisibleRef.current = document.visibilityState === 'visible';
      // Immediately refresh when tab becomes visible again
      if (documentVisibleRef.current && selectedSessionKey) {
        void loadHistory(selectedSessionKey, true).catch(() => undefined);
        void refreshInbox().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [loadHistory, refreshInbox, selectedSessionKey]);

  useEffect(() => {
    if (!selectedSessionKey) {
      return;
    }

    const ownedActive = selectedSessionKey.startsWith('codex-owned:')
      && (
        selectedSession?.runtimeSurface?.lifecycle?.availability === 'running'
        || Boolean(pendingOwnedTurnBySession[selectedSessionKey])
        || actionStateBySession[selectedSessionKey] === 'steering'
      );
    const isActive = ownedActive || selectedSession?.status === 'running' || waitingForResponse;
    const intervalMs = ownedActive
      ? 1500
      : selectedSessionKey.startsWith('codex-owned:')
        ? 4000
        : isActive
          ? 2500
          : 20000; // idle: 20s instead of 10s — less aggressive

    const timer = window.setInterval(() => {
      // Skip polling when tab is hidden — no point updating invisible UI
      if (!documentVisibleRef.current) return;

      void loadHistory(selectedSessionKey, true).catch(() => undefined);
      // Only refresh inbox when something is actually happening
      if (isActive) {
        void refreshInbox().catch(() => undefined);
      }
      if (selectedSessionKey.startsWith('codex-owned:')) {
        void loadOwnedReviewPacket(selectedSessionKey, true).catch(() => undefined);
      }
      // Only poll review files when diff view is actually open AND session is active
      if (selectedReviewFilePath && diffOpen && (isActive || selectedSessionKey.startsWith('codex-owned:'))) {
        void loadReviewFile(selectedReviewFilePath, true).catch(() => undefined);
      }
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [actionStateBySession, diffOpen, loadHistory, loadOwnedReviewPacket, loadReviewFile, pendingOwnedTurnBySession, refreshInbox, selectedReviewFilePath, selectedSession?.runtimeSurface?.lifecycle?.availability, selectedSession?.status, selectedSessionKey, waitingForResponse]);

  // For discovered Codex sessions, find the linked owned session and show its history
  // This makes the chat seamless — user sees Codex responses without knowing about the owned/discovered split
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

  // Load linked owned session history when it exists
  useEffect(() => {
    if (linkedOwnedKey && !historyBySession[linkedOwnedKey] && !historyLoading[linkedOwnedKey]) {
      void loadHistory(linkedOwnedKey, true).catch(() => undefined);
    }
  }, [linkedOwnedKey, historyBySession, historyLoading, loadHistory]);

  // Poll linked owned session too
  useEffect(() => {
    if (!linkedOwnedKey) return;
    const timer = window.setInterval(() => {
      if (!documentVisibleRef.current) return;
      void loadHistory(linkedOwnedKey, true).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [linkedOwnedKey, loadHistory]);

  // Merge discovered + owned history for seamless display
  const effectiveHistoryKey = linkedOwnedKey && historyBySession[linkedOwnedKey]?.length ? linkedOwnedKey : selectedSessionKey;
  const discoveredEntries = selectedSessionKey ? historyBySession[selectedSessionKey] ?? [] : [];
  const ownedEntries = linkedOwnedKey ? historyBySession[linkedOwnedKey] ?? [] : [];
  // Show discovered session's history PLUS owned session's history (which has the responses)
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

  // Clear typing indicator only when a new ASSISTANT message appears
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
  // ── Project-grouped squad rail ──

  const projectGroups = useMemo(() => {
    const isRelevant = (session: MobileInboxSnapshot['sessions'][number]) => {
      if (session.isCurrentSession) return true;
      if (session.id === selectedSession?.id) return true;

      // Parse age once — used by both Codex and OpenClaw filters
      const ageText = session.lastEventAt ?? '';
      const hoursMatch = ageText.match(/^(\d+)h/);
      const daysMatch = ageText.match(/^(\d+)d/);
      const ageHours = daysMatch ? parseInt(daysMatch[1], 10) * 24
        : hoursMatch ? parseInt(hoursMatch[1], 10)
        : 0;
      const isStale = ageHours > 4;

      // Codex sessions: show live/recent discovered sessions and active owned sessions.
      if (session.runtime === 'codex') {
        const src = session.runtimeSurface?.sourceLabel ?? '';
        const ownership = session.runtimeSurface?.ownership ?? '';
        // Discovered sessions: only show if a live desktop process is verified
        if (ownership === 'discovered') {
          if (src.includes('live pid')) return true;
          return false;
        }
        // Owned sessions: show only if actively running or very recently finished (under 1h)
        if (ownership === 'owned') {
          if (src.includes('active pid')) return true;
          const minsMatch = ageText.match(/^(\d+)m/);
          const recentMins = minsMatch ? parseInt(minsMatch[1], 10) : 999;
          if (ageText === 'just now' || recentMins < 60) return true;
          return false;
        }
        return false;
      }

      // OpenClaw sessions: filter stale ones
      if (isStale) return false;

      if (['running', 'reviewing', 'blocked'].includes(session.status)) return true;
      if (session.activity || session.alerts > 0) return true;
      return false;
    };

    const relevant = snapshot.sessions.filter(isRelevant);
    const groupMap = new Map<string, MobileInboxSnapshot['sessions']>();
    for (const session of relevant) {
      const ws = session.workspace || '~/clawd';
      const existing = groupMap.get(ws) ?? [];
      existing.push(session);
      groupMap.set(ws, existing);
    }

    const groups: ProjectGroup[] = [];
    for (const [ws, rawSessions] of groupMap) {
      // Deduplicate: only collapse truly dead duplicates (same session id).
      // Never dedup by branch — user may have multiple Codex agents on the same branch.
      const deduped: typeof rawSessions = [];
      const seenIds = new Set<string>();
      for (const s of rawSessions) {
        if (seenIds.has(s.id)) continue;
        seenIds.add(s.id);
        deduped.push(s);
      }
      const sessions = deduped;
      const running = sessions.some((s) => s.status === 'running' || s.status === 'reviewing');
      const bestCtx = Math.max(...sessions.map((s) => s.context?.usedPercent ?? 0));
      let mostRecentTime: string | undefined;
      for (const s of sessions) {
        if (s.activity?.headline || s.lastEventAt) {
          mostRecentTime = s.lastEventAt;
          break;
        }
      }

      groups.push({
        projectName: projectDisplayName(ws, sessions),
        workspace: ws,
        sessions,
        hasPrimary: sessions.some((s) => s.isCurrentSession),
        summary: projectSummary(sessions),
        mostRecentTime: mostRecentTime ?? sessions[0]?.lastEventAt,
        bestContextPct: bestCtx,
        hasRunning: running,
      });
    }

    groups.sort((a, b) => {
      if (a.hasPrimary && !b.hasPrimary) return -1;
      if (!a.hasPrimary && b.hasPrimary) return 1;
      if (a.hasRunning && !b.hasRunning) return -1;
      if (!a.hasRunning && b.hasRunning) return 1;
      return 0;
    });

    return groups;
  }, [selectedSession, snapshot.sessions]);

  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const totalAdditions = reviewFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const totalDeletions = reviewFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const focusedAdditions = selectedReviewFile?.additions ?? totalAdditions;
  const focusedDeletions = selectedReviewFile?.deletions ?? totalDeletions;
  const sessionSwitcher = snapshot.sessions.slice(0, 5);
  const activeTitle = compactLine(
    isOwnedCodexSession
      ? selectedReviewPacket?.title ?? selectedSession?.name ?? selectedSession?.currentTask
      : snapshot.review?.pullRequest?.title ?? selectedSession?.name ?? selectedSession?.currentTask,
    selectedSession?.isCurrentSession ? 'Q ↔ Mister live' : selectedSession?.name ?? 'Current session',
    26,
  );
  const activeSubtitle = compactLine(
    isOwnedCodexSession
      ? (selectedReviewPacket?.repoSlug && selectedReviewPacket?.branch ? `/${selectedReviewPacket.repoSlug}/${selectedReviewPacket.branch}` : selectedSession?.sessionKey)
      : (snapshot.review ? `/${snapshot.review.repoSlug}/${snapshot.review.branch}` : selectedSession?.sessionKey),
    selectedSession?.sessionKey ?? 'mobile/live',
    42,
  );
  const headerLabel = isOwnedCodexSession
    ? (selectedSession?.runtimeSurface?.capabilities.interrupt ? 'Codex live' : selectedSession?.runtimeSurface?.capabilities.sendInput ? 'Codex chat' : 'Codex watch')
    : selectedSession?.runtime === 'codex'
      ? 'Codex'
      : selectedSession?.status === 'running'
        ? 'Live'
        : snapshot.review?.pullRequest
          ? 'Review'
          : 'Session';
  const headerProgress = Math.min(scrollY / 88, 1);
  const isHeaderCompact = headerProgress > 0.12;
  const isComposerPrimed = isChatSession && (composeFocused || transcriptAttachments.length > 0);
  const dockMotionProgress = !isComposerPrimed && isScrolling ? 1 : 0;
  const dockFadeProgress = dockMotionProgress;
  const diffFileLabel = reviewFiles.length === 1 ? 'file' : 'files';
  const contextUsedPercent = Math.round(selectedSession?.context.usedPercent ?? 0);
  const ownedAvailability = selectedSession?.runtimeSurface?.lifecycle?.availability;
  const ownedLastOutcome = selectedSession?.runtimeSurface?.lifecycle?.lastOutcome;
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

  const statusTone = isOwnedCodexSession
    ? ownedLifecycleTone(ownedAvailability, ownedLastOutcome)
    : contextPressureTone(contextUsedPercent);
  const statusHeadline = isOwnedCodexSession
    ? ownedLifecycleLabel(ownedAvailability)
    : `${contextUsedPercent}% used`;
  const statusMeta = isOwnedCodexSession
    ? [ownedOutcomeLabel(ownedLastOutcome), ownedReviewDispositionLabel(ownedReviewDisposition)].join(' • ')
    : contextTrendLabel(selectedSession?.context.trend);

  const shellStyle = {
    '--remodex-header-progress': headerProgress.toFixed(3),
    '--remodex-dock-fade-progress': dockFadeProgress.toFixed(3),
    '--remodex-dock-motion-progress': dockMotionProgress.toFixed(3),
    '--remodex-compose-active': isComposerPrimed ? '1' : '0',
    '--remodex-viewport-top-offset': `${viewportTopOffset}px`,
  } as CSSProperties;

  useLayoutEffect(() => {
    if (!selectedSessionKey || typeof window === 'undefined') {
      return;
    }
    if (!transcriptEntries.length && !transcriptGroups.length && !pendingOwnedTurn) {
      return;
    }

    const isFirstLoad = !initialBottomPinBySessionRef.current[selectedSessionKey];
    if (isFirstLoad) {
      // First load: always pin to bottom immediately (no smooth — instant)
      initialBottomPinBySessionRef.current[selectedSessionKey] = true;
      const runPin = () => transcriptBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
      const frameA = window.requestAnimationFrame(() => {
        runPin();
        window.requestAnimationFrame(runPin);
      });
      return () => window.cancelAnimationFrame(frameA);
    }

    // Subsequent updates: only scroll if user is already near the bottom
    if (!stickToBottomRef.current) {
      return; // user scrolled up — don't interrupt them
    }

    // Smooth scroll to bottom for new content
    const frame = window.requestAnimationFrame(() => {
      transcriptBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingOwnedTurn, scrollMarker, selectedSessionKey]);

  async function handleAttachmentSelection(files: FileList | null) {
    if (!selectedSessionKey || !files?.length) {
      return;
    }
    if (!isChatSession) {
      setSurfaceNote('Image attachments are only available for chat sessions right now.');
      return;
    }

    const chosenFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (!chosenFiles.length) {
      setSurfaceNote('Only image attachments are supported right now.');
      return;
    }

    try {
      const nextAttachments = await Promise.all(chosenFiles.slice(0, 4).map(async (file, index) => {
        if (file.size > 5_000_000) {
          throw new Error(`${file.name} is too large. Keep image attachments under 5 MB.`);
        }
        const content = await fileToDataUrl(file);
        return {
          id: `${file.name}:${file.lastModified}:${index}`,
          fileName: file.name,
          mimeType: file.type || 'image/png',
          content,
          previewUrl: URL.createObjectURL(file),
        } satisfies DraftAttachment;
      }));

      setDraftAttachmentsBySession((current) => ({
        ...current,
        [selectedSessionKey]: [...(current[selectedSessionKey] ?? []), ...nextAttachments].slice(0, 4),
      }));
      setSurfaceNote(`Attached ${nextAttachments.length} image${nextAttachments.length === 1 ? '' : 's'}.`);
      window.requestAnimationFrame(() => composeRef.current?.focus());
    } catch (error) {
      setSurfaceNote(error instanceof Error ? error.message : 'Unable to prepare these image attachments.');
    }
  }

  function removeDraftAttachment(sessionKey: string, attachmentId: string) {
    setDraftAttachmentsBySession((current) => {
      const existing = current[sessionKey] ?? [];
      const removed = existing.find((item) => item.id === attachmentId);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      const remaining = existing.filter((item) => item.id !== attachmentId);
      return {
        ...current,
        [sessionKey]: remaining,
      };
    });
  }

  async function runAction(payload: MobileActionRequest) {
    const sessionKey = payload.sessionKey;
    const nextState = payload.action === 'stop'
      ? 'stopping'
      : payload.action === 'watch' || payload.action === 'resolve'
        ? 'reviewing'
        : 'steering';

    setActionStateBySession((current) => ({
      ...current,
      [sessionKey]: nextState,
    }));

    try {
      const response = await fetch('/api/mobile/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const result = await readJson<MobileActionResponse>(response);
      setActionNoteBySession((current) => ({ ...current, [sessionKey]: result.note }));
      window.setTimeout(() => {
        setActionNoteBySession((current) => (current[sessionKey] === result.note ? { ...current, [sessionKey]: null } : current));
      }, 3000);
      await refreshInbox();
      await loadHistory(sessionKey, true).catch(() => undefined);
      if (sessionKey.startsWith('codex-owned:')) {
        await loadOwnedReviewPacket(sessionKey, true).catch(() => undefined);
      }
      return result;
    } finally {
      setActionStateBySession((current) => ({ ...current, [sessionKey]: 'idle' }));
    }
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
    if (!selectedSessionKey || enhancing) return;
    const raw = draftBySession[selectedSessionKey]?.trim();
    if (!raw || raw.length < 3) return;

    setEnhancing(true);
    setPreEnhanceDraft(raw);
    try {
      const res = await fetch('/api/mobile/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: raw }),
      });
      if (!res.ok) throw new Error('enhance failed');
      const { enhanced } = await res.json();
      if (enhanced && typeof enhanced === 'string') {
        setDraftBySession((cur) => ({ ...cur, [selectedSessionKey]: enhanced }));
      }
    } catch {
      setSurfaceNote('Enhancement failed — original prompt kept');
      setPreEnhanceDraft(null);
    } finally {
      setEnhancing(false);
    }
  }

  function handleUndoEnhance() {
    if (!selectedSessionKey || preEnhanceDraft === null) return;
    setDraftBySession((cur) => ({ ...cur, [selectedSessionKey]: preEnhanceDraft }));
    setPreEnhanceDraft(null);
  }

  async function handleSteerSubmit(sessionKey: string) {
    if (actionStateBySession[sessionKey] === 'steering') return;

    const targetSession = snapshot.sessions.find((session) => session.sessionKey === sessionKey);
    const isDiscoveredCodex = targetSession?.runtime === 'codex' && targetSession?.runtimeSurface?.ownership === 'discovered';
    const isOwnedCodex = targetSession?.runtime === 'codex' && targetSession?.runtimeSurface?.ownership === 'owned';
    const isChat = targetSession?.runtime === 'openclaw' || isDiscoveredCodex || isOwnedCodex;
    if (!isChat) {
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: 'Cannot send to this session type.',
      }));
      return;
    }

    const message = draftBySession[sessionKey]?.trim();
    const attachments = draftAttachmentsBySession[sessionKey] ?? [];
    if (!message && attachments.length === 0) {
      setActionNoteBySession((current) => ({ ...current, [sessionKey]: 'Type a message or attach an image first.' }));
      return;
    }

    playSendClick();

    // Show typing indicator until a new assistant message arrives
    lastAssistantCountRef.current = transcriptEntries.filter((e) => e.role === 'assistant').length;
    setWaitingForResponse(true);

    // Optimistic: inject user message into transcript immediately
    const optimisticEntry: MobileTranscriptEntry = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      text: message ?? '',
      media: attachments.length > 0
        ? attachments.map((a) => ({ kind: 'image' as const, path: a.previewUrl, name: a.fileName }))
        : undefined,
      timestampLabel: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    };
    setHistoryBySession((current) => ({
      ...current,
      [sessionKey]: [...(current[sessionKey] ?? []), optimisticEntry],
    }));

    // Optimistic: clear UI immediately before the API round-trip
    setDraftBySession((current) => ({ ...current, [sessionKey]: '' }));
    setDraftAttachmentsBySession((current) => ({ ...current, [sessionKey]: [] }));
    setPreEnhanceDraft(null);
    attachments.forEach((item) => {
      URL.revokeObjectURL(item.previewUrl);
    });
    setSurfaceNote(
      attachments.length > 0
        ? `Sent with ${attachments.length} image${attachments.length === 1 ? '' : 's'}.`
        : 'Sent.',
    );

    try {
      if (isDiscoveredCodex) {
        // For discovered Codex: find or create ONE owned session for this workspace,
        // then resume it. Never create multiple owned sessions for the same cwd.
        const cwd = targetSession?.runtimeSurface?.cwd ?? targetSession?.workspace ?? '';

        // Check if an owned session already exists for this workspace
        const existingOwned = snapshot.sessions.find((s) =>
          s.runtime === 'codex' &&
          s.runtimeSurface?.ownership === 'owned' &&
          (s.runtimeSurface?.cwd === cwd || s.workspace === cwd) &&
          s.runtimeSurface?.lifecycle?.availability === 'ready-for-resume',
        );

        if (existingOwned) {
          // Resume the existing owned session
          await runAction({
            action: 'resume' as MobileActionRequest['action'],
            sessionKey: existingOwned.sessionKey,
            message,
          });
          // Switch to the owned session
          setSelectedId(existingOwned.id);
          setSurfaceNote('Resuming Codex session…');
          await loadHistory(existingOwned.sessionKey, true).catch(() => undefined);
        } else {
          // No owned session exists — launch a new one
          const launchResult = await runAction({
            action: 'launch' as MobileActionRequest['action'],
            sessionKey,
            message,
            cwd,
          });
          if (launchResult?.ok && launchResult.sessionKey && launchResult.sessionKey !== sessionKey) {
            setSurfaceNote('Codex launched — switching to session…');
            await new Promise((r) => setTimeout(r, 2000));
            const freshInbox = await refreshInbox();
            const newSession = freshInbox?.sessions?.find((s: { sessionKey?: string }) => s.sessionKey === launchResult.sessionKey);
            if (newSession) {
              setSelectedId(newSession.id);
              await loadHistory(launchResult.sessionKey, true).catch(() => undefined);
            }
          } else {
            setSurfaceNote('Codex session launched.');
          }
        }
      } else if (isOwnedCodex) {
        // Owned Codex: resume the session directly
        await runAction({
          action: 'resume' as MobileActionRequest['action'],
          sessionKey,
          message,
        });
        setSurfaceNote('Sent to Codex…');
      } else {
        await runAction({
          action: 'steer',
          sessionKey,
          message,
          attachments: attachments.map((item) => ({
            type: 'image',
            mimeType: item.mimeType,
            fileName: item.fileName,
            content: item.content,
          })),
        });
      }
    } catch (error) {
      // Restore draft on failure so the user doesn't lose their message
      setDraftBySession((current) => ({ ...current, [sessionKey]: message ?? '' }));
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: error instanceof Error ? error.message : 'Failed to send. Message restored.',
      }));
    }
  }

  function handleLoadOwnedCorrectionDraft(sessionKey: string) {
    const packet = reviewPacketBySession[sessionKey];
    if (!packet) {
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: 'Review packet is still loading. Refresh and try again.',
      }));
      return;
    }

    setDraftBySession((current) => ({
      ...current,
      [sessionKey]: buildOwnedCorrectionDraft(packet),
    }));
    setActionNoteBySession((current) => ({
      ...current,
      [sessionKey]: 'Loaded correction draft from review packet.',
    }));
    window.requestAnimationFrame(() => composeRef.current?.focus());
  }

  async function handleOwnedResumeSubmit(sessionKey: string) {
    if (actionStateBySession[sessionKey] === 'steering') return;

    const message = draftBySession[sessionKey]?.trim();
    if (!message) {
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: 'Write an instruction or load the correction draft first.',
      }));
      return;
    }

    playSendClick();

    const pendingTurn: PendingOwnedTurn = {
      id: `pending-${Date.now()}`,
      prompt: message,
      createdAt: Date.now(),
      timestampLabel: mobileClockFormatter.format(new Date()),
    };

    setPendingOwnedTurnBySession((current) => ({
      ...current,
      [sessionKey]: pendingTurn,
    }));

    // Optimistic: clear draft immediately
    setDraftBySession((current) => ({ ...current, [sessionKey]: '' }));
    setSurfaceNote('Turn queued.');

    try {
      await runAction({
        action: 'resume',
        sessionKey,
        message,
      });
    } catch (error) {
      setPendingOwnedTurnBySession((current) => {
        if (!current[sessionKey]) {
          return current;
        }
        const next = { ...current };
        delete next[sessionKey];
        return next;
      });
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: error instanceof Error ? error.message : 'Unable to resume the owned Codex session from mobile.',
      }));
    }
  }

  function optimisticallySetOwnedReviewDisposition(
    sessionKey: string,
    disposition: RuntimeReviewPacket['reviewDisposition'],
  ) {
    const updatedAt = new Date().toISOString();
    setReviewPacketBySession((current) => {
      const existing = current[sessionKey];
      if (!existing) {
        return current;
      }
      return {
        ...current,
        [sessionKey]: {
          ...existing,
          reviewDisposition: disposition,
          reviewDispositionUpdatedAt: updatedAt,
          reviewDispositionUpdatedAtLabel: 'Just now',
        },
      };
    });
  }

  async function handleOwnedReviewDisposition(action: 'watch' | 'resolve', sessionKey: string) {
    const previousPacket = reviewPacketBySession[sessionKey];
    const nextDisposition = action === 'resolve' ? 'resolved' : 'watching';

    if (previousPacket) {
      optimisticallySetOwnedReviewDisposition(sessionKey, nextDisposition);
    }

    setActionNoteBySession((current) => ({
      ...current,
      [sessionKey]: action === 'resolve' ? 'Marking resolved…' : 'Switching to watching…',
    }));

    try {
      const result = await runAction({
        action,
        sessionKey,
      });
      setSurfaceNote(result.note);
    } catch (error) {
      if (previousPacket) {
        setReviewPacketBySession((current) => ({
          ...current,
          [sessionKey]: previousPacket,
        }));
      }
      void loadOwnedReviewPacket(sessionKey, true).catch(() => undefined);
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: error instanceof Error ? error.message : 'Unable to update the owned review state from mobile.',
      }));
    }
  }

  function handleCopy(text: string) {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setSurfaceNote('Clipboard is not available on this browser.');
      return;
    }

    void navigator.clipboard.writeText(text).then(() => {
      setSurfaceNote('Copied to clipboard.');
    }).catch(() => {
      setSurfaceNote('Could not copy to the clipboard.');
    });
  }

  async function handleSurfaceRefresh() {
    setSurfaceRefreshing(true);
    try {
      const nextSnapshot = await refreshInbox();
      const nextSessionKey = selectedSessionKey
        ?? nextSnapshot.primarySessionKey
        ?? nextSnapshot.sessions.find((session) => session.isCurrentSession)?.sessionKey
        ?? nextSnapshot.sessions[0]?.sessionKey;
      let nextReviewPath = selectedReviewFilePath;

      if (nextSessionKey) {
        await loadHistory(nextSessionKey, true).catch(() => undefined);
        if (nextSessionKey.startsWith('codex-owned:')) {
          const packet = await loadOwnedReviewPacket(nextSessionKey, true).catch(() => null);
          nextReviewPath = nextReviewPath ?? packet?.changedFiles[0]?.path ?? null;
        } else {
          nextReviewPath = nextReviewPath ?? nextSnapshot.review?.changedFiles[0]?.path ?? null;
        }
      }
      if (nextReviewPath) {
        await loadReviewFile(nextReviewPath, true).catch(() => undefined);
      }
      setSurfaceNote('Refreshed.');
    } catch (error) {
      setSurfaceNote(error instanceof Error ? error.message : 'Unable to refresh the mobile surface right now.');
    } finally {
      setSurfaceRefreshing(false);
    }
  }

  function handleSessionFocus(sessionId: string) {
    const nextSession = snapshot.sessions.find((session) => session.id === sessionId);
    if (!nextSession?.sessionKey) {
      return;
    }

    setSelectedId(sessionId);
    setActiveView('chat');
    setControlsOpen(false);
    setDiffOpen(false);
    setSurfaceNote(`Focused ${compactLine(nextSession.name, 'the selected session', 40)}.`);

    void (async () => {
      await loadHistory(nextSession.sessionKey).catch(() => undefined);
      if (!nextSession.sessionKey.startsWith('codex-owned:')) {
        return;
      }
      const packet = await loadOwnedReviewPacket(nextSession.sessionKey).catch(() => null);
      const nextPath = packet?.changedFiles[0]?.path;
      if (!nextPath) {
        return;
      }
      setSelectedReviewFilePath(nextPath);
      await loadReviewFile(nextPath).catch(() => undefined);
    })();
  }

  async function handleStopActiveRun() {
    if (!selectedSessionKey) {
      return;
    }
    if (!isChatSession && !canInterruptOwnedCodex) {
      setSurfaceNote('No active run to interrupt right now.');
      return;
    }
    if (!window.confirm(isOwnedCodexSession ? 'Interrupt the active owned Codex run?' : 'Stop the active run for this session?')) {
      return;
    }

    try {
      const result = await runAction({
        action: 'stop',
        sessionKey: selectedSessionKey,
      });
      setSurfaceNote(result.note);
      setControlsOpen(false);
    } catch (error) {
      setSurfaceNote(error instanceof Error ? error.message : isOwnedCodexSession ? 'Unable to interrupt the owned Codex run from mobile.' : 'Unable to stop the active run from mobile.');
    }
  }

  function openDiffViewer() {
    if (!reviewFiles.length) {
      setSurfaceNote('No active diff to review right now.');
      return;
    }

    const nextPath = selectedReviewFilePath ?? reviewFiles[0]?.path ?? null;
    if (nextPath) {
      setSelectedReviewFilePath(nextPath);
      if (!reviewFileByPath[nextPath]) {
        void loadReviewFile(nextPath).catch(() => undefined);
      }
    }

    setControlsOpen(false);
    setDiffOpen(true);
  }

  function handleReviewFileFocus(reviewPath: string) {
    setSelectedReviewFilePath(reviewPath);
    void loadReviewFile(reviewPath).catch(() => undefined);
  }


  function handleApprovalDecision(approval: ApprovalRequest, resolution: 'approved' | 'rejected') {
    setResolvedApprovals((current) => ({ ...current, [approval.id]: resolution }));
    setSurfaceNote(`${resolution === 'approved' ? '✅ Approved' : '❌ Rejected'}: ${approval.title}`);
    window.setTimeout(() => {
      setPendingApprovals((current) => current.filter((item) => item.id !== approval.id));
    }, 1500);
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
    if (!selectedSessionKey) {
      return;
    }
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

  const composeBarHandlers = {
    onSend: () => {
      if (!selectedSessionKey) {
        return;
      }
      return handleSteerSubmit(selectedSessionKey);
    },
    onOwnedResume: () => {
      if (!selectedSessionKey) {
        return;
      }
      return handleOwnedResumeSubmit(selectedSessionKey);
    },
    onEnhance: () => handleEnhancePrompt(),
    onUndoEnhance: handleUndoEnhance,
    onAttach: () => fileInputRef.current?.click(),
    onAttachFiles: (files: FileList | null) => handleAttachmentSelection(files),
    onRemoveAttachment: (attachmentId: string) => {
      if (!selectedSessionKey) {
        return;
      }
      removeDraftAttachment(selectedSessionKey, attachmentId);
    },
    onRefresh: () => handleSurfaceRefresh(),
    onStop: () => handleStopActiveRun(),
    onInterrupt: () => handleStopActiveRun(),
    onOpenDiff: openDiffViewer,
    onLoadCorrectionDraft: () => {
      if (!selectedSessionKey) {
        return;
      }
      handleLoadOwnedCorrectionDraft(selectedSessionKey);
    },
    onToggleOwnedReviewDisposition: () => {
      if (!selectedSessionKey) {
        return;
      }
      return handleOwnedReviewDisposition(ownedReviewDisposition === 'resolved' ? 'watch' : 'resolve', selectedSessionKey);
    },
    onDraftChange: (value: string) => {
      if (!selectedSessionKey) {
        return;
      }
      setDraftBySession((current) => ({ ...current, [selectedSessionKey]: value }));
    },
    onFocusChange: setComposeFocused,
  };

  return (
    <div className="mobile-wrap remodex-mobile-page" style={shellStyle} suppressHydrationWarning>
      <div className="remodex-phone-shell">
        <header
          className="remodex-topbar"
          data-compact={isHeaderCompact ? 'true' : 'false'}
          data-context-visible="false"
          data-visible={headerVisible ? 'true' : 'false'}
        >
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="remodex-circle-button"
              aria-label="Conversation controls"
              onClick={() => setControlsOpen(true)}
              style={{ background: '#ef4444', color: '#ffffff', border: 'none', boxShadow: '0 4px 12px rgba(239,68,68,0.25)' }}
            >
              <Menu size={18} strokeWidth={2.1} />
            </button>
            {pendingApprovals.length > 0 ? (
              <span className="remodex-approval-badge">{pendingApprovals.length}</span>
            ) : null}
          </div>
          <div className="remodex-title-shell">
            <div className="remodex-title-stack">
              <span className="remodex-title-kicker">{headerLabel}</span>
              <h1>{activeTitle}</h1>
              <p>{activeSubtitle}</p>
            </div>
          </div>
          <button
            type="button"
            className="remodex-diff-pill"
            onClick={openDiffViewer}
            disabled={!reviewFiles.length}
            aria-label={`Open diff sheet with +${focusedAdditions ?? 0}, -${focusedDeletions ?? 0}, ${reviewFiles.length} ${diffFileLabel}`}
          >
            <span className="remodex-diff-pill-stats" aria-hidden="true">
              <span className="remodex-diff-pill-chip remodex-diff-pill-chip-add">+{focusedAdditions ?? 0}</span>
              <span className="remodex-diff-pill-chip remodex-diff-pill-chip-remove">-{focusedDeletions ?? 0}</span>
            </span>
            <span className="remodex-diff-pill-meta">
              <span className="remodex-diff-pill-count">{reviewFiles.length}</span>
              <span className="remodex-diff-pill-caption">{diffFileLabel}</span>
            </span>
            <SlidersHorizontal size={15} strokeWidth={2} />
          </button>
        </header>

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
              projectGroups={projectGroups}
              expandedProject={expandedProject}
              selectedSession={selectedSession}
              onSessionFocus={handleSessionFocus}
              onProjectToggle={(workspace) => setExpandedProject(workspace)}
              onCostsView={() => setActiveView('costs')}
              agentDisplayName={agentDisplayName}
            />
          ) : null}

          {selectedSession?.activity && selectedSession.status !== 'idle' ? (
            <div className="remodex-activity-bar">
              <span className="remodex-activity-dot" />
              <span className="remodex-activity-label">{selectedSession.activity.headline}</span>
              {selectedSession.activity.filePath ? (
                <span className="remodex-activity-file">{selectedSession.activity.filePath.split('/').pop()}</span>
              ) : null}
            </div>
          ) : null}

          {statusTone !== 'calm' ? (
            <div className={`remodex-context-system-msg remodex-context-system-msg-${statusTone}`}>
              <span className="remodex-context-system-dot" />
              <span>{statusHeadline} · {statusMeta}</span>
            </div>
          ) : null}

          {refreshError ? <p className="remodex-banner-note">{refreshError}</p> : null}
          {surfaceNote ? <p className="remodex-banner-note">{surfaceNote}</p> : null}
          {transcriptError ? <p className="remodex-banner-note">{transcriptError}</p> : null}
          {selectedReviewPacketError ? <p className="remodex-banner-note">{selectedReviewPacketError}</p> : null}

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

          <div className="remodex-runtime-bar">
            <div className={`remodex-runtime-pressure remodex-runtime-pressure-${statusTone}`}>
              <span className="remodex-pressure-dot" />
              <span className="remodex-pressure-label">{statusHeadline}</span>
              <span className="remodex-pressure-sep">·</span>
              <GitBranch size={12} strokeWidth={1.6} />
              <span className="remodex-pressure-branch">{compactLine(snapshot.review?.branch ?? selectedSession?.branch ?? 'main', 'main', 18)}</span>
            </div>
          </div>
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

      {expandedMedia ? (
        <div className="remodex-media-overlay" role="dialog" aria-modal="true" onClick={() => setExpandedMedia(null)}>
          <section className="remodex-media-lightbox" onClick={(event) => event.stopPropagation()}>
            <div className="remodex-media-lightbox-head">
              <strong>{expandedMedia.name}</strong>
              <button type="button" className="remodex-sheet-icon-button" onClick={() => setExpandedMedia(null)} aria-label="Close media viewer">
                <X size={16} strokeWidth={2.1} />
              </button>
            </div>
            <div className="remodex-media-lightbox-body">
              {isImageMedia(expandedMedia) ? (
                <Image
                  src={mediaHref(expandedMedia.path)}
                  alt={expandedMedia.name}
                  width={1600}
                  height={1200}
                  unoptimized
                  className="remodex-media-lightbox-image"
                />
              ) : (
                <div className="remodex-media-lightbox-file">
                  <FileText size={32} strokeWidth={2.1} />
                  <p>{expandedMedia.name}</p>
                </div>
              )}
            </div>
            <div className="remodex-media-lightbox-actions">
              <a href={mediaHref(expandedMedia.path)} target="_blank" rel="noreferrer" className="remodex-media-action-link">
                <ExternalLink size={16} strokeWidth={2.1} />
                Open
              </a>
              <a href={mediaHref(expandedMedia.path, true)} download={expandedMedia.name} className="remodex-media-action-link remodex-media-action-link-primary">
                <Download size={16} strokeWidth={2.1} />
                Save
              </a>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
