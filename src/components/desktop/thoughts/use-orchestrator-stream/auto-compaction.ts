'use client';

import { useEffect } from 'react';
import { isMeteredOrchestratorBackend } from '@/lib/lane/orchestrator-backends/billing';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { hasQueuedOrchestratorSessionPrelude } from '@/lib/orchestrator/store';
import {
  ORCHESTRATOR_AUTO_COMPACT_RESET_FLOOR,
  ORCHESTRATOR_AUTO_COMPACT_THRESHOLD,
  ORCHESTRATOR_METERED_AUTO_COMPACT_RESET_FLOOR,
  ORCHESTRATOR_METERED_AUTO_COMPACT_THRESHOLD,
  type CompactResponsePayload,
  type OrchestratorStreamStatus,
} from './shared';

interface RefLike<T> {
  current: T;
}

interface AutoCompactionOptions {
  repoPath: string | null;
  threadId: string | null;
  runningTotal: number;
  status: OrchestratorStreamStatus;
  lastBackendRef: RefLike<string | null>;
  threadIdRef: RefLike<string | null>;
  statusRef: RefLike<OrchestratorStreamStatus>;
  inFlightRef: RefLike<boolean>;
  armedRef: RefLike<boolean>;
  requestCompaction: (
    repoPath: string,
    runningTotal: number,
    options: { threadId: string | null },
  ) => Promise<CompactResponsePayload | null>;
  primeCompactedSession: (
    repoPath: string,
    payload: CompactResponsePayload | null,
    options: { setTranscript: boolean; threadId: string | null },
  ) => Promise<unknown>;
}

export function useOrchestratorAutoCompaction(options: AutoCompactionOptions) {
  const {
    armedRef,
    inFlightRef,
    lastBackendRef,
    primeCompactedSession,
    repoPath,
    requestCompaction,
    runningTotal,
    status,
    statusRef,
    threadId,
    threadIdRef,
  } = options;
  useEffect(() => {
    if (!repoPath) return;
    // Metered backends compact at the smaller window target. This only runs
    // between turns so a compaction never rewrites the prompt-cache prefix
    // while a turn is active.
    const metered = lastBackendRef.current !== null
      && isOrchestratorBackendId(lastBackendRef.current)
      && isMeteredOrchestratorBackend(lastBackendRef.current);
    const resetFloor = metered ? ORCHESTRATOR_METERED_AUTO_COMPACT_RESET_FLOOR : ORCHESTRATOR_AUTO_COMPACT_RESET_FLOOR;
    const threshold = metered ? ORCHESTRATOR_METERED_AUTO_COMPACT_THRESHOLD : ORCHESTRATOR_AUTO_COMPACT_THRESHOLD;
    if (runningTotal < resetFloor) armedRef.current = true;
    if (status !== 'ready' || runningTotal < threshold || inFlightRef.current || !armedRef.current) return;
    if (hasQueuedOrchestratorSessionPrelude(repoPath, threadIdRef.current)) return;
    inFlightRef.current = true;
    armedRef.current = false;
    const compactThreadId = threadIdRef.current;
    let started = false;
    const timer = window.setTimeout(() => {
      started = true;
      void (async () => {
        try {
          const payload = await requestCompaction(repoPath, runningTotal, {
            threadId: compactThreadId,
          });
          if (
            !payload?.ok
            || !payload.applied
            || !Array.isArray(payload.transcript)
            || statusRef.current !== 'ready'
            || threadIdRef.current !== compactThreadId
          ) {
            armedRef.current = true;
            return;
          }
          // Auto-compaction is silent: replacing the visible transcript would
          // erase client-only cards and system notes.
          await primeCompactedSession(repoPath, payload, {
            setTranscript: false,
            threadId: compactThreadId,
          });
        } catch {
          armedRef.current = true;
        } finally {
          inFlightRef.current = false;
        }
      })();
    }, 800);
    return () => {
      window.clearTimeout(timer);
      if (!started) inFlightRef.current = false;
    };
  }, [
    armedRef,
    inFlightRef,
    lastBackendRef,
    primeCompactedSession,
    repoPath,
    requestCompaction,
    runningTotal,
    status,
    statusRef,
    threadId,
    threadIdRef,
  ]);
}
