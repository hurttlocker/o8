import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { createBackendRoleRouteChoice } from '@/lib/operator/role-routing';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';
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
  const requested = createBackendRoleRouteChoice(
    backend.id,
    options.model ?? null,
    options.thinkingEffort ?? null,
  );
  const routedOptions = {
    ...options,
    orchestrationMode: resolveOrchestratorExecutionMode(rawOrchestrationMode),
  };
  const record = (status: 'selected' | 'failed', reason: string) => {
    recordRoleRoutingReceiptSafely({
      role: 'orchestrate',
      repoPath,
      contextType: 'orchestrator-thread',
      contextId: options.threadId ?? null,
      requested,
      effective: requested,
      sources: {
        backend: 'request-time',
        runtime: 'derived',
        model: options.model ? 'request-time' : 'runtime-default',
        effort: options.thinkingEffort ? 'request-time' : 'runtime-default',
      },
      reason,
      status,
    });
  };
  return backend.sendTurn(repoPath, message, onEvent, routedOptions)
    .then(() => {
      record('selected', `${backend.label} completed the orchestrator turn.`);
    })
    .catch((error) => {
      record('failed', `${backend.label} failed the orchestrator turn: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
}
