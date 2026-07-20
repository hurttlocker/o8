import type {
  OrchestratorRuntime,
  WorkerIntent,
  WorkerProvider,
  WorkerRouting,
  WorkerRoutingConfidence,
} from '@/lib/orchestrator/types';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

// Runtimes with a reasoning-effort surface. codex → `-c model_reasoning_effort`,
// claude-code → `--effort`. opencode has none, so a requested effort is a
// clean no-op there (selectedEffort stays null and no launch flag is emitted).
const EFFORT_CAPABLE_RUNTIMES: readonly OrchestratorRuntime[] = ['codex', 'claude-code'];

// Codex stays the always-on fallback workhorse when no dispatchable runtime is
// requested. Other runtimes are honored when the capability map marks them
// dispatchable — that's what makes mixed-runtime swarms work.
export const PRODUCTION_AGENT_RUNTIME: OrchestratorRuntime = 'codex';
export const PRODUCTION_AGENT_PROVIDER: WorkerProvider = 'codex';
export const PRODUCTION_AGENT_ENFORCEMENT = 'dispatchable_runtimes' as const;

/** Map a dispatchable runtime to its worker provider for routing metadata. */
function providerForRuntime(runtime: OrchestratorRuntime): WorkerProvider {
  switch (runtime) {
    case 'gemini': return 'gemini';
    case 'antigravity': return 'antigravity';
    case 'claude-code': return 'claude';
    case 'opencode': return 'opencode';
    case 'openhands': return 'openhands';
    case 'goose': return 'goose';
    case 'qwen': return 'qwen';
    case 'kimi': return 'kimi';
    case 'aider': return 'aider';
    case 'cursor': return 'cursor';
    case 'grok': return 'grok';
    case 'pi': return 'pi';
    case 'codex':
    default: return 'codex';
  }
}

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
  'antigravity',
  'opencode',
  'openhands',
  'goose',
  'qwen',
  'aider',
  'cursor',
  'grok',
  'pi',
];

const ORCHESTRATOR_RUNTIMES: readonly OrchestratorRuntime[] = [
  'codex',
  'claude-code',
  'gemini',
  'antigravity',
  'opencode',
  'openhands',
  'goose',
  'qwen',
  'kimi',
  'aider',
  'cursor',
  'grok',
  'pi',
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
  requestedRuntime: OrchestratorRuntime | null;
  selectedRuntime: OrchestratorRuntime;
  workerIntent: WorkerIntent;
  source?: string;
}) {
  const source = input.source ? ` from ${input.source}` : '';
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

  // A requested model is honored only when it targets the runtime we actually
  // selected — so a Codex model hint can't leak onto a Gemini packet.
  const modelTargetsSelected = requestedModel
    && (requestedRuntime === null || requestedRuntime === selectedRuntime)
    && (requestedProvider === null || requestedProvider === selectedProvider);

  // Effort applies only when the selected runtime has a reasoning-effort surface;
  // on opencode it's a clean no-op (null → no launch flag).
  const selectedEffort = requestedEffort && EFFORT_CAPABLE_RUNTIMES.includes(selectedRuntime)
    ? requestedEffort
    : null;

  return {
    workerIntent,
    requestedProvider,
    requestedRuntime,
    requestedModel,
    requestedEffort,
    selectedProvider,
    selectedRuntime,
    selectedModel: modelTargetsSelected ? requestedModel : null,
    selectedEffort,
    enforcement: PRODUCTION_AGENT_ENFORCEMENT,
    confidence: input.confidence ?? routingConfidence(workerIntent),
    reason: input.reason ?? routingReason({
      requestedRuntime,
      selectedRuntime,
      workerIntent,
      source: input.source,
    }),
    decidedAt: new Date().toISOString(),
  };
}
