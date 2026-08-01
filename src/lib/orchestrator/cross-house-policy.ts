import { CROSS_HOUSE_MODEL_TIERS } from '@/lib/models';
import type { SubscriptionProfile } from '@/lib/operator/subscription-profile';
import {
  ORCHESTRATOR_RUNTIMES,
  type OrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';

export type CrossHouse = 'anthropic' | 'openai';
export type CrossHouseRole = 'orchestrator' | 'review' | 'worker' | 'brain' | 'canvas-agent';
export type CrossHouseModelTier = keyof typeof CROSS_HOUSE_MODEL_TIERS;

const HOUSE_RUNTIME = {
  anthropic: 'claude-code',
  openai: 'codex',
} as const satisfies Record<CrossHouse, OrchestratorRuntime>;

const HOUSE_BACKEND = {
  anthropic: 'claude',
  openai: 'codex',
} as const satisfies Record<CrossHouse, OrchestratorBackendId>;

const ROLE_MODEL_TIER = {
  orchestrator: 'frontierOrchestrator',
  review: 'reviewMechanical',
  worker: 'reviewMechanical',
  brain: 'scout',
  'canvas-agent': 'reviewMechanical',
} as const satisfies Record<CrossHouseRole, CrossHouseModelTier>;

export interface CrossHouseCandidate {
  house: CrossHouse;
  runtime: typeof HOUSE_RUNTIME[CrossHouse];
  backend: typeof HOUSE_BACKEND[CrossHouse];
  runtimeTier: (typeof ORCHESTRATOR_RUNTIMES)[OrchestratorRuntime]['tier'];
  model: string;
}

function candidatesForTier(modelTier: CrossHouseModelTier): Record<CrossHouse, readonly CrossHouseCandidate[]> {
  return Object.freeze({
    anthropic: Object.freeze([{
      house: 'anthropic' as const,
      runtime: HOUSE_RUNTIME.anthropic,
      backend: HOUSE_BACKEND.anthropic,
      runtimeTier: ORCHESTRATOR_RUNTIMES[HOUSE_RUNTIME.anthropic].tier,
      model: CROSS_HOUSE_MODEL_TIERS[modelTier].anthropic,
    }]),
    openai: Object.freeze([{
      house: 'openai' as const,
      runtime: HOUSE_RUNTIME.openai,
      backend: HOUSE_BACKEND.openai,
      runtimeTier: ORCHESTRATOR_RUNTIMES[HOUSE_RUNTIME.openai].tier,
      model: CROSS_HOUSE_MODEL_TIERS[modelTier].openai,
    }]),
  });
}

const MODEL_TIERS = Object.keys(CROSS_HOUSE_MODEL_TIERS) as CrossHouseModelTier[];

export const CROSS_HOUSE_EQUIVALENCE_POLICY = Object.freeze(
  Object.fromEntries(
    (Object.keys(ROLE_MODEL_TIER) as CrossHouseRole[]).map((role) => {
      return [role, Object.freeze({
        defaultModelTier: ROLE_MODEL_TIER[role],
        tiers: Object.freeze(Object.fromEntries(
          MODEL_TIERS.map((modelTier) => [modelTier, candidatesForTier(modelTier)]),
        )) as Record<CrossHouseModelTier, Record<CrossHouse, readonly CrossHouseCandidate[]>>,
      })];
    }),
  ) as Record<CrossHouseRole, {
    defaultModelTier: CrossHouseModelTier;
    tiers: Record<CrossHouseModelTier, Record<CrossHouse, readonly CrossHouseCandidate[]>>;
  }>,
);

export interface CrossHouseFallbackDecision {
  role: CrossHouseRole;
  modelTier: CrossHouseModelTier;
  fromHouse: CrossHouse;
  toHouse: CrossHouse;
  fromRuntime: CrossHouseCandidate['runtime'];
  toRuntime: CrossHouseCandidate['runtime'];
  fromBackend: OrchestratorBackendId;
  toBackend: OrchestratorBackendId;
  fromModel: string;
  toModel: string;
  runtimeTier: CrossHouseCandidate['runtimeTier'];
  action: 'handoff' | 'hold';
  noticeKind: 'cross-house-quota-fallback';
}

function otherHouse(house: CrossHouse): CrossHouse {
  return house === 'anthropic' ? 'openai' : 'anthropic';
}

function profileHasHouse(profile: SubscriptionProfile, house: CrossHouse): boolean {
  return profile === 'both'
    || (profile === 'claude-only' && house === 'anthropic')
    || (profile === 'codex-only' && house === 'openai');
}

function houseForBackend(backend: OrchestratorBackendId): CrossHouse | null {
  // Fable is BYO metered Anthropic traffic, so it is deliberately outside
  // this subscription-only policy even though its models share a house.
  if (backend === 'claude') return 'anthropic';
  if (backend === 'codex') return 'openai';
  return null;
}

function modelTierFor(role: CrossHouseRole, model?: string | null): CrossHouseModelTier {
  const normalized = model?.trim();
  if (normalized) {
    for (const tier of Object.keys(CROSS_HOUSE_MODEL_TIERS) as CrossHouseModelTier[]) {
      const pair = CROSS_HOUSE_MODEL_TIERS[tier];
      if (pair.anthropic === normalized || pair.openai === normalized) return tier;
    }
  }
  return CROSS_HOUSE_EQUIVALENCE_POLICY[role].defaultModelTier;
}

export function resolveCrossHouseFallback(input: {
  role: CrossHouseRole;
  backend: OrchestratorBackendId;
  model?: string | null;
  subscriptionProfile?: SubscriptionProfile;
}): CrossHouseFallbackDecision | null {
  const fromHouse = houseForBackend(input.backend);
  if (!fromHouse) return null;

  const modelTier = modelTierFor(input.role, input.model);
  const policy = CROSS_HOUSE_EQUIVALENCE_POLICY[input.role];
  const candidates = policy.tiers[modelTier];
  const source = candidates[fromHouse][0];
  const toHouse = otherHouse(fromHouse);
  const candidate = candidates[toHouse]
    .find((entry) => entry.runtimeTier === source.runtimeTier);
  if (!candidate) return null;

  const profile = input.subscriptionProfile ?? 'both';
  const action = profileHasHouse(profile, toHouse) ? 'handoff' : 'hold';
  return {
    role: input.role,
    modelTier,
    fromHouse,
    toHouse,
    fromRuntime: source.runtime,
    toRuntime: candidate.runtime,
    fromBackend: input.backend,
    toBackend: candidate.backend,
    fromModel: input.model?.trim() || CROSS_HOUSE_MODEL_TIERS[modelTier][fromHouse],
    toModel: CROSS_HOUSE_MODEL_TIERS[modelTier][toHouse],
    runtimeTier: source.runtimeTier,
    action,
    noticeKind: 'cross-house-quota-fallback',
  };
}

export function resolveCrossHouseFallbackForQuota(
  error: unknown,
  input: Parameters<typeof resolveCrossHouseFallback>[0],
): CrossHouseFallbackDecision | null {
  return isRuntimeQuotaLimitError(error) ? resolveCrossHouseFallback(input) : null;
}

const QUOTA_LIMIT_PATTERNS = [
  /\busage[ _-]?limit(?:[ _-]?reached)?\b/i,
  /\b(?:weekly|daily|monthly)[ _-]?limit\b/i,
  /\bquota\b/i,
  /\brate[ _-]?limit(?:ed|[ _-]?reached)?\b/i,
  /\bexceeded your current quota\b/i,
  /\btoo many requests\b/i,
  /\b429\b/,
  /\blimit resets?\b/i,
  /\bcredits? exhausted\b/i,
];

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error ?? '');
}

export function isRuntimeQuotaLimitError(error: unknown): boolean {
  const message = errorText(error);
  return QUOTA_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

export function buildCrossHouseFallbackMessage(decision: CrossHouseFallbackDecision): string {
  const source = decision.fromHouse === 'anthropic' ? 'Anthropic' : 'OpenAI';
  if (decision.action === 'hold') {
    return `${source} subscription exhausted. No comparable ${decision.toHouse} subscription is configured, so ${decision.role} work is paused without metered fallback.`;
  }
  const target = decision.toHouse === 'anthropic' ? 'Anthropic' : 'OpenAI';
  return `${source} subscription exhausted. ${decision.role} work moved sideways to ${target} ${decision.toModel} (${decision.runtimeTier} runtime tier).`;
}
