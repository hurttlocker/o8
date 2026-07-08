import { CROSS_HOUSE_MODEL_TIERS } from '@/lib/models';
import type { SubscriptionProfile } from '@/lib/operator/subscription-profile';
import type { CrossHouseFallback } from './quota-fallback';
import type { OrchestratorBackendId } from './types';

export interface SingleSubscriptionQuotaFallbackOptions {
  subscriptionProfile?: SubscriptionProfile;
  currentModel?: string | null;
}

export function resolveSingleSubscriptionOrchestratorFallback(
  backend: OrchestratorBackendId,
  options: SingleSubscriptionQuotaFallbackOptions,
): CrossHouseFallback | null {
  const profile = options.subscriptionProfile ?? 'both';
  if (profile === 'both') return null;

  if (backend !== 'claude' && backend !== 'fable') {
    return backend === 'codex' ? {
      fromBackend: backend,
      toBackend: backend,
      fromHouse: 'openai',
      toHouse: 'openai',
      fromModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.openai,
      toModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.openai,
      tier: 'frontierOrchestrator',
      action: 'hold',
      noticeKind: 'cross-house-orchestrator-handoff',
    } : null;
  }

  const currentModel = options.currentModel?.trim() || CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.anthropic;
  const toModel = CROSS_HOUSE_MODEL_TIERS.reviewMechanical.anthropic;
  const exhausted = currentModel === toModel;
  return {
    fromBackend: backend,
    toBackend: exhausted ? backend : 'claude',
    fromHouse: 'anthropic',
    toHouse: 'anthropic',
    fromModel: currentModel,
    toModel,
    tier: exhausted ? 'reviewMechanical' : 'frontierOrchestrator',
    action: exhausted ? 'hold' : 'downgrade',
    noticeKind: 'cross-house-orchestrator-handoff',
  };
}
