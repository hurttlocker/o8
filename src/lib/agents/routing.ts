import type {
  OrchestratorRuntime,
  WorkerIntent,
  WorkerProvider,
  WorkerRouting,
  WorkerRoutingConfidence,
} from '@/lib/orchestrator/types';
import {
  getRuntimeCapability,
  isOrchestratorRuntime,
  listDispatchableWorkerProviders,
  listDispatchableRuntimes,
} from '@/lib/orchestrator/runtime-capabilities';
import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

// Codex stays the always-on fallback workhorse when no dispatchable runtime is
// requested. Other runtimes are honored when the capability map marks them
// dispatchable — that's what makes mixed-runtime swarms work.
export const PRODUCTION_AGENT_RUNTIME: OrchestratorRuntime = 'codex';
export const PRODUCTION_AGENT_PROVIDER: WorkerProvider = 'codex';
export const PRODUCTION_AGENT_ENFORCEMENT = 'dispatchable_runtimes' as const;

/** Map a dispatchable runtime to its worker provider for routing metadata. */
function providerForRuntime(runtime: OrchestratorRuntime): WorkerProvider {
  return getRuntimeCapability(runtime).workerProvider;
}

const WORKER_INTENTS: readonly WorkerIntent[] = [
  'light_worker',
  'heavy_worker',
  'reviewer',
  'diagnostic',
  'orchestrator',
];

const WORKER_PROVIDERS: readonly WorkerProvider[] = [
  ...listDispatchableWorkerProviders(),
  'minimax',
];

export interface ResolveWorkerRoutingInput {
  workerIntent?: unknown;
  requestedProvider?: unknown;
  requestedRuntime?: unknown;
  requestedModel?: unknown;
  requestedEffort?: unknown;
  source?: string;
  confidence?: WorkerRoutingConfidence;
  reason?: string;
}

function normalizeEffort(value: unknown): ThinkingEffort | null {
  // 'adaptive' means "let the runtime decide" — treat as no explicit effort so
  // the launch stays at the runtime default (parity). Only a concrete tier is
  // carried.
  return isThinkingEffort(value) && value !== 'adaptive' ? value : null;
}

export function normalizeWorkerIntent(value: unknown): WorkerIntent {
  return WORKER_INTENTS.includes(value as WorkerIntent)
    ? value as WorkerIntent
    : 'heavy_worker';
}

export function normalizeWorkerProvider(value: unknown): WorkerProvider | null {
  return WORKER_PROVIDERS.includes(value as WorkerProvider)
    ? value as WorkerProvider
    : null;
}

export function normalizeRequestedRuntime(value: unknown): OrchestratorRuntime | null {
  return isOrchestratorRuntime(value) ? value : null;
}

function normalizeModel(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

type RuntimeBoundModelHouse = 'codex' | 'claude' | 'gemini' | 'cursor' | 'grok';

function modelHouse(model: string): RuntimeBoundModelHouse | null {
  const normalized = model.trim().toLowerCase();
  if (
    normalized.startsWith('claude-')
    || normalized.startsWith('anthropic/')
    || normalized.includes('/claude-')
  ) {
    return 'claude';
  }
  if (
    normalized.startsWith('gpt-')
    || normalized.startsWith('openai-')
    || normalized.startsWith('openai/')
    || normalized.includes('/gpt-')
  ) {
    return 'codex';
  }
  if (
    normalized.startsWith('gemini-')
    || normalized.startsWith('google/')
    || normalized.includes('/gemini-')
  ) {
    return 'gemini';
  }
  if (normalized.startsWith('cursor-') || normalized.startsWith('cursor/')) {
    return 'cursor';
  }
  if (
    normalized.startsWith('grok-')
    || normalized.startsWith('xai/')
    || normalized.includes('/grok-')
  ) {
    return 'grok';
  }
  return null;
}

/**
 * Single-house CLIs must never receive another provider's model identifier.
 * Model-agnostic adapters such as opencode/OpenHands intentionally accept
 * provider-qualified cross-house ids, so they remain unrestricted here.
 */
function modelMatchesRuntime(model: string, runtime: OrchestratorRuntime): boolean {
  const house = modelHouse(model);
  if (!house) return true;
  const runtimeHouse = getRuntimeCapability(runtime).authHouse;
  return runtimeHouse !== 'codex'
    && runtimeHouse !== 'claude'
    && runtimeHouse !== 'gemini'
    && runtimeHouse !== 'cursor'
    && runtimeHouse !== 'grok'
    ? true
    : house === runtimeHouse;
}

function routingConfidence(intent: WorkerIntent): WorkerRoutingConfidence {
  if (intent === 'light_worker' || intent === 'diagnostic') return 'high';
  if (intent === 'reviewer' || intent === 'orchestrator') return 'medium';
  return 'medium';
}

function routingReason(input: {
  requestedModel: string | null;
  modelTargetsSelected: boolean;
  requestedRuntime: OrchestratorRuntime | null;
  selectedRuntime: OrchestratorRuntime;
  workerIntent: WorkerIntent;
  source?: string;
}) {
  const source = input.source ? ` from ${input.source}` : '';
  if (input.requestedModel && !input.modelTargetsSelected) {
    return `Requested model ${input.requestedModel}${source} is incompatible with selected runtime ${input.selectedRuntime}; the runtime default will be used.`;
  }
  if (input.requestedRuntime && input.requestedRuntime !== input.selectedRuntime) {
    return `Requested ${input.requestedRuntime}${source} is not currently dispatchable; routed ${input.workerIntent} to ${input.selectedRuntime}.`;
  }
  return `Routed ${input.workerIntent}${source} to ${input.selectedRuntime}.`;
}

export function resolveWorkerRouting(input: ResolveWorkerRoutingInput = {}): WorkerRouting {
  const workerIntent = normalizeWorkerIntent(input.workerIntent);
  const requestedProvider = normalizeWorkerProvider(input.requestedProvider);
  const requestedRuntime = normalizeRequestedRuntime(input.requestedRuntime);
  const requestedModel = normalizeModel(input.requestedModel);
  const requestedEffort = normalizeEffort(input.requestedEffort);

  // Honor a requested runtime when the capability map marks it dispatchable.
  // Anything else falls back to Codex. An explicit operator default is resolved
  // by the SERVER entry points (create-mission / spawn-prompt routes,
  // parseMissionRuntime) and arrives here as requestedRuntime — this module is
  // client-bundled via the dashboard, so it must never require the server-only
  // operator defaults itself (broke the 0.1.553 next build).
  const dispatchable = listDispatchableRuntimes({ includeExperimental: true });
  const selectedRuntime = requestedRuntime && dispatchable.includes(requestedRuntime)
    ? requestedRuntime
    : PRODUCTION_AGENT_RUNTIME;
  const selectedProvider = providerForRuntime(selectedRuntime);

  // Every upstream model source (explicit hint, stored dispatch default,
  // persisted packet value) arrives here as requestedModel. Honor it only when
  // both its routing metadata and its model house target the selected runtime.
  // A mismatch yields selectedModel=null, so launch resolves through that
  // runtime adapter's own defaultModel instead of spawning a foreign model.
  const modelTargetsSelected = requestedModel
    && (requestedRuntime === null || requestedRuntime === selectedRuntime)
    && (requestedProvider === null || requestedProvider === selectedProvider)
    && modelMatchesRuntime(requestedModel, selectedRuntime);

  // Effort applies only when the selected runtime has a reasoning-effort surface;
  // on opencode it's a clean no-op (null → no launch flag).
  const selectedEffort = requestedEffort && getRuntimeCapability(selectedRuntime).reasoningEffort
    ? requestedEffort
    : null;
  const modelDisposition = requestedModel
    ? modelTargetsSelected ? 'requested' : 'rejected-incompatible'
    : 'runtime-default';
  const resolvedReason = routingReason({
    requestedModel,
    modelTargetsSelected: Boolean(modelTargetsSelected),
    requestedRuntime,
    selectedRuntime,
    workerIntent,
    source: input.source,
  });

  return {
    workerIntent,
    requestedProvider,
    requestedRuntime,
    requestedModel,
    requestedEffort,
    selectedProvider,
    selectedRuntime,
    selectedModel: modelTargetsSelected ? requestedModel : null,
    modelDisposition,
    selectedEffort,
    enforcement: PRODUCTION_AGENT_ENFORCEMENT,
    confidence: input.confidence ?? routingConfidence(workerIntent),
    reason: modelDisposition === 'rejected-incompatible' ? resolvedReason : input.reason ?? resolvedReason,
    decidedAt: new Date().toISOString(),
  };
}
