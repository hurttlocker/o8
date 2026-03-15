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

// ── Unified sync polling ──

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
  /** Stable ref to historyBySession — avoids putting the state object in deps which causes a restart loop */
  historyBySessionRef: MutableRefObject<Record<string, MobileTranscriptEntry[]>>;
  /** When true, WebSocket is handling real-time push — polling backs off to safety-net interval */
  wsConnected?: boolean;
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
    historyBySessionRef,
    wsConnected,
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

  // When WS is connected, polling is just a safety net (30s).
  // When WS is down, polling runs at normal speed.
  const intervalMs = wsConnected
    ? 30_000
    : ownedActive
      ? 1500
      : selectedSessionKey?.startsWith('codex-owned:')
        ? 4000
        : isActive
          ? 2500
          : 20000;

  function getLastId(sessionKey: string): string | undefined {
    const entries = historyBySessionRef.current[sessionKey];
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
