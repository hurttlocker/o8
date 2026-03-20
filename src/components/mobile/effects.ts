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
    // TopBar always visible — never hide hamburger on scroll
    setHeaderVisible(true);
    clearHeaderReveal();
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

/**
 * Polling interval tier — used as the effect dependency instead of the raw
 * objects. This prevents the polling loop from restarting when objects like
 * actionStateBySession or pendingOwnedTurnBySession churn identity without
 * changing the actual polling speed (#193).
 */
export type PollingTier = 'ws-safety' | 'owned-active' | 'owned-idle' | 'active' | 'idle';

const POLLING_INTERVALS: Record<PollingTier, number> = {
  'ws-safety': 30_000,
  'owned-active': 1500,
  'owned-idle': 4000,
  'active': 2500,
  'idle': 20000,
};

export function computePollingTier(args: {
  wsConnected?: boolean;
  selectedSessionKey?: string;
  selectedSession?: SessionSummary;
  pendingOwnedTurnBySession: Record<string, PendingOwnedTurn>;
  actionStateBySession: Record<string, ActionState>;
  waitingForResponse: boolean;
}): PollingTier {
  if (args.wsConnected) return 'ws-safety';
  const sk = args.selectedSessionKey;
  const isOwned = sk?.startsWith('codex-owned:');
  const ownedActive = isOwned && (
    args.selectedSession?.runtimeSurface?.lifecycle?.availability === 'running'
    || Boolean(sk && args.pendingOwnedTurnBySession[sk])
    || (sk != null && args.actionStateBySession[sk] === 'steering')
  );
  if (ownedActive) return 'owned-active';
  if (isOwned) return 'owned-idle';
  const isActive = args.selectedSession?.status === 'running' || args.waitingForResponse;
  return isActive ? 'active' : 'idle';
}

interface UnifiedSyncPollingArgs {
  /** Stable polling tier — only restarts the loop when this changes */
  pollingTier: PollingTier;
  selectedSessionKey?: string;
  linkedOwnedKey: string | null;
  diffOpen: boolean;
  selectedReviewFilePath: string | null;
  documentVisibleRef: MutableRefObject<boolean>;
  /** Stable ref to historyBySession — avoids putting the state object in deps which causes a restart loop */
  historyBySessionRef: MutableRefObject<Record<string, MobileTranscriptEntry[]>>;
  // Refs for churny values read during tick, not in the dependency array
  pollingTierRef: MutableRefObject<PollingTier>;
  selectedSessionKeyRef: MutableRefObject<string | undefined>;
  linkedOwnedKeyRef: MutableRefObject<string | null>;
  diffOpenRef: MutableRefObject<boolean>;
  selectedReviewFilePathRef: MutableRefObject<string | null>;
  // State setters for sync
  setSnapshot: Dispatch<SetStateAction<MobileInboxSnapshot>>;
  setRefreshError: Dispatch<SetStateAction<string | null>>;
  setHistoryBySession: Dispatch<SetStateAction<Record<string, MobileTranscriptEntry[]>>>;
  setHistoryGroupsBySession: Dispatch<SetStateAction<Record<string, MobileRuntimeTailGroup[]>>>;
  setReviewFileByPath: Dispatch<SetStateAction<Record<string, MobileReviewFileResponse['file']>>>;
  // Legacy loaders for owned review packet (stays separate — not in sync endpoint yet)
  loadOwnedReviewPacketRef: MutableRefObject<(sessionKey: string, force?: boolean) => Promise<RuntimeReviewPacket | null | undefined>>;
}

export function startUnifiedSyncPolling(args: UnifiedSyncPollingArgs) {
  const {
    pollingTier,
    documentVisibleRef,
    historyBySessionRef,
    pollingTierRef,
    selectedSessionKeyRef,
    linkedOwnedKeyRef,
    diffOpenRef,
    selectedReviewFilePathRef,
  setSnapshot,
  setRefreshError,
  setHistoryBySession,
  setReviewFileByPath,
  loadOwnedReviewPacketRef,
} = args;

  const intervalMs = POLLING_INTERVALS[pollingTier];

  function getLastId(sessionKey: string): string | undefined {
    const entries = historyBySessionRef.current[sessionKey];
    if (!entries?.length) return undefined;
    const last = entries[entries.length - 1];
    return last?.id?.startsWith('optimistic-') ? undefined : last?.id;
  }

  async function tick() {
    if (!documentVisibleRef.current) return;

    // Read current values from refs — these may have changed since the
    // effect started, but we don't restart the timer for them.
    const sk = selectedSessionKeyRef.current;
    const linked = linkedOwnedKeyRef.current;
    const tier = pollingTierRef.current;
    const isActive = tier === 'owned-active' || tier === 'active';

    const wantReviewFile = !!(
      selectedReviewFilePathRef.current
      && diffOpenRef.current
      && (isActive || sk?.startsWith('codex-owned:'))
    );

    await mobileSyncOnce({
      wantInbox: isActive || !sk,
      historySessionKey: sk,
      historyLastId: sk ? getLastId(sk) : undefined,
      reviewFilePath: wantReviewFile ? selectedReviewFilePathRef.current ?? undefined : undefined,
      linkedSessionKey: linked ?? undefined,
      linkedLastId: linked ? getLastId(linked) : undefined,
      setSnapshot,
      setRefreshError,
      setHistoryBySession,
      setReviewFileByPath,
    });

    // Owned review packet stays on the legacy endpoint (not consolidated yet)
    if (sk?.startsWith('codex-owned:')) {
      void loadOwnedReviewPacketRef.current(sk, true).catch(() => undefined);
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
}

export function pinTranscriptToBottom({
  selectedSessionKey,
  transcriptEntries,
  transcriptGroups,
  pendingOwnedTurn,
  initialBottomPinBySessionRef,
  transcriptBottomRef,
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

  // Auto-scroll disabled — user controls scroll position.
  // The "new messages" pill handles manual scroll-to-bottom.
  return;
}
