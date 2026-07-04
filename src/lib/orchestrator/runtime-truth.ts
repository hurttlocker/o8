import { normalizeRuntimeStatusToOrchestratorStatus } from '@/lib/orchestrator/runtime-status';
import type { OrchestratorRuntimeTruth } from '@/lib/orchestrator/types';

export function runtimeTruthHasActiveWriter(runtime: OrchestratorRuntimeTruth | undefined): boolean {
  if (!runtime) return false;
  if (runtime.runtime !== 'codex' || runtime.ownership === 'discovered') return false;
  if (runtime.runtimeAvailability === 'running' || runtime.canInterrupt === true) return true;
  return normalizeRuntimeStatusToOrchestratorStatus(runtime.status, {
    waitingAsRunning: true,
    fallbackStatus: null,
  }) === 'running';
}
