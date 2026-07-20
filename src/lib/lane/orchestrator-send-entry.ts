import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { resolveOrchestratorExecutionMode } from './orchestrator-backends/orchestration-mode';
import type { OrchestratorBackend, OrchestratorBackendId, OrchestratorTurnOptions } from './orchestrator-backends/types';

/**
 * Resolve the backend identity before ws-server creates subscriptions, abort
 * keys, or persisted session metadata. Single's Codex fallback must be visible
 * to those callers; hiding it inside a backend wrapper would mislabel a Codex
 * session as OpenClaw/Claude and poison the next resume.
 */
export function resolveOrchestratorExecutionBackendId(
  requestedBackendId: OrchestratorBackendId,
  rawOrchestrationMode: unknown,
): OrchestratorBackendId {
  return resolveOrchestratorExecutionMode(rawOrchestrationMode) === 'single'
    ? 'codex'
    : requestedBackendId;
}

/** Single must fail on its hardened Codex turn, never hand off unsandboxed. */
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
): Promise<void> {
  return backend.sendTurn(repoPath, message, onEvent, {
    ...options,
    orchestrationMode: resolveOrchestratorExecutionMode(rawOrchestrationMode),
  });
}
