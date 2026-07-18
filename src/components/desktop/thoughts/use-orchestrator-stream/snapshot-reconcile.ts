import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorStreamStatus } from './shared';
import { formatTimestampLabel } from './shared';

const NO_EVENT_STALE_MS = 120_000;
const ACTIVE_TURN_STALE_MS = 390_000;
const FALLBACK_POLL_MS = 15_000;

interface NoSnapshotBusyFallbackOptions {
  repoPath: string | null;
  snapshotSeenRef: RefObject<boolean>;
  statusRef: RefObject<OrchestratorStreamStatus>;
  lastEventAtRef: RefObject<number>;
  turnTranscriptEventCountRef: RefObject<number>;
  messagesRef: RefObject<MobileTranscriptEntry[]>;
  setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>>;
  healStaleBusyState: (reason: string) => void;
}

export function appendSnapshotTurnFailure(
  turnId: string,
  setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>>,
  messagesRef: RefObject<MobileTranscriptEntry[]>,
) {
  const id = `orch-turn-failed-${turnId}`;
  setMessages((prev) => {
    if (prev.some((message) => message.id === id)) return prev;
    const at = Date.now();
    const next = [...prev, {
      id,
      role: 'system' as const,
      text: 'Orchestrator error: The server reports that this turn failed before the client received its terminal event. Re-send to retry.',
      isError: true,
      timestamp: at,
      timestampLabel: formatTimestampLabel(at),
    }];
    messagesRef.current = next;
    return next;
  });
}

export function useNoSnapshotBusyFallback(options: NoSnapshotBusyFallbackOptions) {
  const {
    repoPath,
    snapshotSeenRef,
    statusRef,
    lastEventAtRef,
    turnTranscriptEventCountRef,
    messagesRef,
    setMessages,
    healStaleBusyState,
  } = options;
  useEffect(() => {
    if (!repoPath) return;

    const interval = setInterval(() => {
      if (snapshotSeenRef.current || statusRef.current !== 'busy') return;
      const quietFor = Date.now() - lastEventAtRef.current;
      const sawTranscript = turnTranscriptEventCountRef.current > 0;
      const deadline = sawTranscript ? ACTIVE_TURN_STALE_MS : NO_EVENT_STALE_MS;
      if (quietFor < deadline) return;

      if (!sawTranscript) {
        const at = Date.now();
        setMessages((prev) => {
          const next = [...prev, {
            id: `orch-stale-no-events-${at}`,
            role: 'system' as const,
            text: 'Orchestrator error: This turn produced no transcript events before the client fallback expired. Re-send to retry.',
            isError: true,
            timestamp: at,
            timestampLabel: formatTimestampLabel(at),
          }];
          messagesRef.current = next;
          return next;
        });
      }
      healStaleBusyState(
        `no snapshot and no events for ${Math.round(quietFor / 1000)}s while status=busy`,
      );
    }, FALLBACK_POLL_MS);

    return () => clearInterval(interval);
  }, [healStaleBusyState, lastEventAtRef, messagesRef, repoPath, setMessages, snapshotSeenRef, statusRef, turnTranscriptEventCountRef]);
}
