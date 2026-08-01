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

const EXHAUSTION_CODES = new Set([
  'usage_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

const EXHAUSTION_MESSAGES = [
  /^\s*you(?:'ve| have) hit your (?:(?:weekly|daily|monthly|\d+[ -]hour) )?(?:usage )?limit\b/i,
  /^\s*you(?:'ve| have) reached your (?:(?:weekly|daily|monthly|\d+[ -]hour) )?(?:usage )?limit\b/i,
  /^\s*you(?:'re| are) out of usage credits\b/i,
  /^\s*your org is out of usage\b/i,
  /^\s*your seat type doesn't include (?:extra )?usage credits\b/i,
  /^\s*your usage allocation has been disabled by your admin\b/i,
  /^\s*your group's usage limit is set to \$0\b/i,
];

const TRANSIENT_PATTERNS = [
  /\bHTTP\/?\s*5\d\d\b/i,
  /\b(?:status(?: code)?[:= ]+)?5\d\d\b.*\b(?:server|upstream|gateway|service)\b/i,
  /\b(?:ECONN[A-Z]+|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|network (?:error|unreachable)|connection (?:reset|refused|timed out))\b/i,
  /\b(?:401|403)\b|\b(?:unauthori[sz]ed|forbidden|authentication failed|invalid api key|token (?:expired|revoked))\b/i,
  /\bserver is temporarily limiting requests\b/i,
  /\bretry-after\b/i,
];

interface QuotaErrorFacts {
  codes: Set<string>;
  messages: string[];
  statuses: Set<number>;
  retryAfter: boolean;
}

function collectQuotaFacts(error: unknown): QuotaErrorFacts {
  const facts: QuotaErrorFacts = { codes: new Set(), messages: [], statuses: new Set(), retryAfter: false };
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 4 || value === null || value === undefined || seen.has(value)) return;
    if (typeof value === 'string') {
      facts.messages.push(value);
      const trimmed = value.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { visit(JSON.parse(trimmed), depth + 1); } catch { /* plain CLI output */ }
      } else if (trimmed.includes('\n')) {
        for (const line of trimmed.split(/\r?\n/)) {
          const candidate = line.trim();
          if (!candidate.startsWith('{')) continue;
          try { visit(JSON.parse(candidate), depth + 1); } catch { /* non-JSON log line */ }
        }
      }
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ['code', 'error_code', 'rate_limit_reached_type']) {
      if (typeof record[key] === 'string') facts.codes.add(record[key].toLowerCase());
    }
    for (const key of ['status', 'statusCode', 'status_code']) {
      if (typeof record[key] === 'number') facts.statuses.add(record[key]);
    }
    const headers = record.headers && typeof record.headers === 'object'
      ? record.headers as Record<string, unknown>
      : null;
    if (headers && Object.keys(headers).some((key) => key.toLowerCase() === 'retry-after')) {
      facts.retryAfter = true;
    }
    for (const key of ['message', 'result', 'detail', 'error']) {
      visit(record[key], depth + 1);
    }
    if (value instanceof Error) {
      visit(value.message, depth + 1);
      visit((value as Error & { cause?: unknown }).cause, depth + 1);
    }
  };
  visit(error);
  return facts;
}

export function isRuntimeQuotaLimitError(error: unknown): boolean {
  const facts = collectQuotaFacts(error);
  const message = facts.messages.join('\n');
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return false;
  if (facts.retryAfter) return false;
  if ([...facts.statuses].some((status) => status >= 500 || status === 401 || status === 403)) return false;
  if ([...facts.codes].some((code) => EXHAUSTION_CODES.has(code))) return true;
  const hasExhaustionMessage = EXHAUSTION_MESSAGES.some((pattern) => (
    facts.messages.some((candidate) => pattern.test(candidate))
  ));
  if (hasExhaustionMessage) return true;
  // A bare 429 is ordinary throttling. Only a structured exhaustion code or
  // an observed subscription-cap message above may cross houses.
  return false;
}

export function buildCrossHouseFallbackMessage(decision: CrossHouseFallbackDecision): string {
  const source = decision.fromHouse === 'anthropic' ? 'Anthropic' : 'OpenAI';
  if (decision.action === 'hold') {
    return `${source} subscription exhausted. No comparable ${decision.toHouse} subscription is configured, so ${decision.role} work is paused without metered fallback.`;
  }
  const target = decision.toHouse === 'anthropic' ? 'Anthropic' : 'OpenAI';
  return `${source} subscription exhausted. ${decision.role} work moved sideways to ${target} ${decision.toModel} (${decision.runtimeTier} runtime tier).`;
}
