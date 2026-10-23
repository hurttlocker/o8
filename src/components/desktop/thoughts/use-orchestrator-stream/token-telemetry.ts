import { useCallback, useRef } from 'react';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { refreshOrchestratorTokenTelemetry, requestOrchestratorCompaction } from './session';

interface RefLike<T> { current: T }

/** Keep the context measurement and its provenance bound to the same value. */
export function useOrchestratorTokenTelemetry(options: {
  repoPathRef: RefLike<string | null>;
  threadIdRef: RefLike<string | null>;
  lastBackendRef: RefLike<string | null>;
  updateRunningTotal: (value: number) => void;
  setTokenCount: (value: number) => void;
  telemetryBindingRef: RefLike<string | null>;
  telemetryTotalRef: RefLike<number | null>;
}) {
  const { repoPathRef, threadIdRef, lastBackendRef, updateRunningTotal, setTokenCount, telemetryBindingRef, telemetryTotalRef } = options;
  const measurementRef = useRef<{ tokens: number; source: string; binding: string | null } | null>(null);
  const refreshTokenTelemetry = useCallback(async () => {
    let measuredTokens = 0;
    return await refreshOrchestratorTokenTelemetry({
      repoPath: repoPathRef.current,
      threadId: threadIdRef.current,
      backend: isOrchestratorBackendId(lastBackendRef.current) ? lastBackendRef.current : null,
      setRunningTotal: (tokens) => { measuredTokens = tokens; updateRunningTotal(tokens); },
      setTokenCount,
      setContextSource: (source) => {
        measurementRef.current = { tokens: measuredTokens, source: source ?? 'runtime-context', binding: telemetryBindingRef.current };
      },
      telemetryBindingRef,
      telemetryTotalRef,
    });
  }, [repoPathRef, threadIdRef, lastBackendRef, updateRunningTotal, setTokenCount, telemetryBindingRef, telemetryTotalRef]);

  const requestCompaction = useCallback(async (
    activeRepoPath: string,
    nextRunningTotal: number,
    compactOptions?: Parameters<typeof requestOrchestratorCompaction>[2],
  ) => {
    const activeThreadId = compactOptions?.threadId ?? threadIdRef.current;
    if (!activeThreadId) return null;
    const measurement = measurementRef.current;
    const sameMeasurement = measurement?.tokens === nextRunningTotal
      && measurement.binding === `${activeThreadId}\0${lastBackendRef.current}`;
    return await requestOrchestratorCompaction(activeRepoPath, nextRunningTotal, {
      ...compactOptions,
      threadId: activeThreadId,
      contextSource: sameMeasurement ? measurement.source : 'transcript-estimate',
    });
  }, [threadIdRef, lastBackendRef]);
  return { refreshTokenTelemetry, requestCompaction };
}
