import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import { isClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { WorkerProvider } from '@/lib/orchestrator/types';
import { isRuntimeWorkerProvider, listDispatchableWorkerProviders } from '@/lib/orchestrator/runtime-capabilities';
import { optionalString } from './shared';

export const WORKER_PROVIDER_OPTIONS: WorkerProvider[] = [...listDispatchableWorkerProviders(), 'minimax'];

export const MISSION_WORKER_PIN_PROPERTIES = {
  model: {
    type: 'string',
    description: 'Optional per-packet model pin. For claude-code packets, this wins over the global worker profile.',
  },
  carrier: {
    type: 'string',
    enum: ['native', 'openrouter', 'codex-subscription'],
    description: 'Optional claude-code packet carrier pin. It affects worker packets only and never changes the orchestrator carrier.',
  },
} as const;

export function parseWorkerProvider(value: unknown): WorkerProvider | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'minimax' || isRuntimeWorkerProvider(value)) return value;
  throw new Error(`requestedProvider must be one of: ${WORKER_PROVIDER_OPTIONS.join(', ')}.`);
}

export function parseMissionWorkerPinInput(args: Record<string, unknown>): {
  requestedModel?: string;
  claudeCodeCarrier?: ClaudeCodeModelSource;
} {
  const requestedModel = optionalString(args, 'model') || undefined;
  const carrier = optionalString(args, 'carrier') || undefined;
  if (carrier && !isClaudeCodeModelSource(carrier)) {
    throw new Error('carrier must be one of: native, openrouter, codex-subscription.');
  }
  return {
    requestedModel,
    claudeCodeCarrier: isClaudeCodeModelSource(carrier) ? carrier : undefined,
  };
}
