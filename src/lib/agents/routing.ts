import type {
  OrchestratorRuntime,
  WorkerIntent,
  WorkerProvider,
  WorkerRouting,
  WorkerRoutingConfidence,
} from '@/lib/orchestrator/types';

export const PRODUCTION_AGENT_RUNTIME: OrchestratorRuntime = 'codex';
export const PRODUCTION_AGENT_PROVIDER: WorkerProvider = 'codex';
export const PRODUCTION_AGENT_ENFORCEMENT = 'codex_only_production';

const WORKER_INTENTS: readonly WorkerIntent[] = [
  'light_worker',
  'heavy_worker',
  'reviewer',
  'diagnostic',
  'orchestrator',
];

const WORKER_PROVIDERS: readonly WorkerProvider[] = [
  'codex',
  'kimi',
  'minimax',
  'claude',
  'gemini',
  'opencode',
];

const ORCHESTRATOR_RUNTIMES: readonly OrchestratorRuntime[] = [
  'codex',
  'claude-code',
  'gemini',
  'opencode',
];

export interface ResolveWorkerRoutingInput {
  workerIntent?: unknown;
  requestedProvider?: unknown;
  requestedRuntime?: unknown;
  requestedModel?: unknown;
  source?: string;
  confidence?: WorkerRoutingConfidence;
  reason?: string;
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
  return ORCHESTRATOR_RUNTIMES.includes(value as OrchestratorRuntime)
    ? value as OrchestratorRuntime
    : null;
}

function normalizeModel(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function routingConfidence(intent: WorkerIntent): WorkerRoutingConfidence {
  if (intent === 'light_worker' || intent === 'diagnostic') return 'high';
  if (intent === 'reviewer' || intent === 'orchestrator') return 'medium';
  return 'medium';
}

function routingReason(input: {
  requestedProvider: WorkerProvider | null;
  requestedRuntime: OrchestratorRuntime | null;
  workerIntent: WorkerIntent;
  source?: string;
}) {
  const requested = input.requestedProvider ?? input.requestedRuntime;
  const source = input.source ? ` from ${input.source}` : '';
  if (requested && requested !== PRODUCTION_AGENT_PROVIDER && requested !== PRODUCTION_AGENT_RUNTIME) {
    return `Requested ${requested}${source}, but production agent spawning is currently restricted to Codex. Intent scaffold preserved for later provider routing.`;
  }
  return `Production routing selected Codex for ${input.workerIntent}${source}.`;
}

export function resolveWorkerRouting(input: ResolveWorkerRoutingInput = {}): WorkerRouting {
  const workerIntent = normalizeWorkerIntent(input.workerIntent);
  const requestedProvider = normalizeWorkerProvider(input.requestedProvider);
  const requestedRuntime = normalizeRequestedRuntime(input.requestedRuntime);
  const requestedModel = normalizeModel(input.requestedModel);
  const requestedCodexModel = requestedModel
    && (requestedProvider === null || requestedProvider === PRODUCTION_AGENT_PROVIDER)
    && (requestedRuntime === null || requestedRuntime === PRODUCTION_AGENT_RUNTIME);

  return {
    workerIntent,
    requestedProvider,
    requestedRuntime,
    requestedModel,
    selectedProvider: PRODUCTION_AGENT_PROVIDER,
    selectedRuntime: PRODUCTION_AGENT_RUNTIME,
    selectedModel: requestedCodexModel ? requestedModel : null,
    enforcement: PRODUCTION_AGENT_ENFORCEMENT,
    confidence: input.confidence ?? routingConfidence(workerIntent),
    reason: input.reason ?? routingReason({
      requestedProvider,
      requestedRuntime,
      workerIntent,
      source: input.source,
    }),
    decidedAt: new Date().toISOString(),
  };
}

export function assertProductionAgentRuntime(runtime: OrchestratorRuntime | string): asserts runtime is 'codex' {
  if (runtime !== PRODUCTION_AGENT_RUNTIME) {
    throw new Error(
      `Production agent spawning is restricted to Codex. Requested runtime "${runtime}" is scaffolded for later but cannot launch yet.`,
    );
  }
}
