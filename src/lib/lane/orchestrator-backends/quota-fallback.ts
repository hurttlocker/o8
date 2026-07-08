import { CROSS_HOUSE_MODEL_TIERS } from '@/lib/models';
import { resolveSingleSubscriptionOrchestratorFallback, type SingleSubscriptionQuotaFallbackOptions } from './quota-fallback-single-sub';
import type { OrchestratorBackendId } from './types';

export type RuntimeHouse = 'anthropic' | 'openai';

export interface CrossHouseFallback {
  fromBackend: OrchestratorBackendId;
  toBackend: OrchestratorBackendId;
  fromHouse: RuntimeHouse;
  toHouse: RuntimeHouse;
  fromModel: string;
  toModel: string;
  tier: keyof typeof CROSS_HOUSE_MODEL_TIERS;
  action?: 'handoff' | 'downgrade' | 'hold';
  noticeKind: 'cross-house-orchestrator-handoff';
}

const QUOTA_LIMIT_PATTERNS = [
  /\busage limit\b/i,
  /\bweekly limit\b/i,
  /\bdaily limit\b/i,
  /\bmonthly limit\b/i,
  /\bquota\b/i,
  /\brate limit(?:ed)?\b/i,
  /\bexceeded your current quota\b/i,
  /\btoo many requests\b/i,
  /\b429\b/,
  /\blimit resets?\b/i,
];

export function isRuntimeQuotaLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return QUOTA_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

export function resolveCrossHouseOrchestratorFallback(
  backend: OrchestratorBackendId,
  options: SingleSubscriptionQuotaFallbackOptions = {},
): CrossHouseFallback | null {
  const singleSubFallback = resolveSingleSubscriptionOrchestratorFallback(backend, options);
  if (singleSubFallback) return singleSubFallback;
  if (backend !== 'claude' && backend !== 'fable') return null;
  return {
    fromBackend: backend,
    toBackend: 'codex',
    fromHouse: 'anthropic',
    toHouse: 'openai',
    fromModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.anthropic,
    toModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.openai,
    tier: 'frontierOrchestrator',
    noticeKind: 'cross-house-orchestrator-handoff',
  };
}

export function buildCrossHouseHandoffMessage(fallback: CrossHouseFallback): string {
  if (fallback.action === 'hold') return 'quota exhausted — paused until reset';
  if (fallback.action === 'downgrade') return `Claude quota hit — orchestrator degraded to Sonnet 5 until reset.`;
  const source = fallback.fromBackend === 'fable' ? 'Claude Fable' : 'Claude';
  return `${source} subscription exhausted — Codex ${fallback.toModel} is acting orchestrator on this mission thread.`;
}
