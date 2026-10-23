import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { estimateOrchestratorContext } from '@/lib/orchestrator/context-estimate';
import { queueOrchestratorSessionPrelude } from '@/lib/orchestrator/store';
import {
  ORCHESTRATOR_CONTEXT_LIMIT,
  emitTokenUsage,
  type CompactResponsePayload,
} from './shared';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { mergeCompactionMarkers } from '@/lib/transcripts/compaction';

interface RefLike<T> {
  current: T;
}

interface RefreshTokenTelemetryOptions {
  repoPath: string | null;
  threadId: string | null;
  backend: OrchestratorBackendId | null;
  messages?: readonly MobileTranscriptEntry[];
  setRunningTotal: (value: number) => void;
  setTokenCount: (value: number) => void;
  setContextSource?: (value: string | undefined) => void;
  telemetryBindingRef: RefLike<string | null>;
  telemetryTotalRef: RefLike<number | null>;
}

interface RuntimeTelemetryResponse {
  telemetry?: {
    totalTokens?: number | null;
    contextTokens?: number | null;
    contextSource?: string;
    estimatedCostUsd?: number | null;
    model?: string | null;
  };
}

export async function refreshOrchestratorTokenTelemetry(
  options: RefreshTokenTelemetryOptions,
): Promise<{ totalTokens: number | null; estimatedCostUsd: number | null; model: string | null } | null> {
  const activeRepoPath = options.repoPath;
  const threadId = options.threadId?.trim() ?? '';
  const backend = options.backend;
  if (!activeRepoPath || !threadId.startsWith('thoughts-') || !backend) {
    options.telemetryBindingRef.current = null;
    options.telemetryTotalRef.current = null;
    return null;
  }

  const binding = `${threadId}\0${backend}`;
  if (options.telemetryBindingRef.current !== binding) {
    options.telemetryBindingRef.current = binding;
    options.telemetryTotalRef.current = null;
  }
  let telemetry: RuntimeTelemetryResponse['telemetry'];
  try {
    const params = new URLSearchParams({ threadId, backend });
    const response = await fetch(`/api/runtime/telemetry?${params.toString()}`, { cache: 'no-store' });
    if (response.ok) telemetry = (await response.json() as RuntimeTelemetryResponse).telemetry;
  } catch { /* An unavailable provider or endpoint still leaves a transcript estimate. */ }
  if (options.telemetryBindingRef.current !== binding) return null;

  // Never substitute billing totals: tool requests repeatedly bill the same
  // prompt. An absent, zero or invalid context report uses a named estimate.
  const rawContextTokens = telemetry?.contextTokens;
  const measured = typeof rawContextTokens === 'number' && Number.isFinite(rawContextTokens) && rawContextTokens > 0;
  const totalTokens = Math.min(ORCHESTRATOR_CONTEXT_LIMIT, measured
    ? rawContextTokens : estimateOrchestratorContext(options.messages ?? []));
  const source = measured ? telemetry?.contextSource ?? 'runtime-context' : 'transcript-estimate';
  const estimatedCostUsd = typeof telemetry?.estimatedCostUsd === 'number' ? telemetry.estimatedCostUsd : null;
  const telemetryModel = typeof telemetry?.model === 'string' ? telemetry.model : null;
  const previousTotal = options.telemetryTotalRef.current;
  const nextTokenCount = previousTotal === null || totalTokens < previousTotal
    ? 0 : Math.max(0, totalTokens - previousTotal);
  options.telemetryTotalRef.current = totalTokens;
  options.setTokenCount(nextTokenCount);
  options.setRunningTotal(totalTokens);
  options.setContextSource?.(source);
  emitTokenUsage({ repoPath: activeRepoPath, tokenCount: nextTokenCount, runningTotal: totalTokens });
  return { totalTokens, estimatedCostUsd, model: telemetryModel };

}

export async function requestOrchestratorCompaction(
  activeRepoPath: string,
  nextRunningTotal: number,
  options?: { keepTailCount?: number; trigger?: 'auto' | 'manual' | 'handoff'; threadId?: string | null; contextSource?: string },
): Promise<CompactResponsePayload | null> {
  const response = await fetch('/api/orchestrator/compact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repoPath: activeRepoPath,
      threadId: options?.threadId,
      runningTotal: nextRunningTotal,
      contextSource: options?.contextSource,
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
  telemetrySessionKeyRef: RefLike<string | null>;
  telemetryTotalRef: RefLike<number | null>;
  isCurrent?: () => boolean;
}

export async function primeCompactedOrchestratorSession(
  options: PrimeCompactedSessionOptions,
) {
  const { payload, repoPath } = options;
  if (!payload.ok || !payload.applied || !Array.isArray(payload.transcript)) return null;
  if (options.isCurrent && !options.isCurrent()) return null;

  await fetch('/api/orchestrator/reset-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath, threadId: options.threadId }),
  }).catch(() => null);
  if (options.isCurrent && !options.isCurrent()) return null;

  if (payload.resumePrelude) {
    queueOrchestratorSessionPrelude(repoPath, payload.resumePrelude, 'replace', options.threadId);
  }

  const nextTotal = typeof payload.tokensAfter === 'number' ? payload.tokensAfter : 0;
  options.telemetrySessionKeyRef.current = null;
  options.telemetryTotalRef.current = nextTotal;

  // The primed transcript is model context, not new conversation turns.
  // Even silent compaction adds its boundary while keeping the visible history.
  const display = mergeCompactionMarkers(options.messagesRef.current, payload.transcript);
  options.messagesRef.current = display;
  options.setMessages(display);

  options.setTokenCount(0);
  options.setRunningTotal(nextTotal);
  emitTokenUsage({ repoPath, tokenCount: 0, runningTotal: nextTotal });
  return {
    nextTotal,
    resumePrelude: payload.resumePrelude ?? null,
    transcript: payload.transcript,
  };
}
