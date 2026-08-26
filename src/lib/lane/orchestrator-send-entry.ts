import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { resolveOrchestratorExecutionMode } from './orchestrator-backends/orchestration-mode';
import type { OrchestratorBackend, OrchestratorBackendId, OrchestratorTurnOptions } from './orchestrator-backends/types';

/** Resolve the selected backend before subscriptions and persistence are built. */
export function resolveOrchestratorExecutionBackendId(
  requestedBackendId: OrchestratorBackendId,
  rawOrchestrationMode: unknown,
): OrchestratorBackendId {
  void rawOrchestrationMode;
  return requestedBackendId;
}

/** Solo must stay on the selected runtime rather than silently changing houses. */
export function orchestratorModeAllowsBackendFallback(rawOrchestrationMode: unknown): boolean {
  return resolveOrchestratorExecutionMode(rawOrchestrationMode) !== 'single';
}

/** Backend invocation seam used by ws-server's orchestrator-send handler. */
export function sendOrchestratorBackendTurn(
  backend: OrchestratorBackend,
  repoPath: string,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: OrchestratorTurnOptions,
  rawOrchestrationMode: unknown,
  leadingEvents: readonly OrchestratorEvent[] = [],
): Promise<void> {
  for (const event of leadingEvents) onEvent(event);
  return backend.sendTurn(repoPath, message, onEvent, {
    ...options,
    orchestrationMode: resolveOrchestratorExecutionMode(rawOrchestrationMode),
  });
}
