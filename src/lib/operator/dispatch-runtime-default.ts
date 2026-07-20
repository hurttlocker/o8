import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

export type DispatchDefaultOrchestratorBackend =
  | 'auto'
  | 'codex'
  | 'claude'
  | 'openclaw'
  | 'hermes'
  | 'collide'
  | 'fable'
  | 'acp'
  // The free conversational backend never dispatches, but it remains a valid
  // orchestratorBackend setting while the worker default independently falls
  // through to Codex.
  | 'o8';

export interface ResolveDefaultDispatchRuntimeInput {
  explicitRuntime?: OrchestratorRuntime | null;
  orchestratorBackend: DispatchDefaultOrchestratorBackend;
  inAppOrchestratorEnabled?: boolean;
}

export function resolveDefaultDispatchRuntime(
  input: ResolveDefaultDispatchRuntimeInput,
): OrchestratorRuntime {
  if (input.explicitRuntime) return input.explicitRuntime;
  return 'codex';
}
