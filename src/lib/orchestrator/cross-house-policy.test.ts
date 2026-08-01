import { describe, expect, it } from 'vitest';
import { CROSS_HOUSE_MODEL_TIERS } from '@/lib/models';
import {
  CROSS_HOUSE_EQUIVALENCE_POLICY,
  buildCrossHouseFallbackMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseFallback,
} from './cross-house-policy';

describe('cross-house equivalence policy', () => {
  it('keeps every role on an equal runtime tier across houses', () => {
    for (const role of Object.values(CROSS_HOUSE_EQUIVALENCE_POLICY)) {
      for (const tier of Object.values(role.tiers)) {
        expect(tier.anthropic[0]?.runtimeTier).toBe(tier.openai[0]?.runtimeTier);
      }
    }
  });

  it('routes orchestrators in both directions at the frontier model tier', () => {
    expect(resolveCrossHouseFallback({ role: 'orchestrator', backend: 'claude' }))
      .toMatchObject({
        fromBackend: 'claude',
        toBackend: 'codex',
        fromModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.anthropic,
        toModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.openai,
        action: 'handoff',
      });
    expect(resolveCrossHouseFallback({ role: 'orchestrator', backend: 'codex' }))
      .toMatchObject({
        fromBackend: 'codex',
        toBackend: 'claude',
        fromModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.openai,
        toModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.anthropic,
        action: 'handoff',
      });
  });

  it('preserves a selected standard model tier instead of dropping lower', () => {
    expect(resolveCrossHouseFallback({
      role: 'worker',
      backend: 'codex',
      model: CROSS_HOUSE_MODEL_TIERS.reviewMechanical.openai,
    })).toMatchObject({
      modelTier: 'reviewMechanical',
      toModel: CROSS_HOUSE_MODEL_TIERS.reviewMechanical.anthropic,
    });
  });

  it('holds visibly when the other subscription house is unavailable', () => {
    const decision = resolveCrossHouseFallback({
      role: 'orchestrator',
      backend: 'claude',
      subscriptionProfile: 'claude-only',
    });
    expect(decision?.action).toBe('hold');
    expect(buildCrossHouseFallbackMessage(decision!)).toContain('without metered fallback');
  });

  it('does not treat the metered Fable backend as a subscription surface', () => {
    expect(resolveCrossHouseFallback({ role: 'orchestrator', backend: 'fable' })).toBeNull();
  });

  it('recognizes emitted and structured Codex quota failures', () => {
    expect(isRuntimeQuotaLimitError({
      type: 'turn.failed',
      error: { code: 'usage_limit_reached', message: 'You have hit your usage limit' },
    })).toBe(true);
    expect(isRuntimeQuotaLimitError('429 too many requests: exceeded your current quota')).toBe(true);
    expect(isRuntimeQuotaLimitError(new Error('process exited with code 1'))).toBe(false);
  });
});
