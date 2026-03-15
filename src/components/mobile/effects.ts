import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from 'react';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import type {
  MobileInboxSnapshot,
  MobileReviewFileResponse,
  MobileRuntimeTailGroup,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';
import type { ActionState, PendingOwnedTurn, SessionSummary } from './types';
import { mobileSyncOnce } from './controller';

interface ViewportOffsetArgs {
  setViewportTopOffset: Dispatch<SetStateAction<number>>;
}

export function trackViewportTopOffset({ setViewportTopOffset }: ViewportOffsetArgs) {
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
}

interface LiveInboxArgs {
  setSnapshot: Dispatch<SetStateAction<MobileInboxSnapshot>>;
  setRefreshError: Dispatch<SetStateAction<string | null>>;
}

export function startLiveInboxRefresh({ setSnapshot, setRefreshError }: LiveInboxArgs) {
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
}

interface ScrollChromeArgs {
  setScrollY: Dispatch<SetStateAction<number>>;
  setIsScrolling: Dispatch<SetStateAction<boolean>>;
  setHeaderVisible: Dispatch<SetStateAction<boolean>>;
  scrollStopTimerRef: MutableRefObject<number | null>;
  headerRevealTimerRef: MutableRefObject<number | null>;
  stickToBottomRef: MutableRefObject<boolean>;
  isWindowNearBottom: (threshold?: number) => boolean;
}

export function trackScrollChrome({
  setScrollY,
  setIsScrolling,
  setHeaderVisible,
  scrollStopTimerRef,
  headerRevealTimerRef,
  stickToBottomRef,
  isWindowNearBottom,
}: ScrollChromeArgs) {
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
}

interface VisibilityRefreshArgs {
  documentVisibleRef: MutableRefObject<boolean>;
  selectedSessionKey?: string;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
  refreshInbox: () => Promise<unknown>;
}

export function trackVisibilityRefresh({
  documentVisibleRef,
  selectedSessionKey,
  loadHistory,
  refreshInbox,
}: VisibilityRefreshArgs) {
  const handler = () => {
    documentVisibleRef.current = document.visibilityState === 'visible';
    if (documentVisibleRef.current && selectedSessionKey) {
      void loadHistory(selectedSessionKey, true).catch(() => undefined);
      void refreshInbox().catch(() => undefined);
    }
  };

  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

interface SessionPollingArgs {
  selectedSessionKey?: string;
  selectedSession?: SessionSummary;
  pendingOwnedTurnBySession: Record<string, PendingOwnedTurn>;
  actionStateBySession: Record<string, ActionState>;
  waitingForResponse: boolean;
  diffOpen: boolean;
  selectedReviewFilePath: string | null;
  documentVisibleRef: MutableRefObject<boolean>;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
  refreshInbox: () => Promise<unknown>;
  loadOwnedReviewPacket: (sessionKey: string, force?: boolean) => Promise<RuntimeReviewPacket | null | undefined>;
  loadReviewFile: (reviewPath: string, force?: boolean) => Promise<MobileReviewFileResponse['file'] | undefined>;
}

export function startSessionPolling({
  selectedSessionKey,
  selectedSession,
  pendingOwnedTurnBySession,
  actionStateBySession,
  waitingForResponse,
  diffOpen,
  selectedReviewFilePath,
  documentVisibleRef,
  loadHistory,
  refreshInbox,
  loadOwnedReviewPacket,
  loadReviewFile,
}: SessionPollingArgs) {
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
        : 20000;

  const timer = window.setInterval(() => {
    if (!documentVisibleRef.current) return;

    void loadHistory(selectedSessionKey, true).catch(() => undefined);
    if (isActive) {
      void refreshInbox().catch(() => undefined);
    }
    if (selectedSessionKey.startsWith('codex-owned:')) {
      void loadOwnedReviewPacket(selectedSessionKey, true).catch(() => undefined);
    }
    if (selectedReviewFilePath && diffOpen && (isActive || selectedSessionKey.startsWith('codex-owned:'))) {
      void loadReviewFile(selectedReviewFilePath, true).catch(() => undefined);
    }
  }, intervalMs);

  return () => {
    window.clearInterval(timer);
  };
}

interface LinkedOwnedPollingArgs {
  linkedOwnedKey: string | null;
  documentVisibleRef: MutableRefObject<boolean>;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
}

export function startLinkedOwnedPolling({
  linkedOwnedKey,
  documentVisibleRef,
  loadHistory,
}: LinkedOwnedPollingArgs) {
  if (!linkedOwnedKey) {
    return;
  }

  const timer = window.setInterval(() => {
    if (!documentVisibleRef.current) return;
    void loadHistory(linkedOwnedKey, true).catch(() => undefined);
  }, 3000);

  return () => window.clearInterval(timer);
}

// ── Unified sync polling (replaces inbox + session + linked polling) ──

interface UnifiedSyncPollingArgs {
  selectedSessionKey?: string;
  selectedSession?: SessionSummary;
  linkedOwnedKey: string | null;
  pendingOwnedTurnBySession: Record<string, PendingOwnedTurn>;
  actionStateBySession: Record<string, ActionState>;
  waitingForResponse: boolean;
  diffOpen: boolean;
  selectedReviewFilePath: string | null;
  documentVisibleRef: MutableRefObject<boolean>;
  historyBySession: Record<string, MobileTranscriptEntry[]>;
  // State setters for sync
  setSnapshot: Dispatch<SetStateAction<MobileInboxSnapshot>>;
  setRefreshError: Dispatch<SetStateAction<string | null>>;
  setHistoryBySession: Dispatch<SetStateAction<Record<string, MobileTranscriptEntry[]>>>;
  setHistoryGroupsBySession: Dispatch<SetStateAction<Record<string, MobileRuntimeTailGroup[]>>>;
  setReviewFileByPath: Dispatch<SetStateAction<Record<string, MobileReviewFileResponse['file']>>>;
  // Legacy loaders for owned review packet (stays separate — not in sync endpoint yet)
  loadOwnedReviewPacket: (sessionKey: string, force?: boolean) => Promise<RuntimeReviewPacket | null | undefined>;
}

export function startUnifiedSyncPolling(args: UnifiedSyncPollingArgs) {
  const {
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
  } = args;

  // Determine polling interval based on activity level
  const ownedActive = selectedSessionKey?.startsWith('codex-owned:')
    && (
      selectedSession?.runtimeSurface?.lifecycle?.availability === 'running'
      || Boolean(selectedSessionKey && pendingOwnedTurnBySession[selectedSessionKey])
      || (selectedSessionKey && actionStateBySession[selectedSessionKey] === 'steering')
    );
  const isActive = ownedActive || selectedSession?.status === 'running' || waitingForResponse;
  const intervalMs = ownedActive
    ? 1500
    : selectedSessionKey?.startsWith('codex-owned:')
      ? 4000
      : isActive
        ? 2500
        : 20000;

  function getLastId(sessionKey: string): string | undefined {
    const entries = historyBySession[sessionKey];
    if (!entries?.length) return undefined;
    const last = entries[entries.length - 1];
    return last?.id?.startsWith('optimistic-') ? undefined : last?.id;
  }

  async function tick() {
    if (!documentVisibleRef.current) return;

    const wantReviewFile = !!(
      selectedReviewFilePath
      && diffOpen
      && (isActive || selectedSessionKey?.startsWith('codex-owned:'))
    );

    await mobileSyncOnce({
      wantInbox: isActive || !selectedSessionKey, // Always sync inbox when idle on squad view
      historySessionKey: selectedSessionKey,
      historyLastId: selectedSessionKey ? getLastId(selectedSessionKey) : undefined,
      reviewFilePath: wantReviewFile ? selectedReviewFilePath ?? undefined : undefined,
      linkedSessionKey: linkedOwnedKey ?? undefined,
      linkedLastId: linkedOwnedKey ? getLastId(linkedOwnedKey) : undefined,
      setSnapshot,
      setRefreshError,
      setHistoryBySession,
      setHistoryGroupsBySession,
      setReviewFileByPath,
    });

    // Owned review packet stays on the legacy endpoint (not consolidated yet)
    if (selectedSessionKey?.startsWith('codex-owned:')) {
      void loadOwnedReviewPacket(selectedSessionKey, true).catch(() => undefined);
    }
  }

  // Initial sync
  void tick();
  const timer = window.setInterval(() => void tick(), intervalMs);

  return () => window.clearInterval(timer);
}

interface TranscriptStreamArgs {
  selectedSessionKey?: string;
  sessions: SessionSummary[];
  setHistoryBySession: Dispatch<SetStateAction<Record<string, MobileTranscriptEntry[]>>>;
  setStreamingText: Dispatch<SetStateAction<string>>;
  streamingTextRef: MutableRefObject<string>;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
}

export function connectTranscriptStream({
  selectedSessionKey,
  sessions,
  setHistoryBySession,
  setStreamingText,
  streamingTextRef,
  loadHistory,
}: TranscriptStreamArgs) {
  if (!selectedSessionKey || typeof window === 'undefined') return;
  const session = sessions.find((item) => item.sessionKey === selectedSessionKey);
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
      } catch {
        // Ignore malformed events.
      }
    });

    es.addEventListener('chat-done', (event) => {
      if (disposed) return;
      streamingTextRef.current = '';
      setStreamingText('');
      try {
        const data = JSON.parse(event.data);
        if (data.text && selectedSessionKey) {
          setHistoryBySession((current) => {
            const prev = current[selectedSessionKey] ?? [];
            if (prev.length > 0 && prev[prev.length - 1]?.text === data.text) {
              return current;
            }
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
      } catch {
        // Ignore malformed events.
      }
      void loadHistory(selectedSessionKey, true).catch(() => undefined);
    });

    es.addEventListener('chat-error', () => {
      if (disposed) return;
      streamingTextRef.current = '';
      setStreamingText('');
    });

    es.onerror = () => {
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
}

interface ScrollPinArgs {
  selectedSessionKey?: string;
  transcriptEntries: MobileTranscriptEntry[];
  transcriptGroups: MobileRuntimeTailGroup[];
  pendingOwnedTurn: PendingOwnedTurn | null;
  initialBottomPinBySessionRef: MutableRefObject<Record<string, boolean>>;
  transcriptBottomRef: RefObject<HTMLDivElement | null>;
  stickToBottomRef: MutableRefObject<boolean>;
}

export function pinTranscriptToBottom({
  selectedSessionKey,
  transcriptEntries,
  transcriptGroups,
  pendingOwnedTurn,
  initialBottomPinBySessionRef,
  transcriptBottomRef,
  stickToBottomRef,
}: ScrollPinArgs) {
  if (!selectedSessionKey || typeof window === 'undefined') {
    return;
  }
  if (!transcriptEntries.length && !transcriptGroups.length && !pendingOwnedTurn) {
    return;
  }

  const isFirstLoad = !initialBottomPinBySessionRef.current[selectedSessionKey];
  if (isFirstLoad) {
    initialBottomPinBySessionRef.current[selectedSessionKey] = true;
    const runPin = () => transcriptBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
    const frameA = window.requestAnimationFrame(() => {
      runPin();
      window.requestAnimationFrame(runPin);
    });
    return () => window.cancelAnimationFrame(frameA);
  }

  if (!stickToBottomRef.current) {
    return;
  }

  const frame = window.requestAnimationFrame(() => {
    transcriptBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  });
  return () => window.cancelAnimationFrame(frame);
}
