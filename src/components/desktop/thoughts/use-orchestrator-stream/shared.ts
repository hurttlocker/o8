import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { getBrowserWsPort } from '@/lib/panel/ws-port-client';
import type { ThoughtsOrchestratorBusyState } from '@/components/desktop/thoughts/chat-panel/types';

export type OrchestratorStreamStatus = 'connecting' | 'ready' | 'busy' | 'error' | 'dead';

export type OrchestratorPermissionMode = 'full' | 'plan';
export const DEFAULT_ORCHESTRATOR_MODEL = 'claude-opus-4-7';

export const ORCHESTRATOR_CONTEXT_LIMIT = 1_000_000;
export const ORCHESTRATOR_AUTO_COMPACT_RESET_FLOOR = 250_000;
export const ORCHESTRATOR_AUTO_COMPACT_THRESHOLD = 300_000;
export const ORCHESTRATOR_FORCE_COMPACT_THRESHOLD = Math.floor(ORCHESTRATOR_CONTEXT_LIMIT * 0.85);
export const ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS = 4_000;
export const ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS = 8_000;
export const ORCHESTRATOR_COMPACTION_STATUS_MIN_MS = 1_200;
export const ORCHESTRATOR_TOKEN_EVENT = 'cortex:orchestrator-token-usage';

export interface OrchestratorTokenUsageDetail {
  repoPath: string | null;
  tokenCount: number;
  runningTotal: number;
}

export interface CompactResponsePayload {
  ok?: boolean;
  applied?: boolean;
  transcript?: MobileTranscriptEntry[];
  resumePrelude?: string | null;
  tokensAfter?: number;
}

export function approxTokens(value: string): number {
  return Math.max(0, Math.ceil(value.trim().length / 4));
}

export function sortTranscriptEntries(entries: MobileTranscriptEntry[]) {
  return [...entries].sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
}

export function normalizeRepoPath(value: string | null | undefined) {
  return (value ?? '').trim().replace(/\/+$/, '');
}

export function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const { hostname, port, protocol } = window.location;
  const token = document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? '';
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';

  if (isLocal) {
    return `ws://${hostname}:${getBrowserWsPort()}/ws?token=${encodeURIComponent(token)}`;
  }

  const wsPort = port ? `:${port}` : '';
  return `${wsProto}://${hostname}${wsPort}/ws?token=${encodeURIComponent(token)}`;
}

function normalizeTelemetryPath(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '').replace(/^~(?=\/)/, '');
}

export function scoreTelemetryPath(candidate: string | null | undefined, repoPath: string): number {
  const normalizedCandidate = normalizeTelemetryPath(candidate);
  const normalizedRepo = normalizeTelemetryPath(repoPath);
  if (!normalizedCandidate || !normalizedRepo) return 0;
  if (normalizedCandidate === normalizedRepo) return 4;
  if (normalizedRepo.endsWith(normalizedCandidate) || normalizedCandidate.endsWith(normalizedRepo)) return 3;
  const candidateName = normalizedCandidate.split('/').filter(Boolean).pop();
  const repoName = normalizedRepo.split('/').filter(Boolean).pop();
  return candidateName && candidateName === repoName ? 1 : 0;
}

export function emitTokenUsage(detail: OrchestratorTokenUsageDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OrchestratorTokenUsageDetail>(ORCHESTRATOR_TOKEN_EVENT, { detail }));
}

export function formatTimestampLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function createIdleBusyState(): ThoughtsOrchestratorBusyState {
  return {
    active: false,
    startedAt: null,
    toolCallsStarted: 0,
    toolCallsCompleted: 0,
    latestToolLabel: null,
  };
}
