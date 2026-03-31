import type { OrchestratorPacketStatus } from '@/lib/orchestrator/types';

export interface NormalizeRuntimeStatusOptions {
  waitingAsRunning?: boolean;
  fallbackStatus?: OrchestratorPacketStatus | null;
}

export function normalizeRuntimeStatusToOrchestratorStatus(
  status?: string | null,
  options: NormalizeRuntimeStatusOptions = {},
): OrchestratorPacketStatus | null {
  const fallbackStatus = options.fallbackStatus === undefined ? 'idle' : options.fallbackStatus;
  const normalized = status?.trim().toLowerCase() ?? '';

  if (normalized === 'running' || normalized === 'working') {
    return 'running';
  }
  if (normalized === 'waiting') {
    return options.waitingAsRunning ? 'running' : fallbackStatus;
  }
  if (normalized === 'reviewing') {
    return 'awaiting_review';
  }
  if (normalized === 'blocked' || normalized === 'failed' || normalized === 'error') {
    return 'blocked';
  }
  if (normalized === 'queued') {
    return 'queued';
  }
  if (normalized === 'launching') {
    return 'launching';
  }
  if (normalized === 'recovering') {
    return 'recovering';
  }
  if (normalized === 'released') {
    return 'released';
  }
  if (normalized === 'archived') {
    return 'archived';
  }
  if (normalized === 'idle') {
    return 'idle';
  }

  return fallbackStatus;
}
