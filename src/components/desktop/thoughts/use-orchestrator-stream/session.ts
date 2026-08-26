import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { queueOrchestratorSessionPrelude } from '@/lib/orchestrator/store';
import {
  ORCHESTRATOR_CONTEXT_LIMIT,
  emitTokenUsage,
  scoreTelemetryPath,
  type CompactResponsePayload,
} from './shared';

interface RefLike<T> {
  current: T;
}

interface RefreshTokenTelemetryOptions {
  repoPath: string | null;
  setRunningTotal: (value: number) => void;
  setTokenCount: (value: number) => void;
  telemetrySessionKeyRef: RefLike<string | null>;
  telemetryTotalRef: RefLike<number | null>;
}

interface RuntimeInventoryResponse {
  agents?: Array<{
    runtime?: string;
    sessionKey?: string;
    sessionKind?: string;
    status?: string;
    isCurrentSession?: boolean;
    workspace?: string;
    runtimeSurface?: { cwd?: string | null };
  }>;
}

interface RuntimeTelemetryResponse {
  telemetry?: {
    totalTokens?: number | null;
    contextTokens?: number | null;
    estimatedCostUsd?: number | null;
    model?: string | null;
  };
}

export async function refreshOrchestratorTokenTelemetry(
  options: RefreshTokenTelemetryOptions,
): Promise<{ totalTokens: number | null; estimatedCostUsd: number | null; model: string | null } | null> {
  const activeRepoPath = options.repoPath;
  if (!activeRepoPath) return null;

  try {
    let sessionKey = options.telemetrySessionKeyRef.current;
    if (!sessionKey) {
      const inventoryResponse = await fetch('/api/runtime/inventory?fresh=1', { cache: 'no-store' });
      const inventory = inventoryResponse.ok
        ? await inventoryResponse.json() as RuntimeInventoryResponse
        : null;
      sessionKey = (inventory?.agents ?? [])
        .map((agent) => {
          if (agent.runtime !== 'claude-code' || !agent.sessionKey) {
            return { score: -1, sessionKey: null as string | null };
          }
          const pathScore = Math.max(
            scoreTelemetryPath(agent.workspace, activeRepoPath),
            scoreTelemetryPath(agent.runtimeSurface?.cwd, activeRepoPath),
          );
          if (pathScore === 0) {
            return { score: -1, sessionKey: null as string | null };
          }
          return {
            score: pathScore * 10
              + (agent.sessionKind === 'owned' ? 6 : 0)
              + (agent.isCurrentSession ? 3 : 0)
              + (agent.status === 'running' || agent.status === 'reviewing' || agent.status === 'idle' ? 1 : 0),
            sessionKey: agent.sessionKey,
          };
        })
        .sort((left, right) => right.score - left.score)[0]?.sessionKey ?? null;
      options.telemetrySessionKeyRef.current = sessionKey;
    }
    if (!sessionKey) return null;

    const response = await fetch(`/api/runtime/telemetry?sessionKey=${encodeURIComponent(sessionKey)}`, { cache: 'no-store' });
    if (!response.ok) {
      options.telemetrySessionKeyRef.current = null;
      return null;
    }

    const payload = await response.json() as RuntimeTelemetryResponse;
    // Runtime totalTokens is the billable rollup and may include native child
    // work. Auto-compact and the context meter use only the tokens that entered
    // this parent session's own window.
    const rawContextTokens = typeof payload.telemetry?.contextTokens === 'number'
      ? payload.telemetry.contextTokens
      : payload.telemetry?.totalTokens;
    const totalTokens = typeof rawContextTokens === 'number'
      ? Math.max(0, Math.min(ORCHESTRATOR_CONTEXT_LIMIT, rawContextTokens))
      : null;
    const estimatedCostUsd = typeof payload.telemetry?.estimatedCostUsd === 'number'
      ? payload.telemetry.estimatedCostUsd
      : null;
    const telemetryModel = typeof payload.telemetry?.model === 'string' ? payload.telemetry.model : null;
    if (totalTokens == null) {
      return { totalTokens: null, estimatedCostUsd, model: telemetryModel };
    }

    const previousTotal = options.telemetryTotalRef.current;
    const nextTokenCount = previousTotal === null || totalTokens < previousTotal
      ? 0
      : Math.max(0, totalTokens - previousTotal);

    options.telemetryTotalRef.current = totalTokens;
    options.setTokenCount(nextTokenCount);
    options.setRunningTotal(totalTokens);
    emitTokenUsage({ repoPath: activeRepoPath, tokenCount: nextTokenCount, runningTotal: totalTokens });
    return { totalTokens, estimatedCostUsd, model: telemetryModel };
  } catch {
    return null;
  }
}

export async function requestOrchestratorCompaction(
  activeRepoPath: string,
  nextRunningTotal: number,
  nextMessages: MobileTranscriptEntry[],
  options?: { keepTailCount?: number; trigger?: 'auto' | 'manual' | 'handoff'; threadId?: string | null },
): Promise<CompactResponsePayload | null> {
  const response = await fetch('/api/orchestrator/compact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repoPath: activeRepoPath,
      threadId: options?.threadId,
      runningTotal: nextRunningTotal,
      messages: nextMessages,
      keepTailCount: options?.keepTailCount,
      trigger: options?.trigger,
    }),
  });
  if (!response.ok) return null;
  return await response.json() as CompactResponsePayload;
}

interface PrimeCompactedSessionOptions {
  messagesRef: RefLike<MobileTranscriptEntry[]>;
  payload: CompactResponsePayload;
  repoPath: string;
  threadId?: string | null;
  setMessages: (entries: MobileTranscriptEntry[]) => void;
  setRunningTotal: (value: number) => void;
  setTokenCount: (value: number) => void;
  setTranscript?: boolean;
  telemetrySessionKeyRef: RefLike<string | null>;
  telemetryTotalRef: RefLike<number | null>;
}

export async function primeCompactedOrchestratorSession(
  options: PrimeCompactedSessionOptions,
) {
  const { payload, repoPath } = options;
  if (!payload.ok || !payload.applied || !Array.isArray(payload.transcript)) return null;

  await fetch('/api/orchestrator/reset-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath, threadId: options.threadId }),
  }).catch(() => null);

  if (payload.resumePrelude) {
    queueOrchestratorSessionPrelude(repoPath, payload.resumePrelude, 'replace', options.threadId);
  }

  const nextTotal = typeof payload.tokensAfter === 'number' ? payload.tokensAfter : 0;
  options.telemetrySessionKeyRef.current = null;
  options.telemetryTotalRef.current = nextTotal;

  if (options.setTranscript !== false) {
    options.messagesRef.current = payload.transcript;
    options.setMessages(payload.transcript);
  }

  options.setTokenCount(0);
  options.setRunningTotal(nextTotal);
  emitTokenUsage({ repoPath, tokenCount: 0, runningTotal: nextTotal });
  return {
    nextTotal,
    resumePrelude: payload.resumePrelude ?? null,
    transcript: payload.transcript,
  };
}
