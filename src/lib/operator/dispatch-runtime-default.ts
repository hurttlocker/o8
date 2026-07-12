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
  // The free conversational backend never dispatches, but it's a valid
  // orchestratorBackend setting, so the pairing fn must accept it (falls through
  // to the codex default like any non-claude backend).
  | 'o8';

export interface ResolveDefaultDispatchRuntimeInput {
  explicitRuntime?: OrchestratorRuntime | null;
  orchestratorBackend: DispatchDefaultOrchestratorBackend;
  inAppOrchestratorEnabled?: boolean;
}

export function resolveEffectiveDefaultOrchestratorBackend(input: {
  orchestratorBackend: DispatchDefaultOrchestratorBackend;
  inAppOrchestratorEnabled?: boolean;
}): DispatchDefaultOrchestratorBackend {
  if (input.orchestratorBackend !== 'auto') return input.orchestratorBackend;
  return input.inAppOrchestratorEnabled ? 'claude' : 'codex';
}

export function oppositeFrontierDispatchRuntime(
  orchestratorBackend: DispatchDefaultOrchestratorBackend,
): OrchestratorRuntime {
  if (orchestratorBackend === 'codex') return 'claude-code';
  if (orchestratorBackend === 'claude') return 'codex';
  return 'codex';
}

export function resolveDefaultDispatchRuntime(
  input: ResolveDefaultDispatchRuntimeInput,
): OrchestratorRuntime {
  if (input.explicitRuntime) return input.explicitRuntime;
  return oppositeFrontierDispatchRuntime(resolveEffectiveDefaultOrchestratorBackend(input));
}
